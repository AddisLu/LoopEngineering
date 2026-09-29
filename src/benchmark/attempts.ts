import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getTask, latestRun } from '../tasks.js';
import { runVerifyGate } from '../orchestrator/run.js';
import { readMetrics, readVerify, type VerifiedStep } from '../orchestrator/runSummary.js';
import type { MetricCheck, MetricsReport } from '../orchestrator/acceptance.js';
import type { SandboxDeps } from '../exec/sandbox.js';
import type { Task, TaskRun } from '../types.js';

/**
 * What a benchmark arm's verification found, attempt by attempt, and the final re-measurement the
 * ranking goes by. The question it answers is how a model got there: right on the first try, right
 * only after the engine sent it back (and whether it was the function or the thresholds that
 * failed), whether it profiled its own code, or never.
 */

/** pass; a step failed (build / wrong answer); only the 驗收指標 missed; it changed the yardstick; no verification ran */
export type AttemptOutcome = 'pass' | 'functional' | 'metrics' | 'protected' | 'unverified';

export interface AttemptRecord {
  attempt: number;
  run_id: string;
  outcome: AttemptOutcome;
  /** the step that failed (functional / protected) */
  failed_step: string | null;
  /** everything LOOP_METRICS reported, and each threshold's verdict */
  metrics: Record<string, number | string> | null;
  checks: MetricCheck[] | null;
  /** how the run ended when it never reached verification (timeout, interrupted, …) */
  note: string | null;
  /** GPU 沙盒 runs the agent made itself during this attempt */
  self_runs: number;
  /** one of them ran a profiler (ncu / nsys) */
  profiler: boolean;
  /** when the attempt ran (ISO / sqlite UTC as stored); finished_at is null while it runs */
  started_at: string | null;
  finished_at: string | null;
  duration_s: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /** its verification steps, with the time each took when that was recorded */
  steps: VerifiedStep[];
}

export interface IterationSummary {
  attempts: AttemptRecord[];
  /** the first attempt whose verification passed (1-based); null when none did */
  passed_at: number | null;
  first_try: boolean;
  /** an attempt had the function right but missed the thresholds: speed came second */
  tuned: boolean;
  self_runs: number;
  profiler: boolean;
  /** one line for the tables */
  label: string;
}

/** The final code of every arm measured again, one arm at a time, when the benchmark is judged. */
export interface FinalMeasurement {
  outcome: Exclude<AttemptOutcome, 'unverified'>;
  failed_step: string | null;
  metrics: Record<string, number | string> | null;
  checks: MetricCheck[] | null;
  steps: Array<{ step: string; ok: boolean; exitCode: number | null; timedOut: boolean; tail: string; ms?: number }>;
  measured_at: string;
}

const PROFILER = /(^|[\s/;&|(])(ncu|nsys)(\s|$)/;

function classify(steps: Array<{ step: string; ok: boolean }>, metrics: MetricsReport | null): { outcome: AttemptOutcome; failed: string | null } {
  const bad = steps.find((s) => !s.ok);
  if (bad) return { outcome: bad.step === '保護路徑' ? 'protected' : 'functional', failed: bad.step };
  if (metrics && !metrics.pass) return { outcome: 'metrics', failed: null };
  return { outcome: 'pass', failed: null };
}

function sandboxRuns(db: Database.Database, runId: string): { n: number; profiler: boolean } {
  const rows = db
    .prepare("SELECT detail FROM task_events WHERE run_id = ? AND kind = 'note' AND detail LIKE '沙盒：%'")
    .all(runId) as Array<{ detail: string }>;
  const profiler = rows.some((r) => PROFILER.test(r.detail.slice(3).split(' → ')[0] ?? ''));
  return { n: rows.length, profiler };
}

/** why a run never reached verification, in the words the pages use */
export function humanNote(detail: string): string {
  const d = detail.trim();
  if (/^aborted (by user|via api)/i.test(d)) return '被中止';
  if (/^watchdog timeout/i.test(d)) return '逾時';
  if (/^setup_cmd failed/i.test(d)) return `準備環境失敗（${d.replace(/^setup_cmd failed\s*/i, '').slice(0, 80)}）`;
  const intr = /^interrupted: (\w+)/i.exec(d);
  if (intr) return intr[1] === 'user' ? '被中止' : `被中斷（${intr[1] === 'breaker' ? '額度保護' : intr[1] === 'window' ? '時段' : intr[1] === 'pause' ? '暫停排程' : intr[1]}）`;
  if (/^resume limit/i.test(d)) return '續跑次數用完';
  if (/^exit=/i.test(d)) return `執行出錯（${d.slice(0, 80)}）`;
  return d;
}

function lastStatus(db: Database.Database, runId: string): string | null {
  const row = db
    .prepare("SELECT detail FROM task_events WHERE run_id = ? AND kind = 'status' AND detail IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(runId) as { detail: string } | undefined;
  return row?.detail ? humanNote(row.detail.split('\n')[0]!).slice(0, 200) : null;
}

/** sqlite writes "YYYY-MM-DD HH:MM:SS" (UTC); finishRun writes ISO */
function tsMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

const num = (v: number | string | null | undefined) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v ?? '—'));

/** "max_ms 27.7（要 <= 10）" for each threshold that missed */
export function missedChecks(checks: MetricCheck[] | null): string {
  return (checks ?? [])
    .filter((c) => !c.pass)
    .map((c) => `${c.name} ${c.actual == null ? '沒有回報' : num(c.actual)}（要 ${c.op} ${c.target}）`)
    .join('、');
}

export function describeAttempt(a: Pick<AttemptRecord, 'outcome' | 'failed_step' | 'checks' | 'note'>): string {
  switch (a.outcome) {
    case 'pass':
      return '通過';
    case 'functional':
      return `功能沒過（${a.failed_step ?? '驗證步驟'}）`;
    case 'metrics':
      return `功能正確但指標未達：${missedChecks(a.checks) || '門檻沒過'}`;
    case 'protected':
      return '改了不能動的量尺（保護路徑）';
    default:
      return `沒跑到驗證${a.note ? `：${a.note}` : ''}`;
  }
}

function label(s: Omit<IterationSummary, 'label'>): string {
  if (!s.attempts.length) return '沒有執行紀錄';
  const tools = [s.self_runs ? `自己試跑 ${s.self_runs} 次` : '沒自己試跑', s.profiler ? '用過 ncu' : '沒用 ncu'].join('、');
  if (s.passed_at === 1) return `第 1 次就通過（${tools}）`;
  if (s.passed_at) {
    const why = s.tuned ? '先對功能、再調效能' : '先前功能沒過';
    return `第 ${s.passed_at} 次才通過（${why}；${tools}）`;
  }
  return `${s.attempts.length} 次都沒通過（最後：${describeAttempt(s.attempts[s.attempts.length - 1]!)}；${tools}）`;
}

/** Every attempt of one arm task, oldest first, with what its verification and the agent did. */
export function armIterations(db: Database.Database, taskId: string): IterationSummary {
  // oldest first; rowid breaks a tie between runs started within the same second
  const runs = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at, rowid').all(taskId) as TaskRun[];
  const attempts: AttemptRecord[] = runs.map((run, i) => {
    const steps = readVerify(run);
    const metrics = readMetrics(run);
    const verified = run.verify_json != null;
    const c = verified ? classify(steps, metrics) : { outcome: 'unverified' as const, failed: null };
    const sb = sandboxRuns(db, run.id);
    const start = tsMs(run.started_at);
    const end = tsMs(run.finished_at);
    return {
      attempt: i + 1,
      run_id: run.id,
      outcome: c.outcome,
      failed_step: c.failed,
      metrics: metrics?.values ?? null,
      checks: metrics?.checks ?? null,
      note: verified ? null : lastStatus(db, run.id),
      self_runs: sb.n,
      profiler: sb.profiler,
      started_at: run.started_at ?? null,
      finished_at: run.finished_at ?? null,
      duration_s: start != null && end != null ? Math.max(0, Math.round((end - start) / 1000)) : null,
      tokens_in: run.tokens_in ?? null,
      tokens_out: run.tokens_out ?? null,
      steps,
    };
  });
  const passIdx = attempts.findIndex((a) => a.outcome === 'pass');
  const passedAt = passIdx >= 0 ? passIdx + 1 : null;
  const upTo = passedAt ? attempts.slice(0, passedAt) : attempts;
  const summary = {
    attempts,
    passed_at: passedAt,
    first_try: passedAt === 1,
    tuned: upTo.some((a) => a.outcome === 'metrics'),
    self_runs: attempts.reduce((s, a) => s + a.self_runs, 0),
    profiler: attempts.some((a) => a.profiler),
  };
  return { ...summary, label: label(summary) };
}

/**
 * Measure an arm's final code again with the benchmark's own verification, without touching the
 * arm's recorded attempts. The judge step runs this for every arm in turn, after all of them have
 * finished, so no arm is timed while another one compiles or a local model generates on the same
 * GPU. Null when the arm left no worktree to measure.
 */
export async function measureArm(db: Database.Database, taskId: string, sandboxDeps?: SandboxDeps): Promise<FinalMeasurement | null> {
  const task = getTask(db, taskId);
  const run = task ? latestRun(db, taskId) : undefined;
  if (!task || !run?.worktree_path || !fs.existsSync(run.worktree_path)) return null;
  const gate = await runVerifyGate(db, task, run.worktree_path, run.id, task.base_branch, sandboxDeps, { record: false });
  if (!gate.ran && !gate.failure) return null; // nothing measurable here (no command steps / capability missing)
  const steps = gate.results.map((r) => ({ step: r.step, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, tail: r.output.replace(/\s+$/, '').slice(-600), ...(r.ms != null ? { ms: r.ms } : {}) }));
  const c = classify(steps, gate.metrics);
  return {
    outcome: c.outcome === 'unverified' ? 'functional' : c.outcome,
    failed_step: c.failed,
    metrics: gate.metrics?.values ?? null,
    checks: gate.metrics?.checks ?? null,
    steps,
    measured_at: new Date().toISOString(),
  };
}

/** The code every arm started from, measured with the same verification as the arms. */
export interface BaselineMeasurement extends FinalMeasurement {
  /** the commit that was measured: the base the arms recorded */
  base_sha: string;
}

export type GitExec = (args: string[]) => void;
const realGitExec: GitExec = (args) => {
  execFileSync('git', args, { stdio: 'ignore', timeout: 60_000 });
};

/**
 * Measure where the arms started: the base commit an arm recorded, checked out on its own (a
 * detached worktree under the data dir, removed afterwards) and verified once exactly like the
 * arms. It is what "N× faster than before" is measured against, and it tells an arm that made
 * the code faster apart from a task that was already within the bar. Null when no arm recorded
 * its base, or the repo will not check it out; the benchmark then simply has no baseline.
 */
export async function measureBaseline(
  db: Database.Database,
  taskIds: string[],
  sandboxDeps?: SandboxDeps,
  git: GitExec = realGitExec,
): Promise<BaselineMeasurement | null> {
  let task: Task | undefined;
  let run: TaskRun | undefined;
  for (const id of taskIds) {
    const t = getTask(db, id);
    if (!t?.repo_path) continue;
    const r = db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? AND base_sha IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(id) as TaskRun | undefined;
    if (r?.base_sha) {
      task = t;
      run = r;
      break;
    }
  }
  if (!task?.repo_path || !run?.base_sha) return null;
  const sha = run.base_sha;
  const dir = path.join(paths.worktreesDir, `baseline_${task.benchmark_id ?? task.id}_${Date.now().toString(36)}`);
  try {
    git(['-C', task.repo_path, 'worktree', 'add', '--detach', dir, sha]);
  } catch {
    return null;
  }
  try {
    const gate = await runVerifyGate(db, task, dir, run.id, task.base_branch, sandboxDeps, { record: false });
    if (!gate.ran && !gate.failure) return null;
    const steps = gate.results.map((r) => ({ step: r.step, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, tail: r.output.replace(/\s+$/, '').slice(-600), ...(r.ms != null ? { ms: r.ms } : {}) }));
    const c = classify(steps, gate.metrics);
    return {
      outcome: c.outcome === 'unverified' ? 'functional' : c.outcome,
      failed_step: c.failed,
      metrics: gate.metrics?.values ?? null,
      checks: gate.metrics?.checks ?? null,
      steps,
      measured_at: new Date().toISOString(),
      base_sha: sha,
    };
  } finally {
    try {
      git(['-C', task.repo_path, 'worktree', 'remove', '--force', dir]);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        git(['-C', task.repo_path, 'worktree', 'prune']);
      } catch {
        /* a stale worktree entry is harmless; git prunes it later */
      }
    }
  }
}
