import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { buildClaudeArgs } from '../orchestrator/adapters/claudeCode.js';
import { validateSetting } from '../settings.js';
import { DEFAULT_SETTINGS } from '../config.js';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { resolveModel, runTask } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';
import type { Complexity } from '../config.js';
import type { DispatchContext } from '../orchestrator/adapters/types.js';

function ctx(model: string | null): DispatchContext {
  return { model, resume: false, resumeSessionId: null } as unknown as DispatchContext;
}

describe('model selection', () => {
  it('passes --model to the CLI when a model is set', () => {
    expect(buildClaudeArgs(ctx('sonnet'))).toContain('--model');
    const a = buildClaudeArgs(ctx('sonnet'));
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('omits --model for null / default (uses the CLI default)', () => {
    expect(buildClaudeArgs(ctx(null))).not.toContain('--model');
    expect(buildClaudeArgs(ctx('default'))).not.toContain('--model');
  });

  it('default_model defaults to sonnet (keeps autonomous coding off the costly default)', () => {
    expect(DEFAULT_SETTINGS.default_model).toBe('sonnet');
  });

  it('validates default_model against the accepted aliases', () => {
    expect(validateSetting('default_model', 'sonnet')).toBeNull();
    expect(validateSetting('default_model', 'haiku')).toBeNull();
    expect(validateSetting('default_model', '')).toBeNull(); // CLI default
    expect(validateSetting('default_model', 'gpt-4')).toMatch(/default_model must be/);
  });

  it('validates route_S/M/L and model_routing like other model/bool settings', () => {
    expect(validateSetting('route_S', 'haiku')).toBeNull();
    expect(validateSetting('route_M', 'default')).toBeNull();
    expect(validateSetting('route_L', 'nope')).toMatch(/route_L must be/);
    expect(validateSetting('model_routing', 'true')).toBeNull();
    expect(validateSetting('model_routing', 'maybe')).toMatch(/true or false/);
  });
});

// ---- SDD Phase 3: per-complexity model routing (resolveModel) ----

describe('resolveModel: per-complexity routing', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  const mk = (complexity: Complexity, model: string | null = null): ReturnType<typeof getTask> =>
    getTask(db, createTask(db, { title: 't', goal: 'g', complexity, model }).id);

  it('model_routing default seed is off (zero-impact invariant)', () => {
    expect(DEFAULT_SETTINGS.model_routing).toBe('false');
  });

  it('flag OFF -> reduces to default_model (unchanged dispatch)', () => {
    // default_model seeds to 'sonnet'
    expect(resolveModel(db, mk('S')!)).toBe('sonnet');
    expect(resolveModel(db, mk('L')!)).toBe('sonnet');
    setSetting(db, 'default_model', '');
    expect(resolveModel(db, mk('M')!)).toBeNull(); // empty -> CLI default
  });

  it('a per-task model always wins, even with routing on', () => {
    setSetting(db, 'model_routing', 'true');
    setSetting(db, 'route_S', 'haiku');
    expect(resolveModel(db, mk('S', 'opus')!)).toBe('opus');
    // explicit 'default' opts out to the CLI default (null), NOT default_model
    expect(resolveModel(db, mk('S', 'default')!)).toBeNull();
  });

  it('flag ON routes by complexity; a default/empty route falls through to default_model', () => {
    setSetting(db, 'model_routing', 'true');
    setSetting(db, 'route_S', 'haiku');
    setSetting(db, 'route_M', 'default'); // falls through
    setSetting(db, 'route_L', 'opus');
    setSetting(db, 'default_model', 'sonnet');
    expect(resolveModel(db, mk('S')!)).toBe('haiku');
    expect(resolveModel(db, mk('M')!)).toBe('sonnet'); // route 'default' -> default_model, not CLI default
    expect(resolveModel(db, mk('L')!)).toBe('opus');
  });
});

// ---- e2e (mock adapter, zero tokens): the real runTask lifecycle stamps task_runs.model ----

describe('runTask: stamps the resolved model on the run (SDD Phase 3/4)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
    setCachedUsage(10, 10);
    process.env.MOCK_SLEEP_MS = '120';
  });
  afterEach(() => {
    db.close();
    delete process.env.MOCK_SLEEP_MS;
  });

  const runModel = (taskId: string): string | null =>
    (db.prepare('SELECT model FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId) as { model: string | null }).model;

  it('model_routing on + route_S=haiku -> the S task actually runs & records model=haiku', async () => {
    setSetting(db, 'model_routing', 'true');
    setSetting(db, 'route_S', 'haiku');
    const t = createTask(db, { title: 'x', goal: 'g', coding_tool: 'mock', complexity: 'S', verification_steps: ['true'] });
    await runTask(db, getTask(db, t.id)!, {});
    expect(runModel(t.id)).toBe('haiku');
  });

  it('routing off (default) -> records the default_model key (sonnet)', async () => {
    const t = createTask(db, { title: 'x', goal: 'g', coding_tool: 'mock', complexity: 'S', verification_steps: ['true'] });
    await runTask(db, getTask(db, t.id)!, {});
    expect(runModel(t.id)).toBe('sonnet');
  });
});
