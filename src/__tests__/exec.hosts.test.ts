import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { validateSetting } from '../settings.js';
import {
  deleteExecHost,
  describeExecHosts,
  dockerHostUrl,
  ExecHostError,
  getExecHost,
  listExecHosts,
  parseDataMounts,
  remoteIds,
  remoteWorkdir,
  resolveExecTarget,
  setHostIds,
  sshArgs,
  syncToRemote,
  upsertExecHost,
  type HostExec,
} from '../exec/hosts.js';
import { buildDockerArgs, runSandbox, sandboxSettings, summarizeSandboxResult, verifySandboxRunner, type DockerOutcome, type DockerRunner, type SandboxResult } from '../exec/sandbox.js';
import { checkSandbox } from '../exec/check.js';
import { parseSandboxStep, runVerification } from '../orchestrator/verify.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import { sandboxTools, type SandboxRun } from '../chat/sandboxTools.js';
import { buildApp } from '../server/app.js';
import { createRun, createTask, getTask } from '../tasks.js';

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
const dir = (tag = 'h') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-exec-${tag}-`));
  tmp.push(d);
  return d;
};
const addAoi = (extra: Partial<Parameters<typeof upsertExecHost>[1]> = {}) =>
  upsertExecHost(db, {
    name: 'aoi-gpu',
    ssh_target: 'loop@aoi-gpu',
    ssh_port: 2222,
    work_root: '/srv/loop-exec/',
    image: 'aoi-eval:13.0',
    data_mounts: '/mnt/aoi:/datasets,/mnt/golden:/golden',
    description: 'AOI 圖庫與 RTX 4090',
    ...extra,
  });
const outcome = (o: Partial<DockerOutcome> = {}): DockerOutcome => ({ code: 0, output: '', truncated: false, timedOut: false, aborted: false, ...o });

/** A fake ssh/rsync: answers `id`, records every call. */
function fakeHost(opts: { rsyncCode?: number; sshOut?: string; sshCode?: number } = {}): { exec: HostExec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: HostExec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'rsync') return { code: opts.rsyncCode ?? 0, out: opts.rsyncCode ? 'rsync: connection unexpectedly closed' : '' };
    if (cmd === 'ssh') return { code: opts.sshCode ?? 0, out: opts.sshOut ?? '1001\n1002' };
    return { code: 0, out: '' };
  };
  return { exec, calls };
}

describe('host registry', () => {
  it('stores, lists and validates hosts', () => {
    const h = addAoi();
    expect(h).toMatchObject({ name: 'aoi-gpu', work_root: '/srv/loop-exec', ssh_port: 2222, enabled: 1 });
    expect(listExecHosts(db).map((x) => x.name)).toEqual(['aoi-gpu']);
    for (const bad of [
      { name: 'local' },
      { name: 'Bad Name' },
      { ssh_target: 'loop@aoi;rm -rf /' },
      { work_root: 'relative/dir' },
      { work_root: '/' },
      { work_root: '/srv/../etc' },
      { data_mounts: 'relative:/x' },
      { data_mounts: '/mnt/aoi:/work' },
      { ssh_port: 70000 },
    ]) {
      expect(() => addAoi(bad as never), JSON.stringify(bad)).toThrow(ExecHostError);
    }
    expect(deleteExecHost(db, 'aoi-gpu')).toBe(true);
    expect(getExecHost(db, 'aoi-gpu')).toBeUndefined();
  });

  it('keeps learned uid/gid while the machine is the same, forgets them when it changes', () => {
    addAoi();
    setHostIds(db, 'aoi-gpu', 1001, 1002);
    expect(addAoi({ description: 'renamed' })).toMatchObject({ remote_uid: 1001, remote_gid: 1002 });
    expect(addAoi({ ssh_target: 'loop@other-box' })).toMatchObject({ remote_uid: null, remote_gid: null });
  });

  it('parses read-only data mounts', () => {
    expect(parseDataMounts('/mnt/aoi:/datasets, /mnt/golden')).toEqual([
      { source: '/mnt/aoi', target: '/datasets' },
      { source: '/mnt/golden', target: '/data/golden' },
    ]);
    expect(parseDataMounts('')).toEqual([]);
    expect(() => parseDataMounts('/a b:/x')).toThrow(/不合法/);
  });

  it('resolves where a run goes: default host, explicit host, unknown, disabled', () => {
    expect(resolveExecTarget(db, null)).toEqual({ kind: 'local' });
    addAoi();
    expect(resolveExecTarget(db, 'aoi-gpu')).toMatchObject({ kind: 'remote', host: { name: 'aoi-gpu' } });
    setSetting(db, 'exec_default_host', 'aoi-gpu');
    expect(resolveExecTarget(db, '')).toMatchObject({ kind: 'remote' });
    expect(resolveExecTarget(db, 'local')).toEqual({ kind: 'local' });
    expect(() => resolveExecTarget(db, 'nope')).toThrow(/沒有這台/);
    addAoi({ enabled: false });
    expect(() => resolveExecTarget(db, 'aoi-gpu')).toThrow(/停用/);
  });

  it('describes hosts for the model: local first, default marked, data targets listed', () => {
    setSetting(db, 'exec_data_mounts', '/nas/local-set:/datasets');
    addAoi();
    setSetting(db, 'exec_default_host', 'aoi-gpu');
    const d = describeExecHosts(db);
    expect(d.map((h) => [h.name, h.default])).toEqual([['local', false], ['aoi-gpu', true]]);
    expect(d[0]!.data).toEqual([{ source: '/nas/local-set', target: '/datasets' }]);
    expect(d[1]!.description).toBe('AOI 圖庫與 RTX 4090');
  });

  it('validates the two settings', () => {
    expect(validateSetting('exec_default_host', 'aoi-gpu')).toBeNull();
    expect(validateSetting('exec_default_host', 'Bad Host')).toMatch(/exec_default_host/);
    expect(validateSetting('exec_data_mounts', '/mnt/a:/datasets')).toBeNull();
    expect(validateSetting('exec_data_mounts', 'nope')).toMatch(/exec_data_mounts/);
  });
});

describe('ssh / rsync plumbing', () => {
  it('builds ssh args, the docker -H url and safe remote workspace paths', () => {
    const h = addAoi();
    expect(sshArgs(h)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-p', '2222']);
    expect(dockerHostUrl(h)).toBe('ssh://loop@aoi-gpu:2222');
    expect(dockerHostUrl({ ssh_target: 'aoi', ssh_port: null })).toBe('ssh://aoi');
    expect(remoteWorkdir(h, 'task-t_1')).toBe('/srv/loop-exec/task-t_1');
    // whatever the key, the workspace is one directory directly under work_root
    for (const key of ['../../etc', '..', '.', '/abs', 'a/b']) {
      const p = remoteWorkdir(h, key);
      expect(path.posix.dirname(p), key).toBe('/srv/loop-exec');
      expect(path.posix.basename(p).startsWith('.'), key).toBe(false);
    }
  });

  it('rsync mirrors the workspace but leaves gitignored build outputs alone', async () => {
    const h = addAoi();
    const { exec, calls } = fakeHost();
    const r = await syncToRemote(h, '/w/tree/', '/srv/loop-exec/task-1', exec);
    expect(r.ok).toBe(true);
    const args = calls[0]!.args;
    expect(calls[0]!.cmd).toBe('rsync');
    expect(args).toEqual(expect.arrayContaining(['-a', '--delete', '--filter=:- .gitignore', '--exclude=.git', '--rsync-path=mkdir -p /srv/loop-exec/task-1 && rsync']));
    expect(args[args.indexOf('-e') + 1]).toBe('ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -p 2222');
    expect(args.slice(-2)).toEqual(['/w/tree/', 'loop@aoi-gpu:/srv/loop-exec/task-1/']);
  });

  it('learns the remote uid/gid once, then uses the cached ones', async () => {
    const h = addAoi();
    const { exec, calls } = fakeHost();
    expect(await remoteIds(h, exec)).toEqual({ uid: 1001, gid: 1002 });
    expect(calls[0]!.args.at(-1)).toBe('id -u; id -g');
    setHostIds(db, 'aoi-gpu', 5, 6);
    expect(await remoteIds(getExecHost(db, 'aoi-gpu')!, exec)).toEqual({ uid: 5, gid: 6 });
    expect(calls).toHaveLength(1);
  });
});

describe('running on a remote host', () => {
  const s = () => ({ ...sandboxSettings(db), enabled: true });

  it('syncs, then runs through docker -H with the remote workspace, ids, image and read-only data', async () => {
    const h = addAoi();
    const w = dir();
    const { exec, calls } = fakeHost();
    const seen: Array<{ args: string[]; hostArgs?: string[] }> = [];
    const runner: DockerRunner = async (args, o) => (seen.push({ args, hostArgs: o.hostArgs }), outcome({ output: 'detection_rate=0.991' }));
    const r = await runSandbox(s(), { workdir: w, command: 'python3 eval.py', remote: { host: h, key: 'task-t_9' } }, { runner, hostExec: exec });
    expect(r).toMatchObject({ exitCode: 0, infra: false, host: 'aoi-gpu' });
    expect(summarizeSandboxResult(r)).toMatch(/@aoi-gpu$/);
    expect(calls.map((c) => c.cmd)).toEqual(['ssh', 'rsync']); // ids, then sync — before docker
    const joined = seen[0]!.args.join(' ');
    expect(seen[0]!.hostArgs).toEqual(['-H', 'ssh://loop@aoi-gpu:2222']);
    expect(joined).toContain('--mount type=bind,source=/srv/loop-exec/task-t_9,target=/work');
    expect(joined).toContain('--user 1001:1002');
    expect(joined).toContain('--mount type=bind,source=/mnt/aoi,target=/datasets,readonly');
    expect(joined).toContain('--mount type=bind,source=/mnt/golden,target=/golden,readonly');
    expect(joined).toContain('--network none');
    expect(seen[0]!.args.slice(-4)).toEqual(['aoi-eval:13.0', 'bash', '-c', 'python3 eval.py']);
  });

  it('a failed sync or an unreachable host is a sandbox error with a fix, and docker never starts', async () => {
    const h = addAoi();
    const w = dir();
    let started = 0;
    const runner: DockerRunner = async () => (started++, outcome());
    const badSync = await runSandbox(s(), { workdir: w, command: 'true', remote: { host: h, key: 'k' } }, { runner, hostExec: fakeHost({ rsyncCode: 12 }).exec });
    expect(badSync).toMatchObject({ infra: true, host: 'aoi-gpu' });
    expect(badSync.error).toContain('同步');
    expect(badSync.output).toContain('connection unexpectedly closed');
    const noSsh = await runSandbox(s(), { workdir: w, command: 'true', remote: { host: h, key: 'k' } }, { runner, hostExec: fakeHost({ sshCode: 255, sshOut: 'Permission denied (publickey)' }).exec });
    expect(noSsh.error).toContain('連不上');
    expect(noSsh.hint).toContain('loop exec check --host aoi-gpu');
    expect(started).toBe(0);
  });

  it('the local sandbox gets exec_data_mounts read-only too', () => {
    setSetting(db, 'exec_data_mounts', '/nas/aoi:/datasets');
    const args = buildDockerArgs(s(), { workdir: '/w', command: 'ls /datasets', name: 'n', uid: 1, gid: 1 }).join(' ');
    expect(args).toContain('--mount type=bind,source=/nas/aoi,target=/datasets,readonly');
  });
});

describe('sandbox@host verification steps', () => {
  it('parses the host out of the prefix', () => {
    expect(parseSandboxStep('sandbox@aoi-gpu: python3 eval.py')).toEqual({ host: 'aoi-gpu', command: 'python3 eval.py' });
    expect(parseSandboxStep('sandbox: make')).toEqual({ host: null, command: 'make' });
    expect(parseSandboxStep('Sandbox@AOI : make')).toEqual({ host: 'aoi', command: 'make' });
    expect(parseSandboxStep('npm test')).toBeNull();
  });

  it('runs on the named host in the task workspace; an unknown host fails the step', async () => {
    const h = addAoi();
    const seen: string[] = [];
    const runner: DockerRunner = async (args, o) => (seen.push(`${o.hostArgs?.join(' ')}|${args.join(' ')}`), outcome({ output: 'ok' }));
    const step = verifySandboxRunner({ ...sandboxSettings(db), enabled: true }, { runner, hostExec: fakeHost().exec }, (name) => resolveExecTarget(db, name), 'task-t_1');
    const task = { verification_steps: JSON.stringify(['sandbox@aoi-gpu: python3 eval.py', 'sandbox@ghost: true']) } as never;
    const r = await runVerification(task, dir(), 60_000, undefined, step);
    expect(seen[0]).toContain('-H ssh://loop@aoi-gpu:2222|');
    expect(seen[0]).toContain(`source=${remoteWorkdir(h, 'task-t_1')},target=/work`);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('sandbox@ghost: true');
    expect(r.results[1]!.output).toContain('沒有這台');
  });
});

describe('the agent and the chat model can pick the host', () => {
  it('POST /api/exec/run forwards host, keyed by task; an unknown host is a 400', async () => {
    setSetting(db, 'exec_enabled', 'true');
    addAoi();
    const seen: Array<{ remote?: { host: { name: string }; key: string } | null }> = [];
    const run: SandboxRun = async (_s, req) => (seen.push(req as never), { exitCode: 0, timedOut: false, aborted: false, durationMs: 1, timeoutSec: 120, output: '', truncated: false, hint: null, infra: false, error: null, host: 'aoi-gpu' } as SandboxResult);
    const app: FastifyInstance = buildApp({ db, apiToken: null, sandboxRun: run, mcpPool: null });
    await app.ready();
    try {
      const t = createTask(db, { title: 't', goal: 'g', verification_steps: ['true'] });
      const r = createRun(db, { task_id: t.id, worktree_path: dir() });
      const ok = await app.inject({ method: 'POST', url: '/api/exec/run', payload: { run_id: r.id, command: 'ls /datasets', host: 'aoi-gpu' } });
      expect(ok.statusCode).toBe(200);
      expect(seen[0]!.remote).toMatchObject({ host: { name: 'aoi-gpu' }, key: `task-${t.id}` });
      const bad = await app.inject({ method: 'POST', url: '/api/exec/run', payload: { run_id: r.id, command: 'true', host: 'ghost' } });
      expect(bad.statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/exec/status' })).json().hosts.map((h: { name: string }) => h.name)).toEqual(['local', 'aoi-gpu']);
    } finally {
      await app.close();
    }
  });

  it('chat: sandbox_run offers the hosts and keys the remote workspace by conversation', async () => {
    const ws = path.join(dir(), 'c_conv1');
    expect(Object.keys((sandboxTools(db, ws, { run: async () => ({}) as never })[3]!.parameters as { properties: object }).properties)).not.toContain('host');
    addAoi();
    const seen: Array<{ remote?: { key: string; host: { name: string } } | null }> = [];
    const run: SandboxRun = async (_s, req) => (seen.push(req as never), { exitCode: 0, timedOut: false, aborted: false, durationMs: 1, timeoutSec: 120, output: 'x', truncated: false, hint: null, infra: false, error: null, host: 'aoi-gpu' } as SandboxResult);
    const tool = sandboxTools(db, ws, { run })[3]!;
    expect((tool.parameters as { properties: { host: { enum: string[] } } }).properties.host.enum).toEqual(['local', 'aoi-gpu']);
    expect(tool.description).toContain('AOI 圖庫與 RTX 4090');
    await tool.run({ command: 'ls /datasets', host: 'aoi-gpu' }, { db, fetch, signal: new AbortController().signal });
    expect(seen[0]!.remote).toMatchObject({ key: 'chat-c_conv1', host: { name: 'aoi-gpu' } });
    const bad = await tool.run({ command: 'true', host: 'ghost' }, { db, fetch, signal: new AbortController().signal });
    expect(bad.ok).toBe(false);
  });

  it('LOOP_TASK.md lists the hosts and their data when there is a choice', () => {
    addAoi();
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', verification_steps: ['sandbox@aoi-gpu: python3 eval.py'] }).id)!;
    const md = fs.readFileSync(writeTaskFile(dir(), task, { mcpServers: ['loop-exec'], exec: { image: 'img', timeoutSec: 120, maxTimeoutSec: 900, hosts: describeExecHosts(db) } }), 'utf8');
    expect(md).toContain('`aoi-gpu`：AOI 圖庫與 RTX 4090；唯讀資料：`/datasets`、`/golden`');
    expect(md).toContain('host: "<主機>"');
    const localOnly = fs.readFileSync(writeTaskFile(dir(), task, { mcpServers: ['loop-exec'], exec: { image: 'img', timeoutSec: 120, maxTimeoutSec: 900, hosts: [{ name: 'local', description: 'x', data: [], default: true }] } }), 'utf8');
    expect(localOnly).not.toContain('可用的沙盒主機');
  });
});

describe('loop exec check --host', () => {
  const probe = ['== gpu', 'GPU 0: NVIDIA RTX 4090', '== nvcc', 'Build cuda_13.0', '== ncu', 'Version 2025.3', '== net', 'net: none', '== work', 'work: writable', '== data', 'ro /datasets', 'rw /golden'].join('\n');

  it('walks ssh → rsync → docker -H → image → container, records ids, and flags a writable data mount', async () => {
    const h = addAoi();
    const hostCalls: string[] = [];
    const host: HostExec = async (cmd, args) => {
      hostCalls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'ssh') return { code: 0, out: 'LOOP_OK\n1001\n1002\nrsync:yes' };
      if (cmd === 'rsync') return { code: 0, out: 'rsync version 3.2.7' };
      if (args.includes('version')) return { code: 0, out: '27.3.1' };
      return { code: 0, out: 'amd64 12000000000' };
    };
    let ids: number[] = [];
    const run = async () => ({ exitCode: 0, timedOut: false, aborted: false, durationMs: 1, timeoutSec: 120, truncated: false, hint: null, infra: false, error: null, host: 'aoi-gpu', output: probe });
    const lines = await checkSandbox({ ...sandboxSettings(db), enabled: true }, dir(), { remote: h, onRemoteIds: (u, g) => (ids = [u, g]) }, { host, run });
    expect(ids).toEqual([1001, 1002]);
    expect(hostCalls.some((c) => c.startsWith('docker -H ssh://loop@aoi-gpu:2222 version'))).toBe(true);
    expect(hostCalls.some((c) => c.includes('image inspect') && c.endsWith('aoi-eval:13.0'))).toBe(true);
    expect(lines.map((l) => [l.label, l.ok])).toEqual([
      ['SSH', true], ['rsync', true], ['Docker', true], ['映像', true], ['GPU', true], ['nvcc', true], ['ncu', true], ['網路隔離', true], ['/work', true],
      ['資料 /datasets', true], ['資料 /golden', false],
    ]);
  });

  it('stops at ssh with the commands that fix it', async () => {
    const h = addAoi();
    const lines = await checkSandbox({ ...sandboxSettings(db), enabled: true }, dir(), { remote: h }, { host: async () => ({ code: 255, out: 'Permission denied (publickey).' }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ok: false, label: 'SSH' });
    expect(lines[0]!.detail).toContain('ssh-copy-id loop@aoi-gpu');
  });
});
