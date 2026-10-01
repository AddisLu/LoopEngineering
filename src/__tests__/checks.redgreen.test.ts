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
import { createCheck } from '../checks/store.js';
import { renderChecks, snapshotChecks, type CheckSnapshot } from '../checks/render.js';
import { checkRunsForRun } from '../checks/runs.js';
import { runCheck, type MachineRunner } from '../checks/runner.js';

/**
 * 重現 紅→綠: the repro must fail on the code before the change (with this change's test files put
 * onto it) and pass after it — so a local model cannot pass by writing a test that never failed, or
 * by "fixing" the test instead of the code.
 */

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
  db.prepare('INSERT INTO repos (id, name, remote_url, local_path) VALUES (?, ?, ?, ?)').run('r_calc', 'calc', 'http://gitea.corp:3000/aoi/calc.git', '/srv/repos/calc');
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const BUGGY = 'add() { echo $(( $1 - $2 )); }\n';
const FIXED = 'add() { echo $(( $1 + $2 )); }\n';
const STRONG = '. ./lib.sh\nr=$(add 2 3)\n[ "$r" = 5 ] || { echo "add 2 3 = $r"; exit 1; }\necho "add ok"\n';
const WEAK = '. ./lib.sh\nadd 5 0 >/dev/null\necho "add ok"\n';

/** main has `base`; the task branch loop/<id> gets `change` on top. Returns the repo (it is the worktree). */
function repoWith(base: Record<string, string>, change: Record<string, string>, repro: { command: string; test_globs?: string; machine?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-redgreen-'));
  tmp.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'loop@test.local']);
  git(dir, ['config', 'user.name', 'Loop Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  const baseSha = commit(dir, base, 'base');
  createCheck(db, 'r_calc', { name: '重現', kind: 'repro', command: repro.command, test_globs: repro.test_globs ?? 'tests/**', machine: repro.machine ?? null });
  const snap = snapshotChecks(db, 'r_calc');
  const task = taskFor(snap, dir);
  git(dir, ['checkout', '-q', '-b', `loop/${task.id}`]);
  const headSha = commit(dir, change, 'change');
  const run = createRun(db, { task_id: task.id, worktree_path: dir, branch: `loop/${task.id}` });
  return { dir, task, runId: run.id, baseSha, headSha, snap };
}

function taskFor(snap: CheckSnapshot[], repo: string): Task {
  const r = renderChecks(snap);
  const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: r.verification_steps, verify_mode: r.verify_mode, repo_path: repo, base_branch: 'main' });
  db.prepare('UPDATE tasks SET checks_json = ?, repo_id = ? WHERE id = ?').run(JSON.stringify(snap), 'r_calc', t.id);
  return getTask(db, t.id)!;
}

const leftovers = () => (fs.existsSync(paths.worktreesDir) ? fs.readdirSync(paths.worktreesDir).filter((n) => n.startsWith('redgreen_')) : []);

describe('重現 紅→綠', () => {
  it('red on base with the new test carried over, green on HEAD → pass; the scratch tree is removed', async () => {
    const { dir, task, runId, baseSha } = repoWith({ 'lib.sh': BUGGY }, { 'lib.sh': FIXED, 'tests/test_add.sh': STRONG }, { command: 'bash tests/test_add.sh' });
    const before = leftovers();
    expect(await runVerifyPipeline(db, task, dir, runId, 'main')).toBe('pass');
    const [row] = checkRunsForRun(db, runId);
    expect(row!.ok).toBe(1);
    expect(row!.base_sha).toBe(baseSha);
    expect(row!.output_tail).toContain('修改前：✗ exit 1 · 修改後：✓ exit 0');
    expect(row!.output_tail).toContain('add 2 3 = -1'); // the base really ran the new test on the old code
    expect(row!.output_tail).toContain('套上這次的測試檔：tests/test_add.sh');
    expect(JSON.parse(row!.result_json!)).toMatchObject({
      mode: 'red_green',
      before: { exitCode: 1, ok: false },
      after: { exitCode: 0, ok: true },
      carried: ['tests/test_add.sh'],
    });
    expect(JSON.parse(getRun(db, runId)!.verify_json!)[0]).toMatchObject({ step: '重現', ok: true });
    expect(leftovers()).toEqual(before);
    expect(git(dir, ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('green on base → fail: the repro proves nothing', async () => {
    const { dir, task, runId } = repoWith({ 'lib.sh': BUGGY, 'tests/test_old.sh': WEAK }, { 'lib.sh': FIXED }, { command: 'bash tests/test_old.sh' });
    expect(await runVerifyPipeline(db, task, dir, runId, 'main')).toBe('fail');
    const [row] = checkRunsForRun(db, runId);
    expect(row!.ok).toBe(0);
    expect(row!.exit_code).toBeNull();
    expect(row!.output_tail).toContain('修改前：✓ exit 0 · 修改後：✓ exit 0');
    expect(row!.output_tail).toContain('修改前就通過了');
    const detail = (db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'status' ORDER BY id DESC LIMIT 1").get(task.id) as { detail: string }).detail;
    expect(detail).toContain('verify failed at: 重現');
    expect(detail).toContain('修改前就通過了');
  });

  it('weakening a test that failed before is caught: the changed test is carried onto base too', async () => {
    const { dir, task, runId } = repoWith({ 'lib.sh': BUGGY, 'tests/test_add.sh': STRONG }, { 'tests/test_add.sh': WEAK }, { command: 'bash tests/test_add.sh' });
    const gate = await runVerifyGate(db, task, dir, runId, 'main');
    expect(gate.failure?.failedStep).toBe('重現');
    expect(gate.results[0]!.output).toContain('修改前就通過了');
  });

  it('still red after the change → fail with 修改後還是沒通過', async () => {
    const { dir, task, runId } = repoWith({ 'lib.sh': BUGGY }, { 'tests/test_add.sh': STRONG }, { command: 'bash tests/test_add.sh' });
    const gate = await runVerifyGate(db, task, dir, runId, 'main');
    expect(gate.failure?.failedStep).toBe('重現');
    expect(gate.results[0]!.output).toContain('修改前：✗ exit 1 · 修改後：✗ exit 1');
    expect(gate.results[0]!.output).toContain('修改後還是沒通過');
    expect(gate.results[0]!.exitCode).toBe(1);
  });

  it('re-verifying work already merged into base uses the before the run recorded', async () => {
    const { dir, task, runId, baseSha } = repoWith({ 'lib.sh': BUGGY }, { 'lib.sh': FIXED, 'tests/test_add.sh': STRONG }, { command: 'bash tests/test_add.sh' });
    expect(await runVerifyPipeline(db, task, dir, runId, 'main')).toBe('pass');
    expect(getRun(db, runId)!.base_sha).toBe(baseSha);
    git(dir, ['branch', '-f', 'main', 'HEAD']); // merged: HEAD is now its own merge-base with main
    const again = await runVerifyGate(db, getTask(db, task.id)!, dir, runId, 'main');
    expect(again.failure).toBeNull();
    expect(checkRunsForRun(db, runId).map((r) => [r.kind, r.base_sha])).toEqual([
      ['verify', baseSha],
      ['reverify', baseSha],
    ]);
  });

  it('on a 機台: the before tree (with the carried test) is sent as files, then HEAD is checked out; both run there', async () => {
    const { dir, task, runId, baseSha, headSha } = repoWith({ 'lib.sh': BUGGY }, { 'lib.sh': FIXED, 'tests/test_add.sh': STRONG }, { command: 'bash tests/test_add.sh', machine: 'aoi-1' });
    const calls: Array<Record<string, unknown>> = [];
    let baseTree: Record<string, string> = {};
    const m: MachineRunner = {
      osOf: () => 'linux',
      async checkout(machine, req) {
        calls.push({ op: 'checkout', machine, repoName: req.repoName, remoteUrl: req.remoteUrl, sha: req.sha, branch: req.branch });
        if (req.repoName.endsWith('-base')) {
          baseTree = { lib: fs.readFileSync(path.join(req.localTree, 'lib.sh'), 'utf8'), test: fs.readFileSync(path.join(req.localTree, 'tests/test_add.sh'), 'utf8') };
        }
        return { ok: true, out: '', dir: `/srv/loop/${req.repoName}` };
      },
      async run(machine, req) {
        calls.push({ op: 'run', machine, cwd: req.cwd });
        const base = req.cwd.endsWith('-base');
        return { ok: !base, exitCode: base ? 1 : 0, timedOut: false, output: base ? 'add 2 3 = -1\n' : 'add ok\n', ms: 10 };
      },
      dataset: async () => ({ ok: false, out: 'unused', dir: '' }),
      pullBack: async () => ({ ok: false, out: 'unused' }),
      async lock(machine, fn) {
        calls.push({ op: 'lock', machine });
        return fn();
      },
    };
    const gate = await runVerifyGate(db, task, dir, runId, 'main', undefined, { checkDeps: { machines: m } });
    expect(gate.failure).toBeNull();
    expect(calls).toEqual([
      { op: 'lock', machine: 'aoi-1' },
      { op: 'checkout', machine: 'aoi-1', repoName: 'calc-base', remoteUrl: null, sha: baseSha, branch: 'main' },
      { op: 'run', machine: 'aoi-1', cwd: '/srv/loop/calc-base' },
      { op: 'checkout', machine: 'aoi-1', repoName: 'calc', remoteUrl: null, sha: headSha, branch: `loop/${task.id}` },
      { op: 'run', machine: 'aoi-1', cwd: '/srv/loop/calc' },
    ]);
    expect(baseTree).toEqual({ lib: BUGGY, test: STRONG }); // old code, new test
    expect(gate.results[0]!.output).toContain('修改前：✗ exit 1 · 修改後：✓ exit 0');
  });

  it('a 試跑 (no redGreen) just runs the repro command once', async () => {
    const { dir, snap } = repoWith({ 'lib.sh': BUGGY }, { 'lib.sh': FIXED, 'tests/test_add.sh': STRONG }, { command: 'bash tests/test_add.sh' });
    const out = await runCheck(db, snap[0]!, { cwd: dir, timeoutMs: 60_000, kind: 'trial', record: true, taskId: null, runId: null, base: 'main', branch: null, redGreen: false });
    expect(out.result).toMatchObject({ step: '重現', ok: true, exitCode: 0 });
    expect(out.result.output).not.toContain('修改前');
  });
});
