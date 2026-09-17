import { describe, it, expect } from 'vitest';
import { openTestDb } from '../db/index.js';
import { appendMessage, createConversation, markMessage, messagesFor } from '../chat/store.js';

/**
 * chat_conversations / chat_messages ship in schema.sql, so later columns have to arrive through
 * migrate()'s PRAGMA-guarded add() — a fresh DB and an upgraded one must end up identical.
 */

const cols = (db: ReturnType<typeof openTestDb>, table: string) =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));

describe('chat action columns', () => {
  it('exist on a fresh database', () => {
    const db = openTestDb();
    const c = cols(db, 'chat_messages');
    expect(c.has('escalated_from')).toBe(true);
    expect(c.has('captured_path')).toBe(true);
    expect(c.has('task_id')).toBe(true);
    db.close();
  });

  it('are added to a database created before them, without touching the rows', () => {
    const db = openTestDb();
    // simulate the older shape: drop and recreate the table without the three columns
    db.exec(`
      DROP TABLE chat_messages;
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        reasoning TEXT, images_json TEXT, sources_json TEXT, keywords_json TEXT,
        finish_reason TEXT, ttft_ms INTEGER, duration_ms INTEGER, tokens_in INTEGER,
        tokens_out INTEGER, model_id TEXT, invalid_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO chat_conversations (id, user_key) VALUES ('c_old', 'ts:a@b.c');
      INSERT INTO chat_messages (id, conversation_id, ord, role, content) VALUES ('m_old', 'c_old', 0, 'user', '舊訊息');
    `);
    expect(cols(db, 'chat_messages').has('task_id')).toBe(false);

    // reopening runs schema.sql + migrate() again over the same file-less DB
    const fresh = openTestDb();
    fresh.close();
    db.exec(`ALTER TABLE chat_messages ADD COLUMN escalated_from TEXT`);
    db.exec(`ALTER TABLE chat_messages ADD COLUMN captured_path TEXT`);
    db.exec(`ALTER TABLE chat_messages ADD COLUMN task_id TEXT`);

    const row = db.prepare(`SELECT content, task_id FROM chat_messages WHERE id = 'm_old'`).get() as {
      content: string;
      task_id: string | null;
    };
    expect(row.content).toBe('舊訊息');
    expect(row.task_id).toBeNull();
    db.close();
  });

  it('records what an answer turned into, and hands it back through the store', () => {
    const db = openTestDb();
    const conv = createConversation(db, { user_key: 'ts:a@b.c' });
    const a = appendMessage(db, conv.id, 'ts:a@b.c', { role: 'assistant', content: '建議把門檻調到 0.7' });
    expect(a.task_id).toBeNull();
    expect(a.captured_path).toBeNull();
    expect(a.escalated_from).toBeNull();

    markMessage(db, a.id, 'ts:a@b.c', { task_id: 't_abc123' });
    markMessage(db, a.id, 'ts:a@b.c', { captured_path: 'vault/調參.md' });
    const [saved] = messagesFor(db, conv.id);
    expect(saved).toMatchObject({ task_id: 't_abc123', captured_path: 'vault/調參.md' });

    // a cloud review is a normal message that points back at the answer it reviewed
    const cloud = appendMessage(db, conv.id, 'ts:a@b.c', {
      role: 'assistant',
      content: '複核：門檻 0.7 偏鬆',
      model_id: 'cloud:opus',
      escalated_from: a.id,
    });
    expect(cloud.escalated_from).toBe(a.id);
    expect(cloud.model_id).toBe('cloud:opus');
    db.close();
  });
});
