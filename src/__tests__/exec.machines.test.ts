import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import {
  createMachine,
  datasetsUsingMachine,
  deleteMachine,
  getMachine,
  isWorkRootFor,
  labelsOf,
  lastCheckOf,
  listMachines,
  MachineError,
  normalizeLabels,
  normalizeMachine,
  recordCheck,
  reposUsingMachine,
  RESERVED_MACHINE_NAMES,
  updateMachine,
  type MachineInput,
} from '../exec/machines.js';

/** The 機台 registry: what a row may say, and the CRUD + check bookkeeping around it. */

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

const linux: MachineInput = { name: 'gpu-1', ssh_target: 'loop@gpu-1', work_root: '/srv/loop/' };
const windows: MachineInput = { name: 'aoi-1', ssh_target: 'aoi@aoi-1', os: 'windows', work_root: 'C:/loop/', labels: ['CUDA', 'aoi-v3', 'cuda'] };

describe('normalizeMachine', () => {
  it('fills the defaults and canonicalises what it is given', () => {
    expect(normalizeMachine(linux)).toEqual({
      name: 'gpu-1',
      ssh_target: 'loop@gpu-1',
      ssh_port: null,
      os: 'auto',
      shell: 'auto',
      work_root: '/srv/loop',
      labels: '',
      description: null,
      software: null,
      transport: 'auto',
      enabled: 1,
    });
    expect(normalizeMachine({ ...windows, ssh_port: '2222', shell: 'CMD', transport: 'copy', description: '  RTX A4000  ', software: ' Halcon 23.11 ', enabled: false })).toEqual({
      name: 'aoi-1',
      ssh_target: 'aoi@aoi-1',
      ssh_port: 2222,
      os: 'windows',
      shell: 'cmd',
      work_root: 'C:\\loop',
      labels: 'cuda,aoi-v3',
      description: 'RTX A4000',
      software: 'Halcon 23.11',
      transport: 'copy',
      enabled: 0,
    });
    // a bare host (ssh config alias) and an auto OS with either root shape
    expect(normalizeMachine({ name: 'box', ssh_target: 'aoi-1', work_root: 'D:\\loop\\' }).work_root).toBe('D:\\loop');
    expect(normalizeMachine({ name: 'box', ssh_target: 'aoi-1', work_root: '//srv//loop' }).work_root).toBe('/srv/loop');
  });

  it.each<[string, Partial<MachineInput>, RegExp]>([
    ['a reserved name', { name: 'local' }, /機台名稱/],
    ['the other reserved name', { name: 'engine' }, /機台名稱/],
    ['an upper-case name', { name: 'Gpu-1' }, /機台名稱/],
    ['a name starting with -', { name: '-x' }, /機台名稱/],
    ['a 41-char name', { name: 'a'.repeat(41) }, /機台名稱/],
    ['an empty name', { name: '' }, /機台名稱/],
    ['a target with a space', { ssh_target: 'loop @gpu' }, /SSH 目標/],
    ['a target ssh would read as an option', { ssh_target: '-oProxyCommand=x' }, /SSH 目標/],
    ['two @', { ssh_target: 'a@b@c' }, /SSH 目標/],
    ['an empty target', { ssh_target: '' }, /SSH 目標/],
    ['port 0', { ssh_port: 0 }, /SSH 埠/],
    ['port 70000', { ssh_port: 70000 }, /SSH 埠/],
    ['a non-numeric port', { ssh_port: 'abc' }, /SSH 埠/],
    ['a fractional port', { ssh_port: 22.5 }, /SSH 埠/],
    ['an unknown OS', { os: 'mac' }, /作業系統/],
    ['an unknown shell', { shell: 'zsh' }, /shell/],
    ['PowerShell on Linux', { os: 'linux', shell: 'powershell' }, /Linux 機台的 shell/],
    ['bash on Windows', { os: 'windows', work_root: 'C:\\loop', shell: 'bash' }, /Windows 機台的 shell/],
    ['a Windows root on a Linux box', { os: 'linux', work_root: 'C:\\loop' }, /工作目錄/],
    ['a Linux root on a Windows box', { os: 'windows', work_root: '/srv/loop' }, /工作目錄/],
    ['a relative root', { work_root: 'loop' }, /工作目錄/],
    ['the filesystem root', { work_root: '/' }, /工作目錄/],
    ['a bare drive', { os: 'windows', work_root: 'C:\\' }, /工作目錄/],
    ['a root with ..', { work_root: '/srv/../loop' }, /工作目錄/],
    ['a root with a space', { os: 'windows', work_root: 'C:\\my loop' }, /工作目錄/],
    ["a root with a quote", { work_root: "/srv/lo'op" }, /工作目錄/],
    ['a label with a space', { labels: 'cuda,aoi v3' }, /標籤/],
    ['too many labels', { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }, /標籤最多/],
    ['an unknown transport', { transport: 'ftp' }, /transport/],
    ['a novel of a description', { description: 'x'.repeat(2001) }, /說明太長/],
  ])('rejects %s', (_what, patch, msg) => {
    expect(() => normalizeMachine({ ...linux, ...patch })).toThrow(msg);
    expect(() => normalizeMachine({ ...linux, ...patch })).toThrow(MachineError);
  });

  it('exposes the root and label rules', () => {
    expect(RESERVED_MACHINE_NAMES).toEqual(['local', 'engine', 'sandbox']); // 'sandbox' is a route segment
    expect(isWorkRootFor('linux', '/srv/loop')).toBe(true);
    expect(isWorkRootFor('windows', 'C:\\loop')).toBe(true);
    expect(isWorkRootFor('auto', 'C:\\loop')).toBe(true);
    expect(isWorkRootFor('auto', 'loop')).toBe(false);
    expect(normalizeLabels(' cuda, GPU ,,cuda ')).toBe('cuda,gpu');
    expect(normalizeLabels(null)).toBe('');
    expect(labelsOf({ labels: 'cuda,gpu' })).toEqual(['cuda', 'gpu']);
    expect(labelsOf({ labels: '' })).toEqual([]);
  });
});

describe('CRUD', () => {
  it('creates, reads, lists and refuses a duplicate', () => {
    const m = createMachine(db, windows);
    expect(m).toMatchObject({ name: 'aoi-1', os: 'windows', shell: 'auto', work_root: 'C:\\loop', labels: 'cuda,aoi-v3', transport: 'auto', enabled: 1, last_check_ok: null });
    expect(m.created_at).toBeTruthy();
    createMachine(db, { ...linux, enabled: false });
    expect(() => createMachine(db, windows)).toThrow(/已經有這台機台：aoi-1/);
    expect(() => createMachine(db, { ...linux, name: 'local' })).toThrow(MachineError);
    expect(listMachines(db).map((x) => x.name)).toEqual(['aoi-1', 'gpu-1']);
    expect(listMachines(db, { enabledOnly: true }).map((x) => x.name)).toEqual(['aoi-1']);
    expect(getMachine(db, 'aoi-1')?.ssh_target).toBe('aoi@aoi-1');
    expect(getMachine(db, 'nope')).toBeUndefined();
  });

  it('updates only the fields given, validates the whole row, never renames', () => {
    createMachine(db, windows);
    const m = updateMachine(db, 'aoi-1', { description: 'RTX A4000', ssh_port: 2222 });
    expect(m).toMatchObject({ ssh_target: 'aoi@aoi-1', ssh_port: 2222, description: 'RTX A4000', labels: 'cuda,aoi-v3', os: 'windows' });
    expect(updateMachine(db, 'aoi-1', { ssh_port: null, labels: [] })).toMatchObject({ ssh_port: null, labels: '' });
    expect(updateMachine(db, 'aoi-1', { enabled: false })?.enabled).toBe(0);
    expect(updateMachine(db, 'aoi-1', { description: null })?.description).toBeNull();
    // the merged row is validated: a Linux root on this Windows box is refused and nothing changes
    expect(() => updateMachine(db, 'aoi-1', { work_root: '/srv/loop' })).toThrow(/工作目錄/);
    expect(getMachine(db, 'aoi-1')?.work_root).toBe('C:\\loop');
    expect(() => updateMachine(db, 'aoi-1', { name: 'aoi-2' })).toThrow(/不能改名/);
    expect(updateMachine(db, 'aoi-1', { name: 'aoi-1', shell: 'cmd' })?.shell).toBe('cmd');
    expect(updateMachine(db, 'ghost', { description: 'x' })).toBeUndefined();
  });

  it('deletes', () => {
    createMachine(db, linux);
    expect(deleteMachine(db, 'gpu-1')).toBe(true);
    expect(deleteMachine(db, 'gpu-1')).toBe(false);
    expect(listMachines(db)).toEqual([]);
  });

  it('recordCheck stores the lines and fills only what still says auto', () => {
    createMachine(db, linux);
    const lines = [
      { ok: true, label: 'SSH 登入', detail: 'loop@gpu-1（Linux，bash）' },
      { ok: null, label: 'Python', detail: '找不到 python' },
    ];
    const m = recordCheck(db, 'gpu-1', lines, true, { os: 'linux', shell: 'bash', transport: 'gitea' })!;
    expect(m).toMatchObject({ os: 'linux', shell: 'bash', transport: 'gitea', last_check_ok: 1 });
    expect(m.last_check_at).toBeTruthy();
    expect(lastCheckOf(m)).toEqual(lines);
    // a later check never overrides what a person (or the first check) set; null/auto leave things alone
    const again = recordCheck(db, 'gpu-1', [], false, { os: 'windows', shell: 'auto', transport: null })!;
    expect(again).toMatchObject({ os: 'linux', shell: 'bash', transport: 'gitea', last_check_ok: 0 });
    expect(lastCheckOf(again)).toEqual([]);
    createMachine(db, { ...windows, transport: 'copy' });
    expect(recordCheck(db, 'aoi-1', [], true, { os: 'windows', shell: 'powershell', transport: 'gitea' })).toMatchObject({ os: 'windows', shell: 'powershell', transport: 'copy' });
    expect(recordCheck(db, 'ghost', [], true)).toBeUndefined();
    expect(lastCheckOf({ last_check_json: '{not json' })).toBeNull();
    expect(lastCheckOf({ last_check_json: null })).toBeNull();
  });

  it('lists the repos and 圖資 whose checks run on a machine', () => {
    createMachine(db, linux);
    expect(reposUsingMachine(db, 'gpu-1')).toEqual([]);
    expect(datasetsUsingMachine(db, 'gpu-1')).toEqual([]);
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path, machine) VALUES ('r_1', 'cf-aoi', 'http://gitea.corp:3000/aoi/cf-aoi.git', '/tmp/cf-aoi', 'gpu-1')").run();
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path, machine, enabled) VALUES ('r_2', 'old', 'http://gitea.corp:3000/aoi/old.git', '/tmp/old', 'gpu-1', 0)").run();
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path) VALUES ('r_3', 'engine-only', 'http://gitea.corp:3000/aoi/e.git', '/tmp/e')").run();
    db.prepare("INSERT INTO datasets (id, name, remote_url) VALUES ('ds_1', 'dataset-2026Q2', 'http://gitea.corp:3000/aoi/ds.git')").run();
    db.prepare("INSERT INTO checks (id, repo_id, name, kind, machine, command, dataset_id) VALUES ('ck_1', 'r_1', '圖資回歸', 'dataset', 'gpu-1', 'run --in {images}', 'ds_1')").run();
    expect(reposUsingMachine(db, 'gpu-1')).toEqual([{ name: 'cf-aoi', remoteUrl: 'http://gitea.corp:3000/aoi/cf-aoi.git' }]);
    expect(datasetsUsingMachine(db, 'gpu-1')).toEqual([{ name: 'dataset-2026Q2' }]);
    expect(datasetsUsingMachine(db, 'other')).toEqual([]);
  });
});
