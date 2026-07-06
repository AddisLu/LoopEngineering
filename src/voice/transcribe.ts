import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { ENGINE_REPO_ROOT, getVoicePython } from '../config.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 5 * 60_000;

export type TranscribeExec = (pythonBin: string, args: string[]) => Promise<string>;

/** Real one-shot call to scripts/transcribe.py (faster-whisper, RTX 2080 venv). */
async function defaultExec(pythonBin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(pythonBin, args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Transcribe one audio file via scripts/transcribe.py. `exec` is injectable so tests
 * never spawn the real venv/GPU. Any failure (bad audio, no GPU, script error) throws —
 * the route (voiceRoutes.ts) catches it and reports the failure to the client.
 */
export async function transcribe(
  db: Database.Database,
  audioPath: string,
  exec: TranscribeExec = defaultExec,
): Promise<string> {
  const scriptPath = path.join(ENGINE_REPO_ROOT, 'scripts', 'transcribe.py');
  const args = [
    scriptPath,
    '--audio', audioPath,
    '--model', getSetting(db, 'voice_model') || 'large-v3',
    '--terms', getSetting(db, 'voice_terms_path') || '',
    '--lang', 'zh',
  ];
  const stdout = await exec(getVoicePython(), args);
  return stdout.trim();
}
