import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, setStatus } from '../tasks.js';
import { setCachedUsage } from '../token/usage.js';
import { forecastBacklog } from '../token/accounting.js';
import { boardState } from '../server/board.js';
import { buildApp } from '../server/app.js';

let db: Database.Database;

const BASE_TASK = {
  title: 't',
  goal: 'g',
  plan_ref: 'https://example.com/plan.md',
  plan_kind: 'url' as const,
  coding_tool: 'mock',
  verification_steps: ['true'],
};

beforeEach(() => {
  db = openTestDb();
  // force the "day" window regardless of wall-clock time so sessionMax/weeklyMax
  // (and hence verdict/capacity numbers) are deterministic in CI.
  setSetting(db, 'day_window', '00:00-24:00');
});
afterEach(() => db.close());

function seedTask(complexity: 'S' | 'M' | 'L', status: string): void {
  const t = createTask(db, { ...BASE_TASK, complexity });
  if (status !== 'draft') setStatus(db, t.id, status as any);
}

describe('forecastBacklog', () => {
  it('sums weekly cost over pending tasks (default estimates: S=1/M=3/L=6 weekly, S=3/M=8/L=20 session)', () => {
    seedTask('L', 'queued');
    seedTask('L', 'running');
    seedTask('M', 'blocked');
    seedTask('M', 'verifying');
    // terminal — must be excluded from the backlog entirely
    seedTask('L', 'closed');
    seedTask('L', 'failed');
    seedTask('M', 'review');
    seedTask('M', 'attention');

    setCachedUsage(15, 20); // session 15%, weekly 20%

    const f = forecastBacklog(db);
    expect(f.pending).toBe(4);
    expect(f.by_complexity).toEqual({ S: 0, M: 2, L: 2 });
    expect(f.weekly_backlog_pct).toBe(2 * 6 + 2 * 3); // 18
    expect(f.weekly_now).toBe(20);
    expect(f.weekly_max).toBe(80);
    expect(f.weekly_headroom).toBe(80 - 20 - 18); // 42
    expect(f.capacity_more_M).toBe(Math.floor(42 / 3)); // 14
    expect(f.capacity_more_L).toBe(Math.floor(42 / 6)); // 7
    expect(f.session_now).toBe(15);
    expect(f.session_max).toBe(65);
    expect(f.largest_task_session_pct).toBe(20); // biggest single est (L), NOT summed
    expect(f.largest_task_session_fits).toBe(true); // 20 <= 95 - 5
    expect(f.verdict).toBe('plenty');
  });

  it('does not sum session% across the backlog — largest single task only', () => {
    seedTask('S', 'queued');
    seedTask('M', 'queued');
    seedTask('L', 'queued');
    setCachedUsage(50, 10);
    const f = forecastBacklog(db);
    // if this were a sum it would be 3+8+20=31, not the max
    expect(f.largest_task_session_pct).toBe(20);
  });

  it('verdict thresholds by weekly headroom (empty backlog, headroom = weekly_max - weekly_now)', () => {
    setCachedUsage(10, 20); // headroom = 80-20 = 60 -> capacity_more_M = 20
    expect(forecastBacklog(db).verdict).toBe('plenty');

    setCachedUsage(10, 74); // headroom = 6 -> capacity_more_M = 2
    expect(forecastBacklog(db).verdict).toBe('some');

    setCachedUsage(10, 78); // headroom = 2 -> capacity_more_M = 0, but > 0
    expect(forecastBacklog(db).verdict).toBe('tight');

    setCachedUsage(10, 85); // headroom = max(0, -5) = 0
    expect(forecastBacklog(db).verdict).toBe('full');
  });

  it('empty backlog -> zeros and full headroom (plenty)', () => {
    setCachedUsage(10, 10);
    const f = forecastBacklog(db);
    expect(f.pending).toBe(0);
    expect(f.by_complexity).toEqual({ S: 0, M: 0, L: 0 });
    expect(f.weekly_backlog_pct).toBe(0);
    expect(f.largest_task_session_pct).toBe(0);
    expect(f.largest_task_session_fits).toBe(true);
    expect(f.weekly_headroom).toBe(80 - 10);
    expect(f.verdict).toBe('plenty');
  });

  it('is read-only: does not touch task rows or settings', () => {
    seedTask('M', 'queued');
    setCachedUsage(10, 10);
    const before = db.prepare('SELECT * FROM tasks').all();
    forecastBacklog(db);
    const after = db.prepare('SELECT * FROM tasks').all();
    expect(after).toEqual(before);
  });
});

describe('GET /api/forecast + BoardState.forecast', () => {
  it('exposes the forecast over REST and on the board snapshot', async () => {
    seedTask('L', 'queued');
    setCachedUsage(10, 10);

    const app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: '/api/forecast' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pending).toBe(1);
    expect(body.by_complexity).toEqual({ S: 0, M: 0, L: 1 });
    expect(typeof body.weekly_headroom).toBe('number');
    expect(typeof body.verdict).toBe('string');

    const board = boardState(db);
    expect(board.forecast).toEqual({
      weekly_backlog_pct: body.weekly_backlog_pct,
      weekly_headroom: body.weekly_headroom,
      capacity_more_M: body.capacity_more_M,
      verdict: body.verdict,
    });
    await app.close();
  });
});
