import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, createRun, getTask, updateRun, setStatus } from '../tasks.js';
import { buildApp } from '../server/app.js';
import { verifiedShas } from '../review/code.js';
import { collectArtifacts } from '../review/artifacts.js';
import { removeTrialWorkspace } from '../review/review.js';
import type { SandboxResult } from '../exec/sandbox.js';
import { lintPrd } from '../prd/lint.js';
import { composeJobPrd } from '../plans/job.js';
import { createPlan } from '../plans/store.js';

let db: Database.Database;
let app: FastifyInstance;
let tmp: string[] = [];
const sandboxCalls: Array<{ command: string; workdir: string; remote: unknown }> = [];

const result = (over: Partial<SandboxResult> = {}): SandboxResult => ({
  exitCode: 0,
  timedOut: false,
  aborted: false,
  durationMs: 1200,
  timeoutSec: 600,
  output: 'ALL PASS\nLOOP_METRICS {"kernels_pass": 4, "mem_throughput_pct": 81.5}',
  truncated: false,
  hint: null,
  infra: false,
  error: null,
  host: 'local',
  ...over,
});

beforeEach(async () => {
  db = openTestDb();
  sandboxCalls.length = 0;
  app = buildApp({
    db,
    apiToken: null,
    mcpPool: null,
    sandboxRun: async (_s, req) => {
      sandboxCalls.push({ command: req.command, workdir: req.workdir, remote: req.remote ?? null });
      return result();
    },
    releaseToken: 'tok',
    releaseFetch: (async (url: string) =>
      String(url).endsWith('/releases')
        ? new Response(JSON.stringify({ id: 5, html_url: 'http://gitea.corp:3000/aoi/cf-aoi/releases/tag/v1.0.0' }), { status: 201 })
        : new Response(JSON.stringify({ browser_download_url: 'http://gitea.corp:3000/attachments/z' }), { status: 201 })) as unknown as typeof fetch,
  });
});
afterEach(async () => {
  await app.close();
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
const dir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-page-${tag}-`));
  tmp.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const as = (who: string) => ({ 'x-loop-user': who });

/** a task that finished verification and waits in review with its merge deferred to a person */
function reviewedTask() {
  const repo = dir('repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'arith.cu'), '__global__ void add() {}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const task = createTask(db, {
    title: 'CUDA 加減乘除',
    goal: '寫四則運算 kernel 並用 Nsight 驗證',
    coding_tool: 'claude-code',
    verification_steps: ['sandbox: bash run_ncu.sh'],
    repo_path: repo,
    base_branch: 'main',
    acceptance_metrics: 'kernels_pass == 4; mem_throughput_pct >= 60',
    artifacts: 'build/arith',
    verify_rubric: '- 四個 kernel 都正確\n\n人工驗收：\n- 在 GPU 機上看一次 ncu 報告',
  });
  const wt = path.join(dir('wts'), 'loop_' + task.id);
  git(repo, 'worktree', 'add', '-q', '-b', `loop/${task.id}`, wt, 'main');
  fs.writeFileSync(path.join(wt, 'arith.cu'), '__global__ void add() {}\n__global__ void sub() {}\n');
  fs.writeFileSync(path.join(wt, 'VERIFY.md'), '# 人工驗收\n- [ ] 確認 div 的誤差在容許範圍\n- [x] 已經做過的事\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'loop: auto-commit');
  fs.mkdirSync(path.join(wt, 'build'));
  fs.writeFileSync(path.join(wt, 'build', 'arith'), 'ELF');
  const run = createRun(db, { task_id: task.id, worktree_path: wt, branch: `loop/${task.id}` });
  updateRun(db, run.id, {
    verify_json: JSON.stringify([{ step: 'sandbox: bash run_ncu.sh', ok: true, exitCode: 0, timedOut: false, tail: 'ALL PASS' }]),
    metrics_json: JSON.stringify({
      values: { kernels_pass: 4, mem_throughput_pct: 81.5 },
      checks: [
        { name: 'kernels_pass', op: '==', target: 4, actual: 4, pass: true },
        { name: 'mem_throughput_pct', op: '>=', target: 60, actual: 81.5, pass: true },
      ],
      pass: true,
    }),
    ...verifiedShas(wt, 'main'),
  });
  db.prepare("UPDATE tasks SET merge_status = 'pending' WHERE id = ?").run(task.id);
  setStatus(db, task.id, 'review', { detail: '待人工驗證' });
  return { repo, wt, task: getTask(db, task.id)!, runId: run.id };
}

async function waitTrial(taskId: string, tid: string) {
  for (let i = 0; i < 100; i++) {
    const t = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/trials/${tid}` })).json();
    if (t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('trial did not finish');
}

describe('驗收頁', () => {
  it('shows the verdict, what was measured, the changed files and the checklist', async () => {
    const { task } = reviewedTask();
    const b = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/review`, headers: as('呂侑儒') })).json();
    expect(b.verdict).toBe('passed');
    expect(b.headline).toBe('2 項指標全部達標，1 個驗證步驟都成功');
    expect(b.hosts).toEqual(['local']);
    expect(b.changed_files).toEqual(expect.arrayContaining([{ status: 'M', path: 'arith.cu' }, { status: 'A', path: 'VERIFY.md' }]));
    expect(b.checklist.map((c: { text: string }) => c.text)).toEqual(['在 GPU 機上看一次 ncu 報告', '確認 div 的誤差在容許範圍']);
    expect(b.can.approve).toBe(false);
    expect(b.can.approve_reason).toContain('還有 2 項沒勾');
    expect(b.can.trial_reason).toContain('exec_enabled');
    expect(b.viewer.label).toBe('呂侑儒');

    const src = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/code/file?path=arith.cu` })).json();
    expect(src.text).toContain('sub()');
    const base = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/code/file?path=arith.cu&side=base` })).json();
    expect(base.text).not.toContain('sub()');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/code/diff?path=arith.cu` })).json().diff).toContain('+__global__ void sub() {}');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/code/file?path=../../etc/passwd` })).statusCode).toBe(404);
  });

  it('核可 needs every manual check ticked, then merges the deferred merge and records who', async () => {
    const { repo, task } = reviewedTask();
    const early = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: as('呂侑儒') });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toContain('還有 2 項沒勾');
    for (const index of [0, 1]) {
      const r = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/checks`, headers: as('呂侑儒'), payload: { index, checked: true } });
      expect(r.json().checklist[index]).toMatchObject({ checked: true, by: '呂侑儒' });
    }
    const ok = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: as('呂侑儒') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ merged: true, detail: '已合併到 main' });
    expect(git(repo, 'log', '--oneline', 'main')).toContain('loop: auto-commit');
    const t = getTask(db, task.id)!;
    expect(t.approved_by).toBe('呂侑儒');
    expect(t.merge_status).toBe('merged');
  });

  it('試跑: only for people allowed to run code; re-runs verification and reads the metrics', async () => {
    const { task } = reviewedTask();
    setSetting(db, 'exec_enabled', 'true');
    setSetting(db, 'exec_allowed_users', 'name:tester');
    const denied = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/trials`, headers: as('路人'), payload: { mode: 'verify' } });
    expect(denied.statusCode).toBe(403);

    const started = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/trials`, headers: as('tester'), payload: { mode: 'verify' } });
    expect(started.statusCode).toBe(202);
    const done = await waitTrial(task.id, started.json().id);
    expect(done.status).toBe('done');
    expect(done.results[0]).toMatchObject({ step: 'sandbox: bash run_ncu.sh', ok: true, exitCode: 0 });
    expect(done.metrics.pass).toBe(true);
    // it ran in a separate checkout of the verified commit, not in the task's own worktree
    expect(sandboxCalls[0]!.command).toBe('bash run_ncu.sh');
    expect(sandboxCalls[0]!.workdir).toContain(path.join('review', task.id));
    expect(fs.readFileSync(path.join(sandboxCalls[0]!.workdir, 'arith.cu'), 'utf8')).toContain('sub()');

    const cmd = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/trials`, headers: as('tester'), payload: { mode: 'command', command: './build/arith --help' } });
    const cdone = await waitTrial(task.id, cmd.json().id);
    expect(cdone.results[0].step).toBe('sandbox: ./build/arith --help');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/trials` })).json().trials).toHaveLength(2);
    removeTrialWorkspace(task);
  });

  it('退回修改 puts the feedback in the goal and requeues the task on its own branch', async () => {
    const { task } = reviewedTask();
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/request-changes`, payload: { feedback: ' ' } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/request-changes`, headers: as('呂侑儒'), payload: { feedback: 'div 在分母很小時誤差太大，請改用 IEEE 除法' } });
    expect(r.json()).toEqual({ ok: true, status: 'queued' });
    const t = getTask(db, task.id)!;
    expect(t.goal).toContain('## 人工驗收退回（呂侑儒');
    expect(t.goal).toContain('請改用 IEEE 除法');
    expect(t.checklist_json).toBeNull();
    expect(t.merge_status).toBeNull();
  });

  it('產出物: list, download one, download the zip; 發佈 only after 核可', async () => {
    const { wt, task, runId } = reviewedTask();
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as Parameters<typeof collectArtifacts>[2];
    await collectArtifacts(db, task, run, wt);
    const list = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/artifacts` })).json();
    expect(list.manifest.files.map((f: { path: string }) => f.path)).toEqual(['build/arith']);
    const one = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/artifacts/file?path=build/arith` });
    expect(one.body).toBe('ELF');
    expect(one.headers['content-disposition']).toContain('filename="arith"');
    const zip = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/artifacts.zip` });
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(zlib.inflateRawSync).toBeTypeOf('function');

    git(task.repo_path!, 'remote', 'add', 'origin', 'http://gitea.corp:3000/aoi/cf-aoi.git');
    setSetting(db, 'gitea_url', 'http://gitea.corp:3000');
    const early = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/release`, payload: { tag: 'v1.0.0' } });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toContain('核可後');
    db.prepare("UPDATE tasks SET approved_by = 'x', approved_at = datetime('now') WHERE id = ?").run(task.id);
    // the page's button reads the same token the release uses, not only the process env
    vi.stubEnv('GITEA_TOKEN', '');
    try {
      const can = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/review` })).json().can;
      expect([can.release, can.release_reason]).toEqual([true, null]);
    } finally {
      vi.unstubAllEnvs();
    }
    const bad = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/release`, payload: { tag: 'v 1' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/release`, headers: as('呂侑儒'), payload: { tag: 'v1.0.0' } });
    expect(ok.json()).toEqual({ url: 'http://gitea.corp:3000/aoi/cf-aoi/releases/tag/v1.0.0', asset_url: 'http://gitea.corp:3000/attachments/z' });
    expect(getTask(db, task.id)!.release_url).toBe('http://gitea.corp:3000/aoi/cf-aoi/releases/tag/v1.0.0');
  });
});

describe('新工作', () => {
  function jobFixture() {
    const repo = dir('jobrepo');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'x');
    git(repo, 'branch', 'feature/bright');
    setSetting(db, 'prd_repo_allowlist', repo);
    const plan = createPlan(db, {
      name: '亮缺陷判型 — 標準圖集',
      repo_path: fs.realpathSync(repo),
      host: 'aoi-gpu',
      steps: ['cmake --build build -j', 'python3 scripts/eval/run.py --gallery {dataset}'],
      dataset_root: '/datasets',
      dataset_default: '20260615',
      metrics: 'detection_rate >= 0.98; miss == 0',
      protected_paths: 'scripts/eval/**',
      artifacts: 'build/cfaoi_ip',
      manual_checks: ['上機台跑一次選定的圖集'],
      domain: 'cuda',
    });
    return { repo: fs.realpathSync(repo), plan };
  }
  const job = (repo: string, planId: string, over: Record<string, unknown> = {}) => ({
    repo_path: repo,
    base_branch: 'feature/bright',
    title: '修正 X 區亮缺陷判型',
    symptom: 'X 區的亮缺陷被判成髒污',
    expected: '改好後判成亮缺陷，其他判型不變',
    plan_id: planId,
    dataset: '20260701',
    ...over,
  });

  it('the PRD it becomes passes the gate as written, with everything the plan says', () => {
    const { repo, plan } = jobFixture();
    const md = composeJobPrd(job(repo, plan.id), plan, repo, '/datasets/20260701', [
      'sandbox@aoi-gpu: cmake --build build -j',
      'sandbox@aoi-gpu: python3 scripts/eval/run.py --gallery /datasets/20260701',
    ]);
    const r = lintPrd(md, { exists: () => true });
    expect(r.missing).toEqual([]);
    expect(r.fields.verify_mode).toEqual(['command', 'manual']);
    expect(r.fields.acceptance_metrics).toBe('detection_rate >= 0.98; miss == 0');
    expect(r.fields.protected_paths).toEqual(['scripts/eval/**']);
    expect(r.fields.artifacts).toEqual(['build/cfaoi_ip']);
    expect(r.fields.manual_checks).toEqual(['上機台跑一次選定的圖集']);
    expect(r.fields.base_branch).toBe('feature/bright');
  });

  it('options, check, submit: the task carries the plan, its machine and a human sign-off', async () => {
    const { repo, plan } = jobFixture();
    const reviewing = buildApp({ db, apiToken: null, mcpPool: null, prdReviewExec: async () => '{"ok":true,"missing":[],"questions":[],"risk_notes":[]}' });
    try {
      const opts = (await reviewing.inject({ method: 'GET', url: '/api/jobs/options' })).json();
      expect(opts.repos).toEqual([expect.objectContaining({ path: repo, name: path.basename(repo), branches: ['feature/bright', 'main'] })]);
      const outside = await reviewing.inject({ method: 'POST', url: '/api/jobs/check', payload: job('/etc', plan.id) });
      expect(outside.statusCode).toBe(400);
      expect(outside.json().error).toContain('允許的 repo');
      const vague = await reviewing.inject({ method: 'POST', url: '/api/jobs/check', payload: job(repo, plan.id, { symptom: '壞了', expected: '好' }) });
      expect(vague.json().error).toContain('至少 15 個字');
      const check = (await reviewing.inject({ method: 'POST', url: '/api/jobs/check', payload: job(repo, plan.id) })).json();
      expect(check.check.ok).toBe(true);
      expect(check.markdown).toContain('sandbox@aoi-gpu: python3 scripts/eval/run.py --gallery /datasets/20260701');
      const created = await reviewing.inject({ method: 'POST', url: '/api/jobs', headers: as('呂侑儒'), payload: job(repo, plan.id) });
      expect(created.statusCode).toBe(201);
      const t = getTask(db, created.json().task.id)!;
      expect(t.status).toBe('queued');
      expect(t.verify_plan_id).toBe(plan.id);
      expect(t.verify_mode).toBe('command,manual');
      expect(t.artifacts).toBe('build/cfaoi_ip');
      expect(t.protected_paths).toBe('scripts/eval/**');
      expect(t.base_branch).toBe('feature/bright');
      expect(JSON.parse(t.verification_steps)).toEqual(['sandbox@aoi-gpu: cmake --build build -j', 'sandbox@aoi-gpu: python3 scripts/eval/run.py --gallery /datasets/20260701']);
    } finally {
      await reviewing.close();
    }
  });
});
