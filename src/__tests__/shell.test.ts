import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolveShell, runShell } from '../util/shell.js';

// ---- fake execFileSync for platform-detection tests (no real process ever spawned) ----

type ExecFn = (cmd: string, args: string[], opts?: Record<string, unknown>) => string;

/** `git --exec-path` + `where bash` both resolve — Git-Bash is "installed". */
function gitBashPresent(): ExecFn {
  return (cmd, args) => {
    if (cmd === 'git' && args[0] === '--exec-path') return 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core';
    if (cmd === 'where') return 'C:\\found.exe';
    throw new Error(`unexpected exec: ${cmd}`);
  };
}

/** Nothing resolves — no git, no bash, no powershell on PATH. */
function nothingPresent(): ExecFn {
  return () => {
    throw new Error('not found');
  };
}

/** git --exec-path fails, but `where bash` succeeds (bash on PATH without a Git install). */
function bashOnPathOnly(): ExecFn {
  return (cmd, args) => {
    if (cmd === 'where' && args[0] === 'bash') return 'bash';
    throw new Error('not found');
  };
}

/** No bash anywhere, but `where powershell` succeeds. */
function powershellOnlyPresent(): ExecFn {
  return (cmd, args) => {
    if (cmd === 'where' && args[0] === 'powershell') return 'C:\\Windows\\powershell.exe';
    throw new Error('not found');
  };
}

const existsAlways = () => true;
const existsNever = () => false;

describe('resolveShell', () => {
  it('linux (any shell setting unset/auto) -> bash -lc, byte-identical to today', () => {
    const shell = resolveShell({ platform: 'linux' });
    expect(shell.cmd).toBe('bash');
    expect(shell.argsFor('npm test')).toEqual(['-lc', 'npm test']);
  });

  it('darwin auto -> bash -lc too', () => {
    const shell = resolveShell({ platform: 'darwin' });
    expect(shell.cmd).toBe('bash');
    expect(shell.argsFor('echo hi')).toEqual(['-lc', 'echo hi']);
  });

  it('win32 auto: git-bash found via `git --exec-path` -> used, with -lc args', () => {
    const shell = resolveShell({
      platform: 'win32',
      execFileSync: gitBashPresent(),
      existsSync: existsAlways,
    });
    expect(shell.cmd).toContain('bash.exe');
    expect(shell.argsFor('echo hi')).toEqual(['-lc', 'echo hi']);
  });

  it('win32 auto: no git install but bash on PATH -> git-bash path still preferred', () => {
    const shell = resolveShell({
      platform: 'win32',
      execFileSync: bashOnPathOnly(),
      existsSync: existsNever,
    });
    expect(shell.cmd).toBe('bash');
    expect(shell.argsFor('echo hi')).toEqual(['-lc', 'echo hi']);
  });

  it('win32 auto: no bash anywhere, powershell on PATH -> PowerShell', () => {
    const shell = resolveShell({
      platform: 'win32',
      execFileSync: powershellOnlyPresent(),
      existsSync: existsNever,
    });
    expect(shell.cmd).toBe('powershell');
    expect(shell.argsFor('echo hi')).toEqual(['-NoProfile', '-Command', 'echo hi']);
  });

  it('win32 auto: nothing found -> falls back to cmd', () => {
    const shell = resolveShell({
      platform: 'win32',
      execFileSync: nothingPresent(),
      existsSync: existsNever,
    });
    expect(shell.cmd).toBe('cmd');
    expect(shell.argsFor('echo hi')).toEqual(['/c', 'echo hi']);
  });

  it('explicit shell setting overrides platform/auto-detection', () => {
    expect(resolveShell({ platform: 'win32', shellSetting: 'bash' }).cmd).toBe('bash');
    expect(resolveShell({ platform: 'linux', shellSetting: 'powershell' }).cmd).toBe('powershell');
    expect(resolveShell({ platform: 'linux', shellSetting: 'cmd' }).cmd).toBe('cmd');
  });

  it('explicit git-bash: uses the located bash if found, else falls back to plain "bash"', () => {
    const found = resolveShell({ platform: 'win32', shellSetting: 'git-bash', execFileSync: gitBashPresent(), existsSync: existsAlways });
    expect(found.cmd).toContain('bash.exe');

    const notFound = resolveShell({ platform: 'win32', shellSetting: 'git-bash', execFileSync: nothingPresent(), existsSync: existsNever });
    expect(notFound.cmd).toBe('bash');
  });
});

// ---- fake spawn for runShell tests (no real process ever spawned) ----

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killSignal: string | undefined;
  kill(signal?: string) {
    this.killed = true;
    this.killSignal = signal;
  }
}

describe('runShell', () => {
  it('exit 0 -> ok result with captured output', async () => {
    let child!: FakeChild;
    const spawnFn = (() => {
      child = new FakeChild();
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as any;

    const p = runShell('echo hi', '/tmp', { spawnFn, shell: { cmd: 'bash', argsFor: (s) => ['-lc', s] } });
    child.stdout.emit('data', Buffer.from('hi\n'));
    child.emit('close', 0);
    const r = await p;
    expect(r).toEqual({ exitCode: 0, timedOut: false, output: 'hi\n' });
  });

  it('non-zero exit -> exitCode preserved, not timed out', async () => {
    let child!: FakeChild;
    const spawnFn = (() => {
      child = new FakeChild();
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as any;

    const p = runShell('exit 1', '/tmp', { spawnFn, shell: { cmd: 'bash', argsFor: (s) => ['-lc', s] } });
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 1);
    const r = await p;
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(false);
    expect(r.output).toBe('boom');
  });

  it('timeout -> SIGKILL sent, timedOut true, exitCode null', async () => {
    let child!: FakeChild;
    const spawnFn = (() => {
      child = new FakeChild();
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as any;

    const p = runShell('sleep 999', '/tmp', {
      spawnFn,
      timeoutMs: 10,
      shell: { cmd: 'bash', argsFor: (s) => ['-lc', s] },
    });
    // never emit 'close' — simulates a hung child.
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe('SIGKILL');
  });

  it('spawn error event -> exitCode null, output falls back to the error', async () => {
    let child!: FakeChild;
    const spawnFn = (() => {
      child = new FakeChild();
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as any;

    const p = runShell('nope', '/tmp', { spawnFn, shell: { cmd: 'bash', argsFor: (s) => ['-lc', s] } });
    child.emit('error', new Error('ENOENT'));
    const r = await p;
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain('ENOENT');
  });

  it('onData is invoked with each raw chunk (used to tee to a log file)', async () => {
    let child!: FakeChild;
    const spawnFn = (() => {
      child = new FakeChild();
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as any;
    const seen: string[] = [];

    const p = runShell('echo hi', '/tmp', {
      spawnFn,
      shell: { cmd: 'bash', argsFor: (s) => ['-lc', s] },
      onData: (d) => seen.push(d.toString('utf8')),
    });
    child.stdout.emit('data', Buffer.from('hi\n'));
    child.emit('close', 0);
    await p;
    expect(seen).toEqual(['hi\n']);
  });

  it('defaults to resolveShell() (auto) when no shell is passed', async () => {
    let capturedCmd: string | undefined;
    let child!: FakeChild;
    const spawnFn = ((cmd: string) => {
      capturedCmd = cmd;
      child = new FakeChild();
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as any;

    const p = runShell('true', '/tmp', { spawnFn });
    child.emit('close', 0);
    await p;
    // On this test host (linux/mac CI), auto resolves to bash regardless of platform quirks.
    expect(capturedCmd).toBe('bash');
  });
});
