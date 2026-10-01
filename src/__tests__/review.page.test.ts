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
import { paths } from '../config.js';
import type { SandboxResult } from '../exec/sandbox.js';

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

describe('結果頁: 交給同事 and a check run\'s files', () => {
  it('交給同事 records who follows the task up, and the page shows it', async () => {
    const { task } = reviewedTask();
    const r = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/owner`, headers: as('呂侑儒'), payload: { owner: ' 王小明 ' } });
    expect(r.json()).toEqual({ ok: true, owner: '王小明' });
    expect(getTask(db, task.id)!.owner).toBe('王小明');
    expect(getTask(db, task.id)!.status).toBe('review'); // nothing else about the task changes
    const notes = (db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'note'").all(task.id) as { detail: string }[]).map((e) => e.detail);
    expect(notes).toContain('交給 王小明（呂侑儒）');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/review` })).json().task.owner).toBe('王小明');

    for (const payload of [{}, { owner: 3 }, { owner: 'x'.repeat(41) }, { owner: 'a\u0007b' }]) {
      expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/owner`, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/tasks/t_nope/owner', payload: { owner: '王小明' } })).statusCode).toBe(404);
    const back = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/owner`, headers: as('王小明'), payload: { owner: '' } });
    expect(back.json()).toEqual({ ok: true, owner: null });
    expect(getTask(db, task.id)!.owner).toBeNull();
  });

  it('serves the pictures a check run pulled back, and nothing outside that run', async () => {
    const root = path.join(paths.dataDir, 'check-runs');
    const run = path.join(root, 'cr_page1');
    fs.mkdirSync(path.join(run, 'out', 'overlays'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cr_page2'), { recursive: true });
    fs.writeFileSync(path.join(run, 'out', 'overlays', 'IMG_0412.png'), 'PNG');
    fs.writeFileSync(path.join(run, 'out', 'results.json'), '{"IMG_0412":"OK"}');
    fs.writeFileSync(path.join(run, 'page.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    fs.writeFileSync(path.join(root, 'cr_page2', 'secret.txt'), 'another run');
    fs.writeFileSync(path.join(root, 'top.txt'), 'the folder of every run');
    try {
      const img = await app.inject({ method: 'GET', url: '/api/check-runs/cr_page1/files/out/overlays/IMG_0412.png' });
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['x-content-type-options']).toBe('nosniff');
      expect(img.body).toBe('PNG');
      const json = await app.inject({ method: 'GET', url: '/api/check-runs/cr_page1/files/out/results.json' });
      expect([json.headers['content-type'], json.headers['content-disposition']]).toEqual(['text/plain; charset=utf-8', undefined]);
      // markup never renders in the page's origin: it only downloads
      const svg = await app.inject({ method: 'GET', url: '/api/check-runs/cr_page1/files/page.svg' });
      expect(svg.headers['content-type']).toBe('application/octet-stream');
      expect(svg.headers['content-disposition']).toContain('attachment');
      for (const bad of [
        '/api/check-runs/cr_page1/files/../cr_page2/secret.txt',
        '/api/check-runs/cr_page1/files/out/../../cr_page2/secret.txt',
        '/api/check-runs/cr_page1/files/out%2F..%2F..%2Fcr_page2%2Fsecret.txt',
        '/api/check-runs/cr_page1/files/%2E%2E/top.txt',
        '/api/check-runs/cr_page1/files/..%2Ftop.txt',
        '/api/check-runs/..%2Fcr_page2/files/secret.txt',
        '/api/check-runs/cr_page1/files/%2Fetc%2Fpasswd',
        '/api/check-runs/cr_page1/files/out%5C..%5C..%5Ctop.txt',
        '/api/check-runs/cr_page1/files/',
        '/api/check-runs/cr_page1/files/out',
        '/api/check-runs/cr_page9/files/secret.txt',
      ]) {
        const r = await app.inject({ method: 'GET', url: bad });
        expect(r.statusCode, bad).toBe(404);
        expect(r.body, bad).not.toMatch(/another run|every run|root:/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('結果頁: a 問題單 bundle', () => {
  it('reads the frozen checks against check_runs: summaries, 修前, attempts, 自評, issue, screenshots, escalation', async () => {
    const { task, runId } = reviewedTask();
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path) VALUES ('r_page', 'cf-aoi', 'http://gitea.corp/aoi/cf-aoi.git', ?)").run(task.repo_path);
    const shot = path.join(dir('img'), 'err.png');
    fs.writeFileSync(shot, 'PNG');
    const checks = [
      { id: 'ck_build', name: '建置', kind: 'build', machine: null, command: 'make', required: true },
      { id: 'ck_repro', name: '重現', kind: 'repro', machine: null, command: './repro.sh', required: true },
    ];
    const plan = path.join(dir('plan'), 'PRD.md');
    fs.writeFileSync(plan, '# 需求\n修好除以零');
    db.prepare(
      `UPDATE tasks SET repo_id = 'r_page', checks_json = ?, images_json = ?, analysis_json = ?, review_json = ?, plan_ref = ?, model = 'local:qwen', ladder_step = 0 WHERE id = ?`,
    ).run(
      JSON.stringify(checks),
      JSON.stringify([{ file: shot, name: 'err.png', text: 'Division by zero' }]),
      JSON.stringify({ kind: 'bugfix', causes: [{ file: 'arith.cu', why: '沒檢查分母' }], questions: [] }),
      JSON.stringify({ summary: ['加了分母檢查'], why: '避免除以零', risks: [], out_of_scope: [], confidence: 'high' }),
      plan,
      task.id,
    );
    setSetting(db, 'fix_escalation', 'local:qwen,local:glm');
    db.prepare("INSERT INTO issue_links (task_id, repo_id, owner, repo, number, issue_url) VALUES (?, 'r_page', 'aoi', 'cf-aoi', 12, 'http://gitea.corp/aoi/cf-aoi/issues/12')").run(task.id);
    const row = db.prepare(
      `INSERT INTO check_runs (id, check_id, task_id, run_id, kind, ok, exit_code, timed_out, ms, result_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))`,
    );
    row.run('cr_b', 'ck_build', task.id, runId, 'verify', 1, 0, 41_000, null);
    row.run('cr_r', 'ck_repro', task.id, runId, 'red_green', 1, 0, 900, JSON.stringify({ before: { ok: false, exit_code: 1 }, after: { ok: true, exit_code: 0 } }));
    db.prepare("UPDATE task_runs SET verify_json = ?, finished_at = datetime('now') WHERE id = ?").run(
      JSON.stringify([
        { step: 'check:ck_build', ok: true, exitCode: 0, timedOut: false, tail: '' },
        { step: 'check:ck_repro', ok: true, exitCode: 0, timedOut: false, tail: '' },
      ]),
      runId,
    );

    const b = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/review` })).json();
    expect(b.headline).toBe('2 項檢查都過，重現測試從紅變綠');
    expect(b.checks.map((c: { name: string; state: string }) => [c.name, c.state])).toEqual([['建置', 'passed'], ['重現', 'passed']]);
    expect(b.checks[1].repro).toEqual({ before_ok: false, after_ok: true });
    expect(b.attempts).toHaveLength(1);
    expect(b.attempts[0].outcome).toBe('通過');
    expect(b.review.summary).toEqual(['加了分母檢查']);
    expect(b.issue).toEqual({ number: 12, url: 'http://gitea.corp/aoi/cf-aoi/issues/12', closed: false });
    expect(b.ticket.repo).toBe('cf-aoi');
    expect(b.ticket.analysis.causes[0].file).toBe('arith.cu');
    expect(b.ticket.images).toEqual([{ index: 0, name: 'err.png', text: 'Division by zero' }]);
    expect(b.ticket.prd).toContain('修好除以零');
    expect(b.escalation).toEqual({ next: 'local:glm' });
    expect(b.dataset).toEqual([]);

    const img = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/images/0` });
    expect([img.statusCode, img.headers['content-type'], img.body]).toEqual([200, 'image/png', 'PNG']);
    for (const bad of ['1', '-1', 'x', '0.0']) expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/images/${bad}` })).statusCode, bad).toBe(404);
  });

  it('a task that is not a ticket gets none of it', async () => {
    const { task } = reviewedTask();
    const b = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/review` })).json();
    expect([b.checks, b.dataset, b.attempts, b.ticket, b.escalation, b.issue, b.review]).toEqual([[], [], [], null, null, null, null]);
    expect(b.headline).toBe('2 項指標全部達標，1 個驗證步驟都成功');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/images/0` })).statusCode).toBe(404);
  });
});

describe('新工作流程 options', () => {
  it('offers the allow-listed repos with their branches', async () => {
    const repo = dir('jobrepo');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'x');
    git(repo, 'branch', 'feature/bright');
    setSetting(db, 'prd_repo_allowlist', repo);
    const opts = (await app.inject({ method: 'GET', url: '/api/jobs/options' })).json();
    expect(opts.repos).toEqual([expect.objectContaining({ path: fs.realpathSync(repo), name: path.basename(repo), branches: ['feature/bright', 'main'] })]);
    // the old 新工作 form's endpoints went with it
    expect((await app.inject({ method: 'POST', url: '/api/jobs/check', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/jobs', payload: {} })).statusCode).toBe(404);
  });
});
