import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { registerPrdRoutes } from '../server/prdRoutes.js';
import { createSource } from '../knowledge/ingest/sources.js';
import type { RetrievedChunk } from '../knowledge/retrieve.js';
import type { LocalChatResult } from '../local/chat.js';

/**
 * The wizard's two zero-token helpers, with the knowledge search and the local model both faked.
 * What matters: the model can only pick from what retrieval found, a missing model degrades to
 * the retrieval order rather than failing, and an empty index is an honest 503.
 */

let db: Database.Database;
let app: FastifyInstance;
let repo: string;
let chatCalls: { system: string; user: string }[];
let chatReply: (req: { system: string; user: string }) => LocalChatResult;
let searchHits: RetrievedChunk[];
let searchQueries: string[];

const chunk = (id: number, p: string, text: string, section: string | null = null): RetrievedChunk => ({
  chunk_id: id,
  document_id: id,
  source_id: 'src_x',
  source_kind: 'git',
  path: p,
  uri: `${repo}/${p}`,
  section,
  start_line: 10 * id,
  end_line: 10 * id + 5,
  text,
  score: 1 / id,
});

beforeEach(async () => {
  db = openTestDb();
  setSetting(db, 'prd_gate_enabled', 'true');
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-prd-assist-'));
  createSource(db, { kind: 'git', uri: repo });
  chatCalls = [];
  searchQueries = [];
  searchHits = [chunk(1, 'ip/src/defect_rules.h', 'bypass_edge_x default 4', 'rules'), chunk(2, 'ip/src/edge_check.cpp', 'edge margin logic'), chunk(3, 'docs/STATUS.md', 'status')];
  chatReply = (req) => {
    if (req.system.includes('檢索助手')) return { ok: true, content: '["bypass_edge_x", "邊緣"]' };
    if (req.system.includes('資深工程師')) return { ok: true, content: '[{"path":"ip/src/edge_check.cpp","why":"邊界判定在這","lines":"20-25"},{"path":"ip/src/defect_rules.h","why":"預設值"},{"path":"made/up.cpp","why":"模型亂猜"}]' };
    return { ok: true, content: '["Given 圖集 A When 跑 offline-tcp Then 誤判 0", "Given 一片板 When 邊緣有紋路 Then 不判刮傷", "短句"]' };
  };
  app = Fastify();
  registerPrdRoutes(app, db, {
    search: async (_db, q) => {
      searchQueries.push(q);
      return searchHits;
    },
    localChat: async (_db, req) => {
      chatCalls.push(req);
      return chatReply(req);
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

describe('POST /api/prd/suggest-files', () => {
  it('expands keywords, searches the repo, and lets the model rank only what retrieval found', async () => {
    const res = await post('/api/prd/suggest-files', { repo_path: repo, module: 'ip', description: 'ROI 邊緣常把紋路判成刮傷' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ranked).toBe(true);
    expect(body.keywords).toEqual(['bypass_edge_x', '邊緣']);
    expect(searchQueries).toEqual(['ROI 邊緣常把紋路判成刮傷', 'bypass_edge_x', '邊緣']);
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(['ip/src/edge_check.cpp', 'ip/src/defect_rules.h']); // made/up.cpp dropped
    expect(body.files[0]).toMatchObject({ why: '邊界判定在這', lines: '20-25' });
    expect(body.files[1].lines).toBe('10-15'); // from the chunk when the model gave none
  });

  it('falls back to retrieval order when the model is not loaded or answers garbage', async () => {
    chatReply = () => ({ ok: false, reason: 'not_ready', detail: 'no local model ready' });
    const res = await post('/api/prd/suggest-files', { repo_path: repo, description: '邊緣誤判' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ranked).toBe(false);
    expect(res.json().files.map((f: { path: string }) => f.path)).toEqual(['ip/src/defect_rules.h', 'ip/src/edge_check.cpp', 'docs/STATUS.md']);
    expect(res.json().files[0].why).toBe('rules'); // the section stands in for a reason

    chatReply = () => ({ ok: true, content: '這不是 JSON' });
    expect((await post('/api/prd/suggest-files', { repo_path: repo, description: '邊緣誤判' })).json().ranked).toBe(false);
  });

  it('says so when the knowledge base has nothing for this repo, and refuses an unlisted repo', async () => {
    searchHits = [];
    const res = await post('/api/prd/suggest-files', { repo_path: repo, description: '邊緣誤判' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('知識庫');
    expect((await post('/api/prd/suggest-files', { repo_path: '/etc', description: 'x' })).statusCode).toBe(403);
    expect((await post('/api/prd/suggest-files', { repo_path: repo, description: '' })).statusCode).toBe(400);
  });
});

describe('POST /api/prd/draft-acceptance', () => {
  it('returns usable Given/When/Then lines and drops what is too short', async () => {
    const res = await post('/api/prd/draft-acceptance', { description: '邊緣誤判', expected: '不判刮傷', method: 'dataset' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual(['Given 圖集 A When 跑 offline-tcp Then 誤判 0', 'Given 一片板 When 邊緣有紋路 Then 不判刮傷']);
    expect(chatCalls.at(-1)?.user).toContain('期望行為：不判刮傷');
  });

  it('is a 503 with a sentence the page can show when the model is not loaded', async () => {
    chatReply = () => ({ ok: false, reason: 'not_ready', detail: 'no local model ready (status: idle)' });
    const res = await post('/api/prd/draft-acceptance', { description: '邊緣誤判' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('本地模型未載入');
    expect((await post('/api/prd/draft-acceptance', { description: '' })).statusCode).toBe(400);
  });

  it('is 404 while the gate is off', async () => {
    setSetting(db, 'prd_gate_enabled', 'false');
    expect((await post('/api/prd/draft-acceptance', { description: 'x' })).statusCode).toBe(404);
    expect((await post('/api/prd/suggest-files', { repo_path: repo, description: 'x' })).statusCode).toBe(404);
  });
});
