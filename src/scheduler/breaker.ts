import type Database from 'better-sqlite3';
import { activeRuns } from '../tasks.js';
import { logEvent } from '../db/index.js';
import { killRun } from '../orchestrator/kill.js';
import type { UsageReading } from '../types.js';

/**
 * Circuit breaker: if session% has reached the hard limit, SIGINT every active run
 * (escalating to SIGKILL). Runs are marked interrupted_by='breaker' so runTask sends
 * their tasks to 'blocked' (session_id kept — NOT a failure; resumable).
 */
export function checkBreaker(db: Database.Database, reading: UsageReading, hardLimitPct: number): boolean {
  if (!Number.isFinite(reading.session.percent) || reading.session.percent < hardLimitPct) {
    return false;
  }
  const runs = activeRuns(db);
  if (runs.length === 0) return true;
  for (const run of runs) {
    logEvent(db, {
      task_id: run.task_id,
      run_id: run.id,
      kind: 'breaker',
      detail: `session ${reading.session.percent}% >= ${hardLimitPct}%`,
      session_pct: reading.session.percent,
      weekly_pct: reading.weekly.percent,
    });
    killRun(db, { id: run.id, pid: run.pid }, 'breaker');
  }
  return true;
}
