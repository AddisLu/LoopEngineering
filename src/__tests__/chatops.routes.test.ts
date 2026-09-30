import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createTask, getTask } from '../tasks.js';
import { appendMessage, createConversation } from '../chat/store.js';
import { createPending } from '../chatops/actions.js';
import { getOpsRunner } from '../chatops/execute.js';
import { OPS_READ_TOOLS, OPS_RESULT_PREFIX, OPS_TOOL_NAMES } from '../chatops/tools.js';

// /api/ops: the card's buttons belong to the person who prepared the action; the loop-ops forwarder
// is a separate `ext:` identity that may only read unless ops_external_enabled.
const ME = { 'tailscale-user-login': 'addis@example.com' };
const OTHER = { 'tailscale-user-login': 'other@example.com' };
const MY_KEY = 'ts:addis@example.com';
let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openTestDb();
  // never the live usage endpoint: the overview reads a fixed number
  const usage = () => ({ session: { percent: 12, resetsAt: null }, weekly: { percent: 30, resetsAt: null }, source: 'cache' as const, error: null });
  app = buildApp({ db, apiToken: null, opsDeps: { exec: { waitMs: 3000 }, view: { usage: usage as never }, prep: { usage: usage as never } } });
  await app.ready();
});
afterEach(async () => {
  await getOpsRunner().idle();
  await app.close();
  db.close();
});

const draft = () => createTask(db, { title: '修登入', goal: 'a goal long enough', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true'], complexity: 'S' });
function pendingQueue(taskId: string) {
  const c = createConversation(db, { user_key: MY_KEY });
  appendMessage(db, c.id, MY_KEY, { role: 'user', content: `排入 ${taskId}` });
  const m = appendMessage(db, c.id, MY_KEY, { role: 'assistant', content: '請確認' });
  return createPending(db, { messageId: m.id, conversationId: c.id, userKey: MY_KEY, label: 'addis' }, {
    kind: 'task',
    op: 'queue',
    target: taskId,
    params: { id: taskId },
    expect: { status: 'draft' },
    summary: `排入 ${taskId}「修登入」`,
    risk: 'normal',
    speed: 'fast',
  });
}
const on = () => {
  setSetting(db, 'ops_chat_enabled', 'true');
  setSetting(db, 'ops_allowed_users', MY_KEY);
};

describe('the card', () => {
  it('everything is 404 while 對話操作 is off', async () => {
    for (const [method, url] of [['GET', '/api/ops/actions'], ['POST', '/api/ops/actions/x/confirm'], ['GET', '/api/ops/tools'], ['POST', '/api/ops/tools/ops_overview']] as const) {
      expect((await app.inject({ method, url, headers: ME, ...(method === 'POST' ? { payload: {} } : {}) })).statusCode, url).toBe(404);
    }
  });

  it('the button runs the action once, for its owner only', async () => {
    on();
    const t = draft();
    const a = pendingQueue(t.id);
    expect((await app.inject({ method: 'POST', url: `/api/ops/actions/${a.id}/confirm`, headers: OTHER })).statusCode).toBe(403); // not listed
    setSetting(db, 'ops_allowed_users', `${MY_KEY},ts:other@example.com`);
    expect((await app.inject({ method: 'POST', url: `/api/ops/actions/${a.id}/confirm`, headers: OTHER })).statusCode).toBe(404); // not theirs
    const view = await app.inject({ method: 'GET', url: `/api/ops/actions/${a.code}`, headers: ME });
    expect(view.json()).toMatchObject({ action: { id: a.id, status: 'pending', summary: `排入 ${t.id}「修登入」` } });
    const r = await app.inject({ method: 'POST', url: `/api/ops/actions/${a.id}/confirm`, headers: ME });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, action: { status: 'done' }, message: expect.stringContaining('已完成') });
    expect(getTask(db, t.id)!.status).toBe('queued');
    const again = await app.inject({ method: 'POST', url: `/api/ops/actions/${a.id}/confirm`, headers: ME });
    expect(again.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/ops/actions', headers: ME })).json().actions).toHaveLength(1);
  });

  it('cancel drops a pending action; a second cancel says it is no longer pending', async () => {
    on();
    const a = pendingQueue(draft().id);
    const r = await app.inject({ method: 'POST', url: `/api/ops/actions/${a.id}/cancel`, headers: ME });
    expect(r.json()).toMatchObject({ ok: true, action: { status: 'cancelled' } });
    expect((await app.inject({ method: 'POST', url: `/api/ops/actions/${a.id}/cancel`, headers: ME })).statusCode).toBe(409);
  });
});

describe('the loop-ops forwarder', () => {
  const ext = { 'x-loop-ops-user': 'Claude Code' };

  it('reads by default; preparing and confirming need ops_external_enabled', async () => {
    on();
    const list = (await app.inject({ method: 'GET', url: '/api/ops/tools', headers: ext })).json();
    expect(list.allowed).toBe(false);
    expect(list.tools.map((t: { name: string }) => t.name)).toEqual([...OPS_READ_TOOLS]);
    expect(list.tools[0]).toMatchObject({ name: 'ops_overview', inputSchema: { type: 'object' } });
    const o = await app.inject({ method: 'POST', url: '/api/ops/tools/ops_overview', headers: ext, payload: {} });
    expect(o.json()).toMatchObject({ ok: true, text: expect.stringMatching(new RegExp(`^${OPS_RESULT_PREFIX.slice(0, 10)}`)) });
    const t = draft();
    expect((await app.inject({ method: 'POST', url: '/api/ops/tools/ops_prepare_action', headers: ext, payload: { action: 'queue', target: t.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/ops/tools/nope', headers: ext, payload: {} })).statusCode).toBe(404);
  });

  it('enabled: prepare, then confirm with the code — as its own identity, never the person\'s', async () => {
    on();
    setSetting(db, 'ops_external_enabled', 'true');
    expect((await app.inject({ method: 'GET', url: '/api/ops/tools', headers: ext })).json().tools.map((t: { name: string }) => t.name)).toEqual([...OPS_TOOL_NAMES]);
    const t = draft();
    const p = (await app.inject({ method: 'POST', url: '/api/ops/tools/ops_prepare_action', headers: ext, payload: { action: 'queue', target: t.id } })).json();
    expect(p).toMatchObject({ ok: true, action: { status: 'pending' }, text: expect.stringContaining('code 帶') });
    const code = p.action.code as string;
    const noCode = (await app.inject({ method: 'POST', url: '/api/ops/tools/ops_confirm', headers: ext, payload: {} })).json();
    expect(noCode).toMatchObject({ ok: false, text: expect.stringContaining('要帶動作代碼') });
    // another caller (or the person on the chat page) cannot run it
    expect((await app.inject({ method: 'POST', url: '/api/ops/tools/ops_confirm', headers: { 'x-loop-ops-user': 'someone' }, payload: { code } })).json()).toMatchObject({ ok: false });
    expect((await app.inject({ method: 'POST', url: `/api/ops/actions/${p.action.id}/confirm`, headers: ME })).statusCode).toBe(404);
    const r = (await app.inject({ method: 'POST', url: '/api/ops/tools/ops_confirm', headers: ext, payload: { code } })).json();
    expect(r).toMatchObject({ ok: true, action: { status: 'done' } });
    expect(getTask(db, t.id)!.status).toBe('queued');
    const owner = db.prepare('SELECT user_key, user_label FROM ops_actions WHERE id = ?').get(p.action.id) as { user_key: string; user_label: string };
    expect(owner).toEqual({ user_key: 'ext:claude code', user_label: 'Claude Code（外部工具）' });
    const note = db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 1").get(t.id) as { detail: string };
    expect(note.detail).toContain('對話操作（Claude Code（外部工具））');
  });
});
