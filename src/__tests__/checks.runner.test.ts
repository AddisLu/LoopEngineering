import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createRun, createTask, getRun, getTask } from '../tasks.js';
import { paths } from '../config.js';
import type { Task } from '../types.js';
import { runVerifyGate, runVerifyPipeline } from '../orchestrator/run.js';
import { runVerification } from '../orchestrator/verify.js';
import { createCheck } from '../checks/store.js';
import { createDataset } from '../checks/datasets.js';
import { renderChecks, snapshotChecks, type CheckSnapshot } from '../checks/render.js';
import { checkRunsForRun, getCheckRun } from '../checks/runs.js';
import { checkStepRunner, hasCheckSteps, parseCheckStep, prefixMetricLines, type MachineRunner } from '../checks/runner.js';

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
  db.prepare('INSERT INTO repos (id, name, remote_url, local_path) VALUES (?, ?, ?, ?)').run('r_cfaoi', 'cf-aoi', 'http://gitea.corp:3000/aoi/cf-aoi.git', '/srv/repos/cf-aoi');
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

function mkTmp(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-checks-${tag}-`));
  tmp.push(d);
  return d;
}
function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function identity(dir: string): void {
  git(dir, ['config', 'user.email', 'loop@test.local']);
  git(dir, ['config', 'user.name', 'Loop Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}
function commit(dir: string, files: Record<string, string>, msg: string): void {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-q', '-m', msg]);
}

/** A task that runs exactly these frozen checks (as the ticket flow will create it). */
function taskFor(snap: CheckSnapshot[], extra: Partial<Parameters<typeof createTask>[1]> = {}): Task {
  const r = renderChecks(snap);
  const t = createTask(db, {
    title: 't',
    goal: 'g',
    coding_tool: 'mock',
    verification_steps: r.verification_steps,
    acceptance_metrics: r.acceptance_metrics,
    protected_paths: r.protected_paths,
    verify_mode: r.verify_mode,
    ...extra,
  });
  db.prepare('UPDATE tasks SET checks_json = ?, repo_id = ? WHERE id = ?').run(JSON.stringify(snap), 'r_cfaoi', t.id);
  return getTask(db, t.id)!;
}

function plainSetup(snap: CheckSnapshot[]) {
  const task = taskFor(snap);
  const wt = mkTmp('wt');
  const run = createRun(db, { task_id: task.id, worktree_path: wt });
  return { task, wt, runId: run.id };
}

/** A worktree on loop/<task> with a file:// origin, like a real run's. */
function gitSetup(snap: CheckSnapshot[]) {
  const root = mkTmp('git');
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const wt = path.join(root, 'wt');
  execFileSync('git', ['clone', '-q', origin, wt], { stdio: 'pipe' });
  identity(wt);
  commit(wt, { 'README.md': 'base\n' }, 'base');
  git(wt, ['push', '-q', 'origin', 'main']);
  const task = taskFor(snap, { repo_path: wt, base_branch: 'main' });
  git(wt, ['checkout', '-q', '-b', `loop/${task.id}`]);
  commit(wt, { 'src/fix.txt': 'fixed\n' }, 'fix');
  const run = createRun(db, { task_id: task.id, worktree_path: wt, branch: `loop/${task.id}` });
  return { task, wt, origin, runId: run.id };
}

interface Call {
  op: string;
  machine: string;
  [k: string]: unknown;
}

function fakeMachines(o: { os?: 'linux' | 'windows'; run?: (req: { cwd: string; command: string }) => { exitCode: number; output: string }; onPullBack?: (remote: string[], localDir: string) => void } = {}) {
  const calls: Call[] = [];
  const root = o.os === 'windows' ? 'C:\\loop' : '/srv/loop';
  const join = (a: string, b: string) => (o.os === 'windows' ? `${a}\\${b}` : `${a}/${b}`);
  const m: MachineRunner = {
    osOf: () => o.os ?? 'linux',
    async checkout(machine, req) {
      calls.push({ op: 'checkout', machine, ...req });
      return { ok: true, out: '', dir: join(root, req.repoName) };
    },
    async run(machine, req) {
      calls.push({ op: 'run', machine, cwd: req.cwd, command: req.command, timeoutMs: req.timeoutMs });
      const r = o.run?.(req) ?? { exitCode: 0, output: 'ok\n' };
      return { ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: false, output: r.output, ms: 4321 };
    },
    async dataset(machine, ds) {
      calls.push({ op: 'dataset', machine, ...ds });
      return { ok: true, out: '', dir: join(join(root, 'datasets'), ds.name) };
    },
    async pullBack(machine, remotePaths, localDir) {
      calls.push({ op: 'pullBack', machine, remotePaths, localDir });
      o.onPullBack?.(remotePaths, localDir);
      return { ok: true, out: '' };
    },
    async lock(machine, fn) {
      calls.push({ op: 'lock', machine });
      return fn();
    },
  };
  return { m, calls };
}

describe('check: steps on the engine host', () => {
  it('run like a plain step, carry the check name and are recorded per run (verify, then reverify)', async () => {
    const c = createCheck(db, 'r_cfaoi', { name: '單元測試', kind: 'test', command: 'echo "unit ok"' });
    const { task, wt, runId } = plainSetup(snapshotChecks(db, 'r_cfaoi'));
    expect(task.verification_steps).toBe(JSON.stringify([`check:${c.id}`]));
    expect(hasCheckSteps(task)).toBe(true);
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('pass');
    const verify = JSON.parse(getRun(db, runId)!.verify_json!);
    expect(verify).toEqual([expect.objectContaining({ step: '單元測試', ok: true, exitCode: 0 })]);
    const [row] = checkRunsForRun(db, runId);
    expect(row).toMatchObject({ check_id: c.id, task_id: task.id, run_id: runId, kind: 'verify', ok: 1, exit_code: 0, timed_out: 0 });
    expect(row!.output_tail).toContain('unit ok');
    expect(row!.finished_at).not.toBeNull();
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('pass');
    expect(checkRunsForRun(db, runId).map((r) => r.kind)).toEqual(['verify', 'reverify']);
  });

  it('a failing check fails verification under its own name (attention detail, resume context)', async () => {
    createCheck(db, 'r_cfaoi', { name: '建置', kind: 'build', command: 'echo building' });
    createCheck(db, 'r_cfaoi', { name: '單元測試', kind: 'test', command: 'echo "3 tests failed"; exit 3' });
    createCheck(db, 'r_cfaoi', { name: '不會跑到', kind: 'test', command: 'echo never' });
    const { task, wt, runId } = plainSetup(snapshotChecks(db, 'r_cfaoi'));
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('fail');
    expect(getTask(db, task.id)!.status).toBe('attention');
    const detail = (db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'status' ORDER BY id DESC LIMIT 1").get(task.id) as { detail: string }).detail;
    expect(detail).toContain('verify failed at: 單元測試');
    expect(detail).toContain('3 tests failed');
    expect(fs.readFileSync(path.join(wt, 'LOOP_RESUME_CONTEXT.md'), 'utf8')).toContain('單元測試');
    expect(checkRunsForRun(db, runId).map((r) => [r.ok, r.exit_code])).toEqual([
      [1, 0],
      [0, 3],
    ]);
  });

  it('the check timeout wins over the verify step timeout', async () => {
    createCheck(db, 'r_cfaoi', { name: '慢', kind: 'test', command: 'sleep 5', timeout_min: 1 });
    const { task, wt } = plainSetup(snapshotChecks(db, 'r_cfaoi'));
    const seen: number[] = [];
    const runner = checkStepRunner(db, task, { shell: async (_c, _cwd, t) => (seen.push(t), { ok: true, exitCode: 0, timedOut: false, output: '', ms: 1 }), record: null });
    await runner(JSON.parse(task.verification_steps)[0], wt, 5_000);
    expect(seen).toEqual([60_000]);
    const noOwn = createCheck(db, 'r_cfaoi', { name: '預設', kind: 'test', command: 'true' });
    const t2 = taskFor(snapshotChecks(db, 'r_cfaoi').filter((s) => s.id === noOwn.id));
    await checkStepRunner(db, t2, { shell: async (_c, _cwd, t) => (seen.push(t), { ok: true, exitCode: 0, timedOut: false, output: '', ms: 1 }), record: null })(`check:${noOwn.id}`, wt, 5_000);
    expect(seen[1]).toBe(20 * 60_000); // check_timeout_min
    expect(checkRunsForRun(db, 'nothing')).toEqual([]);
  });

  it('a task without check: steps never builds the runner and records nothing', async () => {
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: ['echo plain'] });
    const wt = mkTmp('plain');
    const run = createRun(db, { task_id: t.id, worktree_path: wt });
    expect(hasCheckSteps(t)).toBe(false);
    expect(await runVerifyPipeline(db, getTask(db, t.id)!, wt, run.id, 'main')).toBe('pass');
    expect(JSON.parse(getRun(db, run.id)!.verify_json!)).toEqual([expect.objectContaining({ step: 'echo plain', ok: true })]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM check_runs').get() as { n: number }).n).toBe(0);
  });

  it('falls back to the live check when the task has no copy; an unknown id fails clearly; no runner = clear note', async () => {
    const c = createCheck(db, 'r_cfaoi', { name: '活的', kind: 'test', command: 'echo live' });
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: [`check:${c.id}`, 'check:ck_gone123'] });
    const wt = mkTmp('live');
    const run = createRun(db, { task_id: t.id, worktree_path: wt });
    const gate = await runVerifyGate(db, getTask(db, t.id)!, wt, run.id, 'main');
    expect(gate.results.map((r) => [r.step, r.ok])).toEqual([
      ['活的', true],
      ['check:ck_gone123', false],
    ]);
    expect(gate.results[1]!.output).toContain('找不到檢查 ck_gone123');
    const bare = await runVerification(getTask(db, t.id)!, wt);
    expect(bare.ok).toBe(false);
    expect(bare.results[0]!.output).toContain('沒有接上檢查執行器');
    expect(parseCheckStep(' check: ck_abc-_1 ')).toBe('ck_abc-_1');
    expect(parseCheckStep('check: make')).toBeNull();
    expect(parseCheckStep('checkov .')).toBeNull();
  });
});

describe('check: steps on a 機台', () => {
  it('pushes the branch, then checks out HEAD on the machine and runs there, under its lock', async () => {
    const c = createCheck(db, 'r_cfaoi', { name: '單元測試', kind: 'test', command: 'ctest --test-dir build', machine: 'aoi-1' });
    const { task, wt, origin, runId } = gitSetup(snapshotChecks(db, 'r_cfaoi'));
    const { m, calls } = fakeMachines({ run: () => ({ exitCode: 0, output: '100% tests passed\n' }) });
    expect(await runVerifyPipeline(db, task, wt, runId, 'main', undefined, undefined, { machines: m })).toBe('pass');
    const head = git(wt, ['rev-parse', 'HEAD']).trim();
    expect(git(origin, ['rev-parse', `loop/${task.id}`]).trim()).toBe(head); // on origin before the machine fetched
    expect(calls).toEqual([
      { op: 'lock', machine: 'aoi-1' },
      { op: 'checkout', machine: 'aoi-1', repoName: 'cf-aoi', remoteUrl: origin, sha: head, branch: `loop/${task.id}`, localTree: wt },
      { op: 'run', machine: 'aoi-1', cwd: '/srv/loop/cf-aoi', command: 'ctest --test-dir build', timeoutMs: 20 * 60_000 },
    ]);
    const [row] = checkRunsForRun(db, runId);
    expect(row).toMatchObject({ check_id: c.id, machine: 'aoi-1', head_sha: head, ok: 1 });
    expect(row!.output_tail).toContain('（在 aoi-1：/srv/loop/cf-aoi）');
    expect(row!.output_tail).toContain('100% tests passed');
  });

  it('without a bound machine runner the step fails with 機台執行器尚未設定', async () => {
    createCheck(db, 'r_cfaoi', { name: '建置', kind: 'build', command: 'msbuild', machine: 'aoi-win' });
    const { task, wt, runId } = plainSetup(snapshotChecks(db, 'r_cfaoi'));
    expect(await runVerifyPipeline(db, task, wt, runId, 'main', undefined, undefined, { machines: null })).toBe('fail');
    const [row] = checkRunsForRun(db, runId);
    expect(row!.ok).toBe(0);
    expect(row!.output_tail).toContain('機台執行器尚未設定');
    expect(row!.output_tail).toContain('aoi-win');
  });

  it('a machine that cannot get the code fails the step with its reason; errors never escape', async () => {
    createCheck(db, 'r_cfaoi', { name: '建置', kind: 'build', command: 'make', machine: 'aoi-1' });
    const { task, wt, runId } = gitSetup(snapshotChecks(db, 'r_cfaoi'));
    const { m } = fakeMachines();
    m.checkout = async () => ({ ok: false, out: 'fatal: could not read from remote', dir: '' });
    const r1 = await runVerifyGate(db, task, wt, runId, 'main', undefined, { checkDeps: { machines: m } });
    expect(r1.results[0]!.output).toContain('拿不到要檢查的程式');
    expect(r1.results[0]!.output).toContain('could not read from remote');
    m.checkout = async () => {
      throw new Error('ssh exploded');
    };
    const r2 = await runVerifyGate(db, task, wt, runId, 'main', undefined, { checkDeps: { machines: m } });
    expect(r2.failure?.failedStep).toBe('建置');
    expect(r2.results[0]!.output).toContain('ssh exploded');
  });
});

describe('圖資回歸', () => {
  const ANSWERS = JSON.stringify({ 'a.png': 'OK', 'b.png': 'NG', 'c.png': 'OK', 'd.png': 'NG' });
  const OUTPUT = JSON.stringify([
    { image: 'a.png', label: 'OK' },
    { image: 'b.png', label: 'NG' },
    { image: 'c.png', label: 'NG' },
  ]);

  it('on a machine: dataset, {images} {answers} {out} filled, output pulled back, compared, LOOP_METRICS judged', async () => {
    const ds = createDataset(db, { name: 'q2', remote_url: 'http://gitea.corp:3000/aoi/q2.git', images_dir: 'imgs/val' });
    const c = createCheck(db, 'r_cfaoi', {
      name: '圖資回歸',
      kind: 'dataset',
      machine: 'aoi-1',
      dataset_id: ds.id,
      command: 'run_inference --in {images} --gt {answers} --out {out}',
      pass_rule: 'metrics',
      metrics: 'correct_rate >= 0.5; missing <= 1',
    });
    const { task, wt, runId } = gitSetup(snapshotChecks(db, 'r_cfaoi'));
    const { m, calls } = fakeMachines({
      run: (req) => ({ exitCode: 0, output: req.command.startsWith('mkdir') ? '' : 'inference done\n' }),
      onPullBack: (remote, localDir) => {
        const name = path.posix.basename(remote[0]!);
        if (name === 'answers.json') fs.writeFileSync(path.join(localDir, 'answers.json'), ANSWERS);
        else {
          fs.mkdirSync(path.join(localDir, name, 'overlays'), { recursive: true });
          fs.writeFileSync(path.join(localDir, name, 'results.json'), OUTPUT);
          fs.writeFileSync(path.join(localDir, name, 'overlays', 'c.png'), 'png');
        }
      },
    });
    const gate = await runVerifyGate(db, task, wt, runId, 'main', undefined, { checkDeps: { machines: m } });
    expect(gate.failure).toBeNull();
    expect(gate.metrics).toMatchObject({ pass: true, values: { correct_rate: 0.5, mismatches: 1, missing: 1, total: 4, time_ms: 4321 } });
    const [row] = checkRunsForRun(db, runId);
    const crId = row!.id;
    const runs = calls.filter((x) => x.op === 'run').map((x) => x.command);
    expect(runs).toEqual([
      `mkdir -p '/srv/loop/cf-aoi-out/${crId}'`,
      `run_inference --in /srv/loop/datasets/q2/imgs/val --gt /srv/loop/datasets/q2/answers.json --out /srv/loop/cf-aoi-out/${crId}`,
    ]);
    expect(calls.find((x) => x.op === 'dataset')).toEqual({ op: 'dataset', machine: 'aoi-1', name: 'q2', remoteUrl: 'http://gitea.corp:3000/aoi/q2.git' });
    expect(calls.filter((x) => x.op === 'pullBack').map((x) => x.remotePaths)).toEqual([[`/srv/loop/cf-aoi-out/${crId}`], ['/srv/loop/datasets/q2/answers.json']]);
    expect(row!.output_tail).toContain('圖資比對：2/4 正確（50.00%）；不符 1、沒有輸出 1');
    expect(row!.output_tail.trimEnd().split('\n').at(-1)).toBe('LOOP_METRICS {"correct_rate":0.5,"mismatches":1,"missing":1,"total":4,"time_ms":4321}');
    const result = JSON.parse(row!.result_json!);
    expect(result.cases.map((x: { case: string; ok: boolean }) => [x.case, x.ok])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', false],
    ]);
    expect(JSON.parse(row!.artifacts_json!).files).toContain(`out/${crId}/overlays/c.png`);
    expect(JSON.parse(row!.metrics_json!)).toMatchObject({ pass: true });
    expect(c.id).toBe(row!.check_id);

    // the same run against a stricter threshold fails on 驗收指標, not on the step
    db.prepare('UPDATE tasks SET acceptance_metrics = ? WHERE id = ?').run('correct_rate >= 0.9', task.id);
    const strict = await runVerifyGate(db, getTask(db, task.id)!, wt, runId, 'main', undefined, { checkDeps: { machines: m } });
    expect(strict.failure?.failedStep).toBe('驗收指標');
    expect(strict.failure!.results.at(-1)!.output).toContain('correct_rate = 0.5，要求 >= 0.9');
  });

  it('a Windows machine gets backslash paths and mkdir without -p', async () => {
    const ds = createDataset(db, { name: 'q2w', remote_url: 'http://gitea.corp:3000/aoi/q2w.git', answer_file: 'gt/answers.csv' });
    createCheck(db, 'r_cfaoi', { name: '圖資', kind: 'dataset', machine: 'aoi-win', dataset_id: ds.id, command: 'aoi.exe --in {images} --out {out}' });
    const { task, wt, runId } = gitSetup(snapshotChecks(db, 'r_cfaoi'));
    const { m, calls } = fakeMachines({
      os: 'windows',
      onPullBack: (remote, localDir) => {
        if (remote[0]!.endsWith('answers.csv')) fs.writeFileSync(path.join(localDir, 'answers.csv'), 'image,label\na.png,OK\n');
        else fs.writeFileSync(path.join(localDir, 'result.csv'), 'a.png,OK\n'); // contents only, not the folder
      },
    });
    const gate = await runVerifyGate(db, task, wt, runId, 'main', undefined, { checkDeps: { machines: m } });
    expect(gate.failure).toBeNull();
    const crId = checkRunsForRun(db, runId)[0]!.id;
    expect(calls.filter((x) => x.op === 'run').map((x) => x.command)).toEqual([
      `mkdir "C:\\loop\\cf-aoi-out\\${crId}"`,
      `aoi.exe --in C:\\loop\\datasets\\q2w\\images --out C:\\loop\\cf-aoi-out\\${crId}`,
    ]);
    expect(calls.filter((x) => x.op === 'pullBack').map((x) => x.remotePaths)).toEqual([[`C:\\loop\\cf-aoi-out\\${crId}`], ['C:\\loop\\datasets\\q2w\\gt\\answers.csv']]);
    expect(gate.metrics?.values).toMatchObject({ correct_rate: 1, total: 1 });
  });

  it('on the engine host: the dataset repo is cloned locally and {out} is read in place', async () => {
    const root = mkTmp('ds');
    const bare = path.join(root, 'ds.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const seed = path.join(root, 'seed');
    execFileSync('git', ['clone', '-q', bare, seed], { stdio: 'pipe' });
    identity(seed);
    commit(seed, { 'images/a.png': 'a', 'images/b.png': 'b', 'answers.json': ANSWERS }, 'dataset');
    git(seed, ['push', '-q', 'origin', 'main']);
    const name = `local-${path.basename(root)}`;
    tmp.push(path.join(paths.dataDir, 'datasets', name));
    const ds = createDataset(db, { name, remote_url: `file://${bare}` });
    createCheck(db, 'r_cfaoi', {
      name: '圖資（本機）',
      kind: 'dataset',
      dataset_id: ds.id,
      command: `ls {images} && test -f {answers} && printf '%s' '${OUTPUT}' > {out}/results.json`,
      pass_rule: 'metrics',
      metrics: 'correct_rate >= 0.5',
    });
    const { task, wt, runId } = plainSetup(snapshotChecks(db, 'r_cfaoi'));
    const gate = await runVerifyGate(db, task, wt, runId, 'main');
    expect(gate.failure).toBeNull();
    expect(gate.metrics?.values).toMatchObject({ correct_rate: 0.5, mismatches: 1, missing: 1, total: 4 });
    const row = checkRunsForRun(db, runId)[0]!;
    expect(row.output_tail).toContain('a.png');
    expect(fs.existsSync(path.join(paths.dataDir, 'datasets', name, 'answers.json'))).toBe(true);
    expect(fs.existsSync(path.join(paths.checkRunsDir, row.id, 'out', 'results.json'))).toBe(true);
    // a second run updates the cached clone instead of cloning again
    const again = await runVerifyGate(db, task, wt, runId, 'main');
    expect(again.failure).toBeNull();
  });

  it('a command that fails is a failed step; an unreadable answer file too', async () => {
    const ds = createDataset(db, { name: 'broken', remote_url: 'http://gitea.corp:3000/aoi/broken.git' });
    createCheck(db, 'r_cfaoi', { name: '圖資', kind: 'dataset', machine: 'aoi-1', dataset_id: ds.id, command: 'run --out {out}' });
    const { task, wt, runId } = gitSetup(snapshotChecks(db, 'r_cfaoi'));
    const crashing = fakeMachines({ run: (req) => (req.command.startsWith('mkdir') ? { exitCode: 0, output: '' } : { exitCode: 2, output: 'Segmentation fault\n' }) });
    const g1 = await runVerifyGate(db, task, wt, runId, 'main', undefined, { checkDeps: { machines: crashing.m } });
    expect(g1.failure?.failedStep).toBe('圖資');
    expect(g1.results[0]!.output).toContain('Segmentation fault');
    expect(crashing.calls.some((x) => x.op === 'pullBack')).toBe(false);
    const garbled = fakeMachines({ onPullBack: (_r, localDir) => fs.writeFileSync(path.join(localDir, 'answers.json'), '{nope') });
    const g2 = await runVerifyGate(db, task, wt, runId, 'main', undefined, { checkDeps: { machines: garbled.m } });
    expect(g2.failure?.failedStep).toBe('圖資');
    expect(g2.results[0]!.output).toContain('讀不到圖資 broken 的答案檔');
  });

  it('two checks reporting the same metric are judged separately (namespaced)', async () => {
    const ds = createDataset(db, { name: 'shared', remote_url: 'http://gitea.corp:3000/aoi/shared.git' });
    const a = createCheck(db, 'r_cfaoi', { name: 'A', kind: 'dataset', machine: 'aoi-1', dataset_id: ds.id, command: 'a --out {out}', pass_rule: 'metrics', metrics: 'correct_rate >= 0.9' });
    const b = createCheck(db, 'r_cfaoi', { name: 'B', kind: 'dataset', machine: 'aoi-1', dataset_id: ds.id, command: 'b --out {out}', pass_rule: 'metrics', metrics: 'correct_rate >= 0.4' });
    const { task, wt, runId } = gitSetup(snapshotChecks(db, 'r_cfaoi'));
    let n = 0;
    const { m } = fakeMachines({
      onPullBack: (remote, localDir) => {
        if (path.posix.basename(remote[0]!) === 'answers.json') return fs.writeFileSync(path.join(localDir, 'answers.json'), ANSWERS);
        n++;
        // A gets everything right, B half
        fs.writeFileSync(path.join(localDir, 'results.json'), n === 1 ? JSON.stringify({ a: 'OK', b: 'NG', c: 'OK', d: 'NG' }) : JSON.stringify({ a: 'OK', b: 'NG' }));
      },
    });
    expect(task.acceptance_metrics).toBe(`${a.id}.correct_rate >= 0.9; ${b.id}.correct_rate >= 0.4`);
    const gate = await runVerifyGate(db, task, wt, runId, 'main', undefined, { checkDeps: { machines: m } });
    expect(gate.failure).toBeNull();
    expect(gate.metrics?.values).toMatchObject({ [`${a.id}.correct_rate`]: 1, [`${b.id}.correct_rate`]: 0.5 });
    expect(gate.metrics?.values).not.toHaveProperty('correct_rate');
  });

  it('prefixMetricLines rewrites only LOOP_METRICS lines', () => {
    const out = 'x\nLOOP_METRICS {"a":1,"ck_1.b":2}\n  LOOP_METRICS {broken\nLOOP_METRICS {"c":3}';
    expect(prefixMetricLines(out, 'ck_1.')).toBe('x\nLOOP_METRICS {"ck_1.a":1,"ck_1.b":2}\n  LOOP_METRICS {broken\nLOOP_METRICS {"ck_1.c":3}');
    expect(getCheckRun(db, 'cr_none')).toBeNull();
  });
});
