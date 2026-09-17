import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { registerChatRoutes } from '../server/chatRoutes.js';
import { buildApp } from '../server/app.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { listTasks } from '../tasks.js';

/**
 * 轉成任務 / 存進知識庫. Both must be idempotent (one note, one task per answer however many times
 * the button is pressed) and must stay inside the asking user's own history.
 */

const ME = { 'tailscale-user-login': 'addis@example.com' };
const OTHER = { 'tailscale-user-login': 'other@example.com' };
const TUNE = [
  '先說明判斷。',
  '```loop-tune',
  JSON.stringify({
    symptom: 'ROI 邊緣誤判',
    suggestions: [{ file: 'ip/src/defect.cpp', param: 'edge_margin_px', current: '4', proposed: '8', why: '邊緣梯度大', risk: 'low', verify: '重跑 20 張' }],
  }),
  '```',
].join('\n');

let db: Database.Database;
let app: FastifyInstance;
let tmp: string[] = [];
let sentPrompts: string[] = [];
let sentModels: string[] = [];

beforeEach(async () => {
  db = openTestDb();
  setSetting(db, 'local_models_enabled', 'true');
  sentPrompts = [];
  sentModels = [];
  app = Fastify();
  registerChatRoutes(app, db, {
    fetch: async () => new Response('{}'),
    localChat: async () => ({ ok: true, content: 't' }),
    // stands in for `claude -p`: zero tokens, zero network
    escalateExec: async (prompt, model) => {
      sentPrompts.push(prompt);
      sentModels.push(model);
      return '雲端複核結果：佇列深度的判斷合理，但也要看 completion queue。';
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

const post = (url: string, payload: unknown = {}, headers = ME) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });
const vault = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-chat-vault-'));
  tmp.push(d);
  createSource(db, { kind: 'vault', uri: d });
  return d;
};
async function answer(content: string) {
  const conv = (await post('/api/chat/conversations', { knowledge: true })).json();
  await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'user', content: '問題' });
  const a = (await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'assistant', content })).json();
  return { conv, a };
}

describe('轉成任務', () => {
  it('turns a suggestion block into one draft task carrying the whole table', async () => {
    const { a } = await answer(TUNE);
    const res = await post(`/api/chat/messages/${a.id}/task`);

    expect(res.statusCode).toBe(201);
    const { task, existing, from_tune } = res.json();
    expect({ existing, from_tune }).toEqual({ existing: false, from_tune: true });
    // a suggestion becomes work only when a human queues it
    expect(task.status).toBe('draft');
    expect(task.created_by).toBe('chat');
    expect(task.source_ref).toBe(`chat:${a.id}`);
    expect(task.goal).toContain('edge_margin_px');
    expect(task.goal).toContain('不得自動套用到機台');
    expect(task.verify_mode).toBe('manual');
  });

  it('is idempotent: pressing the button again returns the same task', async () => {
    const { a } = await answer(TUNE);
    const first = (await post(`/api/chat/messages/${a.id}/task`)).json().task;
    const second = await post(`/api/chat/messages/${a.id}/task`);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ existing: true, task: { id: first.id } });
    expect(listTasks(db)).toHaveLength(1);
    // the message itself remembers, so a reload still shows 已建任務 without asking again
    const stored = db.prepare('SELECT task_id FROM chat_messages WHERE id = ?').get(a.id) as { task_id: string };
    expect(stored.task_id).toBe(first.id);
  });

  it('still works for an ordinary answer with no suggestion block', async () => {
    const { a } = await answer('把 RDMA 收圖改回 SEND/RECV 比較穩。');
    const { task, from_tune } = (await post(`/api/chat/messages/${a.id}/task`)).json();
    expect(from_tune).toBe(false);
    expect(task.goal).toContain('SEND/RECV');
    expect(task.created_by).toBe('chat');
  });

  it('never reaches another user’s message', async () => {
    const { a } = await answer(TUNE);
    expect((await post(`/api/chat/messages/${a.id}/task`, {}, OTHER)).statusCode).toBe(404);
    expect(listTasks(db)).toEqual([]);
  });
});

describe('存進知識庫', () => {
  it('writes the answer into the vault, indexes it, and only once', async () => {
    const dir = vault();
    const { a } = await answer('RDMA 掉幀是因為佇列深度不足。');

    const first = await post(`/api/chat/messages/${a.id}/capture`);
    expect(first.statusCode).toBe(201);
    const { path: notePath, existing } = first.json();
    expect(existing).toBe(false);
    const written = fs.readFileSync(path.join(dir, notePath), 'utf8');
    expect(written).toContain('佇列深度不足');
    expect(written).toContain('來源：模型對話'); // provenance, so a note is never mistaken for a doc

    const again = await post(`/api/chat/messages/${a.id}/capture`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ existing: true, path: notePath });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.md'))).toHaveLength(1);
  });

  it('says what is wrong when there is no vault to write into', async () => {
    const { a } = await answer('內容');
    const res = await post(`/api/chat/messages/${a.id}/capture`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/vault/i);
  });

  it('refuses an empty answer and another user’s message', async () => {
    vault();
    const { a } = await answer('   ');
    expect((await post(`/api/chat/messages/${a.id}/capture`)).statusCode).toBe(400);
    const { a: b } = await answer('有內容');
    expect((await post(`/api/chat/messages/${b.id}/capture`, {}, OTHER)).statusCode).toBe(404);
  });
});

describe('請雲端複核', () => {
  const enable = () => setSetting(db, 'chat_escalate_enabled', 'true');

  it('is off until switched on: the page gets a 404 with the setting name', async () => {
    const { a } = await answer('本地的回答');
    const res = await post(`/api/chat/messages/${a.id}/escalate`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('chat_escalate_enabled');
  });

  it('stores the review as its own message pointing back at the answer it reviewed', async () => {
    enable();
    const { a } = await answer('RDMA 掉幀是因為佇列深度不足。');
    const res = await post(`/api/chat/messages/${a.id}/escalate`, { model: 'opus' });

    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.model_id).toBe('cloud:opus');
    expect(msg.escalated_from).toBe(a.id);
    expect(msg.content).toContain('雲端複核結果');
    // the prompt carries the answer and its citations, and says the reviewer cannot see the repo
    expect(sentPrompts[0]).toContain('佇列深度不足');
    expect(sentPrompts[0]).toContain('本地模型看得到專案知識庫、你看不到');
    expect(sentModels[0]).toBe('opus');
  });

  it('refuses to spend usage above the hard limit, like the benchmark judge', async () => {
    enable();
    setSetting(db, 'hard_limit_pct', '0');
    const { a } = await answer('回答');
    const res = await post(`/api/chat/messages/${a.id}/escalate`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('hard limit');
    expect(sentPrompts).toEqual([]); // nothing was spent
  });

  it('rejects an unknown model, a review of a review, and another user’s message', async () => {
    enable();
    const { a } = await answer('回答');
    expect((await post(`/api/chat/messages/${a.id}/escalate`, { model: 'gpt-9' })).statusCode).toBe(400);
    expect((await post(`/api/chat/messages/${a.id}/escalate`, {}, OTHER)).statusCode).toBe(404);

    const review = (await post(`/api/chat/messages/${a.id}/escalate`)).json();
    const second = await post(`/api/chat/messages/${review.id}/escalate`);
    expect(second.statusCode).toBe(400);
  });
});

describe('匯出與分享', () => {
  it('exports Markdown with a filename a browser can save', async () => {
    const { conv } = await answer('因為佇列深度不足。');
    const res = await app.inject({ method: 'GET', url: `/api/chat/conversations/${conv.id}/export`, headers: ME });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(String(res.headers['content-disposition'])).toContain("filename*=UTF-8''");
    expect(res.body).toContain('佇列深度不足');
    expect((await app.inject({ method: 'GET', url: `/api/chat/conversations/${conv.id}/export?format=pdf`, headers: ME })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/chat/conversations/${conv.id}/export`, headers: OTHER })).statusCode).toBe(404);
  });

  it('publishes a read-only page behind an unguessable token, and revokes it', async () => {
    const { conv } = await answer('分享用的回答');
    const share = (await post(`/api/chat/conversations/${conv.id}/share`)).json();
    expect(share.token).toMatch(/^s_/);
    expect(share.token.length).toBeGreaterThan(20);
    expect(share.url).toBe(`/share.html#${share.token}`);

    const read = await app.inject({ method: 'GET', url: `/api/chat/shared/${share.token}` });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.conversation.title).toBeTruthy();
    expect(body.messages.map((m: { content: string }) => m.content)).toContain('分享用的回答');
    // a shared transcript is text: no image URLs, no user_key, no id of the owner
    expect(JSON.stringify(body)).not.toContain('images');
    expect(JSON.stringify(body)).not.toContain('user_key');

    // pressing 分享 again keeps the same link rather than orphaning the one already sent out
    expect((await post(`/api/chat/conversations/${conv.id}/share`)).json().token).toBe(share.token);

    expect((await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${conv.id}/share`, headers: ME })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/chat/shared/${share.token}` })).statusCode).toBe(404);
  });

  it('404s an unknown token and every share route while the flag is off', async () => {
    const { conv } = await answer('內容');
    expect((await app.inject({ method: 'GET', url: '/api/chat/shared/s_nope' })).statusCode).toBe(404);
    const share = (await post(`/api/chat/conversations/${conv.id}/share`)).json();
    setSetting(db, 'chat_share_enabled', 'false');
    expect((await app.inject({ method: 'GET', url: `/api/chat/shared/${share.token}` })).statusCode).toBe(404);
    expect((await post(`/api/chat/conversations/${conv.id}/share`)).statusCode).toBe(404);
  });
});

describe('調參紀錄', () => {
  const TUNE2 = TUNE.replace('ROI 邊緣誤判', '暗場門檻太鬆').replace('edge_margin_px', 'dark_threshold');
  const history = (headers = ME) => app.inject({ method: 'GET', url: '/api/chat/tune/history', headers });

  it('lists only the answers that carry a suggestion block, newest first, with the task they became', async () => {
    await answer('普通回答，沒有建議表');
    const { a: first } = await answer(TUNE);
    await answer(TUNE2);

    const res = await history();
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ symptom: '暗場門檻太鬆', suggestions_count: 1, task: null });
    expect(items[0].top).toMatchObject({ param: 'dark_threshold', proposed: '8', risk: 'low' });
    expect(items[1].message_id).toBe(first.id);
    expect(items[1].conversation_title).toBeTruthy();

    // 轉成任務 shows up on the next read, with the live task status
    const { task } = (await post(`/api/chat/messages/${first.id}/task`)).json();
    const after = (await history()).json().items.find((i: { message_id: string }) => i.message_id === first.id);
    expect(after.task).toMatchObject({ id: task.id, status: 'draft' });
    expect(after.task.title).toContain('調參建議');
  });

  it('skips soft-deleted answers and blocks the model got wrong', async () => {
    const { conv, a } = await answer(TUNE);
    await post(`/api/chat/conversations/${conv.id}/truncate`, { ord: a.ord });
    await answer('```loop-tune\n{ not json\n```');
    expect((await history()).json().items).toEqual([]);
  });

  it('is scoped to the asking user, and gated like the rest of the chat API', async () => {
    await answer(TUNE);
    expect((await history(OTHER)).json().items).toEqual([]);
    setSetting(db, 'chat_history_enabled', 'false');
    expect((await history()).statusCode).toBe(404);
    setSetting(db, 'chat_history_enabled', 'true');
    setSetting(db, 'local_models_enabled', 'false');
    expect((await history()).statusCode).toBe(404);
  });
});

describe('feature gates', () => {
  it('404s both actions while local models are off', async () => {
    const { a } = await answer(TUNE);
    setSetting(db, 'local_models_enabled', 'false');
    expect((await post(`/api/chat/messages/${a.id}/task`)).statusCode).toBe(404);
    expect((await post(`/api/chat/messages/${a.id}/capture`)).statusCode).toBe(404);
  });
});

describe('分享連結 under a configured API token', () => {
  // The share page has no way to hold a bearer, so the auth hook lets exactly this one GET
  // through. Everything else must still be locked.
  it('reads a shared transcript without a bearer while the rest of /api stays closed', async () => {
    const guarded = buildApp({ db, apiToken: 'FULL' });
    const conv = (
      await guarded.inject({
        method: 'POST',
        url: '/api/chat/conversations',
        payload: {},
        headers: { ...ME, authorization: 'Bearer FULL' },
      })
    ).json();
    await guarded.inject({
      method: 'POST',
      url: `/api/chat/conversations/${conv.id}/messages`,
      payload: { role: 'assistant', content: '給老闆看的結論' },
      headers: { ...ME, authorization: 'Bearer FULL' },
    });
    const share = (
      await guarded.inject({
        method: 'POST',
        url: `/api/chat/conversations/${conv.id}/share`,
        payload: {},
        headers: { ...ME, authorization: 'Bearer FULL' },
      })
    ).json();

    const open = await guarded.inject({ method: 'GET', url: `/api/chat/shared/${share.token}` });
    expect(open.statusCode).toBe(200);
    expect(open.json().messages[0].content).toBe('給老闆看的結論');

    // the exemption is one method on one prefix, nothing more
    expect((await guarded.inject({ method: 'GET', url: '/api/chat/conversations' })).statusCode).toBe(401);
    expect((await guarded.inject({ method: 'GET', url: `/api/chat/conversations/${conv.id}` })).statusCode).toBe(401);
    expect((await guarded.inject({ method: 'DELETE', url: `/api/chat/shared/${share.token}` })).statusCode).toBe(401);
    await guarded.close();
  });
});
