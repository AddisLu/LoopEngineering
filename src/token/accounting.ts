import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import type { Complexity } from '../config.js';

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
