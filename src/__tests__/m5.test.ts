import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { openTestDb, setSetting, getNum } from '../db/index.js';
import { createTask, getTask, setStatus, createRun, getRun } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { tick, type TickInfo } from '../scheduler/tick.js';
import { checkWindowSwitch } from '../scheduler/breaker.js';
import { estimateWeeklyPct } from '../token/accounting.js';
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

// A daytime instant, used so resolvePolicy(now) === 'day' with the default 08:00-23:00 window.
const DAY = new Date('2026-07-04T10:00:00');

beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'day_window', '08:00-23:00');
  setCachedUsage(10, 10);
});
afterEach(() => {
  db.close();
  delete process.env.LOOP_TEST_TIMEOUT_MS;
  delete process.env.MOCK_SLEEP_MS;
});

// ---- helpers ----

/** One tick with a no-op dispatcher; returns the decision info (dispatched[] reflects choices). */
function runTick(opts: { now?: Date; inflight?: number } = {}): TickInfo {
  return tick(db, { inflightCount: () => opts.inflight ?? 0, startRun: () => {}, now: opts.now });
}

/** One tick that actually fires runTask, collecting the promises (as in m1). */
function tickAndCollect(now?: Date): Promise<void>[] {
  const started: Promise<void>[] = [];
  tick(db, { inflightCount: () => 0, startRun: (t, o) => started.push(runTask(db, t, o)), now });
  return started;
}

function fmtUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
/** Backdate a task's updated_at (= queued-since) so aging sees a wait. */
function backdateQueued(taskId: string, now: Date, minsAgo: number): void {
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(fmtUtc(new Date(now.getTime() - minsAgo * 60_000)), taskId);
}

function insertActiveRun(taskId: string, sessionBefore: number, weeklyBefore: number): string {
  const id = `r_${nanoid(8)}`;
  db.prepare(
    'INSERT INTO task_runs (id, task_id, attempt, session_pct_before, weekly_pct_before) VALUES (?,?,1,?,?)',
  ).run(id, taskId, sessionBefore, weeklyBefore);
  return id;
}

function queued(overrides: Partial<typeof MOCK_TASK> & { priority?: number } = {}): string {
  const t = createTask(db, { ...MOCK_TASK, ...overrides });
  setStatus(db, t.id, 'queued');
  return t.id;
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('waitFor timeout'));
      }
    }, 25);
  });
}

// ============================================================================
// #1 day/night window checkpoint
// ============================================================================
describe('#1 window-switch checkpoint', () => {
  it('records dispatch_window + weekly_pct_before on a real run', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    await runTask(db, getTask(db, t.id)!, {});
    const run = db.prepare('SELECT * FROM task_runs WHERE task_id=?').get(t.id) as any;
    expect(['day', 'night']).toContain(run.dispatch_window);
    expect(run.weekly_pct_before).not.toBeNull();
    expect(run.weekly_pct_after).not.toBeNull();
  });

  it('checkWindowSwitch interrupts only runs whose window flipped', () => {
    const a = createTask(db, MOCK_TASK); // stale (night) run — should checkpoint
    const b = createTask(db, MOCK_TASK); // current (day) run — should be left alone
    const c = createTask(db, MOCK_TASK); // already being killed — should be skipped
    const ra = insertActiveRun(a.id, 10, 10);
    const rb = insertActiveRun(b.id, 10, 10);
    const rc = insertActiveRun(c.id, 10, 10);
    db.prepare('UPDATE task_runs SET dispatch_window=? WHERE id=?').run('night', ra);
    db.prepare('UPDATE task_runs SET dispatch_window=? WHERE id=?').run('day', rb);
    db.prepare('UPDATE task_runs SET dispatch_window=?, interrupted_by=? WHERE id=?').run('night', 'breaker', rc);

    checkWindowSwitch(db, 'day');

    expect(getRun(db, ra)!.interrupted_by).toBe('window');
    expect(getRun(db, rb)!.interrupted_by).toBeNull();
    expect(getRun(db, rc)!.interrupted_by).toBe('breaker'); // untouched
  });

  it('tick only checkpoints when the feature flag is on', () => {
    const t = createTask(db, MOCK_TASK);
    const r = insertActiveRun(t.id, 10, 10);
    db.prepare('UPDATE task_runs SET dispatch_window=? WHERE id=?').run('night', r);

    setSetting(db, 'window_checkpoint', 'false');
    runTick({ now: DAY, inflight: 1 });
    expect(getRun(db, r)!.interrupted_by).toBeNull();

    setSetting(db, 'window_checkpoint', 'true');
    runTick({ now: DAY, inflight: 1 });
    expect(getRun(db, r)!.interrupted_by).toBe('window');
  });

  it('checkpoints a live run to blocked (resumable) then re-enters it', async () => {
    setSetting(db, 'window_checkpoint', 'true');
    process.env.MOCK_SLEEP_MS = '5000';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    const p = runTask(db, getTask(db, t.id)!, {});
    await waitFor(() => !!(db.prepare('SELECT session_id FROM task_runs WHERE task_id=?').get(t.id) as any)?.session_id);
    // Force the in-flight run's dispatch window to differ from the tick's window.
    db.prepare('UPDATE task_runs SET dispatch_window=? WHERE task_id=?').run('night', t.id);

    tick(db, { inflightCount: () => 1, startRun: () => {}, now: DAY });
    await p;

    const blocked = getTask(db, t.id)!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.resume_count).toBe(1);
    const run = db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(t.id) as any;
    expect(run.interrupted_by).toBe('window');
    expect(run.session_id).toBeTruthy(); // kept for --resume

    // re-enter under the new window's budget
    setSetting(db, 'window_checkpoint', 'false');
    process.env.MOCK_SLEEP_MS = '200';
    const started = tickAndCollect();
    expect(started.length).toBe(1);
    await Promise.all(started);
    expect(getTask(db, t.id)!.status).toBe('review');
  });
});

// ============================================================================
// #2 weekly budget in packing
// ============================================================================
describe('#2 weekly packing', () => {
  it('estimateWeeklyPct uses the seed until 5 samples, then the measured median', () => {
    const t = createTask(db, { ...MOCK_TASK, complexity: 'M' });
    expect(estimateWeeklyPct(db, 'M')).toBe(getNum(db, 'est_weekly_pct_M', 3));
    // 5 weekly deltas 2,3,4,5,6 -> median 4
    for (const [b, a] of [[10, 12], [20, 23], [30, 34], [40, 45], [50, 56]]) {
      db.prepare(
        `INSERT INTO task_runs (id, task_id, attempt, weekly_pct_before, weekly_pct_after, finished_at)
         VALUES (?, ?, 1, ?, ?, datetime('now'))`,
      ).run(`r_${nanoid(8)}`, t.id, b, a);
    }
    expect(estimateWeeklyPct(db, 'M')).toBe(4);
  });

  it('weekly headroom can be the binding fit constraint', () => {
    // session has lots of room, weekly almost none (78/80). est_weekly_M(3) > 2 -> no fit.
    setCachedUsage(10, 78);
    const id = queued({ complexity: 'M' });

    setSetting(db, 'weekly_packing', 'true');
    expect(runTick({ now: DAY }).dispatched.length).toBe(0);

    // with weekly packing off, only session is checked -> it dispatches
    setSetting(db, 'weekly_packing', 'false');
    const info = runTick({ now: DAY });
    expect(info.dispatched.map((d) => d.taskId)).toContain(id);
  });
});

// ============================================================================
// #3 concurrency reservation
// ============================================================================
describe('#3 concurrency reservation', () => {
  it('reserves an in-flight run’s unspent cost so packing cannot over-commit', () => {
    setSetting(db, 'max_concurrency', '2');
    setCachedUsage(30, 10); // session headroom 35 (day max 65)

    // an in-flight L run that just started (spent ~0, est 20 still to come)
    const active = createTask(db, { ...MOCK_TASK, complexity: 'L' });
    setStatus(db, active.id, 'running');
    insertActiveRun(active.id, 30, 10);

    const qId = queued({ complexity: 'L' }); // est 20

    // reserve ON: 35 - 20(reserved) = 15 < 20 -> does not fit
    setSetting(db, 'concurrency_reserve', 'true');
    expect(runTick({ now: DAY, inflight: 1 }).dispatched.length).toBe(0);

    // reserve OFF: raw 35 >= 20 -> over-commits (dispatches)
    setSetting(db, 'concurrency_reserve', 'false');
    expect(runTick({ now: DAY, inflight: 1 }).dispatched.map((d) => d.taskId)).toContain(qId);
  });
});

// ============================================================================
// #4 priority aging + starvation reserve
// ============================================================================
describe('#4 priority aging', () => {
  it('aging lifts a long-waiting low-priority task above a fresh higher one', () => {
    setSetting(db, 'age_step_min', '30');
    const aged = queued({ priority: 1 }); // waited 200m -> +6 -> eff 7
    const fresh = queued({ priority: 5 }); // eff 5
    backdateQueued(aged, DAY, 200);
    backdateQueued(fresh, DAY, 0);

    // aging OFF: base priority wins -> fresh dispatched first (cap 1)
    setSetting(db, 'priority_aging', 'false');
    expect(runTick({ now: DAY }).dispatched[0]?.taskId).toBe(fresh);

    // aging ON: aged task overtakes
    setSetting(db, 'priority_aging', 'true');
    expect(runTick({ now: DAY }).dispatched[0]?.taskId).toBe(aged);
  });

  it('reserves headroom for a starving top task instead of dispatching cheaper low-priority work', () => {
    setSetting(db, 'priority_aging', 'true');
    setSetting(db, 'starve_min', '60');
    setCachedUsage(61, 10); // session headroom 4 (day max 65)

    const bigStarving = queued({ priority: 9, complexity: 'L' }); // est 20 -> can't fit
    const cheap = queued({ priority: 1, complexity: 'S' }); // est 3 -> would fit
    backdateQueued(bigStarving, DAY, 120); // waited past starve threshold
    backdateQueued(cheap, DAY, 0);

    const info = runTick({ now: DAY });
    expect(info.dispatched.length).toBe(0); // cheap work is held back
    expect(info.reason).toMatch(/reserving headroom/);

    // With aging off, the cheap task jumps the queue (the starvation this prevents).
    setSetting(db, 'priority_aging', 'false');
    expect(runTick({ now: DAY }).dispatched.map((d) => d.taskId)).toContain(cheap);
  });
});
