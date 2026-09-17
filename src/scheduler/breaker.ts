import type Database from 'better-sqlite3';
import { activeRuns } from '../tasks.js';
import { logEvent } from '../db/index.js';
import { killRun } from '../orchestrator/kill.js';
import type { UsageReading } from '../types.js';

/** 本地模型 runs spend no Anthropic quota, so neither quota safety below may interrupt them. */
const isLocalRun = (run: { model: string | null }): boolean => !!run.model && run.model.startsWith('local:');

/**
 * Circuit breaker: if session% has reached the hard limit, SIGINT every active run
 * (escalating to SIGKILL). Runs are marked interrupted_by='breaker' so runTask sends
 * their tasks to 'blocked' (session_id kept — NOT a failure; resumable).
 */
export function checkBreaker(db: Database.Database, reading: UsageReading, hardLimitPct: number): boolean {
  if (!Number.isFinite(reading.session.percent) || reading.session.percent < hardLimitPct) {
    return false;
  }
  const runs = activeRuns(db).filter((r) => !isLocalRun(r));
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

/**
 * Day/night window checkpoint (Phase 3 #1). A run dispatched under one window's budget
 * can bleed into the other (e.g. a night task running into the tighter day budget). When
 * the current window differs from a run's dispatch window, gracefully checkpoint it —
 * reusing the breaker mechanism (SIGINT -> the run commits WIP and goes 'blocked',
 * keeping its session_id) so it re-enters under the new window's budget on the next tick.
 * Feature-flagged by `window_checkpoint`; the caller decides whether to invoke this.
 */
export function checkWindowSwitch(db: Database.Database, currentWindow: 'day' | 'night'): void {
  for (const run of activeRuns(db)) {
    if (run.interrupted_by) continue; // already being killed (breaker/timeout/user)
    if (isLocalRun(run)) continue;
    if (!run.dispatch_window || run.dispatch_window === currentWindow) continue;
    logEvent(db, {
      task_id: run.task_id,
      run_id: run.id,
      kind: 'window',
      detail: `window ${run.dispatch_window} -> ${currentWindow}: checkpoint for re-budget`,
    });
    killRun(db, { id: run.id, pid: run.pid }, 'window');
  }
}
