import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { isEngineRepo } from '../config.js';
import { getBool, setSetting, logEvent } from '../db/index.js';
import { getTask, latestRun } from '../tasks.js';
import { addWorktree, removeWorktree } from '../git/worktree.js';
import { syncWithBase, pushBranch, stripLoopArtifacts, integrateIntoBase, gitEnvFor } from '../git/integrate.js';
import type { SandboxDeps } from '../exec/sandbox.js';
import type { Task } from '../types.js';
import { createMergeTask } from './mergeTask.js';
import { cleanupWorktree } from './cleanup.js';
import { runVerifyGate, collectTaskArtifacts } from './run.js';

export type MergeOutcome = 'merged' | 'pending' | 'conflict';

export interface MergeResult {
  outcome: MergeOutcome;
  detail: string;
  /** the resolution task a conflict queued (or the one already working on it) */
  merge_task_id?: string;
}

/** A second 合併 while the first is still re-verifying — the route answers 409. */
export class MergeInProgressError extends Error {}

/** Why a reviewed task can't be merged by hand (null = go): the same checks the /merge route makes. */
export function mergeBlocker(t: Task): { error: string; extra: Record<string, unknown> } | null {
  if (t.status !== 'review') return { error: 'task not in review', extra: { status: t.status } };
  if (t.merge_status !== 'pending' && t.merge_status !== 'conflict') return { error: 'task not awaiting merge', extra: { merge_status: t.merge_status } };
  if (!t.repo_path || !t.base_branch) return { error: 'task has no repo/base', extra: {} };
  return null;
}

const inFlight = new Set<string>();

/** Tasks being merged by hand right now (in this process) — 對話操作's git refuses to touch their repos meanwhile. */
export function mergingTaskIds(): string[] {
  return [...inFlight];
}

/**
 * 合併 / 核可並合併 for a task parked in review at merge_status pending/conflict: the engine's own
 * close-out, run on demand. The latest base goes into the task branch first; when that changed the
 * branch, the command verification runs again on the result (recorded on the run, so the review
 * page shows what was checked) and only a pass fast-forwards base. A plain fast-forward — what the
 * button used to do — can never land a task whose base moved on after it finished, which left it
 * pending until someone merged it by hand, with nothing on record.
 *
 * A failed re-verification or a conflict leaves the task in review (never attention: nobody is
 * resumed by a button press) with merge_status saying why; a conflict queues the usual
 * merge-resolution task unless one is already open. Never touches the user's checkout beyond the
 * fast-forward integrateIntoBase already guards.
 */
export async function mergeReviewedTask(
  db: Database.Database,
  task: Task,
  opts: { by?: string | null; sandboxDeps?: SandboxDeps } = {},
): Promise<MergeResult> {
  if (!task.repo_path || !task.base_branch) return { outcome: 'pending', detail: 'task has no repo/base' };
  if (inFlight.has(task.id)) throw new MergeInProgressError('這個任務已經在合併中（正在重新驗證），請稍候');
  inFlight.add(task.id);
  const scratch: { worktree: string | null } = { worktree: null };
  try {
    return await merge(db, task, opts, scratch);
  } finally {
    inFlight.delete(task.id);
    // a worktree checked out only for this merge goes again; the branch stays
    if (scratch.worktree && fs.existsSync(scratch.worktree)) removeWorktree(task.repo_path, scratch.worktree);
  }
}

async function merge(
  db: Database.Database,
  task: Task,
  opts: { by?: string | null; sandboxDeps?: SandboxDeps },
  scratch: { worktree: string | null },
): Promise<MergeResult> {
  const repo = task.repo_path!;
  const base = task.base_branch!;
  const branch = `loop/${task.id}`;
  const run = latestRun(db, task.id);
  const who = opts.by ? `（${opts.by}）` : '';
  const note = (detail: string) => logEvent(db, { task_id: task.id, run_id: run?.id ?? null, kind: 'merge', detail });
  const setMerge = (status: MergeOutcome) => db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run(status, task.id);
  // network git gets the Gitea token when origin is on the Gitea host; undefined otherwise
  const gitEnv = gitEnvFor(db, repo);

  let wt = run?.worktree_path && fs.existsSync(run.worktree_path) ? run.worktree_path : null;
  if (!wt) {
    // the worktree was reclaimed: check the branch out again — but never cut a fresh one
    if (!branchExists(repo, branch)) return { outcome: 'pending', detail: `找不到分支 ${branch}，沒有東西可以合併` };
    try {
      wt = addWorktree(repo, branch, base, { env: gitEnv }).path;
      scratch.worktree = wt;
    } catch (err) {
      return { outcome: 'pending', detail: `無法取出 ${branch}：${String((err as Error).message).slice(0, 200)}` };
    }
  }

  const sync = syncWithBase(wt, base, getBool(db, 'git_fetch_base', true), gitEnv);
  let checked = '';
  if (sync.status === 'conflict') {
    setMerge('conflict');
    const files = sync.conflictFiles.join(', ') || '(unknown files)';
    note(`conflict${who}: ${files}`);
    if (!getBool(db, 'merge_conflict_task', true) || task.parent_task_id) {
      return { outcome: 'conflict', detail: `和 ${sync.baseRef} 有衝突（${files}），需要人工合併` };
    }
    const open = db
      .prepare("SELECT id FROM tasks WHERE parent_task_id = ? AND status NOT IN ('closed', 'failed') ORDER BY created_at DESC LIMIT 1")
      .get(task.id) as { id: string } | undefined;
    if (open) return { outcome: 'conflict', detail: `和 ${sync.baseRef} 有衝突（${files}）；解衝突任務 ${open.id} 已經在處理`, merge_task_id: open.id };
    const mt = createMergeTask(db, getTask(db, task.id) ?? task, sync.conflictFiles, sync.baseRef);
    return { outcome: 'conflict', detail: `和 ${sync.baseRef} 有衝突（${files}）；已排入解衝突任務 ${mt.id}`, merge_task_id: mt.id };
  }
  if (sync.status === 'refused') {
    return { outcome: 'pending', detail: `無法把 ${sync.baseRef} 併進 ${branch}（任務的工作目錄有未提交的變更？）` };
  }
  if (sync.status === 'merged') {
    note(`merged ${sync.baseRef} into ${branch}${who}`);
    if (run) {
      const gate = await runVerifyGate(db, task, wt, run.id, base, opts.sandboxDeps);
      if (gate.failure) {
        setMerge('pending');
        const detail = `把 ${sync.baseRef} 併進任務分支後重新驗證沒有通過（${gate.failure.failedStep ?? '驗證'}），沒有合併`;
        note(detail);
        return { outcome: 'pending', detail };
      }
      if (gate.ran) {
        checked = '，合併前已重新驗證';
        await collectTaskArtifacts(db, task, run.id, wt); // what was re-verified is what ships
      } else {
        checked = '（沒有可以自動重跑的驗證步驟）';
      }
    }
  }

  stripLoopArtifacts(wt);
  if (getBool(db, 'auto_push_branch', true)) pushBranch(wt, branch, gitEnv);
  const r = integrateIntoBase(repo, wt, branch, base, gitEnv);
  setMerge(r.outcome);
  note(`${r.detail}${who}`);
  if (r.outcome !== 'merged') return { outcome: 'pending', detail: r.detail };
  // the engine's own repo changed on main — same rebuild+restart the close-out asks for
  if (getBool(db, 'self_update', true) && isEngineRepo(repo)) {
    setSetting(db, 'self_update_pending', 'true');
    logEvent(db, { task_id: task.id, run_id: run?.id ?? null, kind: 'note', detail: 'self-update pending: engine repo changed on main' });
  }
  cleanupWorktree(db, task);
  return { outcome: 'merged', detail: `已合併到 ${base}${checked}` };
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
