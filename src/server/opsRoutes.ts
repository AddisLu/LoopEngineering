import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import { identityOf, IdentityError, type ChatIdentity } from './identity.js';
import { appendMessage, createConversation } from '../chat/store.js';
import { getGenerationRegistry } from '../chat/generation.js';
import { toOpenAiTools } from '../chat/tools.js';
import { actionView, cancelAction, findAction, listActions, refreshPending } from '../chatops/actions.js';
import { confirmButton } from '../chatops/execute.js';
import { OPS_RESULT_PREFIX, OPS_WRITE_TOOLS, opsAllowedFor, opsExecDeps, opsTools, type OpsToolDeps } from '../chatops/tools.js';
import type { ChatCtx } from '../chatops/types.js';

/**
 * /api/ops — 對話操作 outside the chat stream:
 *  - the card's 確認執行／取消 buttons, and its status refresh (the chat identity owns the action);
 *  - the tool list and tool calls for mcp/loop-ops-mcp.mjs, the forwarder that gives tools like
 *    Claude Code the same operations. Those callers are `ext:<name>` identities with their own
 *    conversation; they may only read unless ops_external_enabled, and confirming needs the code.
 * Everything is off (404) unless ops_chat_enabled.
 */

export interface OpsRouteOptions {
  identity?: (req: FastifyRequest) => ChatIdentity;
  deps?: OpsToolDeps;
}

const EXT_HEADER = 'x-loop-ops-user';
const OFF = { error: '對話操作沒有開（ops_chat_enabled=false）' };

/** The forwarder's caller: `ext:<name>` — never the same key as a person on the chat page. */
function externalUser(req: FastifyRequest): { key: string; label: string } {
  const raw = req.headers[EXT_HEADER];
  const name = String(Array.isArray(raw) ? raw[0] : raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  const label = name || '外部工具';
  return { key: `ext:${label.toLowerCase()}`, label };
}

/** One conversation per external caller holds its actions (an action belongs to a conversation). */
function externalConversation(db: Database.Database, user: { key: string; label: string }): string {
  const row = db.prepare('SELECT id FROM chat_conversations WHERE user_key = ? ORDER BY created_at ASC, rowid ASC LIMIT 1').get(user.key) as { id: string } | undefined;
  return row?.id ?? createConversation(db, { user_key: user.key, user_label: user.label, title: `loop-ops（${user.label}）` }).id;
}

export function registerOpsRoutes(app: FastifyInstance, db: Database.Database, opts: OpsRouteOptions = {}): void {
  const identity = opts.identity ?? ((req: FastifyRequest) => identityOf(req));
  const gens = () => getGenerationRegistry(db);
  const deps = (): OpsToolDeps => ({ isRunning: (id) => gens().isRunning(id), otherAnswers: (except) => gens().runningCount(except), ...opts.deps });
  const on = () => getBool(db, 'ops_chat_enabled', false);
  const who = (req: FastifyRequest, reply: FastifyReply): ChatIdentity | null => {
    if (!on()) {
      reply.code(404).send(OFF);
      return null;
    }
    try {
      return identity(req);
    } catch (err) {
      if (err instanceof IdentityError) {
        reply.code(400).send({ error: err.message });
        return null;
      }
      throw err;
    }
  };

  // ---- the chat card -----------------------------------------------------------------------

  app.get('/api/ops/actions', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    const q = req.query as { conversation_id?: string; limit?: string };
    if (q.conversation_id) refreshPending(db, q.conversation_id);
    return { actions: listActions(db, { userKey: me.user_key, conversationId: q.conversation_id || null, limit: Number(q.limit) || 20 }).map(actionView) };
  });

  app.get('/api/ops/actions/:id', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    const a = findAction(db, (req.params as { id: string }).id, me.user_key);
    if (!a) return reply.code(404).send({ error: '找不到這個動作' });
    refreshPending(db, a.conversation_id);
    return { action: actionView(findAction(db, a.id, me.user_key)!) };
  });

  app.post('/api/ops/actions/:id/confirm', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    if (!opsAllowedFor(db, me.user_key)) return reply.code(403).send({ error: `${me.label} 不在可以執行操作的名單（ops_allowed_users）` });
    const r = await confirmButton(db, (req.params as { id: string }).id, me.user_key, opsExecDeps(db, deps()));
    const body = { ok: r.ok, message: r.message, ...(r.action ? { action: actionView(r.action) } : {}) };
    return r.ok ? body : reply.code(r.action ? 409 : 404).send(body);
  });

  app.post('/api/ops/actions/:id/cancel', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    const a = cancelAction(db, (req.params as { id: string }).id, me.user_key);
    if (!a) return reply.code(409).send({ ok: false, message: '這個動作已經不是待確認（可能已執行、過期或取消了）' });
    return { ok: true, message: `已取消 ${a.code}`, action: actionView(a) };
  });

  // ---- mcp/loop-ops-mcp.mjs ------------------------------------------------------------------

  app.get('/api/ops/tools', async (req, reply) => {
    if (!on()) return reply.code(404).send(OFF);
    const user = externalUser(req);
    // listing only: a stand-in answer so the write tools are described (they never run from here)
    const allowed = getBool(db, 'ops_external_enabled', false);
    const chat = allowed ? { messageId: '', conversationId: '', userKey: user.key, label: user.label } : null;
    const tools = opsTools(db, { userKey: user.key, conversationId: null, chat, allowed, mode: 'external' });
    return { allowed, tools: toOpenAiTools(tools).map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })) };
  });

  app.post('/api/ops/tools/:name', async (req, reply) => {
    if (!on()) return reply.code(404).send(OFF);
    const name = (req.params as { name: string }).name;
    const args = (req.body ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || Array.isArray(args)) return reply.code(400).send({ error: '參數必須是 JSON 物件' });
    const allowed = getBool(db, 'ops_external_enabled', false);
    const write = (OPS_WRITE_TOOLS as readonly string[]).includes(name);
    if (write && !allowed) {
      return reply.code(403).send({ error: '外部工具目前只能查詢（ops_external_enabled=false）；要讓它準備和執行操作，請在設定打開 ops_external_enabled' });
    }
    const user = externalUser(req);
    const conversationId = externalConversation(db, user);
    // each write call is its own "answer" in the caller's conversation: an action belongs to one
    const chat: ChatCtx | null = write
      ? { messageId: appendMessage(db, conversationId, user.key, { role: 'assistant', content: `（loop-ops：${name}）` }).id, conversationId, userKey: user.key, label: `${user.label}（外部工具）` }
      : null;
    const tools = opsTools(db, { userKey: user.key, conversationId, chat, allowed, mode: 'external', deps: deps() });
    const def = tools.find((t) => t.name === name);
    if (!def) return reply.code(404).send({ error: `沒有這個工具：${name}` });
    try {
      // the ops tools do not stream or fetch; the signal only satisfies ToolCtx
      const r = await def.run(args, { db, fetch, signal: new AbortController().signal });
      return { ok: r.ok, text: `${def.resultPrefix ?? OPS_RESULT_PREFIX}${r.text}`, summary: r.summary, ...(r.action ? { action: r.action } : {}), ...(r.sources ? { sources: r.sources } : {}) };
    } catch (err) {
      return reply.code(500).send({ error: `工具執行失敗：${(err as Error).message.slice(0, 200)}` });
    }
  });
}
