import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { logEvent, openTestDb, setSetting } from '../db/index.js';
import { createRun, createTask, getTask, setStatus, updateRun, latestRun } from '../tasks.js';
import { addWorktree } from '../git/worktree.js';
import { createPlan } from '../plans/store.js';
import { setCachedUsage } from '../token/usage.js';
import { BenchmarkInputError, benchmarkMatrix, benchmarkRecommendations, createBenchmark, getBenchmark } from '../benchmark/store.js';
import { armIterations, measureArm } from '../benchmark/attempts.js';
import { judgeBenchmark } from '../benchmark/complete.js';
import { benchmarkReport } from '../benchmark/report.js';
import { buildApp } from '../server/app.js';

/**
 * Benchmarks held to a measured bar: a 驗證方案 gives every arm the same steps, thresholds and
 * yardstick; each arm's attempts say how it got there (first try, sent back, profiled); the final
 * code of every arm is measured again, one at a time, and an arm that misses the bar never ranks
 * above one that met it. Hermetic: temp git repos, host-shell steps, injected judges.
 */

let db: Database.Database;
let app: FastifyInstance | undefined;
let tmp: string[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const mk = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-benchm-${tag}-`));
  tmp.push(d);
  return d;
};

/** a repo whose `bash bench.sh` reports the kernel time kept in ms.txt (20 ms on main) */
function benchRepo(): string {
  const repo = mk('repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'bench.sh'), 'echo "LOOP_METRICS {\\"correct\\":1,\\"max_ms\\":$(cat ms.txt)}"\n');
  fs.writeFileSync(path.join(repo, 'ms.txt'), '20\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

/** an arm that finished: its branch/worktree with `ms` in ms.txt, one run per recorded attempt */
function finishArm(taskId: string, repo: string, ms: number, attempts: Array<{ ok: boolean; max_ms?: number; sandbox?: string[] }>, status: 'review' | 'attention') {
  git(repo, 'branch', `loop/${taskId}`, 'main');
  const wt = addWorktree(repo, `loop/${taskId}`, 'main').path;
  fs.writeFileSync(path.join(wt, 'ms.txt'), `${ms}\n`);
  git(wt, 'config', 'user.email', 't@t');
  git(wt, 'config', 'user.name', 't');
  git(wt, 'commit', '-qam', `kernel at ${ms} ms`);
  attempts.forEach((a, i) => {
    const run = createRun(db, { task_id: taskId, worktree_path: wt, branch: `loop/${taskId}` });
    db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(`2026-09-29 10:0${i}:00`, run.id);
    const checks = a.max_ms == null ? [] : [{ name: 'max_ms', op: '<=', target: 10, actual: a.max_ms, pass: a.max_ms <= 10 }];
    updateRun(db, run.id, {
      verify_json: JSON.stringify([{ step: 'bash bench.sh', ok: a.ok, exitCode: a.ok ? 0 : 1, timedOut: false, tail: '' }]),
      metrics_json: a.max_ms == null ? null : JSON.stringify({ values: { correct: 1, max_ms: a.max_ms }, checks, pass: checks.every((c) => c.pass) }),
    });
    for (const cmd of a.sandbox ?? []) logEvent(db, { task_id: taskId, run_id: run.id, kind: 'note', detail: `沙盒：${cmd} → exit 0 · 3 s` });
  });
  setStatus(db, taskId, status, { detail: status === 'review' ? 'verification passed' : 'verify failed at: 驗收指標' });
  return wt;
}

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  setSetting(db, 'benchmark_enabled', 'true');
  app = undefined;
  tmp = [];
});
afterEach(async () => {
  await app?.close();
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe('a benchmark from a 驗證方案', () => {
  it('gives every arm the plan\'s steps (aimed at its machine), thresholds, yardstick, artifacts and time limits', () => {
    const repo = benchRepo();
    const plan = createPlan(db, {
      name: 'CCL 10 ms',
      repo_path: repo,
      host: 'local',
      steps: ['bash bench.sh'],
      metrics: 'correct == 1; max_ms <= 10',
      protected_paths: ['bench.sh'],
      artifacts: ['build/*.ncu-rep'],
      domain: 'cuda',
    });
    const { benchmark, arms } = createBenchmark(db, {
      title: 'ccl',
      goal: 'every mask under 10 ms',
      plan_ref: 'https://example.com/ccl.md',
      verification_steps: [],
      verify_plan_id: plan.id,
      models: ['local:qwen38-flash', 'sonnet'],
      coding_tool: 'mock',
      verify_timeout_min: 20,
      timeout_min: 180,
    });
    expect(benchmark).toMatchObject({
      repo_path: repo,
      domain: 'cuda',
      acceptance_metrics: 'correct == 1; max_ms <= 10',
      protected_paths: 'bench.sh',
      artifacts: 'build/*.ncu-rep',
      verify_plan_id: plan.id,
      verify_timeout_min: 20,
      timeout_min: 180,
    });
    expect(JSON.parse(benchmark.verification_steps)).toEqual(['sandbox: bash bench.sh']);
    for (const a of arms) {
      expect(getTask(db, a.task_id)).toMatchObject({
        acceptance_metrics: 'correct == 1; max_ms <= 10',
        protected_paths: 'bench.sh',
        artifacts: 'build/*.ncu-rep',
        verify_plan_id: plan.id,
        verify_timeout_min: 20,
        timeout_min: 180,
        repo_path: repo,
      });
    }
  });

  it('refuses thresholds it could never check and time limits out of range', () => {
    const repo = benchRepo();
    const base = { title: 't', goal: 'g', plan_ref: 'https://example.com/p.md', repo_path: repo, base_branch: 'main', verification_steps: ['bash bench.sh'], models: ['local:qwen38-flash', 'sonnet'], coding_tool: 'mock' as const };
    expect(() => createBenchmark(db, { ...base, acceptance_metrics: 'fast enough' })).toThrow(BenchmarkInputError);
    expect(() => createBenchmark(db, { ...base, timeout_min: 0 })).toThrow(/1 到 1440/);
    expect(() => createBenchmark(db, { ...base, verify_plan_id: 'vp_nope' })).toThrow(/找不到驗證方案/);
  });
});

describe('how an arm got there', () => {
  const task = () => createTask(db, { title: 'arm', goal: 'g', plan_ref: 'https://example.com/p.md', verification_steps: ['bash bench.sh'], complexity: 'S' });

  it('right on the first try, without profiling', () => {
    const t = task();
    const run = createRun(db, { task_id: t.id });
    updateRun(db, run.id, { verify_json: JSON.stringify([{ step: 'bash bench.sh', ok: true, exitCode: 0, timedOut: false, tail: '' }]) });
    const it = armIterations(db, t.id);
    expect(it).toMatchObject({ passed_at: 1, first_try: true, tuned: false, self_runs: 0, profiler: false });
    expect(it.label).toBe('第 1 次就通過（沒自己試跑、沒用 ncu）');
  });

  it('wrong, then right but slow, then fast after profiling its own kernel', () => {
    const repo = benchRepo();
    const t = task();
    finishArm(
      t.id,
      repo,
      7,
      [
        { ok: false, sandbox: ['bash bench.sh'] },
        { ok: true, max_ms: 14, sandbox: ['/usr/local/cuda/bin/ncu --set full ./build/ccl_bench --mask noise --profile'] },
        { ok: true, max_ms: 7 },
      ],
      'review',
    );
    const it = armIterations(db, t.id);
    expect(it.attempts.map((a) => a.outcome)).toEqual(['functional', 'metrics', 'pass']);
    expect(it).toMatchObject({ passed_at: 3, first_try: false, tuned: true, self_runs: 2, profiler: true });
    expect(it.attempts[1]).toMatchObject({ metrics: { max_ms: 14 }, profiler: true });
    expect(it.label).toBe('第 3 次才通過（先對功能、再調效能；自己試跑 2 次、用過 ncu）');
  });
});

describe('the final re-measurement and the ranking', () => {
  function measuredBenchmark() {
    const repo = benchRepo();
    const { benchmark } = createBenchmark(db, {
      title: 'kernel budget',
      goal: 'max_ms <= 10',
      plan_ref: 'https://example.com/p.md',
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['bash bench.sh'],
      acceptance_metrics: 'correct == 1; max_ms <= 10',
      domain: 'cuda',
      models: ['local:qwen38-flash', 'sonnet'],
      coding_tool: 'mock',
    });
    const arms = getBenchmark(db, benchmark.id)!.arms;
    const local = arms.find((a) => a.model === 'local:qwen38-flash')!;
    const cloud = arms.find((a) => a.model === 'sonnet')!;
    // the local arm never got under the budget; the cloud arm did on its second attempt
    finishArm(local.task_id, repo, 12, [{ ok: true, max_ms: 30 }, { ok: true, max_ms: 12 }], 'attention');
    finishArm(cloud.task_id, repo, 6, [{ ok: true, max_ms: 11, sandbox: ['ncu --metrics gpu__time_duration.sum ./k'] }, { ok: true, max_ms: 6 }], 'review');
    return { benchmark, repo, local, cloud };
  }
  // the judge likes the local arm's code better (A = the local arm, B = the cloud arm)
  const prompts: string[] = [];
  const judge = async (prompt: string) => {
    prompts.push(prompt);
    const s = (v: number) => ({ correctness: v, completeness: v, code_quality: v, adherence: v });
    return JSON.stringify({ arms: [{ arm: 'A', scores: s(9), notes: 'tidy' }, { arm: 'B', scores: s(7), notes: 'ok' }], winner: 'A', summary: 'A reads better.' });
  };

  it('measures every arm again, and an arm that misses the bar never outranks one that meets it', async () => {
    prompts.length = 0;
    const { benchmark, local, cloud } = measuredBenchmark();
    const before = latestRun(db, local.task_id)!.metrics_json;

    const judged = await judgeBenchmark(db, benchmark.id, judge);

    expect(judged).toMatchObject({ status: 'judged', winner: 'sonnet' });
    const arms = getBenchmark(db, benchmark.id)!.arms;
    const byModel = (m: string) => arms.find((a) => a.model === m)!;
    expect(byModel('sonnet')).toMatchObject({ judge_rank: 1, verify_outcome: 'pass' });
    expect(byModel('local:qwen38-flash')).toMatchObject({ judge_rank: 2, verify_outcome: 'fail' });
    expect(JSON.parse(byModel('local:qwen38-flash').final_json!)).toMatchObject({ outcome: 'metrics', metrics: { max_ms: 12 } });
    expect(JSON.parse(byModel('sonnet').final_json!)).toMatchObject({ outcome: 'pass', metrics: { max_ms: 6 } });
    expect(JSON.parse(byModel('sonnet').attempts_json!)).toMatchObject({ passed_at: 2, tuned: true, profiler: true });
    // the re-measurement leaves every attempt's own record as it was
    expect(latestRun(db, local.task_id)!.metrics_json).toBe(before);
    // the judge saw the bar and what was measured
    expect(prompts[0]).toContain('Engine-checked thresholds');
    expect(prompts[0]).toContain('correct == 1; max_ms <= 10');
    expect(prompts[0]).toMatch(/Final re-measurement[^\n]*FAILED[^\n]*max_ms=12/);
    expect(prompts[0]).toContain('used a profiler (ncu/nsys): yes');
    expect(getTask(db, cloud.task_id)!.status).toBe('closed');
  });

  it('judging again after the arms were closed keeps what they did (a failed arm stays failed, its diff stays)', async () => {
    const { benchmark } = measuredBenchmark();
    await judgeBenchmark(db, benchmark.id, judge);
    const first = JSON.parse(getBenchmark(db, benchmark.id)!.benchmark.result_json!).evidence;

    await judgeBenchmark(db, benchmark.id, judge);

    const d = getBenchmark(db, benchmark.id)!;
    expect(d.arms.find((a) => a.model === 'local:qwen38-flash')).toMatchObject({ verify_outcome: 'fail', judge_rank: 2 });
    const again = JSON.parse(d.benchmark.result_json!).evidence;
    for (const e of again) {
      const was = first.find((f: { model: string }) => f.model === e.model);
      expect(e.diff).toBe(was.diff);
      expect(e.diff).toContain('ms.txt');
    }
  });

  it('writes a report: the verdict, the bar per arm, how each got there, and the standings on this kind of work', async () => {
    const { benchmark } = measuredBenchmark();
    await judgeBenchmark(db, benchmark.id, judge);
    const md = benchmarkReport(db, benchmark.id)!;
    expect(md).toContain('# 評比報告：kernel budget');
    expect(md).toContain('勝出：**sonnet**');
    expect(md).toContain('通過門檻：1／2 組');
    expect(md).toMatch(/\| 名次 \| 模型 \| 最終量測 \| correct \| max_ms \| 迭代 \|/);
    expect(md).toContain('第 2 次才通過（先對功能、再調效能；自己試跑 1 次、用過 ncu）');
    expect(md).toContain('2 次都沒通過');
    expect(md).toContain('CUDA／GPU 類工作的累積戰績');
    expect(md).toContain('## 量測方式');

    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: `/api/benchmarks/${benchmark.id}/report.md` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain(`benchmark-${benchmark.id}.md`);
    expect(res.body).toBe(md);
    expect((await app.inject({ method: 'GET', url: '/api/benchmarks/b_nope/report.md' })).statusCode).toBe(404);
  });

  it('measures nothing when the arm left no worktree', async () => {
    const t = createTask(db, { title: 'x', goal: 'g', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], complexity: 'S' });
    createRun(db, { task_id: t.id, worktree_path: '/definitely/gone' });
    expect(await measureArm(db, t.id)).toBeNull();
  });
});

describe('which model fits which kind of software', () => {
  /** judged benchmarks written straight into the tables: [domain, model, passed, attempts_json] */
  function history(rows: Array<[string, string, boolean, number | null]>) {
    rows.forEach(([domain, model, passed, passedAt], i) => {
      const id = `b_h${i}`;
      db.prepare("INSERT INTO benchmarks (id, title, goal, domain, status, winner) VALUES (?, 't', 'g', ?, 'judged', ?)").run(id, domain, passed ? model : null);
      const attempts = passedAt === null ? null : JSON.stringify({ attempts: [], passed_at: passed ? passedAt : null, first_try: passed && passedAt === 1, profiler: passedAt === 2, tuned: false, self_runs: 1, label: '' });
      db.prepare('INSERT INTO benchmark_arms (benchmark_id, model, task_id, verify_outcome, judge_score, judge_rank, attempts_json) VALUES (?, ?, ?, ?, ?, 1, ?)').run(
        id,
        model,
        `t_h${i}`,
        passed ? 'pass' : 'fail',
        passed ? 8 : 3,
        attempts,
      );
    });
  }

  it('filters by software type, local or cloud, sample size and pass rate, and reports first-try rates', () => {
    history([
      ['cuda', 'local:qwen3-coder-next', true, 1],
      ['cuda', 'local:qwen3-coder-next', true, 2],
      ['cuda', 'local:qwen38-flash', false, 3],
      ['cuda', 'sonnet', true, 1],
      ['python', 'local:qwen38-flash', true, 1],
    ]);
    const cudaLocal = benchmarkMatrix(db, { domain: 'cuda', kind: 'local' });
    expect(cudaLocal.map((r) => r.model)).toEqual(['local:qwen3-coder-next', 'local:qwen38-flash']);
    expect(cudaLocal[0]).toMatchObject({ n: 2, verify_pass_rate: 1, first_try_rate: 0.5, avg_passed_at: 1.5, profiler_rate: 0.5, win_rate: 1, local: true, tracked: 2 });
    expect(benchmarkMatrix(db, { kind: 'cloud' }).map((r) => r.model)).toEqual(['sonnet']);
    expect(benchmarkMatrix(db, { min_pass: 0.8 }).every((r) => r.verify_pass_rate >= 0.8)).toBe(true);
    expect(benchmarkMatrix(db, { min_n: 2 }).map((r) => r.model)).toEqual(['local:qwen3-coder-next']);
  });

  it('recommends a local model per kind of software, next to the cloud reference', async () => {
    history([
      ['cuda', 'local:qwen3-coder-next', true, 1],
      ['cuda', 'local:qwen38-flash', false, 3],
      ['cuda', 'sonnet', true, 1],
      ['python', 'local:qwen38-flash', false, 3],
      ['python', 'sonnet', true, 1],
    ]);
    const recs = benchmarkRecommendations(db);
    const cuda = recs.find((r) => r.domain === 'cuda')!;
    expect(cuda.local?.model).toBe('local:qwen3-coder-next');
    expect(cuda.cloud?.model).toBe('sonnet');
    expect(cuda.verdict).toContain('可以交給 Qwen3 Coder Next');
    expect(cuda.verdict).toContain('僅供參考');
    expect(recs.find((r) => r.domain === 'python')!.verdict).toContain('本地模型還做不來');

    app = buildApp({ db, apiToken: null });
    const m = (await app.inject({ method: 'GET', url: '/api/benchmarks/matrix?domain=cuda&kind=local&min_pass=0.5' })).json().matrix;
    expect(m.map((r: { model: string }) => r.model)).toEqual(['local:qwen3-coder-next']);
    expect((await app.inject({ method: 'GET', url: '/api/benchmarks/recommend' })).json().recommendations).toHaveLength(2);
  });
});
