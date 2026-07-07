import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting } from '../../db/index.js';
import { ENGINE_REPO_ROOT } from '../../config.js';
import type { SourceRow } from './types.js';
import { parseSourceConfig } from './types.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10 * 60_000;

export interface OpenProjectDoc {
  ext_id: string;
  title: string;
  text: string;
  uri: string | null;
  doc_kind: string;
  updated_at: string | null;
}

/** Injectable so tests never spawn a real python process (see scripts/openproject_dump.py). */
export type OpenProjectDumpExec = (pythonBin: string, args: string[]) => Promise<string>;

async function defaultExec(pythonBin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(pythonBin, args, { timeout: TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

function isOpenProjectDoc(v: unknown): v is Record<string, unknown> & { ext_id: string; title: string; text: string; doc_kind: string } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.ext_id === 'string' && typeof o.title === 'string' && typeof o.text === 'string' && typeof o.doc_kind === 'string';
}

/**
 * Parses the dump script's line-delimited JSON stdout. A blank, malformed, or
 * incomplete line is silently skipped rather than thrown — one corrupted work package
 * must not blank out an entire ingest run (see plan-OP-ingest.md's "壞行略過不 crash").
 */
export function parseOpenProjectDump(stdout: string): OpenProjectDoc[] {
  const out: OpenProjectDoc[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isOpenProjectDoc(parsed)) continue;
    out.push({
      ext_id: parsed.ext_id,
      title: parsed.title,
      text: parsed.text,
      uri: typeof parsed.uri === 'string' ? parsed.uri : null,
      doc_kind: parsed.doc_kind,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    });
  }
  return out;
}

/**
 * Spawns scripts/openproject_dump.py (stdlib-only Python, reuses the user's existing
 * op_api.py — see plan-OP-ingest.md) and parses its line-delimited JSON stdout. A
 * source without `op_repo` configured (or a non-openproject source) yields no docs.
 * The child's non-zero exit rejects the returned promise (propagated to the caller as
 * an ingest failure), matching the script's "非零 exit 表失敗" contract.
 */
export async function dumpOpenProjectSource(
  db: Database.Database,
  source: SourceRow,
  exec: OpenProjectDumpExec = defaultExec,
): Promise<OpenProjectDoc[]> {
  const config = parseSourceConfig(source.config);
  if (!config.op_repo) return [];

  const scriptPath = path.join(ENGINE_REPO_ROOT, 'scripts', 'openproject_dump.py');
  const args = [scriptPath, '--op-repo', config.op_repo];
  if (config.op_config) args.push('--op-config', config.op_config);
  if (config.kinds && config.kinds.length) args.push('--kinds', config.kinds.join(','));

  const pythonBin = getSetting(db, 'ingest_openproject_python') || 'python3';
  const stdout = await exec(pythonBin, args);
  return parseOpenProjectDump(stdout);
}
