import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { logEvent, getBool } from './db/index.js';
import type { Task, TaskRun } from './types.js';
import type { TaskStatus, Complexity } from './config.js';

export interface NewTaskInput {
  title: string;
  goal: string;
  plan_ref?: string | null;
  plan_kind?: 'md' | 'html' | 'url' | null;
  coding_tool?: string;
  verification_steps?: string[];
  setup_cmd?: string | null;
  repo_path?: string | null;
  base_branch?: string | null;
  complexity?: Complexity;
  priority?: number;
  model?: string | null;
  timeout_min?: number | null;
  depends_on?: string | null;
  environment?: string | null;
}

export function createTask(db: Database.Database, input: NewTaskInput): Task {
  const id = `t_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO tasks (id, title, goal, plan_ref, plan_kind, coding_tool, verification_steps,
       setup_cmd, repo_path, base_branch, complexity, priority, model, timeout_min, depends_on, environment, status)
     VALUES (@id, @title, @goal, @plan_ref, @plan_kind, @coding_tool, @verification_steps,
       @setup_cmd, @repo_path, @base_branch, @complexity, @priority, @model, @timeout_min, @depends_on, @environment, 'draft')`,
  ).run({
    id,
    title: input.title,
    goal: input.goal,
    plan_ref: input.plan_ref ?? null,
    plan_kind: input.plan_kind ?? null,
    coding_tool: input.coding_tool ?? 'claude-code',
    verification_steps: JSON.stringify(input.verification_steps ?? []),
    setup_cmd: input.setup_cmd ?? null,
    repo_path: input.repo_path ?? null,
    base_branch: input.base_branch ?? null,
    complexity: input.complexity ?? 'M',
    priority: input.priority ?? 2,
    model: input.model ?? null,
    timeout_min: input.timeout_min ?? null,
    depends_on: input.depends_on ?? null,
    environment: input.environment ?? null,
  });
  logEvent(db, { task_id: id, kind: 'status', to_status: 'draft', detail: 'created' });
  return getTask(db, id)!;
}

/**
 * Where a task stands relative to its `depends_on` chain link.
 * - 'none'        no dependency declared
 * - 'satisfied'   the dependency is closed — the task may run
 * - 'waiting'     the dependency exists but is not closed yet (any live status)
 * - 'dep-failed'  the dependency terminally failed — human must resolve (restart dep,
 *                 or clear/delete this task); the scheduler never runs it automatically
 * - 'dep-missing' the dependency id no longer exists (deleted) — held for the same reason
 */
export type DependencyState = 'none' | 'satisfied' | 'waiting' | 'dep-failed' | 'dep-missing';

export function dependencyState(db: Database.Database, t: Task): DependencyState {
  if (!t.depends_on) return 'none';
  const dep = getTask(db, t.depends_on);
  if (!dep) return 'dep-missing';
  if (dep.status === 'closed') return 'satisfied';
  // dep_done_on_merge (default off): the dep's work is already on main once it's in
  // review with a merged PR — release the chain without waiting for a human close.
  if (dep.status === 'review' && dep.merge_status === 'merged' && getBool(db, 'dep_done_on_merge', false)) {
    return 'satisfied';
  }
  if (dep.status === 'failed') return 'dep-failed';
  return 'waiting';
}

export function getTask(db: Database.Database, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function listTasks(db: Database.Database, status?: TaskStatus): Task[] {
  if (status) {
    return db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC')
      .all(status) as Task[];
  }
  return db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as Task[];
}

export function countByStatus(db: Database.Database): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all() as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/**
 * Permanently delete a task and its associated rows (task_events, task_runs) in a
 * single transaction. `defer_foreign_keys` lets us drop the children explicitly in
 * child→parent order without tripping the run's self-referential `resume_of` FK.
 * Returns whether the task existed. Delete is permanent (no soft-delete, by design).
 */
export function deleteTask(db: Database.Database, id: string): boolean {
  const tx = db.transaction((taskId: string): boolean => {
    db.pragma('defer_foreign_keys = ON');
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId);
    return db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId).changes > 0;
  });
  return tx(id);
}

/** Statuses that batch-prune must NEVER delete — in-flight or awaiting a human. */
export const NEVER_PRUNE: readonly string[] = ['running', 'verifying', 'queued', 'blocked', 'attention', 'review'];
/** Default prune targets: only truly terminal tasks. */
export const DEFAULT_PRUNE_STATUS: readonly string[] = ['closed', 'failed'];

export interface PruneFilter {
  status?: string[];
  olderThanDays?: number;
}

/**
 * Tasks eligible for batch prune, filtered by status and age. Requested statuses
 * are intersected with a safety guard: anything active/blocked/review is dropped,
 * so `tasksForPrune` can never surface a task that prune is forbidden to delete.
 * Age is measured on `updated_at` (when the task last changed, ~ entered its
 * terminal state). Returns [] when the effective status set is empty.
 */
export function tasksForPrune(db: Database.Database, filter: PruneFilter = {}): Task[] {
  const requested = filter.status?.length ? filter.status : DEFAULT_PRUNE_STATUS;
  const statuses = [...new Set(requested)].filter((s) => !NEVER_PRUNE.includes(s));
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  const params: unknown[] = [...statuses];
  let sql = `SELECT * FROM tasks WHERE status IN (${placeholders})`;
  if (filter.olderThanDays != null && Number.isFinite(filter.olderThanDays) && filter.olderThanDays > 0) {
    sql += " AND updated_at <= datetime('now', ?)";
    params.push(`-${filter.olderThanDays} days`);
  }
  sql += ' ORDER BY updated_at ASC';
  return db.prepare(sql).all(...params) as Task[];
}

/** All runs for a task, newest first — used to reach on-disk artifacts before delete. */
export function listRunsForTask(db: Database.Database, taskId: string): TaskRun[] {
  return db
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC')
    .all(taskId) as TaskRun[];
}

/**
 * Transition a task's status and record it. Guards against unknown transitions are
 * kept loose on purpose (the scheduler/orchestrator own the state machine); this is
 * the single write path so every change lands in task_events.
 */
export function setStatus(
  db: Database.Database,
  id: string,
  to: TaskStatus,
  opts: { detail?: string; run_id?: string | null; session_pct?: number | null; weekly_pct?: number | null } = {},
): void {
  const cur = getTask(db, id);
  if (!cur) throw new Error(`task not found: ${id}`);
  if (cur.status === to && !opts.detail) return;
  db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(to, id);
  logEvent(db, {
    task_id: id,
    run_id: opts.run_id ?? null,
    kind: 'status',
    from_status: cur.status,
    to_status: to,
    detail: opts.detail ?? null,
    session_pct: opts.session_pct ?? null,
    weekly_pct: opts.weekly_pct ?? null,
  });
}

export function bumpResume(db: Database.Database, id: string): number {
  db.prepare('UPDATE tasks SET resume_count = resume_count + 1 WHERE id = ?').run(id);
  return getTask(db, id)!.resume_count;
}

// ---- runs ----

export function createRun(
  db: Database.Database,
  args: {
    task_id: string;
    resume_of?: string | null;
    attempt?: number;
    worktree_path?: string | null;
    branch?: string | null;
    log_path?: string | null;
    session_pct_before?: number | null;
    weekly_pct_before?: number | null;
    dispatch_window?: string | null;
  },
): TaskRun {
  const id = `r_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO task_runs (id, task_id, resume_of, attempt, worktree_path, branch, log_path,
       session_pct_before, weekly_pct_before, dispatch_window)
     VALUES (@id, @task_id, @resume_of, @attempt, @worktree_path, @branch, @log_path,
       @session_pct_before, @weekly_pct_before, @dispatch_window)`,
  ).run({
    id,
    task_id: args.task_id,
    resume_of: args.resume_of ?? null,
    attempt: args.attempt ?? 1,
    worktree_path: args.worktree_path ?? null,
    branch: args.branch ?? null,
    log_path: args.log_path ?? null,
    session_pct_before: args.session_pct_before ?? null,
    weekly_pct_before: args.weekly_pct_before ?? null,
    dispatch_window: args.dispatch_window ?? null,
  });
  return getRun(db, id)!;
}

export function getRun(db: Database.Database, id: string): TaskRun | undefined {
  return db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as TaskRun | undefined;
}

export function updateRun(db: Database.Database, id: string, patch: Partial<TaskRun>): void {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const set = cols.map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE task_runs SET ${set} WHERE id = @id`).run({ ...patch, id });
}

export function finishRun(
  db: Database.Database,
  id: string,
  patch: Partial<TaskRun>,
): void {
  updateRun(db, id, { ...patch, finished_at: new Date().toISOString() });
}

export function activeRuns(db: Database.Database): TaskRun[] {
  return db
    .prepare('SELECT * FROM task_runs WHERE finished_at IS NULL ORDER BY started_at ASC')
    .all() as TaskRun[];
}

/**
 * In-flight runs joined with their task complexity — for concurrency headroom
 * reservation (Phase 3 #3). Each row carries the budget% at dispatch so the tick can
 * reserve the run's *unspent* estimated cost before packing more work.
 */
export interface ActiveRunCost {
  complexity: Complexity;
  session_pct_before: number | null;
  weekly_pct_before: number | null;
}
export function activeRunCosts(db: Database.Database): ActiveRunCost[] {
  return db
    .prepare(
      `SELECT t.complexity AS complexity,
              r.session_pct_before AS session_pct_before,
              r.weekly_pct_before  AS weekly_pct_before
         FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.finished_at IS NULL`,
    )
    .all() as ActiveRunCost[];
}

/** Latest run for a task (for resume: reuse session_id). */
export function latestRun(db: Database.Database, taskId: string): TaskRun | undefined {
  return db
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(taskId) as TaskRun | undefined;
}
