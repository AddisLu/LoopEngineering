import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus, createRun, finishRun, tasksForPrune } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { killRun } from '../orchestrator/kill.js';
import { tick } from '../scheduler/tick.js';
import { addWorktree } from '../git/worktree.js';
import { buildApp } from '../server/app.js';
import { boardState } from '../server/board.js';
import { routeStatusEvent } from '../notify.js';
import { setCachedUsage } from '../token/usage.js';
import { paths } from '../config.js';
import type { TaskStatus } from '../config.js';

let db: Database.Database;
let app: FastifyInstance | undefined;
let tmpRoots: string[] = [];

const MOCK_TASK = {
  title: 'attention task',
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
  tmpRoots = [];
});
afterEach(async () => {
  await app?.close();
  db.close();
  delete process.env.LOOP_TEST_TIMEOUT_MS;
  delete process.env.MOCK_SLEEP_MS;
  delete process.env.MOCK_EXIT;
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
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

const runRow = (taskId: string): any =>
  db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId);

const waitForSession = (taskId: string) => waitFor(() => !!runRow(taskId)?.session_id);

// hermetic local git fixture (no network)
function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function makeRepo(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `loop-attn-${tag}-`));
  tmpRoots.push(root);
  const repo = path.join(root, 'repo');
  git(root, ['init', '-b', 'main', 'repo']);
  git(repo, ['config', 'user.email', 'loop@test.local']);
  git(repo, ['config', 'user.name', 'Loop Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'v1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--no-verify', '-m', 'seed']);
  return repo;
}

/** attention task backed by a real repo + worktree on branch loop/<id>, with a run row. */
function attentionTaskWithWorktree(tag: string): { id: string; repo: string; wt: string } {
  const repo = makeRepo(tag);
  const t = createTask(db, { ...MOCK_TASK, repo_path: repo, base_branch: 'main' });
  const wt = addWorktree(repo, `loop/${t.id}`, 'main', { fetchBase: false });
  const run = createRun(db, { task_id: t.id, worktree_path: wt.path, branch: `loop/${t.id}` });
  finishRun(db, run.id, { session_id: 'sid-fixture', exit_code: 1 });
  setStatus(db, t.id, 'attention', { detail: 'fixture failure' });
  return { id: t.id, repo, wt: wt.path };
}

// ---- 1. watchdog timeout -> attention ----

describe('watchdog timeout routes to attention', () => {
  it('holds the task with the watchdog detail; worktree preserved', async () => {
    process.env.MOCK_SLEEP_MS = '10000';
    process.env.LOOP_TEST_TIMEOUT_MS = '400'; // fires first
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    expect(getTask(db, t.id)!.status).toBe('attention');
    expect(latestEventDetail(t.id, 'attention')).toBe('watchdog timeout');
    const run = runRow(t.id);
    expect(run.interrupted_by).toBe('timeout');
    expect(fs.existsSync(run.worktree_path)).toBe(true); // preserved for triage
  });
});

// ---- 2. adapter failure -> attention ----

describe('adapter error routes to attention', () => {
  it('MOCK_EXIT=1 lands in attention with the exit detail', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    process.env.MOCK_EXIT = '1';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    expect(getTask(db, t.id)!.status).toBe('attention');
    expect(latestEventDetail(t.id, 'attention')).toMatch(/exit=1/);
  });
});

// ---- 3. interrupt with exhausted resume budget -> attention ----

describe('breaker interrupt past the resume budget routes to attention', () => {
  it('holds instead of failing, keeping the session for a manual 續跑', async () => {
    process.env.MOCK_SLEEP_MS = '5000';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    db.prepare('UPDATE tasks SET resume_count = ? WHERE id = ?').run(2, t.id); // at the cap (max 2)

    const p = runTask(db, getTask(db, t.id)!, {});
    await waitForSession(t.id);
    const run = runRow(t.id);
    killRun(db, { id: run.id, pid: run.pid }, 'breaker');
    await p;

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('attention');
    expect(done.resume_count).toBe(3);
    expect(latestEventDetail(t.id, 'attention')).toMatch(/resume limit/);
    expect(runRow(t.id).session_id).toBeTruthy(); // kept for /resume
  });
});

// ---- 4. final verify failure -> attention ----

describe('final verify failure routes to attention', () => {
  it('holds with worktree + LOOP_RESUME_CONTEXT.md when the resume budget is spent', async () => {
    process.env.MOCK_SLEEP_MS = '200';
    setSetting(db, 'max_resumes', '0'); // no auto-resume budget -> straight to attention
    const t = createTask(db, { ...MOCK_TASK, verification_steps: ['false'] });
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    expect(getTask(db, t.id)!.status).toBe('attention');
    expect(latestEventDetail(t.id, 'attention')).toMatch(/verify failed at/);
    const run = runRow(t.id);
    expect(fs.existsSync(run.worktree_path)).toBe(true);
    expect(fs.existsSync(path.join(run.worktree_path, 'LOOP_RESUME_CONTEXT.md'))).toBe(true);
  });
});

// ---- 5. ABORT RACE regression: user abort is terminal ----

describe('abort race', () => {
  it('a mid-flight abort STAYS failed (not overwritten to blocked / auto-resumed)', async () => {
    process.env.MOCK_SLEEP_MS = '5000';
    app = buildApp({ db, apiToken: null });
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    const p = runTask(db, getTask(db, t.id)!, {});
    await waitForSession(t.id);

    const res = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/abort` });
    expect(res.statusCode).toBe(200);
    await p; // the run's own interrupt handling completes AFTER the endpoint

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('failed'); // terminal — the old bug flipped this to blocked
    expect(runRow(t.id).interrupted_by).toBe('user');

    // and the scheduler never resumes it
    const dispatched: string[] = [];
    tick(db, { inflightCount: () => 0, startRun: (task) => dispatched.push(task.id) });
    expect(dispatched).toEqual([]);
    expect(getTask(db, t.id)!.status).toBe('failed');
  });
});

// ---- 6. pause --hard regression: stays resumable via reason 'pause' ----

describe('pause --hard', () => {
  it('interrupts with reason pause -> blocked (resumable), not terminal failed', async () => {
    process.env.MOCK_SLEEP_MS = '5000';
    app = buildApp({ db, apiToken: null });
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    const p = runTask(db, getTask(db, t.id)!, {});
    await waitForSession(t.id);

    const res = await app.inject({ method: 'POST', url: '/api/pause?hard=1' });
    expect(res.statusCode).toBe(200);
    await p;

    const cur = getTask(db, t.id)!;
    expect(cur.status).toBe('blocked');
    expect(runRow(t.id).interrupted_by).toBe('pause');
    expect(cur.resume_count).toBe(1); // within budget -> auto-resume eligible

    // unpause -> next tick resumes it to completion
    process.env.MOCK_SLEEP_MS = '200';
    setSetting(db, 'scheduler_paused', 'false');
    const started: Promise<void>[] = [];
    tick(db, { inflightCount: () => 0, startRun: (task, o) => started.push(runTask(db, task, o)) });
    expect(started.length).toBe(1);
    await Promise.all(started);
    expect(getTask(db, t.id)!.status).toBe('review');
  });
});

// ---- 7. POST /api/tasks/:id/resume ----

describe('POST /api/tasks/:id/resume', () => {
  it('attention -> blocked with resume_count clamped; the next tick dispatches a resume', async () => {
    app = buildApp({ db, apiToken: null });
    const id = mk('attention');
    const run = createRun(db, { task_id: id, worktree_path: '/tmp/x' });
    finishRun(db, run.id, { session_id: 'sid-1', exit_code: 130 });
    db.prepare('UPDATE tasks SET resume_count = ? WHERE id = ?').run(3, id); // budget exceeded

    const res = await app.inject({ method: 'POST', url: `/api/tasks/${id}/resume` });
    expect(res.statusCode).toBe(200);

    const cur = getTask(db, id)!;
    expect(cur.status).toBe('blocked');
    expect(cur.resume_count).toBe(2); // clamped to max_resumes -> exactly one more attempt

    const dispatched: { id: string; resume: boolean }[] = [];
    tick(db, { inflightCount: () => 0, startRun: (task, o) => dispatched.push({ id: task.id, resume: !!o.resume }) });
    expect(dispatched).toEqual([{ id, resume: true }]);
  });

  it('400 when the latest run has no session; 409 when not in attention', async () => {
    app = buildApp({ db, apiToken: null });
    const noSession = mk('attention');
    createRun(db, { task_id: noSession, worktree_path: '/tmp/x' }); // no session_id
    const r400 = await app.inject({ method: 'POST', url: `/api/tasks/${noSession}/resume` });
    expect(r400.statusCode).toBe(400);
    expect(r400.json().error).toMatch(/no session/);
    expect(getTask(db, noSession)!.status).toBe('attention'); // unchanged

    const wrong = mk('failed');
    const r409 = await app.inject({ method: 'POST', url: `/api/tasks/${wrong}/resume` });
    expect(r409.statusCode).toBe(409);
  });
});

// ---- 8. POST /api/tasks/:id/restart (real git fixture) ----

describe('POST /api/tasks/:id/restart', () => {
  it('deletes the loop/<id> branch + worktree and requeues fresh', async () => {
    app = buildApp({ db, apiToken: null });
    const { id, repo, wt } = attentionTaskWithWorktree('restart');
    db.prepare("UPDATE tasks SET resume_count = 3, pr_url = 'https://x/pr/1', merge_status = 'conflict' WHERE id = ?").run(id);
    expect(git(repo, ['rev-parse', '--verify', `loop/${id}`]).trim()).toBeTruthy();

    const res = await app.inject({ method: 'POST', url: `/api/tasks/${id}/restart` });
    expect(res.statusCode).toBe(200);

    expect(fs.existsSync(wt)).toBe(false); // worktree gone
    expect(() => git(repo, ['rev-parse', '--verify', `loop/${id}`])).toThrow(); // branch DELETED
    const cur = getTask(db, id)!;
    expect(cur.status).toBe('queued');
    expect(cur.resume_count).toBe(0);
    expect(cur.pr_url).toBeNull();
    expect(cur.merge_status).toBeNull();
    expect(latestEventDetail(id, 'queued')).toMatch(/restart/);
  });

  it('409 for a status outside attention/failed', async () => {
    app = buildApp({ db, apiToken: null });
    const id = mk('review');
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${id}/restart` });
    expect(res.statusCode).toBe(409);
  });
});

// ---- 9. POST /api/tasks/:id/abandon ----

describe('POST /api/tasks/:id/abandon', () => {
  it('marks the task failed and keeps the worktree by default', async () => {
    app = buildApp({ db, apiToken: null });
    const { id, wt } = attentionTaskWithWorktree('abandon-keep');

    const res = await app.inject({ method: 'POST', url: `/api/tasks/${id}/abandon` });
    expect(res.statusCode).toBe(200);
    expect(getTask(db, id)!.status).toBe('failed');
    expect(latestEventDetail(id, 'failed')).toBe('abandoned by user');
    expect(fs.existsSync(wt)).toBe(true); // still there for post-mortem
  });

  it('?cleanup=1 also removes the worktree; 409 when not in attention', async () => {
    app = buildApp({ db, apiToken: null });
    const { id, wt } = attentionTaskWithWorktree('abandon-clean');

    const res = await app.inject({ method: 'POST', url: `/api/tasks/${id}/abandon?cleanup=1` });
    expect(res.statusCode).toBe(200);
    expect(getTask(db, id)!.status).toBe('failed');
    expect(fs.existsSync(wt)).toBe(false);

    const wrong = mk('blocked');
    const r409 = await app.inject({ method: 'POST', url: `/api/tasks/${wrong}/abandon` });
    expect(r409.statusCode).toBe(409);
  });
});

// ---- 10. queue guard: drafts only ----

describe('POST /api/tasks/:id/queue from-status guard', () => {
  it('409s for non-draft statuses (hint: use /restart) but still queues drafts', async () => {
    app = buildApp({ db, apiToken: null });
    for (const status of ['attention', 'failed', 'review'] as TaskStatus[]) {
      const id = mk(status);
      const res = await app.inject({ method: 'POST', url: `/api/tasks/${id}/queue` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/restart/);
      expect(getTask(db, id)!.status).toBe(status); // untouched
    }
    const draft = mk('draft');
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${draft}/queue` })).statusCode).toBe(200);
    expect(getTask(db, draft)!.status).toBe('queued');
  });
});

// ---- 11. prune never touches attention ----

describe('tasksForPrune', () => {
  it('never returns attention tasks, even when explicitly requested', () => {
    const id = mk('attention');
    expect(tasksForPrune(db, { status: ['attention'] })).toEqual([]);
    expect(tasksForPrune(db).map((t) => t.id)).not.toContain(id);
  });
});

// ---- 12. routeStatusEvent unit mapping ----

describe('routeStatusEvent', () => {
  it('maps attention/blocked/review/failed and ignores the rest', () => {
    const attn = routeStatusEvent({ task_id: 't_1', to_status: 'attention', detail: 'watchdog timeout' })!;
    expect(attn.priority).toBe('high');
    expect(attn.title).toMatch(/待確認/);
    expect(attn.message).toMatch(/t_1/);
    expect(attn.message).toMatch(/watchdog timeout/);

    // previously dead code: blocked events were selected by SQL but never handled
    const blocked = routeStatusEvent({ task_id: 't_2', to_status: 'blocked', detail: 'interrupted: breaker' })!;
    expect(blocked.priority).toBe('default');
    expect(blocked.message).toMatch(/auto-resume/);

    const merged = routeStatusEvent({ task_id: 't_3', to_status: 'review', detail: null, merge_status: 'merged' })!;
    expect(merged.priority).toBe('default');
    expect(merged.message).toMatch(/已自動併入/);
    const conflict = routeStatusEvent({ task_id: 't_3', to_status: 'review', detail: null, merge_status: 'conflict' })!;
    expect(conflict.priority).toBe('high');
    expect(conflict.message).toMatch(/合併衝突/);
    const pending = routeStatusEvent({ task_id: 't_3', to_status: 'review', detail: null, merge_status: 'pending' })!;
    expect(pending.message).toMatch(/待合併/);

    const failed = routeStatusEvent({ task_id: 't_4', to_status: 'failed', detail: 'aborted by user' })!;
    expect(failed.priority).toBe('high');
    expect(failed.message).toMatch(/aborted by user/);

    expect(routeStatusEvent({ task_id: 't_5', to_status: 'running', detail: null })).toBeNull();
    expect(routeStatusEvent({ task_id: 't_6', to_status: null, detail: null })).toBeNull();
  });
});

// ---- 13. board card for an attention task ----

describe('board state for attention', () => {
  it('carries fail_detail and the latest run logTail', () => {
    const t = createTask(db, MOCK_TASK);
    const logPath = path.join(paths.logsDir, `${t.id}-attn-test.jsonl`);
    fs.writeFileSync(
      logPath,
      JSON.stringify({ type: 'assistant', text: 'working on it' }) + '\n' +
        JSON.stringify({ type: 'result', subtype: 'error' }) + '\n',
    );
    const run = createRun(db, { task_id: t.id, worktree_path: '/tmp/x', log_path: logPath });
    finishRun(db, run.id, { exit_code: 1 });
    setStatus(db, t.id, 'attention', { run_id: run.id, detail: 'exit=1 subtype=error' });

    const card = boardState(db).cards.find((c) => c.id === t.id)!;
    expect(card.status).toBe('attention');
    expect(card.fail_detail).toBe('exit=1 subtype=error');
    expect(Array.isArray(card.logTail)).toBe(true);
    expect(card.logTail!.length).toBeGreaterThan(0);
    expect(card.logTail!.join('\n')).toMatch(/working on it/);

    fs.rmSync(logPath, { force: true });
  });
});
