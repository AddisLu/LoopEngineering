import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createPlan, datasetPath, getPlan, hostPathFor, listDatasets, listPlans, PlanError, planSteps, updatePlan } from '../plans/store.js';
import { upsertExecHost, type HostExec } from '../exec/hosts.js';
import { buildApp } from '../server/app.js';

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plans-'));
  tmp.push(d);
  return d;
};

const BRIGHT = {
  name: '亮缺陷判型 — 標準圖集',
  repo_path: '/srv/repos/cf-aoi',
  host: 'aoi-gpu',
  steps: ['cmake --build build -j', 'python3 scripts/eval/run.py --gallery {dataset} --golden {dataset}/golden'],
  dataset_root: '/datasets',
  dataset_default: '20260615',
  metrics: 'detection_rate >= 0.98; miss == 0',
  protected_paths: 'scripts/eval/**, data/golden/**',
  artifacts: ['build/cfaoi_ip', 'reports/*.csv'],
  manual_checks: ['上機台跑一次', '  ', '確認 UI 判型名稱'],
  domain: 'cuda',
};

describe('verification plans', () => {
  it('stores a plan with its lists normalised and thresholds checked', () => {
    const p = createPlan(db, BRIGHT, '呂侑儒');
    expect(p.id).toMatch(/^vp_/);
    expect(p.protected_paths).toEqual(['scripts/eval/**', 'data/golden/**']);
    expect(p.artifacts).toEqual(['build/cfaoi_ip', 'reports/*.csv']);
    expect(p.manual_checks).toEqual(['上機台跑一次', '確認 UI 判型名稱']);
    expect(p.metrics).toBe('detection_rate >= 0.98; miss == 0');
    expect(p.created_by).toBe('呂侑儒');
    const u = updatePlan(db, p.id, { ...BRIGHT, name: '改名' }, 'someone')!;
    expect(u.name).toBe('改名');
    expect(u.updated_by).toBe('someone');
    expect(updatePlan(db, 'vp_nope', BRIGHT)).toBeNull();
  });

  it('rejects what an operator could not use', () => {
    const bad = (patch: Record<string, unknown>) => () => createPlan(db, { ...BRIGHT, ...patch } as typeof BRIGHT);
    expect(bad({ name: ' ' })).toThrow(PlanError);
    expect(bad({ steps: [] })).toThrow(/至少要有一個/);
    expect(bad({ dataset_root: null })).toThrow(/{dataset}/);
    expect(bad({ metrics: 'detection rate high' })).toThrow(/驗收門檻/);
    expect(bad({ protected_paths: '/etc/passwd' })).toThrow(/相對路徑/);
    expect(bad({ artifacts: '../secret' })).toThrow(/產出物/);
    expect(bad({ steps: ['sandbox@x: make'] })).toThrow(/不用再寫 sandbox/);
    expect(bad({ domain: 'cobol' })).toThrow(/領域/);
    expect(bad({ repo_path: 'relative/repo' })).toThrow(/絕對路徑/);
  });

  it('turns into verification steps aimed at its machine, with the picked 圖資 filled in', () => {
    const p = createPlan(db, BRIGHT);
    const ds = datasetPath(p, null)!;
    expect(ds).toBe('/datasets/20260615');
    expect(planSteps(p, ds)).toEqual([
      'sandbox@aoi-gpu: cmake --build build -j',
      'sandbox@aoi-gpu: python3 scripts/eval/run.py --gallery /datasets/20260615 --golden /datasets/20260615/golden',
    ]);
    const local = createPlan(db, { ...BRIGHT, host: 'local' });
    expect(planSteps(local, '/datasets/x')[0]).toBe('sandbox: cmake --build build -j');
    const shell = createPlan(db, { ...BRIGHT, host: null, steps: ['npm test'], dataset_root: null });
    expect(planSteps(shell, null)).toEqual(['npm test']);
    expect(() => planSteps(p, null)).toThrow(/選圖資/);
    expect(() => datasetPath(p, '../../etc')).toThrow(/圖資名稱/);
  });

  it('lists plans for a repo: its own first, then the ones for every repo', () => {
    createPlan(db, { ...BRIGHT, name: 'B 通用', repo_path: null, host: null, steps: ['make test'], dataset_root: null });
    createPlan(db, { ...BRIGHT, name: 'A 專用' });
    createPlan(db, { ...BRIGHT, name: 'C 別的', repo_path: '/srv/repos/other' });
    expect(listPlans(db, '/srv/repos/cf-aoi').map((p) => p.name)).toEqual(['A 專用', 'B 通用']);
    expect(listPlans(db).length).toBe(3);
  });
});

describe('圖資 listing', () => {
  it('maps the container path through the machine\'s read-only mounts', () => {
    const mounts = [{ source: '/mnt/aoi', target: '/datasets' }];
    expect(hostPathFor(mounts, '/datasets')).toBe('/mnt/aoi');
    expect(hostPathFor(mounts, '/datasets/2026')).toBe('/mnt/aoi/2026');
    expect(hostPathFor(mounts, '/data')).toBeNull();
  });

  it('local sandbox: folders of the mounted source, newest first, with image counts', async () => {
    const src = dir();
    for (const [name, n] of [['20260615', 3], ['20260701', 2], ['.hidden', 1]] as const) {
      fs.mkdirSync(path.join(src, name, 'sub'), { recursive: true });
      for (let i = 0; i < n; i++) fs.writeFileSync(path.join(src, name, i % 2 ? 'sub' : '', `img${i}.png`), 'x');
      fs.writeFileSync(path.join(src, name, 'notes.txt'), 'x');
    }
    setSetting(db, 'exec_data_mounts', `${src}:/datasets`);
    const p = createPlan(db, { ...BRIGHT, host: 'local' });
    const ds = await listDatasets(db, p);
    expect(ds).toEqual([
      { name: '20260701', path: '/datasets/20260701', images: 2 },
      { name: '20260615', path: '/datasets/20260615', images: 3 },
    ]);
  });

  it('a machine without that mount says how to add it', async () => {
    upsertExecHost(db, { name: 'aoi-gpu', ssh_target: 'loop@aoi-gpu', work_root: '/srv/loop-exec', data_mounts: '/mnt/other:/other' });
    const p = createPlan(db, BRIGHT);
    await expect(listDatasets(db, p)).rejects.toThrow(/--data <那台路徑>:\/datasets/);
  });

  it('remote machine: one ssh call lists the folders and counts', async () => {
    upsertExecHost(db, { name: 'aoi-gpu', ssh_target: 'loop@aoi-gpu', ssh_port: 2222, work_root: '/srv/loop-exec', data_mounts: '/mnt/aoi:/datasets' });
    const calls: string[][] = [];
    const exec: HostExec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, out: '20260615\t1240\n20260701\t860\nbad/name\t1\n' };
    };
    const ds = await listDatasets(db, createPlan(db, BRIGHT), exec);
    expect(ds.map((d) => `${d.name}:${d.images}`)).toEqual(['20260701:860', '20260615:1240']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('loop@aoi-gpu');
    expect(calls[0]!.join(' ')).toContain("cd '/mnt/aoi'");
    const down: HostExec = async () => ({ code: 255, out: 'ssh: connect to host aoi-gpu port 2222: Connection refused' });
    await expect(listDatasets(db, createPlan(db, BRIGHT), down)).rejects.toThrow(/連不上 aoi-gpu/);
  });
});

describe('驗證方案 API', () => {
  it('create, read, update, list, datasets, check, delete', async () => {
    upsertExecHost(db, { name: 'aoi-gpu', ssh_target: 'loop@aoi-gpu', work_root: '/srv/loop-exec', data_mounts: '/mnt/aoi:/datasets' });
    const app = buildApp({
      db,
      apiToken: null,
      mcpPool: null,
      planHostExec: async () => ({ code: 0, out: '20260615\t1240\n' }),
      planCheck: async () => [{ ok: true, label: 'Docker', detail: '27.0' }],
    });
    try {
      const bad = await app.inject({ method: 'POST', url: '/api/verify-plans', payload: { name: 'x', steps: [] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('至少要有一個');
      const created = await app.inject({ method: 'POST', url: '/api/verify-plans', payload: { ...BRIGHT, steps: BRIGHT.steps.join('\n') }, headers: { 'x-loop-user': '呂侑儒' } });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      expect(getPlan(db, id)!.created_by).toBe('呂侑儒');
      const list = (await app.inject({ method: 'GET', url: `/api/verify-plans?repo=${encodeURIComponent('/srv/repos/cf-aoi')}` })).json();
      expect(list.plans.map((p: { id: string }) => p.id)).toEqual([id]);
      expect(list.hosts.map((h: { name: string }) => h.name)).toEqual(['local', 'aoi-gpu']);
      const put = await app.inject({ method: 'PUT', url: `/api/verify-plans/${id}`, payload: { ...BRIGHT, metrics: 'miss == 0' } });
      expect(put.json().metrics).toBe('miss == 0');
      const ds = (await app.inject({ method: 'GET', url: `/api/verify-plans/${id}/datasets` })).json();
      expect(ds).toEqual({ datasets: [{ name: '20260615', path: '/datasets/20260615', images: 1240 }], default: '20260615' });
      const check = (await app.inject({ method: 'POST', url: `/api/verify-plans/${id}/check` })).json();
      expect(check.ok).toBe(true);
      expect(check.datasets.detail).toContain('1 個圖資資料夾');
      expect((await app.inject({ method: 'DELETE', url: `/api/verify-plans/${id}` })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/verify-plans/${id}` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
