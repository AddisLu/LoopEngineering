import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { vecUpsert } from '../knowledge/vec.js';
import { search, reciprocalRankFusion } from '../knowledge/retrieve.js';
import type { EmbedExec } from '../knowledge/embed.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

function insertSource(id: string, kind: string, uri: string): void {
  db.prepare(`INSERT INTO sources (id, kind, uri) VALUES (?, ?, ?)`).run(id, kind, uri);
}

function insertDocument(opts: { source_id: string; path: string; uri?: string; doc_kind?: string }): number {
  const info = db
    .prepare(`INSERT INTO documents (source_id, path, uri, doc_kind) VALUES (?, ?, ?, ?)`)
    .run(opts.source_id, opts.path, opts.uri ?? null, opts.doc_kind ?? null);
  return Number(info.lastInsertRowid);
}

function insertChunk(opts: {
  document_id: number;
  text: string;
  section?: string | null;
  start_line?: number | null;
  end_line?: number | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chunks (document_id, ord, text, section, start_line, end_line)
       VALUES (?, 0, ?, ?, ?, ?)`,
    )
    .run(opts.document_id, opts.text, opts.section ?? null, opts.start_line ?? null, opts.end_line ?? null);
  return Number(info.lastInsertRowid);
}

const DIM = 1024;
function vec(...entries: [number, number][]): number[] {
  const v = new Array(DIM).fill(0);
  for (const [i, val] of entries) v[i] = val;
  return v;
}

// ---- 1. reciprocalRankFusion: pure function ----

describe('reciprocalRankFusion', () => {
  it('a single ranked list degrades to a monotonic transform of its own order', () => {
    const scores = reciprocalRankFusion([[10, 20, 30]]);
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(ranked).toEqual([10, 20, 30]);
  });

  it('an id present in a better rank across two lists outranks one only present in the first list', () => {
    // id 1: rank0 in list A only. id 2: rank1 in list A, rank0 in list B.
    const scores = reciprocalRankFusion([
      [1, 2, 3],
      [2],
    ]);
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(ranked[0]).toBe(2);
    expect(ranked[1]).toBe(1);
  });

  it('sums exactly 1/(k+rank) per appearance (k=60 default)', () => {
    const scores = reciprocalRankFusion([[5], [5]]);
    expect(scores.get(5)).toBeCloseTo(1 / 61 + 1 / 61);
  });
});

// ---- 2. search(): FTS-only ranking + citations (rag_enabled=false, the default) ----

describe('search: FTS-only (rag_enabled=false default)', () => {
  it('ranks chunks by keyword relevance and returns citation fields', async () => {
    insertSource('src_1', 'git', '/repo');
    const doc1 = insertDocument({ source_id: 'src_1', path: 'src/git/worktree.ts', uri: '/repo/src/git/worktree.ts', doc_kind: 'ts' });
    const doc2 = insertDocument({ source_id: 'src_1', path: 'README.md', uri: '/repo/README.md', doc_kind: 'md' });
    const chunk1 = insertChunk({ document_id: doc1, text: 'addWorktree cuts a fresh loop/<taskid> worktree from origin/base', start_line: 12, end_line: 34 });
    insertChunk({ document_id: doc2, text: 'This repo has nothing to do with the search term.' });

    const results = await search(db, 'addWorktree');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunk_id: chunk1,
      document_id: doc1,
      source_id: 'src_1',
      source_kind: 'git',
      path: 'src/git/worktree.ts',
      start_line: 12,
      end_line: 34,
    });
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('orders three matching chunks by term-frequency relevance (pure FTS, no vectors involved)', async () => {
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument({ source_id: 'src_1', path: 'a.md', doc_kind: 'md' });
    const c1 = insertChunk({ document_id: doc, text: 'keyword keyword keyword keyword keyword filler filler filler filler filler' });
    const c2 = insertChunk({ document_id: doc, text: 'keyword keyword keyword filler filler filler filler filler filler filler' });
    const c3 = insertChunk({ document_id: doc, text: 'keyword filler filler filler filler filler filler filler filler filler' });

    const results = await search(db, 'keyword');
    expect(results.map((r) => r.chunk_id)).toEqual([c1, c2, c3]);
  });

  it('short queries (<3 chars) fall back to LIKE — the trigram tokenizer cannot match them', async () => {
    insertSource('src_1', 'vault', '/vault');
    const doc = insertDocument({ source_id: 'src_1', path: 'notes.md', doc_kind: 'md' });
    const chunk = insertChunk({ document_id: doc, text: '公司只能用 Windows 11，注意編碼問題' });

    const results = await search(db, '只能');
    expect(results.map((r) => r.chunk_id)).toContain(chunk);
  });

  it('scope filters to documents whose uri starts with the given path prefix', async () => {
    insertSource('src_repo', 'git', '/repo');
    insertSource('src_other', 'git', '/other');
    const docRepo = insertDocument({ source_id: 'src_repo', path: 'a.ts', uri: '/repo/a.ts', doc_kind: 'ts' });
    const docOther = insertDocument({ source_id: 'src_other', path: 'a.ts', uri: '/other/a.ts', doc_kind: 'ts' });
    const chunkRepo = insertChunk({ document_id: docRepo, text: 'shared_keyword only in repo' });
    insertChunk({ document_id: docOther, text: 'shared_keyword only in other' });

    const results = await search(db, 'shared_keyword', { scope: '/repo' });
    expect(results.map((r) => r.chunk_id)).toEqual([chunkRepo]);
  });

  it('kind filters to one doc_kind', async () => {
    insertSource('src_1', 'git', '/repo');
    const docMd = insertDocument({ source_id: 'src_1', path: 'a.md', doc_kind: 'md' });
    const docTs = insertDocument({ source_id: 'src_1', path: 'a.ts', doc_kind: 'ts' });
    const chunkMd = insertChunk({ document_id: docMd, text: 'unique_term in markdown' });
    insertChunk({ document_id: docTs, text: 'unique_term in typescript' });

    const results = await search(db, 'unique_term', { kind: 'md' });
    expect(results.map((r) => r.chunk_id)).toEqual([chunkMd]);
  });

  it('rag_enabled=false never calls the embed exec, even with vectors already stored', async () => {
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument({ source_id: 'src_1', path: 'a.md', doc_kind: 'md' });
    const chunk = insertChunk({ document_id: doc, text: 'keyword text here' });
    vecUpsert(db, 'vec_chunks', chunk, vec([0, 1]), chunk);

    let calls = 0;
    const spyEmbed: EmbedExec = async (_bin, _args, texts) => {
      calls++;
      return texts.map(() => vec([0, 1]));
    };
    await search(db, 'keyword', { embedExec: spyEmbed });
    expect(calls).toBe(0);
  });
});

// ---- 3. search(): hybrid RRF fusion (rag_enabled=true) ----

describe('search: hybrid FTS+vec fusion (rag_enabled=true)', () => {
  it('a strong vector match promotes a chunk above one that only wins on keyword frequency', async () => {
    setSetting(db, 'rag_enabled', 'true');
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument({ source_id: 'src_1', path: 'a.md', doc_kind: 'md' });
    // FTS ranks: chunk1 (5x keyword) > chunk2 (3x keyword) > chunk3 (1x keyword).
    const chunk1 = insertChunk({ document_id: doc, text: 'keyword keyword keyword keyword keyword filler filler filler filler filler' });
    const chunk2 = insertChunk({ document_id: doc, text: 'keyword keyword keyword filler filler filler filler filler filler filler' });
    const chunk3 = insertChunk({ document_id: doc, text: 'keyword filler filler filler filler filler filler filler filler filler' });
    // Only chunk2 is embedded, with a vector identical to the query -> best possible vec rank.
    vecUpsert(db, 'vec_chunks', chunk2, vec([0, 1]), chunk2);

    const queryVector = vec([0, 1]);
    const fakeEmbed: EmbedExec = async (_bin, _args, texts) => texts.map(() => queryVector);

    // Fused order (chunk2 first, boosted by its vec match) differs from what pure FTS
    // alone would give (chunk1 first, by keyword frequency — see the FTS-only describe
    // block's identical fixture above), demonstrating the fusion actually did something.
    const results = await search(db, 'keyword', { embedExec: fakeEmbed });
    expect(results.map((r) => r.chunk_id)).toEqual([chunk2, chunk1, chunk3]);
  });

  it('vec0 has no metadata filter — a vector-only candidate outside scope is dropped, not backfilled', async () => {
    setSetting(db, 'rag_enabled', 'true');
    insertSource('src_other', 'git', '/other');
    const docOther = insertDocument({ source_id: 'src_other', path: 'b.md', uri: '/other/b.md', doc_kind: 'md' });
    const chunkOther = insertChunk({ document_id: docOther, text: 'nothing matches here either' });
    vecUpsert(db, 'vec_chunks', chunkOther, vec([0, 1]), chunkOther);

    const queryVector = vec([0, 1]);
    const fakeEmbed: EmbedExec = async (_bin, _args, texts) => texts.map(() => queryVector);

    // The query text doesn't match anything via FTS; chunkOther's only route in is its
    // vector, but it's outside `scope` — so the fused candidate is dropped entirely rather
    // than backfilled from within scope, leaving an empty result (not a false positive
    // from vec0's blind spot to metadata filters).
    const results = await search(db, 'irrelevant query', { scope: '/repo', embedExec: fakeEmbed });
    expect(results).toEqual([]);
  });

  it('degrades to FTS-only when the query fails to embed (embedExec returns no vector)', async () => {
    setSetting(db, 'rag_enabled', 'true');
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument({ source_id: 'src_1', path: 'a.md', doc_kind: 'md' });
    const chunk = insertChunk({ document_id: doc, text: 'keyword only chunk' });

    const brokenEmbed: EmbedExec = async () => [];
    const results = await search(db, 'keyword', { embedExec: brokenEmbed });
    expect(results.map((r) => r.chunk_id)).toEqual([chunk]);
  });

  it('degrades to FTS-only (never throws) when the embed call itself rejects', async () => {
    setSetting(db, 'rag_enabled', 'true');
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument({ source_id: 'src_1', path: 'a.md', doc_kind: 'md' });
    const chunk = insertChunk({ document_id: doc, text: 'keyword only chunk' });

    const throwingEmbed: EmbedExec = async () => {
      throw new Error('simulated: embed daemon/one-shot both down');
    };
    const results = await search(db, 'keyword', { embedExec: throwingEmbed });
    expect(results.map((r) => r.chunk_id)).toEqual([chunk]);
  });
});

// ---- 4. search(): topK truncation ----

describe('search: topK', () => {
  it('truncates fused results to topK (default rag_top_k setting)', async () => {
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument({ source_id: 'src_1', path: 'a.md', doc_kind: 'md' });
    for (let i = 0; i < 5; i++) insertChunk({ document_id: doc, text: `keyword chunk number ${i}` });

    const results = await search(db, 'keyword', { topK: 2 });
    expect(results).toHaveLength(2);
  });
});

// ---- 5. REST: /api/rag/search wiring ----

describe('REST: /api/rag/search', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('returns citation-bearing results for a matching query', async () => {
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument({ source_id: 'src_1', path: 'src/git/worktree.ts', uri: '/repo/src/git/worktree.ts', doc_kind: 'ts' });
    insertChunk({ document_id: doc, text: 'addWorktree cuts a fresh worktree', start_line: 1, end_line: 5 });

    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: '/api/rag/search?q=addWorktree' });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path: 'src/git/worktree.ts', start_line: 1, end_line: 5 });
  });

  it('400s when q is missing', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: '/api/rag/search' });
    expect(res.statusCode).toBe(400);
  });

  it('an empty corpus returns an empty result list, not an error', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: '/api/rag/search?q=anything' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
  });
});
