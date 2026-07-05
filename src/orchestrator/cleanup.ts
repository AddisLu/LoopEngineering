import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { latestRun, listRunsForTask } from '../tasks.js';
import { logEvent } from '../db/index.js';
import { removeWorktree, resolveInside } from '../git/worktree.js';
import { paths } from '../config.js';
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

/**
 * Reset a task's workspace for a from-scratch requeue (重來): remove every run
 * worktree AND delete the `loop/<id>` branch. Passing the branch to removeWorktree is
 * what fixes the requeue collision — without it, addWorktree silently reuses the stale
 * branch/dir and the "fresh" run starts from the old tip instead of base. Worktree
 * paths are safety-gated to the data dir (same rule as pruneTaskArtifacts). Best-effort,
 * never throws.
 */
export function resetTaskWorkspace(db: Database.Database, task: Task): void {
  const branch = `loop/${task.id}`;
  const removed: string[] = [];
  const seen = new Set<string>(); // resume runs share one worktree — clean each path once
  for (const run of listRunsForTask(db, task.id)) {
    const wt = resolveInside(paths.worktreesDir, run.worktree_path);
    if (!wt || seen.has(wt)) continue;
    seen.add(wt);
    if (task.repo_path) {
      // even when the dir is already gone, removeWorktree still prunes and drops the branch
      if (removeWorktree(task.repo_path, wt, run.branch ?? branch)) removed.push(wt);
    } else if (fs.existsSync(wt)) {
      // repo-less (mock) scratch dir
      try {
        fs.rmSync(wt, { recursive: true, force: true });
        removed.push(wt);
      } catch {
        /* best effort */
      }
    }
  }
  logEvent(db, {
    task_id: task.id,
    kind: 'note',
    detail: `workspace reset: branch ${branch} deleted, ${removed.length} worktree(s) removed`,
  });
}
