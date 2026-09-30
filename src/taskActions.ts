import type Database from 'better-sqlite3';
import { getNum, getSetting } from './db/index.js';
import { activeRuns, countByStatus, deleteTask, getTask, latestRun, setStatus } from './tasks.js';
import { validateTask } from './gate/validateTask.js';
import { environmentMap } from './deploy/store.js';
import { killRun } from './orchestrator/kill.js';
import { cleanupWorktree, resetTaskWorkspace } from './orchestrator/cleanup.js';
import { pruneTaskArtifacts } from './git/worktree.js';
import { removeTrialWorkspace } from './review/review.js';
import { collectDistillMaterial, runDistiller, type DistillExec } from './knowledge/distill.js';
import type { Task } from './types.js';
import { recordFix } from './repo/ledger.js';

/**
 * The task transitions the REST routes (board, CLI, MCP) and 對話操作 (src/chatops) share. Each
 * checks its own preconditions and throws TaskActionError — an HTTP status, the message the route
 * always sent and any extra response fields — so a route answers exactly as before and the chat
 * turns the same refusal into a sentence.
 */
export class TaskActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function need(db: Database.Database, id: string): Task {
  const t = getTask(db, id);
  if (!t) throw new TaskActionError('not found', 404);
  return t;
}

/** Interrupt every in-flight run of a task; returns how many were signalled. */
export function killTaskRuns(db: Database.Database, taskId: string, why: 'user' | 'pause' = 'user'): number {
  const runs = activeRuns(db).filter((r) => r.task_id === taskId);
  for (const r of runs) killRun(db, { id: r.id, pid: r.pid }, why);
  return runs.length;
}

/**
 * Put a draft in the queue. Only drafts enter the queue here; a troubled task (attention/failed)
 * must go through restartTask so its stale branch/worktree is reset first. `auto` is the capped
 * path the MCP uses by default: a burst of calls can't flood autonomous spend.
 */
export function queueTask(db: Database.Database, id: string, o: { auto?: boolean } = {}): Task {
  const t = need(db, id);
  if (t.status !== 'draft') {
    throw new TaskActionError(`task is ${t.status} — only a draft can be queued; use /restart to requeue it`, 409, { status: t.status });
  }
  const gate = validateTask(t, getSetting(db, 'host_capabilities') ?? '', environmentMap(db));
  if (!gate.ok) throw new TaskActionError('gate not satisfied', 409, { gate });
  if (o.auto) {
    const max = getNum(db, 'max_autoqueue', 3);
    const counts = countByStatus(db);
    const active = (counts.queued ?? 0) + (counts.running ?? 0);
    if (active >= max) {
      throw new TaskActionError('autoqueue limit reached', 429, {
        limit: max,
        active,
        message: `Auto-queue limit reached (${active} queued+running ≥ max_autoqueue=${max}). Task left as draft — queue it from the board or raise max_autoqueue.`,
      });
    }
  }
  setStatus(db, id, 'queued', { detail: o.auto ? 'auto-queued via api' : 'queued via api' });
  return getTask(db, id)!;
}

/**
 * 續跑: hand an attention task back to the auto-resume path. Clamping (not resetting)
 * resume_count to max_resumes grants exactly ONE more tick-eligible attempt — the scheduler
 * resumes blocked tasks while resume_count <= max_resumes.
 */
export function resumeTask(db: Database.Database, id: string): Task {
  const t = need(db, id);
  if (t.status !== 'attention') throw new TaskActionError('task not in attention', 409, { status: t.status });
  const run = latestRun(db, id);
  if (!run?.session_id) throw new TaskActionError('no session — use restart', 400);
  const maxResumes = getNum(db, 'max_resumes', 2);
  db.prepare('UPDATE tasks SET resume_count = ? WHERE id = ?').run(Math.min(t.resume_count, maxResumes), id);
  setStatus(db, id, 'blocked', { detail: 'manual resume from attention' });
  return getTask(db, id)!;
}

/**
 * 重來: requeue from scratch. resetTaskWorkspace removes the run worktrees AND the loop/<id>
 * branch, so the next dispatch re-cuts from (freshly fetched) base instead of silently reusing
 * the stale branch/dir.
 */
export function restartTask(db: Database.Database, id: string): Task {
  const t = need(db, id);
  if (t.status !== 'attention' && t.status !== 'failed') {
    throw new TaskActionError('restart only applies to attention/failed tasks', 409, { status: t.status });
  }
  resetTaskWorkspace(db, t);
  db.prepare('UPDATE tasks SET resume_count = 0, pr_url = NULL, merge_status = NULL WHERE id = ?').run(id);
  setStatus(db, id, 'queued', { detail: 'restart: fresh from base' });
  return getTask(db, id)!;
}

/** 放棄: close the triage as a terminal failure; `cleanup` also reclaims the worktree. */
export function abandonTask(db: Database.Database, id: string, o: { cleanup?: boolean } = {}): Task {
  const t = need(db, id);
  if (t.status !== 'attention') throw new TaskActionError('task not in attention', 409, { status: t.status });
  setStatus(db, id, 'failed', { detail: 'abandoned by user' });
  if (o.cleanup) cleanupWorktree(db, t);
  return getTask(db, id)!;
}

/**
 * 轉待確認: a blocked task auto-resumes on every eligible tick with no way to stop it — hand it
 * to attention instead, since the tick only scans 'blocked'. A hold racing an in-flight tick may
 * still allow one more resume (one-poll window, acceptable).
 */
export function holdTask(db: Database.Database, id: string): Task {
  const t = need(db, id);
  if (t.status !== 'blocked') throw new TaskActionError('task not blocked', 409, { status: t.status });
  setStatus(db, id, 'attention', { detail: 'held by user (auto-resume stopped)' });
  return getTask(db, id)!;
}

/** 中止: interrupt whatever runs and mark the task failed (terminal: interrupted_by='user'). */
export function abortTask(db: Database.Database, id: string): Task {
  need(db, id);
  killTaskRuns(db, id, 'user');
  setStatus(db, id, 'failed', { detail: 'aborted via api' });
  return getTask(db, id)!;
}

/** 結案: done; reclaims the worktree and the 驗收頁's 試跑 checkout, then distills in the background. */
export function closeTask(db: Database.Database, id: string, o: { distillExec?: DistillExec } = {}): Task {
  const t = need(db, id);
  // collect BEFORE cleanupWorktree destroys the worktree HANDOFF.md lives in
  const material = collectDistillMaterial(db, t);
  // 過去修法: a ticket's outcome, while its shas still resolve (only tasks of an imported repo)
  recordFix(db, t, t.merge_status === 'merged' ? 'merged' : 'abandoned');
  setStatus(db, id, 'closed', { detail: 'closed via api' });
  cleanupWorktree(db, t);
  removeTrialWorkspace(t);
  // fire-and-forget: never delays the caller (see knowledge/distill.ts)
  void runDistiller(db, t, material, o.distillExec).catch(() => {});
  return getTask(db, id)!;
}

/** Delete a task and its disk artifacts. An active task needs `force`, which interrupts it first. */
export function deleteTaskSafe(db: Database.Database, id: string, o: { force?: boolean } = {}): { deleted: string } {
  const t = need(db, id);
  const active = t.status === 'running' || t.status === 'verifying' || t.status === 'queued';
  if (active && !o.force) throw new TaskActionError('task is active — abort it first or pass ?force=1', 409, { status: t.status });
  if (active) killTaskRuns(db, id, 'user');
  pruneTaskArtifacts(db, t); // remove worktrees/logs/plan (path-safe) before cascade-delete
  deleteTask(db, id);
  return { deleted: id };
}
