import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ResolvedShell {
  cmd: string;
  argsFor(script: string): string[];
}

type ExecFileSyncFn = (cmd: string, args: string[], opts?: Record<string, unknown>) => Buffer | string;

export interface ResolveShellOptions {
  /** Injectable for tests — defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** The `shell` setting's raw value (defaults to 'auto'). */
  shellSetting?: string;
  /** Injectable for tests — defaults to node:fs existsSync. */
  existsSync?: (p: string) => boolean;
  /** Injectable for tests — defaults to node:child_process execFileSync. */
  execFileSync?: ExecFileSyncFn;
}

const bash: ResolvedShell = { cmd: 'bash', argsFor: (script) => ['-lc', script] };
const powershell: ResolvedShell = { cmd: 'powershell', argsFor: (script) => ['-NoProfile', '-Command', script] };
const cmdShell: ResolvedShell = { cmd: 'cmd', argsFor: (script) => ['/c', script] };
const gitBash = (bashPath: string): ResolvedShell => ({ cmd: bashPath, argsFor: (script) => ['-lc', script] });

function commandOnPath(name: string, execFileSyncFn: ExecFileSyncFn): boolean {
  try {
    execFileSyncFn('where', [name], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** Git-for-Windows ships bash at <git-exec-path>/../../../bin/bash.exe; fall back to PATH. */
function locateGitBash(existsSyncFn: (p: string) => boolean, execFileSyncFn: ExecFileSyncFn): string | null {
  try {
    const execPath = execFileSyncFn('git', ['--exec-path'], { encoding: 'utf8' }).toString().trim();
    if (execPath) {
      const candidate = path.join(execPath, '..', '..', '..', 'bin', 'bash.exe');
      if (existsSyncFn(candidate)) return candidate;
    }
  } catch {
    /* git not installed or --exec-path failed */
  }
  return commandOnPath('bash', execFileSyncFn) ? 'bash' : null;
}

/**
 * Pick the shell to run verify/setup/deploy steps with. Linux/macOS always resolve to
 * `bash -lc` (byte-identical to today's hard-wired spawn), regardless of the `shell`
 * setting — 'auto' is the only thing that varies by platform. On win32, 'auto' prefers
 * Git-Bash (so unix-flavored steps keep working), then PowerShell, then cmd. Explicit
 * settings (bash/powershell/cmd/git-bash) always force that shell, on any platform —
 * useful for testing the Windows paths from Linux.
 */
export function resolveShell(opts: ResolveShellOptions = {}): ResolvedShell {
  const platform = opts.platform ?? process.platform;
  const setting = (opts.shellSetting ?? 'auto').trim() || 'auto';
  const existsSyncFn = opts.existsSync ?? existsSync;
  const execFileSyncFn = opts.execFileSync ?? execFileSync;

  if (setting === 'bash') return bash;
  if (setting === 'powershell') return powershell;
  if (setting === 'cmd') return cmdShell;
  if (setting === 'git-bash') {
    const found = locateGitBash(existsSyncFn, execFileSyncFn);
    return gitBash(found ?? 'bash');
  }

  // auto
  if (platform !== 'win32') return bash;
  const found = locateGitBash(existsSyncFn, execFileSyncFn);
  if (found) return gitBash(found);
  return commandOnPath('powershell', execFileSyncFn) ? powershell : cmdShell;
}

type SpawnFn = typeof spawn;

export interface RunShellOptions {
  timeoutMs?: number;
  /** Extra env vars merged over process.env (e.g. deploy_cmd's LOOP_DEPLOY_SHA). */
  env?: Record<string, string>;
  /** Called with each raw stdout/stderr chunk as it arrives (e.g. to tee to a log file). */
  onData?: (chunk: Buffer) => void;
  /** Pre-resolved shell; defaults to resolveShell() (platform auto-detect). */
  shell?: ResolvedShell;
  /** Injectable for tests — defaults to node:child_process spawn. */
  spawnFn?: SpawnFn;
}

export interface RunShellResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** The single spawn helper behind verify steps, task setup, and deploy_cmd. Captures
 * (and tails to 20k chars) combined stdout+stderr; SIGKILLs the child on timeout. */
export function runShell(script: string, cwd: string, opts: RunShellOptions = {}): Promise<RunShellResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const spawnFn = opts.spawnFn ?? spawn;
  const shell = opts.shell ?? resolveShell();
  return new Promise((resolve) => {
    const child = spawnFn(shell.cmd, shell.argsFor(script), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let out = '';
    const cap = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 20_000) out = out.slice(-20_000);
      opts.onData?.(d);
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exitCode: null, timedOut: true, output: out });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false, output: out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, output: out || String(err) });
    });
  });
}
