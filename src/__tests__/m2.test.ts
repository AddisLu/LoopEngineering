import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, logEvent } from '../db/index.js';
import { createTask, getTask, setStatus, latestRun } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { tick } from '../scheduler/tick.js';
import { buildApp } from '../server/app.js';
import { boardState } from '../server/board.js';
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

const API_MOCK_BODY = {
  title: 'api task',
  goal: 'do a thing',
  plan_ref: 'https://example.com/p.md',
  coding_tool: 'mock',
  verification_steps: 'true',
  complexity: 'S',
};

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
  delete process.env.LOOP_TEST_TIMEOUT_MS;
});

/** Count how many candidates a single tick would dispatch (without actually running them). */
function dispatchCount(now?: Date): number {
  const disp: string[] = [];
  tick(db, { inflightCount: () => 0, startRun: (t) => disp.push(t.id), now });
  return disp.length;
}

describe('fit budget (hard-limit band + safety reserve)', () => {
  it('packs against the sessionMax->hard_limit band, not just sessionMax headroom', () => {
    setSetting(db, 'day_window', '08:00-23:00');
    setSetting(db, 'hard_limit_pct', '95');
    setSetting(db, 'safety_reserve_pct', '5');
    setCachedUsage(60, 10); // session 60%

    const t = createTask(db, { ...MOCK_TASK, complexity: 'M' }); // est 8
    setStatus(db, t.id, 'queued');

    // Day sessionMax=65 → old headroom (65-60=5) < est 8 would have rejected this.
    // New fit budget = (95-5)-60 = 30 ≥ 8 → it dispatches. That's the reclaimed band.
    expect(dispatchCount(new Date('2026-07-04T10:00:00'))).toBe(1);
  });

  it('keeps a safety reserve below the hard limit even inside the start gate', () => {
    setSetting(db, 'hard_limit_pct', '95');
    setSetting(db, 'safety_reserve_pct', '5');
    setCachedUsage(88, 10); // session 88%

    const t = createTask(db, { ...MOCK_TASK, complexity: 'M' }); // est 8
    setStatus(db, t.id, 'queued');

    // Night sessionMax=92 → start gate passes (88<92), but fit budget = (95-5)-88 = 2 < 8,
    // so we hold rather than risk pushing the run past the breaker.
    expect(dispatchCount(new Date('2026-07-04T02:00:00'))).toBe(0);
  });
});

describe('verify failure is resumable (retry with a cap)', () => {
  it('blocks-for-resume on verify failure, then fails once the resume cap is hit', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    setSetting(db, 'max_resumes', '1');
    const t = createTask(db, { ...MOCK_TASK, verification_steps: ['false'] }); // verify always fails
    setStatus(db, t.id, 'queued');

    // 1st attempt: coding succeeds, verify fails → blocked (resumable), not failed.
    await runTask(db, getTask(db, t.id)!, {});
    let cur = getTask(db, t.id)!;
    expect(cur.status).toBe('blocked');
    expect(cur.resume_count).toBe(1);

    // failure context handed to the resume via a file in the worktree
    const run = latestRun(db, t.id)!;
    expect(fs.existsSync(path.join(run.worktree_path!, 'LOOP_RESUME_CONTEXT.md'))).toBe(true);

    // 2nd attempt (resume): now at the cap (1/1) → terminal failure.
    await runTask(db, getTask(db, t.id)!, { resume: true });
    cur = getTask(db, t.id)!;
    expect(cur.status).toBe('failed');
  });
});

describe('MCP auto-queue cap', () => {
  it('caps auto-queue at max_autoqueue but leaves manual queueing uncapped', async () => {
    const app = buildApp({ db, apiToken: null });
    try {
      setSetting(db, 'max_autoqueue', '1');
      const mk = async () =>
        (await app.inject({ method: 'POST', url: '/api/tasks', payload: API_MOCK_BODY })).json().task;
      const a = await mk();
      const b = await mk();

      expect((await app.inject({ method: 'POST', url: `/api/tasks/${a.id}/queue?auto=1` })).statusCode).toBe(200);

      const rej = await app.inject({ method: 'POST', url: `/api/tasks/${b.id}/queue?auto=1` });
      expect(rej.statusCode).toBe(429);
      expect(rej.json().error).toMatch(/autoqueue/);

      // a human queueing from the board/CLI is intentional and not rate-limited
      expect((await app.inject({ method: 'POST', url: `/api/tasks/${b.id}/queue` })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('scheduler reason on the board', () => {
  it('surfaces the latest persisted scheduler reason', () => {
    expect(boardState(db).reason).toBeNull();
    logEvent(db, { kind: 'scheduler', detail: 'session 82% >= 65%' });
    logEvent(db, { kind: 'scheduler', detail: 'at concurrency' });
    expect(boardState(db).reason).toBe('at concurrency');
  });
});

describe('task result endpoint', () => {
  it('reports status, pr_url and a log tail for a finished task', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    const app = buildApp({ db, apiToken: null });
    try {
      const t = createTask(db, MOCK_TASK);
      setStatus(db, t.id, 'queued');
      await runTask(db, getTask(db, t.id)!, {});

      const res = await app.inject({ method: 'GET', url: `/api/tasks/${t.id}/result` });
      expect(res.statusCode).toBe(200);
      const r = res.json();
      expect(r.status).toBe('review');
      expect(r).toHaveProperty('pr_url');
      expect(Array.isArray(r.log_tail)).toBe(true);
      expect(r.log_tail.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
