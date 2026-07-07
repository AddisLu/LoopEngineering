import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RawDatabase from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { loadVec, isVecAvailable, vecUpsert, vecKnn, type VecLoader } from '../knowledge/vec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

/** A raw in-memory db with schema.sql applied but WITHOUT the automatic real loadVec()
 * call that openTestDb()/getDb() perform — needed so these tests can inject their own
 * (possibly failing) loader on a db the vec.ts memoization hasn't touched yet. */
function freshUnloadedDb(): Database.Database {
  const raw = new RawDatabase(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return raw;
}

const DIM = 1024;
/** One-hot-ish vector padded to the default embed_dim so tests don't hardcode 1024 zeros. */
function vec(...entries: [number, number][]): number[] {
  const v = new Array(DIM).fill(0);
  for (const [i, val] of entries) v[i] = val;
  return v;
}

// ---- 1. real extension load (runtime probe, like the FTS5 trigram probe elsewhere) ----

describe('vec: real sqlite-vec extension load via openTestDb()', () => {
  it('loads successfully and creates the vec_chunks/vec_nodes virtual tables', () => {
    expect(isVecAvailable(db)).toBe(true);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vec_chunks','vec_nodes')`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['vec_chunks', 'vec_nodes']);
  });

  it('is idempotent — calling loadVec again on the same db is a cheap no-op returning the memoized result', () => {
    expect(loadVec(db, DIM)).toBe(true);
    expect(loadVec(db, DIM)).toBe(true);
  });
});

// ---- 2. loadExtension failure -> guarded degrade to FTS-only, never crashes ----

describe('vec: loadExtension failure degrades to FTS-only', () => {
  const throwingLoader: VecLoader = () => {
    throw new Error('simulated: native extension not present on this platform');
  };

  it('returns false, marks unavailable, and does not create the vec0 tables', () => {
    const fresh = freshUnloadedDb();
    try {
      expect(() => loadVec(fresh, DIM, throwingLoader)).not.toThrow();
      expect(loadVec(fresh, DIM, throwingLoader)).toBe(false);
      expect(isVecAvailable(fresh)).toBe(false);
      const tables = fresh
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vec_chunks','vec_nodes')`)
        .all();
      expect(tables).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it('vecUpsert/vecKnn are safe no-ops (never throw) when the extension is unavailable', () => {
    const fresh = freshUnloadedDb();
    try {
      loadVec(fresh, DIM, throwingLoader);
      expect(() => vecUpsert(fresh, 'vec_chunks', 1, vec([0, 1]), 1)).not.toThrow();
      expect(vecKnn(fresh, 'vec_chunks', vec([0, 1]), 5)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it('plain knowledge_nodes FTS queries keep working unaffected (guard, not crash)', () => {
    const fresh = freshUnloadedDb();
    try {
      loadVec(fresh, DIM, throwingLoader);
      expect(() => fresh.prepare(`SELECT * FROM knowledge_nodes WHERE invalid_at IS NULL`).all()).not.toThrow();
    } finally {
      fresh.close();
    }
  });
});

// ---- 3. vecUpsert/vecKnn round trip (injected fake vectors — no GPU/model needed) ----

describe('vec: vecUpsert + vecKnn round trip', () => {
  it('inserts vectors and returns nearest neighbors ordered by distance', () => {
    // vec_chunks.chunk_id is INTEGER (mirrors chunks.id); vec_nodes.node_id is TEXT
    // (mirrors knowledge_nodes.id) — vec0 enforces the metadata column type strictly.
    vecUpsert(db, 'vec_chunks', 1, vec([0, 1]), 101); // unit vector along dim 0
    vecUpsert(db, 'vec_chunks', 2, vec([1, 1]), 102); // unit vector along dim 1 (orthogonal to a)
    vecUpsert(db, 'vec_chunks', 3, vec([0, 0.9], [1, 0.1]), 103); // close to a, far from b

    const results = vecKnn(db, 'vec_chunks', vec([0, 1]), 3);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ rowid: 1, refId: 101 });
    expect(results[0].distance).toBeCloseTo(0);
    expect(results.map((r) => r.refId).indexOf(103)).toBeLessThan(results.map((r) => r.refId).indexOf(102));
  });

  it('upsert replaces the previous vector/refId for the same rowid (delete-then-insert)', () => {
    vecUpsert(db, 'vec_nodes', 42, vec([0, 1]), 'node-old');
    vecUpsert(db, 'vec_nodes', 42, vec([2, 1]), 'node-new');

    const results = vecKnn(db, 'vec_nodes', vec([2, 1]), 1);
    expect(results).toEqual([{ rowid: 42, refId: 'node-new', distance: 0 }]);
  });

  it('keeps vec_chunks and vec_nodes independent (same rowid, different tables)', () => {
    vecUpsert(db, 'vec_chunks', 7, vec([0, 1]), 707);
    vecUpsert(db, 'vec_nodes', 7, vec([1, 1]), 'node-7');

    expect(vecKnn(db, 'vec_chunks', vec([0, 1]), 1)).toEqual([{ rowid: 7, refId: 707, distance: 0 }]);
    expect(vecKnn(db, 'vec_nodes', vec([1, 1]), 1)).toEqual([{ rowid: 7, refId: 'node-7', distance: 0 }]);
  });
});

// ---- 4. schema: sources/documents/chunks tables exist and cascade correctly ----

describe('schema: sources/documents/chunks (Phase 0 foundation, unpopulated until Phase 1)', () => {
  it('supports the bi-temporal insert/invalidate shape and cascades on delete', () => {
    db.prepare(`INSERT INTO sources (id, kind, uri) VALUES ('src_1', 'git', '/repo')`).run();
    const docId = db
      .prepare(`INSERT INTO documents (source_id, path, doc_kind) VALUES ('src_1', 'a.md', 'md')`)
      .run().lastInsertRowid as number;
    db.prepare(`INSERT INTO chunks (document_id, ord, text) VALUES (?, 0, 'hello world')`).run(docId);

    const chunkCountBefore = (db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
    expect(chunkCountBefore).toBe(1);

    db.prepare(`DELETE FROM documents WHERE id = ?`).run(docId);
    const chunkCountAfter = (db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
    expect(chunkCountAfter).toBe(0); // ON DELETE CASCADE
  });
});
