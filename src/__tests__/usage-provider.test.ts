import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, setStatus, createRun } from '../tasks.js';
import { readUsage, setCachedUsage } from '../token/usage.js';
import { checkBreaker } from '../scheduler/breaker.js';
import { tick } from '../scheduler/tick.js';

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

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh (ignored once LOOP_USAGE_PROVIDER=none short-circuits)
});
afterEach(() => {
  db.close();
  delete process.env.LOOP_USAGE_PROVIDER;
});

describe('usage_provider=none — benign reading', () => {
  it('readUsage returns a healthy 0%-used "disabled" reading', () => {
    process.env.LOOP_USAGE_PROVIDER = 'none';
    const r = readUsage();
    expect(r.ok).toBe(true);
    expect(r.source).toBe('disabled');
    expect(r.session.percent).toBe(0);
    expect(r.weekly.percent).toBe(0);
  });

  it('the percent breaker never trips on the benign reading', () => {
    process.env.LOOP_USAGE_PROVIDER = 'none';
    expect(checkBreaker(db, readUsage(), 95)).toBe(false);
  });

  it('a tick still dispatches a queued task (fit-gate degrades to always-fits)', () => {
    process.env.LOOP_USAGE_PROVIDER = 'none';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    const info = tick(db, { inflightCount: () => 0, startRun: () => {} });
    expect(info.dispatched.map((d) => d.taskId)).toContain(t.id);
  });
});

describe('request-cap gate — the layer-1 limiter when usage_provider=none', () => {
  function seedRuns(n: number): void {
    const t = createTask(db, MOCK_TASK); // draft; its runs just populate the count
    for (let i = 0; i < n; i++) createRun(db, { task_id: t.id });
  }

  it('blocks dispatch once request_daily_max is reached', () => {
    seedRuns(2);
    setSetting(db, 'request_daily_max', '2');
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    const info = tick(db, { inflightCount: () => 0, startRun: () => {} });
    expect(info.dispatched).toHaveLength(0);
    expect(info.reason).toMatch(/request cap/);
  });

  it('allows dispatch when under the cap', () => {
    seedRuns(2);
    setSetting(db, 'request_daily_max', '3');
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    const info = tick(db, { inflightCount: () => 0, startRun: () => {} });
    expect(info.dispatched.map((d) => d.taskId)).toContain(t.id);
  });

  it('is zero-impact when unset (default 0 disables the gate)', () => {
    seedRuns(5);
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    const info = tick(db, { inflightCount: () => 0, startRun: () => {} });
    expect(info.dispatched.map((d) => d.taskId)).toContain(t.id);
  });
});
