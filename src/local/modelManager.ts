import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getNum, getSetting, setSetting, logEvent } from '../db/index.js';
import { notify } from '../notify.js';
import { getLocalModel, listLocalModels } from './models.js';
import { weightsComplete } from './weights.js';
import { scopedCommand, unitName } from './scope.js';
import { shutdownWarmWorkers } from '../voice/daemon.js';
import { getTranscribeWarmWorkerSingleton } from '../voice/transcribe.js';
import { getEmbedWarmWorkerSingleton } from '../knowledge/embed.js';

/**
 * 本地模型 lifecycle: which model vLLM is serving, and switching it. One GPU holds one model,
 * so a switch = free the warm workers' VRAM -> `docker stop/rm` the vLLM container -> detached
 * `run-recipe.sh <recipe> --solo --earlyoom` -> poll `/v1/models` until the served id appears.
 *
 * Never blocks the tick: ensureLoaded() starts a background switch and returns immediately; the
 * tick reads state() each pass. The tick (not this class) guarantees no local run is in flight
 * when a switch starts. State survives restarts via the local_model_loaded / local_model_status
 * settings, and reconcile() adopts whatever vLLM is actually serving.
 */

export type LocalModelStatus = 'idle' | 'starting' | 'ready' | 'error';

export interface ModelManagerState {
  loaded: string | null; // local model id currently serving (status 'ready'), else null
  wanted: string | null; // target of the current / last switch
  status: LocalModelStatus;
  since: string | null; // ISO time of the last status change
  error: string | null;
}

export type EnsureResult = 'ready' | 'switching' | 'busy';

export interface LauncherHandle {
  pid: number | undefined;
  onExit(cb: (code: number | null) => void): void;
}

export interface ModelManagerDeps {
  /** Start `bash <repo>/run-recipe.sh <recipe> --solo --earlyoom` detached, output -> logPath. */
  launch?: (repo: string, recipe: string, logPath: string) => LauncherHandle;
  /** Run a short command (docker stop/rm); resolves with the exit code, never rejects. */
  exec?: (cmd: string, args: string[], timeoutMs: number) => Promise<number | null>;
  /** Is a container with this name still known to docker? (the --rm removal race, see switchTo) */
  containerExists?: (name: string) => Promise<boolean>;
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  /** Free VRAM held by the whisper / bge-m3 warm workers before vLLM claims the GPU. */
  shutdownWorkers?: () => void;
  /** Are the weights fully in the HF cache? A switch never downloads ~100 GB at dispatch time. */
  isCached?: (servedModelId: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

const REFRESH_MS = 5 * 60_000;

/**
 * How a recipe is started. `HF_HUB_OFFLINE=1` is deliberate: the switcher only offers models
 * whose weights are already complete on disk (src/local/weights.ts), so vLLM has no business
 * talking to the hub at load time. Without it, an upstream repo that published a *new revision*
 * makes vLLM resolve that revision instead and quietly start re-downloading ~100 GB mid-switch —
 * which is how this machine ended up with no model at all during a demo.
 */
export function launchArgs(repo: string, recipe: string): string[] {
  return [path.join(repo, 'run-recipe.sh'), recipe, '--solo', '--earlyoom', '-e', 'HF_HUB_OFFLINE=1'];
}

/**
 * `detached` alone does not survive `systemctl --user restart`: the whole service cgroup is
 * killed, run-recipe.sh traps the signal and stops the container — a deploy would take the
 * model the operator is talking to down with it. The launcher therefore runs in its own
 * transient scope (src/local/scope.ts) and reconcile() re-adopts it after the restart.
 */
export function launchCommand(repo: string, recipe: string, logName: string, env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  return scopedCommand('bash', launchArgs(repo, recipe), unitName('loop', logName), env);
}

function defaultLaunch(repo: string, recipe: string, logPath: string): LauncherHandle {
  const fd = fs.openSync(logPath, 'a');
  const { cmd, args } = launchCommand(repo, recipe, path.basename(logPath, '.log'));
  // detached + unref: vLLM outlives an engine restart (reconcile() re-adopts it).
  const child = nodeSpawn(cmd, args, {
    cwd: repo,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd); // the child holds its own copy
  child.unref();
  return {
    pid: child.pid,
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
      child.on('error', () => cb(null));
    },
  };
}

function defaultContainerExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    nodeExecFile('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.ID}}'], { timeout: 10_000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

function defaultExec(cmd: string, args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    nodeExecFile(cmd, args, { timeout: timeoutMs }, (err) => {
      if (!err) return resolve(0);
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

/** Weights present and not mid-download (hf leaves `*.incomplete` blobs while fetching). */
export function hfCached(servedModelId: string): boolean {
  return weightsComplete(servedModelId);
}

export class ModelManager {
  readonly db: Database.Database;
  private st: ModelManagerState;
  private switching: Promise<void> | null = null;
  private errorAt = 0;
  private lastRefresh = 0;
  private readonly d: Required<ModelManagerDeps>;

  constructor(db: Database.Database, deps: ModelManagerDeps = {}) {
    this.db = db;
    this.d = {
      launch: deps.launch ?? defaultLaunch,
      exec: deps.exec ?? defaultExec,
      containerExists: deps.containerExists ?? defaultContainerExists,
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
      shutdownWorkers:
        deps.shutdownWorkers ??
        (() => shutdownWarmWorkers([getTranscribeWarmWorkerSingleton(), getEmbedWarmWorkerSingleton()])),
      isCached: deps.isCached ?? hfCached,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: deps.now ?? Date.now,
      pollMs: deps.pollMs ?? 10_000,
    };
    const persisted = getSetting(db, 'local_model_status');
    const loaded = getSetting(db, 'local_model_loaded') || null;
    // A persisted 'starting'/'error' has no live switch behind it after a restart — treat as idle
    // until reconcile() looks at what vLLM is really serving.
    const ready = persisted === 'ready' && !!loaded;
    this.st = { loaded: ready ? loaded : null, wanted: loaded, status: ready ? 'ready' : 'idle', since: null, error: null };
  }

  state(): ModelManagerState {
    return { ...this.st };
  }

  /** In an error cool-down (local_switch_retry_min) after failing to load this model? */
  unavailable(id: string): boolean {
    return (
      this.st.status === 'error' &&
      this.st.wanted === id &&
      this.d.now() - this.errorAt < getNum(this.db, 'local_switch_retry_min', 10) * 60_000
    );
  }

  /** Make `id` the serving model. Returns at once; poll state() for the outcome. */
  ensureLoaded(id: string): EnsureResult {
    if (this.st.status === 'ready' && this.st.loaded === id) return 'ready';
    if (this.switching) return this.st.wanted === id ? 'switching' : 'busy';
    if (this.unavailable(id)) return 'busy';
    this.switching = this.switchTo(id).finally(() => {
      this.switching = null;
    });
    return 'switching';
  }

  /** Resolves when the in-flight switch (if any) has finished — for the CLI, which must stay alive. */
  waitForSwitch(): Promise<void> {
    return this.switching ?? Promise.resolve();
  }

  /** Throttled background reconcile, called from the tick so a vLLM crash is noticed. */
  refresh(): void {
    if (this.switching || this.d.now() - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = this.d.now();
    void this.reconcile();
  }

  /** Adopt whatever vLLM is actually serving (engine restart, manual start, crash). */
  async reconcile(): Promise<void> {
    if (this.switching) return;
    this.lastRefresh = this.d.now();
    const served = await this.servedModelId();
    if (this.switching) return; // a switch started while we were probing — it owns state now
    const match = served ? listLocalModels(this.db).find((m) => m.served_model_id === served) : undefined;
    if (match) {
      if (!(this.st.status === 'ready' && this.st.loaded === match.id)) {
        this.set({ loaded: match.id, wanted: match.id, status: 'ready', error: null });
        logEvent(this.db, { kind: 'note', detail: `local model: adopted running ${match.id}` });
      }
    } else if (this.st.status === 'ready' || this.st.status === 'starting') {
      this.set({ loaded: null, status: 'idle' });
      logEvent(this.db, { kind: 'note', detail: 'local model: vLLM not serving a registered model — marked idle' });
    }
  }

  /** Stop vLLM entirely (frees the GPU). Waits for an in-flight switch first. */
  async stop(): Promise<void> {
    if (this.switching) await this.switching.catch(() => {});
    await this.d.exec('docker', ['stop', this.container()], 120_000);
    this.set({ loaded: null, status: 'idle', error: null });
    logEvent(this.db, { kind: 'note', detail: 'local model: stopped' });
  }

  private container(): string {
    return getSetting(this.db, 'local_vllm_container') || 'vllm_node';
  }

  private async switchTo(id: string): Promise<void> {
    const model = getLocalModel(this.db, id);
    // synchronous up to the first await: the very next tick already sees 'starting'
    this.set({ wanted: id, loaded: null, status: 'starting', error: null });
    if (!model || !model.enabled) return this.fail(id, `unknown or disabled local model '${id}'`);
    const started = this.d.now();
    logEvent(this.db, { kind: 'note', detail: `local model: switching to ${id} (${model.recipe})` });

    // Already serving it (started by hand, or engine restarted)? Adopt without a 6-minute restart.
    if ((await this.servedModelId()) === model.served_model_id) return this.ready(id, started);
    if (!this.d.isCached(model.served_model_id)) {
      return this.fail(id, `weights not downloaded: ${model.served_model_id} (run hf-download.sh first)`);
    }

    this.d.shutdownWorkers();
    await this.d.exec('docker', ['stop', this.container()], 120_000);
    await this.d.exec('docker', ['rm', '-f', this.container()], 60_000);
    // launch-cluster.sh runs the container with `--rm`, so the daemon removes it asynchronously
    // after a stop: `docker rm -f` can return while the name is still taken, and the next
    // `docker run --name vllm_node` then dies with "name already in use" — which is how a demo
    // machine ended up serving nothing at all. Wait for the name to actually free up.
    const freed = await this.waitForContainerGone();
    if (!freed) return this.fail(id, `container ${this.container()} 還在（docker rm 沒清掉），沒有啟動新的模型`);

    const repo = getSetting(this.db, 'local_vllm_repo') || '';
    const logPath = path.join(paths.logsDir, `vllm-${id}-${started}.log`);
    let exited: number | null | undefined;
    try {
      this.d.launch(repo, model.recipe, logPath).onExit((code) => {
        exited = code;
      });
    } catch (err) {
      return this.fail(id, `vLLM launch failed: ${String(err)}`);
    }

    const deadline = started + getNum(this.db, 'local_switch_timeout_sec', 900) * 1000;
    while (this.d.now() < deadline) {
      await this.d.sleep(this.d.pollMs);
      if ((await this.servedModelId()) === model.served_model_id) return this.ready(id, started);
      // run-recipe.sh stays in the foreground while vLLM serves, so an early exit is a failure
      if (exited !== undefined) {
        return this.fail(id, `vLLM launcher exited (code ${exited}) before ${id} was ready — see ${logPath}`);
      }
    }
    return this.fail(id, `timed out after ${Math.round((this.d.now() - started) / 1000)}s loading ${id} — see ${logPath}`);
  }

  /** Poll until no container holds our name (bounded); true when the name is free. */
  private async waitForContainerGone(timeoutMs = 60_000): Promise<boolean> {
    const exists = this.d.containerExists;
    const until = this.d.now() + timeoutMs;
    while (await exists(this.container())) {
      if (this.d.now() >= until) return false;
      await this.d.sleep(1000);
    }
    return true;
  }

  private async servedModelId(): Promise<string | null> {
    const base = (getSetting(this.db, 'local_vllm_base_url') || 'http://127.0.0.1:8000/v1').replace(/\/+$/, '');
    try {
      const res = await this.d.fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const id = body?.data?.[0]?.id;
      return typeof id === 'string' ? id : null;
    } catch {
      return null;
    }
  }

  private set(patch: Partial<ModelManagerState>): void {
    this.st = { ...this.st, ...patch, since: new Date(this.d.now()).toISOString() };
    setSetting(this.db, 'local_model_loaded', this.st.loaded ?? '');
    setSetting(this.db, 'local_model_status', this.st.status);
  }

  private ready(id: string, started: number): void {
    this.set({ loaded: id, wanted: id, status: 'ready', error: null });
    logEvent(this.db, {
      kind: 'note',
      detail: `local model: ${id} ready after ${Math.round((this.d.now() - started) / 1000)}s`,
    });
  }

  private fail(id: string, msg: string): void {
    this.errorAt = this.d.now();
    this.set({ loaded: null, wanted: id, status: 'error', error: msg });
    logEvent(this.db, { kind: 'note', detail: `local model: ${msg}` });
    void notify(this.db, { title: 'Loop: 本地模型載入失敗', message: msg, priority: 'high', tags: ['warning'] });
  }
}

let _mm: ModelManager | null = null;

/** Process-wide manager (the engine and the API share it). Re-created if bound to another db. */
export function getModelManager(db: Database.Database, deps?: ModelManagerDeps): ModelManager {
  if (!_mm || _mm.db !== db) _mm = new ModelManager(db, deps);
  return _mm;
}
