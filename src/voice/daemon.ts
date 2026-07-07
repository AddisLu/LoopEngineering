import { spawn } from 'node:child_process';

/**
 * Minimal duck-typed surface of node's ChildProcess this module needs — lets tests
 * drive a fake worker (EventEmitter-based, no real python/GPU) instead of the real thing.
 */
export interface ChildLike {
  stdin: { write(chunk: string): unknown };
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit' | 'error', cb: (err?: unknown) => void): unknown;
  kill(): unknown;
  killed?: boolean;
}

export type SpawnFn = (pythonBin: string, scriptPath: string) => ChildLike;

/** Real spawn of scripts/transcribe_daemon.py, kept alive across requests. */
export const realSpawn: SpawnFn = (pythonBin, scriptPath) => spawn(pythonBin, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Pulls this request's payload out of the daemon's parsed JSON response, or
   * returns undefined if the shape doesn't match (-> 'malformed' rejection). */
  extract: (parsed: Record<string, unknown>) => unknown;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Singleton-per-instance manager for a warm python worker subprocess (whisper
 * transcription, bge-m3 embedding, ...): spawns lazily on first use, reuses the same
 * process across requests (saves the multi-second model-load + CUDA-init cost a
 * one-shot script pays every time), respawns automatically if the process dies
 * mid-flight or before, and self-terminates after an idle period to free VRAM. One
 * request in flight at a time is fine (both use cases are inherently serial) but
 * requests are queued FIFO regardless, matched to the daemon's one-response-per-line
 * protocol. `.transcribe()`/`.embed()` are thin protocol-specific wrappers over the
 * shared `request()` plumbing — each script speaks its own request/response shape.
 */
export class WarmWorker {
  private child: ChildLike | null = null;
  private buf = '';
  private queue: PendingRequest[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly spawnFn: SpawnFn,
    private readonly pythonBin: string,
    private readonly scriptPath: string,
    private readonly idleMinutes: () => number,
    private readonly timeoutMs: number,
  ) {}

  isAlive(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /** Transcribe one audio file via the daemon; rejects on daemon death/timeout so the
   * caller (transcribe.ts) can fall back to the one-shot script. */
  async transcribe(audioPath: string, termsFile: string): Promise<string> {
    return this.request({ audio: audioPath, terms_file: termsFile }, (p) =>
      typeof p.text === 'string' ? p.text : undefined,
    );
  }

  /** Embed a batch of texts via the daemon; rejects on daemon death/timeout so the
   * caller (embed.ts) can fall back to the one-shot script. */
  async embed(texts: string[]): Promise<number[][]> {
    return this.request({ texts }, (p) => (Array.isArray(p.embeddings) ? (p.embeddings as number[][]) : undefined));
  }

  /** Shared request/response plumbing: writes one JSON line to the daemon's stdin,
   * resolves/rejects the matching queued request once its response line arrives
   * (matched FIFO in onData), and always re-arms the idle-shutdown timer after. */
  private async request<T>(payload: Record<string, unknown>, extract: (parsed: Record<string, unknown>) => T | undefined): Promise<T> {
    this.clearIdleTimer();
    this.ensureSpawned();
    const child = this.child!;
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = this.queue.findIndex((r) => r.resolve === resolve);
          if (i >= 0) this.queue.splice(i, 1);
          this.killChild();
          reject(new Error('warm worker timed out'));
        }, this.timeoutMs);
        this.queue.push({ resolve: resolve as (value: unknown) => void, reject, extract: extract as (parsed: Record<string, unknown>) => unknown, timer });
        child.stdin.write(JSON.stringify(payload) + '\n');
      });
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  /** Stop the worker (idle timeout, or explicit shutdown) — frees VRAM. */
  killChild(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // already dead
      }
    }
    this.child = null;
    this.buf = '';
  }

  private ensureSpawned(): void {
    if (this.isAlive()) return;
    this.child = this.spawnFn(this.pythonBin, this.scriptPath);
    this.buf = '';
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr?.on('data', () => {
      /* daemon logs progress to stderr; nothing to do with it here */
    });
    this.child.on('exit', () => this.onDeath(new Error('warm worker exited')));
    this.child.on('error', (err) => this.onDeath(err instanceof Error ? err : new Error(String(err))));
  }

  private onData(chunk: Buffer | string): void {
    this.buf += chunk.toString();
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      const req = this.queue.shift();
      if (!req) continue;
      clearTimeout(req.timer);
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.error === 'string') {
          req.reject(new Error(parsed.error));
          continue;
        }
        const value = req.extract(parsed);
        if (value !== undefined) req.resolve(value);
        else req.reject(new Error('malformed warm worker response'));
      } catch {
        req.reject(new Error('malformed warm worker response'));
      }
    }
  }

  private onDeath(err: Error): void {
    this.child = null;
    this.buf = '';
    const pending = this.queue.splice(0);
    for (const req of pending) {
      clearTimeout(req.timer);
      req.reject(err);
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    const minutes = this.idleMinutes();
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.idleTimer = setTimeout(() => this.killChild(), minutes * 60_000);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
