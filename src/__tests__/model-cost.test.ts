import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, createRun, activeRunCosts } from '../tasks.js';
import { estimatePct, estimateWeeklyPct } from '../token/accounting.js';
import type { Complexity } from '../config.js';

let db: Database.Database;
let runSeq = 0;

beforeEach(() => {
  db = openTestDb();
  runSeq = 0;
});
afterEach(() => {
  db.close();
});

/** Seed one clean, completed first-run of a given complexity+model with fixed deltas. */
function seedRun(complexity: Complexity, model: string, sessionDelta: number, weeklyDelta = 0): void {
  const t = createTask(db, { title: 't', goal: 'g', complexity });
  db.prepare(
    `INSERT INTO task_runs (id, task_id, model, session_pct_before, session_pct_after,
       weekly_pct_before, weekly_pct_after, exit_code, started_at)
     VALUES (@id, @task_id, @model, @sb, @sa, @wb, @wa, 0, datetime('now'))`,
  ).run({
    id: `r_seed_${runSeq++}`,
    task_id: t.id,
    model,
    sb: 10,
    sa: 10 + sessionDelta,
    wb: 20,
    wa: 20 + weeklyDelta,
  });
}

describe('estimatePct: model-aware calibration (SDD Phase 4)', () => {
  it('keys the estimate on (complexity, model): cheap model estimates far lower than the expensive one', () => {
    for (let i = 0; i < 5; i++) seedRun('S', 'haiku', 1); // haiku S ~1%
    for (let i = 0; i < 5; i++) seedRun('S', 'sonnet', 5); // sonnet S ~5%

    expect(estimatePct(db, 'S', 'haiku')).toBeCloseTo(1);
    expect(estimatePct(db, 'S', 'sonnet')).toBeCloseTo(5);
    // the whole point: the fit gate reserves ~5x less for a haiku S-task than a sonnet one
    expect(estimatePct(db, 'S', 'haiku')).toBeLessThan(estimatePct(db, 'S', 'sonnet'));
  });

  it('no-model call = legacy blended estimate over ALL models (pollution the keying fixes)', () => {
    for (let i = 0; i < 5; i++) seedRun('S', 'haiku', 1);
    for (let i = 0; i < 5; i++) seedRun('S', 'sonnet', 5);
    // p75 of the mixed 10-sample set leans to the expensive tail — over-estimating haiku.
    const blended = estimatePct(db, 'S');
    expect(blended).toBeGreaterThan(estimatePct(db, 'S', 'haiku'));
    expect(blended).toBeCloseTo(5);
  });

  it('cold start (<5 model samples) falls back to the per-complexity seed (safe over-estimate)', () => {
    for (let i = 0; i < 3; i++) seedRun('S', 'haiku', 1); // only 3 -> below MIN_SAMPLES
    // seed est_pct_S defaults to 3 — higher than haiku's real ~1, so the gate never under-reserves
    expect(estimatePct(db, 'S', 'haiku')).toBe(3);
  });

  it('weekly estimate is model-keyed symmetrically', () => {
    for (let i = 0; i < 5; i++) seedRun('M', 'haiku', 0, 1);
    for (let i = 0; i < 5; i++) seedRun('M', 'sonnet', 0, 4);
    expect(estimateWeeklyPct(db, 'M', 'haiku')).toBeCloseTo(1);
    expect(estimateWeeklyPct(db, 'M', 'sonnet')).toBeCloseTo(4);
  });

  it('zero-impact: with no model arg the query is unchanged, and historical NULL-model rows still count', () => {
    // legacy rows never stamped a model
    for (let i = 0; i < 5; i++) {
      const t = createTask(db, { title: 't', goal: 'g', complexity: 'L' });
      db.prepare(
        `INSERT INTO task_runs (id, task_id, session_pct_before, session_pct_after, exit_code, started_at)
         VALUES (@id, @task_id, 10, 17, 0, datetime('now'))`,
      ).run({ id: `r_legacy_${runSeq++}`, task_id: t.id });
    }
    expect(estimatePct(db, 'L')).toBeCloseTo(7); // legacy no-model path sees them
    // but a model-keyed query does NOT match NULL-model rows -> falls back to the seed (20)
    expect(estimatePct(db, 'L', 'haiku')).toBe(20);
  });
});

describe('createRun/activeRunCosts: model plumbing (SDD Phase 4)', () => {
  it('createRun stores the resolved model and activeRunCosts surfaces it for the reserve', () => {
    const t = createTask(db, { title: 't', goal: 'g', complexity: 'S' });
    createRun(db, { task_id: t.id, model: 'haiku', session_pct_before: 5 });
    const costs = activeRunCosts(db);
    expect(costs).toHaveLength(1);
    expect(costs[0].model).toBe('haiku');
    expect(costs[0].complexity).toBe('S');
  });
});
