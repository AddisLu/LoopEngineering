import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { TaskRun } from '../types.js';
import {
  buildAttempts,
  buildChecks,
  buildDatasetViews,
  fmtMs,
  fmtRate,
  indexImages,
  latestPerCheck,
  nextEscalation,
  pickBeforeRow,
  pickShownRun,
  readAnalysis,
  readFrozenChecks,
  stepLabel,
  ticketHeadline,
  whereLabel,
  type CheckRunRow,
} from '../review/result.js';
import { checkRunFileType, listCheckRunFiles, resolveCheckRunFile } from '../review/checkFiles.js';

// ---- fixtures ------------------------------------------------------------------------------------

const CHECKS_JSON = JSON.stringify([
  { id: 'ck_build', repo_id: 'r_1', name: '建置', kind: 'build', machine: 'aoi-1', command: 'cmake --build build', required: true, ord: 0 },
  { id: 'ck_repro', repo_id: 'r_1', name: '重現', kind: 'repro', machine: 'aoi-1', command: 'pytest tests/test_recipe_reload.py', required: true, ord: 1 },
  { id: 'ck_unit', repo_id: 'r_1', name: '單元測試', kind: 'test', machine: 'aoi-1', command: 'ctest', required: true, ord: 2 },
  {
    id: 'ck_ds',
    repo_id: 'r_1',
    name: '圖資回歸',
    kind: 'dataset',
    machine: 'aoi-1',
    command: 'run_inference --in {images} --out {out}',
    required: true,
    ord: 3,
    baseline: { sha: '3f2a1c9d0e', values: { correct_rate: 0.987, time_ms: 5100 }, ms: 5100, at: '2026-09-20T00:00:00Z', run_id: 'cr_base' },
    dataset: { id: 'ds_1', name: 'dataset-2026Q2' },
  },
  { id: 'ck_look', repo_id: 'r_1', name: '看一次畫面', kind: 'manual', machine: null, command: null, required: true, ord: 4, manual_text: '在產線機上看一次 recipe 切換' },
]);

let seq = 0;
function row(over: Partial<CheckRunRow> & Pick<CheckRunRow, 'check_id'>): CheckRunRow {
  seq += 1;
  return {
    id: `cr_${seq}`,
    task_id: 't_1',
    run_id: 'r_3',
    kind: 'verify',
    machine: 'aoi-1',
    head_sha: 'abc1234',
    base_sha: 'def5678',
    ok: 1,
    exit_code: 0,
    timed_out: 0,
    ms: 1000,
    output_tail: '',
    metrics_json: null,
    result_json: null,
    artifacts_json: null,
    started_at: '2026-10-01 01:00:00',
    finished_at: '2026-10-01 01:01:00',
    ...over,
  };
}

function run(id: string, over: Partial<TaskRun> = {}): TaskRun {
  return {
    id,
    task_id: 't_1',
    resume_of: null,
    attempt: 1,
    session_id: null,
    pid: null,
    worktree_path: null,
    branch: null,
    log_path: null,
    exit_code: 0,
    error: null,
    interrupted_by: null,
    usage_json: null,
    session_pct_before: null,
    session_pct_after: null,
    weekly_pct_before: null,
    weekly_pct_after: null,
    dispatch_window: null,
    discipline: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    backend: null,
    started_at: '2026-10-01 00:00:00',
    finished_at: '2026-10-01 00:10:00',
    ...over,
  };
}

const CASES_AFTER = [
  { case: 'IMG_0412', expected: 'OK', actual: 'OK', ok: true, note: '' },
  { case: 'IMG_0977', expected: 'NG', actual: 'NG', ok: true, note: '' },
  { case: 'IMG_1103', expected: 'OK', actual: 'NG', ok: false, note: '標籤不符' },
  { case: 'IMG_2000', expected: 'OK', actual: 'OK', ok: true, note: '' },
  { case: 'IMG_3000', expected: 'NG', actual: null, ok: false, note: '沒有輸出' },
];
const CASES_BEFORE = [
  { case: 'IMG_0412', expected: 'OK', actual: 'NG', ok: false, note: '' },
  { case: 'IMG_0977', expected: 'NG', actual: 'OK', ok: false, note: '' },
  { case: 'IMG_1103', expected: 'OK', actual: 'OK', ok: true, note: '' },
  { case: 'IMG_2000', expected: 'OK', actual: 'OK', ok: true, note: '' },
  { case: 'IMG_3000', expected: 'NG', actual: 'NG', ok: true, note: '' },
];

/** a ticket's third run: everything passed, the repro went red → green, the dataset improved */
function passedRows(): CheckRunRow[] {
  return [
    row({ check_id: 'ck_build', ms: 41_000 }),
    row({ check_id: 'ck_repro', kind: 'red_green', ms: 9000, result_json: JSON.stringify({ before: { ok: false, exit_code: 1, tail: 'FAILED' }, after: { ok: true, exit_code: 0, tail: 'passed' } }) }),
    row({ check_id: 'ck_unit', ms: 128_000 }),
    row({
      check_id: 'ck_ds',
      ms: 4900,
      metrics_json: JSON.stringify({ values: { correct_rate: 0.99, mismatches: 1, missing: 1, total: 5, time_ms: 4900 }, checks: [], pass: true }),
      result_json: JSON.stringify(CASES_AFTER),
    }),
  ];
}

// ---- tests ---------------------------------------------------------------------------------------

describe('結果頁 builders', () => {
  it('reads the frozen checks in order, from the snapshot or from a raw checks row', () => {
    const checks = readFrozenChecks(CHECKS_JSON);
    expect(checks.map((c) => c.id)).toEqual(['ck_build', 'ck_repro', 'ck_unit', 'ck_ds', 'ck_look']);
    expect(checks[3]).toMatchObject({ dataset: 'dataset-2026Q2', baseline: { sha: '3f2a1c9d0e', values: { correct_rate: 0.987, time_ms: 5100 }, run_id: 'cr_base' } });
    const raw = readFrozenChecks(
      JSON.stringify([
        { id: 'ck_a', name: 'A', kind: 'test', required: 0, baseline_json: JSON.stringify({ sha: 'x', values: { time_ms: '12' } }) },
        { id: 'ck_b', name: '  ' },
        { name: 'no id' },
      ]),
    );
    expect(raw).toEqual([{ id: 'ck_a', name: 'A', kind: 'test', machine: null, command: null, required: false, manual_text: null, baseline: { sha: 'x', values: { time_ms: 12 }, run_id: null }, dataset: null }]);
    expect(readFrozenChecks(null)).toEqual([]);
    expect(readFrozenChecks('{nope')).toEqual([]);
    expect(readFrozenChecks('{"a":1}')).toEqual([]);
  });

  it('formats times, rates and machines the way the page shows them', () => {
    expect([fmtMs(800), fmtMs(4900), fmtMs(41_000), fmtMs(59_600), fmtMs(128_000), fmtMs(372_000), fmtMs(3_900_000)]).toEqual([
      '0.8 s',
      '4.9 s',
      '41 s',
      '1 分 00 秒',
      '2 分 08 秒',
      '6 分 12 秒',
      '1 時 05 分',
    ]);
    expect(fmtMs(null)).toBeNull();
    expect([fmtRate(0.987), fmtRate(0.99), fmtRate(98.7)]).toEqual(['98.7%', '99.0%', '98.7%']);
    expect([whereLabel(null), whereLabel('aoi-1'), whereLabel('sandbox:local'), whereLabel('sandbox:gpu2')]).toEqual(['引擎主機', 'aoi-1', 'GPU 沙盒', 'GPU 沙盒（gpu2）']);
  });

  it('lists every check GitHub-checks style: the red → green repro, the dataset against its baseline', () => {
    const checks = readFrozenChecks(CHECKS_JSON);
    const shown = latestPerCheck(passedRows(), 'r_3');
    const list = buildChecks(checks, shown, new Map(), []);
    expect(list.map((c) => [c.name, c.state, c.summary])).toEqual([
      ['建置', 'passed', '41 s'],
      ['重現', 'passed', '修前 ✗ → 修後 ✓'],
      ['單元測試', 'passed', '2 分 08 秒'],
      ['圖資回歸', 'passed', '正確率 98.7% → 99.0% · 5.1 s → 4.9 s'],
      ['看一次畫面', 'manual', '在產線機上看一次 recipe 切換'],
    ]);
    expect(list[0]).toMatchObject({ kind_label: '建置', where: 'aoi-1', required: true, ok: true, ms: 41_000, run_id: shown.get('ck_build')!.id, command: null });
    expect(list[1]).toMatchObject({ command: 'pytest tests/test_recipe_reload.py', repro: { before_ok: false, after_ok: true } });
    expect(list[3]!.cases).toBe(true);
    expect(list[4]).toMatchObject({ run_id: null, ok: null, kind_label: '人工' });
    expect(ticketHeadline('review', list)).toBe('4 項檢查都過，重現測試從紅變綠');
  });

  it('says what failed, what is still running and what has no result yet', () => {
    const checks = readFrozenChecks(CHECKS_JSON);
    const rows = [
      row({ check_id: 'ck_build', ms: 41_000 }),
      row({ check_id: 'ck_unit', ok: 0, exit_code: 1, ms: 30_000, output_tail: '1 test failed' }),
      row({ check_id: 'ck_ds', ok: null, finished_at: null, ms: null }),
    ];
    const list = buildChecks(checks, latestPerCheck(rows, 'r_3'), new Map(), []);
    expect(list.map((c) => [c.name, c.state, c.summary])).toEqual([
      ['建置', 'passed', '41 s'],
      ['重現', 'waiting', '等待中'],
      ['單元測試', 'failed', 'exit 1'],
      ['圖資回歸', 'running', '執行中…'],
      ['看一次畫面', 'manual', '在產線機上看一次 recipe 切換'],
    ]);
    expect(ticketHeadline('verifying', list)).toBe('正在跑檢查 2/4');
    expect(ticketHeadline('attention', list)).toBe('沒過：單元測試（aoi-1）');
    expect(ticketHeadline('running', list)).toBeNull();
    expect(ticketHeadline('review', list)).toBeNull(); // not every check has a result: the usual headline stays

    const timedOut = buildChecks(checks, latestPerCheck([row({ check_id: 'ck_unit', ok: 0, exit_code: 124, timed_out: 1 })], 'r_3'), new Map(), []);
    expect(timedOut[2]).toMatchObject({ state: 'failed', summary: '逾時', timed_out: true });
    // a failed attention with no failed check (e.g. setup failed): nothing to say from the checks
    expect(ticketHeadline('attention', buildChecks(checks, new Map(), new Map(), []))).toBeNull();
    // a failed optional check does not turn a passed task red
    const optional = buildChecks(
      readFrozenChecks(JSON.stringify([{ id: 'a', name: 'A', kind: 'build' }, { id: 'b', name: 'B', kind: 'custom', required: false }])),
      latestPerCheck([row({ check_id: 'a' }), row({ check_id: 'b', ok: 0, exit_code: 2 })], 'r_3'),
      new Map(),
      [],
    );
    expect(ticketHeadline('review', optional)).toBe('必過的 1 項都過，選用的「B」沒過');
    // the engine host is not named in the conclusion
    const local = buildChecks(readFrozenChecks(JSON.stringify([{ id: 'a', name: '建置', kind: 'build' }])), latestPerCheck([row({ check_id: 'a', ok: 0, exit_code: 2 })], 'r_3'), new Map(), []);
    expect(ticketHeadline('failed', local)).toBe('沒過：建置');
  });

  it('falls back to the verify step when a check left no check_runs row, and shows gated metrics', () => {
    const checks = readFrozenChecks(JSON.stringify([{ id: 'ck_gpu', name: 'GPU 效能', kind: 'custom', machine: 'sandbox:local' }, { id: 'ck_p', name: '延遲', kind: 'custom' }]));
    const steps = [{ step: 'check:ck_gpu', ok: false, exitCode: 3, timedOut: false, tail: 'nvcc: error', ms: 2000 }];
    const metrics = JSON.stringify({
      values: { p99_ms: 61, qps: 900 },
      checks: [
        { name: 'qps', op: '>=', target: 800, actual: 900, pass: true },
        { name: 'p99_ms', op: '<=', target: 50, actual: 61, pass: false },
      ],
      pass: false,
    });
    const list = buildChecks(checks, latestPerCheck([row({ check_id: 'ck_p', ok: 0, metrics_json: metrics })], 'r_3'), new Map(), steps);
    expect(list[0]).toMatchObject({ state: 'failed', summary: 'exit 3', where: 'GPU 沙盒', tail: 'nvcc: error', run_id: null, ms: 2000 });
    expect(list[1]).toMatchObject({ state: 'failed', summary: 'p99_ms 61 ≤ 50 · qps 900 ≥ 800' });
    expect(stepLabel('check:ck_gpu', checks)).toBe('GPU 效能');
    expect(stepLabel('npm test', checks)).toBe('npm test');
  });

  it('picks the run to show and the 修前 run of a check', () => {
    const runs = [run('r_3', { verify_json: '[]' }), run('r_2', { verify_json: '[]' }), run('r_1')];
    const rows = [row({ check_id: 'ck_unit', run_id: 'r_2' })];
    expect(pickShownRun(runs, rows, false)).toBe('r_2');
    expect(pickShownRun(runs, rows, true)).toBe('r_3');
    expect(pickShownRun(runs, [], false)).toBe('r_3');
    expect(pickShownRun([run('r_9')], [], false)).toBe('r_9');
    expect(pickShownRun([], [], false)).toBeNull();
    // the latest row of a check wins within the run; other runs and 試跑 rows are ignored
    const a = row({ check_id: 'ck_unit', run_id: 'r_2', ok: 0 });
    const b = row({ check_id: 'ck_unit', run_id: 'r_2', kind: 'reverify', ok: 1 });
    expect(latestPerCheck([a, b, row({ check_id: 'ck_unit', run_id: 'r_1' }), row({ check_id: 'ck_unit', run_id: 'r_2', kind: 'trial' })], 'r_2').get('ck_unit')).toBe(b);

    const ds = readFrozenChecks(CHECKS_JSON)[3]!;
    const baseRow = row({ id: 'cr_base', check_id: 'ck_ds', kind: 'baseline', task_id: null, run_id: null, started_at: '2026-09-20 00:00:00' });
    const trial = row({ check_id: 'ck_ds', kind: 'trial', task_id: null, run_id: null, started_at: '2026-09-25 00:00:00' });
    const late = row({ check_id: 'ck_ds', kind: 'trial', task_id: null, run_id: null, started_at: '2026-10-02 00:00:00' });
    expect(pickBeforeRow(ds, [baseRow, trial, late], '2026-10-01 00:00:00')).toBe(baseRow);
    const noRef = { ...ds, baseline: null };
    expect(pickBeforeRow(noRef, [trial, baseRow, late], '2026-10-01 00:00:00')).toBe(baseRow); // a baseline beats a 試跑
    expect(pickBeforeRow(noRef, [trial, late], '2026-10-01T00:00:00.000Z')).toBe(trial); // never a 試跑 after the run
    expect(pickBeforeRow(noRef, [late], '2026-10-01 00:00:00')).toBeNull();
    expect(pickBeforeRow(noRef, [row({ check_id: 'ck_ds', kind: 'baseline', finished_at: null, run_id: null })], null)).toBeNull(); // unfinished
  });

  it('diffs a 圖資回歸 case by case against the 修前 run, with the pictures each run pulled back', () => {
    const checks = readFrozenChecks(CHECKS_JSON);
    const rows = passedRows();
    const shown = latestPerCheck(rows, 'r_3');
    const before = new Map([['ck_ds', row({ id: 'cr_base', check_id: 'ck_ds', kind: 'baseline', run_id: null, result_json: JSON.stringify(CASES_BEFORE) })]]);
    const afterId = shown.get('ck_ds')!.id;
    const files: Record<string, string[]> = {
      [afterId]: ['out/results.json', 'out/overlays/IMG_0412.png', 'out/overlays/IMG_1103.png', 'inputs/IMG_0412.jpg', '.hidden.png'],
      cr_base: ['out/IMG_0412_overlay.png', 'out/IMG_1103.png'],
    };
    const [view] = buildDatasetViews(checks, shown, before, (id) => files[id] ?? []);
    expect(view).toMatchObject({ check_id: 'ck_ds', name: '圖資回歸', dataset: 'dataset-2026Q2', baseline_sha: '3f2a1c9', run_id: afterId, before_run_id: 'cr_base', truncated: false });
    expect(view!.counts).toEqual({ total: 5, correct_before: 3, correct_after: 3, better: 2, worse: 1, missing: 1 });
    expect(view!.rows.map((r) => [r.case, r.before, r.after, r.change])).toEqual([
      ['IMG_0412', 'NG', 'OK', 'better'],
      ['IMG_0977', 'OK', 'NG', 'better'],
      ['IMG_1103', 'OK', 'NG', 'worse'],
      ['IMG_2000', 'OK', 'OK', 'same'],
      ['IMG_3000', 'NG', null, 'missing'],
    ]);
    expect(view!.rows[0]).toMatchObject({
      image: { run_id: afterId, path: 'inputs/IMG_0412.jpg' },
      after_image: { run_id: afterId, path: 'out/overlays/IMG_0412.png' },
      before_image: { run_id: 'cr_base', path: 'out/IMG_0412_overlay.png' },
    });
    expect(view!.rows[2]).toMatchObject({ note: '標籤不符', image: { run_id: afterId, path: 'out/overlays/IMG_1103.png' }, before_image: { run_id: 'cr_base', path: 'out/IMG_1103.png' } });
    expect(view!.rows[3]).toMatchObject({ image: null, before_image: null, after_image: null });

    // no 修前 run: nothing is better or worse, and the chip has no 修前 count
    const [alone] = buildDatasetViews(checks, shown, new Map(), () => []);
    expect(alone!.counts).toEqual({ total: 5, correct_before: null, correct_after: 3, better: 0, worse: 0, missing: 1 });
    expect(alone!.rows.map((r) => r.change)).toEqual(['same', 'same', 'same', 'same', 'missing']);
    // the cap keeps every changed case
    const [capped] = buildDatasetViews(checks, shown, before, () => [], 3);
    expect(capped!.truncated).toBe(true);
    expect(capped!.rows.map((r) => r.case)).toEqual(['IMG_0412', 'IMG_0977', 'IMG_1103']);
    expect(capped!.counts.total).toBe(5);
    // a dataset check that has no per-case rows (it crashed before comparing) gets no viewer
    expect(buildDatasetViews(checks, latestPerCheck([row({ check_id: 'ck_ds', ok: 0, exit_code: 1 })], 'r_3'), before, () => [])).toEqual([]);
  });

  it('indexes pictures by case: overlays, inputs, the rest', () => {
    const idx = indexImages(['a/overlays/X1.png', 'images/X1.bmp', 'X1.png', 'X2-vis.jpg', 'notes.txt', 'X3.tif']);
    expect(Object.fromEntries(idx.overlay)).toEqual({ X1: 'a/overlays/X1.png', X2: 'X2-vis.jpg' });
    expect(Object.fromEntries(idx.input)).toEqual({ X1: 'images/X1.bmp' });
    expect(Object.fromEntries(idx.other)).toEqual({ X1: 'X1.png' });
  });

  it('keeps the attempt history: model, why each run did not pass, minutes', () => {
    const checks = readFrozenChecks(CHECKS_JSON);
    const unitFail = JSON.stringify([
      { step: 'check:ck_build', ok: true, exitCode: 0, timedOut: false, tail: '' },
      { step: 'check:ck_unit', ok: false, exitCode: 1, timedOut: false, tail: 'FAIL' },
    ]);
    const reproFail = JSON.stringify([{ step: 'check:ck_repro', ok: false, exitCode: 1, timedOut: false, tail: 'still failing' }]);
    const pass = JSON.stringify([{ step: 'check:ck_build', ok: true, exitCode: 0, timedOut: false, tail: '' }]);
    const runs = [
      run('r_3', { model: 'local:glm53-flash', started_at: '2026-10-01 02:00:00', finished_at: '2026-10-01 02:21:00', verify_json: pass }),
      run('r_1', { model: 'local:qwen3-coder-next', started_at: '2026-10-01 00:00:00', finished_at: '2026-10-01 00:12:00', verify_json: unitFail }),
      run('r_2', { model: 'local:qwen3-coder-next', started_at: '2026-10-01 01:00:00', finished_at: '2026-10-01 01:09:00', verify_json: reproFail }),
      run('r_4', { model: 'local:glm53-flash', started_at: '2026-10-01 03:00:00', finished_at: null }),
    ];
    const rows = [row({ check_id: 'ck_repro', run_id: 'r_2', kind: 'red_green', ok: 0, result_json: JSON.stringify({ before: { ok: false, exit_code: 1, tail: '' }, after: { ok: false, exit_code: 1, tail: '' } }) })];
    expect(buildAttempts(runs, checks, rows).map((a) => [a.n, a.run_id, a.model, a.ok, a.outcome, a.minutes])).toEqual([
      [1, 'r_1', 'local:qwen3-coder-next', false, '沒過 單元測試', 12],
      [2, 'r_2', 'local:qwen3-coder-next', false, '沒過 重現（修後仍紅）', 9],
      [3, 'r_3', 'local:glm53-flash', true, '通過', 21],
      [4, 'r_4', 'local:glm53-flash', null, '進行中', null],
    ]);
    const odd = buildAttempts(
      [
        run('a', { started_at: '2026-10-01 00:00:00', interrupted_by: 'pause' }),
        run('b', { started_at: '2026-10-01 00:01:00', interrupted_by: 'user' }),
        run('c', { started_at: '2026-10-01 00:02:00', exit_code: 1 }),
        run('d', { started_at: '2026-10-01 00:03:00' }),
        run('e', { started_at: '2026-10-01 00:04:00', verify_json: JSON.stringify([{ step: 'npm test', ok: false, exitCode: null, timedOut: true, tail: '' }]) }),
      ],
      [],
      [],
    );
    expect(odd.map((a) => a.outcome)).toEqual(['中斷', '中止', '沒完成', '沒有檢查紀錄', '沒過 npm test（逾時）']);
    const beforePassed = buildAttempts(
      [run('r_2', { verify_json: reproFail })],
      checks,
      [row({ check_id: 'ck_repro', run_id: 'r_2', kind: 'red_green', ok: 0, result_json: JSON.stringify({ before: { ok: true, exit_code: 0 }, after: { ok: true, exit_code: 0 } }) })],
    );
    expect(beforePassed[0]!.outcome).toBe('沒過 重現（修前就過了）');
  });

  it('names the model 再試一次（換模型） would switch to', () => {
    const ladder = 'local:qwen3-coder-next, local:glm53-flash';
    expect(nextEscalation(ladder, 'local:qwen3-coder-next', 0)).toBe('local:glm53-flash');
    expect(nextEscalation(ladder, 'opus', 0)).toBe('local:qwen3-coder-next');
    expect(nextEscalation(ladder, 'local:glm53-flash', 1)).toBeNull();
    expect(nextEscalation(ladder, 'local:glm53-flash', 2)).toBeNull();
    expect(nextEscalation('', 'opus', 0)).toBeNull();
    expect(nextEscalation(null, null, null)).toBeNull();
  });

  it('reads the analysis card for the 需求 tab, ignoring what it does not know', () => {
    const a = readAnalysis(
      JSON.stringify({
        kind: 'bugfix',
        summary: '第二次載入同一個 recipe 時沒有重新套用',
        causes: [{ file: 'src/recipe.cpp', why: 'recipe_changed 判成 false', line: 214, evidence: 'if (!recipe_changed) return;' }, { why: 'no file' }],
        repro: { command: 'pytest tests/test_recipe_reload.py', mode: 'existing' },
        questions: ['bypass_edge_x 的單位是 mm 嗎？', { q: '要不要保留舊行為？' }],
        extra: 1,
      }),
    );
    expect(a).toEqual({
      kind: 'bugfix',
      kind_label: '錯誤修復',
      summary: '第二次載入同一個 recipe 時沒有重新套用',
      causes: [{ file: 'src/recipe.cpp', why: 'recipe_changed 判成 false', line: 214, evidence: 'if (!recipe_changed) return;' }],
      repro: { command: 'pytest tests/test_recipe_reload.py', note: 'existing' },
      questions: ['bypass_edge_x 的單位是 mm 嗎？', '要不要保留舊行為？'],
    });
    expect(readAnalysis(null)).toBeNull();
    expect(readAnalysis('[1]')).toBeNull();
  });
});

describe('check run files', () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cr-'));
    tmp.push(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cr-out-'));
    tmp.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    const run = path.join(root, 'cr_1');
    fs.mkdirSync(path.join(run, 'out', 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(run, 'out', 'overlays', 'IMG_1.png'), 'PNG');
    fs.writeFileSync(path.join(run, 'out', 'results.json'), '{}');
    fs.writeFileSync(path.join(run, '.cache'), 'x');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(run, 'out', 'link.txt'));
    fs.symlinkSync(outside, path.join(run, 'escape'));
    fs.mkdirSync(path.join(root, 'cr_2'));
    fs.writeFileSync(path.join(root, 'cr_2', 'other.txt'), 'other run');
    return { root, run };
  }

  it('serves a file of the run, and nothing outside its folder', () => {
    const { root, run } = tree();
    expect(resolveCheckRunFile(root, 'cr_1', 'out/overlays/IMG_1.png')).toBe(fs.realpathSync(path.join(run, 'out', 'overlays', 'IMG_1.png')));
    for (const bad of ['../cr_2/other.txt', 'out/../../cr_2/other.txt', '/etc/passwd', 'out\\results.json', 'out//results.json', './out/results.json', 'out/link.txt', 'escape/secret.txt', 'out', 'missing.png', '']) {
      expect(resolveCheckRunFile(root, 'cr_1', bad), bad).toBeNull();
    }
    for (const id of ['..', 'cr_1/../cr_2', '.', '', 'a b']) expect(resolveCheckRunFile(root, id, 'other.txt'), id).toBeNull();
    expect(resolveCheckRunFile(root, 'cr_2', 'other.txt')).not.toBeNull();
  });

  it('lists what a run pulled back without dot-files or links, and serves only pictures and text in place', () => {
    const { root } = tree();
    expect(listCheckRunFiles(root, 'cr_1')).toEqual(['out/overlays/IMG_1.png', 'out/results.json']);
    expect(listCheckRunFiles(root, 'cr_x')).toEqual([]);
    expect(listCheckRunFiles(root, '../x')).toEqual([]);
    expect(listCheckRunFiles(root, 'cr_1', 1)).toEqual(['out/overlays/IMG_1.png']);
    expect(checkRunFileType('a/IMG.PNG')).toEqual({ type: 'image/png', inline: true });
    expect(checkRunFileType('run.log')).toEqual({ type: 'text/plain; charset=utf-8', inline: true });
    for (const f of ['x.svg', 'x.html', 'x.bin', 'noext']) expect(checkRunFileType(f), f).toEqual({ type: 'application/octet-stream', inline: false });
  });
});
