import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { validateSetting } from '../settings.js';
import {
  buildDockerArgs,
  DEFAULT_EXEC_IMAGE,
  effectiveTimeoutSec,
  formatSandboxResult,
  OutputCapture,
  realDockerRunner,
  runSandbox,
  sandboxInUse,
  sandboxSettings,
  summarizeSandboxResult,
  verifySandboxRunner,
  type DockerOutcome,
  type DockerRunner,
  type SandboxSettings,
} from '../exec/sandbox.js';
import { checkSandbox, formatCheck, parseProbe, PROBE_COMMAND, type HostExec } from '../exec/check.js';

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
const dir = (tag = 'w') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-exec-${tag}-`));
  tmp.push(d);
  return d;
};

const base = (): SandboxSettings => ({ ...sandboxSettings(db), enabled: true });
const outcome = (o: Partial<DockerOutcome>): DockerOutcome => ({ code: 0, output: '', truncated: false, timedOut: false, aborted: false, ...o });
const fakeRunner = (o: Partial<DockerOutcome>, seen: string[][] = []): DockerRunner => async (args) => {
  seen.push(args);
  return outcome(o);
};

describe('settings', () => {
  it('ships off, with a CUDA devel image and conservative limits', () => {
    const s = sandboxSettings(db);
    expect(s.enabled).toBe(false);
    expect(s.image).toBe(DEFAULT_EXEC_IMAGE);
    expect(s).toMatchObject({ gpus: 'all', memory: '16g', cpus: '8', pids: 512, timeoutSec: 120, maxTimeoutSec: 900, maxConcurrency: 2, profilingCap: false });
    setSetting(db, 'exec_gpus', '');
    expect(sandboxSettings(db).gpus).toBe(''); // explicit "no GPU" survives
  });

  it('validates the keys people set by hand', () => {
    expect(validateSetting('exec_enabled', 'yes')).toMatch(/true or false/);
    expect(validateSetting('exec_enabled', 'true')).toBeNull();
    expect(validateSetting('exec_image', 'nvidia/cuda:13.0.3-devel-ubuntu24.04')).toBeNull();
    expect(validateSetting('exec_image', 'bad image; rm -rf /')).toMatch(/image/);
    expect(validateSetting('exec_memory', '16g')).toBeNull();
    expect(validateSetting('exec_memory', 'lots')).toMatch(/memory/);
    expect(validateSetting('exec_cpus', '0')).toMatch(/positive/);
    expect(validateSetting('exec_gpus', '')).toBeNull();
    expect(validateSetting('exec_gpus', 'device=0')).toBeNull();
    expect(validateSetting('exec_gpus', 'all; echo')).toMatch(/gpus/);
    expect(validateSetting('exec_allowed_users', 'ts:alice@corp, local')).toBeNull();
    expect(validateSetting('exec_allowed_users', 'alice')).toMatch(/exec_allowed_users/);
    expect(validateSetting('exec_timeout_sec', '-1')).toMatch(/non-negative/);
  });
});

describe('docker argv: the whole isolation policy', () => {
  it('no network, no capabilities, read-only root, capped resources, one bind mount, never pulls', () => {
    const args = buildDockerArgs(base(), { workdir: '/data/exec/chat/c_1', command: 'nvcc x.cu && ./a.out', name: 'loop-exec-abc', uid: 1000, gid: 1000, scope: 'chat' });
    const joined = args.join(' ');
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--pull', 'never']);
    expect(joined).toContain('--network none');
    expect(joined).toContain('--gpus all');
    expect(joined).toContain('--user 1000:1000');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).not.toContain('--cap-add');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--pids-limit 512 --memory 16g --memory-swap 16g --cpus 8');
    expect(joined).toContain('--read-only --tmpfs /tmp:rw,exec,nosuid,size=2g');
    expect(joined).toContain('--mount type=bind,source=/data/exec/chat/c_1,target=/work -w /work');
    expect(joined).toContain('--label loop-exec=1 ');
    expect(joined).toContain('--label loop-exec.scope=chat');
    // the command is one argv entry after `bash -c`, never re-split by a shell
    expect(args.slice(-4)).toEqual([DEFAULT_EXEC_IMAGE, 'bash', '-c', 'nvcc x.cu && ./a.out']);
    expect(args.filter((a) => a === '-v')).toHaveLength(0); // exactly one mount, and it is the workspace
  });

  it('no GPU when exec_gpus is empty; SYS_ADMIN only when profiling is explicitly allowed', () => {
    const noGpu = buildDockerArgs({ ...base(), gpus: '' }, { workdir: '/w', command: 'true', name: 'n', uid: null, gid: null });
    expect(noGpu).not.toContain('--gpus');
    expect(noGpu).not.toContain('--user');
    const prof = buildDockerArgs({ ...base(), profilingCap: true }, { workdir: '/w', command: 'true', name: 'n', uid: 1, gid: 1 });
    expect(prof.join(' ')).toContain('--cap-drop ALL --cap-add SYS_ADMIN');
  });

  it('clamps the requested timeout', () => {
    const s = base();
    expect(effectiveTimeoutSec(s, undefined)).toBe(120);
    expect(effectiveTimeoutSec(s, 30)).toBe(30);
    expect(effectiveTimeoutSec(s, 99_999)).toBe(900);
    expect(effectiveTimeoutSec(s, -5)).toBe(120);
    expect(effectiveTimeoutSec(s, 'abc')).toBe(120);
  });
});

describe('output capture', () => {
  it('keeps the head and the tail and says how much was dropped', () => {
    const cap = new OutputCapture(3000);
    cap.push('H'.repeat(2500));
    cap.push('x'.repeat(10_000));
    cap.push('TAIL');
    const r = cap.result();
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('H'.repeat(2000))).toBe(true);
    expect(r.text.endsWith('TAIL')).toBe(true);
    expect(r.text).toMatch(/中間省略 \d+ 字/);
    const small = new OutputCapture(3000);
    small.push('ok\n');
    expect(small.result()).toEqual({ text: 'ok\n', truncated: false });
  });
});

describe('runSandbox', () => {
  it('runs the command in the workspace and reports exit code and output', async () => {
    const w = dir();
    const seen: string[][] = [];
    const r = await runSandbox(base(), { workdir: w, command: '  ./arith  ', scope: 'chat' }, { runner: fakeRunner({ code: 0, output: 'max err 0\nPASS\n' }, seen), uid: 1, gid: 1 });
    expect(r).toMatchObject({ exitCode: 0, infra: false, error: null, hint: null, timeoutSec: 120 });
    expect(seen[0]!.at(-1)).toBe('./arith');
    expect(seen[0]!.join(' ')).toContain(`source=${w},target=/work`);
    expect(summarizeSandboxResult(r)).toMatch(/^exit 0 · \d+\.\d s$/);
    expect(formatSandboxResult(r)).toContain('PASS');
  });

  it('a failing command is a result, not a sandbox failure', async () => {
    const r = await runSandbox(base(), { workdir: dir(), command: 'nvcc bad.cu' }, { runner: fakeRunner({ code: 2, output: 'bad.cu(3): error: expected a ";"' }) });
    expect(r).toMatchObject({ exitCode: 2, infra: false, error: null });
    expect(summarizeSandboxResult(r)).toMatch(/^exit 2/);
  });

  it('refuses bad requests before touching docker', async () => {
    let called = 0;
    const runner: DockerRunner = async () => {
      called++;
      return outcome({});
    };
    expect((await runSandbox(base(), { workdir: dir(), command: '   ' }, { runner })).error).toMatch(/不可為空/);
    expect((await runSandbox(base(), { workdir: '/definitely/not/here', command: 'true' }, { runner })).error).toMatch(/不存在/);
    expect((await runSandbox(base(), { workdir: 'relative/path', command: 'true' }, { runner })).error).toMatch(/不合法/);
    expect((await runSandbox(base(), { workdir: '/a,b', command: 'true' }, { runner })).error).toMatch(/不合法/);
    expect((await runSandbox(base(), { workdir: dir(), command: 'x'.repeat(20_001) }, { runner })).error).toMatch(/太長/);
    expect(called).toBe(0);
  });

  it('recognises docker failures and says what to do', async () => {
    const s = base();
    const w = dir();
    const noImage = await runSandbox(s, { workdir: w, command: 'true' }, { runner: fakeRunner({ code: 125, output: `docker: Error response from daemon: No such image: ${s.image}.` }) });
    expect(noImage.infra).toBe(true);
    expect(noImage.hint).toContain(`docker pull ${s.image}`);
    const noGpu = await runSandbox(s, { workdir: w, command: 'true' }, { runner: fakeRunner({ code: 125, output: 'could not select device driver "" with capabilities: [[gpu]]' }) });
    expect(noGpu.hint).toContain('NVIDIA Container Toolkit');
    const noDocker = await runSandbox(s, { workdir: w, command: 'true' }, { runner: fakeRunner({ code: null, error: '找不到 docker 指令（這台機器沒有安裝 Docker，或不在 PATH 上）' }) });
    expect(noDocker).toMatchObject({ infra: true });
    expect(noDocker.hint).toContain('Docker');
    const daemon = await runSandbox(s, { workdir: w, command: 'true' }, { runner: fakeRunner({ code: 1, output: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }) });
    expect(daemon.infra).toBe(true);
    // the command's own output mentioning an image is NOT a docker failure
    const own = await runSandbox(s, { workdir: w, command: './app' }, { runner: fakeRunner({ code: 1, output: 'error: image file not found' }) });
    expect(own).toMatchObject({ infra: false, hint: null });
  });

  it('explains timeouts, OOM kills, missing counters permission and missing tools', async () => {
    const s = base();
    const w = dir();
    const hint = async (o: Partial<DockerOutcome>) => (await runSandbox(s, { workdir: w, command: 'x', timeoutSec: 5 }, { runner: fakeRunner(o) })).hint;
    expect(await hint({ code: 137, timedOut: true })).toMatch(/超過 5 秒/);
    expect(await hint({ code: 137 })).toMatch(/exec_memory=16g/);
    expect(await hint({ code: 1, output: '==ERROR== ERR_NVGPUCTRPERM - The user does not have permission' })).toMatch(/NVreg_RestrictProfilingToAdminUsers=0/);
    expect(await hint({ code: 127, output: 'bash: line 1: ncu: command not found' })).toMatch(/沒有 ncu/);
    expect(await hint({ code: 127, output: 'bash: nvcc: command not found' })).toMatch(/-devel/);
    expect(await hint({ code: 1, output: "touch: cannot touch '/opt/x': Read-only file system" })).toMatch(/唯讀/);
    expect(await hint({ code: 1, output: 'Could not resolve host: pypi.org' })).toMatch(/沒有網路/);
  });

  it('never runs more containers than exec_max_concurrency', async () => {
    const s = { ...base(), maxConcurrency: 1 };
    const w = dir();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: DockerRunner = async (args) => {
      order.push(`start ${args.at(-1)}`);
      if (args.at(-1) === 'first') await gate;
      order.push(`end ${args.at(-1)}`);
      return outcome({});
    };
    const a = runSandbox(s, { workdir: w, command: 'first' }, { runner: slow });
    const b = runSandbox(s, { workdir: w, command: 'second' }, { runner: slow });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['start first']); // the second one is waiting for the slot
    expect(sandboxInUse()).toBe(1);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['start first', 'end first', 'start second', 'end second']);
    expect(sandboxInUse()).toBe(0);
  });

  it('gives up on a busy sandbox instead of queueing forever', async () => {
    const s = { ...base(), maxConcurrency: 1 };
    const w = dir();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hold = runSandbox(s, { workdir: w, command: 'hold' }, { runner: async () => (await gate, outcome({})) });
    const busy = await runSandbox(s, { workdir: w, command: 'next' }, { runner: fakeRunner({}), queueWaitMs: 50 });
    expect(busy.infra).toBe(true);
    expect(busy.error).toMatch(/忙碌/);
    release();
    await hold;
  });

  it('the verify runner uses the engine timeout, not the per-call cap', async () => {
    const seen: string[][] = [];
    const step = verifySandboxRunner({ ...base(), maxTimeoutSec: 60 }, { runner: async (args, o) => (seen.push([...args, String(o.timeoutMs)]), outcome({ code: 0, output: 'ok' })) });
    const r = await step('make test', dir(), 20 * 60_000);
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(seen[0]!.at(-1)).toBe(String(20 * 60_000));
    expect(seen[0]!.join(' ')).toContain('--label loop-exec.scope=verify');
    const bad = verifySandboxRunner(base(), { runner: fakeRunner({ code: 125, output: 'No such image: x' }) });
    expect((await bad('true', dir(), 1000)).ok).toBe(false);
  });
});

describe('the real docker runner (against a fake docker on PATH)', () => {
  let savedPath: string | undefined;
  let bin: string;
  beforeEach(() => {
    savedPath = process.env.PATH;
    bin = dir('bin');
    // `docker run …` echoes, sleeps when asked, and records `docker kill <name>`
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/bash\nif [ "$1" = "kill" ]; then echo "$2" >> "${bin}/killed"; [ -f "${bin}/sleep.pid" ] && kill "$(cat "${bin}/sleep.pid")" 2>/dev/null; exit 0; fi\ncmd="\${@: -1}"\nif [ "$cmd" = "sleep" ]; then sleep 30 & echo $! > "${bin}/sleep.pid"; wait $!; exit 137; fi\necho "out:$cmd"; echo "err line" >&2; exit 3\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${savedPath}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it('captures both streams and the exit code', async () => {
    const r = await realDockerRunner(['run', 'img', 'bash', '-c', 'hello'], { name: 'loop-exec-t1', timeoutMs: 10_000, maxChars: 5000 });
    expect(r.code).toBe(3);
    expect(r.output).toContain('out:hello');
    expect(r.output).toContain('err line');
    expect(r.timedOut).toBe(false);
  });

  it('kills the container by name on timeout (the client alone would leave it running)', async () => {
    const r = await realDockerRunner(['run', 'img', 'bash', '-c', 'sleep'], { name: 'loop-exec-t2', timeoutMs: 300, maxChars: 5000 });
    expect(r.timedOut).toBe(true);
    expect(fs.readFileSync(path.join(bin, 'killed'), 'utf8')).toContain('loop-exec-t2');
  }, 20_000);

  it('stops on abort, and reports a missing docker binary', async () => {
    const ac = new AbortController();
    const p = realDockerRunner(['run', 'img', 'bash', '-c', 'sleep'], { name: 'loop-exec-t3', timeoutMs: 20_000, maxChars: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.aborted).toBe(true);
    process.env.PATH = dir('empty');
    const missing = await realDockerRunner(['run'], { name: 'loop-exec-t4', timeoutMs: 1000, maxChars: 100 });
    expect(missing.error).toMatch(/找不到 docker/);
  }, 20_000);
});

describe('loop exec check', () => {
  const okHost: HostExec = async (_cmd, args) => (args[0] === 'version' ? { code: 0, out: '28.1.1' } : { code: 0, out: 'arm64 9800000000' });
  const probeOut = [
    '== gpu',
    'GPU 0: NVIDIA GB10 (UUID: GPU-1)',
    '== nvcc',
    'Build cuda_13.0.r13.0/compiler.36260728_0',
    '== ncu',
    'Version 2025.3.1.0 (build 36273991) (public-release)',
    '== net',
    'net: none',
    '== work',
    'work: writable',
  ].join('\n');

  it('parses the probe sections', () => {
    expect(parseProbe(probeOut)).toMatchObject({ gpu: 'GPU 0: NVIDIA GB10 (UUID: GPU-1)', net: 'net: none', work: 'work: writable' });
    expect(PROBE_COMMAND).toContain('== ncu');
  });

  it('passes a ready machine, and checks counters with --profile', async () => {
    const cmds: string[] = [];
    const run = async (_s: SandboxSettings, req: { command: string }) => {
      cmds.push(req.command);
      const profile = req.command.includes('ncu --metrics');
      return {
        exitCode: 0, timedOut: false, aborted: false, durationMs: 5, timeoutSec: 120, truncated: false, hint: null, infra: false, error: null,
        output: profile ? 'mismatches=0\n  sm__cycles_elapsed.avg   cycle   4,321' : probeOut,
      };
    };
    const lines = await checkSandbox(base(), dir(), { profile: true }, { host: okHost, run });
    expect(lines.every((l) => l.ok === true)).toBe(true);
    expect(formatCheck(lines)).toContain('✅ GPU：GPU 0: NVIDIA GB10');
    expect(lines.map((l) => l.label)).toEqual(['Docker', '映像', 'GPU', 'nvcc', 'ncu', '網路隔離', '/work', 'ncu 權限']);
    expect(cmds[1]).toContain('nvcc -O2 -o probe probe.cu');
  });

  it('stops at the first missing piece and says how to fix it', async () => {
    const noDocker = await checkSandbox(base(), dir(), {}, { host: async () => ({ code: null, out: '' }) });
    expect(noDocker).toHaveLength(1);
    expect(noDocker[0]).toMatchObject({ ok: false, label: 'Docker' });
    const noImage = await checkSandbox(base(), dir(), {}, { host: async (_c, a) => (a[0] === 'version' ? { code: 0, out: '28' } : { code: 1, out: 'No such image' }) });
    expect(noImage.at(-1)!.detail).toContain('docker pull');
  });

  it('flags counters permission and a missing ncu', async () => {
    const run = async (_s: SandboxSettings, req: { command: string }) => ({
      exitCode: req.command.includes('ncu --metrics') ? 1 : 0, timedOut: false, aborted: false, durationMs: 1, timeoutSec: 120, truncated: false, infra: false, error: null,
      hint: req.command.includes('ncu --metrics') ? '沒有讀 GPU 效能計數器的權限' : null,
      output: req.command.includes('ncu --metrics') ? '==ERROR== ERR_NVGPUCTRPERM' : probeOut,
    });
    const denied = await checkSandbox(base(), dir(), { profile: true }, { host: okHost, run });
    expect(denied.at(-1)).toMatchObject({ ok: false, label: 'ncu 權限' });
    const noNcu = await checkSandbox(base(), dir(), { profile: true }, {
      host: okHost,
      run: async () => ({ exitCode: 0, timedOut: false, aborted: false, durationMs: 1, timeoutSec: 120, truncated: false, infra: false, error: null, hint: null, output: probeOut.replace(/Version 2025.*/, 'ncu: not found') }),
    });
    expect(noNcu.find((l) => l.label === 'ncu')).toMatchObject({ ok: null });
    expect(noNcu.at(-1)).toMatchObject({ ok: null, label: 'ncu 權限' });
  });
});
