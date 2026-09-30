import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { getCheck } from '../checks/store.js';
import { trialCheck, repoTrialDir } from '../checks/baseline.js';
import type { CheckDeps, MachineRunner } from '../checks/runner.js';

let db: Database.Database;
let app: FastifyInstance | null = null;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
});
afterEach(async () => {
  if (app) await app.close();
  app = null;
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repo row whose local_path is a real clone (file:// origin), like an imported one. */
function importedRepo(id: string, extra: { build_cmd?: string; test_cmd?: string; machine?: string } = {}): { local: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-checkroutes-'));
  tmp.push(root);
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(root, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'pipe' });
  git(seed, ['config', 'user.email', 'loop@test.local']);
  git(seed, ['config', 'user.name', 'Loop Test']);
  fs.writeFileSync(path.join(seed, 'bench.sh'), 'echo "bench"\necho \'LOOP_METRICS {"fps": 31.5, "time_ms": 1200}\'\n');
  git(seed, ['add', '-A']);
  git(seed, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', 'origin', 'main']);
  const local = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', origin, local], { stdio: 'pipe' });
  db.prepare('INSERT INTO repos (id, name, remote_url, local_path, default_branch, build_cmd, test_cmd, machine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'bench-repo',
    origin,
    local,
    'main',
    extra.build_cmd ?? null,
    extra.test_cmd ?? null,
    extra.machine ?? null,
  );
  tmp.push(repoTrialDir(id));
  return { local, sha: git(local, ['rev-parse', 'origin/main']).trim() };
}

function start(checkDeps?: CheckDeps): FastifyInstance {
  app = buildApp({ db, apiToken: null, mcpPool: null, checkRoutes: { checkDeps } });
  return app;
}

async function settle(a: FastifyInstance, runId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 250; i++) {
    const r = (await a.inject({ method: 'GET', url: `/api/check-runs/${runId}` })).json();
    if (!r.running) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('試跑 did not finish');
}

describe('檢查 API', () => {
  it('create, list, patch, reorder, delete — with the caller as author and actionable 400s', async () => {
    importedRepo('r_a');
    const a = start();
    expect((await a.inject({ method: 'GET', url: '/api/repos/r_nope/checks' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/repos/r_nope/checks', payload: { name: 'x', kind: 'build', command: 'make' } })).statusCode).toBe(404);
    const bad = await a.inject({ method: 'POST', url: '/api/repos/r_a/checks', payload: { name: 'x', kind: 'build' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('指令');
    const made = await a.inject({ method: 'POST', url: '/api/repos/r_a/checks', payload: { name: '建置', kind: 'build', command: 'make -j', timeout_min: 30, protected_paths: ['scripts/eval/**'] }, headers: { 'x-loop-user': '呂侑儒' } });
    expect(made.statusCode).toBe(201);
    const build = made.json();
    expect(build).toMatchObject({ name: '建置', created_by: '呂侑儒', timeout_min: 30, protected_paths: 'scripts/eval/**', baseline: null, last_run: null });
    const test = (await a.inject({ method: 'POST', url: '/api/repos/r_a/checks', payload: { name: '測試', kind: 'test', command: 'make test' } })).json();
    const listed = (await a.inject({ method: 'GET', url: '/api/repos/r_a/checks' })).json();
    expect(listed.checks.map((c: { name: string }) => c.name)).toEqual(['建置', '測試']);
    const patched = await a.inject({ method: 'PATCH', url: `/api/checks/${build.id}`, payload: { machine: 'aoi-1', required: false } });
    expect(patched.json()).toMatchObject({ machine: 'aoi-1', required: 0, command: 'make -j', timeout_min: 30 });
    expect((await a.inject({ method: 'PATCH', url: `/api/checks/${build.id}`, payload: { kind: 'nope' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PATCH', url: '/api/checks/ck_missing', payload: { name: 'x' } })).statusCode).toBe(404);
    const re = await a.inject({ method: 'POST', url: '/api/repos/r_a/checks/reorder', payload: { ids: [test.id] } });
    expect(re.json().checks.map((c: { name: string }) => c.name)).toEqual(['測試', '建置']);
    expect((await a.inject({ method: 'POST', url: '/api/repos/r_a/checks/reorder', payload: { ids: 'x' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: `/api/checks/${build.id}` })).json().name).toBe('建置');
    expect((await a.inject({ method: 'DELETE', url: `/api/checks/${build.id}` })).json()).toEqual({ ok: true });
    expect((await a.inject({ method: 'GET', url: `/api/checks/${build.id}` })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: `/api/checks/${build.id}` })).statusCode).toBe(404);
  });

  it('from-detected creates 建置 + 測試 on the repo machine once; nothing detected is a 409', async () => {
    importedRepo('r_det', { build_cmd: 'cmake --build build -j', test_cmd: 'ctest --test-dir build', machine: 'aoi-1' });
    importedRepo('r_none');
    const a = start();
    const first = await a.inject({ method: 'POST', url: '/api/repos/r_det/checks/from-detected' });
    expect(first.statusCode).toBe(201);
    expect(first.json().created.map((c: { name: string; kind: string; command: string; machine: string }) => [c.name, c.kind, c.command, c.machine])).toEqual([
      ['建置', 'build', 'cmake --build build -j', 'aoi-1'],
      ['測試', 'test', 'ctest --test-dir build', 'aoi-1'],
    ]);
    const again = await a.inject({ method: 'POST', url: '/api/repos/r_det/checks/from-detected' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ created: [], skipped: ['建置', '測試'] });
    expect((await a.inject({ method: 'POST', url: '/api/repos/r_none/checks/from-detected' })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: '/api/repos/r_gone/checks/from-detected' })).statusCode).toBe(404);
  });

  it('試跑 runs on the default branch asynchronously, reports the metric names, and a passing run becomes the baseline', async () => {
    const { sha } = importedRepo('r_bench');
    const a = start();
    const c = (await a.inject({ method: 'POST', url: '/api/repos/r_bench/checks', payload: { name: '效能', kind: 'custom', command: 'bash bench.sh' } })).json();
    const t = await a.inject({ method: 'POST', url: `/api/checks/${c.id}/trial` });
    expect(t.statusCode).toBe(202);
    const runId = t.json().run_id as string;
    expect(runId).toMatch(/^cr_/);
    const run = await settle(a, runId);
    expect(run).toMatchObject({ kind: 'trial', ok: 1, exit_code: 0, head_sha: sha, task_id: null, running: false, discovered: ['fps', 'time_ms'] });
    expect(run.output_tail).toContain('bench');
    expect(fs.existsSync(path.join(repoTrialDir('r_bench'), 'bench.sh'))).toBe(true);
    const runs = (await a.inject({ method: 'GET', url: `/api/checks/${c.id}/runs` })).json().runs;
    expect(runs.map((r: { id: string }) => r.id)).toEqual([runId]);
    expect(runs[0]).not.toHaveProperty('output_tail');
    expect((await a.inject({ method: 'POST', url: `/api/checks/${c.id}/baseline`, payload: {} })).statusCode).toBe(400);
    const based = await a.inject({ method: 'POST', url: `/api/checks/${c.id}/baseline`, payload: { run_id: runId } });
    expect(based.statusCode).toBe(200);
    expect(based.json().baseline).toMatchObject({ sha, values: { fps: 31.5, time_ms: 1200 }, run_id: runId });
    // with a baseline, 「不比基準差」 has numbers; the list shows the last run
    await a.inject({ method: 'PATCH', url: `/api/checks/${c.id}`, payload: { pass_rule: 'baseline' } });
    const listed = (await a.inject({ method: 'GET', url: '/api/repos/r_bench/checks' })).json().checks[0];
    expect(listed.last_run).toMatchObject({ id: runId, ok: 1, running: false });
    expect(getCheck(db, c.id)!.pass_rule).toBe('baseline');
    expect((await a.inject({ method: 'GET', url: '/api/check-runs/cr_nope' })).statusCode).toBe(404);
  });

  it('a failing 試跑 cannot be the baseline; manual checks and unknown checks cannot be tried', async () => {
    importedRepo('r_f');
    const a = start();
    const c = (await a.inject({ method: 'POST', url: '/api/repos/r_f/checks', payload: { name: '壞', kind: 'test', command: 'echo "LOOP_METRICS {\\"x\\": 1}"; exit 1' } })).json();
    const run = await settle(a, (await a.inject({ method: 'POST', url: `/api/checks/${c.id}/trial` })).json().run_id);
    expect(run).toMatchObject({ ok: 0, exit_code: 1 });
    const refused = await a.inject({ method: 'POST', url: `/api/checks/${c.id}/baseline`, payload: { run_id: run.id } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('沒有通過');
    const m = (await a.inject({ method: 'POST', url: '/api/repos/r_f/checks', payload: { name: '人工', kind: 'manual' } })).json();
    expect((await a.inject({ method: 'POST', url: `/api/checks/${m.id}/trial` })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: '/api/checks/ck_nope/trial' })).statusCode).toBe(404);
    const other = (await a.inject({ method: 'POST', url: '/api/repos/r_f/checks', payload: { name: '別的', kind: 'test', command: 'true' } })).json();
    expect((await a.inject({ method: 'POST', url: `/api/checks/${other.id}/baseline`, payload: { run_id: run.id } })).statusCode).toBe(400);
  });

  it('one 試跑 per repo at a time; a machine 試跑 checks out the default branch there', async () => {
    const { local, sha } = importedRepo('r_m');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: Array<Record<string, unknown>> = [];
    const machines: MachineRunner = {
      osOf: () => 'linux',
      async checkout(machine, req) {
        calls.push({ op: 'checkout', machine, sha: req.sha, branch: req.branch, remoteUrl: req.remoteUrl, repoName: req.repoName });
        return { ok: true, out: '', dir: `/srv/loop/${req.repoName}` };
      },
      async run(machine, req) {
        calls.push({ op: 'run', machine, cwd: req.cwd, command: req.command });
        await gate;
        return { ok: true, exitCode: 0, timedOut: false, output: 'LOOP_METRICS {"correct_rate": 0.99}\n', ms: 5 };
      },
      dataset: async () => ({ ok: false, out: '', dir: '' }),
      pullBack: async () => ({ ok: false, out: '' }),
      lock: (_m, fn) => fn(),
    };
    const a = start({ machines });
    const c = (await a.inject({ method: 'POST', url: '/api/repos/r_m/checks', payload: { name: '機台', kind: 'test', command: 'run-tests', machine: 'aoi-1' } })).json();
    const first = await a.inject({ method: 'POST', url: `/api/checks/${c.id}/trial` });
    expect(first.statusCode).toBe(202);
    const busy = await a.inject({ method: 'POST', url: `/api/checks/${c.id}/trial` });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toContain('已經有一個試跑');
    release();
    const run = await settle(a, first.json().run_id);
    expect(run).toMatchObject({ ok: 1, machine: 'aoi-1', discovered: ['correct_rate'] });
    expect(calls).toEqual([
      { op: 'checkout', machine: 'aoi-1', sha, branch: 'main', remoteUrl: git(local, ['remote', 'get-url', 'origin']).trim(), repoName: 'bench-repo' },
      { op: 'run', machine: 'aoi-1', cwd: '/srv/loop/bench-repo', command: 'run-tests' },
    ]);
    // the repo is free again
    const third = await a.inject({ method: 'POST', url: `/api/checks/${c.id}/trial` });
    expect(third.statusCode).toBe(202);
    expect(await settle(a, third.json().run_id)).toMatchObject({ ok: 1 });
  });

  it('trialCheck (the CLI path) awaits the run; a missing clone is recorded, not thrown', async () => {
    importedRepo('r_cli');
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path) VALUES ('r_gone', 'gone', 'x', '/nonexistent/clone')").run();
    start();
    const ok = (await app!.inject({ method: 'POST', url: '/api/repos/r_cli/checks', payload: { name: 'ok', kind: 'test', command: 'echo fine' } })).json();
    const r = await trialCheck(db, ok.id);
    expect(r.run.ok).toBe(1);
    const gone = (await app!.inject({ method: 'POST', url: '/api/repos/r_gone/checks', payload: { name: 'g', kind: 'test', command: 'true' } })).json();
    const g = await trialCheck(db, gone.id);
    expect(g.run.ok).toBe(0);
    expect(g.run.output_tail).toContain('試跑沒有開始：找不到 repo 的本機複本');
  });
});

describe('圖資 API', () => {
  it('create, list, patch, delete; a dataset in use cannot be deleted', async () => {
    importedRepo('r_ds');
    const a = start();
    const made = await a.inject({ method: 'POST', url: '/api/datasets', payload: { name: 'dataset-2026Q2', remote_url: 'http://gitea.corp:3000/aoi/q2.git', cases: 1204 }, headers: { 'x-loop-user': 'addis' } });
    expect(made.statusCode).toBe(201);
    const ds = made.json();
    expect(ds).toMatchObject({ name: 'dataset-2026Q2', answer_format: 'auto', cases: 1204, created_by: 'addis' });
    expect((await a.inject({ method: 'POST', url: '/api/datasets', payload: { name: 'dataset-2026Q2', remote_url: 'http://gitea.corp:3000/aoi/q2.git' } })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: '/api/datasets', payload: { name: 'bad name', remote_url: 'http://x/y.git' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/datasets' })).json().datasets.map((d: { name: string }) => d.name)).toEqual(['dataset-2026Q2']);
    expect((await a.inject({ method: 'PATCH', url: `/api/datasets/${ds.id}`, payload: { answer_format: 'csv' } })).json().answer_format).toBe('csv');
    expect((await a.inject({ method: 'PATCH', url: '/api/datasets/ds_nope', payload: { cases: 1 } })).statusCode).toBe(404);
    const c = (await a.inject({ method: 'POST', url: '/api/repos/r_ds/checks', payload: { name: '圖資回歸', kind: 'dataset', dataset_id: ds.id, command: 'run --in {images} --out {out}', pass_rule: 'baseline' } })).json();
    const inUse = await a.inject({ method: 'DELETE', url: `/api/datasets/${ds.id}` });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error).toContain('圖資回歸');
    await a.inject({ method: 'DELETE', url: `/api/checks/${c.id}` });
    expect((await a.inject({ method: 'DELETE', url: `/api/datasets/${ds.id}` })).json()).toEqual({ ok: true });
    expect((await a.inject({ method: 'DELETE', url: `/api/datasets/${ds.id}` })).statusCode).toBe(404);
  });
});
