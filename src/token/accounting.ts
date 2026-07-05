import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import type { Complexity } from '../config.js';

const MIN_SAMPLES = 5;

/**
 * Measured %-point cost of the last completed runs for a complexity, from a
 * before/after column pair. (max_concurrency = 1 makes deltas clean and additive;
 * with concurrency > 1 they are approximate, which is why packing also reserves
 * in-flight cost — see tick.ts #3.)
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
        ORDER BY r.started_at DESC
        LIMIT 20`,
    )
    .all(complexity) as { b: number; a: number }[];
  return rows.map((r) => r.a - r.b).filter((d) => d >= 0);
}

/** Measured session %-point cost of a completed run. */
export function runDeltas(db: Database.Database, complexity: Complexity): number[] {
  return deltas(db, complexity, 'session_pct_before', 'session_pct_after');
}

/** Measured weekly %-point cost of a completed run (Phase 3 #2). */
export function weeklyRunDeltas(db: Database.Database, complexity: Complexity): number[] {
  return deltas(db, complexity, 'weekly_pct_before', 'weekly_pct_after');
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Estimated session %-points a task of this complexity will consume.
 * Uses the measured median once we have >= 5 samples, else the seeded default.
 */
export function estimatePct(db: Database.Database, complexity: Complexity): number {
  const ds = runDeltas(db, complexity);
  if (ds.length >= MIN_SAMPLES) {
    const m = median(ds);
    if (Number.isFinite(m)) return m;
  }
  return getNum(db, `est_pct_${complexity}`, complexity === 'S' ? 3 : complexity === 'L' ? 20 : 8);
}

/**
 * Estimated weekly %-points a task of this complexity will consume (Phase 3 #2).
 * Same calibration shape as estimatePct, against the weekly before/after columns.
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
