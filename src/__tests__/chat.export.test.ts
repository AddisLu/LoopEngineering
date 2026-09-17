import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { appendMessage, createConversation, getConversation, messagesFor, truncateFrom } from '../chat/store.js';
import { exportFilename, toMarkdown } from '../chat/export.js';

const USER = 'ts:addis@example.com';
let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

describe('toMarkdown', () => {
  it('writes the transcript with speakers, citations and what each answer became', () => {
    const conv = createConversation(db, { user_key: USER, user_label: '呂侑儒', title: 'RDMA 掉幀' });
    appendMessage(db, conv.id, USER, { role: 'user', content: 'RDMA 為什麼掉幀？' });
    appendMessage(db, conv.id, USER, {
      role: 'assistant',
      content: '因為佇列深度不足。',
      reasoning: '先看 flight recorder…',
      sources: [{ n: 1, source: 'cf-aoi', path: 'docs/rdma.md', section: '收圖', start_line: 12, end_line: 20, snippet: 'x' }],
    });
    appendMessage(db, conv.id, USER, { role: 'assistant', content: '複核意見', model_id: 'cloud:opus' });

    const md = toMarkdown(getConversation(db, conv.id, USER)!, messagesFor(db, conv.id));

    expect(md).toContain('# RDMA 掉幀');
    expect(md).toContain('對話者：呂侑儒');
    expect(md).toContain('## 你');
    expect(md).toContain('## 本地模型');
    expect(md).toContain('## 雲端複核 · opus'); // a shared doc must not blur who said what
    expect(md).toContain('[1] cf-aoi/docs/rdma.md · 收圖 第 12–20 行');
    expect(md).not.toContain('flight recorder'); // 思考過程 is left out by default
    expect(toMarkdown(getConversation(db, conv.id, USER)!, messagesFor(db, conv.id), { includeReasoning: true })).toContain(
      'flight recorder',
    );
  });

  it('skips soft-deleted turns, so a 重答 does not export twice', () => {
    const conv = createConversation(db, { user_key: USER });
    appendMessage(db, conv.id, USER, { role: 'user', content: '問題' });
    const bad = appendMessage(db, conv.id, USER, { role: 'assistant', content: '第一版答案' });
    truncateFrom(db, conv.id, USER, bad.ord);
    appendMessage(db, conv.id, USER, { role: 'assistant', content: '重答後的答案' });

    const md = toMarkdown(getConversation(db, conv.id, USER)!, messagesFor(db, conv.id));
    expect(md).toContain('重答後的答案');
    expect(md).not.toContain('第一版答案');
  });

  it('notes truncated and stopped answers, attachments, and the actions taken', () => {
    const conv = createConversation(db, { user_key: USER });
    appendMessage(db, conv.id, USER, { role: 'assistant', content: '被截斷的答案', finish_reason: 'length' });
    appendMessage(db, conv.id, USER, { role: 'assistant', content: '被停止的答案', finish_reason: 'abort' });
    const md = toMarkdown(getConversation(db, conv.id, USER)!, messagesFor(db, conv.id));
    expect(md).toContain('達到長度上限');
    expect(md).toContain('被中途停止');
  });

  it('keeps a Chinese title usable as a filename', () => {
    const conv = createConversation(db, { user_key: USER, title: 'RDMA/收圖: 掉幀?' });
    expect(exportFilename(getConversation(db, conv.id, USER)!)).toBe('RDMA收圖 掉幀.md');
  });
});
