import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createRepo } from '../repo/store.js';
import { saveStageA } from '../repo/profileStore.js';
import { getReport, runDiagnosis, rulesVerdict } from '../diag/diagnose.js';
import { parseDiag } from '../diag/parse.js';
import { upsertLearned } from '../knowledge/learn.js';
import { repoScope } from '../knowledge/types.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'diag');
const sample = (f: string) => ({ name: f, text: fs.readFileSync(path.join(FIX, f), 'utf8') });

let db: Database.Database;
let app: FastifyInstance;
let dir: string;
let prompts: string[];
let reply: string;

beforeEach(async () => {
  db = openTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-repo-'));
  fs.mkdirSync(path.join(dir, 'ip', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ip', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ip', 'src', 'control_server.cpp'), `${'// x\n'.repeat(406)}        FR_INCIDENT("bad_json", e.what());\n`);
  prompts = [];
  reply = JSON.stringify({
    category: 'data',
    confidence: 'high',
    summary: '上游送來的 recipe 不是 JSON（以 no 開頭），control_server 解析失敗',
    causes: [{ category: 'data', title: '上游送了非 JSON 的 recipe', why: 'bad_json 的 detail 是 parse error at line 1', evidence: ['ip/src/control_server.cpp:407'] }],
    suggestions: [{ file: 'ip/config/default_zone.ini', param: 'fast_search_range', current: '2', proposed: '1', why: '回到預設', risk: 'low', verify: '跑 verify_flight' }],
  });
  app = buildApp({
    db,
    apiToken: null,
    profileRoutes: {
      diagnose: {
        localChat: (async (_db: unknown, req: { user: string }) => (prompts.push(req.user), { ok: true, content: reply })) as never,
      },
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedRepo() {
  const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://gitea.corp:3000/aoi/cf-aoi', local_path: dir });
  saveStageA(db, repo.id, { sha: 'abc' }, [
    { kind: 'param', key: 'fast_search_range', section: 'Pattern', file: 'ip/config/default_zone.ini', line: 22, text: 'fast_search_range = 1', value: '1', meaning: 'Lightweight search range for fast kernel (pixels)' },
    { kind: 'param', key: 'pitch_x', section: 'Pattern', file: 'ip/config/default_zone.ini', line: 13, text: 'pitch_x = 26', value: '26', meaning: 'Pattern pitch (px)' },
    { kind: 'param_use', key: 'fast_search_range', section: null, file: 'ip/src/config/config_parser.h', line: 178, text: 'else if (key == "fast_search_range")', value: null, meaning: null },
    { kind: 'incident', key: 'bad_json', section: null, file: 'ip/src/control_server.cpp', line: 407, text: 'FR_INCIDENT("bad_json", e.what());', value: null, meaning: null },
    { kind: 'error_code', key: 'ERR_GRAB_TIMEOUT', section: null, file: 'grab/src/errors.h', line: 12, text: '#define ERR_GRAB_TIMEOUT 1203', value: '1203', meaning: null },
  ]);
  return repo;
}

async function waitReady(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = getReport(db, id)!;
    if (r.status === 'ready' || r.status === 'failed') return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('not ready');
}

describe('機況診斷', () => {
  it('the flight recorder samples + the machine ini → code, changed params, a verdict', async () => {
    const repo = seedRepo();
    const ini = { name: 'default_zone.ini', text: '[Pattern]\npitch_x = 26\nfast_search_range = 2\n' };
    const res = await app.inject({ method: 'POST', url: '/api/diag', payload: { repo_id: repo.id, note: 'IP01 一直判 bad_json', inputs: [sample('20260712.jsonl'), sample('incident_20260712_053710_819.json'), ini] } });
    expect(res.statusCode).toBe(201);
    const id = res.json().report.id as string;
    expect(res.json().report.signature).toContain('incident:bad_json@ip/src/control_server.cpp');
    const r = await waitReady(id);
    expect(r.status).toBe('ready');
    expect(r.result!.category).toBe('data');
    expect(r.result!.code_refs[0]).toMatchObject({ from: 'incident bad_json', file: 'ip/src/control_server.cpp', line: 407, text: 'FR_INCIDENT("bad_json", e.what());' });
    expect(r.result!.params).toEqual([
      expect.objectContaining({ section: 'Pattern', key: 'fast_search_range', baseline: '1', current: '2', meaning: 'Lightweight search range for fast kernel (pixels)', where: ['ip/src/config/config_parser.h:178'] }),
    ]);
    expect(r.result!.suggestions[0]).toMatchObject({ param: 'fast_search_range', proposed: '1' });
    expect(prompts[0]).toContain('## 工程師描述的現象\nIP01 一直判 bad_json');
    expect(prompts[0]).toContain('## 和預設不同的參數');
    expect(prompts[0]).toContain('預設 1 → 機台 2');
    // history and reading back
    expect((await app.inject({ method: 'GET', url: '/api/diag' })).json().reports[0].id).toBe(id);
    expect((await app.inject({ method: 'GET', url: `/api/diag/${id}` })).json().report.result.summary).toContain('recipe');
  });

  it('記成案例: the next report with the same signature finds it; learned pitfalls join in', async () => {
    const repo = seedRepo();
    const first = (await app.inject({ method: 'POST', url: '/api/diag', payload: { repo_id: repo.id, inputs: [sample('incident_20260712_053710_819.json')] } })).json().report.id;
    await waitReady(first);
    const c = await app.inject({ method: 'POST', url: `/api/diag/${first}/case`, payload: { cause: 'MES 送來空字串 recipe', resolution: '請 MES 修正並加上 recipe 檢查' } });
    expect(c.statusCode).toBe(200);
    expect(c.json().report.case_id).toMatch(/^k_/);
    const node = db.prepare('SELECT kind, status, scope, facet FROM knowledge_nodes WHERE id = ?').get(c.json().report.case_id);
    expect(node).toEqual({ kind: 'case', status: 'approved', scope: repoScope(dir), facet: 'case' });
    upsertLearned(db, repoScope(dir), 'pitfall', 'control_server 的 JSON 解析要先檢查空字串', '會看到：bad_json', { trigger: { words: ['bad_json'], files: [], kinds: [] }, evidence: [{ task: 't_1' }] });
    db.prepare("UPDATE knowledge_nodes SET status = 'approved' WHERE kind = 'pitfall'").run();
    const second = (await app.inject({ method: 'POST', url: '/api/diag', payload: { repo_id: repo.id, inputs: [sample('20260712.jsonl')] } })).json().report.id;
    const r = await waitReady(second);
    expect(r.result!.similar_cases[0]).toMatchObject({ title: 'bad_json：MES 送來空字串 recipe' });
    expect(r.result!.pitfalls.map((p) => p.title)).toEqual(['control_server 的 JSON 解析要先檢查空字串']);
    expect(prompts.at(-1)).toContain('## 過去相似的機況案例');
    expect((await app.inject({ method: 'POST', url: `/api/diag/${second}/case`, payload: { cause: 'x' } })).statusCode).toBe(400);
  });

  it('without a model the rules still sort the evidence; bad input is a 400', async () => {
    const p = parseDiag([{ name: 'log', text: '[2026/07/12 05:37:10.123] ERROR grab timeout ERR_GRAB_TIMEOUT (code=1203)\n' }]);
    expect(rulesVerdict(p, [], []).category).toBe('environment');
    reply = 'not json';
    const repo = seedRepo();
    const id = (await app.inject({ method: 'POST', url: '/api/diag', payload: { repo_id: repo.id, inputs: [{ name: 'log', text: '[2026/07/12 05:37:10.123] ERROR grab timeout ERR_GRAB_TIMEOUT (code=1203)' }] } })).json().report.id;
    const r = await waitReady(id);
    expect(r.result!.model_used).toBeNull();
    expect(r.result!.summary).toContain('只用規則判斷');
    expect(r.result!.code_refs.some((c) => c.file === 'grab/src/errors.h')).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/diag', payload: { inputs: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/diag', payload: { inputs: [{ name: 'x', text: 'y' }], repo_id: 'r_nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/diag/dg_nope' })).statusCode).toBe(404);
  });
});

describe('Repo 檔案 reads', () => {
  it('profile view, index search, drafts across repos, approve-many', async () => {
    const repo = seedRepo();
    const v = (await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/profile` })).json();
    expect(v).toMatchObject({ status: 'ready', sha: 'abc', index_counts: { param: 2, param_use: 1, incident: 1, error_code: 1 }, first_pass: { rate: null, n: 0 } });
    const hits = (await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/index?q=fast_search&kind=` })).json().entries;
    expect(hits.map((e: { kind: string }) => e.kind).sort()).toEqual(['param', 'param_use']);
    expect((await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/index?q=bad_json&kind=incident` })).json().entries[0].line).toBe(407);
    const d = upsertLearned(db, repoScope(dir), 'pitfall', '陷阱 A', 'x', { trigger: { words: [], files: [], kinds: [] }, evidence: [] });
    const drafts = (await app.inject({ method: 'GET', url: '/api/knowledge/facet-drafts' })).json().nodes;
    expect(drafts).toEqual([expect.objectContaining({ id: d.id, repo: { id: repo.id, name: 'cf-aoi' } })]);
    expect((await app.inject({ method: 'POST', url: '/api/knowledge/approve-many', payload: { ids: [d.id] } })).json()).toEqual({ ok: true, approved: 1 });
    expect((await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/profile` })).json().nodes.pitfall[0]).toMatchObject({ id: d.id, status: 'approved' });

  });
});
