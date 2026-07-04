import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import type { Complexity } from '../config.js';

const MIN_SAMPLES = 5;

/**
 * Measured session %-point cost of a completed run.
 * (max_concurrency = 1 makes before/after deltas clean and additive.)
 */
export function runDeltas(db: Database.Database, complexity: Complexity): number[] {
  const rows = db
    .prepare(
      `SELECT r.session_pct_before AS b, r.session_pct_after AS a
         FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE t.complexity = ?
          AND r.session_pct_before IS NOT NULL
          AND r.session_pct_after IS NOT NULL
        ORDER BY r.started_at DESC
        LIMIT 20`,
    )
    .all(complexity) as { b: number; a: number }[];
  return rows.map((r) => r.a - r.b).filter((d) => d >= 0);
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
  const deltas = runDeltas(db, complexity);
  if (deltas.length >= MIN_SAMPLES) {
    const m = median(deltas);
    if (Number.isFinite(m)) return m;
  }
  return getNum(db, `est_pct_${complexity}`, complexity === 'S' ? 3 : complexity === 'L' ? 20 : 8);
}

export function isCalibrated(db: Database.Database, complexity: Complexity): boolean {
  return runDeltas(db, complexity).length >= MIN_SAMPLES;
}
