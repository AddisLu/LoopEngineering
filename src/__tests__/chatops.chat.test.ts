import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { appendMessage, createConversation } from '../chat/store.js';
import { clearRecipeCache } from '../local/recipes.js';
import { CHAT_SYSTEM_PROMPT, registerChatRoutes, systemPromptWithTools, type ChatRouteOptions } from '../server/chatRoutes.js';
import { toOpenAiTools, type ToolDef, type ToolRound } from '../chat/tools.js';
import type { McpPool } from '../mcp/client.js';
import { getOpsRunner } from '../chatops/execute.js';
import { OPS_PROMPT, OPS_READ_TOOLS, OPS_RESULT_PREFIX, OPS_TOOL_NAMES, opsTools } from '../chatops/tools.js';
import { createPending } from '../chatops/actions.js';

// 對話操作 inside POST /api/chat: off changes nothing; on, the model gets the ops tools (read-only
// unless the asker is listed), the old unconfirmed `loop` MCP is hidden, and nothing runs until the
// person says yes in a later message.
let db: Database.Database;
let app: FastifyInstance;
let tmp: string[] = [];
let script: string[] = [];
let bodies: Array<Record<string, unknown>> = [];
const USER = 'local';

const dir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-opschat-${tag}-`));
  tmp.push(d);
  return d;
};
const sse = (frames: unknown[]) => `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
const call = (name: string, args: unknown) =>
  sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${name}_${bodies.length}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]);
const say = (text: string) => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);
const fakeTool: ToolDef = { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} }, run: async () => ({ ok: true, text: '', summary: '' }) };
const pool = {
  listTools: async () => [
    { server: 'loop', tools: [{ name: 'loop_add_task', description: 'adds and queues a task', inputSchema: { type: 'object', properties: {} } }] },
    { server: 'loop-fs', tools: [{ name: 'list_dir', description: 'lists a directory', inputSchema: { type: 'object', properties: {} } }] },
  ],
  callTool: async () => ({ text: '', isError: false }),
} as unknown as McpPool;

const usage = () => ({ session: { percent: 12, resetsAt: null }, weekly: { percent: 30, resetsAt: null }, source: 'cache' as const, error: null });
async function build(extra: Partial<ChatRouteOptions> = {}) {
  if (app) await app.close();
  app = Fastify();
  registerChatRoutes(app, db, {
    tools: () => [fakeTool],
    hubDir: dir('hub'),
    fetch: async (_url, init) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
      return new Response(script.shift() ?? say('好的'), { headers: { 'content-type': 'text/event-stream' } });
    },
    // never the live usage endpoint
    opsDeps: { exec: { waitMs: 3000 }, view: { usage: usage as never }, prep: { usage: usage as never } },
    ...extra,
  });
  await app.ready();
}

beforeEach(async () => {
  db = openTestDb();
  script = [];
  bodies = [];
  setSetting(db, 'local_models_enabled', 'true');
  setSetting(db, 'local_model_status', 'ready');
  setSetting(db, 'local_model_loaded', 'qwen38-flash');
  setSetting(db, 'chat_tools_enabled', 'true');
  const repo = dir('recipes');
  fs.mkdirSync(path.join(repo, 'recipes'));
  fs.writeFileSync(path.join(repo, 'recipes', 'qwen3.8-flash-next-nvfp4-solo.yaml'), 'model: x\ncommand: |\n  vllm serve x --tool-call-parser qwen3_xml --enable-auto-tool-choice\n');
  setSetting(db, 'local_vllm_repo', repo);
  clearRecipeCache();
  await build();
});
afterEach(async () => {
  await getOpsRunner().idle();
  await app.close();
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

type Msg = { role: string; content: string };
/** One turn the way the page does it: the question and an empty answer row are saved first. */
async function ask(conv: string | null, text: string, o: { tools?: boolean; history?: Msg[]; mode?: string } = {}) {
  let messageId: string | undefined;
  if (conv) {
    appendMessage(db, conv, USER, { role: 'user', content: text });
    messageId = appendMessage(db, conv, USER, { role: 'assistant', content: '' }).id;
  }
  const n = bodies.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: { messages: [...(o.history ?? []), { role: 'user', content: text }], ...(o.tools ? { tools: true } : {}), ...(o.mode ? { mode: o.mode } : {}), ...(messageId ? { message_id: messageId } : {}) },
  });
  const first = bodies[n] ?? {};
  const names = ((first.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name);
  const system = (first.messages as Msg[] | undefined)?.[0]?.content ?? '';
  const row = messageId ? (db.prepare('SELECT content, tools_json FROM chat_messages WHERE id = ?').get(messageId) as { content: string; tools_json: string | null }) : null;
  return { res, messageId, first, names, system, answer: row?.content ?? '', rounds: row?.tools_json ? (JSON.parse(row.tools_json) as ToolRound[]).filter((r) => Array.isArray(r.calls)) : [] };
}
const conversation = () => createConversation(db, { user_key: USER, title: 't' }).id;
const enable = (users = USER) => {
  setSetting(db, 'ops_chat_enabled', 'true');
  setSetting(db, 'ops_allowed_users', users);
};
const draftTask = () => createTask(db, { title: '修登入', goal: 'a goal long enough', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true'], complexity: 'S' });

describe('off: nothing changes', () => {
  it('the plain path and the tools path send exactly what they sent before', async () => {
    const plain = await ask(conversation(), 'hi');
    expect(plain.first.tools).toBeUndefined();
    expect(plain.system).toBe(CHAT_SYSTEM_PROMPT);
    const chip = await ask(conversation(), 'hi', { tools: true });
    expect(chip.names).toEqual(['web_search']);
    expect(chip.system).toBe(systemPromptWithTools([fakeTool]));
    expect(chip.system).not.toContain('Loop 引擎的操作助理');
    await build({ mcpPool: pool });
    expect((await ask(conversation(), 'hi', { tools: true })).names).toEqual(['web_search', 'mcp__loop__loop_add_task', 'mcp__loop_fs__list_dir']);
  });

  it('on, but the serving recipe cannot call tools: still the plain path', async () => {
    enable();
    fs.writeFileSync(path.join(String(db.prepare("SELECT value FROM settings WHERE key = 'local_vllm_repo'").pluck().get()), 'recipes', 'qwen3.8-flash-next-nvfp4-solo.yaml'), 'model: x\ncommand: |\n  vllm serve x\n');
    clearRecipeCache();
    const r = await ask(conversation(), 'hi');
    expect(r.first.tools).toBeUndefined();
    expect(r.system).toBe(CHAT_SYSTEM_PROMPT);
  });
});

describe('on: who gets which tools', () => {
  it('no saved conversation or not listed: read-only, and the model is told so', async () => {
    enable('ts:someone@else');
    const anon = await ask(null, '現在狀況？');
    expect(anon.names).toEqual([...OPS_READ_TOOLS]);
    expect(anon.system).toContain(OPS_PROMPT);
    expect(anon.system).toContain('你目前只能查詢');
    const other = await ask(conversation(), '現在狀況？');
    expect(other.names).toEqual([...OPS_READ_TOOLS]);
  });

  it('listed, in a saved conversation: every ops tool, no chip needed; tune mode stays as it was', async () => {
    enable();
    const r = await ask(conversation(), '現在狀況？');
    expect(r.names).toEqual([...OPS_TOOL_NAMES]);
    expect(r.system).not.toContain('你目前只能查詢');
    // the manual comes after the tail that invites diagrams, so its rules are the last word
    expect(r.system.indexOf(OPS_PROMPT)).toBeGreaterThan(r.system.indexOf('SVG'));
    for (const rule of ['先呼叫查詢工具', '不要沿用前面回答', '呼叫 ops_cancel，然後只回一句話', '只能照抄工具結果', '不要畫圖']) expect(OPS_PROMPT, rule).toContain(rule);
    expect((await ask(conversation(), '調參', { mode: 'tune' })).first.tools).toBeUndefined();
  });

  it('with the chip, the old unconfirmed `loop` MCP is hidden; other servers stay', async () => {
    enable();
    await build({ mcpPool: pool });
    const r = await ask(conversation(), 'hi', { tools: true });
    expect(r.names).toContain('mcp__loop_fs__list_dir');
    expect(r.names).not.toContain('mcp__loop__loop_add_task');
    expect(r.names).toContain('ops_prepare_work');
  });

  it('the schemas stay small enough to send with every question', () => {
    const all = opsTools(db, { userKey: USER, conversationId: 'c', chat: { messageId: 'm', conversationId: 'c', userKey: USER, label: 'x' }, allowed: true });
    expect(all.map((t) => t.name)).toEqual([...OPS_TOOL_NAMES]);
    expect(JSON.stringify(toOpenAiTools(all)).length).toBeLessThan(7000);
  });
});

describe('two turns: prepare, then the person confirms', () => {
  it('the model cannot confirm in the answer that prepared; the person\'s 「確認」 runs it', async () => {
    enable();
    const t = draftTask();
    const conv = conversation();
    script = [call('ops_prepare_action', { action: 'queue', target: t.id }), call('ops_confirm', {}), say('已準備好，請回覆「確認」。')];
    const t1 = await ask(conv, `排入 ${t.id}`);
    expect(t1.res.statusCode).toBe(200);
    expect(getTask(db, t.id)!.status).toBe('draft');
    const a = db.prepare('SELECT code, status FROM ops_actions').get() as { code: string; status: string };
    expect(a.status).toBe('pending');
    expect(t1.rounds[0]!.calls[0]).toMatchObject({ name: 'ops_prepare_action', ok: true, action: { code: a.code, status: 'pending', risk: 'normal' } });
    expect(t1.rounds[1]!.calls[0]).toMatchObject({ name: 'ops_confirm', ok: false, summary: expect.stringContaining('沒有執行') });
    const toolMsg = (bodies[1]!.messages as Msg[]).at(-1)!;
    expect(toolMsg.content.startsWith(OPS_RESULT_PREFIX)).toBe(true);
    expect(toolMsg.content).toContain(`排入 ${t.id}「修登入」`);

    script = [call('ops_confirm', {}), say('已排入。')];
    const t2 = await ask(conv, '確認', { history: [{ role: 'user', content: `排入 ${t.id}` }, { role: 'assistant', content: t1.answer }] });
    expect(t2.system).toContain(`待確認的動作 ${a.code}`);
    expect(t2.rounds[0]!.calls[0]).toMatchObject({ name: 'ops_confirm', ok: true, action: { status: 'done' } });
    expect(getTask(db, t.id)!.status).toBe('queued');
    expect(t2.answer).toBe('已排入。');
    // the next question hears what happened
    const t3 = await ask(conv, '好了嗎？');
    expect(t3.system).toContain(`最近的動作 ${a.code}`);
    expect(t3.system).not.toContain('本對話有一個待確認的動作');
  });

  it('a high-risk action needs its code; the refusal shows it again so 「確認 CODE」 works next', async () => {
    enable();
    const t = draftTask();
    setStatus(db, t.id, 'running');
    const conv = conversation();
    script = [call('ops_prepare_action', { action: 'abort', target: t.id }), say('要中止請回覆確認加代碼。')];
    await ask(conv, `中止 ${t.id}`);
    const { code } = db.prepare('SELECT code FROM ops_actions').get() as { code: string };
    script = [call('ops_confirm', {}), say(`要回覆「確認 ${code}」。`)];
    const t2 = await ask(conv, '確認');
    expect(t2.rounds[0]!.calls[0]).toMatchObject({ ok: false, summary: expect.stringContaining(`確認 ${code}`) });
    expect(getTask(db, t.id)!.status).toBe('running');
    script = [call('ops_confirm', { code }), say('已中止。')];
    const t3 = await ask(conv, `確認 ${code}`);
    expect(t3.rounds[0]!.calls[0]).toMatchObject({ ok: true, action: { status: 'done' } });
    expect(getTask(db, t.id)!.status).toBe('failed');
  });

  it('a model switch confirmed in an answer starts only after that answer is written', async () => {
    enable();
    db.prepare("INSERT INTO local_models (id, display_name, recipe, served_model_id, enabled) VALUES ('b', 'B', 'b', 'org/b', 1)").run();
    const conv = conversation();
    const t1 = await ask(conv, '切到 b');
    createPending(db, { messageId: t1.messageId!, conversationId: conv, userKey: USER, label: '本機' }, { kind: 'model', op: 'switch_model', target: 'b', params: { id: 'b' }, expect: null, summary: '切到 b', risk: 'normal', speed: 'deferred' });
    const loaded: string[] = [];
    await build({ opsDeps: { view: { usage: usage as never }, prep: { usage: usage as never }, exec: { waitMs: 3000, modelManager: { state: () => ({ loaded: 'qwen38-flash', wanted: 'qwen38-flash', status: 'ready', since: null, error: null }), ensureLoaded: (id: string) => (loaded.push(id), 'switching') } } } });
    script = [call('ops_confirm', {}), say('這則回答結束後切換。')];
    const t2 = await ask(conv, '確認');
    expect(t2.rounds[0]!.calls[0]).toMatchObject({ ok: true, summary: expect.stringContaining('這則回答結束後') });
    await getOpsRunner().idle();
    // it ran after the answer: the guard (no weights in the empty cache) is what stopped it
    const a = db.prepare("SELECT status, result_json FROM ops_actions WHERE op = 'switch_model'").get() as { status: string; result_json: string };
    expect(a.status).toBe('failed');
    expect(JSON.parse(a.result_json).detail).toContain('權重');
    expect(loaded).toEqual([]);
  });
});
