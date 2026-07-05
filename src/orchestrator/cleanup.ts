import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { latestRun } from '../tasks.js';
import { logEvent } from '../db/index.js';
import { removeWorktree } from '../git/worktree.js';
import type { Task } from '../types.js';

/**
 * Reclaim a task's git worktree once its work has been externalized to a durable
 * terminal state — a PR was opened, or the task was closed/deleted. Without this the
 * 24/7 scheduler leaves a full checkout per dispatch and the disk grows unbounded.
 *
 * Best-effort and never throws. Worktrees for 'failed'/'blocked' are deliberately
 * NOT cleaned here, so they stay available for triage or resume.
 */
export function cleanupWorktree(db: Database.Database, task: Task): void {
  // mock scratch dirs (and any repo-less task) have no git worktree to remove
  if (!task.repo_path) return;
  const run = latestRun(db, task.id);
  const wt = run?.worktree_path;
  if (!wt || !fs.existsSync(wt)) return;
  const ok = removeWorktree(task.repo_path, wt);
  logEvent(db, {
    task_id: task.id,
    run_id: run?.id ?? null,
    kind: 'note',
    detail: ok ? `worktree removed (${wt})` : `worktree removal failed — manual cleanup needed (${wt})`,
  });
}
