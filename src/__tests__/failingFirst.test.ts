import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';
import os from 'node:os';
import { reproCheckOf, reproDryRun } from '../checks/failingFirst.js';

let db: Database.Database;

const repro = (command: string, over: Record<string, unknown> = {}) => ({
  id: 'ck_repro',
  repo_id: 'r_x',
  name: '重現',
  kind: 'repro',
  machine: null,
  command,
  pass_rule: 'exit0',
  metrics: null,
  thresholds: null,
  baseline: null,
  baseline_tol: 0,
  dataset: null,
  test_globs: [],
  red_on_base: true,
  timeout_min: null,
  required: true,
  ord: 0,
  protected_paths: [],
  artifacts: [],
  manual_text: null,
  metric_prefix: null,
  ...over,
});

function ticket(command: string, over: Record<string, unknown> = {}): string {
  const t = createTask(db, {
    title: '除以零',
    goal: '修好除以零',
    plan_ref: 'https://example.com/plan.md',
    plan_kind: 'url',
    coding_tool: 'mock',
    verification_steps: ['true'],
    complexity: 'S',
  });
  db.prepare('UPDATE tasks SET checks_json = ? WHERE id = ?').run(JSON.stringify([repro(command, over)]), t.id);
  setStatus(db, t.id, 'queued');
  return t.id;
}

const events = (id: string, kind: string) =>
  (db.prepare('SELECT detail FROM task_events WHERE task_id = ? AND kind = ? ORDER BY id').all(id, kind) as { detail: string }[]).map((e) => e.detail);
const lastRun = (id: string) => db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(id) as { id: string; worktree_path: string; error: string | null };

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  process.env.MOCK_SLEEP_MS = '50';
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
});

describe('先失敗再修 (failing_first)', () => {
  it('off by default: the repro command never runs', async () => {
    const id = ticket('echo ran >> ff-marker; exit 1');
    await runTask(db, getTask(db, id)!, {});
    expect(getTask(db, id)!.status).toBe('review');
    expect(fs.existsSync(path.join(lastRun(id).worktree_path, 'ff-marker'))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_runs WHERE kind = 'repro_before'").get()).toEqual({ n: 0 });
  });

  it('a repro that fails on base goes to the agent as 重現輸出（修改前）', async () => {
    setSetting(db, 'failing_first', 'true');
    const id = ticket("echo 'ZeroDivisionError: division by zero'; exit 1");
    await runTask(db, getTask(db, id)!, {});
    expect(getTask(db, id)!.status).toBe('review');
    const run = lastRun(id);
    const md = fs.readFileSync(path.join(run.worktree_path, 'LOOP_TASK.md'), 'utf8');
    expect(md).toContain('## 重現輸出（修改前');
    expect(md).toContain('ZeroDivisionError: division by zero');
    const cr = db.prepare("SELECT kind, ok, task_id, run_id FROM check_runs WHERE check_id = 'ck_repro'").get();
    expect(cr).toEqual({ kind: 'repro_before', ok: 0, task_id: id, run_id: run.id });
    expect(events(id, 'note')).toContain('先失敗再修：重現指令在修改前失敗了（正確）');
  });

  it('a repro that already passes stops the task before any dispatch', async () => {
    setSetting(db, 'failing_first', 'true');
    const id = ticket("echo 'all good'; exit 0");
    await runTask(db, getTask(db, id)!, {});
    expect(getTask(db, id)!.status).toBe('attention');
    expect(events(id, 'dispatch')).toEqual([]);
    expect(events(id, 'status').pop()).toContain('重現指令在修改前就通過了');
    expect(lastRun(id).error).toBe('repro passed before the fix');
  });

  it('only on the first run: a later run (退回修改, 換模型) does not re-run it', async () => {
    setSetting(db, 'failing_first', 'true');
    const id = ticket('exit 0');
    db.prepare("INSERT INTO task_runs (id, task_id, started_at, finished_at) VALUES ('run_old', ?, datetime('now', '-1 hour'), datetime('now', '-50 minutes'))").run(id);
    await runTask(db, getTask(db, id)!, {});
    expect(getTask(db, id)!.status).toBe('review');
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_runs WHERE kind = 'repro_before'").get()).toEqual({ n: 0 });
  });

  it('only a 重現 with a command that is meant to be red on base', () => {
    const snap = (c: Record<string, unknown>) => ({ checks_json: JSON.stringify([c]) });
    expect(reproCheckOf(snap(repro('make repro')))?.id).toBe('ck_repro');
    expect(reproCheckOf(snap(repro('make repro', { red_on_base: false })))).toBeNull();
    expect(reproCheckOf(snap(repro('  ')))).toBeNull();
    expect(reproCheckOf(snap(repro('make test', { kind: 'test' })))).toBeNull();
    expect(reproCheckOf({ checks_json: null })).toBeNull();
  });

  it('the 分析卡 試跑 runs the typed command on the repo clone and records nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ff-'));
    try {
      const repo = { id: 'r_x', local_path: dir, machine: null, default_branch: 'main' };
      const red = await reproDryRun(db, { id: 't_x', base_branch: 'main' }, repo, { command: "pwd; echo 'Traceback'; exit 3" });
      expect(red).toMatchObject({ ok: false, exit_code: 3 });
      expect(red.tail).toContain(fs.realpathSync(dir));
      expect(red.tail).toContain('Traceback');
      expect((await reproDryRun(db, { id: 't_x', base_branch: null }, repo, { command: 'true' })).ok).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM check_runs').get()).toEqual({ n: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
