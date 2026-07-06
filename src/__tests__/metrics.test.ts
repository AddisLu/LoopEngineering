import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { computeMetrics } from '../server/metrics.js';
import { buildApp } from '../server/app.js';

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

/** 'YYYY-MM-DD' for N days before today, UTC — matches computeMetrics' own day keying. */
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Seed one fully-shaped task (created/queued/running/closed events + task row) at
 * caller-controlled timestamps, so throughput/cycle-time buckets are deterministic
 * regardless of when the test runs.
 */
function seedClosedTask(
  db: Database.Database,
  opts: {
    createdDay: string; // 'YYYY-MM-DD'
    closedDay: string;
    estPct?: number | null;
    attention?: boolean;
    mergeStatus?: string | null;
    parentTaskId?: string | null;
  },
): string {
  const t = createTask(db, {
    title: `task ${opts.createdDay}->${opts.closedDay}`,
    goal: 'g',
    coding_tool: 'mock',
    verification_steps: ['true'],
    complexity: 'S',
  });
  const createdAt = `${opts.createdDay} 08:00:00`;
  const queuedAt = `${opts.createdDay} 08:05:00`;
  const runningAt = `${opts.createdDay} 08:10:00`;
  const reviewAt = `${opts.closedDay} 08:30:00`;
  const closedAt = `${opts.closedDay} 09:00:00`;

  db.prepare(`UPDATE tasks SET created_at = ?, updated_at = ?, status = 'closed', est_session_pct = ?,
      merge_status = ?, parent_task_id = ? WHERE id = ?`).run(
    createdAt,
    closedAt,
    opts.estPct ?? null,
    opts.mergeStatus ?? null,
    opts.parentTaskId ?? null,
    t.id,
  );
  db.prepare(`UPDATE task_events SET created_at = ? WHERE task_id = ? AND to_status = 'draft'`).run(createdAt, t.id);
  const ins = db.prepare(
    `INSERT INTO task_events (task_id, kind, from_status, to_status, created_at) VALUES (?, 'status', ?, ?, ?)`,
  );
  ins.run(t.id, 'draft', 'queued', queuedAt);
  ins.run(t.id, 'queued', 'running', runningAt);
  if (opts.attention) ins.run(t.id, 'running', 'attention', `${opts.createdDay} 09:20:00`);
  ins.run(t.id, opts.attention ? 'attention' : 'running', 'review', reviewAt);
  ins.run(t.id, 'review', 'closed', closedAt);
  return t.id;
}

describe('computeMetrics', () => {
  it('buckets closed tasks per day, computes rates/cycle-time/token-cost/autonomy', () => {
    const today = isoDaysAgo(0);
    const twoDaysAgo = isoDaysAgo(2);

    seedClosedTask(db, { createdDay: twoDaysAgo, closedDay: twoDaysAgo, estPct: 5 });
    seedClosedTask(db, { createdDay: twoDaysAgo, closedDay: today, estPct: 10, attention: true });
    seedClosedTask(db, { createdDay: today, closedDay: today, estPct: 7, mergeStatus: 'merged' });
    seedClosedTask(db, { createdDay: today, closedDay: today, parentTaskId: 't_parent' });

    db.prepare(`INSERT INTO task_events (kind, detail, created_at) VALUES ('note', 'self-update: rebuilding', ?)`).run(
      `${today} 09:30:00`,
    );

    const m = computeMetrics(db, { days: 3 });

    expect(m.days).toBe(3);
    const byDay = Object.fromEntries(m.throughput.by_day.map((d) => [d.day, d.count]));
    expect(byDay[twoDaysAgo]).toBe(1);
    expect(byDay[today]).toBe(3);
    expect(m.throughput.total_closed).toBe(4);
    expect(m.throughput.by_day.length).toBe(3); // days=3 window, zero-filled

    expect(m.status_counts.closed).toBe(4);

    // funnel: all 4 tasks were created within the 3-day window
    expect(m.funnel.created).toBe(4);
    expect(m.funnel.closed).toBe(4);
    expect(m.funnel.close_rate).toBe(1);
    expect(m.funnel.went_attention).toBe(1);
    expect(m.funnel.attention_rate).toBeCloseTo(0.25);
    expect(m.funnel.went_failed).toBe(0);

    // cycle time: task 2 took 2 days (2880 min) created->closed; others same-day (~24h=1440min)
    expect(m.cycle_time.sample).toBe(4);
    expect(m.cycle_time.avg_min).toBeGreaterThan(0);
    expect(m.cycle_time.median_min).toBeGreaterThan(0);
    expect(m.cycle_time.dispatch_avg_min).toBeCloseTo(5, 1); // queued->running = 5 min every time

    // token cost
    expect(m.token_cost.avg_pct).toBeCloseTo((5 + 10 + 7) / 3);
    expect(m.token_cost.recent.length).toBe(4);

    // autonomy
    expect(m.autonomy.self_updates).toBe(1);
    expect(m.autonomy.auto_merged).toBe(1);
    expect(m.autonomy.merge_conflict_tasks).toBe(1);
  });

  it('empty DB → zeros, no crash', () => {
    const m = computeMetrics(db, { days: 14 });
    expect(m.throughput.total_closed).toBe(0);
    expect(m.throughput.by_day.length).toBe(14);
    expect(m.throughput.by_day.every((d) => d.count === 0)).toBe(true);
    expect(m.funnel.created).toBe(0);
    expect(m.funnel.close_rate).toBe(0);
    expect(m.funnel.attention_rate).toBe(0);
    expect(m.cycle_time.sample).toBe(0);
    expect(m.cycle_time.avg_min).toBeNull();
    expect(m.cycle_time.median_min).toBeNull();
    expect(m.token_cost.avg_pct).toBeNull();
    expect(m.token_cost.recent).toEqual([]);
    expect(m.usage_trend).toEqual([]);
    expect(m.autonomy).toEqual({ self_updates: 0, auto_merged: 0, merge_conflict_tasks: 0 });
    expect(Object.keys(m.status_counts).length).toBe(0);
  });

  it('defaults to 14 days', () => {
    expect(computeMetrics(db).days).toBe(14);
  });
});

describe('GET /api/metrics', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('returns a 200 metrics snapshot shaped like computeMetrics', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toBe(14);
    expect(body).toHaveProperty('throughput');
    expect(body).toHaveProperty('status_counts');
    expect(body).toHaveProperty('funnel');
    expect(body).toHaveProperty('cycle_time');
    expect(body).toHaveProperty('token_cost');
    expect(body).toHaveProperty('usage_trend');
    expect(body).toHaveProperty('autonomy');
  });

  it('clamps ?days to [1, 90]', async () => {
    app = buildApp({ db, apiToken: null });
    expect((await app.inject({ method: 'GET', url: '/api/metrics?days=0' })).json().days).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/metrics?days=500' })).json().days).toBe(90);
    expect((await app.inject({ method: 'GET', url: '/api/metrics?days=7' })).json().days).toBe(7);
    expect((await app.inject({ method: 'GET', url: '/api/metrics?days=notanumber' })).json().days).toBe(14);
  });

  it('401s without a bearer token when one is configured', async () => {
    app = buildApp({ db, apiToken: 'secret' });
    const noauth = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(noauth.statusCode).toBe(401);
    const withAuth = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: { authorization: 'Bearer secret' },
    });
    expect(withAuth.statusCode).toBe(200);
  });
});

describe('team-prep columns (owner/created_by)', () => {
  it('round-trip through createTask, default to null when unset', () => {
    const t = createTask(db, { title: 'x', goal: 'g', coding_tool: 'mock', verification_steps: ['true'] });
    expect(t.owner).toBeNull();
    expect(t.created_by).toBeNull();

    const withOwner = createTask(db, {
      title: 'y',
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['true'],
      owner: 'alice',
      created_by: 'bob',
    });
    expect(withOwner.owner).toBe('alice');
    expect(withOwner.created_by).toBe('bob');
    expect(getTask(db, withOwner.id)!.owner).toBe('alice');
  });

  it('migrate() is idempotent (re-running openTestDb-style setup does not error)', () => {
    // openTestDb already ran schema+migrate once in beforeEach; open a second in-memory
    // DB to exercise the migration path again from scratch without crashing.
    const db2 = openTestDb();
    try {
      const t = createTask(db2, { title: 'x', goal: 'g', coding_tool: 'mock', verification_steps: ['true'] });
      expect(t.owner).toBeNull();
    } finally {
      db2.close();
    }
  });
});
