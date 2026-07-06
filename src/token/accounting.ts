import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import type { Complexity } from '../config.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { readUsage } from './usage.js';

const MIN_SAMPLES = 5;

/**
 * Measured %-point cost of the last completed runs for a complexity, from a
 * before/after column pair (session or weekly).
 * (max_concurrency = 1 makes before/after deltas clean and additive; with
 * concurrency > 1 they are approximate, which is why packing also reserves
 * in-flight cost — see tick.ts #3.)
 *
 * Only clean, fully-completed FIRST runs feed the estimator: interrupted samples
 * (breaker/timeout/user) and non-zero exits are dropped — counting them would train
 * the estimate toward zero. Resume legs are skipped too (their before/after only
 * covers the tail of a task, not its whole cost). A NULL exit_code is tolerated
 * (finishRun records 0 for clean runs; a not-yet-recorded row is already excluded
 * by the after-column NULL check).
 */
function deltas(
  db: Database.Database,
  complexity: Complexity,
  beforeCol: string,
  afterCol: string,
): number[] {
  const rows = db
    .prepare(
      `SELECT r.${beforeCol} AS b, r.${afterCol} AS a
         FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE t.complexity = ?
          AND r.${beforeCol} IS NOT NULL
          AND r.${afterCol} IS NOT NULL
          AND r.interrupted_by IS NULL
          AND (r.exit_code = 0 OR r.exit_code IS NULL)
          AND r.resume_of IS NULL
        ORDER BY r.started_at DESC
        LIMIT 20`,
    )
    .all(complexity) as { b: number; a: number }[];
  return rows.map((r) => r.a - r.b).filter((d) => d >= 0);
}

/** Measured session %-point cost of completed runs. */
export function runDeltas(db: Database.Database, complexity: Complexity): number[] {
  return deltas(db, complexity, 'session_pct_before', 'session_pct_after');
}

/** Measured weekly %-point cost of completed runs (Phase 3 #2). */
export function weeklyRunDeltas(db: Database.Database, complexity: Complexity): number[] {
  return deltas(db, complexity, 'weekly_pct_before', 'weekly_pct_after');
}

/** Linear-interpolated percentile (p in 0..1) of a numeric sample. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  if (s.length === 1) return s[0]!;
  const rank = (s.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return s[lo]! + frac * (s[hi]! - s[lo]!);
}

/** Median (p50) of a numeric sample. */
function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

/**
 * Estimated session %-points a task of this complexity will consume.
 * Uses a high percentile (p75) of the measured clean runs once we have >= 5 samples
 * (a safety margin over the median so a run is less likely to overrun its headroom),
 * else the seeded default.
 */
export function estimatePct(db: Database.Database, complexity: Complexity): number {
  const ds = runDeltas(db, complexity);
  if (ds.length >= MIN_SAMPLES) {
    const p = percentile(ds, 0.75);
    if (Number.isFinite(p)) return p;
  }
  return getNum(db, `est_pct_${complexity}`, complexity === 'S' ? 3 : complexity === 'L' ? 20 : 8);
}

/**
 * Estimated weekly %-points a task of this complexity will consume (Phase 3 #2).
 * Same calibration shape as estimatePct, against the weekly before/after columns;
 * uses the median (weekly deltas are coarser, no extra p75 margin needed).
 */
export function estimateWeeklyPct(db: Database.Database, complexity: Complexity): number {
  const ds = weeklyRunDeltas(db, complexity);
  if (ds.length >= MIN_SAMPLES) {
    const m = median(ds);
    if (Number.isFinite(m)) return m;
  }
  return getNum(db, `est_weekly_pct_${complexity}`, complexity === 'S' ? 1 : complexity === 'L' ? 6 : 3);
}

export function isCalibrated(db: Database.Database, complexity: Complexity): boolean {
  return runDeltas(db, complexity).length >= MIN_SAMPLES;
}

export interface BacklogForecast {
  pending: number;
  by_complexity: { S: number; M: number; L: number };
  weekly_backlog_pct: number;
  weekly_now: number;
  weekly_max: number;
  weekly_headroom: number;
  session_now: number;
  session_max: number;
  largest_task_session_pct: number;
  largest_task_session_fits: boolean; // largest_task_session_pct <= (hard_limit_pct - safety_reserve_pct)
  capacity_more_M: number;
  capacity_more_L: number;
  verdict: 'plenty' | 'some' | 'tight' | 'full';
}

/**
 * Aggregate backlog forecast: "is there budget headroom to add more tasks?" (D-FC).
 * Read-only over existing per-task estimates — never touches scheduling/budget state.
 *
 * Weekly is the CUMULATIVE constraint (it never resets mid-week): sum estimateWeeklyPct
 * over every non-terminal task. Session is PER-WINDOW (resets every 5h) — reporting the
 * largest single backlog task's session estimate (not a sum) tells you whether the
 * costliest queued task fits a session window at all, which a running sum would not.
 */
export function forecastBacklog(db: Database.Database): BacklogForecast {
  const byStatusRows = db
    .prepare(
      `SELECT complexity, COUNT(*) AS n FROM tasks
        WHERE status NOT IN ('closed','failed','review','attention')
        GROUP BY complexity`,
    )
    .all() as { complexity: Complexity; n: number }[];

  const by_complexity = { S: 0, M: 0, L: 0 };
  for (const r of byStatusRows) {
    if (r.complexity === 'S' || r.complexity === 'M' || r.complexity === 'L') {
      by_complexity[r.complexity] = r.n;
    }
  }
  const pending = by_complexity.S + by_complexity.M + by_complexity.L;

  const estW: Record<Complexity, number> = {
    S: estimateWeeklyPct(db, 'S'),
    M: estimateWeeklyPct(db, 'M'),
    L: estimateWeeklyPct(db, 'L'),
  };
  const weekly_backlog_pct =
    by_complexity.S * estW.S + by_complexity.M * estW.M + by_complexity.L * estW.L;

  const policy = resolvePolicy(db);
  const usage = readUsage();
  const weekly_now = usage.weekly.percent;
  const weekly_max = policy.weeklyMax;
  const weekly_headroom = Math.max(0, weekly_max - weekly_now - weekly_backlog_pct);

  const session_now = usage.session.percent;
  const session_max = policy.sessionMax;
  const largest_task_session_pct = (['S', 'M', 'L'] as Complexity[])
    .filter((c) => by_complexity[c] > 0)
    .reduce((max, c) => Math.max(max, estimatePct(db, c)), 0);
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  const safetyReserve = getNum(db, 'safety_reserve_pct', 5);
  const largest_task_session_fits = largest_task_session_pct <= hardLimit - safetyReserve;

  const capacity_more_M = estW.M > 0 ? Math.floor(weekly_headroom / estW.M) : 0;
  const capacity_more_L = estW.L > 0 ? Math.floor(weekly_headroom / estW.L) : 0;

  let verdict: BacklogForecast['verdict'];
  if (weekly_headroom <= 0) verdict = 'full';
  else if (capacity_more_M < 1) verdict = 'tight';
  else if (capacity_more_M < 3) verdict = 'some';
  else verdict = 'plenty';

  return {
    pending,
    by_complexity,
    weekly_backlog_pct,
    weekly_now,
    weekly_max,
    weekly_headroom,
    session_now,
    session_max,
    largest_task_session_pct,
    largest_task_session_fits,
    capacity_more_M,
    capacity_more_L,
    verdict,
  };
}
