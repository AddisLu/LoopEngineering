import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createPlan } from '../plans/store.js';
import { checksFromPlan, planCheckInputs } from '../checks/fromPlan.js';
import { listChecks } from '../checks/store.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  db.prepare("INSERT INTO repos (id, name, remote_url, local_path) VALUES ('r_ccl', 'ccl', 'https://gitea.corp/aoi/ccl.git', '/tmp/ccl')").run();
});
afterEach(() => db.close());

const ccl = () =>
  createPlan(db, {
    name: 'CCL',
    host: 'local',
    steps: ['make -j', 'python3 bench.py --images {dataset}'],
    dataset_root: '/datasets',
    dataset_default: 'ccl-2026q2',
    metrics: 'accuracy >= 0.98; time_ms <= 5300',
    protected_paths: ['bench.py', 'answers/**'],
    artifacts: ['build/ccl'],
    manual_checks: ['在機台上開一次 GUI 看標記'],
  });

describe('驗證方案 → 檢查', () => {
  it('each step becomes a check where the plan ran it; metrics on the last; the checklist becomes 人工', () => {
    const { inputs, skipped } = planCheckInputs(ccl());
    expect(skipped).toEqual([]);
    expect(inputs.map((i) => [i.name, i.kind, i.machine, i.command, i.pass_rule, i.metrics])).toEqual([
      ['CCL · 1', 'custom', 'sandbox:local', 'make -j', 'exit0', null],
      ['CCL · 2', 'custom', 'sandbox:local', 'python3 bench.py --images /datasets/ccl-2026q2', 'metrics', 'accuracy >= 0.98; time_ms <= 5300'],
      ['CCL · 人工', 'manual', undefined, undefined, undefined, undefined],
    ]);
    expect(inputs[0]!.protected_paths).toEqual(['bench.py', 'answers/**']);
    expect([inputs[0]!.artifacts, inputs[1]!.artifacts]).toEqual([[], ['build/ccl']]);
  });

  it('writes them to the repo once; a second run adds nothing', () => {
    const plan = ccl();
    const first = checksFromPlan(db, plan.id, 'r_ccl', 'cli');
    expect(first.created).toHaveLength(3);
    expect(listChecks(db, 'r_ccl').map((c) => [c.kind, c.machine, c.pass_rule, c.required])).toEqual([
      ['custom', 'sandbox:local', 'exit0', 1],
      ['custom', 'sandbox:local', 'metrics', 1],
      ['manual', null, 'exit0', 0],
    ]);
    const again = checksFromPlan(db, plan.id, 'r_ccl', 'cli');
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(3);
  });

  it('a step aimed at its own sandbox host keeps it; {dataset} without a default is skipped, not guessed', () => {
    const plan = createPlan(db, { name: 'CUDA', steps: ['sandbox@gpu2: bash run_ncu.sh', 'python3 eval.py {dataset}'], dataset_root: '/d' });
    const { inputs, skipped } = planCheckInputs(plan);
    expect(inputs.map((i) => [i.machine, i.command])).toEqual([['sandbox:gpu2', 'bash run_ncu.sh']]);
    expect(skipped[0]).toContain('{dataset}');
  });

  it('unknown plan or repo is a 404', () => {
    expect(() => checksFromPlan(db, 'vp_nope', 'r_ccl')).toThrow(/沒有這個驗證方案/);
    expect(() => checksFromPlan(db, ccl().id, 'r_nope')).toThrow(/沒有這個 repo/);
  });
});
