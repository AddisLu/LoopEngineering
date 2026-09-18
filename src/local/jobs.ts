import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getSetting, setSetting, logEvent } from '../db/index.js';
import { clearImageCache, imageExists } from './images.js';
import { weightsBytes, weightsComplete } from './weights.js';
import { registerRecipe } from './models.js';
import { scopedCommand, unitName } from './scope.js';

// re-exported so existing callers/tests keep one import site for the scope helper
export { scopedCommand } from './scope.js';

/**
 * The one long host job the 模型 panel can start: pull a model's weights, or build the container
 * image a recipe runs in. One job at a time, never touching the vLLM that is serving.
 *
 * Why the download does not go through `run-recipe.sh --download-only`: run-recipe.py treats a
 * non-empty `snapshots/` as "already downloaded", and `hf download` links each finished file into
 * the snapshot as it goes — so an interrupted pull is never resumed by that path. `uvx hf download`
 * (what hf-download.sh runs underneath) resumes from the `*.incomplete` blobs. Builds do go through
 * `run-recipe.sh <recipe> --solo --build-only`, which is non-interactive and honours build_args.
 *
 * The child is detached with its output in a log file, so it survives an engine restart; the job
 * record lives in the local_job_json setting and is re-adopted by pid on the next start.
 */

export type JobKind = 'download' | 'build';
export type JobStatus = 'running' | 'done' | 'error' | 'cancelled' | 'unknown';

export interface JobView {
  id: string;
  kind: JobKind;
  recipe: string;
  model: string | null;
  container: string | null;
  pid: number | null;
  status: JobStatus;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  log_path: string;
  /** download: blobs on disk so far (includes *.incomplete) */
  bytes_now: number | null;
  /** download: expected total from the HF API, when known */
  size_bytes: number | null;
  /** last line of the log with `\r` progress handled — what the panel shows under the bar */
  last_line: string;
  error: string | null;
}

export interface JobHandle {
  pid: number | undefined;
  onExit(cb: (code: number | null) => void): void;
}

export interface JobRunnerDeps {
  /** Start `cmd args` detached in `cwd`, stdout+stderr appended to logPath. */
  launch?: (cmd: string, args: string[], cwd: string, logPath: string, env?: NodeJS.ProcessEnv) => JobHandle;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Is this pid still alive? (used to re-adopt a job after an engine restart) */
  alive?: (pid: number) => boolean;
  now?: () => number;
  weightsBytes?: (model: string) => number | null;
  weightsComplete?: (model: string) => boolean;
  imageExists?: (image: string) => boolean;
  readTail?: (logPath: string, bytes: number) => string;
}

export class JobBusyError extends Error {}

const SETTING = 'local_job_json';
const TAIL_BYTES = 8192;

export function defaultJobLaunch(cmd: string, args: string[], cwd: string, logPath: string, env: NodeJS.ProcessEnv = process.env): JobHandle {
  const fd = fs.openSync(logPath, 'a');
  const scoped = scopedCommand(cmd, args, unitName('loop-local', path.basename(logPath, '.log')), env);
  // detached + unref: the pull outlives an engine restart; the runner re-adopts it by pid
  const child = nodeSpawn(scoped.cmd, scoped.args, { cwd, detached: true, stdio: ['ignore', fd, fd], env });
  fs.closeSync(fd);
  child.unref();
  return {
    pid: child.pid,
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
      child.on('error', () => cb(null));
    },
  };
}

function readTailDefault(logPath: string, bytes: number): string {
  try {
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, 'r');
    try {
      const len = Math.min(bytes, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Log lines as a terminal would show them: a `\r` progress bar keeps only its last frame. */
export function splitLogLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => {
      const frames = line.split('\r');
      return frames[frames.length - 1]!.trim();
    })
    .filter(Boolean)
    .map((line) => line.replace(/hf_[A-Za-z0-9]{20,}/g, 'hf_***')); // never echo a token, even if one leaks into the log
}

/** Turn the tail of a failed job into one sentence the operator can act on. */
export function explainFailure(kind: JobKind, tail: string[]): string {
  const text = tail.join('\n');
  if (/401|GatedRepo|gated|restricted|Access to model/i.test(text)) return '此模型需要 HF 授權（gated），這台沒有設定 HF token';
  if (/No space left/i.test(text)) return '磁碟空間不足';
  if (/Could not resolve host|Network is unreachable|Connection refused|Temporary failure in name resolution/i.test(text)) {
    return '連不上網路（下載與映像都要對外連線）';
  }
  const last = [...tail].reverse().find((l) => l.length > 0);
  return last ? last.slice(0, 200) : kind === 'download' ? '下載失敗，看 log' : '建置失敗，看 log';
}

export class LocalJobRunner {
  readonly db: Database.Database;
  private job: JobView | null = null;
  private readonly launch: NonNullable<JobRunnerDeps['launch']>;
  private readonly kill: NonNullable<JobRunnerDeps['kill']>;
  private readonly alive: NonNullable<JobRunnerDeps['alive']>;
  private readonly now: () => number;
  private readonly bytesOf: (model: string) => number | null;
  private readonly complete: (model: string) => boolean;
  private readonly imageReady: (image: string) => boolean;
  private readonly readTail: (logPath: string, bytes: number) => string;

  constructor(db: Database.Database, deps: JobRunnerDeps = {}) {
    this.db = db;
    this.launch = deps.launch ?? defaultJobLaunch;
    this.kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
    this.alive =
      deps.alive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    this.now = deps.now ?? Date.now;
    this.bytesOf = deps.weightsBytes ?? ((m) => weightsBytes(m));
    this.complete = deps.weightsComplete ?? ((m) => weightsComplete(m));
    this.imageReady = deps.imageExists ?? ((img) => imageExists(img));
    this.readTail = deps.readTail ?? readTailDefault;
    this.adopt();
  }

  /** After a restart: keep a still-running child, otherwise settle the record from what is on disk. */
  private adopt(): void {
    const raw = getSetting(this.db, SETTING);
    if (!raw) return;
    let saved: JobView;
    try {
      saved = JSON.parse(raw) as JobView;
    } catch {
      return;
    }
    if (!saved || typeof saved !== 'object' || !saved.id) return;
    this.job = saved;
    if (saved.status !== 'running') return;
    if (saved.pid && this.alive(saved.pid)) return; // still going — current() keeps polling it
    this.settleFromDisk('引擎重啟期間結束，結果不明——再按一次會續傳');
  }

  private settleFromDisk(unknownMsg: string): void {
    const j = this.job!;
    if (this.finishedOnDisk(j)) {
      this.finish('done', null, null);
    } else {
      j.status = 'unknown';
      j.ended_at = new Date(this.now()).toISOString();
      j.error = unknownMsg;
      this.persist();
    }
  }

  private finishedOnDisk(j: JobView): boolean {
    if (j.kind === 'download') return Boolean(j.model) && this.complete(j.model!);
    if (j.container) {
      clearImageCache();
      return this.imageReady(j.container);
    }
    return false;
  }

  private persist(): void {
    setSetting(this.db, SETTING, this.job ? JSON.stringify(this.job) : '');
  }

  start(kind: JobKind, recipe: string, entry: { model: string | null; container: string | null; size_bytes: number | null; repo: string }): JobView {
    const cur = this.current();
    if (cur && cur.status === 'running') throw new JobBusyError(`已有工作在跑：${cur.kind} ${cur.recipe}`);
    if (kind === 'download' && !entry.model) throw new Error('recipe has no model field');
    fs.mkdirSync(paths.logsDir, { recursive: true });
    const started = this.now();
    const safe = recipe.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const logPath = path.join(paths.logsDir, `local-${kind}-${safe}-${started}.log`);
    const job: JobView = {
      id: `j_${started.toString(36)}`,
      kind,
      recipe,
      model: entry.model,
      container: entry.container,
      pid: null,
      status: 'running',
      started_at: new Date(started).toISOString(),
      ended_at: null,
      exit_code: null,
      log_path: logPath,
      bytes_now: kind === 'download' && entry.model ? this.bytesOf(entry.model) : null,
      size_bytes: entry.size_bytes,
      last_line: '',
      error: null,
    };
    const handle =
      kind === 'download'
        ? this.launch('uvx', ['hf', 'download', entry.model!], entry.repo, logPath)
        : this.launch('bash', [path.join(entry.repo, 'run-recipe.sh'), recipe, '--solo', '--build-only'], entry.repo, logPath);
    job.pid = handle.pid ?? null;
    this.job = job;
    this.persist();
    logEvent(this.db, { kind: 'note', detail: `local ${kind} started: ${recipe} (log ${logPath})` });
    this.hooked.add(job.id);
    handle.onExit((code) => this.onExit(job.id, code));
    return { ...job };
  }

  private onExit(id: string, code: number | null): void {
    const j = this.job;
    if (!j || j.id !== id || j.status !== 'running') return; // cancelled, or a stale handle
    if (code === 0) {
      if (j.kind === 'download' && j.model && !this.complete(j.model)) {
        this.finish('error', code, '下載結束但檔案不完整——再按一次會續傳');
      } else {
        this.finish('done', code, null);
      }
    } else {
      this.finish('error', code, explainFailure(j.kind, this.tail(20)));
    }
  }

  private finish(status: JobStatus, code: number | null, error: string | null): void {
    const j = this.job!;
    j.status = status;
    j.exit_code = code;
    j.ended_at = new Date(this.now()).toISOString();
    j.error = error;
    if (j.kind === 'build') clearImageCache();
    if (status === 'done' && j.kind === 'download' && j.model) {
      try {
        registerRecipe(this.db, { recipe: j.recipe, name: null, model: j.model });
      } catch {
        /* the catalog registers on the next load attempt instead */
      }
    }
    this.refreshLive(j);
    this.persist();
    logEvent(this.db, { kind: 'note', detail: `local ${j.kind} ${status}: ${j.recipe}${error ? ` — ${error}` : ''}` });
  }

  private refreshLive(j: JobView): void {
    if (j.kind === 'download' && j.model) j.bytes_now = this.bytesOf(j.model);
    const lines = this.tail(1);
    j.last_line = lines[lines.length - 1] ?? '';
  }

  /** The job as of now: refreshes bytes/last line, and notices an adopted child that has exited. */
  current(): JobView | null {
    const j = this.job;
    if (!j) return null;
    if (j.status === 'running') {
      if (j.pid && !this.alive(j.pid) && !this.hasExitHook(j)) {
        // adopted after a restart: no exit event will come, decide from disk
        this.settleFromDisk('工作已結束但結果不明，看 log');
      } else {
        this.refreshLive(j);
      }
    }
    return { ...j };
  }

  /** jobs started by this process get an exit event; adopted ones are polled by pid instead */
  private readonly hooked = new Set<string>();
  private hasExitHook(j: JobView): boolean {
    return this.hooked.has(j.id);
  }

  cancel(): JobView | null {
    const j = this.job;
    if (!j || j.status !== 'running') return null;
    if (j.pid) {
      try {
        this.kill(-j.pid, 'SIGTERM'); // the whole group: bash + docker / uvx + hf
      } catch {
        try {
          this.kill(j.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    this.finish('cancelled', null, j.kind === 'download' ? '已取消——下載到一半的檔案留著，再按一次會續傳' : '已取消');
    return { ...j };
  }

  /** Last `lines` log lines, `\r` frames collapsed, tokens masked. */
  tail(lines: number): string[] {
    const j = this.job;
    if (!j) return [];
    const all = splitLogLines(this.readTail(j.log_path, TAIL_BYTES));
    return all.slice(-Math.max(1, Math.min(200, lines)));
  }

  /** Test seam. */
  clear(): void {
    this.job = null;
    this.persist();
  }
}

let singleton: LocalJobRunner | null = null;
export function getJobRunner(db: Database.Database, deps?: JobRunnerDeps): LocalJobRunner {
  if (!singleton || singleton.db !== db) singleton = new LocalJobRunner(db, deps);
  return singleton;
}
