import type Database from 'better-sqlite3';
import { activeRuns, finishRun, getTask, setStatus, bumpResume } from '../tasks.js';
import { getNum, logEvent } from '../db/index.js';
import { isAlive, signalGroup } from './kill.js';

/**
 * On engine startup, reconcile runs that were mid-flight when we crashed/restarted.
 * A run whose process group is gone is 'orphaned' -> its task goes to 'blocked'
 * (resume_count++, or 'failed' once it has been resumed too many times). A run that
 * is somehow still alive is killed and its task blocked (default: don't re-adopt).
 *
 * maxResumes defaults to the shared `max_resumes` setting (see config.ts) so the
 * orchestrator, scheduler, and recovery all agree on the resume budget.
 */
export function recoverOnStartup(db: Database.Database, maxResumes = getNum(db, 'max_resumes', 2)): void {
  const runs = activeRuns(db);
  for (const run of runs) {
    const task = getTask(db, run.task_id);
    if (!task) {
      finishRun(db, run.id, { interrupted_by: 'orphaned', error: 'task missing' });
      continue;
    }

    if (isAlive(run.pid)) {
      signalGroup(run.pid!, 'SIGKILL');
    }

    finishRun(db, run.id, { interrupted_by: 'orphaned' });
    logEvent(db, { task_id: task.id, run_id: run.id, kind: 'recovery', detail: `orphaned run pid=${run.pid}` });

    const resumes = bumpResume(db, task.id);
    if (resumes > maxResumes) {
      setStatus(db, task.id, 'failed', { run_id: run.id, detail: `orphaned; resume limit (${maxResumes}) exceeded` });
    } else {
      setStatus(db, task.id, 'blocked', { run_id: run.id, detail: 'orphaned by restart; will resume' });
    }
  }
}
