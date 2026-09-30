import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import {
  CheckError,
  createCheck,
  deleteCheck,
  getCheck,
  listChecks,
  normalizeMachine,
  parseBaseline,
  reorderChecks,
  updateCheck,
  writeBaseline,
} from '../checks/store.js';
import { createDataset, deleteDataset, getDataset, listDatasets, updateDataset } from '../checks/datasets.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  db.prepare('INSERT INTO repos (id, name, remote_url, local_path) VALUES (?, ?, ?, ?)').run('r_cfaoi', 'cf-aoi', 'http://gitea.corp:3000/aoi/cf-aoi.git', '/srv/repos/cf-aoi');
  db.prepare('INSERT INTO repos (id, name, remote_url, local_path) VALUES (?, ?, ?, ?)').run('r_other', 'other', 'http://gitea.corp:3000/aoi/other.git', '/srv/repos/other');
});
afterEach(() => db.close());

const err = (fn: () => unknown): CheckError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CheckError) return e;
    throw e;
  }
  throw new Error('expected a CheckError');
};

describe('檢查 store', () => {
  it('creates a check with ck_ ids, ord in creation order and normalized fields', () => {
    const build = createCheck(db, 'r_cfaoi', { name: ' 建置 ', kind: 'build', command: 'cmake --build build -j', machine: 'aoi-1' }, '呂侑儒');
    const test = createCheck(db, 'r_cfaoi', {
      name: '單元測試',
      kind: 'test',
      command: 'ctest --test-dir build',
      pass_rule: 'metrics',
      metrics: 'pass_rate ≥ 1, fail = 0',
      protected_paths: ['tests/golden/**', ' scripts/eval/ '],
      timeout_min: '30',
      required: false,
    });
    expect(build.id).toMatch(/^ck_[\w-]{8}$/);
    expect(build.name).toBe('建置');
    expect(build.machine).toBe('aoi-1');
    expect(build.created_by).toBe('呂侑儒');
    expect(build.pass_rule).toBe('exit0');
    expect(build.required).toBe(1);
    expect(build.red_on_base).toBe(1);
    expect(build.enabled).toBe(1);
    expect([build.ord, test.ord]).toEqual([0, 1]);
    expect(test.metrics).toBe('pass_rate >= 1; fail == 0');
    expect(test.protected_paths).toBe('tests/golden/**,scripts/eval/');
    expect(test.timeout_min).toBe(30);
    expect(test.required).toBe(0);
    expect(listChecks(db, 'r_cfaoi').map((c) => c.id)).toEqual([build.id, test.id]);
    expect(listChecks(db, 'r_other')).toEqual([]);
  });

  it('manual checks need no command and drop one that was sent', () => {
    const m = createCheck(db, 'r_cfaoi', { name: '上機台確認', kind: 'manual', command: 'ignored', manual_text: '在 aoi-1 上跑一次 LOAD_RECIPE 兩次' });
    expect(m.command).toBeNull();
    expect(m.manual_text).toBe('在 aoi-1 上跑一次 LOAD_RECIPE 兩次');
  });

  it('validates every field with a message an engineer can act on', () => {
    expect(err(() => createCheck(db, 'r_nope', { name: 'x', kind: 'build', command: 'make' })).status).toBe(404);
    expect(err(() => createCheck(db, 'r_cfaoi', { name: '  ', kind: 'build', command: 'make' })).message).toContain('不能空白');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x'.repeat(61), kind: 'build', command: 'make' })).message).toContain('60');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'lint', command: 'make' })).message).toContain('類型');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', pass_rule: 'always' })).message).toContain('怎麼算過');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: '  ' })).message).toContain('指令');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', metrics: 'fast please' })).message).toContain('門檻');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'custom', command: 'bench', pass_rule: 'metrics' })).message).toContain('試跑');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'sandbox: make' })).message).toContain('前綴');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'test', command: 'run --out {out}' })).message).toContain('只有圖資回歸');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'dataset', command: 'run --out {out}' })).message).toContain('圖資');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'dataset', command: 'run --out {out}', dataset_id: 'ds_missing' })).message).toContain('沒有這個圖資');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', machine: 'AOI 1' })).message).toContain('機台名稱');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', machine: 'local' })).message).toContain('保留字');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'repro', command: 'pytest', machine: 'sandbox:local' })).message).toContain('GPU 沙盒');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'repro', command: 'pytest', test_globs: '/etc/**' })).message).toContain('相對路徑');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', protected_paths: '../x' })).message).toContain('保護路徑');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', artifacts: 'C:\\out\\x.exe' })).message).toContain('產出物');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', timeout_min: 0 })).message).toContain('1–240');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', timeout_min: 241 })).message).toContain('1–240');
    expect(err(() => createCheck(db, 'r_cfaoi', { name: 'x', kind: 'build', command: 'make', baseline_tol: -1 })).message).toContain('容許');
    expect(listChecks(db, 'r_cfaoi')).toEqual([]);
  });

  it('machine is null (engine host), a machine name, or sandbox:<host|local>', () => {
    expect(normalizeMachine(null)).toBeNull();
    expect(normalizeMachine('')).toBeNull();
    expect(normalizeMachine('engine')).toBeNull();
    expect(normalizeMachine('aoi-1')).toBe('aoi-1');
    expect(normalizeMachine('sandbox:local')).toBe('sandbox:local');
    expect(normalizeMachine('sandbox:aoi-gpu')).toBe('sandbox:aoi-gpu');
    expect(() => normalizeMachine('sandbox:')).toThrow(CheckError);
    expect(() => normalizeMachine('x'.repeat(41))).toThrow(CheckError);
  });

  it('PATCH changes only what was sent, null clears, and the whole row is re-validated', () => {
    const c = createCheck(db, 'r_cfaoi', { name: '建置', kind: 'build', command: 'make', machine: 'aoi-1', timeout_min: 30 });
    const moved = updateCheck(db, c.id, { machine: null, name: '建置（引擎）' }, 'someone')!;
    expect(moved.machine).toBeNull();
    expect(moved.name).toBe('建置（引擎）');
    expect(moved.command).toBe('make');
    expect(moved.timeout_min).toBe(30);
    expect(moved.updated_by).toBe('someone');
    expect(moved.created_by).toBeNull();
    expect(err(() => updateCheck(db, c.id, { kind: 'dataset' })).message).toContain('{out}');
    expect(getCheck(db, c.id)!.kind).toBe('build');
    expect(updateCheck(db, 'ck_missing', { name: 'x' })).toBeNull();
  });

  it('reorders by id list, keeps the rest after, rejects foreign ids', () => {
    const a = createCheck(db, 'r_cfaoi', { name: 'a', kind: 'build', command: 'a' });
    const b = createCheck(db, 'r_cfaoi', { name: 'b', kind: 'test', command: 'b' });
    const c = createCheck(db, 'r_cfaoi', { name: 'c', kind: 'test', command: 'c' });
    const o = createCheck(db, 'r_other', { name: 'o', kind: 'test', command: 'o' });
    expect(reorderChecks(db, 'r_cfaoi', [c.id, a.id]).map((x) => x.name)).toEqual(['c', 'a', 'b']);
    expect(err(() => reorderChecks(db, 'r_cfaoi', [o.id])).message).toContain('不是這個 repo');
    expect(listChecks(db, 'r_cfaoi').map((x) => x.ord)).toEqual([0, 1, 2]);
    expect(deleteCheck(db, b.id)).toBe(true);
    expect(deleteCheck(db, b.id)).toBe(false);
    expect(listChecks(db, 'r_cfaoi').map((x) => x.name)).toEqual(['c', 'a']);
  });

  it('a baseline is stored as JSON and read back defensively', () => {
    const c = createCheck(db, 'r_cfaoi', { name: '圖資', kind: 'custom', command: 'bench', pass_rule: 'baseline' });
    expect(parseBaseline(c)).toBeNull();
    const b = writeBaseline(db, c.id, { sha: 'abc123', values: { correct_rate: 0.987, time_ms: 5100 }, ms: 5300, at: '2026-10-01T00:00:00Z', run_id: 'cr_x' })!;
    expect(parseBaseline(b)).toEqual({ sha: 'abc123', values: { correct_rate: 0.987, time_ms: 5100 }, ms: 5300, at: '2026-10-01T00:00:00Z', run_id: 'cr_x' });
    expect(parseBaseline({ baseline_json: '{broken' })).toBeNull();
  });

  it('deleting a repo takes its checks with it', () => {
    createCheck(db, 'r_cfaoi', { name: 'a', kind: 'build', command: 'a' });
    db.prepare('DELETE FROM repos WHERE id = ?').run('r_cfaoi');
    expect(listChecks(db, 'r_cfaoi')).toEqual([]);
  });
});

describe('圖資 store', () => {
  it('creates, lists, updates and deletes with ds_ ids and defaults', () => {
    const ds = createDataset(db, { name: 'dataset-2026Q2', remote_url: 'http://gitea.corp:3000/aoi/dataset-2026Q2.git', cases: 1204 }, 'addis');
    expect(ds.id).toMatch(/^ds_[\w-]{8}$/);
    expect(ds.images_dir).toBe('images');
    expect(ds.answer_file).toBe('answers.json');
    expect(ds.answer_format).toBe('auto');
    expect(ds.cases).toBe(1204);
    expect(ds.created_by).toBe('addis');
    const cjk = createDataset(db, { name: '亮缺陷_20260615', remote_url: 'git@gitea.corp:aoi/bright.git', images_dir: './imgs/val/', answer_file: 'labels', answer_format: 'labels' });
    expect(cjk.images_dir).toBe('imgs/val');
    expect(listDatasets(db).map((d) => d.name)).toEqual(['dataset-2026Q2', '亮缺陷_20260615']);
    const up = updateDataset(db, ds.id, { answer_format: 'csv', answer_file: 'answers.csv' })!;
    expect(up.answer_format).toBe('csv');
    expect(up.remote_url).toBe('http://gitea.corp:3000/aoi/dataset-2026Q2.git');
    expect(updateDataset(db, 'ds_missing', { name: 'x' })).toBeNull();
    expect(deleteDataset(db, cjk.id)).toBe(true);
    expect(getDataset(db, cjk.id)).toBeNull();
    expect(deleteDataset(db, cjk.id)).toBe(false);
  });

  it('rejects unsafe names, paths and URLs with credentials; names are unique', () => {
    const base = { remote_url: 'http://gitea.corp:3000/aoi/ds.git' };
    expect(err(() => createDataset(db, { ...base, name: 'has space' })).message).toContain('圖資名稱');
    expect(err(() => createDataset(db, { ...base, name: 'a/b' })).message).toContain('圖資名稱');
    expect(err(() => createDataset(db, { ...base, name: '$(rm -rf)' })).message).toContain('圖資名稱');
    expect(err(() => createDataset(db, { ...base, name: 'ok', images_dir: '../etc' })).message).toContain('相對路徑');
    expect(err(() => createDataset(db, { ...base, name: 'ok', answer_file: '/abs/answers.json' })).message).toContain('相對路徑');
    expect(err(() => createDataset(db, { ...base, name: 'ok', answer_format: 'xml' })).message).toContain('答案格式');
    expect(err(() => createDataset(db, { name: 'ok', remote_url: 'http://oauth2:secret@gitea.corp/aoi/ds.git' })).message).toContain('token');
    expect(err(() => createDataset(db, { name: 'ok', remote_url: 'https://ghp_token@github.com/x/y.git' })).message).toContain('token');
    expect(err(() => createDataset(db, { name: 'ok', remote_url: 'not a url' })).message).toContain('網址');
    expect(err(() => createDataset(db, { name: 'ok', remote_url: '' })).message).toContain('網址');
    expect(createDataset(db, { name: 'ssh', remote_url: 'ssh://git@gitea.corp:2222/aoi/ds.git' }).remote_url).toBe('ssh://git@gitea.corp:2222/aoi/ds.git');
    createDataset(db, { ...base, name: 'dup' });
    expect(err(() => createDataset(db, { ...base, name: 'dup' })).status).toBe(409);
  });

  it('a dataset a check uses cannot be deleted', () => {
    const ds = createDataset(db, { name: 'q2', remote_url: 'file:///srv/ds/q2.git' });
    createCheck(db, 'r_cfaoi', { name: '圖資回歸', kind: 'dataset', command: 'run --in {images} --out {out}', dataset_id: ds.id, pass_rule: 'baseline' });
    const e = err(() => deleteDataset(db, ds.id));
    expect(e.status).toBe(409);
    expect(e.message).toContain('圖資回歸');
    expect(getDataset(db, ds.id)).not.toBeNull();
  });
});
