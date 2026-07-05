import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, getBool } from '../db/index.js';
import { createTask, getTask, setStatus, dependencyState } from '../tasks.js';
import { tick, type TickInfo, type TickDeps } from '../scheduler/tick.js';
import { setCachedUsage } from '../token/usage.js';
import { isEngineRepo, ENGINE_REPO_ROOT } from '../config.js';

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

const DAY = new Date('2026-07-04T10:00:00');

beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'day_window', '08:00-23:00');
  setCachedUsage(10, 10);
});
afterEach(() => db.close());

function runTick(deps: Partial<TickDeps> = {}): TickInfo {
  return tick(db, { inflightCount: () => 0, startRun: () => {}, now: DAY, ...deps });
}

function setMergeStatus(taskId: string, status: string | null): void {
  db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run(status, taskId);
}

describe('dependencyState: dep_done_on_merge', () => {
  it('review+merged dep is "waiting" by default (false), "satisfied" when the flag is on', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });
    setStatus(db, a.id, 'review');
    setMergeStatus(a.id, 'merged');

    expect(dependencyState(db, getTask(db, b.id)!)).toBe('waiting');

    setSetting(db, 'dep_done_on_merge', 'true');
    expect(dependencyState(db, getTask(db, b.id)!)).toBe('satisfied');
  });

  it('closed dep is always satisfied, regardless of dep_done_on_merge', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });
    setStatus(db, a.id, 'closed');

    expect(dependencyState(db, getTask(db, b.id)!)).toBe('satisfied');
    setSetting(db, 'dep_done_on_merge', 'true');
    expect(dependencyState(db, getTask(db, b.id)!)).toBe('satisfied');
  });

  it('review dep with a pending (non-merged) merge_status stays "waiting" even with the flag on', () => {
    const a = createTask(db, MOCK_TASK);
    const b = createTask(db, { ...MOCK_TASK, title: 'b', depends_on: a.id });
    setStatus(db, a.id, 'review');
    setMergeStatus(a.id, 'pending');
    setSetting(db, 'dep_done_on_merge', 'true');

    expect(dependencyState(db, getTask(db, b.id)!)).toBe('waiting');
  });
});

describe('tick: self_update_pending idle-gated rebuild+restart', () => {
  it('leaves the marker set and does not call selfUpdate while a run is in-flight', () => {
    setSetting(db, 'self_update_pending', 'true');
    const q = createTask(db, MOCK_TASK);
    setStatus(db, q.id, 'queued');

    let calls = 0;
    const info = runTick({ inflightCount: () => 1, selfUpdate: () => { calls += 1; } });

    expect(calls).toBe(0);
    expect(getBool(db, 'self_update_pending')).toBe(true);
    expect(info.reason).not.toBe('self-updating');
  });

  it('when idle: clears the marker, calls selfUpdate once, dispatches nothing this tick', () => {
    setSetting(db, 'self_update_pending', 'true');
    const q = createTask(db, MOCK_TASK);
    setStatus(db, q.id, 'queued');

    let calls = 0;
    const info = runTick({ inflightCount: () => 0, selfUpdate: () => { calls += 1; } });

    expect(calls).toBe(1);
    expect(getBool(db, 'self_update_pending')).toBe(false);
    expect(info.dispatched).toHaveLength(0);
    expect(info.reason).toBe('self-updating');
    // the queued task is untouched — still queued, ready for a later tick
    expect(getTask(db, q.id)!.status).toBe('queued');
  });

  it('re-arms the marker for a retry when selfUpdate throws', () => {
    setSetting(db, 'self_update_pending', 'true');
    const info = runTick({
      inflightCount: () => 0,
      selfUpdate: () => {
        throw new Error('spawn ENOENT');
      },
    });

    expect(getBool(db, 'self_update_pending')).toBe(true);
    expect(info.reason).toBe('self-updating');
  });

  it('does nothing when the marker is unset', () => {
    let calls = 0;
    runTick({ inflightCount: () => 0, selfUpdate: () => { calls += 1; } });
    expect(calls).toBe(0);
  });
});

describe('isEngineRepo', () => {
  it('is false for an unrelated tmp dir and true for the detected engine repo root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupdate-test-'));
    try {
      expect(isEngineRepo(tmp)).toBe(false);
      expect(isEngineRepo(ENGINE_REPO_ROOT)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is false for a path that does not exist', () => {
    expect(isEngineRepo('/nonexistent/path/does-not-exist-xyz')).toBe(false);
  });
});
