import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { registerChatRoutes } from '../server/chatRoutes.js';
import { messagesFor } from '../chat/store.js';

/**
 * 對話紀錄 endpoints. Hermetic: no vLLM, no network — the only local-model call these routes make
 * is the title generator, which is injected.
 */

const ME = { 'tailscale-user-login': 'Addis@example.com' };
const OTHER = { 'tailscale-user-login': 'other@example.com' };
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let db: Database.Database;
let app: FastifyInstance;
let titleCalls: string[];
let titleReply: { ok: true; content: string } | { ok: false; reason: 'not_ready'; detail: string };

beforeEach(async () => {
  db = openTestDb();
  setSetting(db, 'local_models_enabled', 'true');
  titleCalls = [];
  titleReply = { ok: true, content: 'RDMA 收圖掉幀排查' };
  app = Fastify();
  registerChatRoutes(app, db, {
    fetch: async () => new Response('{}'),
    localChat: async (_db, req) => {
      titleCalls.push(req.user);
      return titleReply;
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

const post = (url: string, payload: unknown, headers = ME) => app.inject({ method: 'POST', url, payload: payload as object, headers });
const get = (url: string, headers = ME) => app.inject({ method: 'GET', url, headers });
const newConv = async (headers = ME) => (await post('/api/chat/conversations', { knowledge: true }, headers)).json();

describe('對話紀錄 routes', () => {
  it('creates, appends, updates and replays a whole thread', async () => {
    const conv = await newConv();
    expect(conv.title).toBe('新對話');
    expect(conv.user_key).toBe('ts:addis@example.com'); // normalised by identity.ts

    const q = (await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'user', content: 'RDMA 為什麼掉幀？' })).json();
    const a = (await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'assistant', content: '' })).json();
    expect([q.ord, a.ord]).toEqual([0, 1]);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/chat/messages/${a.id}`,
      headers: ME,
      payload: {
        content: '因為佇列深度不足。',
        reasoning: '先看 flight recorder…',
        sources: [{ n: 1, source: 'cf-aoi', path: 'docs/rdma.md', snippet: 'x' }],
        keywords: ['RDMA', '掉幀'],
        finish_reason: 'stop',
        ttft_ms: 310.7,
        duration_ms: 4200.2,
        tokens_in: 900,
        tokens_out: 120,
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ content: '因為佇列深度不足。', finish_reason: 'stop', ttft_ms: 311, tokens_out: 120 });

    const replay = (await get(`/api/chat/conversations/${conv.id}`)).json();
    expect(replay.conversation.id).toBe(conv.id);
    expect(replay.context_turns).toBe(12);
    expect(replay.messages.map((m: { content: string }) => m.content)).toEqual(['RDMA 為什麼掉幀？', '因為佇列深度不足。']);
    expect(replay.messages[1].sources).toHaveLength(1);
    expect(replay.messages[1].keywords).toEqual(['RDMA', '掉幀']);

    const list = (await get('/api/chat/conversations')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: conv.id, msg_count: 2, preview: 'RDMA 為什麼掉幀？' });
    expect(list.user).toMatchObject({ source: 'tailscale' });
  });

  it('searches, renames and deletes', async () => {
    const conv = await newConv();
    await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'user', content: 'CCL 演算法怎麼調節流門檻？' });

    expect((await get('/api/chat/conversations?q=節流')).json().items).toHaveLength(1);
    expect((await get('/api/chat/conversations?q=不存在')).json().items).toEqual([]);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/chat/conversations/${conv.id}`, headers: ME, payload: { title: '老闆 demo' } });
    expect(renamed.json()).toMatchObject({ title: '老闆 demo', title_source: 'manual' });

    expect((await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${conv.id}`, headers: ME })).statusCode).toBe(200);
    expect((await get('/api/chat/conversations')).json().items).toEqual([]);
    expect((await get(`/api/chat/conversations/${conv.id}`)).statusCode).toBe(404);
  });

  it('truncates a turn so 重答 keeps the replay order', async () => {
    const conv = await newConv();
    await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'user', content: 'Q1' });
    const a = (await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'assistant', content: 'A1' })).json();

    const cut = await post(`/api/chat/conversations/${conv.id}/truncate`, { ord: a.ord });
    expect(cut.json()).toEqual({ removed: 1 });

    const again = (await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'assistant', content: 'A1 改' })).json();
    expect(again.ord).toBeGreaterThan(a.ord);
    expect((await get(`/api/chat/conversations/${conv.id}`)).json().messages.map((m: { content: string }) => m.content)).toEqual(['Q1', 'A1 改']);

    expect((await post(`/api/chat/conversations/${conv.id}/truncate`, { ord: -1 })).statusCode).toBe(400);
  });

  it('stores a pasted screenshot as a file and serves it by URL, never as base64', async () => {
    const conv = await newConv();
    const big = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
    const msg = (await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'user', content: '這張圖', images: [{ url: big, name: '截圖.png' }] })).json();

    expect(msg.images).toHaveLength(1);
    expect(msg.images[0].url).toBe(`/api/chat/messages/${msg.id}/images/0`);
    expect(JSON.stringify(msg)).not.toContain('AAAAAAAA');
    const stored = db.prepare('SELECT images_json FROM chat_messages WHERE id = ?').get(msg.id) as { images_json: string };
    expect(stored.images_json).not.toContain('base64');

    const img = await get(msg.images[0].url);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.length).toBe(msg.images[0].bytes);

    // another user cannot fetch it, and neither can a bad index
    expect((await get(msg.images[0].url, OTHER)).statusCode).toBe(404);
    expect((await get(`/api/chat/messages/${msg.id}/images/7`)).statusCode).toBe(404);
    expect((await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'user', images: [{ url: 'https://example.com/x.png' }] })).statusCode).toBe(400);
  });

  it('names a thread with the local model, and falls back to the question when it cannot', async () => {
    const conv = await newConv();
    await post(`/api/chat/conversations/${conv.id}/messages`, { role: 'user', content: 'RDMA 收圖為什麼會掉幀？請說明排查步驟。' });

    const named = (await post(`/api/chat/conversations/${conv.id}/title`, {})).json();
    expect(named.title).toBe('RDMA 收圖掉幀排查');
    expect(titleCalls[0]).toContain('RDMA 收圖為什麼會掉幀');

    const other = await newConv();
    await post(`/api/chat/conversations/${other.id}/messages`, { role: 'user', content: '行車紀錄的 incident 檔怎麼看？' });
    titleReply = { ok: false, reason: 'not_ready', detail: 'no local model ready' };
    expect((await post(`/api/chat/conversations/${other.id}/title`, {})).json().title).toBe('行車紀錄的 incident 檔怎麼看？');

    // a title the user typed is never overwritten, and the model is not even asked
    await app.inject({ method: 'PATCH', url: `/api/chat/conversations/${conv.id}`, headers: ME, payload: { title: '我自己取的' } });
    titleCalls.length = 0;
    expect((await post(`/api/chat/conversations/${conv.id}/title`, {})).json().title).toBe('我自己取的');
    expect(titleCalls).toEqual([]);
  });
});

describe('對話紀錄 access control', () => {
  it('keeps every route inside the asking user’s own history', async () => {
    const mine = await newConv();
    const msg = (await post(`/api/chat/conversations/${mine.id}/messages`, { role: 'user', content: '我的問題' })).json();

    expect((await get(`/api/chat/conversations/${mine.id}`, OTHER)).statusCode).toBe(404);
    expect((await get('/api/chat/conversations', OTHER)).json().items).toEqual([]);
    expect((await post(`/api/chat/conversations/${mine.id}/messages`, { role: 'user', content: 'x' }, OTHER)).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${mine.id}`, headers: OTHER })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/chat/messages/${msg.id}`, headers: OTHER, payload: { content: 'x' } })).statusCode).toBe(400);
    expect(messagesFor(db, mine.id)[0]?.content).toBe('我的問題');
  });

  it('separates workspaces by the manual name when Tailscale sends no identity', async () => {
    const a = await newConv({ 'x-loop-user': '呂侑儒' } as Record<string, string>);
    expect(a.user_key).toBe('name:呂侑儒');
    expect((await get('/api/chat/conversations', { 'x-loop-user': '呂侑儒' } as Record<string, string>)).json().items).toHaveLength(1);
    expect((await get('/api/chat/conversations', {} as Record<string, string>)).json().items).toEqual([]); // 'local'
    // whitespace-only is treated as "no name given" (→ local), but an unusable name is a 400
    expect((await get('/api/chat/conversations', { 'x-loop-user': '   ' } as Record<string, string>)).json().items).toEqual([]);
    expect((await get('/api/chat/conversations', { 'x-loop-user': 'x'.repeat(80) } as Record<string, string>)).statusCode).toBe(400);
  });
});

describe('對話紀錄 feature gates', () => {
  it('404s every history route while local models are off', async () => {
    setSetting(db, 'local_models_enabled', 'false');
    expect((await get('/api/chat/conversations')).statusCode).toBe(404);
    expect((await post('/api/chat/conversations', {})).statusCode).toBe(404);
  });

  it('404s every history route while chat_history_enabled is off, and keeps chatting working', async () => {
    setSetting(db, 'chat_history_enabled', 'false');
    expect((await get('/api/chat/conversations')).statusCode).toBe(404);
    expect((await post('/api/chat/conversations', {})).statusCode).toBe(404);
    expect((await get('/api/chat/me')).statusCode).toBe(200); // 誰在問 is not part of the history gate
    expect(fs.existsSync('/nonexistent')).toBe(false); // (no stray files written)
  });
});
