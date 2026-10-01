import fs from 'node:fs';
import path from 'node:path';
import { realHostExec, sshArgs, type HostExec } from './hosts.js';
import { parseProbe, type CheckLine } from './check.js';
import { linuxSpecsScript, parseSpecs, specsSummary, windowsSpecsScript, type MachineSpecs } from './specs.js';
import { isWorkRootFor, type Machine, type MachineShell } from './machines.js';

export type { Machine } from './machines.js';

/**
 * Remote runner for 機台: one ssh call per command, the command wrapped so that it runs in the
 * right interpreter, under a hard timeout the box itself enforces, with UTF-8 output both ways.
 * No Docker and no rsync of worktrees: with transport 'gitea' the box fetches the task branch into
 * its own clone under <work_root>/repos/<repo> (Loop's clone — never a person's checkout; build
 * outputs in it survive between runs), with 'copy' the engine sends the tree there. Nothing in
 * here throws for a failing box: every result says in words what went wrong.
 *
 * Linux:   cd '<cwd>' && timeout --kill-after=10 <sec> bash -lc '<cmd>' 2>&1
 *          (TERM at the deadline → exit 124; KILL 10 s later for whatever ignored it → 137)
 * Windows: powershell -NoProfile -NonInteractive -EncodedCommand <script> where the script sets
 *          UTF-8 output, Set-Location '<cwd>', Start-Process of the check's interpreter with
 *          -PassThru, WaitForExit(<ms>) → taskkill /T → exit 124, prints the out/err logs and
 *          exits with the child's code. The interpreter is `powershell -EncodedCommand <cmd>`
 *          (shell auto/powershell) or `cmd /c "chcp 65001>nul && cd /d <cwd> && <cmd> 2>&1"`
 *          (shell cmd). Both layers are base64 (-EncodedCommand) so the box's login shell —
 *          cmd.exe or PowerShell, whichever sshd hands the command to — never re-parses `$`,
 *          quotes or `&&`.
 */

export type RemoteOs = 'linux' | 'windows';
export type RemoteShell = 'bash' | 'powershell' | 'cmd';

export interface RemoteRun {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** merged stdout+stderr, tail-capped */
  output: string;
  ms: number;
}

export interface RemoteStep {
  ok: boolean;
  out: string;
}

/** the remote wrapper's own "took too long" code (GNU timeout's, and what the Windows wrapper exits with) */
export const REMOTE_TIMEOUT_EXIT = 124;
/** ssh could not connect / authenticate at all */
export const SSH_FAILED_EXIT = 255;
/** what a caller gets back of a chatty command: the last 20k, like runShell */
const OUTPUT_TAIL = 20_000;
/** extra time the ssh client gets beyond the remote wrapper's own timeout */
const SSH_GRACE_MS = 30_000;
/** Linux: TERM at the deadline, KILL this many seconds later for whatever ignored it */
const KILL_AFTER_SEC = 10;
/** a Windows command is base64 twice over (inner + outer script) inside a 32k command line */
const MAX_WINDOWS_COMMAND = 4000;
const MAX_LINUX_COMMAND = 20_000;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
/** an absolute path on the box, with nothing a shell or git could misread */
const LINUX_PATH_RE = /^\/[A-Za-z0-9_./-]*$/;
const WINDOWS_PATH_RE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]*$/;
/** git on the box must never sit on a credential prompt (terminal or Credential Manager's dialog) */
const GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

// ---- what the box is ----------------------------------------------------------------------------

export function osOf(m: Pick<Machine, 'os'>): RemoteOs | null {
  return m.os === 'linux' || m.os === 'windows' ? m.os : null;
}

/** The interpreter check commands run in: bash on Linux; PowerShell on Windows unless the row says cmd. */
export function shellOf(m: Pick<Machine, 'os' | 'shell'>): RemoteShell {
  if (osOf(m) === 'windows') return m.shell === 'cmd' ? 'cmd' : 'powershell';
  return 'bash';
}

/** For paths before the health check has said what the box is: a `C:\` work root means Windows. */
function osForPaths(m: Pick<Machine, 'os' | 'work_root'>): RemoteOs {
  return osOf(m) ?? (/^[A-Za-z]:\\/.test(m.work_root) ? 'windows' : 'linux');
}

function unknownOs(m: Pick<Machine, 'name'>): string {
  return `還不知道 ${m.name} 的作業系統（os=auto）：先執行 loop machine check ${m.name}，或在機台頁按「檢查」`;
}

// ---- paths & quoting ----------------------------------------------------------------------------

/** a repo / dataset name as a directory name on the box: nothing a path or a shell could trip on */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_').slice(0, 100) || 'default';
}

export function joinFor(os: RemoteOs, ...parts: string[]): string {
  return os === 'windows' ? path.win32.join(...parts) : path.posix.join(...parts);
}

/** <work_root>/repos/<repo> — posix or backslash join by OS. */
export function repoDirOn(m: Pick<Machine, 'os' | 'work_root'>, repoName: string): string {
  return joinFor(osForPaths(m), m.work_root, 'repos', safeName(repoName));
}

/** <work_root>/datasets/<name> */
export function datasetDirOn(m: Pick<Machine, 'os' | 'work_root'>, name: string): string {
  return joinFor(osForPaths(m), m.work_root, 'datasets', safeName(name));
}

/**
 * One literal argument for that shell: bash single quotes, PowerShell single quotes (`'` doubled),
 * cmd caret-escapes (for an unquoted cmd context). 'linux' means bash, 'windows' PowerShell.
 */
export function quoteFor(kind: RemoteOs | RemoteShell, s: string): string {
  const shell: RemoteShell = kind === 'linux' ? 'bash' : kind === 'windows' ? 'powershell' : kind;
  if (shell === 'bash') return `'${s.replace(/'/g, `'\\''`)}'`;
  if (shell === 'powershell') return `'${s.replace(/'/g, "''")}'`;
  return s.replace(/[&|<>^()"]/g, '^$&');
}

/** powershell -EncodedCommand takes the script as base64 of UTF-16LE */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function decodePowerShell(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf16le');
}

function isRemotePath(os: RemoteOs, p: string): boolean {
  return (os === 'windows' ? WINDOWS_PATH_RE : LINUX_PATH_RE).test(p) && !p.includes('..');
}

function isRemoteUrl(u: string): boolean {
  return (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"\\]+$/.test(u) || /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s'"\\]+$/.test(u)) && !u.startsWith('-');
}

function tail(s: string, n = OUTPUT_TAIL): string {
  return s.length > n ? s.slice(-n) : s;
}

// ---- the wrapper ------------------------------------------------------------------------------

function envLines(shell: RemoteShell, env: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_NAME_RE.test(k)) continue;
    if (shell === 'bash') out.push(`export ${k}=${quoteFor('bash', v)}`);
    else if (shell === 'powershell') out.push(`$env:${k}=${quoteFor('powershell', v)}`);
    else out.push(`set "${k}=${v.replace(/["\r\n]/g, '')}"`);
  }
  return out;
}

/** What the check's own PowerShell runs: UTF-8 out, env, the command, then the exit code a native command left. */
function innerPowerShell(cmd: string, env: Record<string, string> | undefined): string {
  return [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$OutputEncoding=[Text.Encoding]::UTF8',
    "$ErrorActionPreference='Continue'",
    ...envLines('powershell', env),
    cmd,
    '$ok=$?',
    'if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }',
    'if (-not $ok) { exit 1 }',
    'exit 0',
  ].join('\n');
}

/** The spec's cmd form, run as the child of the timeout wrapper. */
function innerCmd(cwd: string | null, cmd: string, env: Record<string, string> | undefined): string {
  const parts = ['chcp 65001>nul', ...envLines('cmd', env), ...(cwd ? [`cd /d ${cwd}`] : []), `${cmd} 2>&1`];
  return `/c "${parts.join(' && ')}"`;
}

/**
 * The one string handed to ssh. Linux: cd + GNU timeout + a login bash. Windows: a PowerShell
 * script (base64) that starts the check's interpreter as a child it can wait on and kill.
 */
export function wrapCommand(m: Pick<Machine, 'os' | 'shell' | 'work_root'>, cwd: string | null, cmd: string, timeoutSec: number, env?: Record<string, string>): string {
  const sec = Math.max(1, Math.ceil(timeoutSec));
  if (osForPaths(m) === 'linux') {
    const script = [...envLines('bash', env), cmd].join('; ');
    return `${cwd ? `cd ${quoteFor('bash', cwd)} && ` : ''}timeout --kill-after=${KILL_AFTER_SEC} ${sec} bash -lc ${quoteFor('bash', script)} 2>&1`;
  }
  const q = (s: string) => quoteFor('powershell', s);
  const child =
    shellOf({ os: 'windows', shell: m.shell }) === 'cmd'
      ? { exe: 'cmd', args: [innerCmd(cwd, cmd, env)] }
      : { exe: 'powershell', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(innerPowerShell(cmd, env))] };
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    "$ErrorActionPreference='Stop'",
    ...(cwd ? [`Set-Location -LiteralPath ${q(cwd)}`] : []),
    '$o=[IO.Path]::GetTempFileName(); $e=[IO.Path]::GetTempFileName()',
    `$p=Start-Process -FilePath ${q(child.exe)} -ArgumentList ${child.args.map(q).join(',')}${cwd ? ` -WorkingDirectory ${q(cwd)}` : ''} -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError $e`,
    '$null=$p.Handle',
    `if (!$p.WaitForExit(${sec * 1000})) { taskkill /T /F /PID $p.Id 2>$null | Out-Null; $p.WaitForExit(); $c=${REMOTE_TIMEOUT_EXIT} } else { $c=$p.ExitCode }`,
    'Get-Content -LiteralPath $o -Encoding UTF8 -Raw',
    'Get-Content -LiteralPath $e -Encoding UTF8 -Raw',
    'Remove-Item -LiteralPath $o,$e -Force -ErrorAction SilentlyContinue',
    'if ($null -eq $c) { $c=1 }',
    'exit $c',
  ].join('\n');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
}

// ---- running one command ------------------------------------------------------------------------

export interface RemoteRequest {
  /** absolute directory on the box; null = wherever ssh lands (the account's home) */
  cwd: string | null;
  command: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

const failedRun = (output: string, exitCode: number | null = null, ms = 0): RemoteRun => ({ ok: false, exitCode, timedOut: false, output, ms });

/**
 * Run one command on the box. Never throws: ssh not installed, the box unreachable (exit 255 →
 * 「連不上」), the remote timeout (124, or KILL's 137 at the deadline) and the command's own
 * failure all come back as a RemoteRun.
 */
export async function runRemote(m: Machine, exec: HostExec, req: RemoteRequest): Promise<RemoteRun> {
  const started = Date.now();
  const os = osOf(m);
  if (!os) return failedRun(unknownOs(m));
  const command = req.command.trim();
  if (!command) return failedRun('command 不可為空');
  const max = os === 'windows' ? MAX_WINDOWS_COMMAND : MAX_LINUX_COMMAND;
  if (command.length > max) return failedRun(`指令太長（${os === 'windows' ? 'Windows 機台' : ''}上限 ${max} 字）；長的腳本請先寫成檔案再執行`);
  for (const k of Object.keys(req.env ?? {})) if (!ENV_NAME_RE.test(k)) return failedRun(`環境變數名稱不合法：${k}`);
  if (req.cwd !== null && !isRemotePath(os, req.cwd)) return failedRun(`工作目錄不合法：${req.cwd}`);
  const timeoutMs = Math.max(1000, Math.round(req.timeoutMs));
  const sec = Math.ceil(timeoutMs / 1000);
  const wrapped = wrapCommand(m, req.cwd, command, sec, req.env);
  let r: { code: number | null; out: string };
  try {
    r = await exec('ssh', [...sshArgs(m), m.ssh_target, wrapped], timeoutMs + SSH_GRACE_MS);
  } catch (err) {
    r = { code: 1, out: (err as Error).message };
  }
  const ms = Date.now() - started;
  const output = tail(r.out ?? '');
  if (r.code === null) return failedRun('引擎主機找不到 ssh 指令：請安裝 openssh-client', null, ms);
  if (r.code === SSH_FAILED_EXIT) return failedRun(`連不上 ${m.name}（ssh ${m.ssh_target}）：${output.slice(-300).trim() || 'ssh exit 255'}`, SSH_FAILED_EXIT, ms);
  const timedOut = r.code === REMOTE_TIMEOUT_EXIT || (r.code === 137 && ms >= timeoutMs);
  if (timedOut) return { ok: false, exitCode: r.code, timedOut: true, output: `${output}\n（逾時：超過 ${sec} 秒，已在 ${m.name} 上中止）`.trim(), ms };
  return { ok: r.code === 0, exitCode: r.code, timedOut: false, output, ms };
}

// ---- code on the box --------------------------------------------------------------------------

export interface CheckoutRequest {
  repoName: string;
  remoteUrl: string;
  sha: string;
  branch: string;
  transport: 'gitea' | 'copy';
  /** transport 'copy': the local tree (a worktree at `sha`) to send */
  localTree?: string;
}

/** Loop's own git plumbing runs in bash / PowerShell whatever syntax the checks use. */
function plumbing(m: Machine, os: RemoteOs): Machine {
  return { ...m, os, shell: 'auto' };
}

/** scp flags: legacy protocol (the remote path goes through its shell), never a prompt */
function scpArgs(m: Pick<Machine, 'ssh_port'>): string[] {
  return ['-O', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(m.ssh_port ? ['-P', String(m.ssh_port)] : [])];
}

/** `C:\loop\x` → `"C:/loop/x"` — scp's remote side is happier with forward slashes */
function scpPath(os: RemoteOs, p: string): string {
  return os === 'windows' ? `"${p.replace(/\\/g, '/')}"` : p;
}

async function existsOn(m: Machine, exec: HostExec, os: RemoteOs, dir: string): Promise<{ exists: boolean } | { error: string }> {
  const gitDir = joinFor(os, dir, '.git');
  const r = await runRemote(m, exec, {
    cwd: null,
    command: os === 'linux' ? `test -d ${quoteFor('bash', gitDir)}` : `if (Test-Path -LiteralPath ${quoteFor('powershell', gitDir)}) { exit 0 } else { exit 1 }`,
    timeoutMs: 30_000,
  });
  if (r.exitCode === 0) return { exists: true };
  if (r.exitCode === 1 && !r.timedOut) return { exists: false };
  return { error: r.output };
}

/**
 * Put the task's code at `sha` in the box's clone of the repo (transport gitea: the box fetches
 * the branch from Gitea with its own credentials; copy: the engine sends `localTree`). The clone
 * is Loop's: `checkout --force` may move it freely, but it is never cleaned, so build outputs
 * survive between runs.
 */
export async function ensureCheckout(m: Machine, exec: HostExec, req: CheckoutRequest): Promise<RemoteStep & { dir: string }> {
  const dir = repoDirOn(m, req.repoName);
  const os = osOf(m);
  if (!os) return { ok: false, out: unknownOs(m), dir };
  if (req.transport === 'copy') return copyTree(m, exec, os, dir, req.localTree);
  if (!SHA_RE.test(req.sha)) return { ok: false, out: `sha 不合法：${req.sha}`, dir };
  if (!REF_RE.test(req.branch) || req.branch.includes('..')) return { ok: false, out: `分支名不合法：${req.branch}`, dir };
  if (!isRemoteUrl(req.remoteUrl)) return { ok: false, out: `remote 網址不合法：${req.remoteUrl}`, dir };
  const pm = plumbing(m, os);
  const q = (s: string) => quoteFor(shellOf(pm), s);
  const outs: string[] = [];
  const step = async (command: string, timeoutMs: number): Promise<RemoteRun> => {
    const r = await runRemote(pm, exec, { cwd: null, command, timeoutMs, env: GIT_ENV });
    if (r.output.trim()) outs.push(r.output.trim());
    return r;
  };
  const ex = await existsOn(pm, exec, os, dir);
  if ('error' in ex) return { ok: false, out: ex.error, dir };
  if (!ex.exists) {
    const r = await step(`git clone --no-checkout ${q(req.remoteUrl)} ${q(dir)}`, 15 * 60_000);
    if (!r.ok) return { ok: false, out: `在 ${m.name} 上 clone 失敗：${tail(outs.join('\n'))}`, dir };
  }
  const f = await step(`git -C ${q(dir)} fetch --prune origin ${q(req.branch)}`, 10 * 60_000);
  if (!f.ok) return { ok: false, out: `在 ${m.name} 上抓分支 ${req.branch} 失敗（分支要先推到 Gitea）：${tail(outs.join('\n'))}`, dir };
  const c = await step(`git -C ${q(dir)} checkout --detach --force ${req.sha}`, 5 * 60_000);
  if (!c.ok) return { ok: false, out: `在 ${m.name} 上切到 ${req.sha.slice(0, 7)} 失敗：${tail(outs.join('\n'))}`, dir };
  return { ok: true, out: tail(outs.join('\n')), dir };
}

async function copyTree(m: Machine, exec: HostExec, os: RemoteOs, dir: string, localTree: string | undefined): Promise<RemoteStep & { dir: string }> {
  if (!localTree || !fs.existsSync(localTree)) return { ok: false, out: `要複製到 ${m.name} 的目錄不存在：${localTree ?? '（沒有給）'}`, dir };
  const src = localTree.replace(/\/+$/, '');
  if (os === 'linux') {
    // .gitignore'd files (build outputs) are neither sent nor deleted: incremental builds survive
    const r = await exec(
      'rsync',
      ['-a', '--delete', '--filter=:- .gitignore', `--rsync-path=mkdir -p ${dir} && rsync`, '-e', ['ssh', ...sshArgs(m)].join(' '), `${src}/`, `${m.ssh_target}:${dir}/`],
      10 * 60_000,
    );
    if (r.code === null) return { ok: false, out: '引擎主機找不到 rsync：請安裝 rsync', dir };
    return { ok: r.code === 0, out: r.code === 0 ? r.out : `複製到 ${m.name} 失敗：${tail(r.out, 2000)}`, dir };
  }
  // scp -r has no --delete: clear the old copy, make sure the parent exists, then send
  const q = (s: string) => quoteFor('powershell', s);
  const prep = await runRemote(plumbing(m, os), exec, {
    cwd: null,
    command: `New-Item -ItemType Directory -Force -Path ${q(path.win32.dirname(dir))} | Out-Null; if (Test-Path -LiteralPath ${q(dir)}) { Remove-Item -LiteralPath ${q(dir)} -Recurse -Force }`,
    timeoutMs: 120_000,
  });
  if (!prep.ok) return { ok: false, out: `在 ${m.name} 上準備目錄失敗：${prep.output}`, dir };
  const r = await exec('scp', [...scpArgs(m), '-r', src, `${m.ssh_target}:${scpPath(os, dir)}`], 15 * 60_000);
  if (r.code === null) return { ok: false, out: '引擎主機找不到 scp：請安裝 openssh-client', dir };
  return { ok: r.code === 0, out: r.code === 0 ? r.out : `複製到 ${m.name} 失敗：${tail(r.out, 2000)}`, dir };
}

/** Bring files/directories from the box into `localDir` (each lands as <localDir>/<basename>). */
export async function pullBack(m: Machine, exec: HostExec, remotePaths: string[], localDir: string): Promise<RemoteStep> {
  const os = osOf(m);
  if (!os) return { ok: false, out: unknownOs(m) };
  if (!remotePaths.length) return { ok: true, out: '' };
  const bad = remotePaths.find((p) => !isRemotePath(os, p));
  if (bad) return { ok: false, out: `遠端路徑不合法：${bad}` };
  fs.mkdirSync(localDir, { recursive: true });
  const dest = `${localDir.replace(/\/+$/, '')}/`;
  const r =
    os === 'linux'
      ? await exec('rsync', ['-a', '-e', ['ssh', ...sshArgs(m)].join(' '), ...remotePaths.map((p) => `${m.ssh_target}:${p}`), dest], 10 * 60_000)
      : await exec('scp', [...scpArgs(m), '-r', ...remotePaths.map((p) => `${m.ssh_target}:${scpPath(os, p)}`), dest], 10 * 60_000);
  if (r.code === null) return { ok: false, out: `引擎主機找不到 ${os === 'linux' ? 'rsync：請安裝 rsync' : 'scp：請安裝 openssh-client'}` };
  return { ok: r.code === 0, out: r.code === 0 ? r.out : `從 ${m.name} 收回失敗：${tail(r.out, 2000)}` };
}

/** Clone or refresh a 圖資 repo under <work_root>/datasets/<name>; `git lfs pull` when .gitattributes mentions lfs. */
export async function ensureDataset(m: Machine, exec: HostExec, ds: { name: string; remoteUrl: string }): Promise<RemoteStep & { dir: string }> {
  const dir = datasetDirOn(m, ds.name);
  const os = osOf(m);
  if (!os) return { ok: false, out: unknownOs(m), dir };
  if (!isRemoteUrl(ds.remoteUrl)) return { ok: false, out: `圖資網址不合法：${ds.remoteUrl}`, dir };
  const pm = plumbing(m, os);
  const q = (s: string) => quoteFor(shellOf(pm), s);
  const outs: string[] = [];
  const step = async (command: string, timeoutMs: number): Promise<RemoteRun> => {
    const r = await runRemote(pm, exec, { cwd: null, command, timeoutMs, env: GIT_ENV });
    if (r.output.trim()) outs.push(r.output.trim());
    return r;
  };
  const ex = await existsOn(pm, exec, os, dir);
  if ('error' in ex) return { ok: false, out: ex.error, dir };
  if (!ex.exists) {
    const r = await step(`git clone ${q(ds.remoteUrl)} ${q(dir)}`, 30 * 60_000);
    if (!r.ok) return { ok: false, out: `在 ${m.name} 上抓圖資 ${ds.name} 失敗：${tail(outs.join('\n'))}`, dir };
  } else {
    const f = await step(`git -C ${q(dir)} fetch --prune origin`, 15 * 60_000);
    if (!f.ok) return { ok: false, out: `在 ${m.name} 上更新圖資 ${ds.name} 失敗：${tail(outs.join('\n'))}`, dir };
    const c = await step(`git -C ${q(dir)} checkout --detach --force origin/HEAD`, 10 * 60_000);
    if (!c.ok) return { ok: false, out: `在 ${m.name} 上更新圖資 ${ds.name} 失敗：${tail(outs.join('\n'))}`, dir };
  }
  const lfs = await step(`git -C ${q(dir)} grep -q -e lfs -- .gitattributes`, 30_000);
  if (lfs.exitCode === 0) {
    const p = await step(`git -C ${q(dir)} lfs pull`, 30 * 60_000);
    if (!p.ok) return { ok: false, out: `在 ${m.name} 上 git lfs pull 失敗（要先裝 git-lfs）：${tail(outs.join('\n'))}`, dir };
  }
  return { ok: true, out: tail(outs.join('\n')), dir };
}

// ---- one run per machine at a time -------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

/** Serialise everything that touches one box (two tasks or a 試跑 never fight over the same clone). */
export async function withMachineLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  const tail = prev.then(() => mine);
  locks.set(name, tail);
  await prev;
  try {
    return await fn();
  } finally {
    done();
    if (locks.get(name) === tail) locks.delete(name);
  }
}

export function machineBusy(name: string): boolean {
  return locks.has(name);
}

// ---- health check (Screen 5) ------------------------------------------------------------------

export interface MachineCheckOptions {
  /** repos whose checks run on this box; the first one is the Gitea probe */
  repos?: Array<{ name: string; remoteUrl: string }>;
  datasets?: Array<{ name: string }>;
  now?: () => number;
}

export interface DetectedFromCheck {
  /** 規格: OS, CPU, RAM, disk, GPU, CUDA, tools (null = the probe did not get that far) */
  specs: MachineSpecs | null;
  os: RemoteOs | null;
  /** what the wrapper runs the checks in: bash / powershell */
  shell: MachineShell | null;
  /** gitea when the box could read the first repo's remote itself, copy otherwise; null = no repo to try */
  transport: 'gitea' | 'copy' | null;
}

export interface MachineCheck {
  lines: CheckLine[];
  ok: boolean;
  detected: DetectedFromCheck;
}

function sshFailure(m: Machine, out: string): string {
  const why = out.trim().split('\n').filter(Boolean).pop()?.slice(-200) || 'ssh exit 255';
  const port = m.ssh_port ? ` -p ${m.ssh_port}` : '';
  const hostKey = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(out) ? '；host key 還沒接受：先在 Spark 上手動 ssh 一次' : '';
  return `無法以金鑰登入 ${m.ssh_target}：${why}。在 Spark 上以引擎的使用者執行 ssh-copy-id${port} ${m.ssh_target}；Windows 請把公鑰放到 C:\\ProgramData\\ssh\\administrators_authorized_keys${hostKey}`;
}

function windowsName(version: string): string {
  const [major, , build] = version.split('.').map(Number);
  if (major === 10 && (build ?? 0) >= 22000) return 'Windows 11';
  if (major === 10) return 'Windows 10';
  return `Windows ${version}`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} 小時前`;
  return `${Math.round(s / 86400)} 天前`;
}

function gb(kb: number): string {
  const g = kb / 1024 / 1024;
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
}

function urlOrigin(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}`;
  } catch {
    return u.replace(/:.*$/, '');
  }
}

function linuxProbe(m: Machine, repos: Array<{ name: string }>, datasets: Array<{ name: string }>): string {
  const q = (s: string) => quoteFor('bash', s);
  const root = q(m.work_root);
  const parts = [
    'echo "== git"; (git --version 2>&1 || echo "git: not found")',
    `echo "== work"; (mkdir -p ${root} && touch ${q(`${m.work_root}/.loop-probe`)} && rm -f ${q(`${m.work_root}/.loop-probe`)} && echo "work: writable" && df -Pk ${root} | tail -n 1 | awk '{print "free_kb:" $4}') 2>&1 || echo "work: not writable"`,
    'echo "== python"; (python3 --version 2>&1 || python --version 2>&1 || echo "python: not found")',
    'echo "== gpu"; (nvidia-smi --query-gpu=name --format=csv,noheader 2>&1 || echo "gpu: none")',
    `echo "== repos"${repos.map((r) => `; echo "repo ${safeName(r.name)} $(git -C ${q(repoDirOn(m, r.name))} rev-parse --short HEAD 2>/dev/null || echo missing) $(git -C ${q(repoDirOn(m, r.name))} log -1 --format=%ct 2>/dev/null)"`).join('')}`,
    `echo "== datasets"${datasets.map((d) => `; echo "dataset ${safeName(d.name)} $(test -d ${q(`${datasetDirOn(m, d.name)}/.git`)} && echo present || echo missing)"`).join('')}`,
    linuxSpecsScript(m.work_root),
  ];
  return parts.join('; ');
}

function windowsProbe(m: Machine, repos: Array<{ name: string }>, datasets: Array<{ name: string }>): string {
  const q = (s: string) => quoteFor('powershell', s);
  const root = m.work_root;
  const probe = `${root}\\.loop-probe`;
  return [
    '"== git"',
    'try { git --version 2>&1 } catch { "git: not found" }',
    '"== work"',
    `try { New-Item -ItemType Directory -Force -Path ${q(root)} | Out-Null; [IO.File]::WriteAllText(${q(probe)}, 'x'); Remove-Item -LiteralPath ${q(probe)} -Force; "work: writable"; "free_kb:" + [math]::Floor((Get-PSDrive -Name ${q(root.slice(0, 1))}).Free / 1024) } catch { "work: not writable " + $_ }`,
    '"== python"',
    'try { python --version 2>&1 } catch { "python: not found" }',
    '"== gpu"',
    'try { nvidia-smi --query-gpu=name --format=csv,noheader 2>&1 } catch { "gpu: none" }',
    '"== repos"',
    ...repos.map((r) => {
      const dir = q(repoDirOn(m, r.name));
      const name = safeName(r.name);
      return `$s = git -C ${dir} rev-parse --short HEAD 2>$null; $t = git -C ${dir} log -1 --format=%ct 2>$null; if ($s) { "repo ${name} $s $t" } else { "repo ${name} missing" }`;
    }),
    '"== datasets"',
    ...datasets.map((d) => `if (Test-Path -LiteralPath ${q(`${datasetDirOn(m, d.name)}\\.git`)}) { "dataset ${safeName(d.name)} present" } else { "dataset ${safeName(d.name)} missing" }`),
    windowsSpecsScript(root),
  ].join('\n');
}

/**
 * Screen 5's list: login + OS, git, Gitea readable, work root writable + free space, python, GPU,
 * the repo clones and dataset caches. Also says what it found out (os / shell / transport) so the
 * caller can fill in a row that still says 'auto'. Every failure line names the fix.
 */
export async function checkMachine(m: Machine, exec: HostExec = realHostExec, opts: MachineCheckOptions = {}): Promise<MachineCheck> {
  const lines: CheckLine[] = [];
  const detected: DetectedFromCheck = { specs: null, os: null, shell: null, transport: null };
  const done = (): MachineCheck => ({ lines, ok: lines.every((l) => l.ok !== false), detected });
  const now = opts.now ?? Date.now;
  const repos = opts.repos ?? [];
  const datasets = opts.datasets ?? [];

  // 1. login, and what answers: `uname -s` says Linux (or MINGW/MSYS = Git Bash on Windows); a cmd
  //    or PowerShell login shell fails it, so the PowerShell wrapper itself is the Windows probe.
  let probe: { code: number | null; out: string };
  try {
    probe = await exec('ssh', [...sshArgs(m), m.ssh_target, 'uname -s'], 20_000);
  } catch (err) {
    probe = { code: 1, out: (err as Error).message };
  }
  if (probe.code === null) {
    lines.push({ ok: false, label: 'SSH 登入', detail: '引擎主機找不到 ssh 指令：請安裝 openssh-client' });
    return done();
  }
  if (probe.code === SSH_FAILED_EXIT) {
    lines.push({ ok: false, label: 'SSH 登入', detail: sshFailure(m, probe.out) });
    return done();
  }
  const uname = (probe.out ?? '').trim().split('\n')[0]?.trim() ?? '';
  let os: RemoteOs | null = null;
  if (probe.code === 0 && /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|AIX)/.test(uname)) os = 'linux';
  else if (/^(MINGW|MSYS|CYGWIN)/i.test(uname)) os = 'windows';
  let win: { version: string; ps: string } | null = null;
  if (os !== 'linux') {
    const r = await runRemote(plumbing(m, 'windows'), exec, {
      cwd: null,
      command: 'Write-Output ("LOOP_WIN=" + [Environment]::OSVersion.Version.ToString()); Write-Output ("LOOP_PS=" + $PSVersionTable.PSVersion.ToString())',
      timeoutMs: 30_000,
    });
    const version = /LOOP_WIN=([\d.]+)/.exec(r.output)?.[1];
    if (r.ok && version) {
      os = 'windows';
      win = { version, ps: /LOOP_PS=(\d+\.\d+)/.exec(r.output)?.[1] ?? '?' };
    } else if (os === 'windows') {
      lines.push({ ok: false, label: 'SSH 登入', detail: `${m.ssh_target}：登入成功（${uname}），但 powershell 跑不起來：${r.output.slice(-300).trim()}` });
      return done();
    } else {
      const said = (probe.out || '').trim().slice(0, 120) || `exit ${probe.code}`;
      lines.push({ ok: false, label: 'SSH 登入', detail: `${m.ssh_target}：登入成功，但認不出作業系統（uname -s：${said}；powershell：${r.output.slice(-200).trim() || '沒有回應'}）` });
      return done();
    }
  }
  detected.os = os;
  detected.shell = os === 'linux' ? 'bash' : 'powershell';
  const where = os === 'linux' ? `${m.ssh_target}（${uname || 'Linux'}，bash）` : `${m.ssh_target}（${windowsName(win!.version)}，PowerShell ${win!.ps}）`;
  if (m.os !== 'auto' && m.os !== os) {
    lines.push({ ok: false, label: 'SSH 登入', detail: `${where}——但機台設定寫的是 ${m.os === 'windows' ? 'Windows' : 'Linux'}：請改機台設定（或改成 auto）` });
  } else {
    lines.push({ ok: true, label: 'SSH 登入', detail: where });
  }
  if (!isWorkRootFor(os, m.work_root)) {
    lines.push({ ok: false, label: '工作目錄', detail: `${m.work_root} 不是${os === 'windows' ? ' Windows（例：C:\\loop）' : ' Linux（例：/srv/loop）'}的路徑：請改機台設定` });
    return done();
  }

  // 2. one wrapped run answers git / work root / python / GPU / clones / caches
  const pm = plumbing(m, os);
  const q = (s: string) => quoteFor(shellOf(pm), s);
  const pr = await runRemote(pm, exec, { cwd: null, command: os === 'linux' ? linuxProbe(m, repos, datasets) : windowsProbe(m, repos, datasets), timeoutMs: 60_000 });
  if (!pr.output.includes('== git')) {
    lines.push({ ok: false, label: '檢查指令', detail: `在 ${m.name} 上跑不了檢查指令（${pr.timedOut ? '逾時' : `exit ${pr.exitCode ?? '?'}`}）：${pr.output.slice(-400).trim()}` });
    return done();
  }
  const p = parseProbe(pr.output);
  detected.specs = parseSpecs(p.specs);

  const gitVersion = /git version (\d+\.\d+(?:\.\d+)?)/.exec(p.git ?? '')?.[1] ?? null;
  lines.push(
    gitVersion
      ? { ok: true, label: 'git', detail: gitVersion }
      : {
          ok: false,
          label: 'git',
          detail:
            os === 'linux'
              ? `找不到 git：在 ${m.name} 上安裝（Ubuntu：sudo apt install git）`
              : `找不到 git：在 ${m.name} 上安裝 Git for Windows（安裝時勾選加入 PATH），並登入 Gitea 一次讓 Credential Manager 記住`,
        },
  );

  const first = repos[0];
  if (!gitVersion) {
    lines.push({ ok: null, label: 'Gitea', detail: '略過（沒有 git）' });
  } else if (!first) {
    lines.push({ ok: null, label: 'Gitea', detail: '沒有 repo 用到這台機台，略過（匯入 repo、在檢查裡選這台之後再檢查一次）' });
  } else {
    const ls = await runRemote(pm, exec, { cwd: null, command: `git ls-remote ${q(first.remoteUrl)} HEAD`, timeoutMs: 25_000, env: GIT_ENV });
    const origin = urlOrigin(first.remoteUrl);
    if (ls.ok) {
      detected.transport = 'gitea';
      lines.push({ ok: true, label: 'Gitea', detail: `能讀 ${origin}（已存認證）` });
    } else {
      detected.transport = 'copy';
      const why = ls.output.trim().split('\n').filter(Boolean).pop()?.slice(0, 160) || `exit ${ls.exitCode ?? '?'}`;
      const fix =
        os === 'linux'
          ? `在 ${m.name} 上 git config --global credential.helper store，再手動 git ls-remote ${first.remoteUrl} 一次輸入帳號與 token`
          : `在 ${m.name} 上手動 git ls-remote ${first.remoteUrl} 一次，讓 Git Credential Manager 記住登入`;
      lines.push({
        ok: m.transport === 'gitea' ? false : null,
        label: 'Gitea',
        detail: `${m.name} 讀不到 ${origin}（${why}）：改用 copy（引擎把程式碼複製過去，較慢）。要讓機台自己抓：${fix}`,
      });
    }
  }

  const work = p.work ?? '';
  const freeKb = Number(/free_kb:(\d+)/.exec(work)?.[1]);
  const user = m.ssh_target.includes('@') ? m.ssh_target.split('@')[0]! : '登入帳號';
  lines.push(
    /work: writable/.test(work)
      ? { ok: true, label: '工作目錄', detail: `${m.work_root} 可寫${Number.isFinite(freeKb) && freeKb > 0 ? `，剩 ${gb(freeKb)}` : ''}` }
      : {
          ok: false,
          label: '工作目錄',
          detail: `${m.work_root} 不可寫（${work.replace(/\s+/g, ' ').trim().slice(0, 200) || '沒有回應'}）：${
            os === 'linux' ? `在 ${m.name} 上 sudo mkdir -p ${m.work_root} && sudo chown ${user} ${m.work_root}` : `在 ${m.name} 上建立 ${m.work_root} 並給 ${user} 寫入權限`
          }`,
        },
  );

  const py = /Python (\d[\d.]*)/.exec(p.python ?? '')?.[1];
  lines.push(py ? { ok: true, label: 'Python', detail: `Python ${py}` } : { ok: null, label: 'Python', detail: '找不到 python；圖資比對在引擎主機做，不影響' });

  const gpus = (p.gpu ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const gpuOk = gpus.length > 0 && !/gpu: none|not found|not recognized|無法|NVIDIA-SMI has failed|No devices/i.test(gpus.join(' '));
  lines.push(gpuOk ? { ok: true, label: 'GPU', detail: gpus.join('、') } : { ok: null, label: 'GPU', detail: '沒有 nvidia-smi（或沒有 NVIDIA GPU）；只有需要 GPU 的檢查會受影響' });
  if (detected.specs) lines.push({ ok: true, label: '規格', detail: specsSummary(detected.specs)! });

  for (const r of repos) {
    const row = (p.repos ?? '').split('\n').find((l) => l.trim().startsWith(`repo ${safeName(r.name)} `)) ?? '';
    const hit = /^repo \S+ ([0-9a-f]{6,40})(?: (\d+))?/.exec(row.trim());
    lines.push(
      hit
        ? { ok: true, label: 'repo 複本', detail: `${r.name} @ ${hit[1]!.slice(0, 7)}${hit[2] ? `（${ago(now() - Number(hit[2]) * 1000)}）` : ''}` }
        : { ok: null, label: 'repo 複本', detail: `${r.name} 還沒複製到 ${m.name}：第一次跑檢查時會 clone` },
    );
  }
  for (const d of datasets) {
    const present = (p.datasets ?? '').split('\n').some((l) => l.trim() === `dataset ${safeName(d.name)} present`);
    lines.push(present ? { ok: true, label: '圖資快取', detail: `${d.name} 已在 ${m.name} 上` } : { ok: null, label: '圖資快取', detail: `${d.name} 還沒抓：第一次跑檢查時會抓` });
  }
  return done();
}
