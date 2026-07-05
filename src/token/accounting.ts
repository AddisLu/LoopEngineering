import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import type { Complexity } from '../config.js';

const MIN_SAMPLES = 5;

/**
 * Measured session %-point cost of a completed run.
 * (max_concurrency = 1 makes before/after deltas clean and additive.)
 *
 * Only clean, fully-completed FIRST runs feed the estimator: interrupted samples
 * (breaker/timeout/user) and non-zero exits are truncated — counting them would
 * train the estimate toward zero. Resume legs are skipped too (their before/after
 * only covers the tail of a task, not its whole cost).
 */
export function runDeltas(db: Database.Database, complexity: Complexity): number[] {
  const rows = db
    .prepare(
      `SELECT r.session_pct_before AS b, r.session_pct_after AS a
         FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE t.complexity = ?
          AND r.session_pct_before IS NOT NULL
          AND r.session_pct_after IS NOT NULL
          AND r.interrupted_by IS NULL
          AND r.exit_code = 0
          AND r.resume_of IS NULL
        ORDER BY r.started_at DESC
        LIMIT 20`,
    )
    .all(complexity) as { b: number; a: number }[];
  return rows.map((r) => r.a - r.b).filter((d) => d >= 0);
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

/**
 * Estimated session %-points a task of this complexity will consume.
 * Uses a high percentile (p75) of the measured clean runs once we have >= 5 samples
 * (a safety margin over the median so a run is less likely to overrun its headroom),
 * else the seeded default.
 */
export function estimatePct(db: Database.Database, complexity: Complexity): number {
  const deltas = runDeltas(db, complexity);
  if (deltas.length >= MIN_SAMPLES) {
    const p = percentile(deltas, 0.75);
    if (Number.isFinite(p)) return p;
  }
  return getNum(db, `est_pct_${complexity}`, complexity === 'S' ? 3 : complexity === 'L' ? 20 : 8);
}

export function isCalibrated(db: Database.Database, complexity: Complexity): boolean {
  return runDeltas(db, complexity).length >= MIN_SAMPLES;
}
