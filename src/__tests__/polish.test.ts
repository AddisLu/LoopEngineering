import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { createTask, getTask, setStatus, createRun, finishRun } from '../tasks.js';
import { runTask, runTaskSetup } from '../orchestrator/run.js';
import { tick } from '../scheduler/tick.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';
import type { TaskStatus } from '../config.js';

let db: Database.Database;
let app: FastifyInstance | undefined;

const MOCK_TASK = {
  title: 'polish task',
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
  app = undefined;
});
afterEach(async () => {
  await app?.close();
  db.close();
  delete process.env.LOOP_TEST_TIMEOUT_MS;
  delete process.env.MOCK_SLEEP_MS;
  delete process.env.MOCK_EXIT;
  delete process.env.MOCK_RESULT_SUBTYPE;
});

// ---- helpers ----

function mk(status: TaskStatus): string {
  const t = createTask(db, MOCK_TASK);
  if (status !== 'draft') setStatus(db, t.id, status);
  return t.id;
}

function latestEventDetail(taskId: string, toStatus: string): string {
  const ev = db
    .prepare("SELECT detail FROM task_events WHERE task_id=? AND kind='status' AND to_status=? ORDER BY id DESC LIMIT 1")
    .get(taskId, toStatus) as { detail: string | null } | undefined;
  return String(ev?.detail ?? '');
}

const runRow = (taskId: string): any =>
  db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId);

const eventCount = (taskId: string, kind: string, detailLike?: string): number => {
  const row = detailLike
    ? (db
        .prepare("SELECT COUNT(*) as n FROM task_events WHERE task_id=? AND kind=? AND detail LIKE ?")
        .get(taskId, kind, detailLike) as { n: number })
    : (db.prepare('SELECT COUNT(*) as n FROM task_events WHERE task_id=? AND kind=?').get(taskId, kind) as {
        n: number;
      });
  return row.n;
};

// ============================================================================
// #1/#2 shared dispatchFailed predicate closes both holes
// ============================================================================
describe('dispatchFailed predicate', () => {
  it('non-zero exit with subtype success -> attention, not verify (hole #1)', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    process.env.MOCK_EXIT = '1';
    process.env.MOCK_RESULT_SUBTYPE = 'success';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    const cur = getTask(db, t.id)!;
    expect(cur.status).toBe('attention');
    expect(latestEventDetail(t.id, 'attention')).toMatch(/exit=1 subtype=success/);
  });

  it('clean exit (0) with subtype error -> attention, not verify (hole #2)', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    process.env.MOCK_EXIT = '0';
    process.env.MOCK_RESULT_SUBTYPE = 'error';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    const cur = getTask(db, t.id)!;
    expect(cur.status).toBe('attention');
    expect(latestEventDetail(t.id, 'attention')).toMatch(/exit=0 subtype=error/);
  });

  it('clean mock run (exit 0, subtype success) still reaches review (regression)', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    expect(getTask(db, t.id)!.status).toBe('review');
  });
});

// ============================================================================
// #3 setup_cmd fail-fast
// ============================================================================
describe('setup_cmd fail-fast', () => {
  it('a failing setup_cmd fails fast to attention BEFORE any adapter dispatch, tail captured', async () => {
    const t = createTask(db, { ...MOCK_TASK, setup_cmd: "echo boom-marker; exit 1" });
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    const cur = getTask(db, t.id)!;
    expect(cur.status).toBe('attention');
    const detail = latestEventDetail(t.id, 'attention');
    expect(detail).toMatch(/setup_cmd failed \(exit=1\)/);
    expect(detail).toMatch(/boom-marker/);

    // no adapter was ever dispatched for this run
    expect(eventCount(t.id, 'dispatch')).toBe(0);

    // the run row carries the setup error and is finished
    const run = runRow(t.id);
    expect(run.error).toBe('setup failed');
    expect(run.finished_at).toBeTruthy();
  });

  it('a successful setup_cmd writes the sentinel and the run proceeds to review', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    const t = createTask(db, { ...MOCK_TASK, setup_cmd: 'true' });
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    expect(getTask(db, t.id)!.status).toBe('review');
    const run = runRow(t.id);
    // mock scratch dirs aren't git repos, so worktreeInternalFile falls back to a dotfile
    expect(fs.existsSync(path.join(run.worktree_path, '.loop-setup-done'))).toBe(true);
  });

  it('runTaskSetup skips a second call once the sentinel matches the unchanged command', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-setup-unit-'));
    try {
      const t = createTask(db, { ...MOCK_TASK, setup_cmd: 'true' });
      const task = getTask(db, t.id)!;
      const logPath = path.join(dir, 'setup.log');
      fs.writeFileSync(logPath, '');

      const first = await runTaskSetup(task, dir, logPath);
      expect(first.kind).toBe('ok');
      expect(fs.readFileSync(path.join(dir, '.loop-setup-done'), 'utf8')).toBe('true');

      const second = await runTaskSetup(task, dir, logPath);
      expect(second.kind).toBe('skipped');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// #4 blocked hold -> attention (轉待確認)
// ============================================================================
describe('POST /api/tasks/:id/hold', () => {
  it('blocked -> attention; non-blocked -> 409; a held task is not picked up by the next tick', async () => {
    app = buildApp({ db, apiToken: null });

    const nonBlocked = mk('queued');
    const r409 = await app.inject({ method: 'POST', url: `/api/tasks/${nonBlocked}/hold` });
    expect(r409.statusCode).toBe(409);
    expect(getTask(db, nonBlocked)!.status).toBe('queued');

    const id = mk('blocked');
    const run = createRun(db, { task_id: id, worktree_path: '/tmp/x' });
    finishRun(db, run.id, { session_id: 'sid-1' }); // eligible for auto-resume until held

    const res = await app.inject({ method: 'POST', url: `/api/tasks/${id}/hold` });
    expect(res.statusCode).toBe(200);
    expect(getTask(db, id)!.status).toBe('attention');
    expect(latestEventDetail(id, 'attention')).toMatch(/held by user/);

    const dispatched: string[] = [];
    tick(db, { inflightCount: () => 0, startRun: (task) => dispatched.push(task.id) });
    expect(dispatched).not.toContain(id);
  });
});

// ============================================================================
// #5 cold-start resume fallback regression (guards the dispatchFailed unification)
// ============================================================================
describe('cold-start resume fallback', () => {
  it('a failed --resume attempt still triggers exactly one cold-start retry', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    process.env.MOCK_EXIT = '1'; // both the resume attempt and the cold-start retry fail
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    // seed a prior run with a session_id so opts.resume resolves a resumeSessionId
    const prior = createRun(db, { task_id: t.id, worktree_path: '/tmp/prior' });
    finishRun(db, prior.id, { session_id: 'stale-session-id', exit_code: 0 });

    await runTask(db, getTask(db, t.id)!, { resume: true });

    // both attempts failed (MOCK_EXIT=1 throughout) -> ends in attention
    expect(getTask(db, t.id)!.status).toBe('attention');

    // the fallback fired exactly once...
    expect(eventCount(t.id, 'note', 'resume failed%')).toBe(1);

    // ...and a real second dispatch attempt happened (two independent mock processes,
    // each emitting one system/init line into the shared run log). started_at has only
    // second resolution, so pick the actual dispatched run by excluding the seeded prior.
    const run = db
      .prepare('SELECT * FROM task_runs WHERE task_id=? AND id != ? ORDER BY started_at DESC LIMIT 1')
      .get(t.id, prior.id) as any;
    const raw = fs.readFileSync(run.log_path, 'utf8');
    const initCount = (raw.match(/"subtype":"init"/g) || []).length;
    expect(initCount).toBe(2);
  });
});
