import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus, deleteTask, dependencyState } from '../tasks.js';
import { tick, type TickInfo } from '../scheduler/tick.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;

const MOCK_TASK = {
  title: 'mock task',
  goal: 'do a thing',
  plan_ref: 'https://example.com/plan.md',
  plan_kind: 'url' as const,
  coding_tool: 'mock',
  verification_steps: ['true'],
  complexity: 'S' as const,
};

const DAY = new Date('2026-07-04T10:00:00');

beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'day_window', '08:00-23:00');
  setCachedUsage(10, 10);
});
afterEach(() => db.close());

/** One tick with a no-op dispatcher; dispatched[] reflects the scheduler's choices. */
function runTick(): TickInfo {
  return tick(db, { inflightCount: () => 0, startRun: () => {}, now: DAY });
}

describe('depends_on: creation + state', () => {
  it('persists depends_on and reports dependency state transitions', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });
    expect(getTask(db, b.id)!.depends_on).toBe(a.id);

    expect(dependencyState(db, getTask(db, b.id)!)).toBe('waiting');
    setStatus(db, a.id, 'failed');
    expect(dependencyState(db, getTask(db, b.id)!)).toBe('dep-failed');
    setStatus(db, a.id, 'closed');
    expect(dependencyState(db, getTask(db, b.id)!)).toBe('satisfied');
    deleteTask(db, a.id);
    expect(dependencyState(db, getTask(db, b.id)!)).toBe('dep-missing');

    const solo = createTask(db, MOCK_TASK);
    expect(dependencyState(db, getTask(db, solo.id)!)).toBe('none');
  });
});

describe('depends_on: scheduler hold on queued tasks', () => {
  it('never dispatches a queued task whose dependency is not closed', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });
    setStatus(db, b.id, 'queued');

    // dep in a live (non-closed) status -> held
    setStatus(db, a.id, 'review');
    expect(runTick().dispatched).toHaveLength(0);

    // dep failed -> still held (human must resolve)
    setStatus(db, a.id, 'failed');
    expect(runTick().dispatched).toHaveLength(0);

    // dep closed -> dispatches
    setStatus(db, a.id, 'closed');
    const info = runTick();
    expect(info.dispatched.map((d) => d.taskId)).toEqual([b.id]);
  });

  it('holds a queued task whose dependency was deleted', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });
    setStatus(db, b.id, 'queued');
    deleteTask(db, a.id);
    expect(runTick().dispatched).toHaveLength(0);
  });
});

describe('depends_on: draft auto-queue on dependency close', () => {
  it('auto-queues a gate-ok draft when its dependency closes (and not before)', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });

    runTick();
    expect(getTask(db, b.id)!.status).toBe('draft'); // dep not closed yet

    setStatus(db, a.id, 'closed');
    const info = runTick();
    // released this very tick and (budget permitting) dispatched
    expect(getTask(db, b.id)!.status).not.toBe('draft');
    expect(info.dispatched.map((d) => d.taskId)).toContain(b.id);
  });

  it('leaves plain drafts (no depends_on) and gate-failing drafts alone', () => {
    const a = createTask(db, MOCK_TASK);
    setStatus(db, a.id, 'closed');
    const plain = createTask(db, MOCK_TASK); // no dep -> never auto-queued
    const gateless = createTask(db, {
      ...MOCK_TASK,
      title: 'no plan',
      plan_ref: null,
      plan_kind: null,
      depends_on: a.id,
    });
    runTick();
    expect(getTask(db, plain.id)!.status).toBe('draft');
    expect(getTask(db, gateless.id)!.status).toBe('draft'); // gate not ok -> stays draft
  });

  it('respects dep_auto_queue=false (chain release disabled)', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });
    setStatus(db, a.id, 'closed');
    setSetting(db, 'dep_auto_queue', 'false');
    runTick();
    expect(getTask(db, b.id)!.status).toBe('draft');
  });
});
