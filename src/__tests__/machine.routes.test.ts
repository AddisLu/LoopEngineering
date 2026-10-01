import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import type { HostExec } from '../exec/hosts.js';
import { decodePowerShell } from '../exec/remote.js';
import { getMachine } from '../exec/machines.js';

/**
 * /api/machines*: the 機台 page's CRUD and the health check, with ssh replaced by a scripted
 * Linux box. The check must persist Screen 5's lines and fill in os / shell / transport on a row
 * that still says auto. Zero network.
 */

const PROBE = ['== git', 'git version 2.45.1', '== work', 'work: writable', 'free_kb:222298112', '== python', 'python: not found', '== gpu', 'gpu: none', '== repos', 'repo cf-aoi missing', '== datasets', ''].join('\n');

/** what the remote command was, whichever OS wrapped it */
function innerOf(remote: string): string {
  const pre = 'powershell -NoProfile -NonInteractive -EncodedCommand ';
  if (remote.startsWith(pre)) {
    const outer = decodePowerShell(remote.slice(pre.length));
    const enc = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)?.[1];
    return enc ? decodePowerShell(enc) : outer;
  }
  const lin = /bash -lc '((?:[^']|'\\'')*)' 2>&1$/.exec(remote);
  return lin ? lin[1]!.replace(/'\\''/g, "'") : remote;
}

function linuxBox(opts: { sshCode?: number; lsCode?: number } = {}) {
  const seen: string[] = [];
  const exec: HostExec = async (cmd, args) => {
    const remote = cmd === 'ssh' ? innerOf(args[args.length - 1] ?? '') : `${cmd} ${args.join(' ')}`;
    seen.push(remote);
    if (opts.sshCode) return { code: opts.sshCode, out: 'Permission denied (publickey).' };
    if (remote === 'uname -s') return { code: 0, out: 'Linux\n' };
    if (remote.includes('== git')) return { code: 0, out: PROBE };
    if (remote.includes('ls-remote')) return { code: opts.lsCode ?? 0, out: opts.lsCode ? 'fatal: Authentication failed' : 'abc\tHEAD\n' };
    return { code: 1, out: '' };
  };
  return { exec, seen };
}

let db: Database.Database;
let app: FastifyInstance;
let box: ReturnType<typeof linuxBox>;
beforeEach(async () => {
  db = openTestDb();
  box = linuxBox();
  app = buildApp({ db, apiToken: null, machineRoutes: { hostExec: (...a) => box.exec(...a) } });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), headers: { 'x-loop-user': 'addis' } });

describe('machine routes', () => {
  it('creates, lists (with the sandbox hosts read-only), reads, patches and deletes', async () => {
    const created = await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'loop@gpu-1', work_root: '/srv/loop', labels: ['CUDA', 'gpu'], ssh_port: '2222' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'gpu-1', ssh_port: 2222, os: 'auto', shell: 'auto', transport: 'auto', labels: 'cuda,gpu', labels_list: ['cuda', 'gpu'], last_check: null, enabled: 1 });

    const list = await call('GET', '/api/machines');
    expect(list.statusCode).toBe(200);
    expect(list.json().machines.map((m: { name: string }) => m.name)).toEqual(['gpu-1']);
    expect(list.json().sandbox_hosts[0]).toMatchObject({ name: 'local', default: true });

    expect((await call('GET', '/api/machines/gpu-1')).json()).toMatchObject({ name: 'gpu-1', ssh_target: 'loop@gpu-1' });
    expect((await call('GET', '/api/machines/ghost')).statusCode).toBe(404);

    const patched = await call('PATCH', '/api/machines/gpu-1', { description: 'RTX 4090', enabled: 'false' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ description: 'RTX 4090', enabled: 0, ssh_target: 'loop@gpu-1', labels: 'cuda,gpu' });
    expect((await call('PATCH', '/api/machines/ghost', { description: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', '/api/machines/gpu-1')).json()).toEqual({ ok: true });
    expect((await call('DELETE', '/api/machines/gpu-1')).statusCode).toBe(404);
    expect(db.prepare("SELECT detail FROM task_events WHERE detail LIKE '機台%' ORDER BY id").all().map((r) => (r as { detail: string }).detail)).toEqual([
      '機台新增：gpu-1（loop@gpu-1）by addis',
      '機台修改：gpu-1 by addis',
      '機台刪除：gpu-1 by addis',
    ]);
  });

  it('answers 400 with the reason for a bad row and 409 for a duplicate', async () => {
    const bad = await call('POST', '/api/machines', { name: 'local', ssh_target: 'x@y', work_root: '/srv/loop' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('機台名稱');
    expect((await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'x@y', work_root: '/srv/loop', os: 'linux', shell: 'cmd' })).json().error).toContain('Linux 機台的 shell');
    expect((await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'loop@gpu-1', work_root: '/srv/loop' })).statusCode).toBe(201);
    const dup = await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'other@gpu-1', work_root: '/srv/loop' });
    expect(dup.statusCode).toBe(409);
    expect((await call('PATCH', '/api/machines/gpu-1', { work_root: 'relative' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/machines/gpu-1', { name: 'gpu-2' })).json().error).toContain('不能改名');
    expect(getMachine(db, 'gpu-1')?.work_root).toBe('/srv/loop');
  });

  it('check: runs the health check over the injected ssh, stores the lines and fills in what it detected', async () => {
    await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'loop@gpu-1', work_root: '/srv/loop' });
    const r = await call('POST', '/api/machines/gpu-1/check', { repos: [{ name: 'cf-aoi', remote_url: 'http://gitea.corp:3000/aoi/cf-aoi.git' }], datasets: [] });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.detected).toMatchObject({ os: 'linux', shell: 'bash', transport: 'gitea' });
    expect(body.lines.map((l: { label: string }) => l.label)).toEqual(['SSH 登入', 'git', 'Gitea', '工作目錄', 'Python', 'GPU', 'repo 複本']);
    expect(body.machine).toMatchObject({ os: 'linux', shell: 'bash', transport: 'gitea', last_check_ok: 1 });
    expect(box.seen[0]).toBe('uname -s');
    expect(box.seen.some((s) => s.includes("git ls-remote 'http://gitea.corp:3000/aoi/cf-aoi.git' HEAD"))).toBe(true);

    const m = (await call('GET', '/api/machines/gpu-1')).json();
    expect(m).toMatchObject({ os: 'linux', shell: 'bash', transport: 'gitea', last_check_ok: 1 });
    expect(m.last_check_at).toBeTruthy();
    expect(m.last_check[0]).toEqual({ ok: true, label: 'SSH 登入', detail: 'loop@gpu-1（Linux，bash）' });
    expect(JSON.parse(getMachine(db, 'gpu-1')!.last_check_json!)).toEqual(m.last_check);
    expect((await call('POST', '/api/machines/ghost/check', {})).statusCode).toBe(404);
  });

  it('check: with no body it asks about the repos and 圖資 whose checks name this machine', async () => {
    await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'loop@gpu-1', work_root: '/srv/loop' });
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path, machine) VALUES ('r_1', 'cf-aoi', 'http://gitea.corp:3000/aoi/cf-aoi.git', '/tmp/cf-aoi', 'gpu-1')").run();
    db.prepare("INSERT INTO datasets (id, name, remote_url) VALUES ('ds_1', 'dataset-2026Q2', 'http://gitea.corp:3000/aoi/ds.git')").run();
    db.prepare("INSERT INTO checks (id, repo_id, name, kind, machine, command, dataset_id) VALUES ('ck_1', 'r_1', '圖資回歸', 'dataset', 'gpu-1', 'run', 'ds_1')").run();
    const body = (await call('POST', '/api/machines/gpu-1/check')).json();
    expect(body.lines.map((l: { label: string; detail: string }) => `${l.label} ${l.detail}`)).toContain('repo 複本 cf-aoi 還沒複製到 gpu-1：第一次跑檢查時會 clone');
    expect(body.lines.map((l: { label: string }) => l.label)).toContain('圖資快取');
    expect(box.seen.some((s) => s.includes("git ls-remote 'http://gitea.corp:3000/aoi/cf-aoi.git' HEAD"))).toBe(true);
  });

  it('check: a box that cannot be reached is recorded as such and the row stays auto', async () => {
    box = linuxBox({ sshCode: 255 });
    await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'loop@gpu-1', work_root: '/srv/loop' });
    const body = (await call('POST', '/api/machines/gpu-1/check', {})).json();
    expect(body.ok).toBe(false);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].detail).toContain('ssh-copy-id loop@gpu-1');
    expect(getMachine(db, 'gpu-1')).toMatchObject({ os: 'auto', shell: 'auto', transport: 'auto', last_check_ok: 0 });
    expect(db.prepare("SELECT detail FROM task_events WHERE detail LIKE '機台檢查%'").all()).toEqual([{ detail: '機台檢查：gpu-1 有問題（SSH 登入） by addis' }]);
    // Gitea unreachable from the box: the check still passes, transport becomes copy
    box = linuxBox({ lsCode: 128 });
    const copy = (await call('POST', '/api/machines/gpu-1/check', { repos: [{ name: 'cf-aoi', remoteUrl: 'http://gitea.corp:3000/aoi/cf-aoi.git' }] })).json();
    expect(copy.ok).toBe(true);
    expect(copy.detected.transport).toBe('copy');
    expect(getMachine(db, 'gpu-1')).toMatchObject({ os: 'linux', transport: 'copy', last_check_ok: 1 });
  });
});

describe('規格: what a box is, and the software a person adds', () => {
  const SPECS = ['== specs', 'os=Ubuntu 22.04.4 LTS', 'arch=x86_64', 'cpu=AMD Ryzen 9 7950X', 'threads=32', 'tpc=2', 'mem_kb=131072000', 'disk_total_kb=1953514584', 'disk_free_kb=976762584', 'gpu=NVIDIA GeForce RTX 4090, 24564, 550.90.07', 'cuda_driver=12.4', 'cuda_toolkit=12.4', 'python=3.10.12'].join('\n');

  it('a machine check stores its 規格; the list shows them with the software line', async () => {
    const withSpecs: HostExec = async (cmd, args) => {
      const r = await box.exec(cmd, args, 1000);
      return r.out === PROBE ? { code: 0, out: `${PROBE}\n${SPECS}\n` } : r;
    };
    await app.close();
    app = buildApp({ db, apiToken: null, machineRoutes: { hostExec: withSpecs } });
    await app.ready();
    await call('POST', '/api/machines', { name: 'gpu-1', ssh_target: 'loop@gpu-1', work_root: '/srv/loop', software: 'Halcon 23.11、Basler pylon 7' });
    const r = (await call('POST', '/api/machines/gpu-1/check', { repos: [], datasets: [] })).json();
    expect(r.lines.find((l: { label: string }) => l.label === '規格').detail).toBe('Ubuntu 22.04.4 LTS（x86_64） · 16 核／32 緒 · RAM 125 GB · NVIDIA GeForce RTX 4090 24 GB · CUDA 12.4');
    const m = (await call('GET', '/api/machines')).json().machines[0];
    expect(m.specs).toMatchObject({ cpu: 'AMD Ryzen 9 7950X', cores: 16, gpus: [{ name: 'NVIDIA GeForce RTX 4090', vram_gb: 24 }], cuda_toolkit: '12.4' });
    expect(m.specs_line).toContain('RTX 4090');
    expect(m.software).toBe('Halcon 23.11、Basler pylon 7');
    // a later check that never reached the probe keeps the stored 規格
    box = linuxBox({ sshCode: 255 });
    await app.close();
    app = buildApp({ db, apiToken: null, machineRoutes: { hostExec: (...a) => box.exec(...a) } });
    await app.ready();
    await call('POST', '/api/machines/gpu-1/check', { repos: [], datasets: [] });
    expect((await call('GET', '/api/machines/gpu-1')).json().specs.cpu).toBe('AMD Ryzen 9 7950X');
    expect((await call('PATCH', '/api/machines/gpu-1', { software: '' })).json().software).toBeNull();
  });

  it('GPU 沙盒 hosts: 讀取規格 runs the probe (this Spark locally), 其他軟體 is kept per host', async () => {
    const seen: string[][] = [];
    await app.close();
    app = buildApp({
      db,
      apiToken: null,
      machineRoutes: {
        hostExec: async (cmd, args) => {
          seen.push([cmd, ...args]);
          return { code: 0, out: SPECS };
        },
      },
    });
    await app.ready();
    expect((await call('GET', '/api/machines')).json().sandbox_hosts[0]).toMatchObject({ name: 'local', specs: null, software: null });
    const r = await call('POST', '/api/machines/sandbox/local/specs');
    expect(r.statusCode).toBe(200);
    expect(r.json().host).toMatchObject({ name: 'local', specs: { cpu: 'AMD Ryzen 9 7950X' }, specs_line: expect.stringContaining('16 核') });
    expect(seen[0]![0]).toBe('bash'); // this Spark: no ssh
    expect(seen[0]![2]).toContain('== specs');
    const p = await call('PATCH', '/api/machines/sandbox/local', { software: ' TensorRT 10.3 ' });
    expect(p.json().host).toMatchObject({ software: 'TensorRT 10.3', specs: { cores: 16 } });
    expect((await call('GET', '/api/machines')).json().sandbox_hosts[0].software).toBe('TensorRT 10.3');
    expect((await call('PATCH', '/api/machines/sandbox/local', { software: 3 })).statusCode).toBe(400);
    expect((await call('POST', '/api/machines/sandbox/nope/specs')).statusCode).toBe(404);
    expect((await call('POST', '/api/machines', { name: 'sandbox', ssh_target: 'x@y', work_root: '/srv/loop' })).statusCode).toBe(400);
  });
});
