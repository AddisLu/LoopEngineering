import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { ENGINE_REPO_ROOT } from '../config.js';
import { listSources } from '../knowledge/ingest/sources.js';
import { parseSourceConfig } from '../knowledge/ingest/types.js';
import { search, type SearchOpts, type RetrievedChunk } from '../knowledge/retrieve.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 60_000;

/** Injectable spawn of scripts/openproject_dump.py (see src/knowledge/ingest/openproject.ts's
 * OpenProjectDumpExec — same shape, separate type so report code never depends on ingest). */
export type OpDataExec = (pythonBin: string, args: string[]) => Promise<string>;

export type SearchFn = (db: Database.Database, q: string, opts?: SearchOpts) => Promise<RetrievedChunk[]>;

async function defaultExec(pythonBin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(pythonBin, args, { timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

export interface OpProjectRef {
  id: string;
  name: string;
}

/** One work package, fields mirroring scripts/openproject_dump.py's --structured output
 * (itself derived from op_api.py's _normalize_wp — see that script for field provenance). */
export interface OpWorkPackage {
  id: number | string;
  subject: string;
  status: string;
  is_closed: boolean;
  type: string;
  assignee_name: string;
  project_id: number | string | null;
  project_name: string;
  start_date: string;
  due_date: string;
  percent_done: number;
  estimated_hours: number;
  spent_hours: number;
  remaining_hours: number;
  description: string;
  custom_fields: Record<string, unknown>;
  updated_at: string;
}

/** A corpus-search fallback item — no live OpenProject fields, just a citation-bearing
 * text snippet (see fetchProjectWorkPackages's snapshot path). */
export interface OpSnapshotItem {
  text: string;
  path: string;
  uri: string | null;
}

export interface FetchWorkPackagesResult {
  source: 'live' | 'snapshot';
  project: OpProjectRef | null;
  items: OpWorkPackage[] | OpSnapshotItem[];
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // malformed line -- skip, never crash a whole fetch over one bad line
    }
  }
  return out;
}

function toWorkPackage(o: Record<string, unknown>): OpWorkPackage | null {
  if (o.id === undefined || o.id === null) return null;
  return {
    id: o.id as number | string,
    subject: typeof o.subject === 'string' ? o.subject : '',
    status: typeof o.status === 'string' ? o.status : '',
    is_closed: Boolean(o.is_closed),
    type: typeof o.type === 'string' ? o.type : '',
    assignee_name: typeof o.assignee_name === 'string' ? o.assignee_name : '',
    project_id: (o.project_id as number | string | null) ?? null,
    project_name: typeof o.project_name === 'string' ? o.project_name : '',
    start_date: typeof o.start_date === 'string' ? o.start_date : '',
    due_date: typeof o.due_date === 'string' ? o.due_date : '',
    percent_done: typeof o.percent_done === 'number' ? o.percent_done : Number(o.percent_done) || 0,
    estimated_hours: typeof o.estimated_hours === 'number' ? o.estimated_hours : Number(o.estimated_hours) || 0,
    spent_hours: typeof o.spent_hours === 'number' ? o.spent_hours : Number(o.spent_hours) || 0,
    remaining_hours: typeof o.remaining_hours === 'number' ? o.remaining_hours : Number(o.remaining_hours) || 0,
    description: typeof o.description === 'string' ? o.description : '',
    custom_fields: o.custom_fields && typeof o.custom_fields === 'object' ? (o.custom_fields as Record<string, unknown>) : {},
    updated_at: typeof o.updated_at === 'string' ? o.updated_at : '',
  };
}

/** First registered enabled `kind='openproject'` source's config — mirrors how
 * ingestAll() picks up sources, but a report only ever needs one op_repo/op_config pair. */
function findOpenProjectConfig(db: Database.Database): { op_repo: string; op_config?: string } | null {
  const source = listSources(db, { enabled: true }).find((s) => s.kind === 'openproject');
  if (!source) return null;
  const config = parseSourceConfig(source.config);
  if (!config.op_repo) return null;
  return { op_repo: config.op_repo, op_config: config.op_config };
}

function buildArgs(opConfig: { op_repo: string; op_config?: string }, extra: string[]): string[] {
  const scriptPath = path.join(ENGINE_REPO_ROOT, 'scripts', 'openproject_dump.py');
  const args = [scriptPath, '--op-repo', opConfig.op_repo];
  if (opConfig.op_config) args.push('--op-config', opConfig.op_config);
  args.push(...extra);
  return args;
}

/**
 * Resolve a human-typed project name/identifier (or a registered source's project) to
 * `{id, name}` by spawning `--list-projects` and fuzzy-matching. Never throws: a missing
 * openproject source, a spawn failure/timeout, or no match all resolve to null.
 */
export async function resolveProject(
  db: Database.Database,
  name: string,
  exec: OpDataExec = defaultExec,
): Promise<OpProjectRef | null> {
  const opConfig = findOpenProjectConfig(db);
  if (!opConfig) return null;

  const pythonBin = getSetting(db, 'ingest_openproject_python') || 'python3';
  try {
    const stdout = await exec(pythonBin, buildArgs(opConfig, ['--list-projects']));
    const rows = parseJsonLines(stdout);
    const query = name.trim().toLowerCase();
    if (!query) return null;

    let best: { id: unknown; name: unknown } | null = null;
    let bestScore = -1;
    for (const r of rows) {
      const rName = typeof r.name === 'string' ? r.name.toLowerCase() : '';
      const rIdent = typeof r.identifier === 'string' ? r.identifier.toLowerCase() : '';
      let score = -1;
      if (query === rName || query === rIdent) score = 2;
      else if (rName.includes(query) || rIdent.includes(query)) score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = { id: r.id, name: r.name };
      }
    }
    if (!best || bestScore < 0 || best.id === undefined || best.id === null) return null;
    return { id: String(best.id), name: typeof best.name === 'string' ? best.name : String(best.id) };
  } catch {
    return null;
  }
}

/**
 * Fetch a project's work packages: try live first (`resolveProject` + `--project
 * --structured`, both spawns timeout+try/catch-guarded), falling back to a fuzzy
 * corpus search (src/knowledge/retrieve.ts's `search`) over the ingested SSoT snapshot
 * when live is off, unconfigured, offline, or the spawn/parse fails. Never throws.
 */
export async function fetchProjectWorkPackages(
  db: Database.Database,
  req: { project: string; topic?: string },
  exec: OpDataExec = defaultExec,
  searchFn: SearchFn = search,
): Promise<FetchWorkPackagesResult> {
  const liveFirst = getBool(db, 'report_live_first', true);

  if (liveFirst) {
    try {
      const opConfig = findOpenProjectConfig(db);
      const resolved = opConfig ? await resolveProject(db, req.project, exec) : null;
      if (opConfig && resolved) {
        const pythonBin = getSetting(db, 'ingest_openproject_python') || 'python3';
        const stdout = await exec(pythonBin, buildArgs(opConfig, ['--project', resolved.id, '--structured']));
        const items = parseJsonLines(stdout)
          .map(toWorkPackage)
          .filter((wp): wp is OpWorkPackage => wp !== null);
        return { source: 'live', project: resolved, items };
      }
    } catch {
      // fall through to the snapshot search below
    }
  }

  try {
    const topK = getNum(db, 'rag_top_k', 8);
    const query = `${req.project} ${req.topic ?? ''}`.trim();
    const chunks = await searchFn(db, query, { topK });
    const items: OpSnapshotItem[] = chunks.map((c) => ({ text: c.text, path: c.path, uri: c.uri }));
    return { source: 'snapshot', project: req.project ? { id: '', name: req.project } : null, items };
  } catch {
    return { source: 'snapshot', project: req.project ? { id: '', name: req.project } : null, items: [] };
  }
}
