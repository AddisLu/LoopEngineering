import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask } from '../tasks.js';
import { createRepo, type Repo } from '../repo/store.js';
import { buildApp } from '../server/app.js';
import { awaitAnalysis, PROPOSE_SYSTEM } from '../intake/analyse.js';
import type { chatLocal } from '../local/chat.js';

/** /api/tickets end to end through buildApp: a fixture repo, a faked local model and a faked Gitea. */

let db: Database.Database;
let app: FastifyInstance;
let root: string;
let repo: Repo;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const DESC = '連續兩次 LOAD_RECIPE 後第二次的 bypass_edge_x 沒生效，apply_recipe 直接跳過了。';
const as = (name: string) => ({ 'x-loop-user': name });

const localChat: typeof chatLocal = async (_db, req) =>
  req.system === PROPOSE_SYSTEM
    ? { ok: true, content: JSON.stringify({ kind: 'bugfix', title: '第二次載入沒生效', causes: [{ file: 'src/loader.cpp', symbol: 'apply_recipe', why: 'recipe_changed 判斷錯' }], repro: { mode: 'new_test', command: null, test_file: 'tests/test_reload.py', description: '新增測試' }, complexity: 'M', questions: ['舊配方也要支援嗎？'] }) }
    : { ok: true, content: '{"ok":true,"missing":[],"questions":[],"risk_notes":[]}' };

const giteaCalls: string[] = [];
const giteaFetch = (async (input: unknown) => {
  const url = String(input);
  giteaCalls.push(url);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/api/v1/repos/aoi/cf-aoi/issues/12')) return json({ number: 12, title: '第二次載入沒生效', body: '載入兩次 recipe A，值沒變', state: 'open', html_url: 'http://gitea.corp/aoi/cf-aoi/issues/12' });
  if (url.endsWith('/api/v1/repos/aoi/cf-aoi/issues/12/assets')) return json([{ id: 1, name: 'shot.png', size: PNG.length, browser_download_url: 'http://gitea.corp/attachments/1' }]);
  if (url === 'http://gitea.corp/attachments/1') return new Response(PNG, { status: 200 });
  return new Response('{"message":"not found"}', { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  db = openTestDb();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ticket-routes-')));
  const dir = path.join(root, 'cf-aoi');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'loader.cpp'), 'void apply_recipe(bool recipe_changed)\n{\n  if (!recipe_changed) return;\n}\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://gitea.corp/aoi/cf-aoi.git', gitea_owner: 'aoi', gitea_repo: 'cf-aoi', local_path: dir, domain: 'cpp', build_cmd: 'echo build', test_cmd: 'echo test' });
  setSetting(db, 'gitea_url', 'http://gitea.corp');
  vi.stubEnv('GITEA_TOKEN', 'tok');
  giteaCalls.length = 0;
  app = buildApp({ db, apiToken: null, ticketRoutes: { localChat, giteaFetch, analyseDeps: { checks: null } } });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function open(body: Record<string, unknown> = {}, user = 'eng'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/tickets', headers: as(user), payload: { description: DESC, repo_id: repo.id, ...body } });
  expect(res.statusCode).toBe(201);
  const id = res.json().ticket.id as string;
  await awaitAnalysis(id);
  return id;
}

describe('/api/tickets', () => {
  it('open → analysed → edited → started (self mode)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tickets', headers: as('eng'), payload: { description: DESC, repo_id: repo.id, images: [`data:image/png;base64,${PNG.toString('base64')}`] } });
    expect(res.statusCode).toBe(201);
    const created = res.json().ticket;
    expect(created).toMatchObject({ status: 'draft', created_by: 'name:eng', analysis_status: 'pending', repo: { id: repo.id, name: 'cf-aoi' }, branch: 'main', approval_mode: 'self' });
    await awaitAnalysis(created.id);

    const got = await app.inject({ method: 'GET', url: `/api/tickets/${created.id}`, headers: as('eng') });
    const t = got.json().ticket;
    expect(t.analysis_status).toBe('ready');
    expect(t.title).toBe('第二次載入沒生效');
    expect(t.analysis.causes[0]).toMatchObject({ file: 'src/loader.cpp', symbol: 'apply_recipe' });
    expect(t.analysis.repro).toMatchObject({ mode: 'new_test', test_file: 'tests/test_reload.py' });
    expect(t.analysis.questions).toEqual(['舊配方也要支援嗎？']);
    expect(t.images).toEqual([{ n: 0, name: '截圖 1.png', mime: 'image/png', text: '', via: 'none', note: expect.stringContaining('截圖未辨識') }]);

    const img = await app.inject({ method: 'GET', url: `/api/tickets/${created.id}/images/0` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload).toEqual(PNG);
    expect((await app.inject({ method: 'GET', url: `/api/tickets/${created.id}/images/3` })).statusCode).toBe(404);

    const plan = await app.inject({ method: 'GET', url: `/api/tickets/${created.id}/plan` });
    expect(plan.json().markdown).toContain('# 第二次載入沒生效');
    expect(plan.json().markdown).toContain('先在 tests/test_reload.py 新增一個會重現這個問題的測試');

    const patched = await app.inject({ method: 'PATCH', url: `/api/tickets/${created.id}`, headers: as('eng'), payload: { kind: 'algo', priority: 3, repro: { mode: 'command', command: 'make repro', description: '跑一次' } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().ticket).toMatchObject({ kind: 'algo', priority: 3, analysis_status: 'ready', analysis: { repro: { mode: 'command', command: 'make repro' } } });
    expect(patched.json().ticket.analysis.checks.map((c: { name: string }) => c.name)).toEqual(['建置', '測試', '重現']);
    expect((await app.inject({ method: 'PATCH', url: `/api/tickets/${created.id}`, headers: as('eng'), payload: { priority: 9 } })).statusCode).toBe(400);

    const started = await app.inject({ method: 'POST', url: `/api/tickets/${created.id}/start`, headers: as('eng') });
    expect(started.statusCode).toBe(200);
    expect(started.json().ticket.status).toBe('queued');
    expect((await app.inject({ method: 'POST', url: `/api/tickets/${created.id}/cancel`, headers: as('eng') })).statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: '/api/tickets?mine=1', headers: as('eng') });
    expect(list.json().tickets).toEqual([expect.objectContaining({ id: created.id, status: 'queued', analysis_status: 'ready', approval_state: null, repo_name: 'cf-aoi' })]);
    expect((await app.inject({ method: 'GET', url: '/api/tickets?mine=1', headers: as('other') })).json().tickets).toEqual([]);
  });

  it('400 on bad input, 404 for a task that is not a ticket', async () => {
    const short = await app.inject({ method: 'POST', url: '/api/tickets', payload: { description: '太短', repo_id: repo.id } });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatch(/至少 10/);
    expect((await app.inject({ method: 'POST', url: '/api/tickets', payload: { description: DESC, repo_id: 'r_none' } })).statusCode).toBe(400);
    const plain = createTask(db, { title: 'x', goal: 'y' });
    expect((await app.inject({ method: 'GET', url: `/api/tickets/${plain.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/tickets/t_nope' })).statusCode).toBe(404);
  });

  it('先存草稿 (analyse: false) saves without analysing, and editing it stays quiet until 請 Loop 分析', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tickets', headers: as('eng'), payload: { description: DESC, repo_id: repo.id, analyse: false } });
    expect(res.statusCode).toBe(201);
    const id = res.json().ticket.id as string;
    expect(res.json().ticket).toMatchObject({ analysis_status: null, is_manager: false });
    const edited = await app.inject({ method: 'PATCH', url: `/api/tickets/${id}`, headers: as('eng'), payload: { description: `${DESC}（補充）` } });
    expect(edited.json().ticket.analysis_status).toBeNull();
    const go = await app.inject({ method: 'POST', url: `/api/tickets/${id}/analyse`, headers: as('eng') });
    expect(go.statusCode).toBe(202);
    await awaitAnalysis(id);
    expect((await app.inject({ method: 'GET', url: `/api/tickets/${id}`, headers: as('eng') })).json().ticket.analysis_status).toBe('ready');
  });

  it('retry, and cancel before it started', async () => {
    const id = await open();
    const retry = await app.inject({ method: 'POST', url: `/api/tickets/${id}/analyse` });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().ticket.analysis_status).toBe('pending');
    await awaitAnalysis(id);
    const cancel = await app.inject({ method: 'POST', url: `/api/tickets/${id}/cancel`, headers: as('eng') });
    expect(cancel.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/tickets/${id}` })).statusCode).toBe(404);
  });

  it('manager mode: start sends it for approval; only a manager approves', async () => {
    setSetting(db, 'approval_mode', 'manager');
    setSetting(db, 'manager_users', 'name:boss');
    const id = await open();
    const sent = await app.inject({ method: 'POST', url: `/api/tickets/${id}/start`, headers: as('eng') });
    expect(sent.json().ticket).toMatchObject({ status: 'draft', approval_mode: 'manager', approval_state: 'awaiting', can_approve: false });
    expect((await app.inject({ method: 'GET', url: `/api/tickets/${id}`, headers: as('boss') })).json().ticket.can_approve).toBe(true);
    const card = (await app.inject({ method: 'GET', url: '/api/board' })).json().cards.find((c: { id: string }) => c.id === id);
    expect(card).toMatchObject({ approval_state: 'awaiting', requested_by: 'eng' });

    expect((await app.inject({ method: 'POST', url: `/api/tickets/${id}/approve-start`, headers: as('eng') })).statusCode).toBe(403);
    const rejected = await app.inject({ method: 'POST', url: `/api/tickets/${id}/reject-start`, headers: as('boss'), payload: { reason: '先補重現步驟' } });
    expect(rejected.json().ticket).toMatchObject({ approval_state: 'rejected' });
    expect(rejected.json().ticket.analysis.questions[0]).toContain('先補重現步驟');

    await app.inject({ method: 'POST', url: `/api/tickets/${id}/start`, headers: as('eng') });
    const approved = await app.inject({ method: 'POST', url: `/api/tickets/${id}/approve-start`, headers: as('boss') });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().ticket).toMatchObject({ status: 'queued', approval_state: 'approved', start_approved_by: 'boss' });
  });

  it('resolve-link: repo and issue links on the Gitea server, imported or not', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/tickets/resolve-link', payload: { url: 'http://gitea.corp/aoi/cf-aoi' } });
    expect(r.json()).toEqual({ kind: 'repo', remote_url: 'http://gitea.corp/aoi/cf-aoi.git', owner: 'aoi', repo_name: 'cf-aoi', repo: { id: repo.id, name: 'cf-aoi' }, issue: null });
    const other = await app.inject({ method: 'POST', url: '/api/tickets/resolve-link', payload: { url: 'http://gitea.corp/aoi/new-tool.git' } });
    expect(other.json()).toMatchObject({ kind: 'repo', repo_name: 'new-tool', repo: null });
    const pr = await app.inject({ method: 'POST', url: '/api/tickets/resolve-link', payload: { url: 'http://gitea.corp/aoi/cf-aoi/pulls/3' } });
    expect(pr.json()).toMatchObject({ kind: 'pr', issue: null });

    const issue = await app.inject({ method: 'POST', url: '/api/tickets/resolve-link', payload: { url: 'http://gitea.corp/aoi/cf-aoi/issues/12' } });
    expect(issue.json()).toMatchObject({
      kind: 'issue',
      repo: { id: repo.id },
      issue: { number: 12, title: '第二次載入沒生效', body: '載入兩次 recipe A，值沒變', html_url: 'http://gitea.corp/aoi/cf-aoi/issues/12', images: [{ name: 'shot.png', data_url: `data:image/png;base64,${PNG.toString('base64')}` }] },
    });
    expect(giteaCalls.every((u) => u.startsWith('http://gitea.corp/'))).toBe(true);
    const missing = await app.inject({ method: 'POST', url: '/api/tickets/resolve-link', payload: { url: 'http://gitea.corp/aoi/cf-aoi/issues/99' } });
    expect(missing.json().error).toMatch(/讀不到 issue #99/);
    const foreign = await app.inject({ method: 'POST', url: '/api/tickets/resolve-link', payload: { url: 'https://elsewhere.example/a/b/issues/1' } });
    expect(foreign.json()).toMatchObject({ kind: null, error: expect.any(String) });
  });

  it('a ticket from an issue link is opened once and remembers the issue', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/tickets', headers: as('eng'), payload: { description: DESC, issue_url: 'http://gitea.corp/aoi/cf-aoi/issues/12' } });
    expect(first.statusCode).toBe(201);
    expect(first.json().ticket).toMatchObject({ source_ref: 'gitea:aoi/cf-aoi#12', issue: { number: 12, url: 'http://gitea.corp/aoi/cf-aoi/issues/12' }, repo: { id: repo.id } });
    await awaitAnalysis(first.json().ticket.id);
    // 「Loop 的分析」 goes back to the issue through the same (injected) Gitea — never the network
    await vi.waitFor(() => expect(giteaCalls).toContain('http://gitea.corp/api/v1/repos/aoi/cf-aoi/issues/12/comments'));
    const second = await app.inject({ method: 'POST', url: '/api/tickets', headers: as('eng'), payload: { description: DESC, repo_id: repo.id, issue_url: 'http://gitea.corp/aoi/cf-aoi/issues/12' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().ticket.id).toBe(first.json().ticket.id);
  });
});
