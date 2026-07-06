import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask, setStatus, createRun } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { unmetCapabilities } from '../capabilities.js';
import { runTask, runVerifyPipeline } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-caps-${tag}-`));
  tmpRoots.push(d);
  return d;
}

const MOCK_TASK = {
  title: 'aoi task',
  goal: 'do a thing',
  plan_ref: 'https://example.com/plan.md',
  plan_kind: 'url' as const,
  coding_tool: 'mock',
  verification_steps: ['true'],
  complexity: 'S' as const,
};

// ---- 1. unmetCapabilities ----

describe('unmetCapabilities', () => {
  it('gpu required + host has gpu -> []', () => {
    expect(unmetCapabilities({ requires: 'gpu' }, 'gpu,network')).toEqual([]);
  });

  it('camera required + host lacks it -> ["camera"]', () => {
    expect(unmetCapabilities({ requires: 'camera' }, 'gpu,network')).toEqual(['camera']);
  });

  it('os:windows is matched as a literal token', () => {
    expect(unmetCapabilities({ requires: 'os:windows' }, 'gpu,os:windows')).toEqual([]);
    expect(unmetCapabilities({ requires: 'os:windows' }, 'gpu,linux')).toEqual(['os:windows']);
  });

  it('case-insensitive matching', () => {
    expect(unmetCapabilities({ requires: 'GPU' }, 'gpu')).toEqual([]);
    expect(unmetCapabilities({ requires: 'gpu' }, 'GPU')).toEqual([]);
  });

  it('empty/null requires -> []', () => {
    expect(unmetCapabilities({ requires: null }, '')).toEqual([]);
    expect(unmetCapabilities({ requires: '' }, 'gpu')).toEqual([]);
  });

  it('mixed: some met, some not', () => {
    expect(unmetCapabilities({ requires: 'gpu, camera, network' }, 'gpu,network')).toEqual(['camera']);
  });
});

// ---- 2. runVerifyPipeline routing ----

describe('capability-gated runVerifyPipeline', () => {
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

  it('unmet capability skips command verification (a failing step never runs) and defers to manual', async () => {
    const { task, worktree, runId } = setup({ requires: 'camera', verification_steps: ['false'] });
    // host_capabilities defaults to '' — camera is unmet
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('manual');

    const ev = db
      .prepare(`SELECT detail FROM task_events WHERE task_id=? AND kind='note' ORDER BY id DESC LIMIT 1`)
      .get(task.id) as { detail: string };
    expect(ev.detail).toMatch(/capability\(s\) unavailable here: camera/);
  });

  it('met capability runs the command step normally (pass)', async () => {
    const { task, worktree, runId } = setup({ requires: 'gpu', verification_steps: ['true'] });
    const { setSetting } = await import('../db/index.js');
    setSetting(db, 'host_capabilities', 'gpu,network');
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('pass');
  });

  it('met capability still lets a failing command fail normally', async () => {
    const { task, worktree, runId } = setup({ requires: 'gpu', verification_steps: ['false'] });
    const { setSetting } = await import('../db/index.js');
    setSetting(db, 'host_capabilities', 'gpu,network');
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('fail');
  });

  it('requires null behaves identically to V1 (no capability note logged)', async () => {
    const { task, worktree, runId } = setup({ verification_steps: ['true'] });
    expect(await runVerifyPipeline(db, task, worktree, runId, 'main')).toBe('pass');
    const ev = db
      .prepare(`SELECT COUNT(*) n FROM task_events WHERE task_id=? AND kind='note'`)
      .get(task.id) as { n: number };
    expect(ev.n).toBe(0);
  });
});

// ---- 3. gate: non-blocking warning ----

describe('validateTask capability warning', () => {
  it('warns (does not block) when a required capability is unmet', () => {
    const t = createTask(db, { ...MOCK_TASK, requires: 'camera' });
    const g = validateTask(getTask(db, t.id)!, ''); // host has nothing
    expect(g.ok).toBe(true); // non-blocking
    expect(g.warnings.some((w) => w.includes('camera'))).toBe(true);
  });

  it('no warning when the capability is met', () => {
    const t = createTask(db, { ...MOCK_TASK, requires: 'gpu' });
    const g = validateTask(getTask(db, t.id)!, 'gpu');
    expect(g.ok).toBe(true);
    expect(g.warnings.some((w) => w.includes('gpu'))).toBe(false);
  });

  it('requires null -> no capability warning (zero behavior change)', () => {
    const t = createTask(db, MOCK_TASK);
    const g = validateTask(getTask(db, t.id)!, '');
    expect(g.warnings.some((w) => w.includes('本主機不具備'))).toBe(false);
  });
});

// ---- 4. e2e (mock adapter): unmet capability defers a whole run to manual ----

describe('e2e (mock adapter): unmet capability auto-defers to manual', () => {
  it('reaches review with merge_status=pending even though verification_steps would fail', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, { ...MOCK_TASK, requires: 'camera', verification_steps: ['false'] });
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');
    expect(done.merge_status).toBe('pending');
  });
});
