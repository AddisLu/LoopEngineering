import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { ingestSource, ingestAll } from '../knowledge/ingest/ingest.js';
import { parseOpenProjectDump, dumpOpenProjectSource, type OpenProjectDumpExec } from '../knowledge/ingest/openproject.js';
import type { DocumentRow, ChunkRow } from '../knowledge/ingest/types.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

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

const WP_LINE = JSON.stringify({
  ext_id: 'wp:101',
  title: '#101 修正登入頁面錯誤',
  text: '描述：登入按鈕在行動裝置上沒反應。\n\n狀態: 進行中\n類型: Bug\n負責人: 小美\n專案: 內部工具\n\n留言:\n- [2026-01-01] 小明: 已重現，正在追查',
  uri: 'http://192.168.72.2/openproject/work_packages/101',
  doc_kind: 'op_work_package',
  updated_at: '2026-01-01T00:00:00Z',
});
const PROJECT_LINE = JSON.stringify({
  ext_id: 'project:internal-tools',
  title: '內部工具',
  text: '公司內部工具開發專案。\n\n效益: 提升自動化程度',
  uri: 'http://192.168.72.2/openproject/projects/internal-tools',
  doc_kind: 'op_project',
  updated_at: '2026-01-02T00:00:00Z',
});

function makeExec(stdout: string): OpenProjectDumpExec {
  return async () => stdout;
}

describe('parseOpenProjectDump', () => {
  it('parses valid line-delimited JSON docs', () => {
    const docs = parseOpenProjectDump(`${WP_LINE}\n${PROJECT_LINE}\n`);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.ext_id).toBe('wp:101');
    expect(docs[1]!.ext_id).toBe('project:internal-tools');
  });

  it('skips blank lines, malformed JSON, and objects missing required fields — never throws', () => {
    const stdout = [
      '',
      '   ',
      'not json at all {{{',
      JSON.stringify({ ext_id: 'wp:1' }), // missing title/text/doc_kind
      WP_LINE,
      '{"ext_id": "wp:2", "title": "t", "text": "x", "doc_kind": "op_work_package"}', // no updated_at/uri
    ].join('\n');
    const docs = parseOpenProjectDump(stdout);
    expect(docs.map((d) => d.ext_id)).toEqual(['wp:101', 'wp:2']);
    expect(docs[1]!.uri).toBeNull();
    expect(docs[1]!.updated_at).toBeNull();
  });
});

describe('dumpOpenProjectSource', () => {
  it('returns [] when the source config has no op_repo', async () => {
    const source = createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: {} });
    const docs = await dumpOpenProjectSource(db, source, makeExec(WP_LINE));
    expect(docs).toEqual([]);
  });

  it('spawns with --op-repo/--op-config/--kinds derived from the source config and the configured python binary', async () => {
    setSetting(db, 'ingest_openproject_python', 'my-python');
    const source = createSource(db, {
      kind: 'openproject',
      uri: 'http://example/openproject',
      config: { op_repo: '/repo', op_config: '/repo/other-config.json', kinds: ['projects'] },
    });
    let seenBin = '';
    let seenArgs: string[] = [];
    const exec: OpenProjectDumpExec = async (bin, args) => {
      seenBin = bin;
      seenArgs = args;
      return PROJECT_LINE;
    };
    const docs = await dumpOpenProjectSource(db, source, exec);
    expect(seenBin).toBe('my-python');
    expect(seenArgs).toContain('--op-repo');
    expect(seenArgs).toContain('/repo');
    expect(seenArgs).toContain('--op-config');
    expect(seenArgs).toContain('/repo/other-config.json');
    expect(seenArgs).toContain('--kinds');
    expect(seenArgs).toContain('projects');
    expect(docs).toHaveLength(1);
  });

  it('defaults the python binary to python3 when unset', async () => {
    const source = createSource(db, {
      kind: 'openproject',
      uri: 'http://example/openproject',
      config: { op_repo: '/repo' },
    });
    let seenBin = '';
    await dumpOpenProjectSource(db, source, async (bin) => {
      seenBin = bin;
      return '';
    });
    expect(seenBin).toBe('python3');
  });
});

describe('ingestSource: kind=openproject', () => {
  function makeSource(enabled = true) {
    return createSource(db, {
      kind: 'openproject',
      uri: 'http://192.168.72.2/openproject',
      config: { op_repo: '/home/user/OpenProject_Exec_Report' },
      enabled,
    });
  }

  it('produces documents/chunks from fake line-delimited JSON (Chinese WP + comments, plus a project)', async () => {
    const source = makeSource();
    const result = await ingestSource(db, source, { openProjectExec: makeExec(`${WP_LINE}\n${PROJECT_LINE}\n`) });

    expect(result.documents_created).toBe(2);
    expect(result.skipped_unchanged).toBe(0);

    const docs = activeDocs(source.id);
    expect(docs.map((d) => d.path)).toEqual(['project:internal-tools', 'wp:101']);

    const wp = docs.find((d) => d.path === 'wp:101')!;
    expect(wp.title).toBe('#101 修正登入頁面錯誤');
    expect(wp.uri).toBe('http://192.168.72.2/openproject/work_packages/101');
    expect(wp.doc_kind).toBe('op_work_package');
    expect(wp.mtime).toBe('2026-01-01T00:00:00Z');

    const chunks = chunksFor(wp.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.text).toContain('小明');
  });

  it('a second run with the same updated_at skips the doc entirely (skipped_unchanged)', async () => {
    const source = makeSource();
    await ingestSource(db, source, { openProjectExec: makeExec(WP_LINE) });
    const second = await ingestSource(db, source, { openProjectExec: makeExec(WP_LINE) });

    expect(second.documents_created).toBe(0);
    expect(second.documents_replaced).toBe(0);
    expect(second.skipped_unchanged).toBe(1);
    expect(activeDocs(source.id)).toHaveLength(1);
  });

  it('a changed updated_at bi-temporally supersedes the doc: old invalidated, new created, chunks re-created', async () => {
    const source = makeSource();
    await ingestSource(db, source, { openProjectExec: makeExec(WP_LINE) });
    const before = activeDocs(source.id)[0]!;
    const beforeChunks = chunksFor(before.id);

    const changed = JSON.parse(WP_LINE);
    changed.text = changed.text + '\n\n留言:\n- [2026-01-05] 小美: 已修好';
    changed.updated_at = '2026-01-05T00:00:00Z';

    const result = await ingestSource(db, source, { openProjectExec: makeExec(JSON.stringify(changed)) });
    expect(result.documents_replaced).toBe(1);
    expect(result.documents_created).toBe(0);

    const oldDoc = allDocs(source.id).find((d) => d.id === before.id)!;
    expect(oldDoc.invalid_at).not.toBeNull();
    const oldChunksAfter = db.prepare(`SELECT * FROM chunks WHERE document_id = ?`).all(before.id) as ChunkRow[];
    expect(oldChunksAfter.every((c) => c.invalid_at !== null)).toBe(true);
    expect(oldChunksAfter).toHaveLength(beforeChunks.length);

    const activeNow = activeDocs(source.id);
    expect(activeNow).toHaveLength(1);
    expect(activeNow[0]!.id).not.toBe(before.id);
    expect(activeNow[0]!.mtime).toBe('2026-01-05T00:00:00Z');
  });

  it('falls back to sha256 comparison when a doc has no updated_at: unchanged text is skipped, changed text replaces', async () => {
    const source = makeSource();
    const noTs = JSON.stringify({
      ext_id: 'wp:200',
      title: '#200 無時間戳的工作包',
      text: '原始內容',
      uri: null,
      doc_kind: 'op_work_package',
      updated_at: null,
    });
    await ingestSource(db, source, { openProjectExec: makeExec(noTs) });
    const second = await ingestSource(db, source, { openProjectExec: makeExec(noTs) });
    expect(second.skipped_unchanged).toBe(1);
    expect(second.documents_replaced).toBe(0);

    const before = activeDocs(source.id)[0]!;
    const changed = JSON.parse(noTs);
    changed.text = '變更後的內容';
    const third = await ingestSource(db, source, { openProjectExec: makeExec(JSON.stringify(changed)) });
    expect(third.documents_replaced).toBe(1);
    const active = activeDocs(source.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(before.id);
    expect(active[0]!.sha256).not.toBe(before.sha256);
  });

  it('an item missing from a later dump invalidates its document (never deletes)', async () => {
    const source = makeSource();
    await ingestSource(db, source, { openProjectExec: makeExec(`${WP_LINE}\n${PROJECT_LINE}\n`) });
    expect(activeDocs(source.id)).toHaveLength(2);

    const result = await ingestSource(db, source, { openProjectExec: makeExec(PROJECT_LINE) });
    expect(result.documents_invalidated).toBe(1);
    expect(result.skipped_unchanged).toBe(1);

    const active = activeDocs(source.id);
    expect(active.map((d) => d.path)).toEqual(['project:internal-tools']);
    const goneAll = allDocs(source.id).find((d) => d.path === 'wp:101')!;
    expect(goneAll.invalid_at).not.toBeNull();
  });

  it('a bad line among good ones is skipped, not a crash — the good docs still ingest', async () => {
    const stdout = ['not valid json {{{', WP_LINE, JSON.stringify({ ext_id: 'wp:x' })].join('\n');
    const source = makeSource();
    const result = await ingestSource(db, source, { openProjectExec: makeExec(stdout) });
    expect(result.documents_created).toBe(1);
    expect(activeDocs(source.id).map((d) => d.path)).toEqual(['wp:101']);
  });

  it('a disabled openproject source is not run by ingestAll (exec never called)', async () => {
    const source = makeSource(false);
    let called = false;
    const exec: OpenProjectDumpExec = async () => {
      called = true;
      return WP_LINE;
    };
    const results = await ingestAll(db, { openProjectExec: exec });
    expect(results).toHaveLength(0);
    expect(called).toBe(false);
    expect(activeDocs(source.id)).toHaveLength(0);
  });

  it('rag_enabled=false (default): documents/chunks stored but embed is never called', async () => {
    const source = makeSource();
    let embedCalls = 0;
    const result = await ingestSource(db, source, {
      openProjectExec: makeExec(WP_LINE),
      embedExec: async (_bin, _args, texts) => {
        embedCalls++;
        return texts.map(() => [0]);
      },
    });
    expect(embedCalls).toBe(0);
    expect(result.chunks_created).toBeGreaterThan(0);
  });
});
