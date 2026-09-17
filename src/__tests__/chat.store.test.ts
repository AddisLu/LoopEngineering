import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { paths } from '../config.js';
import {
  ChatInputError,
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  getMessage,
  imagePath,
  listConversations,
  messagesFor,
  pruneConversations,
  renameConversation,
  searchConversations,
  setAutoTitle,
  truncateFrom,
  updateMessage,
} from '../chat/store.js';

/**
 * 模型對話 history store. Hermetic: an in-memory DB plus the vitest-isolated LOOP_DATA_DIR for
 * the pasted-screenshot files.
 */

const A = 'ts:addis@example.com';
const B = 'ts:other@example.com';
// 1x1 PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});

const turn = (convId: string, user: string, q: string, a: string) => {
  appendMessage(db, convId, user, { role: 'user', content: q });
  return appendMessage(db, convId, user, { role: 'assistant', content: a });
};

describe('chat store CRUD', () => {
  it('round-trips a conversation and its turns', () => {
    const conv = createConversation(db, { user_key: A, user_label: '呂侑儒', knowledge: true, model_id: 'qwen38' });
    expect(conv.title).toBe('新對話');
    expect(conv.title_source).toBe('auto');
    expect(conv.knowledge).toBe(1);

    const q = appendMessage(db, conv.id, A, { role: 'user', content: 'CCL 是什麼？' });
    const a = appendMessage(db, conv.id, A, {
      role: 'assistant',
      content: '連通元件標記。',
      sources: [{ path: 'algo/ccl.md', snippet: 'x' }],
      keywords: ['CCL', '連通元件'],
      finish_reason: 'stop',
      ttft_ms: 120,
      tokens_out: 42,
    });

    expect([q.ord, a.ord]).toEqual([0, 1]);
    const msgs = messagesFor(db, conv.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]?.keywords).toEqual(['CCL', '連通元件']);
    expect(msgs[1]?.sources).toHaveLength(1);
    expect(msgs[1]?.tokens_out).toBe(42);
    // model_id falls back to the conversation's
    expect(msgs[1]?.model_id).toBe('qwen38');

    const summaries = listConversations(db, A);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.msg_count).toBe(2);
    expect(summaries[0]?.preview).toBe('CCL 是什麼？');
  });

  it('fills in a streamed answer through updateMessage', () => {
    const conv = createConversation(db, { user_key: A });
    const a = appendMessage(db, conv.id, A, { role: 'assistant', content: '' });
    const done = updateMessage(db, a.id, A, { content: '完整答案', finish_reason: 'stop', duration_ms: 900 });
    expect(done.content).toBe('完整答案');
    expect(done.finish_reason).toBe('stop');
    expect(done.ord).toBe(a.ord);
    expect(messagesFor(db, conv.id)).toHaveLength(1);
  });

  it('rejects bad input instead of writing half a row', () => {
    expect(() => createConversation(db, { user_key: '  ' })).toThrow(ChatInputError);
    const conv = createConversation(db, { user_key: A });
    expect(() => appendMessage(db, conv.id, A, { role: 'system' as 'user', content: 'x' })).toThrow(ChatInputError);
    expect(() => appendMessage(db, 'c_nope', A, { role: 'user', content: 'x' })).toThrow(ChatInputError);
    expect(() => renameConversation(db, conv.id, A, '   ')).toThrow(ChatInputError);
  });

  it('hides soft-deleted conversations from the sidebar', () => {
    const conv = createConversation(db, { user_key: A });
    turn(conv.id, A, '問', '答');
    expect(deleteConversation(db, conv.id, A)).toBe(true);
    expect(listConversations(db, A)).toEqual([]);
    expect(getConversation(db, conv.id, A)).toBeNull();
    expect(deleteConversation(db, conv.id, A)).toBe(false); // already gone
  });
});

describe('per-user separation', () => {
  it('never lets one user reach another user’s conversation', () => {
    const mine = createConversation(db, { user_key: A });
    turn(mine.id, A, '我的問題', '我的答案');

    expect(getConversation(db, mine.id, B)).toBeNull();
    expect(listConversations(db, B)).toEqual([]);
    expect(searchConversations(db, B, '我的問題')).toEqual([]);
    expect(deleteConversation(db, mine.id, B)).toBe(false);
    expect(() => appendMessage(db, mine.id, B, { role: 'user', content: 'x' })).toThrow(ChatInputError);
    expect(() => truncateFrom(db, mine.id, B, 0)).toThrow(ChatInputError);
    // …and A still has everything
    expect(messagesFor(db, mine.id)).toHaveLength(2);
  });
});

describe('ord across soft deletes (重答)', () => {
  it('keeps ord strictly increasing so the replay order survives a regenerate', () => {
    const conv = createConversation(db, { user_key: A });
    turn(conv.id, A, 'Q1', 'A1');
    const a2 = turn(conv.id, A, 'Q2', 'A2'); // ord 2,3

    expect(truncateFrom(db, conv.id, A, a2.ord)).toBe(1); // drop just the answer
    const redone = appendMessage(db, conv.id, A, { role: 'assistant', content: 'A2 改' });

    // the replacement must sort AFTER the soft-deleted row, not collide with it
    expect(redone.ord).toBeGreaterThan(a2.ord);
    expect(messagesFor(db, conv.id).map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2', 'A2 改']);

    const all = messagesFor(db, conv.id, { includeInvalid: true });
    expect(all.map((m) => m.ord)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(all.map((m) => m.ord)).size).toBe(all.length);
  });

  it('truncating a whole turn (編輯問題重問) leaves the rebuilt turn in order', () => {
    const conv = createConversation(db, { user_key: A });
    turn(conv.id, A, 'Q1', 'A1');
    const q2 = appendMessage(db, conv.id, A, { role: 'user', content: 'Q2' });
    appendMessage(db, conv.id, A, { role: 'assistant', content: 'A2' });

    expect(truncateFrom(db, conv.id, A, q2.ord)).toBe(2);
    turn(conv.id, A, 'Q2 改寫', 'A2 改寫');

    expect(messagesFor(db, conv.id).map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2 改寫', 'A2 改寫']);
  });
});

describe('search', () => {
  it('finds Chinese text through the trigram index and 2-character queries through the fallback', () => {
    const c1 = createConversation(db, { user_key: A, title: '取像流程' });
    turn(c1.id, A, 'RDMA 收圖為什麼會掉幀？', '因為佇列深度不足。');
    const c2 = createConversation(db, { user_key: A });
    turn(c2.id, A, 'CCL 演算法怎麼調？', '調整節流門檻。');

    // ≥3 chars: the trigram MATCH path
    expect(searchConversations(db, A, '佇列深度').map((c) => c.id)).toEqual([c1.id]);
    // 2 chars: shorter than one trigram, so only the LIKE fallback can answer
    expect(searchConversations(db, A, '收圖').map((c) => c.id)).toEqual([c1.id]);
    expect(searchConversations(db, A, '節流').map((c) => c.id)).toEqual([c2.id]);
    // title-only hit, and an empty query just lists
    expect(searchConversations(db, A, '取像').map((c) => c.id)).toEqual([c1.id]);
    expect(searchConversations(db, A, '   ')).toHaveLength(2);
    expect(searchConversations(db, A, '不存在的詞彙')).toEqual([]);
  });

  it('keeps the index in step with edited and deleted messages', () => {
    const conv = createConversation(db, { user_key: A });
    const a = appendMessage(db, conv.id, A, { role: 'assistant', content: '' });
    updateMessage(db, a.id, A, { content: '串流結束後才寫入的內容' });
    expect(searchConversations(db, A, '串流結束').map((c) => c.id)).toEqual([conv.id]);

    truncateFrom(db, conv.id, A, 0); // soft-deleted rows must not surface
    expect(searchConversations(db, A, '串流結束')).toEqual([]);
  });

  it('survives a query full of FTS operators', () => {
    const conv = createConversation(db, { user_key: A });
    turn(conv.id, A, 'NEAR("a" OR b) 這種字串', '好的');
    expect(() => searchConversations(db, A, 'NEAR("a" OR b)')).not.toThrow();
  });
});

describe('titles', () => {
  it('lets the local model name a thread but never overrides a human', () => {
    const conv = createConversation(db, { user_key: A });
    setAutoTitle(db, conv.id, 'RDMA 掉幀排查');
    expect(getConversation(db, conv.id, A)?.title).toBe('RDMA 掉幀排查');

    renameConversation(db, conv.id, A, '老闆 demo 用');
    setAutoTitle(db, conv.id, '模型又想改名');
    const after = getConversation(db, conv.id, A)!;
    expect(after.title).toBe('老闆 demo 用');
    expect(after.title_source).toBe('manual');
  });

  it('trims control characters and caps the length', () => {
    const conv = createConversation(db, { user_key: A });
    renameConversation(db, conv.id, A, `  多行\n標題  ${'長'.repeat(200)}`);
    const t = getConversation(db, conv.id, A)!.title;
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t).not.toMatch(/[\n\r]/);
    expect(t.startsWith('多行 標題')).toBe(true);
  });
});

describe('pasted screenshots', () => {
  it('stores the bytes on disk and keeps base64 out of the database', () => {
    const conv = createConversation(db, { user_key: A });
    const m = appendMessage(db, conv.id, A, {
      role: 'user',
      content: '這張圖是什麼？',
      images: [{ url: PNG, name: '畫面.png' }],
    });

    expect(m.images).toHaveLength(1);
    expect(m.images[0]?.mime).toBe('image/png');
    expect(m.images[0]?.bytes).toBeGreaterThan(0);

    const raw = db.prepare('SELECT images_json FROM chat_messages WHERE id = ?').get(m.id) as { images_json: string };
    expect(raw.images_json).not.toContain('base64');
    expect(raw.images_json).not.toContain(PNG.slice(30, 60));

    const found = imagePath(db, m.id, 0, A)!;
    expect(fs.existsSync(found.abs)).toBe(true);
    expect(found.abs.startsWith(path.join(paths.dataDir, 'chat-images'))).toBe(true);
    expect(fs.readFileSync(found.abs).length).toBe(m.images[0]?.bytes);

    expect(imagePath(db, m.id, 0, B)).toBeNull(); // ownership checked here too
    expect(imagePath(db, m.id, 9, A)).toBeNull();
  });

  it('refuses anything that is not an inline image, and refuses too many', () => {
    const conv = createConversation(db, { user_key: A });
    expect(() => appendMessage(db, conv.id, A, { role: 'user', images: [{ url: 'https://example.com/a.png' }] })).toThrow(
      ChatInputError,
    );
    expect(() =>
      appendMessage(db, conv.id, A, { role: 'user', images: Array.from({ length: 5 }, () => ({ url: PNG })) }),
    ).toThrow(ChatInputError);
    // a rejected message must not leave a row behind
    expect(messagesFor(db, conv.id)).toEqual([]);
  });
});

describe('retention', () => {
  it('prunes old conversations with their messages and image files, and keeps recent ones', () => {
    const old = createConversation(db, { user_key: A });
    const m = appendMessage(db, old.id, A, { role: 'user', content: '舊的', images: [{ url: PNG }] });
    const file = imagePath(db, m.id, 0, A)!.abs;
    const fresh = createConversation(db, { user_key: A });
    turn(fresh.id, A, '新的', '答');

    db.prepare(`UPDATE chat_conversations SET updated_at = datetime('now', '-90 days') WHERE id = ?`).run(old.id);
    expect(pruneConversations(db, 0)).toEqual({ conversations: 0, files: 0 }); // 0 = keep forever
    const swept = pruneConversations(db, 30);

    expect(swept.conversations).toBe(1);
    expect(swept.files).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(messagesFor(db, old.id)).toEqual([]); // cascade
    expect(getMessage(db, m.id, A)).toBeNull();
    expect(listConversations(db, A).map((c) => c.id)).toEqual([fresh.id]);
  });
});
