import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus, listTasks, createRun } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { runTask } from '../orchestrator/run.js';
import { recoverOnStartup } from '../orchestrator/recovery.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { tick } from '../scheduler/tick.js';
import { setCachedUsage } from '../token/usage.js';
import type { Task } from '../types.js';

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
  setCachedUsage(10, 10); // safe, fresh
});
afterEach(() => {
  db.close();
  delete process.env.LOOP_TEST_TIMEOUT_MS;
  delete process.env.MOCK_SLEEP_MS;
});

/** run a single tick with a trivial inline dispatcher that awaits each run. */
function tickAndCollect(now?: Date): Promise<void>[] {
  const started: Promise<void>[] = [];
  tick(db, {
    inflightCount: () => 0,
    startRun: (t, o) => started.push(runTask(db, t, o)),
    now,
  });
  return started;
}

describe('intake gate', () => {
  it('blocks a task missing verification_steps', () => {
    const t = createTask(db, { ...MOCK_TASK, verification_steps: [] });
    const g = validateTask(getTask(db, t.id)!);
    expect(g.ok).toBe(false);
    expect(g.missing.join(' ')).toMatch(/verification_steps/);
  });

  it('passes a complete mock task', () => {
    const t = createTask(db, MOCK_TASK);
    expect(validateTask(getTask(db, t.id)!).ok).toBe(true);
  });
});

describe('policy day/night', () => {
  it('is day inside window, night outside', () => {
    setSetting(db, 'day_window', '08:00-23:00');
    expect(resolvePolicy(db, new Date('2026-07-04T10:00:00')).window).toBe('day');
    expect(resolvePolicy(db, new Date('2026-07-04T02:00:00')).window).toBe('night');
  });
});

describe('mock E2E (zero token)', () => {
  it('runs draft->queued->running->verifying->review', async () => {
    process.env.MOCK_SLEEP_MS = '300';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');

    const events = db.prepare('SELECT to_status FROM task_events WHERE task_id=? AND kind=?').all(t.id, 'status') as {
      to_status: string;
    }[];
    const seq = events.map((e) => e.to_status);
    expect(seq).toEqual(expect.arrayContaining(['running', 'verifying', 'review']));

    const run = db.prepare('SELECT * FROM task_runs WHERE task_id=?').get(t.id) as any;
    expect(run.finished_at).toBeTruthy();
    expect(run.session_pct_before).not.toBeNull();
  });
});

describe('watchdog timeout', () => {
  it('kills an overrunning run and marks the task failed', async () => {
    process.env.MOCK_SLEEP_MS = '10000'; // 10s
    process.env.LOOP_TEST_TIMEOUT_MS = '400'; // fires first
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    expect(getTask(db, t.id)!.status).toBe('failed');
    const run = db.prepare('SELECT * FROM task_runs WHERE task_id=?').get(t.id) as any;
    expect(run.interrupted_by).toBe('timeout');
  });
});

describe('circuit breaker -> blocked -> auto-resume', () => {
  it('interrupts on hard limit, blocks (not fails), then resumes when usage drops', async () => {
    process.env.MOCK_SLEEP_MS = '5000';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    // start (do not await); wait until the child is really up (session_id streamed in)
    const p = runTask(db, getTask(db, t.id)!, {});
    await waitFor(() => !!(db.prepare('SELECT session_id FROM task_runs WHERE task_id=?').get(t.id) as any)?.session_id);

    // breaker: force session over hard limit, then tick
    setCachedUsage(96, 10);
    tick(db, { inflightCount: () => 1, startRun: () => {} });
    await p;

    const blocked = getTask(db, t.id)!;
    expect(blocked.status).toBe('blocked');
    const run = db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(t.id) as any;
    expect(run.interrupted_by).toBe('breaker');
    expect(run.session_id).toBeTruthy(); // kept for resume
    expect(blocked.resume_count).toBe(1);

    // recover: usage drops -> next tick should auto-resume the blocked task
    process.env.MOCK_SLEEP_MS = '200';
    setCachedUsage(10, 10);
    const started = tickAndCollect();
    expect(started.length).toBe(1);
    await Promise.all(started);
    expect(getTask(db, t.id)!.status).toBe('review');
  });
});

describe('resume budget exhaustion escalates to failed', () => {
  it('fails (not blocks) a breaker-interrupted task once resume_count exceeds max_resumes', async () => {
    process.env.MOCK_SLEEP_MS = '5000';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    // pretend it has already been auto-resumed up to the limit (max_resumes default 2)
    db.prepare('UPDATE tasks SET resume_count = ? WHERE id = ?').run(2, t.id);

    const p = runTask(db, getTask(db, t.id)!, {});
    await waitFor(() => !!(db.prepare('SELECT session_id FROM task_runs WHERE task_id=?').get(t.id) as any)?.session_id);

    // breaker trips
    setCachedUsage(96, 10);
    tick(db, { inflightCount: () => 1, startRun: () => {} });
    await p;

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('failed'); // NOT a zombie 'blocked'
    expect(done.resume_count).toBe(3); // 2 -> bumped to 3, which is > max_resumes
    const run = db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(t.id) as any;
    expect(run.interrupted_by).toBe('breaker');
    const ev = db
      .prepare("SELECT detail FROM task_events WHERE task_id=? AND kind='status' AND to_status='failed' ORDER BY id DESC LIMIT 1")
      .get(t.id) as any;
    expect(String(ev?.detail)).toMatch(/resume limit/);
  });
});

describe('crash recovery', () => {
  it('orphans a run whose process is gone and blocks its task', () => {
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'running');
    createRun(db, { task_id: t.id, worktree_path: '/tmp/x', session_pct_before: 10 });
    // fake pid that is not alive
    db.prepare('UPDATE task_runs SET pid=? WHERE task_id=?').run(2_000_000_000, t.id);

    recoverOnStartup(db);

    expect(getTask(db, t.id)!.status).toBe('blocked');
    const run = db.prepare('SELECT * FROM task_runs WHERE task_id=?').get(t.id) as any;
    expect(run.interrupted_by).toBe('orphaned');
    expect(run.finished_at).toBeTruthy();
  });
});

describe('pause blocks new dispatch', () => {
  it('does not dispatch while paused', () => {
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    setSetting(db, 'scheduler_paused', 'true');
    const started = tickAndCollect();
    expect(started.length).toBe(0);
    expect(listTasks(db, 'queued').length).toBe(1);
  });

  it('dispatches when safe and unpaused', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    const started = tickAndCollect();
    expect(started.length).toBe(1);
    await Promise.all(started);
    expect(getTask(db, t.id)!.status).toBe('review');
  });
});

// ---- helpers ----
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

export type { Task };
