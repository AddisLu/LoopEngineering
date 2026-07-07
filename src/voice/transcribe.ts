import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { ENGINE_REPO_ROOT, getVoicePython } from '../config.js';
import { seedGlossaryTerms, glossaryTermsForPrompt } from './glossary.js';
import { WarmWorker, realSpawn } from './daemon.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 5 * 60_000;

export type TranscribeExec = (pythonBin: string, args: string[]) => Promise<string>;

export interface TranscribeDeps {
  /** Injectable warm-worker handle (real WarmWorker duck-types this); tests fake it. */
  warmWorker?: { transcribe(audioPath: string, termsFile: string): Promise<string> };
  readFile?: (p: string) => string;
  writeFile?: (p: string, content: string) => void;
}

/** Real one-shot call to scripts/transcribe.py (faster-whisper, RTX 2080 venv). */
async function defaultExec(pythonBin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(pythonBin, args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

let warmWorkerSingleton: WarmWorker | null = null;

/** Lazily-created process-wide singleton — only ever spawns the real daemon (never in
 * tests, which always inject their own `deps.warmWorker` fake). */
function getWarmWorkerSingleton(db: Database.Database): WarmWorker {
  if (!warmWorkerSingleton) {
    warmWorkerSingleton = new WarmWorker(
      realSpawn,
      getVoicePython(),
      path.join(ENGINE_REPO_ROOT, 'scripts', 'transcribe_daemon.py'),
      () => getNum(db, 'voice_worker_idle_min', 10),
      TIMEOUT_MS,
    );
  }
  return warmWorkerSingleton;
}

/** Idempotently seed terms.txt into the knowledge base (first use only — a no-op once
 * every term already exists there), then write the knowledge-base glossary out to a
 * fresh temp file — this is what's actually handed to the transcriber (daemon or
 * one-shot) via `--terms`/`terms_file`. The knowledge base is the sole source of truth
 * for the prompt; terms.txt is only read again here as a fallback if the knowledge base
 * has no glossary nodes at all. */
function buildMergedTermsFile(
  db: Database.Database,
  readFile?: (p: string) => string,
  writeFile?: (p: string, content: string) => void,
): string {
  const termsPath = getSetting(db, 'voice_terms_path') || '';
  seedGlossaryTerms(db, termsPath, readFile);
  const terms = glossaryTermsForPrompt(db, termsPath, readFile);
  const tmpPath = path.join(os.tmpdir(), `loop-voice-terms-${randomUUID()}.txt`);
  const write = writeFile ?? ((p: string, content: string) => fs.writeFileSync(p, content, 'utf8'));
  write(tmpPath, terms.join('\n'));
  return tmpPath;
}

/**
 * Transcribe one audio file. The glossary prompt is built from the knowledge base alone
 * (terms.txt is a one-time seed plus an empty-knowledge-base fallback — see
 * glossaryTermsForPrompt) before every call. When `voice_warm_worker` is on (default), the
 * singleton daemon is
 * tried first — any failure (dead process, timeout, bad response) falls back to the
 * one-shot `scripts/transcribe.py` via `exec` transparently. `exec`/`deps` are injectable
 * so tests never spawn the real venv/GPU/daemon: the real `getWarmWorkerSingleton` is only
 * ever reached when `exec` is left at its default (i.e. nobody injected a fake one-shot
 * exec) — a caller that injects `exec` without a `deps.warmWorker` is explicitly opting
 * out of the daemon path for that call, exactly like existing one-shot-exec tests do.
 */
export async function transcribe(
  db: Database.Database,
  audioPath: string,
  exec: TranscribeExec = defaultExec,
  deps: TranscribeDeps = {},
): Promise<string> {
  const termsFile = buildMergedTermsFile(db, deps.readFile, deps.writeFile);

  if (getBool(db, 'voice_warm_worker', true) && (deps.warmWorker || exec === defaultExec)) {
    const worker = deps.warmWorker ?? getWarmWorkerSingleton(db);
    try {
      return (await worker.transcribe(audioPath, termsFile)).trim();
    } catch {
      // daemon down/dead/timed out -- fall through to the one-shot script below
    }
  }

  const scriptPath = path.join(ENGINE_REPO_ROOT, 'scripts', 'transcribe.py');
  const args = [
    scriptPath,
    '--audio', audioPath,
    '--model', getSetting(db, 'voice_model') || 'large-v3',
    '--terms', termsFile,
    '--lang', 'zh',
  ];
  const stdout = await exec(getVoicePython(), args);
  return stdout.trim();
}
