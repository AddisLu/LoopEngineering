import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RawDatabase from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { upsertNode } from '../knowledge/store.js';
import { vecUpsert } from '../knowledge/vec.js';
import { bridgeEdges, type BridgeKnn } from '../knowledge/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

const DIM = 1024;
function vec(seed: number): number[] {
  const v = new Array(DIM).fill(0);
  v[seed % DIM] = 1;
  return v;
}

function insertSource(id: string, uri: string): void {
  db.prepare(`INSERT OR IGNORE INTO sources (id, kind, uri) VALUES (?, 'git', ?)`).run(id, uri);
}

function insertDocument(opts: { path: string; title: string; doc_kind: string; sourceId: string }): number {
  const info = db
    .prepare(`INSERT INTO documents (source_id, path, title, doc_kind) VALUES (?, ?, ?, ?)`)
    .run(opts.sourceId, opts.path, opts.title, opts.doc_kind);
  return Number(info.lastInsertRowid);
}

function insertChunk(documentId: number, ord: number, text: string): number {
  const info = db.prepare(`INSERT INTO chunks (document_id, ord, text) VALUES (?, ?, ?)`).run(documentId, ord, text);
  const id = Number(info.lastInsertRowid);
  vecUpsert(db, 'vec_chunks', id, vec(id), id);
  return id;
}

function insertCuratedNode(title: string): string {
  const node = upsertNode(db, { title, kind: 'tech', scope: 'global', status: 'approved' });
  const rowid = (db.prepare(`SELECT rowid AS rowid FROM knowledge_nodes WHERE id = ?`).get(node.id) as { rowid: number })
    .rowid;
  vecUpsert(db, 'vec_nodes', rowid, vec(rowid), node.id);
  return node.id;
}

/** A raw db with schema applied but the vec extension never loaded — isVecAvailable() is
 * false and vec_chunks/vec_nodes don't exist, mirroring a host without the native binary. */
function freshUnloadedDb(): Database.Database {
  const raw = new RawDatabase(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return raw;
}

describe('bridgeEdges: no sqlite-vec -> empty, never throws', () => {
  it('degrades to [] when the vec extension never loaded (no vec_nodes/vec_chunks tables)', () => {
    const fresh = freshUnloadedDb();
    try {
      expect(() => bridgeEdges(fresh)).not.toThrow();
      expect(bridgeEdges(fresh)).toEqual([]);
    } finally {
      fresh.close();
    }
  });
});

describe('bridgeEdges: knn failure -> empty, never throws', () => {
  it('a throwing knn degrades to [] even though sqlite-vec is available', () => {
    insertSource('src_op', 'http://op.example');
    const doc = insertDocument({ path: 'op:1', title: '【X】Project', doc_kind: 'op_project', sourceId: 'src_op' });
    insertChunk(doc, 0, 'chunk text');
    insertCuratedNode('Curated node');

    const throwingKnn: BridgeKnn = () => {
      throw new Error('simulated sqlite-vec failure');
    };
    expect(() => bridgeEdges(db, {}, throwingKnn)).not.toThrow();
    expect(bridgeEdges(db, {}, throwingKnn)).toEqual([]);
  });
});

describe('bridgeEdges: node<->document cross-layer edges (injected knn)', () => {
  it('connects a curated node to the nearest documents (deduped to owning document, closest chunk wins)', () => {
    insertSource('src_op', 'http://op.example');
    const doc1 = insertDocument({ path: 'op:1', title: '【X】P1', doc_kind: 'op_project', sourceId: 'src_op' });
    const doc2 = insertDocument({ path: 'op:2', title: '【X】P2', doc_kind: 'op_project', sourceId: 'src_op' });
    const chunkA = insertChunk(doc1, 0, 'a');
    const chunkB = insertChunk(doc1, 1, 'b'); // second chunk of the SAME document -> dedup to doc1, closest wins
    const chunkC = insertChunk(doc2, 0, 'c');
    const nodeId = insertCuratedNode('Isolated node');

    const knn: BridgeKnn = (_db, table, _embedding, _k) => {
      if (table !== 'vec_chunks') return [];
      return [
        { rowid: chunkA, refId: chunkA, distance: 0.4 },
        { rowid: chunkB, refId: chunkB, distance: 0.1 }, // closer than chunkA, same document
        { rowid: chunkC, refId: chunkC, distance: 0.2 },
      ];
    };

    const edges = bridgeEdges(db, { topK: 3 }, knn);
    const toDoc1 = edges.find((e) => e.src === nodeId && e.dst === `doc_${doc1}`);
    const toDoc2 = edges.find((e) => e.src === nodeId && e.dst === `doc_${doc2}`);
    expect(toDoc1).toBeDefined(); // isolated node now connected
    expect(toDoc2).toBeDefined();
    expect(edges.filter((e) => e.src === nodeId).map((e) => e.dst).sort()).toEqual([`doc_${doc1}`, `doc_${doc2}`].sort());
    expect(edges.every((e) => e.relation === 'related')).toBe(true);
  });

  it('caps neighbors to topK per source regardless of how many the knn implementation returns', () => {
    insertSource('src_op', 'http://op.example');
    const docs = [1, 2, 3].map((i) =>
      insertDocument({ path: `op:${i}`, title: `【X】P${i}`, doc_kind: 'op_project', sourceId: 'src_op' }),
    );
    const chunks = docs.map((d, i) => insertChunk(d, 0, `chunk ${i}`));
    const nodeId = insertCuratedNode('Node');

    const knn: BridgeKnn = (_db, table) => {
      if (table !== 'vec_chunks') return [];
      // ascending distance, more entries than topK -- bridgeEdges must still cap to topK
      return chunks.map((c, i) => ({ rowid: c, refId: c, distance: i * 0.1 }));
    };

    const edges = bridgeEdges(db, { topK: 2 }, knn);
    expect(edges.filter((e) => e.src === nodeId)).toHaveLength(2);
    // the two closest documents survive, the farthest (3rd, beyond the cap) is dropped
    expect(edges.some((e) => e.dst === `doc_${docs[2]}`)).toBe(false);
  });

  it('filters neighbors farther than the threshold', () => {
    insertSource('src_op', 'http://op.example');
    const near = insertDocument({ path: 'op:near', title: '【X】Near', doc_kind: 'op_project', sourceId: 'src_op' });
    const far = insertDocument({ path: 'op:far', title: '【X】Far', doc_kind: 'op_project', sourceId: 'src_op' });
    const chunkNear = insertChunk(near, 0, 'near chunk');
    const chunkFar = insertChunk(far, 0, 'far chunk');
    const nodeId = insertCuratedNode('Node');

    const knn: BridgeKnn = (_db, table) => {
      if (table !== 'vec_chunks') return [];
      return [
        { rowid: chunkNear, refId: chunkNear, distance: 0.1 },
        { rowid: chunkFar, refId: chunkFar, distance: 0.9 },
      ];
    };

    const edges = bridgeEdges(db, { topK: 5, threshold: 0.5 }, knn);
    expect(edges).toEqual([{ src: nodeId, dst: `doc_${near}`, relation: 'related' }]);
  });

  it('deduplicates an edge discovered from both directions (node->doc and doc->node) into one', () => {
    insertSource('src_op', 'http://op.example');
    const doc = insertDocument({ path: 'op:1', title: '【X】P1', doc_kind: 'op_project', sourceId: 'src_op' });
    const chunk = insertChunk(doc, 0, 'chunk');
    const nodeId = insertCuratedNode('Node');

    const knn: BridgeKnn = (_db, table) => {
      if (table === 'vec_chunks') return [{ rowid: chunk, refId: chunk, distance: 0.2 }];
      if (table === 'vec_nodes') return [{ rowid: 1, refId: nodeId, distance: 0.2 }];
      return [];
    };

    const edges = bridgeEdges(db, { topK: 5 }, knn);
    const matching = edges.filter(
      (e) => (e.src === nodeId && e.dst === `doc_${doc}`) || (e.src === `doc_${doc}` && e.dst === nodeId),
    );
    expect(matching).toHaveLength(1);
  });
});

describe('bridgeEdges: knn call signature reaches the real vecKnn by default', () => {
  it('uses real vecKnn end-to-end when no knn is injected (no fake neighbors -> no edges, but never throws)', () => {
    insertSource('src_op', 'http://op.example');
    const doc = insertDocument({ path: 'op:1', title: '【X】P1', doc_kind: 'op_project', sourceId: 'src_op' });
    insertChunk(doc, 0, 'chunk');
    insertCuratedNode('Node');

    expect(() => bridgeEdges(db)).not.toThrow();
    expect(Array.isArray(bridgeEdges(db))).toBe(true);
  });
});
