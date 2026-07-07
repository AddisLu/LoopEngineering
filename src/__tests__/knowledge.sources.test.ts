import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import {
  createSource,
  getSource,
  listSources,
  deleteSource,
  setSourceEnabled,
  touchSourceIngested,
} from '../knowledge/ingest/sources.js';
import { parseSourceConfig } from '../knowledge/ingest/types.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

describe('sources.ts CRUD', () => {
  it('creates a source with defaults (enabled, empty config) and an id prefixed src_', () => {
    const s = createSource(db, { kind: 'git', uri: '/repo' });
    expect(s.id).toMatch(/^src_/);
    expect(s.kind).toBe('git');
    expect(s.enabled).toBe(1);
    expect(parseSourceConfig(s.config)).toEqual({});
    expect(s.last_ingested_at).toBeNull();
  });

  it('stores include/exclude/branch config as JSON, round-tripped by parseSourceConfig', () => {
    const s = createSource(db, {
      kind: 'folder',
      uri: '/vault',
      config: { include: ['*.md'], exclude: ['drafts/**'], branch: 'main' },
    });
    expect(parseSourceConfig(s.config)).toEqual({ include: ['*.md'], exclude: ['drafts/**'], branch: 'main' });
  });

  it('enabled: false registers a disabled source', () => {
    const s = createSource(db, { kind: 'vault', uri: '/vault', enabled: false });
    expect(s.enabled).toBe(0);
  });

  it('getSource / listSources / listSources({enabled}) / deleteSource', () => {
    const a = createSource(db, { kind: 'git', uri: '/repo-a' });
    const b = createSource(db, { kind: 'folder', uri: '/folder-b', enabled: false });

    expect(getSource(db, a.id)?.uri).toBe('/repo-a');
    expect(getSource(db, 'nope')).toBeUndefined();

    expect(listSources(db).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(listSources(db, { enabled: true }).map((s) => s.id)).toEqual([a.id]);
    expect(listSources(db, { enabled: false }).map((s) => s.id)).toEqual([b.id]);

    expect(deleteSource(db, a.id)).toBe(true);
    expect(getSource(db, a.id)).toBeUndefined();
    expect(deleteSource(db, a.id)).toBe(false);
  });

  it('deleting a source cascades to its documents/chunks', () => {
    const s = createSource(db, { kind: 'git', uri: '/repo' });
    const docId = db
      .prepare(`INSERT INTO documents (source_id, path, doc_kind) VALUES (?, 'a.md', 'md')`)
      .run(s.id).lastInsertRowid as number;
    db.prepare(`INSERT INTO chunks (document_id, ord, text) VALUES (?, 0, 'hi')`).run(docId);

    deleteSource(db, s.id);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE source_id = ?`).get(s.id)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?`).get(docId)).toEqual({ n: 0 });
  });

  it('setSourceEnabled toggles the flag; touchSourceIngested stamps last_ingested_at', () => {
    const s = createSource(db, { kind: 'git', uri: '/repo' });
    setSourceEnabled(db, s.id, false);
    expect(getSource(db, s.id)?.enabled).toBe(0);
    setSourceEnabled(db, s.id, true);
    expect(getSource(db, s.id)?.enabled).toBe(1);

    expect(getSource(db, s.id)?.last_ingested_at).toBeNull();
    touchSourceIngested(db, s.id);
    expect(getSource(db, s.id)?.last_ingested_at).not.toBeNull();
  });
});

describe('parseSourceConfig', () => {
  it('degrades malformed/missing JSON to {} instead of throwing', () => {
    expect(parseSourceConfig('not json')).toEqual({});
    expect(parseSourceConfig('')).toEqual({});
    expect(parseSourceConfig('null')).toEqual({});
    expect(parseSourceConfig('42')).toEqual({});
  });
});

describe('REST: /api/sources + /api/ingest wiring', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('creates, lists, and deletes a source; validates kind/uri', async () => {
    app = buildApp({ db, apiToken: null });

    const badKind = await app.inject({ method: 'POST', url: '/api/sources', payload: { kind: 'bogus', uri: '/x' } });
    expect(badKind.statusCode).toBe(400);

    const noUri = await app.inject({ method: 'POST', url: '/api/sources', payload: { kind: 'git' } });
    expect(noUri.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { kind: 'git', uri: '/repo', include: ['*.ts'] },
    });
    expect(created.statusCode).toBe(200);
    const { source } = created.json();
    expect(source.id).toMatch(/^src_/);

    const listed = await app.inject({ method: 'GET', url: '/api/sources' });
    expect(listed.json().sources.some((s: any) => s.id === source.id)).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/sources/${source.id}` });
    expect(del.statusCode).toBe(200);
    const del404 = await app.inject({ method: 'DELETE', url: `/api/sources/${source.id}` });
    expect(del404.statusCode).toBe(404);
  });

  it('POST /api/ingest with an unknown source_id 404s', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: '/api/ingest', payload: { source_id: 'src_nope' } });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/ingest with no source_id runs every enabled source (none registered -> empty results)', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: '/api/ingest', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
  });
});
