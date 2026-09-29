import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';

/**
 * 執行沙盒: run one shell command in a throwaway Docker container that may use the GPU and
 * nothing else — no network, a read-only root filesystem, no Linux capabilities, capped
 * memory/CPU/processes, and exactly one host directory mounted read-write at /work (a chat
 * conversation's scratch dir, or a task run's worktree). The chat page's local model and task
 * agents use it to compile, run and measure what they wrote instead of asking a person to
 * (src/chat/sandboxTools.ts, src/server/execRoutes.ts + mcp/loop-exec-mcp.mjs, `sandbox:` verify
 * steps in src/orchestrator/verify.ts).
 *
 * Off unless exec_enabled. The image is never pulled on demand (--pull never): a multi-GB CUDA
 * image downloading inside a tool call would blow every timeout, so a missing image fails fast
 * with the `docker pull` to run instead.
 */

export const DEFAULT_EXEC_IMAGE = 'nvidia/cuda:13.0.3-devel-ubuntu24.04';

export interface SandboxSettings {
  enabled: boolean;
  image: string;
  /** docker --gpus value; '' runs without a GPU */
  gpus: string;
  memory: string;
  cpus: string;
  pids: number;
  /** default per-run timeout */
  timeoutSec: number;
  /** the most a caller may ask for */
  maxTimeoutSec: number;
  maxConcurrency: number;
  /** combined stdout+stderr kept per run (head + tail) */
  outputChars: number;
  /** --cap-add SYS_ADMIN so Nsight Compute can read GPU counters without the host driver option */
  profilingCap: boolean;
}

export function sandboxSettings(db: Database.Database): SandboxSettings {
  return {
    enabled: getBool(db, 'exec_enabled', false),
    image: (getSetting(db, 'exec_image') || DEFAULT_EXEC_IMAGE).trim(),
    gpus: (getSetting(db, 'exec_gpus') ?? 'all').trim(),
    memory: (getSetting(db, 'exec_memory') || '16g').trim(),
    cpus: (getSetting(db, 'exec_cpus') || '8').trim(),
    pids: Math.max(16, getNum(db, 'exec_pids', 512)),
    timeoutSec: Math.max(1, getNum(db, 'exec_timeout_sec', 120)),
    maxTimeoutSec: Math.max(1, getNum(db, 'exec_max_timeout_sec', 900)),
    maxConcurrency: Math.max(1, getNum(db, 'exec_max_concurrency', 2)),
    outputChars: Math.max(1000, getNum(db, 'exec_output_chars', 12_000)),
    profilingCap: getBool(db, 'exec_profiling_cap', false),
  };
}

/** A caller's requested timeout, clamped to [1, maxTimeoutSec]; absent/invalid → the default. */
export function effectiveTimeoutSec(s: SandboxSettings, requested?: unknown): number {
  const n = Number(requested);
  const want = requested != null && requested !== '' && Number.isFinite(n) && n > 0 ? n : s.timeoutSec;
  return Math.max(1, Math.min(s.maxTimeoutSec, Math.round(want)));
}

export interface DockerArgsInput {
  workdir: string;
  command: string;
  name: string;
  uid: number | null;
  gid: number | null;
  /** free-form label for `docker ps --filter label=loop-exec.scope=…` (chat / task / verify) */
  scope?: string;
}

/** The whole isolation policy lives in this one argv. */
export function buildDockerArgs(s: SandboxSettings, i: DockerArgsInput): string[] {
  const args = ['run', '--rm', '--pull', 'never', '--name', i.name, '--label', 'loop-exec=1'];
  if (i.scope) args.push('--label', `loop-exec.scope=${i.scope.replace(/[^\w:.-]/g, '_')}`);
  args.push('--network', 'none');
  if (s.gpus) args.push('--gpus', s.gpus);
  // the engine's own uid: files written to /work stay removable by the engine (and by git)
  if (i.uid != null && i.gid != null) args.push('--user', `${i.uid}:${i.gid}`);
  args.push('--cap-drop', 'ALL');
  if (s.profilingCap) args.push('--cap-add', 'SYS_ADMIN');
  args.push('--security-opt', 'no-new-privileges');
  args.push('--pids-limit', String(s.pids), '--memory', s.memory, '--memory-swap', s.memory, '--cpus', s.cpus);
  args.push('--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=2g');
  args.push('-e', 'HOME=/tmp', '-e', 'TMPDIR=/tmp');
  args.push('--mount', `type=bind,source=${i.workdir},target=/work`, '-w', '/work');
  args.push(s.image, 'bash', '-c', i.command);
  return args;
}

// ---- running docker --------------------------------------------------------------------------

export interface DockerOutcome {
  code: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** docker itself could not be started (not installed, spawn failure) */
  error?: string;
}

export type DockerRunner = (
  args: string[],
  o: { name: string; timeoutMs: number; maxChars: number; signal?: AbortSignal },
) => Promise<DockerOutcome>;

const HEAD_CHARS = 2000;

/** Keeps the first HEAD_CHARS and the last (maxChars − HEAD_CHARS) characters of a stream. */
export class OutputCapture {
  private head = '';
  private tail = '';
  private total = 0;
  constructor(private readonly maxChars: number) {}
  push(s: string): void {
    if (!s) return;
    this.total += s.length;
    const headRoom = Math.min(HEAD_CHARS, this.maxChars) - this.head.length;
    if (headRoom > 0) {
      this.head += s.slice(0, headRoom);
      s = s.slice(headRoom);
    }
    if (!s) return;
    const tailMax = Math.max(0, this.maxChars - Math.min(HEAD_CHARS, this.maxChars));
    this.tail = (this.tail + s).slice(-tailMax);
  }
  result(): { text: string; truncated: boolean } {
    const kept = this.head.length + this.tail.length;
    if (this.total <= kept) return { text: this.head + this.tail, truncated: false };
    return { text: `${this.head}\n…（中間省略 ${this.total - kept} 字）…\n${this.tail}`, truncated: true };
  }
}

/** Stop a container by name. Killing the `docker run` client alone would leave it running. */
function dockerKill(name: string): void {
  execFile('docker', ['kill', name], { timeout: 15_000 }, () => {
    /* already gone, or docker unreachable — nothing more to do */
  });
}

export const realDockerRunner: DockerRunner = (args, o) =>
  new Promise<DockerOutcome>((resolve) => {
    const cap = new OutputCapture(o.maxChars);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    if (o.signal?.aborted) {
      resolve({ code: null, output: '', truncated: false, timedOut: false, aborted: true });
      return;
    }
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const outDec = new TextDecoder();
    const errDec = new TextDecoder();
    child.stdout.on('data', (d: Buffer) => cap.push(outDec.decode(d, { stream: true })));
    child.stderr.on('data', (d: Buffer) => cap.push(errDec.decode(d, { stream: true })));
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      dockerKill(o.name);
      // the client normally exits as soon as the container dies; this is the backstop
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal?.removeEventListener('abort', onAbort);
      cap.push(outDec.decode());
      cap.push(errDec.decode());
      const { text, truncated } = cap.result();
      resolve({ code, output: text, truncated, timedOut, aborted, ...(error ? { error } : {}) });
    };
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(null, err.code === 'ENOENT' ? '找不到 docker 指令（這台機器沒有安裝 Docker，或不在 PATH 上）' : err.message),
    );
    child.on('close', (code) => finish(code));
  });

// ---- concurrency -------------------------------------------------------------------------------

/** In-process cap on simultaneous containers. Every caller (chat, task API, verify) goes through
 * the engine process, so a plain counter is the whole story. */
class Slots {
  private active = 0;
  private waiters: Array<() => void> = [];
  async acquire(max: number, waitMs: number, signal?: AbortSignal): Promise<(() => void) | null> {
    const deadline = Date.now() + waitMs;
    while (this.active >= max) {
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.min(left, 1000));
        function done() {
          clearTimeout(t);
          resolve();
        }
        this.waiters.push(done);
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
  get inUse(): number {
    return this.active;
  }
}

const slots = new Slots();
/** Test hook: containers the engine is running right now. */
export const sandboxInUse = (): number => slots.inUse;

// ---- the call everyone uses --------------------------------------------------------------------

export interface SandboxRequest {
  /** host directory mounted at /work — must exist */
  workdir: string;
  command: string;
  timeoutSec?: unknown;
  scope?: string;
  signal?: AbortSignal;
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  timeoutSec: number;
  output: string;
  truncated: boolean;
  /** one line on what to do about a failure, when we recognise it */
  hint: string | null;
  /** the sandbox could not run the command at all (docker missing, image not pulled, GPU runtime) */
  infra: boolean;
  error: string | null;
}

export interface SandboxDeps {
  runner?: DockerRunner;
  uid?: number | null;
  gid?: number | null;
  now?: () => number;
  /** how long to wait for a free slot before giving up */
  queueWaitMs?: number;
}

const MAX_COMMAND_CHARS = 20_000;

function failed(timeoutSec: number, error: string, hint: string | null = null): SandboxResult {
  return { exitCode: null, timedOut: false, aborted: false, durationMs: 0, timeoutSec, output: '', truncated: false, hint, infra: true, error };
}

const DAEMON_UNREACHABLE = /Cannot connect to the Docker daemon|permission denied while trying to connect to the Docker daemon/i;

/** docker itself failed (not the command): no binary, no daemon, or its own exit 125. */
export function isDockerFailure(o: Pick<DockerOutcome, 'code' | 'output' | 'timedOut' | 'aborted' | 'error'>): boolean {
  if (o.error) return true;
  if (o.timedOut || o.aborted) return false;
  return o.code === 125 || DAEMON_UNREACHABLE.test(o.output);
}

/** Recognise the usual ways a run goes wrong and say what to do — first match wins. */
export function sandboxHint(
  s: SandboxSettings,
  o: Pick<DockerOutcome, 'code' | 'output' | 'timedOut' | 'aborted' | 'error'>,
  timeoutSec: number,
): string | null {
  const out = `${o.error ?? ''}\n${o.output}`;
  if (o.error && /找不到 docker/.test(o.error)) return '執行沙盒需要 Docker 與 NVIDIA Container Toolkit；請先在這台機器安裝。';
  if (DAEMON_UNREACHABLE.test(out)) return '引擎的使用者連不到 Docker daemon（多半是不在 docker 群組）。';
  // image / GPU runtime problems are docker's own errors (exit 125); the command's output never counts
  if (o.code === 125 && /No such image|Unable to find image|pull access denied|manifest unknown|\bimage\b/i.test(out)) {
    return `這台機器沒有映像 ${s.image}：先執行 docker pull ${s.image}（或把 exec_image 改成已有的映像），再跑 loop exec check。`;
  }
  if (o.code === 125 && /could not select device driver|nvidia|runtime|gpu/i.test(out)) {
    return 'Docker 無法使用 GPU：確認已安裝 NVIDIA Container Toolkit；不需要 GPU 的話可把 exec_gpus 設成空字串。';
  }
  if (/ERR_NVGPUCTRPERM/.test(out)) {
    return 'ncu 沒有讀 GPU 效能計數器的權限：建議在主機設定驅動參數 NVreg_RestrictProfilingToAdminUsers=0 並重開機；或開 exec_profiling_cap（容器多 SYS_ADMIN 權限，隔離會變弱）。';
  }
  if (o.timedOut) return `超過 ${timeoutSec} 秒被中止：縮小問題規模，或呼叫時帶較長的 timeout_sec（上限 exec_max_timeout_sec）。`;
  if (o.aborted) return '已被使用者中止。';
  if (o.code === 137) return `程式被強制結束（exit 137），多半是記憶體超過 exec_memory=${s.memory}。`;
  if (/\bncu: (command )?not found/.test(out)) return `映像 ${s.image} 裡沒有 ncu（Nsight Compute）：用 loop exec check 確認，需要時自建一個含 Nsight Compute 的映像。`;
  if (/\bnvcc: (command )?not found/.test(out)) return `映像 ${s.image} 裡沒有 nvcc：請改用 CUDA 的 -devel 映像。`;
  if (/Read-only file system/i.test(out)) return '容器的根目錄是唯讀的：輸出請寫到 /work（工作目錄）或 /tmp。';
  if (/Temporary failure in name resolution|Could not resolve host|Network is unreachable/i.test(out)) {
    return '沙盒沒有網路（--network none）：需要的套件請先做進映像。';
  }
  return null;
}

export async function runSandbox(s: SandboxSettings, req: SandboxRequest, deps: SandboxDeps = {}): Promise<SandboxResult> {
  const now = deps.now ?? Date.now;
  const timeoutSec = effectiveTimeoutSec(s, req.timeoutSec);
  const command = typeof req.command === 'string' ? req.command.trim() : '';
  if (!command) return failed(timeoutSec, 'command 不可為空');
  if (command.length > MAX_COMMAND_CHARS) return failed(timeoutSec, `command 太長（上限 ${MAX_COMMAND_CHARS} 字）；長的腳本請先寫成檔案再執行`);
  if (!s.image) return failed(timeoutSec, 'exec_image 沒有設定');
  // `,` and `"` would be read as --mount syntax
  if (!path.isAbsolute(req.workdir) || /[,"]/.test(req.workdir)) return failed(timeoutSec, `工作目錄不合法：${req.workdir}`);
  try {
    if (!fs.statSync(req.workdir).isDirectory()) return failed(timeoutSec, `工作目錄不是資料夾：${req.workdir}`);
  } catch {
    return failed(timeoutSec, `工作目錄不存在：${req.workdir}`);
  }

  const release = await slots.acquire(s.maxConcurrency, deps.queueWaitMs ?? 120_000, req.signal);
  if (!release) {
    return req.signal?.aborted
      ? { ...failed(timeoutSec, '已被使用者中止'), aborted: true, infra: false }
      : failed(timeoutSec, `執行沙盒忙碌中（同時最多 ${s.maxConcurrency} 個，exec_max_concurrency）；請稍後再試`);
  }
  const started = now();
  try {
    const name = `loop-exec-${nanoid(12).replace(/[^A-Za-z0-9]/g, 'x')}`;
    const uid = deps.uid !== undefined ? deps.uid : typeof process.getuid === 'function' ? process.getuid() : null;
    const gid = deps.gid !== undefined ? deps.gid : typeof process.getgid === 'function' ? process.getgid() : null;
    const args = buildDockerArgs(s, { workdir: req.workdir, command, name, uid, gid, scope: req.scope });
    const o = await (deps.runner ?? realDockerRunner)(args, { name, timeoutMs: timeoutSec * 1000, maxChars: s.outputChars, signal: req.signal });
    // exit 125 is docker's own "could not create/start the container" — never the command's
    const infra = isDockerFailure(o);
    return {
      exitCode: o.code,
      timedOut: o.timedOut,
      aborted: o.aborted,
      durationMs: now() - started,
      timeoutSec,
      output: o.output,
      truncated: o.truncated,
      hint: sandboxHint(s, o, timeoutSec),
      infra,
      error: o.error ?? (infra ? `docker 無法啟動容器（exit ${o.code}）` : null),
    };
  } finally {
    release();
  }
}

// ---- `sandbox:` verification steps -------------------------------------------------------------

export type SandboxStepRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<{ ok: boolean; exitCode: number | null; timedOut: boolean; output: string }>;

/** How src/orchestrator/verify.ts runs a `sandbox:` step: same container policy the agent had,
 * with the engine's verify timeout (not the per-call cap agents are held to). */
export function verifySandboxRunner(s: SandboxSettings, deps?: SandboxDeps): SandboxStepRunner {
  return async (command, cwd, timeoutMs) => {
    const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = await runSandbox({ ...s, maxTimeoutSec: Math.max(s.maxTimeoutSec, sec) }, { workdir: cwd, command, timeoutSec: sec, scope: 'verify' }, deps);
    return { ok: r.exitCode === 0 && !r.infra, exitCode: r.exitCode, timedOut: r.timedOut, output: formatSandboxResult(r) };
  };
}

// ---- presenting a result -----------------------------------------------------------------------

const secs = (ms: number): string => (ms / 1000).toFixed(1);

/** One short status: "exit 0 · 3.2 s", "逾時（120 s）", "沙盒錯誤". */
export function summarizeSandboxResult(r: SandboxResult): string {
  if (r.error && r.infra) return `沙盒錯誤：${r.error.slice(0, 80)}`;
  if (r.aborted) return '已中止';
  if (r.timedOut) return `逾時（${r.timeoutSec} s）`;
  return `exit ${r.exitCode ?? '?'} · ${secs(r.durationMs)} s`;
}

/** What the model / agent reads: status line, the output, then the hint. */
export function formatSandboxResult(r: SandboxResult): string {
  const lines = [summarizeSandboxResult(r)];
  if (r.error && !r.infra) lines.push(r.error);
  if (r.output.trim()) lines.push('----- 輸出 -----', r.output.replace(/\s+$/, ''));
  else if (!r.infra) lines.push('（沒有輸出）');
  if (r.hint) lines.push(`提示：${r.hint}`);
  return lines.join('\n');
}
