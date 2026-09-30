import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, getSetting } from '../db/index.js';
import { createTask, setStatus, createRun, getRun, activeRunCosts } from '../tasks.js';
import { tick, type TickDeps } from '../scheduler/tick.js';
import { setCachedUsage } from '../token/usage.js';
import type { ModelManagerState } from '../local/modelManager.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
});
afterEach(() => {
  db.close();
});

const BASE = {
  title: 't',
  goal: 'g',
  plan_ref: 'https://example.com/p.md',
  plan_kind: 'url' as const,
  coding_tool: 'claude-code',
  verification_steps: ['true'],
  repo_path: '/tmp/repo',
  base_branch: 'main',
};

function queued(model: string, priority = 2) {
  const t = createTask(db, { ...BASE, model, priority });
  setStatus(db, t.id, 'queued');
  return t;
}

/** An unfinished run row = an in-flight run as far as the scheduler's SQL is concerned. */
function inflight(model: string) {
  const t = createTask(db, { ...BASE, model });
  setStatus(db, t.id, 'running');
  return createRun(db, { task_id: t.id, model });
}

function stubManager(init: Partial<ModelManagerState> = {}, unavailable: string[] = []) {
  const st: ModelManagerState = { loaded: null, wanted: null, status: 'idle', since: null, error: null, ...init };
  const ensured: string[] = [];
  const refreshes = { n: 0 };
  return {
    ensured,
    refreshes,
    mm: {
      state: () => ({ ...st }),
      ensureLoaded: (id: string) => {
        ensured.push(id);
        return 'switching' as const;
      },
      unavailable: (id: string) => unavailable.includes(id),
      refresh: () => {
        refreshes.n += 1;
      },
    },
  };
}

function runTick(mm?: TickDeps['modelManager'], inflightCount = 0) {
  const started: string[] = [];
  const info = tick(db, { inflightCount: () => inflightCount, startRun: (t) => started.push(t.id), modelManager: mm });
  return { info, started };
}

describe('tick: local models off (default)', () => {
  it('holds local tasks and says why; cloud dispatch is unchanged', () => {
    const local = queued('local:qwen38-flash', 5);
    const cloud = queued('sonnet', 1);
    const { info, started } = runTick(stubManager().mm);
    expect(started).toEqual([cloud.id]);
    expect(started).not.toContain(local.id);
    expect(info.reason).toBe('dispatched; 1 local task(s) held: local_models_enabled=false');
  });

  it('no local tasks -> reason strings are exactly as before', () => {
    queued('sonnet');
    expect(runTick().info.reason).toBe('dispatched');
  });

  it('never probes vLLM', () => {
    const stub = stubManager({ status: 'ready', loaded: 'qwen38-flash' });
    runTick(stub.mm);
    expect(stub.refreshes.n).toBe(0);
  });
});

describe('tick: local models on', () => {
  beforeEach(() => setSetting(db, 'local_models_enabled', 'true'));

  it('checks what vLLM serves every tick — paused, or with nothing local queued — so a crash stops saying 就緒', () => {
    const stub = stubManager({ status: 'ready', loaded: 'qwen38-flash' });
    setSetting(db, 'scheduler_paused', 'true');
    expect(runTick(stub.mm).info.paused).toBe(true);
    expect(stub.refreshes.n).toBe(1);
    setSetting(db, 'scheduler_paused', 'false');
    queued('sonnet');
    runTick(stub.mm);
    expect(stub.refreshes.n).toBe(2);
  });

  it('dispatches on the loaded model even when the quota breaker has tripped', () => {
    setCachedUsage(99, 99);
    const local = queued('local:qwen38-flash');
    const cloud = queued('sonnet');
    const { mm } = stubManager({ status: 'ready', loaded: 'qwen38-flash' });
    const { info, started } = runTick(mm);
    expect(started).toEqual([local.id]);
    expect(started).not.toContain(cloud.id);
    expect(info.breakerTripped).toBe(true);
    expect(info.reason).toBe('breaker tripped; local: dispatched 1 on qwen38-flash');
  });

  it('caps local dispatch at local_max_concurrency minus in-flight local runs', () => {
    setSetting(db, 'local_max_concurrency', '2');
    inflight('local:qwen38-flash');
    queued('local:qwen38-flash');
    queued('local:qwen38-flash');
    const { started } = runTick(stubManager({ status: 'ready', loaded: 'qwen38-flash' }).mm, 1);
    expect(started).toHaveLength(1);
  });

  it('stays on the loaded model while it has work, even over a higher-priority other model', () => {
    const flash = queued('local:qwen38-flash', 9);
    const coder = queued('local:qwen3-coder-next', 1);
    const s = stubManager({ status: 'ready', loaded: 'qwen3-coder-next' });
    const { started } = runTick(s.mm);
    expect(started).toEqual([coder.id]);
    expect(started).not.toContain(flash.id);
    expect(s.ensured).toEqual([]);
  });

  it('switches only once no local run is in flight', () => {
    queued('local:qwen38-flash');
    const run = inflight('local:qwen3-coder-next');
    const s = stubManager({ status: 'ready', loaded: 'qwen3-coder-next' });
    const busy = runTick(s.mm, 1);
    expect(busy.started).toEqual([]);
    expect(s.ensured).toEqual([]);
    expect(busy.info.reason).toMatch(/local: 1 run\(s\) still in flight; switch to qwen38-flash waits/);

    db.prepare('UPDATE task_runs SET finished_at = ? WHERE id = ?').run(new Date().toISOString(), run.id);
    const free = runTick(s.mm);
    expect(s.ensured).toEqual(['qwen38-flash']);
    expect(free.info.reason).toMatch(/local: loading qwen38-flash/);
  });

  it('loads the top-priority model when nothing is loaded, skipping a model in cool-down', () => {
    queued('local:qwen38-flash', 9);
    queued('local:qwen3-coder-next', 1);
    const s = stubManager({ status: 'error', wanted: 'qwen38-flash', error: 'weights not downloaded' }, ['qwen38-flash']);
    runTick(s.mm);
    expect(s.ensured).toEqual(['qwen3-coder-next']);
  });

  it('local runs do not consume cloud concurrency slots', () => {
    setSetting(db, 'max_concurrency', '1');
    inflight('local:qwen38-flash');
    const cloud = queued('sonnet');
    // the engine counts the local run as in flight (inflightCount 1), the cloud slot stays free
    const { started } = runTick(stubManager({ status: 'ready', loaded: 'qwen38-flash' }).mm, 1);
    expect(started).toEqual([cloud.id]);
  });

  it('without a model manager local tasks are held, not crashed on', () => {
    queued('local:qwen38-flash');
    const { info, started } = runTick(undefined);
    expect(started).toEqual([]);
    expect(info.reason).toMatch(/1 local task\(s\) held: no model manager/);
  });
});

describe('quota safety ignores local runs', () => {
  it('breaker interrupts cloud runs but leaves local runs alone', () => {
    setCachedUsage(99, 99);
    const cloudRun = inflight('sonnet');
    const localRun = inflight('local:qwen38-flash');
    runTick();
    expect(getRun(db, cloudRun.id)!.interrupted_by).toBe('breaker');
    expect(getRun(db, localRun.id)!.interrupted_by).toBeNull();
  });

  it('concurrency reserve excludes local runs', () => {
    inflight('local:qwen38-flash');
    inflight('sonnet');
    expect(activeRunCosts(db).map((r) => r.model)).toEqual(['sonnet']);
  });

  it('local_models_enabled stays off by default', () => {
    expect(getSetting(db, 'local_models_enabled')).toBe('false');
  });
});
