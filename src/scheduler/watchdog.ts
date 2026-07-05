import type Database from 'better-sqlite3';
import { activeRuns, getTask } from '../tasks.js';
import { logEvent } from '../db/index.js';
import { killRun } from '../orchestrator/kill.js';
import { timeoutMinFor } from './timeout.js';

/**
 * Backstop watchdog. runTask installs its own precise per-run timeout while the
 * engine process lives; this catches runs whose in-process timer was lost (e.g.
 * a run adopted after restart) by comparing wall-clock elapsed to the timeout.
 */
export function checkWatchdog(db: Database.Database, now: Date = new Date()): void {
  for (const run of activeRuns(db)) {
    if (run.interrupted_by) continue; // already being killed
    const task = getTask(db, run.task_id);
    if (!task) continue;
    const timeoutMin = timeoutMinFor(db, task);
    const startedMs = new Date(run.started_at.replace(' ', 'T') + 'Z').getTime();
    const elapsedMin = (now.getTime() - startedMs) / 60_000;
    if (elapsedMin > timeoutMin + 1) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'timeout', detail: `backstop >${timeoutMin}m` });
      killRun(db, { id: run.id, pid: run.pid }, 'timeout');
    }
  }
}
