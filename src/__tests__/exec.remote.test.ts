import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { HostExec } from '../exec/hosts.js';
import type { Machine } from '../exec/machines.js';
import {
  checkMachine,
  datasetDirOn,
  decodePowerShell,
  ensureCheckout,
  ensureDataset,
  machineBusy,
  pullBack,
  quoteFor,
  repoDirOn,
  runRemote,
  shellOf,
  withMachineLock,
  wrapCommand,
} from '../exec/remote.js';

/**
 * The remote runner for 機台, with ssh / rsync / scp replaced by a scripted fake that records
 * every argv: what exactly goes over the wire for a Linux and a Windows box, how exit codes come
 * back, the command sequences that put code and 圖資 on the box, and the health check's parsing.
 * Zero network.
 */

const lin: Machine = {
  name: 'gpu-1',
  ssh_target: 'loop@gpu-1',
  ssh_port: 2222,
  os: 'linux',
  shell: 'auto',
  work_root: '/srv/loop',
  labels: '',
  description: null,
  transport: 'auto',
  enabled: 1,
  last_check_json: null,
  last_check_at: null,
  last_check_ok: null,
  created_at: '',
  updated_at: '',
};
const win: Machine = { ...lin, name: 'aoi-1', ssh_target: 'aoi@aoi-1', ssh_port: null, os: 'windows', work_root: 'C:\\loop' };
const winCmd: Machine = { ...win, shell: 'cmd' };
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30'];
const WIN_PREFIX = 'powershell -NoProfile -NonInteractive -EncodedCommand ';

type Call = { cmd: string; args: string[]; timeoutMs: number };
type Answer = { code: number | null; out: string } | undefined;

/** A scripted ssh/rsync/scp. `answer` sees the call and, for ssh, the remote command text. */
function fake(answer: (c: Call, remote: string) => Answer = () => undefined) {
  const calls: Call[] = [];
  const exec: HostExec = async (cmd, args, timeoutMs) => {
    const c = { cmd, args, timeoutMs };
    calls.push(c);
    return answer(c, cmd === 'ssh' ? (args[args.length - 1] ?? '') : '') ?? { code: 0, out: '' };
  };
  return { exec, calls, remote: (i: number) => calls[i]!.args[calls[i]!.args.length - 1]! };
}

/** the script inside `bash -lc '…'` of a Linux ssh command */
function unwrapLinux(remote: string): string {
  const m = /bash -lc '((?:[^']|'\\'')*)' 2>&1$/.exec(remote);
  if (!m) throw new Error(`not a wrapped Linux command: ${remote}`);
  return m[1]!.replace(/'\\''/g, "'");
}

/** the outer wrapper script and the child's own script (or cmd line) of a Windows ssh command */
function windowsScripts(remote: string): { outer: string; inner: string } {
  if (!remote.startsWith(WIN_PREFIX)) throw new Error(`not a wrapped Windows command: ${remote.slice(0, 80)}`);
  const outer = decodePowerShell(remote.slice(WIN_PREFIX.length));
  const enc = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)?.[1];
  const cmdArg = /-FilePath 'cmd' -ArgumentList '((?:[^']|'')*)'/.exec(outer)?.[1]?.replace(/''/g, "'");
  return { outer, inner: enc ? decodePowerShell(enc) : (cmdArg ?? '') };
}

/** the check's own command, whichever OS wrapped it */
function innerOf(remote: string): string {
  return remote.startsWith(WIN_PREFIX) ? windowsScripts(remote).inner : unwrapLinux(remote);
}

let tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
const dir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-remote-${tag}-`));
  tmp.push(d);
  return d;
};

describe('paths and quoting', () => {
  it('joins the work root per OS and keeps repo names boring', () => {
    expect(repoDirOn(lin, 'cf-aoi')).toBe('/srv/loop/repos/cf-aoi');
    expect(repoDirOn(win, 'cf-aoi')).toBe('C:\\loop\\repos\\cf-aoi');
    expect(datasetDirOn(win, 'dataset-2026Q2')).toBe('C:\\loop\\datasets\\dataset-2026Q2');
    expect(repoDirOn(lin, '../etc; rm')).toBe('/srv/loop/repos/__etc__rm');
    // before the check has said what the box is, a C:\ root means Windows
    expect(repoDirOn({ os: 'auto', work_root: 'C:\\loop' }, 'x')).toBe('C:\\loop\\repos\\x');
    expect(repoDirOn({ os: 'auto', work_root: '/srv/loop' }, 'x')).toBe('/srv/loop/repos/x');
  });

  it('quotes for bash, PowerShell and cmd', () => {
    expect(quoteFor('linux', "it's")).toBe(`'it'\\''s'`);
    expect(quoteFor('bash', 'plain')).toBe("'plain'");
    expect(quoteFor('windows', "it's")).toBe("'it''s'");
    expect(quoteFor('cmd', 'a & b | c > d (e)')).toBe('a ^& b ^| c ^> d ^(e^)');
    expect(shellOf(lin)).toBe('bash');
    expect(shellOf(win)).toBe('powershell');
    expect(shellOf(winCmd)).toBe('cmd');
  });
});

describe('wrapCommand', () => {
  it('Linux: cd, GNU timeout with a KILL escalation, a login bash, merged output', () => {
    expect(wrapCommand(lin, '/srv/loop/repos/cf-aoi', 'make test', 60)).toBe(`cd '/srv/loop/repos/cf-aoi' && timeout --kill-after=10 60 bash -lc 'make test' 2>&1`);
    expect(wrapCommand(lin, null, 'echo hi', 5, { FOO: 'bar' })).toBe(`timeout --kill-after=10 5 bash -lc 'export FOO='\\''bar'\\''; echo hi' 2>&1`);
    expect(wrapCommand(lin, null, `echo "it's"`, 0.2)).toBe(`timeout --kill-after=10 1 bash -lc 'echo "it'\\''s"' 2>&1`);
  });

  it('Windows: an encoded PowerShell wrapper — UTF-8, Set-Location, Start-Process + WaitForExit → 124, the logs, the child exit code', () => {
    const remote = wrapCommand(win, 'C:\\loop\\repos\\cf-aoi', 'cmake --build build', 90, { FOO: 'bar' });
    // nothing the login shell (cmd.exe or PowerShell) could re-parse leaves the base64
    expect(remote).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    const { outer, inner } = windowsScripts(remote);
    expect(outer.split('\n')[0]).toBe('[Console]::OutputEncoding=[Text.Encoding]::UTF8');
    expect(outer).toContain("Set-Location -LiteralPath 'C:\\loop\\repos\\cf-aoi'");
    expect(outer).toContain("$p=Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','");
    expect(outer).toContain("-WorkingDirectory 'C:\\loop\\repos\\cf-aoi' -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError $e");
    expect(outer).toContain('$null=$p.Handle');
    expect(outer).toContain('if (!$p.WaitForExit(90000)) { taskkill /T /F /PID $p.Id 2>$null | Out-Null; $p.WaitForExit(); $c=124 } else { $c=$p.ExitCode }');
    expect(outer).toContain('Get-Content -LiteralPath $o -Encoding UTF8 -Raw\nGet-Content -LiteralPath $e -Encoding UTF8 -Raw');
    expect(outer.trim().endsWith('exit $c')).toBe(true);
    expect(inner).toBe(
      [
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
        '$OutputEncoding=[Text.Encoding]::UTF8',
        "$ErrorActionPreference='Continue'",
        "$env:FOO='bar'",
        'cmake --build build',
        '$ok=$?',
        'if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }',
        'if (-not $ok) { exit 1 }',
        'exit 0',
      ].join('\n'),
    );
    // no cwd: no Set-Location / -WorkingDirectory
    const bare = windowsScripts(wrapCommand(win, null, 'hostname', 10)).outer;
    expect(bare).not.toContain('Set-Location');
    expect(bare).not.toContain('-WorkingDirectory');
  });

  it("Windows with shell=cmd: the child is cmd /c with chcp 65001 and cd /d, quotes doubled for PowerShell's string", () => {
    const { outer, inner } = windowsScripts(wrapCommand(winCmd, 'C:\\loop\\repos\\cf-aoi', "echo it's", 10, { FOO: 'bar' }));
    expect(outer).toContain(`-FilePath 'cmd' -ArgumentList '/c "chcp 65001>nul && set "FOO=bar" && cd /d C:\\loop\\repos\\cf-aoi && echo it''s 2>&1"'`);
    expect(inner).toBe(`/c "chcp 65001>nul && set "FOO=bar" && cd /d C:\\loop\\repos\\cf-aoi && echo it's 2>&1"`);
    expect(outer).toContain('WaitForExit(10000)');
  });
});

describe('runRemote', () => {
  it('ssh argv: the shared options, the port, the target, the wrapped command; the client waits 30 s longer than the box', async () => {
    const f = fake(() => ({ code: 0, out: 'hello\n' }));
    const r = await runRemote(lin, f.exec, { cwd: '/srv/loop/repos/cf-aoi', command: 'make test', timeoutMs: 60_000 });
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false, output: 'hello\n' });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(f.calls[0]).toMatchObject({ cmd: 'ssh', timeoutMs: 90_000 });
    expect(f.calls[0]!.args).toEqual([...SSH_OPTS, '-p', '2222', 'loop@gpu-1', `cd '/srv/loop/repos/cf-aoi' && timeout --kill-after=10 60 bash -lc 'make test' 2>&1`]);
    // a Windows box: no -p without a port, and the encoded wrapper
    const w = fake();
    await runRemote(win, w.exec, { cwd: 'C:\\loop\\repos\\cf-aoi', command: 'ctest', timeoutMs: 5000 });
    expect(w.calls[0]!.args.slice(0, -1)).toEqual([...SSH_OPTS, 'aoi@aoi-1']);
    expect(windowsScripts(w.remote(0)).inner).toContain('\nctest\n');
  });

  it("maps exit codes: the command's own, 124 = timed out on the box, 255 = 連不上, null = no ssh here", async () => {
    const code = (c: number | null, out = '') => runRemote(lin, fake(() => ({ code: c, out })).exec, { cwd: null, command: 'x', timeoutMs: 60_000 });
    expect(await code(3, 'boom')).toMatchObject({ ok: false, exitCode: 3, timedOut: false, output: 'boom' });
    const t = await code(124, 'partial');
    expect(t).toMatchObject({ ok: false, exitCode: 124, timedOut: true });
    expect(t.output).toBe('partial\n（逾時：超過 60 秒，已在 gpu-1 上中止）');
    const down = await code(255, 'ssh: connect to host gpu-1 port 2222: No route to host');
    expect(down).toMatchObject({ ok: false, exitCode: 255, timedOut: false });
    expect(down.output).toBe('連不上 gpu-1（ssh loop@gpu-1）：ssh: connect to host gpu-1 port 2222: No route to host');
    expect(await code(null)).toMatchObject({ ok: false, exitCode: null, output: expect.stringContaining('找不到 ssh') });
  });

  it("KILL's 137 counts as a timeout only at the deadline", async () => {
    const slow = fake();
    const late: HostExec = async (...a) => {
      await new Promise((r) => setTimeout(r, 1050));
      await slow.exec(...a);
      return { code: 137, out: '' };
    };
    expect(await runRemote(lin, late, { cwd: null, command: 'x', timeoutMs: 1000 })).toMatchObject({ exitCode: 137, timedOut: true });
    expect(await runRemote(lin, fake(() => ({ code: 137, out: 'Killed' })).exec, { cwd: null, command: 'x', timeoutMs: 60_000 })).toMatchObject({ exitCode: 137, timedOut: false, ok: false });
  });

  it('never throws, and refuses an unknown OS or bad inputs before touching ssh', async () => {
    const boom: HostExec = async () => {
      throw new Error('spawn EAGAIN');
    };
    expect(await runRemote(lin, boom, { cwd: null, command: 'x', timeoutMs: 1000 })).toMatchObject({ ok: false, output: 'spawn EAGAIN' });
    const f = fake();
    const auto = await runRemote({ ...lin, os: 'auto' }, f.exec, { cwd: null, command: 'x', timeoutMs: 1000 });
    expect(auto.output).toContain('loop machine check gpu-1');
    expect((await runRemote(lin, f.exec, { cwd: '../x', command: 'x', timeoutMs: 1000 })).output).toContain('工作目錄不合法');
    expect((await runRemote(lin, f.exec, { cwd: null, command: '   ', timeoutMs: 1000 })).output).toContain('不可為空');
    expect((await runRemote(lin, f.exec, { cwd: null, command: 'x', timeoutMs: 1000, env: { 'A-B': '1' } })).output).toContain('環境變數');
    expect((await runRemote(win, f.exec, { cwd: null, command: 'x'.repeat(4001), timeoutMs: 1000 })).output).toContain('上限 4000 字');
    expect(f.calls).toHaveLength(0);
  });

  it('keeps the last 20k characters of a chatty command', async () => {
    const r = await runRemote(lin, fake(() => ({ code: 0, out: `${'x'.repeat(25_000)}END` })).exec, { cwd: null, command: 'x', timeoutMs: 1000 });
    expect(r.output).toHaveLength(20_000);
    expect(r.output.endsWith('END')).toBe(true);
  });
});

describe('ensureCheckout', () => {
  const req = { repoName: 'cf-aoi', remoteUrl: 'http://gitea.corp:3000/aoi/cf-aoi.git', sha: 'abc1234', branch: 'loop/t_1', transport: 'gitea' as const };
  const GIT_ENV = "export GIT_TERMINAL_PROMPT='0'; export GCM_INTERACTIVE='never'; ";

  it('gitea on Linux: probes the clone, clones --no-checkout when missing, fetches the branch, checks out the sha detached', async () => {
    const f = fake((_c, remote) => (remote.includes('test -d') ? { code: 1, out: '' } : { code: 0, out: 'ok' }));
    const r = await ensureCheckout(lin, f.exec, req);
    expect(r).toMatchObject({ ok: true, dir: '/srv/loop/repos/cf-aoi' });
    expect(f.calls.map((_c, i) => unwrapLinux(f.remote(i)))).toEqual([
      `test -d '/srv/loop/repos/cf-aoi/.git'`,
      `${GIT_ENV}git clone --no-checkout 'http://gitea.corp:3000/aoi/cf-aoi.git' '/srv/loop/repos/cf-aoi'`,
      `${GIT_ENV}git -C '/srv/loop/repos/cf-aoi' fetch --prune origin 'loop/t_1'`,
      `${GIT_ENV}git -C '/srv/loop/repos/cf-aoi' checkout --detach --force abc1234`,
    ]);
    expect(f.calls[1]!.timeoutMs).toBe(15 * 60_000 + 30_000);
    // an existing clone is fetched into, never re-cloned (and never cleaned)
    const g = fake(() => ({ code: 0, out: '' }));
    expect((await ensureCheckout(lin, g.exec, req)).ok).toBe(true);
    expect(g.calls.map((_c, i) => unwrapLinux(g.remote(i)))).toEqual([
      `test -d '/srv/loop/repos/cf-aoi/.git'`,
      `${GIT_ENV}git -C '/srv/loop/repos/cf-aoi' fetch --prune origin 'loop/t_1'`,
      `${GIT_ENV}git -C '/srv/loop/repos/cf-aoi' checkout --detach --force abc1234`,
    ]);
    expect(g.calls.map((c) => c.args.join(' '))).not.toContain(expect.stringContaining('git clean'));
  });

  it('gitea on Windows: the same sequence in PowerShell, whatever shell the checks use', async () => {
    const f = fake((_c, remote) => (windowsScripts(remote).inner.includes('Test-Path') ? { code: 1, out: '' } : { code: 0, out: '' }));
    const r = await ensureCheckout(winCmd, f.exec, req);
    expect(r).toMatchObject({ ok: true, dir: 'C:\\loop\\repos\\cf-aoi' });
    const inner = f.calls.map((_c, i) => windowsScripts(f.remote(i)).inner);
    expect(inner[0]).toContain("if (Test-Path -LiteralPath 'C:\\loop\\repos\\cf-aoi\\.git') { exit 0 } else { exit 1 }");
    expect(inner[1]).toContain("$env:GIT_TERMINAL_PROMPT='0'\n$env:GCM_INTERACTIVE='never'\ngit clone --no-checkout 'http://gitea.corp:3000/aoi/cf-aoi.git' 'C:\\loop\\repos\\cf-aoi'");
    expect(inner[2]).toContain("git -C 'C:\\loop\\repos\\cf-aoi' fetch --prune origin 'loop/t_1'");
    expect(inner[3]).toContain("git -C 'C:\\loop\\repos\\cf-aoi' checkout --detach --force abc1234");
    for (let i = 0; i < 4; i++) expect(windowsScripts(f.remote(i)).outer).toContain("-FilePath 'powershell'");
  });

  it('reports which step failed, in words', async () => {
    const f = fake((_c, remote) => (remote.includes('fetch --prune') ? { code: 128, out: "fatal: couldn't find remote ref loop/t_1" } : { code: 0, out: '' }));
    const r = await ensureCheckout(lin, f.exec, req);
    expect(r.ok).toBe(false);
    expect(r.out).toContain('抓分支 loop/t_1 失敗');
    expect(r.out).toContain("couldn't find remote ref");
    expect(f.calls).toHaveLength(2);
  });

  it('copy on Linux: rsync -a --delete with the .gitignore filter into <work_root>/repos/<name>', async () => {
    const tree = dir('tree');
    const f = fake();
    const r = await ensureCheckout(lin, f.exec, { ...req, transport: 'copy', localTree: tree });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ cmd: 'rsync', timeoutMs: 10 * 60_000 });
    expect(f.calls[0]!.args).toEqual([
      '-a',
      '--delete',
      '--filter=:- .gitignore',
      '--rsync-path=mkdir -p /srv/loop/repos/cf-aoi && rsync',
      '-e',
      `ssh ${SSH_OPTS.join(' ')} -p 2222`,
      `${tree}/`,
      'loop@gpu-1:/srv/loop/repos/cf-aoi/',
    ]);
    expect((await ensureCheckout(lin, fake(() => ({ code: null, out: '' })).exec, { ...req, transport: 'copy', localTree: tree })).out).toContain('找不到 rsync');
  });

  it('copy on Windows: clears the old copy over ssh, then scp -O -r', async () => {
    const tree = dir('tree');
    const f = fake();
    const r = await ensureCheckout(win, f.exec, { ...req, transport: 'copy', localTree: tree });
    expect(r).toMatchObject({ ok: true, dir: 'C:\\loop\\repos\\cf-aoi' });
    expect(f.calls.map((c) => c.cmd)).toEqual(['ssh', 'scp']);
    const prep = windowsScripts(f.remote(0)).inner;
    expect(prep).toContain("New-Item -ItemType Directory -Force -Path 'C:\\loop\\repos' | Out-Null");
    expect(prep).toContain("if (Test-Path -LiteralPath 'C:\\loop\\repos\\cf-aoi') { Remove-Item -LiteralPath 'C:\\loop\\repos\\cf-aoi' -Recurse -Force }");
    expect(f.calls[1]!.args).toEqual(['-O', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-r', tree, 'aoi@aoi-1:"C:/loop/repos/cf-aoi"']);
  });

  it('refuses a bad sha / branch / url, a missing tree and an unknown OS without touching the box', async () => {
    const f = fake();
    expect((await ensureCheckout(lin, f.exec, { ...req, sha: 'HEAD; rm -rf /' })).out).toContain('sha 不合法');
    expect((await ensureCheckout(lin, f.exec, { ...req, branch: '-x' })).out).toContain('分支名不合法');
    expect((await ensureCheckout(lin, f.exec, { ...req, remoteUrl: "http://x/y'; rm" })).out).toContain('remote 網址不合法');
    expect((await ensureCheckout(lin, f.exec, { ...req, transport: 'copy', localTree: '/nonexistent/tree' })).out).toContain('目錄不存在');
    expect((await ensureCheckout({ ...lin, os: 'auto' }, f.exec, req)).out).toContain('loop machine check');
    expect(f.calls).toHaveLength(0);
  });
});

describe('pullBack', () => {
  it('Linux: one rsync for all paths into the local dir (created if needed)', async () => {
    const local = path.join(dir('pull'), 'cr_1');
    const f = fake();
    expect((await pullBack(lin, f.exec, ['/srv/loop/repos/cf-aoi/out', '/srv/loop/repos/cf-aoi/report.json'], local)).ok).toBe(true);
    expect(fs.existsSync(local)).toBe(true);
    expect(f.calls[0]).toMatchObject({ cmd: 'rsync', timeoutMs: 10 * 60_000 });
    expect(f.calls[0]!.args).toEqual(['-a', '-e', `ssh ${SSH_OPTS.join(' ')} -p 2222`, 'loop@gpu-1:/srv/loop/repos/cf-aoi/out', 'loop@gpu-1:/srv/loop/repos/cf-aoi/report.json', `${local}/`]);
  });

  it('Windows: scp -O -r with forward slashes', async () => {
    const local = dir('pull');
    const f = fake();
    expect((await pullBack(win, f.exec, ['C:\\loop\\repos\\cf-aoi\\out'], local)).ok).toBe(true);
    expect(f.calls[0]!.args).toEqual(['-O', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-r', 'aoi@aoi-1:"C:/loop/repos/cf-aoi/out"', `${local}/`]);
    const bad = await pullBack(win, f.exec, ['C:\\loop\\..\\secret'], local);
    expect(bad.out).toContain('遠端路徑不合法');
    expect((await pullBack(win, f.exec, [], local)).ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect((await pullBack(lin, fake(() => ({ code: 23, out: 'rsync: link_stat failed' })).exec, ['/srv/loop/x'], local)).out).toContain('收回失敗');
  });
});

describe('ensureDataset', () => {
  const ds = { name: 'dataset-2026Q2', remoteUrl: 'http://gitea.corp:3000/aoi/dataset-2026Q2.git' };

  it('clones a missing 圖資 and skips git lfs when .gitattributes never mentions it', async () => {
    const f = fake((_c, remote) => (remote.includes('test -d') || remote.includes('grep -q') ? { code: 1, out: '' } : { code: 0, out: '' }));
    const r = await ensureDataset(lin, f.exec, ds);
    expect(r).toMatchObject({ ok: true, dir: '/srv/loop/datasets/dataset-2026Q2' });
    expect(f.calls.map((_c, i) => innerOf(f.remote(i)).replace(/^export [^;]+; export [^;]+; /, ''))).toEqual([
      `test -d '/srv/loop/datasets/dataset-2026Q2/.git'`,
      `git clone 'http://gitea.corp:3000/aoi/dataset-2026Q2.git' '/srv/loop/datasets/dataset-2026Q2'`,
      `git -C '/srv/loop/datasets/dataset-2026Q2' grep -q -e lfs -- .gitattributes`,
    ]);
  });

  it('refreshes a present 圖資 and pulls LFS objects when .gitattributes mentions lfs', async () => {
    const f = fake(() => ({ code: 0, out: '' }));
    expect((await ensureDataset(win, f.exec, ds)).ok).toBe(true);
    const inner = f.calls.map((_c, i) => innerOf(f.remote(i)));
    expect(inner[0]).toContain("Test-Path -LiteralPath 'C:\\loop\\datasets\\dataset-2026Q2\\.git'");
    expect(inner[1]).toContain("git -C 'C:\\loop\\datasets\\dataset-2026Q2' fetch --prune origin");
    expect(inner[2]).toContain("git -C 'C:\\loop\\datasets\\dataset-2026Q2' checkout --detach --force origin/HEAD");
    expect(inner[3]).toContain("git -C 'C:\\loop\\datasets\\dataset-2026Q2' grep -q -e lfs -- .gitattributes");
    expect(inner[4]).toContain("git -C 'C:\\loop\\datasets\\dataset-2026Q2' lfs pull");
    expect(f.calls[4]!.timeoutMs).toBe(30 * 60_000 + 30_000);
    const noLfs = fake((_c, remote) => (innerOf(remote).includes('lfs pull') ? { code: 1, out: "git: 'lfs' is not a git command" } : { code: 0, out: '' }));
    expect((await ensureDataset(lin, noLfs.exec, ds)).out).toContain('要先裝 git-lfs');
  });
});

describe('withMachineLock', () => {
  it('runs one thing per machine at a time, in order', async () => {
    const order: string[] = [];
    const a = withMachineLock('aoi-1', async () => {
      expect(machineBusy('aoi-1')).toBe(true);
      await new Promise((r) => setTimeout(r, 30));
      order.push('a');
      return 'A';
    });
    const b = withMachineLock('aoi-1', async () => {
      order.push('b');
      return 'B';
    });
    const other = withMachineLock('gpu-1', async () => {
      order.push('other');
    });
    expect(await Promise.all([a, b, other])).toEqual(['A', 'B', undefined]);
    expect(order).toEqual(['other', 'a', 'b']);
    expect(machineBusy('aoi-1')).toBe(false);
    // a failure releases the lock
    await expect(withMachineLock('aoi-1', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(machineBusy('aoi-1')).toBe(false);
  });
});

describe('checkMachine', () => {
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  const LINUX_SPECS = ['== specs', 'os=Ubuntu 22.04.4 LTS', 'kernel=6.5.0-41-generic', 'arch=x86_64', 'cpu=Intel(R) Xeon(R) W-2245 CPU @ 3.90GHz', 'threads=16', 'tpc=2', 'mem_kb=65536000', 'disk_total_kb=976762584', 'disk_free_kb=222298112', 'gpu=NVIDIA RTX A4000, 16376, 550.90.07', 'cuda_driver=12.4', 'cuda_toolkit=12.2', 'python=3.11.4', 'gcc=11.4.0', 'cmake=', 'docker='];
  const WIN_SPECS = ['== specs', 'os=Microsoft Windows 11 專業版 (10.0.22631)', 'kernel=10.0.22631', 'mem_kb=33554432', 'arch=AMD64', 'cpu=Intel(R) Core(TM) i7-12700', 'cores=12', 'threads=20', 'disk_total_kb=976762584', 'disk_free_kb=222298112', 'gpu=NVIDIA RTX A4000, 16376, 552.22', 'cuda_driver=12.4', 'msvc=Visual Studio Professional 2022'];
  const LINUX_PROBE = ['== git', 'git version 2.45.1', '== work', 'work: writable', 'free_kb:222298112', '== python', 'Python 3.11.4', '== gpu', 'NVIDIA RTX A4000', '== repos', `repo cf-aoi 3f2a1c9 ${twoHoursAgo}`, '== datasets', 'dataset dataset-2026Q2 missing', ...LINUX_SPECS, ''].join('\n');
  const WIN_PROBE = LINUX_PROBE.replace('git version 2.45.1', 'git version 2.45.1.windows.1').replace('Python 3.11.4', 'python: not found').replace(LINUX_SPECS.join('\n'), WIN_SPECS.join('\n'));
  const repos = [{ name: 'cf-aoi', remoteUrl: 'http://gitea.corp:3000/aoi/cf-aoi.git' }];
  const datasets = [{ name: 'dataset-2026Q2' }];

  /** a Linux box answering every probe, with overrides */
  const linuxBox = (over: Partial<Record<'uname' | 'probe' | 'ls', Answer>> = {}) =>
    fake((_c, remote) => {
      if (remote === 'uname -s') return over.uname ?? { code: 0, out: 'Linux\n' };
      const inner = remote.startsWith(WIN_PREFIX) ? windowsScripts(remote).inner : unwrapLinux(remote);
      if (inner.includes('== git')) return over.probe ?? { code: 0, out: LINUX_PROBE };
      if (inner.includes('ls-remote')) return over.ls ?? { code: 0, out: '3f2a1c9\tHEAD\n' };
      return { code: 1, out: '' };
    });

  it('Linux, everything fine: the eight lines and what it detected', async () => {
    const f = linuxBox();
    const r = await checkMachine({ ...lin, os: 'auto' }, f.exec, { repos, datasets });
    expect(r.ok).toBe(true);
    expect(r.detected).toMatchObject({ os: 'linux', shell: 'bash', transport: 'gitea' });
    expect(r.detected.specs).toMatchObject({
      os: 'Ubuntu 22.04.4 LTS',
      arch: 'x86_64',
      cores: 8,
      threads: 16,
      ram_gb: 62.5,
      disk_total_gb: 931.5,
      gpus: [{ name: 'NVIDIA RTX A4000', vram_gb: 16 }],
      driver: '550.90.07',
      cuda_driver: '12.4',
      cuda_toolkit: '12.2',
      tools: { python: '3.11.4', gcc: '11.4.0' },
    });
    expect(r.lines.map((l) => `${l.ok === true ? '✓' : l.ok === false ? '✗' : '⚠'} ${l.label}  ${l.detail}`)).toEqual([
      '✓ SSH 登入  loop@gpu-1（Linux，bash）',
      '✓ git  2.45.1',
      '✓ Gitea  能讀 http://gitea.corp:3000（已存認證）',
      '✓ 工作目錄  /srv/loop 可寫，剩 212 GB',
      '✓ Python  Python 3.11.4',
      '✓ GPU  NVIDIA RTX A4000',
      '✓ 規格  Ubuntu 22.04.4 LTS（x86_64） · 8 核／16 緒 · RAM 63 GB · NVIDIA RTX A4000 16 GB · CUDA 12.2',
      '✓ repo 複本  cf-aoi @ 3f2a1c9（2 小時前）',
      '⚠ 圖資快取  dataset-2026Q2 還沒抓：第一次跑檢查時會抓',
    ]);
    // the login probe is a bare `uname -s`; everything after it goes through the wrapper
    expect(f.calls[0]!.args).toEqual([...SSH_OPTS, '-p', '2222', 'loop@gpu-1', 'uname -s']);
    expect(f.calls[0]!.timeoutMs).toBe(20_000);
    expect(f.calls).toHaveLength(3);
    const probe = unwrapLinux(f.remote(1));
    expect(probe).toContain(`touch '/srv/loop/.loop-probe'`);
    expect(probe).toContain(`git -C '/srv/loop/repos/cf-aoi' rev-parse --short HEAD`);
    expect(probe).toContain(`test -d '/srv/loop/datasets/dataset-2026Q2/.git'`);
    expect(probe).toContain(`df -Pk '/srv/loop'`);
    expect(probe).toContain('nvidia-smi --query-gpu=name,memory.total,driver_version');
    expect(unwrapLinux(f.remote(2))).toBe(`export GIT_TERMINAL_PROMPT='0'; export GCM_INTERACTIVE='never'; git ls-remote 'http://gitea.corp:3000/aoi/cf-aoi.git' HEAD`);
  });

  it('cannot log in: one line with the key setup for both OSes, nothing detected', async () => {
    const f = fake(() => ({ code: 255, out: 'loop@gpu-1: Permission denied (publickey).\n' }));
    const r = await checkMachine(lin, f.exec, { repos });
    expect(r.ok).toBe(false);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ ok: false, label: 'SSH 登入' });
    expect(r.lines[0]!.detail).toContain('無法以金鑰登入 loop@gpu-1：loop@gpu-1: Permission denied (publickey).');
    expect(r.lines[0]!.detail).toContain('ssh-copy-id -p 2222 loop@gpu-1');
    expect(r.lines[0]!.detail).toContain('C:\\ProgramData\\ssh\\administrators_authorized_keys');
    expect(r.detected).toEqual({ specs: null, os: null, shell: null, transport: null });
    expect(f.calls).toHaveLength(1);
    const hk = await checkMachine(lin, fake(() => ({ code: 255, out: 'Host key verification failed.' })).exec, {});
    expect(hk.lines[0]!.detail).toContain('host key');
    expect((await checkMachine(lin, fake(() => ({ code: null, out: '' })).exec, {})).lines[0]!.detail).toContain('找不到 ssh');
  });

  it('Windows: uname fails, the PowerShell wrapper answers, the probe runs through it', async () => {
    const f = fake((_c, remote) => {
      if (remote === 'uname -s') return { code: 1, out: "'uname' is not recognized as an internal or external command,\noperable program or batch file.\n" };
      const inner = windowsScripts(remote).inner;
      if (inner.includes('LOOP_WIN')) return { code: 0, out: 'LOOP_WIN=10.0.22631.0\r\nLOOP_PS=5.1.22621.2506\r\n' };
      if (inner.includes('== git')) return { code: 0, out: WIN_PROBE.replace(/\n/g, '\r\n') };
      if (inner.includes('ls-remote')) return { code: 0, out: '3f2a1c9\tHEAD' };
      return { code: 1, out: '' };
    });
    const r = await checkMachine({ ...win, os: 'auto', work_root: 'C:\\loop' }, f.exec, { repos, datasets });
    expect(r.ok).toBe(true);
    expect(r.detected).toMatchObject({ os: 'windows', shell: 'powershell', transport: 'gitea' });
    expect(r.detected.specs).toMatchObject({ os: 'Microsoft Windows 11 專業版 (10.0.22631)', cores: 12, threads: 20, ram_gb: 32, cuda_toolkit: null, tools: { msvc: 'Visual Studio Professional 2022' } });
    expect(r.lines.map((l) => l.detail)).toEqual([
      'aoi@aoi-1（Windows 11，PowerShell 5.1）',
      '2.45.1',
      '能讀 http://gitea.corp:3000（已存認證）',
      'C:\\loop 可寫，剩 212 GB',
      '找不到 python；圖資比對在引擎主機做，不影響',
      'NVIDIA RTX A4000',
      'Microsoft Windows 11 專業版 (10.0.22631)（AMD64） · 12 核／20 緒 · RAM 32 GB · NVIDIA RTX A4000 16 GB · CUDA（驅動）12.4',
      'cf-aoi @ 3f2a1c9（2 小時前）',
      'dataset-2026Q2 還沒抓：第一次跑檢查時會抓',
    ]);
    expect(r.lines[4]!.ok).toBeNull();
    const probe = windowsScripts(f.remote(2)).inner;
    expect(probe).toContain("New-Item -ItemType Directory -Force -Path 'C:\\loop' | Out-Null");
    expect(probe).toContain("Get-PSDrive -Name 'C'");
    expect(probe).toContain("git -C 'C:\\loop\\repos\\cf-aoi' rev-parse --short HEAD");
    expect(probe).toContain("Test-Path -LiteralPath 'C:\\loop\\datasets\\dataset-2026Q2\\.git'");
    expect(probe).toContain('Get-CimInstance Win32_Processor');
    expect(probe).toContain('vswhere.exe');
    // Git Bash's uname also means Windows
    const g = fake((_c, remote) => {
      if (remote === 'uname -s') return { code: 0, out: 'MINGW64_NT-10.0-19045\n' };
      const inner = windowsScripts(remote).inner;
      if (inner.includes('LOOP_WIN')) return { code: 0, out: 'LOOP_WIN=10.0.19045.0\nLOOP_PS=5.1.19041.4046\n' };
      return { code: 0, out: inner.includes('== git') ? WIN_PROBE : '' };
    });
    expect((await checkMachine({ ...win, os: 'auto' }, g.exec, {})).lines[0]!.detail).toBe('aoi@aoi-1（Windows 10，PowerShell 5.1）');
  });

  it('no git: says how to install it and skips Gitea', async () => {
    const f = linuxBox({ probe: { code: 0, out: LINUX_PROBE.replace('git version 2.45.1', 'git: not found') } });
    const r = await checkMachine(lin, f.exec, { repos });
    expect(r.ok).toBe(false);
    expect(r.lines[1]).toMatchObject({ ok: false, label: 'git', detail: expect.stringContaining('sudo apt install git') });
    expect(r.lines[2]).toMatchObject({ ok: null, label: 'Gitea', detail: '略過（沒有 git）' });
    expect(r.detected.transport).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  it('Gitea unreachable from the box: transport copy, the credential fix named; a machine set to gitea fails', async () => {
    const box = () => linuxBox({ ls: { code: 128, out: 'fatal: Authentication failed for http://gitea.corp:3000/aoi/cf-aoi.git/\n' } });
    const r = await checkMachine(lin, box().exec, { repos });
    expect(r.ok).toBe(true);
    expect(r.detected.transport).toBe('copy');
    expect(r.lines[2]).toMatchObject({ ok: null, label: 'Gitea' });
    expect(r.lines[2]!.detail).toContain('gpu-1 讀不到 http://gitea.corp:3000（fatal: Authentication failed');
    expect(r.lines[2]!.detail).toContain('credential.helper store');
    const strict = await checkMachine({ ...lin, transport: 'gitea' }, box().exec, { repos });
    expect(strict.ok).toBe(false);
    expect(strict.lines[2]!.ok).toBe(false);
    // no repo yet: nothing to try, nothing decided
    const none = await checkMachine(lin, linuxBox().exec, {});
    expect(none.lines[2]).toMatchObject({ ok: null, label: 'Gitea' });
    expect(none.detected.transport).toBeNull();
    expect(none.lines.map((l) => l.label)).toEqual(['SSH 登入', 'git', 'Gitea', '工作目錄', 'Python', 'GPU', '規格']);
  });

  it('a wrong setting is a failed line: the OS the row claims, a work root of the other OS, an unwritable root', async () => {
    const claims = await checkMachine({ ...lin, os: 'windows', work_root: 'C:\\loop' }, linuxBox().exec, {});
    expect(claims.lines[0]).toMatchObject({ ok: false, label: 'SSH 登入', detail: expect.stringContaining('機台設定寫的是 Windows') });
    const root = await checkMachine({ ...lin, os: 'auto', work_root: 'C:\\loop' }, linuxBox().exec, {});
    expect(root.lines[1]).toMatchObject({ ok: false, label: '工作目錄', detail: expect.stringContaining('不是 Linux') });
    expect(root.detected.os).toBe('linux');
    const ro = await checkMachine(lin, linuxBox({ probe: { code: 0, out: LINUX_PROBE.replace('work: writable\nfree_kb:222298112', 'mkdir: cannot create directory: Permission denied\nwork: not writable') } }).exec, {});
    expect(ro.lines[3]).toMatchObject({ ok: false, label: '工作目錄' });
    expect(ro.lines[3]!.detail).toContain('sudo mkdir -p /srv/loop && sudo chown loop /srv/loop');
    const gone = await checkMachine(lin, linuxBox({ probe: { code: 124, out: '' } }).exec, {});
    expect(gone.lines[1]).toMatchObject({ ok: false, label: '檢查指令', detail: expect.stringContaining('逾時') });
  });
});
