import { execFileSync } from 'node:child_process';
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

/** Fire-and-forget exec used by the win32 tree-kill branch (injectable for tests). */
type KillExec = (cmd: string, args: string[]) => void;

export interface SignalGroupOptions {
  /** Injectable for tests — defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable for tests — defaults to a swallow-errors execFileSync('taskkill', ...). */
  exec?: KillExec;
}

/**
 * Signal the whole process group (spawned detached => own group).
 *
 * POSIX: `process.kill(-pid, sig)` (negative pid = the group), falling back to the
 * single pid. Windows has no POSIX process groups, and negative-pid / SIGINT / SIGKILL
 * are not honored there, so we tree-kill with `taskkill /PID <pid> /T [/F]`
 * (`/T` = whole tree, `/F` = force, used for the SIGKILL escalation).
 */
export function signalGroup(pid: number, sig: NodeJS.Signals, opts: SignalGroupOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    const exec =
      opts.exec ??
      ((cmd, args) => {
        try {
          execFileSync(cmd, args, { stdio: 'ignore' });
        } catch {
          /* already gone / not ours */
        }
      });
    const args = ['/PID', String(pid), '/T', ...(sig === 'SIGKILL' ? ['/F'] : [])];
    try {
      exec('taskkill', args);
      return true;
    } catch {
      return false;
    }
  }
  // ---- POSIX (unchanged): kill the group, then the single pid ----
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
