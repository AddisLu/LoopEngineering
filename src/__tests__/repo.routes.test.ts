import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { getSetting, openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { awaitImport } from '../repo/import.js';

/** The Repo page's API: import as a job the page polls, the row, its edits, forgetting it. */

let db: Database.Database;
let app: FastifyInstance;
let root: string;
let url: string;
let ingested: string[];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

beforeEach(async () => {
  db = openTestDb();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-repo-routes-')));
  const bare = path.join(root, 'app.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(path.join(seed, 'src'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }));
  fs.writeFileSync(path.join(seed, 'src', 'a.ts'), 'export {};\n');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'push', '-q', bare, 'main');
  url = `file://${bare}`;
  ingested = [];
  app = buildApp({
    db,
    apiToken: null,
    repoRoutes: { importDeps: { allowFileUrls: true, cloneRoot: path.join(root, 'repos'), timeoutMs: 20_000, ingest: async (_db, sid) => void ingested.push(sid) } },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function imported(): Promise<{ id: string; local_path: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/repos/import', payload: { url } });
  expect(res.statusCode).toBe(202);
  const job = await awaitImport(res.json().job.id, { ingest: true });
  expect(job.status).toBe('done');
  return { id: job.repo_id!, local_path: job.dest };
}

describe('/api/repos', () => {
  it('imports as a job the page polls, then lists the row with its stack and the machines', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/repos/import', payload: { url, name: 'aoi-app' }, headers: { 'x-loop-user': 'addis' } });
    expect(res.statusCode).toBe(202);
    const { job } = res.json();
    expect(job).toMatchObject({ id: expect.stringMatching(/^imp_/), url, name: 'aoi-app', by: 'addis' });
    expect(['running', 'done']).toContain(job.status);
    // while it runs the list shows it
    const during = await app.inject({ method: 'GET', url: '/api/repos' });
    expect(during.json().imports.map((j: { id: string }) => j.id)).toEqual(job.status === 'running' ? [job.id] : []);
    await awaitImport(job.id, { ingest: true });
    const polled = await app.inject({ method: 'GET', url: `/api/repos/import/${job.id}` });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().job).toMatchObject({ status: 'done', repo_id: expect.stringMatching(/^r_/), steps: [{ label: '複製中', ok: true }, { label: '偵測建置與測試指令', ok: true }, { label: '完成', ok: true }] });
    expect((await app.inject({ method: 'GET', url: '/api/repos/import/imp_nope' })).statusCode).toBe(404);

    db.prepare("INSERT INTO machines (name, ssh_target, work_root) VALUES ('win-aoi', 'aoi@win', 'C:\\loop'), ('off', 'x@y', '/x')").run();
    db.prepare("UPDATE machines SET enabled = 0 WHERE name = 'off'").run();
    const list = await app.inject({ method: 'GET', url: '/api/repos' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.machines).toEqual(['win-aoi']);
    expect(body.imports).toEqual([]);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({
      id: polled.json().job.repo_id, name: 'aoi-app', remote_url: url, local_path: path.join(root, 'repos', 'aoi-app'), default_branch: 'main',
      build_cmd: 'npm run build', test_cmd: 'npm test', setup_cmd: 'npm install', domain: 'typescript', created_by: 'addis',
      stack: { languages: { typescript: 1 }, dirs: ['src'], entry_points: ['package.json'], files: 2 },
    });
    expect(body.repos[0].source_id).toMatch(/^src_/);
    expect(ingested).toEqual([body.repos[0].source_id]);
    const one = await app.inject({ method: 'GET', url: `/api/repos/${body.repos[0].id}` });
    expect(one.json().repo).toEqual(body.repos[0]);
    expect((await app.inject({ method: 'GET', url: '/api/repos/r_nope' })).statusCode).toBe(404);
  });

  it('refuses a bad URL, a bad name and a repeat before any clone', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/repos/import', payload: { url: 'ext::sh -c id' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: '/api/repos/import', payload: { url, name: '../up' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/repos/import', payload: { url, domain: 'cobol' } })).json()).toEqual({ error: expect.stringContaining('領域') });
    expect((await app.inject({ method: 'POST', url: '/api/repos/import', payload: {} })).statusCode).toBe(400);
    await imported();
    const again = await app.inject({ method: 'POST', url: '/api/repos/import', payload: { url } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('已經匯入過了');
    expect(fs.readdirSync(path.join(root, 'repos'))).toEqual(['app']);
  });

  it('PATCH changes only the editable fields and validates them', async () => {
    const { id, local_path } = await imported();
    db.prepare("INSERT INTO machines (name, ssh_target, work_root) VALUES ('win-aoi', 'aoi@win', 'C:\\loop')").run();
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/repos/${id}`,
      payload: { name: '瑕疵判型', default_branch: 'develop', pr_base: 'release', machine: 'win-aoi', test_cmd: 'ctest', domain: 'cpp', issue_label: 'loop', issue_comments: false, enabled: true, local_path: '/etc', id: 'r_x', stack_json: '{"languages":{}}' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().repo).toMatchObject({ id, name: '瑕疵判型', default_branch: 'develop', pr_base: 'release', machine: 'win-aoi', test_cmd: 'ctest', domain: 'cpp', issue_label: 'loop', issue_comments: 0, enabled: 1, local_path });
    expect(ok.json().repo.stack.languages).toEqual({ typescript: 1 }); // stack_json is import's, not the page's
    for (const [payload, msg] of [
      [{ default_branch: '--force' }, '分支名稱'],
      [{ domain: 'cobol' }, '領域'],
      [{ machine: 'nope' }, '沒有這台機台'],
      [{ name: '' }, '名稱'],
      [{ issue_comments: 'maybe' }, 'true 或 false'],
    ] as const) {
      const r = await app.inject({ method: 'PATCH', url: `/api/repos/${id}`, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toContain(msg);
    }
    expect((await app.inject({ method: 'PATCH', url: '/api/repos/r_nope', payload: { name: 'x' } })).statusCode).toBe(404);
    // the store's audit note names the fields
    const note = db.prepare("SELECT detail FROM task_events WHERE detail LIKE 'repo 設定修改%' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(note.detail).toContain('name');
  });

  it('redetect re-reads the checkout', async () => {
    const { id, local_path } = await imported();
    fs.writeFileSync(path.join(local_path, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint' } }));
    const r = await app.inject({ method: 'POST', url: `/api/repos/${id}/redetect` });
    expect(r.statusCode).toBe(200);
    expect(r.json().repo).toMatchObject({ build_cmd: null, test_cmd: null, setup_cmd: 'npm install' });
    expect((await app.inject({ method: 'POST', url: '/api/repos/r_nope/redetect' })).statusCode).toBe(404);
  });

  it('DELETE forgets the row and the picker entry but leaves the clone', async () => {
    const { id, local_path } = await imported();
    expect(getSetting(db, 'prd_repo_allowlist')).toBe(local_path);
    const gone = await app.inject({ method: 'DELETE', url: `/api/repos/${id}` });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual({ ok: true, local_path });
    expect((await app.inject({ method: 'GET', url: `/api/repos/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/repos/${id}` })).statusCode).toBe(404);
    expect(getSetting(db, 'prd_repo_allowlist')).toBe('');
    expect(fs.existsSync(path.join(local_path, 'package.json'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/repos' })).json().repos).toEqual([]);
  });
});
