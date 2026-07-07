import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { captureNote } from '../knowledge/ingest/capture.js';

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-capture-${tag}-`));
  tmpRoots.push(d);
  return d;
}

describe('captureNote', () => {
  it('writes a markdown note into the registered vault and ingests it immediately', async () => {
    const vault = mkTmpDir('vault');
    createSource(db, { kind: 'vault', uri: vault });

    const result = await captureNote(db, { title: 'My Note', body: 'hello world', tags: ['a', 'b'] });

    expect(result.filename).toBe('my-note.md');
    const written = fs.readFileSync(path.join(vault, 'my-note.md'), 'utf8');
    expect(written).toContain('tags: ["a", "b"]');
    expect(written).toContain('# My Note');
    expect(written).toContain('hello world');
    expect(result.ingest.documents_created).toBe(1);
    expect(result.ingest.chunks_created).toBeGreaterThan(0);
  });

  it('derives the title from the first line of body when title is omitted', async () => {
    const vault = mkTmpDir('vault2');
    createSource(db, { kind: 'vault', uri: vault });

    const result = await captureNote(db, { body: 'This is the first line.\nMore text below.' });
    expect(result.filename).toBe('this-is-the-first-line.md');
  });

  it('appends a numeric suffix on a filename collision instead of overwriting', async () => {
    const vault = mkTmpDir('vault3');
    createSource(db, { kind: 'vault', uri: vault });

    const first = await captureNote(db, { title: 'Dup', body: 'first capture' });
    const second = await captureNote(db, { title: 'Dup', body: 'second capture' });
    expect(first.filename).toBe('dup.md');
    expect(second.filename).toBe('dup-2.md');
    expect(fs.readFileSync(path.join(vault, 'dup.md'), 'utf8')).toContain('first capture');
    expect(fs.readFileSync(path.join(vault, 'dup-2.md'), 'utf8')).toContain('second capture');
  });

  it('throws when no vault source is registered', async () => {
    await expect(captureNote(db, { title: 't', body: 'b' })).rejects.toThrow(/no enabled vault source/);
  });

  it('throws on an empty body', async () => {
    const vault = mkTmpDir('vault4');
    createSource(db, { kind: 'vault', uri: vault });
    await expect(captureNote(db, { title: 't', body: '   ' })).rejects.toThrow(/body is required/);
  });

  it('ignores a disabled vault source', async () => {
    const vault = mkTmpDir('vault5');
    createSource(db, { kind: 'vault', uri: vault, enabled: false });
    await expect(captureNote(db, { title: 't', body: 'b' })).rejects.toThrow(/no enabled vault source/);
  });
});

describe('POST /api/capture', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('captures a note and returns the ingest summary', async () => {
    const vault = mkTmpDir('vault-api');
    createSource(db, { kind: 'vault', uri: vault });
    app = buildApp({ db, apiToken: null });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capture',
      payload: { title: 'API note', body: 'captured via REST', tags: ['x'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.filename).toBe('api-note.md');
    expect(body.ingest.documents_created).toBe(1);
  });

  it('400s when body is missing', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: '/api/capture', payload: { title: 't' } });
    expect(res.statusCode).toBe(400);
  });

  it('400s when no vault source is registered', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: '/api/capture', payload: { body: 'b' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no enabled vault source/);
  });
});
