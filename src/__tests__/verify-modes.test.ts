import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus, createRun } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { parseVerifyMode } from '../types.js';
import { runTask, runVerifyPipeline } from '../orchestrator/run.js';
import { runLlmJudge, type JudgeExec } from '../orchestrator/judge.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
  delete process.env.LOOP_TEST_TIMEOUT_MS;
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-verify-${tag}-`));
  tmpRoots.push(d);
  return d;
}

const MOCK_TASK = {
  title: 'mock task',
  goal: 'do a thing',
  plan_ref: 'https://example.com/plan.md',
  plan_kind: 'url' as const,
  coding_tool: 'mock',
  verification_steps: ['true'],
  complexity: 'S' as const,
};

// ---- 1. runLlmJudge ----

describe('runLlmJudge', () => {
  const JUDGE_TASK = {
    title: 't',
    goal: 'do x',
    coding_tool: 'claude-code',
    verify_rubric: 'must do x correctly',
  };

  it('parses a passing judge response', async () => {
    const t = getTask(db, createTask(db, JUDGE_TASK).id)!;
    const exec: JudgeExec = async () => JSON.stringify({ pass: true, reason: 'looks right' });
    const r = await runLlmJudge(db, t, '/tmp', 'main', exec);
    expect(r).toEqual({ pass: true, reason: 'looks right' });
  });

  it('parses a failing judge response', async () => {
    const t = getTask(db, createTask(db, JUDGE_TASK).id)!;
    const exec: JudgeExec = async () => JSON.stringify({ pass: false, reason: 'missing X' });
    const r = await runLlmJudge(db, t, '/tmp', 'main', exec);
    expect(r).toEqual({ pass: false, reason: 'missing X' });
  });

  it('garbage output is inconclusive (pass: null), never an auto-pass', async () => {
    const t = getTask(db, createTask(db, JUDGE_TASK).id)!;
    const exec: JudgeExec = async () => 'not json {{{';
    const r = await runLlmJudge(db, t, '/tmp', 'main', exec);
    expect(r.pass).toBeNull();
  });

  it('skips (never calls exec) for a mock task', async () => {
    const t = getTask(db, createTask(db, { ...JUDGE_TASK, coding_tool: 'mock' }).id)!;
    let calls = 0;
    const exec: JudgeExec = async () => {
      calls++;
      return JSON.stringify({ pass: true, reason: 'x' });
    };
    const r = await runLlmJudge(db, t, '/tmp', 'main', exec);
    expect(r).toEqual({ pass: null, reason: 'skipped' });
    expect(calls).toBe(0);
  });

  it('skips (never calls exec) when session usage is already at/over hard_limit_pct', async () => {
    setCachedUsage(96, 10); // hard_limit_pct default is 95
    const t = getTask(db, createTask(db, JUDGE_TASK).id)!;
    let calls = 0;
    const exec: JudgeExec = async () => {
      calls++;
      return JSON.stringify({ pass: true, reason: 'x' });
    };
    const r = await runLlmJudge(db, t, '/tmp', 'main', exec);
    expect(r).toEqual({ pass: null, reason: 'skipped' });
    expect(calls).toBe(0);
  });
});

// ---- 2. runVerifyPipeline routing ----

describe('runVerifyPipeline routing', () => {
  function setup(input: Partial<Parameters<typeof createTask>[1]> = {}) {
    const t = createTask(db, {
      title: 't',
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['true'],
      ...input,
    });
    const wt = mkTmpDir('pipeline');
    const run = createRun(db, { task_id: t.id, worktree_path: wt });
    return { task: getTask(db, t.id)!, worktree: wt, runId: run.id };
  }

  it('command-only: pass', async () => {
    const { task, worktree, runId } = setup({ verification_steps: ['true'] });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('pass');
  });

  it('command-only: fail routes through handleVerifyFailure (blocked/attention)', async () => {
    const { task, worktree, runId } = setup({ verification_steps: ['false'] });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('fail');
    expect(['blocked', 'attention']).toContain(getTask(db, task.id)!.status);
  });

  it('manual-only: "manual" with zero verification steps (gate never runs a shell step)', async () => {
    const { task, worktree, runId } = setup({ verify_mode: 'manual', verification_steps: [] });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('manual');
  });

  it('llm inconclusive (mock guard) downgrades to "manual"', async () => {
    const { task, worktree, runId } = setup({
      coding_tool: 'mock',
      verify_mode: 'llm',
      verify_rubric: 'must work',
      verification_steps: [],
    });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('manual');
  });

  it('llm pass (injected judge) -> "pass"', async () => {
    const { task, worktree, runId } = setup({
      coding_tool: 'claude-code',
      verify_mode: 'llm',
      verify_rubric: 'must work',
      verification_steps: [],
    });
    const exec: JudgeExec = async () => JSON.stringify({ pass: true, reason: 'ok' });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main', exec)).toBe('pass');
  });

  it('llm fail (injected judge) -> "fail", routed through handleVerifyFailure', async () => {
    const { task, worktree, runId } = setup({
      coding_tool: 'claude-code',
      verify_mode: 'llm',
      verify_rubric: 'must work',
      verification_steps: [],
    });
    const exec: JudgeExec = async () => JSON.stringify({ pass: false, reason: 'nope' });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main', exec)).toBe('fail');
    expect(['blocked', 'attention']).toContain(getTask(db, task.id)!.status);
  });

  it('command+llm: both must pass — a failing command short-circuits before the judge ever runs', async () => {
    let calls = 0;
    const exec: JudgeExec = async () => {
      calls++;
      return JSON.stringify({ pass: true, reason: 'ok' });
    };
    const { task, worktree, runId } = setup({
      coding_tool: 'claude-code',
      verify_mode: 'command,llm',
      verify_rubric: 'must work',
      verification_steps: ['false'],
    });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main', exec)).toBe('fail');
    expect(calls).toBe(0);
  });

  it('command+llm: both passing -> "pass"', async () => {
    const { task, worktree, runId } = setup({
      coding_tool: 'claude-code',
      verify_mode: 'command,llm',
      verify_rubric: 'must work',
      verification_steps: ['true'],
    });
    const exec: JudgeExec = async () => JSON.stringify({ pass: true, reason: 'ok' });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main', exec)).toBe('pass');
  });
});

// ---- 3. configurable verify timeout ----

describe('configurable verify timeout', () => {
  function setup(input: Partial<Parameters<typeof createTask>[1]> = {}) {
    const t = createTask(db, {
      title: 't',
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['sleep 1.2'],
      ...input,
    });
    const wt = mkTmpDir('timeout');
    const run = createRun(db, { task_id: t.id, worktree_path: wt });
    return { task: getTask(db, t.id)!, worktree: wt, runId: run.id };
  }

  it('honors a per-task verify_timeout_min override (kills a step that overruns it)', async () => {
    const { task, worktree, runId } = setup({ verify_timeout_min: 0.01 }); // 600ms
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('fail');
  }, 10_000);

  it('falls back to the verify_step_timeout_min setting when the task has no override', async () => {
    setSetting(db, 'verify_step_timeout_min', '0.01'); // 600ms
    const { task, worktree, runId } = setup();
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('fail');
  }, 10_000);

  it('a generous timeout (task override) lets the same step pass', async () => {
    const { task, worktree, runId } = setup({ verify_timeout_min: 1 }); // 60s, plenty for `sleep 1.2`
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('pass');
  }, 10_000);
});

// ---- 4. gate relaxation ----

describe('gate relaxation for verify_mode', () => {
  it('manual-only task passes the gate with zero verification steps', () => {
    const t = createTask(db, { ...MOCK_TASK, verify_mode: 'manual', verification_steps: [] });
    expect(validateTask(getTask(db, t.id)!).ok).toBe(true);
  });

  it('an llm-mode task without a rubric fails the gate (missing verify_rubric)', () => {
    const t = createTask(db, { ...MOCK_TASK, verify_mode: 'llm', verification_steps: ['true'] });
    const g = validateTask(getTask(db, t.id)!);
    expect(g.ok).toBe(false);
    expect(g.missing).toContain('verify_rubric');
  });

  it('an llm-mode task WITH a rubric passes the gate', () => {
    const t = createTask(db, {
      ...MOCK_TASK,
      verify_mode: 'llm',
      verify_rubric: 'must work correctly',
      verification_steps: ['true'],
    });
    expect(validateTask(getTask(db, t.id)!).ok).toBe(true);
  });

  it('a command-mode (default) task still requires >= 1 verification step', () => {
    const t = createTask(db, { ...MOCK_TASK, verification_steps: [] });
    const g = validateTask(getTask(db, t.id)!);
    expect(g.ok).toBe(false);
    expect(g.missing.join(' ')).toMatch(/verification_steps/);
  });
});

// ---- 5. e2e (mock adapter): manual verify mode ----

describe('e2e (mock adapter): verify_mode=manual', () => {
  it('reaches review with merge_status=pending and a 待人工驗證 detail', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, { ...MOCK_TASK, verify_mode: 'manual', verification_steps: [] });
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');
    expect(done.merge_status).toBe('pending');

    const ev = db
      .prepare(
        `SELECT detail FROM task_events WHERE task_id=? AND kind='status' AND to_status='review' ORDER BY id DESC LIMIT 1`,
      )
      .get(t.id) as { detail: string };
    expect(ev.detail).toMatch(/待人工驗證/);
  });
});

// ---- 6. existing suites (default verify_mode='command') stay green ----

describe('zero behavior change for the default verify_mode', () => {
  it('parseVerifyMode defaults to {command} when unset', () => {
    const t = getTask(db, createTask(db, MOCK_TASK).id)!;
    expect(t.verify_mode).toBe('command');
    expect(parseVerifyMode(t)).toEqual(new Set(['command']));
  });

  it('the mock E2E still ends in review with merge_status untouched (null)', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');
    expect(done.merge_status).toBeNull();
  });
});
