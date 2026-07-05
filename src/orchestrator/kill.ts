import type Database from 'better-sqlite3';
import type { TaskRun } from '../types.js';
import { updateRun } from '../tasks.js';

/** True if the process (group leader) is still alive. */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists but not ours
  }
}

/** Signal the whole process group (spawned detached => own group). */
export function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    // fall back to the single pid
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Interrupt a run: mark why, SIGINT the group now, escalate to SIGKILL after
 * `graceMs` if it hasn't exited. Returns immediately; escalation is scheduled.
 */
export function killRun(
  db: Database.Database,
  run: Pick<TaskRun, 'id' | 'pid'>,
  reason: 'breaker' | 'timeout' | 'user' | 'pause' | 'orphaned' | 'window',
  graceMs = 30_000,
): void {
  updateRun(db, run.id, { interrupted_by: reason });
  if (!run.pid) return;
  signalGroup(run.pid, 'SIGINT');
  const pid = run.pid;
  const timer = setTimeout(() => {
    if (isAlive(pid)) signalGroup(pid, 'SIGKILL');
  }, graceMs);
  // do not keep the event loop alive just for the escalation timer
  if (typeof timer.unref === 'function') timer.unref();
}
