import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createRun, createTask, getTask, setStatus } from '../tasks.js';
import {
  TaskActionError,
  abandonTask,
  abortTask,
  closeTask,
  deleteTaskSafe,
  holdTask,
  killTaskRuns,
  queueTask,
  restartTask,
  resumeTask,
} from '../taskActions.js';

// The transitions the board routes and 對話操作 share: each refuses with the status and message
// the route always sent, and does exactly what the route did.
let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

const mk = (status?: string) => {
  const t = createTask(db, { title: 't', goal: 'a goal long enough', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true'], complexity: 'S' });
  if (status && status !== 'draft') setStatus(db, t.id, status as never);
  return t.id;
};
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TaskActionError) return { ...err.extra, code: err.status, error: err.message };
    throw err;
  }
  throw new Error('expected a refusal');
};

describe('task transitions (src/taskActions.ts)', () => {
  it('queue: only a draft whose gate passes; the auto path is capped by max_autoqueue', () => {
    expect(refusal(() => queueTask(db, 'nope')).code).toBe(404);
    expect(refusal(() => queueTask(db, mk('attention')))).toMatchObject({ code: 409, error: expect.stringContaining('only a draft') });
    const bad = createTask(db, { title: 'no plan', goal: 'g', coding_tool: 'claude-code', verification_steps: [] });
    expect(refusal(() => queueTask(db, bad.id))).toMatchObject({ code: 409, error: 'gate not satisfied' });
    expect(queueTask(db, mk()).status).toBe('queued');
    setSetting(db, 'max_autoqueue', '1');
    expect(refusal(() => queueTask(db, mk(), { auto: true }))).toMatchObject({ code: 429, limit: 1, active: 1 });
  });

  it('resume needs attention and a session; hold needs blocked; abandon needs attention', () => {
    const a = mk('attention');
    expect(refusal(() => resumeTask(db, a))).toMatchObject({ code: 400, error: 'no session — use restart' });
    const r = createRun(db, { task_id: a, worktree_path: '/tmp/x' });
    db.prepare("UPDATE task_runs SET session_id = 's1' WHERE id = ?").run(r.id);
    db.prepare('UPDATE tasks SET resume_count = 9 WHERE id = ?').run(a);
    const resumed = resumeTask(db, a);
    expect(resumed.status).toBe('blocked');
    expect(resumed.resume_count).toBe(2); // clamped to max_resumes: exactly one more attempt
    expect(holdTask(db, a).status).toBe('attention');
    expect(refusal(() => holdTask(db, a))).toMatchObject({ code: 409, error: 'task not blocked' });
    expect(abandonTask(db, a).status).toBe('failed');
    expect(refusal(() => abandonTask(db, a))).toMatchObject({ code: 409, error: 'task not in attention' });
  });

  it('restart only from attention/failed, clearing the retry budget and the merge state', () => {
    expect(refusal(() => restartTask(db, mk('review')))).toMatchObject({ code: 409 });
    const f = mk('failed');
    db.prepare("UPDATE tasks SET resume_count = 2, merge_status = 'conflict' WHERE id = ?").run(f);
    const t = restartTask(db, f);
    expect(t).toMatchObject({ status: 'queued', resume_count: 0, merge_status: null });
  });

  it('abort marks the task failed; delete refuses an active task unless forced', () => {
    const q = mk('queued');
    expect(refusal(() => deleteTaskSafe(db, q))).toMatchObject({ code: 409, error: expect.stringContaining('abort it first') });
    expect(deleteTaskSafe(db, q, { force: true })).toEqual({ deleted: q });
    expect(getTask(db, q)).toBeUndefined();
    const r = mk('running');
    expect(killTaskRuns(db, r)).toBe(0);
    expect(abortTask(db, r).status).toBe('failed');
  });

  it('close ends the task (no status guard here, as before: 對話操作 adds its own)', () => {
    expect(closeTask(db, mk('review'), { distillExec: async () => '' }).status).toBe('closed');
  });
});
