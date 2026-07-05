import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, logEvent } from '../db/index.js';
import {
  createTask,
  getTask,
  setStatus,
  createRun,
  deleteTask,
  tasksForPrune,
} from '../tasks.js';
import { pruneTaskArtifacts, resolveInside } from '../git/worktree.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';
import { paths } from '../config.js';
import type { TaskStatus } from '../config.js';

let db: Database.Database;
let app: FastifyInstance | undefined;

const MOCK_TASK = {
  title: 'del task',
  goal: 'do a thing',
  plan_ref: 'https://example.com/plan.md',
  plan_kind: 'url' as const,
  coding_tool: 'mock',
  verification_steps: ['true'],
  complexity: 'S' as const,
};

/** create a task straight into a given status (createTask always starts at draft). */
function mk(status: TaskStatus): string {
  const t = createTask(db, MOCK_TASK);
  if (status !== 'draft') setStatus(db, t.id, status);
  return t.id;
}
function touch(p: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const count = (sql: string, id: string): number =>
  (db.prepare(sql).get(id) as { n: number }).n;

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(15, 25);
  app = undefined;
});
afterEach(async () => {
  await app?.close();
  db.close();
});

describe('deleteTask — cascade', () => {
  it('removes the task and its runs + events in one shot', () => {
    const t = createTask(db, MOCK_TASK); // logs a "created" event
    setStatus(db, t.id, 'running'); // logs a status event
    const r1 = createRun(db, { task_id: t.id, branch: 'loop/x' });
    const r2 = createRun(db, { task_id: t.id, resume_of: r1.id, attempt: 2 }); // self-ref FK
    logEvent(db, { task_id: t.id, run_id: r2.id, kind: 'dispatch', detail: 'go' });

    expect(count('SELECT COUNT(*) n FROM task_events WHERE task_id=?', t.id)).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) n FROM task_runs WHERE task_id=?', t.id)).toBe(2);

    expect(deleteTask(db, t.id)).toBe(true);

    expect(getTask(db, t.id)).toBeUndefined();
    expect(count('SELECT COUNT(*) n FROM task_events WHERE task_id=?', t.id)).toBe(0);
    expect(count('SELECT COUNT(*) n FROM task_runs WHERE task_id=?', t.id)).toBe(0);
  });

  it('returns false when the task does not exist', () => {
    expect(deleteTask(db, 't_missing')).toBe(false);
  });

  it('only deletes the target task, leaving others intact', () => {
    const keep = mk('closed');
    createRun(db, { task_id: keep });
    const drop = mk('failed');
    createRun(db, { task_id: drop });

    deleteTask(db, drop);

    expect(getTask(db, keep)).toBeTruthy();
    expect(count('SELECT COUNT(*) n FROM task_runs WHERE task_id=?', keep)).toBe(1);
  });
});

describe('tasksForPrune — status + age guards', () => {
  it('defaults to closed+failed and never surfaces active/blocked/review', () => {
    const closed = mk('closed');
    const failed = mk('failed');
    mk('running');
    mk('verifying');
    mk('queued');
    mk('blocked');
    mk('review');

    const ids = tasksForPrune(db).map((t) => t.id);
    expect(new Set(ids)).toEqual(new Set([closed, failed]));
  });

  it('drops forbidden statuses even when explicitly requested', () => {
    const closed = mk('closed');
    const running = mk('running');
    const review = mk('review');
    const blocked = mk('blocked');
    const attention = mk('attention');

    const ids = tasksForPrune(db, {
      status: ['closed', 'running', 'review', 'blocked', 'attention'],
    }).map((t) => t.id);

    expect(ids).toEqual([closed]);
    expect(ids).not.toContain(running);
    expect(ids).not.toContain(review);
    expect(ids).not.toContain(blocked);
    expect(ids).not.toContain(attention);
  });

  it('respects olderThanDays on updated_at', () => {
    const oldT = mk('closed');
    db.prepare("UPDATE tasks SET updated_at = datetime('now','-10 days') WHERE id=?").run(oldT);
    const freshT = mk('closed');

    const older = tasksForPrune(db, { olderThanDays: 1 }).map((t) => t.id);
    expect(older).toContain(oldT);
    expect(older).not.toContain(freshT);

    const all = tasksForPrune(db).map((t) => t.id);
    expect(all).toEqual(expect.arrayContaining([oldT, freshT]));
  });
});

describe('pruneTaskArtifacts — restricted to the data dir', () => {
  it('removes worktree / log / plan that live under the data dir', () => {
    const t = createTask(db, MOCK_TASK);
    const wt = path.join(paths.worktreesDir, `loop_${t.id}`);
    fs.mkdirSync(wt, { recursive: true });
    touch(path.join(wt, 'file.txt'));
    const log = path.join(paths.logsDir, `${t.id}.jsonl`);
    touch(log);
    const plan = path.join(paths.plansDir, `${t.id}.md`);
    touch(plan);
    createRun(db, { task_id: t.id, worktree_path: wt, log_path: log });
    db.prepare('UPDATE tasks SET plan_ref=?, plan_kind=? WHERE id=?').run(plan, 'md', t.id);

    const res = pruneTaskArtifacts(db, getTask(db, t.id)!);

    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(plan)).toBe(false);
    expect(res.worktrees).toHaveLength(1);
    expect(res.logs).toHaveLength(1);
    expect(res.plans).toHaveLength(1);
    expect(res.skipped).toEqual([]);
  });

  it('NEVER deletes paths outside the data dir (e.g. the user repo)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-outside-'));
    const extWt = path.join(outside, 'repo-worktree');
    fs.mkdirSync(extWt, { recursive: true });
    touch(path.join(extWt, 'src.ts'));
    const extLog = path.join(outside, 'run.jsonl');
    touch(extLog);
    const extPlan = path.join(outside, 'plan.md'); // a user-supplied plan in their repo
    touch(extPlan);

    const t = createTask(db, MOCK_TASK);
    createRun(db, { task_id: t.id, worktree_path: extWt, log_path: extLog });
    db.prepare('UPDATE tasks SET plan_ref=?, plan_kind=? WHERE id=?').run(extPlan, 'md', t.id);

    const res = pruneTaskArtifacts(db, getTask(db, t.id)!);

    // everything outside the data dir is untouched
    expect(fs.existsSync(extWt)).toBe(true);
    expect(fs.existsSync(extLog)).toBe(true);
    expect(fs.existsSync(extPlan)).toBe(true);
    expect(res.worktrees).toEqual([]);
    expect(res.logs).toEqual([]);
    expect(res.plans).toEqual([]);
    expect(res.skipped).toEqual(expect.arrayContaining([extWt, extLog, extPlan]));

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('resolveInside refuses escapes, the base dir itself, and empty input', () => {
    expect(resolveInside(paths.worktreesDir, null)).toBeNull();
    expect(resolveInside(paths.worktreesDir, paths.worktreesDir)).toBeNull();
    expect(resolveInside(paths.worktreesDir, path.join(paths.worktreesDir, '..', 'evil'))).toBeNull();
    const inside = path.join(paths.worktreesDir, 'ok');
    expect(resolveInside(paths.worktreesDir, inside)).toBe(inside);
  });
});

describe('REST — DELETE /api/tasks/:id', () => {
  it('404s for an unknown task', async () => {
    app = buildApp({ db, apiToken: null });
    const r = await app.inject({ method: 'DELETE', url: '/api/tasks/t_nope' });
    expect(r.statusCode).toBe(404);
  });

  it('refuses an active (queued) task without force, deletes with ?force=1', async () => {
    app = buildApp({ db, apiToken: null });
    const id = mk('queued');

    const blocked = await app.inject({ method: 'DELETE', url: `/api/tasks/${id}` });
    expect(blocked.statusCode).toBe(409);
    expect(getTask(db, id)).toBeTruthy();

    const forced = await app.inject({ method: 'DELETE', url: `/api/tasks/${id}?force=1` });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().deleted).toBe(id);
    expect(getTask(db, id)).toBeUndefined();
  });

  it('deletes a terminal task', async () => {
    app = buildApp({ db, apiToken: null });
    const id = mk('closed');
    const r = await app.inject({ method: 'DELETE', url: `/api/tasks/${id}` });
    expect(r.statusCode).toBe(200);
    expect(getTask(db, id)).toBeUndefined();
  });
});

describe('REST — POST /api/tasks/prune', () => {
  it('deletes only terminal tasks, sparing active/blocked/review even if requested', async () => {
    app = buildApp({ db, apiToken: null });
    const closed = mk('closed');
    const failed = mk('failed');
    const spared = [mk('running'), mk('verifying'), mk('queued'), mk('blocked'), mk('review')];

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/prune',
      payload: { status: ['closed', 'failed', 'running', 'verifying', 'queued', 'blocked', 'review'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(new Set(body.ids)).toEqual(new Set([closed, failed]));
    for (const id of spared) expect(getTask(db, id)).toBeTruthy();
    for (const id of [closed, failed]) expect(getTask(db, id)).toBeUndefined();
  });

  it('dryRun reports the would-delete set but deletes nothing', async () => {
    app = buildApp({ db, apiToken: null });
    const id = mk('closed');
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/prune',
      payload: { dryRun: true },
    });
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.ids).toContain(id);
    expect(getTask(db, id)).toBeTruthy();
  });
});
