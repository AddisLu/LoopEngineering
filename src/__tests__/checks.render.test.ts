import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createCheck, updateCheck, writeBaseline } from '../checks/store.js';
import { createDataset } from '../checks/datasets.js';
import {
  assignMetricPrefixes,
  baselineThresholds,
  describeChecks,
  parseCheckSnapshots,
  prefixedThresholds,
  renderChecks,
  snapshotCheck,
  snapshotChecks,
  targetsMachine,
} from '../checks/render.js';
import { getCheck } from '../checks/store.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  db.prepare('INSERT INTO repos (id, name, remote_url, local_path) VALUES (?, ?, ?, ?)').run('r_cfaoi', 'cf-aoi', 'http://gitea.corp:3000/aoi/cf-aoi.git', '/srv/repos/cf-aoi');
});
afterEach(() => db.close());

function seed() {
  const ds = createDataset(db, { name: 'dataset-2026Q2', remote_url: 'http://gitea.corp:3000/aoi/dataset-2026Q2.git' });
  const build = createCheck(db, 'r_cfaoi', { name: '建置', kind: 'build', command: 'cmake --build build -j', machine: 'aoi-1', artifacts: 'build/cfaoi.exe' });
  const unit = createCheck(db, 'r_cfaoi', { name: '單元測試', kind: 'test', command: 'ctest --test-dir build', machine: 'aoi-1', protected_paths: 'tests/golden/**' });
  const repro = createCheck(db, 'r_cfaoi', { name: '重現', kind: 'repro', command: 'pytest tests/test_recipe_reload.py', test_globs: 'tests/**', protected_paths: 'tests/golden/**, scripts/eval/**' });
  const regress = createCheck(db, 'r_cfaoi', {
    name: '圖資回歸',
    kind: 'dataset',
    command: 'run_inference --in {images} --out {out}',
    dataset_id: ds.id,
    pass_rule: 'baseline',
    required: false,
  });
  writeBaseline(db, regress.id, { sha: '3f2a1c1', values: { correct_rate: 0.987, time_ms: 5100, mismatches: 15, missing: 1, total: 1204 }, ms: 5300, at: '2026-09-30T10:00:00Z' });
  const manual = createCheck(db, 'r_cfaoi', { name: '上機確認', kind: 'manual', manual_text: '在 aoi-1 連續 LOAD_RECIPE 兩次，確認 bypass_edge_x 生效' });
  const off = createCheck(db, 'r_cfaoi', { name: '停用的', kind: 'test', command: 'false', enabled: false });
  const optional = createCheck(db, 'r_cfaoi', { name: '效能', kind: 'custom', command: 'python bench.py', pass_rule: 'metrics', metrics: 'fps >= 30', required: false });
  return { ds, build, unit, repro, regress, manual, off, optional };
}

describe('snapshotChecks', () => {
  it('takes every enabled required check, plus the optional ones asked for, in the repo order', () => {
    const c = seed();
    expect(snapshotChecks(db, 'r_cfaoi').map((s) => s.name)).toEqual(['建置', '單元測試', '重現', '上機確認']);
    const withRegress = snapshotChecks(db, 'r_cfaoi', { include: [c.regress.id, c.off.id, 'ck_nothere'] });
    expect(withRegress.map((s) => s.name)).toEqual(['建置', '單元測試', '重現', '圖資回歸', '上機確認']);
  });

  it('turns 「不比基準差」 into concrete numbers at snapshot time and freezes the dataset row', () => {
    const c = seed();
    const s = snapshotCheck(db, getCheck(db, c.regress.id)!);
    expect(s.thresholds).toBe('correct_rate >= 0.987; time_ms <= 5610');
    expect(s.dataset).toEqual({ id: c.ds.id, name: 'dataset-2026Q2', remote_url: 'http://gitea.corp:3000/aoi/dataset-2026Q2.git', images_dir: 'images', answer_file: 'answers.json', answer_format: 'auto' });
    expect(s.baseline?.sha).toBe('3f2a1c1');
    // a later edit of the check never reaches a task that already has its copy
    const frozen = JSON.stringify(snapshotChecks(db, 'r_cfaoi'));
    updateCheck(db, c.unit.id, { command: 'ctest --test-dir build -R fast' });
    const again = parseCheckSnapshots({ checks_json: frozen });
    expect(again.find((x) => x.id === c.unit.id)!.command).toBe('ctest --test-dir build');
  });

  it('a baseline rule without a baseline yet has no thresholds; its own metrics still count', () => {
    seed();
    const b = createCheck(db, 'r_cfaoi', { name: 'b', kind: 'custom', command: 'bench', pass_rule: 'baseline', metrics: 'fps >= 10' });
    expect(snapshotCheck(db, b).thresholds).toBe('fps >= 10');
    const e = createCheck(db, 'r_cfaoi', { name: 'e', kind: 'custom', command: 'bench', metrics: 'fps >= 10' });
    expect(snapshotCheck(db, e).thresholds).toBeNull(); // exit 0 means exit 0
  });

  it('baselineThresholds: times get the tolerance, rates and scores hold, error rates may not grow, counts are informational', () => {
    expect(baselineThresholds({ correct_rate: 0.9, time_ms: 4.9, latency_s: 2, fps: 30, false_positive_rate: 0.01, loss: 0.3, miss: 3, total: 100, note: 'x', mismatches: 4 }, 0.1)).toEqual([
      { name: 'correct_rate', op: '>=', target: 0.9 },
      { name: 'time_ms', op: '<=', target: 5.39 },
      { name: 'latency_s', op: '<=', target: 2.2 },
      { name: 'fps', op: '>=', target: 30 },
      { name: 'false_positive_rate', op: '<=', target: 0.01 },
      { name: 'loss', op: '<=', target: 0.3 },
    ]);
  });
});

describe('renderChecks', () => {
  it('renders steps, thresholds, protected paths, artifacts, manual checks and the verify mode', () => {
    const c = seed();
    const snap = snapshotChecks(db, 'r_cfaoi', { include: [c.regress.id, c.optional.id] });
    const r = renderChecks(snap);
    expect(r.verification_steps).toEqual([`check:${c.build.id}`, `check:${c.unit.id}`, `check:${c.repro.id}`, `check:${c.regress.id}`, `check:${c.optional.id}`]);
    expect(r.acceptance_metrics).toBe('correct_rate >= 0.987; time_ms <= 5610; fps >= 30');
    expect(r.protected_paths).toBe('tests/golden/**,scripts/eval/**');
    expect(r.artifacts).toBe('build/cfaoi.exe');
    expect(r.manual_checks).toEqual(['在 aoi-1 連續 LOAD_RECIPE 兩次，確認 bypass_edge_x 生效']);
    expect(r.verify_mode).toBe('command,manual');
    expect(r.requires).toBeNull();
    expect(targetsMachine(snap)).toBe(true);
  });

  it('only manual checks → verify_mode manual; nothing at all → command with no steps', () => {
    const m = createCheck(db, 'r_cfaoi', { name: '人工', kind: 'manual' });
    expect(renderChecks([snapshotCheck(db, m)])).toMatchObject({ verification_steps: [], verify_mode: 'manual', manual_checks: ['人工'], acceptance_metrics: null, protected_paths: null, artifacts: null });
    expect(renderChecks([])).toMatchObject({ verification_steps: [], verify_mode: 'command' });
    expect(targetsMachine([])).toBe(false);
  });

  it('a migrated GPU-sandbox check renders as the legacy sandbox step', () => {
    const local = createCheck(db, 'r_cfaoi', { name: '沙盒評估', kind: 'custom', command: 'python3 eval.py', machine: 'sandbox:local', pass_rule: 'metrics', metrics: 'detection_rate >= 0.98' });
    const remote = createCheck(db, 'r_cfaoi', { name: '遠端', kind: 'test', command: 'make test', machine: 'sandbox:aoi-gpu' });
    const r = renderChecks(snapshotChecks(db, 'r_cfaoi'));
    expect(r.verification_steps).toEqual(['sandbox@local: python3 eval.py', 'sandbox@aoi-gpu: make test']);
    expect(r.acceptance_metrics).toBe('detection_rate >= 0.98');
    expect(targetsMachine([snapshotCheck(db, local), snapshotCheck(db, remote)])).toBe(false);
  });

  it('two checks reporting the same metric are namespaced by check id, a sandbox check keeps its names', () => {
    const ds = createDataset(db, { name: 'q2', remote_url: 'file:///srv/q2.git' });
    const a = createCheck(db, 'r_cfaoi', { name: 'A', kind: 'dataset', command: 'run {out}', dataset_id: ds.id, pass_rule: 'metrics', metrics: 'correct_rate >= 0.9' });
    const b = createCheck(db, 'r_cfaoi', { name: 'B', kind: 'dataset', command: 'run2 {out}', dataset_id: ds.id, pass_rule: 'metrics', metrics: 'correct_rate >= 0.8' });
    const sb = createCheck(db, 'r_cfaoi', { name: 'S', kind: 'custom', command: 'eval', machine: 'sandbox:local', pass_rule: 'metrics', metrics: 'fps >= 1' });
    const lone = createCheck(db, 'r_cfaoi', { name: 'L', kind: 'custom', command: 'bench', pass_rule: 'metrics', metrics: 'fps >= 2' });
    const snap = snapshotChecks(db, 'r_cfaoi');
    expect(snap.map((s) => s.metric_prefix)).toEqual([`${a.id}.`, `${b.id}.`, null, `${lone.id}.`]);
    expect(prefixedThresholds(snap[0]!)).toEqual([{ name: `${a.id}.correct_rate`, op: '>=', target: 0.9 }]);
    expect(renderChecks(snap).acceptance_metrics).toBe(`${a.id}.correct_rate >= 0.9; ${b.id}.correct_rate >= 0.8; fps >= 1; ${lone.id}.fps >= 2`);
    // a single emitter of a name keeps it plain
    expect(assignMetricPrefixes([snap[0]!]).map((s) => s.metric_prefix)).toEqual([null]);
    expect(sb.id).toBeTruthy();
  });
});

describe('describeChecks', () => {
  it('one human line per check, as LOOP_TASK.md shows them', () => {
    const c = seed();
    const lines = describeChecks(snapshotChecks(db, 'r_cfaoi', { include: [c.regress.id, c.optional.id] }));
    expect(lines).toEqual([
      '- [必過] 建置：`cmake --build build -j`（在 aoi-1，引擎代跑）',
      '- [必過] 單元測試：`ctest --test-dir build`（在 aoi-1，引擎代跑）',
      '- 重現：`pytest tests/test_recipe_reload.py`（修改前必須失敗、修改後必須通過；新增的測試放在 tests/**）',
      '- 圖資回歸：dataset-2026Q2，正確率 ≥ 0.987、time_ms ≤ 5610（引擎比對，不要自己改答案檔）',
      '  - 引擎執行的指令：`run_inference --in {images} --out {out}`（{images} 圖片資料夾、{answers} 答案檔、{out} 輸出資料夾）',
      '- [人工] 在 aoi-1 連續 LOAD_RECIPE 兩次，確認 bypass_edge_x 生效',
      '- 效能：`python bench.py`（門檻 fps ≥ 30）',
    ]);
  });

  it('a repro that only has to pass afterwards, and a dataset on a machine', () => {
    const ds = createDataset(db, { name: 'q3', remote_url: 'file:///srv/q3.git' });
    const r = createCheck(db, 'r_cfaoi', { name: '重現', kind: 'repro', command: 'pytest -k second_load', red_on_base: false, machine: 'aoi-2' });
    const d = createCheck(db, 'r_cfaoi', { name: '圖資', kind: 'dataset', command: 'run {out}', dataset_id: ds.id, machine: 'aoi-2' });
    expect(describeChecks([snapshotCheck(db, r), snapshotCheck(db, d)])).toEqual([
      '- 重現：`pytest -k second_load`（修改後必須通過；在 aoi-2，引擎代跑）',
      '- 圖資：q3（在 aoi-2 由引擎執行並比對，不要自己改答案檔）',
      '  - 引擎執行的指令：`run {out}`（{images} 圖片資料夾、{answers} 答案檔、{out} 輸出資料夾）',
    ]);
  });
});

describe('parseCheckSnapshots', () => {
  it('reads a task copy defensively', () => {
    expect(parseCheckSnapshots({ checks_json: null })).toEqual([]);
    expect(parseCheckSnapshots({ checks_json: '{oops' })).toEqual([]);
    expect(parseCheckSnapshots({ checks_json: '[{"id": "ck_1", "name": "x"}, 3, null]' })).toEqual([{ id: 'ck_1', name: 'x' }]);
  });
});
