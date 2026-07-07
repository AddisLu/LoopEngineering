import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createSource, getSource } from '../knowledge/ingest/sources.js';
import { ingestSource, ingestAll, ingestOne } from '../knowledge/ingest/ingest.js';
import type { EmbedExec } from '../knowledge/embed.js';
import { vecKnn } from '../knowledge/vec.js';
import type { DocumentRow, ChunkRow } from '../knowledge/ingest/types.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  tmpRoots = [];
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-ingest-${tag}-`));
  tmpRoots.push(d);
  return d;
}

function activeDocs(sourceId: string): DocumentRow[] {
  return db
    .prepare(`SELECT * FROM documents WHERE source_id = ? AND invalid_at IS NULL ORDER BY path`)
    .all(sourceId) as DocumentRow[];
}
function allDocs(sourceId: string): DocumentRow[] {
  return db.prepare(`SELECT * FROM documents WHERE source_id = ? ORDER BY id`).all(sourceId) as DocumentRow[];
}
function chunksFor(documentId: number): ChunkRow[] {
  return db.prepare(`SELECT * FROM chunks WHERE document_id = ? ORDER BY ord`).all(documentId) as ChunkRow[];
}

// vec_chunks' dimension is fixed at embed_dim (1024, the default) when the table is
// created — fake vectors must match it, so every fake embedding pads to DIM with the
// text length encoded in slot 0 (enough to make distinct texts distinguishable in a KNN).
const DIM = 1024;
function fakeVec(n: number, tag = 0): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = n;
  v[1] = tag;
  return v;
}
const fakeEmbed: EmbedExec = async (_bin, _args, texts) => texts.map((t) => fakeVec(t.length));

describe('ingestSource: fake file tree -> documents/chunks', () => {
  it('produces the correct document/chunk counts for a small tree, excluding a secret file', async () => {
    const root = mkTmpDir('basic');
    fs.writeFileSync(path.join(root, 'README.md'), '# Hello\nworld\n');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=shh\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    const result = await ingestSource(db, source);
    expect(result.documents_created).toBe(2);
    expect(result.skipped_unchanged).toBe(0);

    const docs = activeDocs(source.id);
    expect(docs.map((d) => d.path)).toEqual(['README.md', 'a.ts']);
    expect(docs.find((d) => d.path === '.env')).toBeUndefined();

    const readme = docs.find((d) => d.path === 'README.md')!;
    const chunks = chunksFor(readme.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.section).toBe('Hello');
  });

  it('a second run with no changes skips every file (skipped_unchanged, no new documents)', async () => {
    const root = mkTmpDir('unchanged');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nbody\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    const first = await ingestSource(db, source);
    expect(first.documents_created).toBe(1);

    const second = await ingestSource(db, source);
    expect(second.documents_created).toBe(0);
    expect(second.documents_replaced).toBe(0);
    expect(second.skipped_unchanged).toBe(1);
    expect(activeDocs(source.id)).toHaveLength(1);
  });

  it('changing a file bi-temporally supersedes it: old doc+chunks invalidated, new doc created, only that file is re-chunked', async () => {
    const root = mkTmpDir('changed');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\noriginal\n');
    fs.writeFileSync(path.join(root, 'b.md'), '# B\nstable\n');
    const source = createSource(db, { kind: 'folder', uri: root });
    await ingestSource(db, source);

    const beforeA = activeDocs(source.id).find((d) => d.path === 'a.md')!;
    const beforeAChunks = chunksFor(beforeA.id);

    fs.writeFileSync(path.join(root, 'a.md'), '# A\nCHANGED CONTENT\n');
    const second = await ingestSource(db, source);
    expect(second.documents_replaced).toBe(1);
    expect(second.documents_created).toBe(0);
    expect(second.skipped_unchanged).toBe(1); // b.md unchanged

    // old a.md document + its chunks are invalidated, never deleted
    const oldA = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(beforeA.id) as DocumentRow;
    expect(oldA.invalid_at).not.toBeNull();
    const oldAChunksAfter = db
      .prepare(`SELECT * FROM chunks WHERE document_id = ?`)
      .all(beforeA.id) as ChunkRow[];
    expect(oldAChunksAfter.every((c) => c.invalid_at !== null)).toBe(true);
    expect(oldAChunksAfter).toHaveLength(beforeAChunks.length);

    // exactly one active a.md document now exists, with fresh content/sha256
    const activeA = activeDocs(source.id).filter((d) => d.path === 'a.md');
    expect(activeA).toHaveLength(1);
    expect(activeA[0]!.id).not.toBe(beforeA.id);
    expect(activeA[0]!.sha256).not.toBe(beforeA.sha256);

    // b.md's document row is untouched (still the same id, still active)
    const activeB = activeDocs(source.id).find((d) => d.path === 'b.md')!;
    expect(activeB.invalid_at).toBeNull();
  });

  it('a file removed from the tree invalidates its document on the next run', async () => {
    const root = mkTmpDir('deleted');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nkeep\n');
    fs.writeFileSync(path.join(root, 'gone.md'), '# Gone\nbye\n');
    const source = createSource(db, { kind: 'folder', uri: root });
    await ingestSource(db, source);
    expect(activeDocs(source.id)).toHaveLength(2);

    fs.unlinkSync(path.join(root, 'gone.md'));
    const result = await ingestSource(db, source);
    expect(result.documents_invalidated).toBe(1);
    expect(result.skipped_unchanged).toBe(1);

    const active = activeDocs(source.id);
    expect(active.map((d) => d.path)).toEqual(['a.md']);
    const goneAll = allDocs(source.id).find((d) => d.path === 'gone.md')!;
    expect(goneAll.invalid_at).not.toBeNull();
  });

  it('rag_enabled=false (default): documents/chunks are stored but embed is never called', async () => {
    const root = mkTmpDir('norag');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nbody\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    let calls = 0;
    const spyEmbed: EmbedExec = async (bin, args, texts) => {
      calls++;
      return fakeEmbed(bin, args, texts);
    };
    const result = await ingestSource(db, source, { embedExec: spyEmbed });
    expect(calls).toBe(0);
    expect(result.chunks_created).toBeGreaterThan(0);
    expect(activeDocs(source.id)).toHaveLength(1);
  });

  it('rag_enabled=true: embed is called and vec_chunks gets a KNN-searchable row per chunk', async () => {
    setSetting(db, 'rag_enabled', 'true');
    const root = mkTmpDir('rag');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nbody\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    let seenTexts: string[] = [];
    const spyEmbed: EmbedExec = async (_bin, _args, texts) => {
      seenTexts = texts;
      return texts.map((t) => fakeVec(t.length, 1));
    };
    const result = await ingestSource(db, source, { embedExec: spyEmbed });
    expect(seenTexts.length).toBe(result.chunks_created);

    const doc = activeDocs(source.id)[0]!;
    const chunks = chunksFor(doc.id);
    expect(chunks.length).toBeGreaterThan(0);
    const knn = vecKnn(db, 'vec_chunks', fakeVec(chunks[0]!.text.length, 1), 5);
    expect(knn.some((r) => r.refId === chunks[0]!.id)).toBe(true);
  });

  it('re-embeds only the changed file on a second run (not the untouched one)', async () => {
    setSetting(db, 'rag_enabled', 'true');
    const root = mkTmpDir('reembed');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\noriginal\n');
    fs.writeFileSync(path.join(root, 'b.md'), '# B\nstable\n');
    const source = createSource(db, { kind: 'folder', uri: root });
    await ingestSource(db, source, { embedExec: fakeEmbed });

    fs.writeFileSync(path.join(root, 'a.md'), '# A\nCHANGED\n');
    let embeddedBatches: string[][] = [];
    const spyEmbed: EmbedExec = async (_bin, _args, texts) => {
      embeddedBatches.push(texts);
      return texts.map((t) => fakeVec(t.length));
    };
    await ingestSource(db, source, { embedExec: spyEmbed });

    const allEmbeddedText = embeddedBatches.flat().join('\n');
    expect(allEmbeddedText).toContain('CHANGED');
    expect(allEmbeddedText).not.toContain('stable');
  });
});

describe('ingestAll / ingestOne', () => {
  it('ingestAll only runs enabled sources', async () => {
    const rootA = mkTmpDir('all-a');
    const rootB = mkTmpDir('all-b');
    fs.writeFileSync(path.join(rootA, 'a.md'), '# A\n');
    fs.writeFileSync(path.join(rootB, 'b.md'), '# B\n');
    const sourceA = createSource(db, { kind: 'folder', uri: rootA, enabled: true });
    const sourceB = createSource(db, { kind: 'folder', uri: rootB, enabled: false });

    const results = await ingestAll(db);
    expect(results.map((r) => r.source_id)).toEqual([sourceA.id]);
    expect(activeDocs(sourceB.id)).toHaveLength(0);
  });

  it('ingestOne runs a specific source by id regardless of its enabled flag', async () => {
    const root = mkTmpDir('one');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\n');
    const source = createSource(db, { kind: 'folder', uri: root, enabled: false });

    const result = await ingestOne(db, source.id);
    expect(result?.documents_created).toBe(1);
    expect(await ingestOne(db, 'src_nope')).toBeUndefined();
  });

  it('touches last_ingested_at on the source after a run', async () => {
    const root = mkTmpDir('touch');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\n');
    const source = createSource(db, { kind: 'folder', uri: root });
    expect(getSource(db, source.id)?.last_ingested_at).toBeNull();
    await ingestSource(db, source);
    expect(getSource(db, source.id)?.last_ingested_at).not.toBeNull();
  });
});
