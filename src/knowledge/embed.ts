import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getNum, getSetting } from '../db/index.js';
import { ENGINE_REPO_ROOT } from '../config.js';
import { WarmWorker, realSpawn } from '../voice/daemon.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 5 * 60_000;

export type EmbedExec = (pythonBin: string, args: string[], texts: string[]) => Promise<number[][]>;

export interface EmbedDeps {
  /** Injectable warm-worker handle (real WarmWorker duck-types this); tests fake it. */
  warmWorker?: { embed(texts: string[]): Promise<number[][]> };
}

/** Real one-shot call to scripts/embed_oneshot.py (sentence-transformers bge-m3, voice-venv).
 * `texts` go over stdin (not argv) — unlike a single audio path, a text batch can be long
 * and contain arbitrary characters. */
async function defaultExec(pythonBin: string, args: string[], texts: string[]): Promise<number[][]> {
  const call = execFileAsync(pythonBin, args, { timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 });
  call.child.stdin!.write(JSON.stringify({ texts }) + '\n');
  call.child.stdin!.end();
  const { stdout } = await call;
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  const parsed = JSON.parse(lastLine) as { embeddings?: unknown; error?: unknown };
  if (Array.isArray(parsed.embeddings)) return parsed.embeddings as number[][];
  throw new Error(typeof parsed.error === 'string' ? parsed.error : 'malformed embed response');
}

let warmWorkerSingleton: WarmWorker | null = null;

/** Lazily-created process-wide singleton — only ever spawns the real daemon (never in
 * tests, which always inject their own `deps.warmWorker` fake). */
function getWarmWorkerSingleton(db: Database.Database): WarmWorker {
  if (!warmWorkerSingleton) {
    warmWorkerSingleton = new WarmWorker(
      realSpawn,
      getSetting(db, 'embed_python') || '',
      path.join(ENGINE_REPO_ROOT, 'scripts', 'embed_daemon.py'),
      () => getNum(db, 'embed_worker_idle_min', 10),
      TIMEOUT_MS,
    );
  }
  return warmWorkerSingleton;
}

/**
 * Embed a batch of texts with the configured model (bge-m3 by default). The warm
 * daemon (scripts/embed_daemon.py) is tried first — any failure (dead process, timeout,
 * bad response) falls back to the one-shot `scripts/embed_oneshot.py` via `exec`
 * transparently, mirroring src/voice/transcribe.ts. `exec`/`deps` are injectable so
 * tests never spawn the real venv/GPU/daemon: the real singleton is only ever reached
 * when `exec` is left at its default, exactly like transcribe()'s injection contract.
 */
export async function embed(
  db: Database.Database,
  texts: string[],
  exec: EmbedExec = defaultExec,
  deps: EmbedDeps = {},
): Promise<number[][]> {
  if (deps.warmWorker || exec === defaultExec) {
    const worker = deps.warmWorker ?? getWarmWorkerSingleton(db);
    try {
      return await worker.embed(texts);
    } catch {
      // daemon down/dead/timed out -- fall through to the one-shot script below
    }
  }

  const scriptPath = path.join(ENGINE_REPO_ROOT, 'scripts', 'embed_oneshot.py');
  const args = [scriptPath, '--model', getSetting(db, 'embed_model') || 'BAAI/bge-m3'];
  const pythonBin = getSetting(db, 'embed_python') || '';
  return exec(pythonBin, args, texts);
}
