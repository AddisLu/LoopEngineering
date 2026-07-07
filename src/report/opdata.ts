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

/** Strips whitespace (incl. full-width 　) and half/full-width brackets so that
 * "大型AOI" still matches a registered project name like "【大型AOI】" or "大型 AOI" even
 * after description noise-stripping leaves stray spaces around the keyword. */
function normalizeForMatch(s: string): string {
  return s.replace(/[\s　()（）【】\[\]{}]/g, '');
}

/** Plain Levenshtein edit distance -- no external dep, inputs are always short (candidate
 * keywords / project names, at most a few dozen chars). Used only to tie-break
 * bestRowMatch below, never as a primary match signal. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] ?? Infinity) + 1, (cur[j - 1] ?? Infinity) + 1, (prev[j - 1] ?? Infinity) + cost));
    }
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/** Tiers a candidate query against one project row's name/identifier, higher wins:
 * 3 = exact raw match; 2 = exact once whitespace/brackets are normalized away (this is
 * what makes a bare "大型AOI" query equal a registered "【大型AOI】", not merely a substring
 * of it); 1 = a plain substring relationship either direction, raw or normalized (so a
 * haiku-parsed keyword that over-strips down to something generic like "AOI" still only
 * *ties* with every other project whose name happens to contain "AOI", instead of
 * silently outranking one of them by dint of list order); 0 = no relationship at all. */
function matchTier(query: string, queryNorm: string, rName: string, rIdent: string): number {
  if (query && (query === rName || query === rIdent)) return 3;
  const rNameNorm = normalizeForMatch(rName);
  const rIdentNorm = normalizeForMatch(rIdent);
  if (queryNorm && (queryNorm === rNameNorm || queryNorm === rIdentNorm)) return 2;
  const eitherWayIncludes = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a));
  if (
    eitherWayIncludes(query, rName) ||
    eitherWayIncludes(query, rIdent) ||
    eitherWayIncludes(queryNorm, rNameNorm) ||
    eitherWayIncludes(queryNorm, rIdentNorm)
  ) {
    return 1;
  }
  return 0;
}

interface RowMatch {
  id: unknown;
  name: unknown;
  tier: number;
}

/** Best-matching --list-projects row for one candidate string: ranked by matchTier, ties
 * broken by editDistance to whichever of name/identifier is closer -- so an ambiguous,
 * over-generic candidate (e.g. a haiku parse that over-strips "大型AOI" down to just "AOI")
 * resolves to the project it's actually closest to, not whichever "*AOI*" project happened
 * to sort first in the API response. Shared by resolveProject (one candidate) and
 * fetchProjectWorkPackages (the haiku-parsed project plus salient-keyword-fallback
 * candidates, scored against one shared --list-projects fetch). */
function bestRowMatch(rows: Record<string, unknown>[], name: string): RowMatch | null {
  const query = name.trim().toLowerCase();
  if (!query) return null;
  const queryNorm = normalizeForMatch(query);

  let best: RowMatch | null = null;
  let bestTier = 0;
  let bestDist = Infinity;
  for (const r of rows) {
    const rName = typeof r.name === 'string' ? r.name.toLowerCase() : '';
    const rIdent = typeof r.identifier === 'string' ? r.identifier.toLowerCase() : '';
    const tier = matchTier(query, queryNorm, rName, rIdent);
    if (tier === 0) continue;
    const dist = Math.min(
      editDistance(queryNorm, normalizeForMatch(rName)),
      editDistance(queryNorm, normalizeForMatch(rIdent)),
    );
    if (tier > bestTier || (tier === bestTier && dist < bestDist)) {
      bestTier = tier;
      bestDist = dist;
      best = { id: r.id, name: r.name, tier };
    }
  }
  return best;
}

/**
 * Resolve a human-typed project name/identifier (or a registered source's project) to
 * `{id, name}` by spawning `--list-projects` and fuzzy-matching (see bestRowMatch). Never
 * throws: a missing openproject source, a spawn failure/timeout, or no match all resolve
 * to null.
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
    const best = bestRowMatch(rows, name);
    if (!best || best.id === undefined || best.id === null) return null;
    return { id: String(best.id), name: typeof best.name === 'string' ? best.name : String(best.id) };
  } catch {
    return null;
  }
}

/** Overdue-and-unfinished items sort before other open items, which sort before closed
 * ones — see compareWorkPackages. */
function sortRank(item: OpWorkPackage, today: string): number {
  if (item.is_closed) return 2;
  const overdue = Boolean(item.due_date) && item.due_date < today && item.percent_done < 100;
  return overdue ? 0 : 1;
}

/** Priority order for packing into a limited char budget: not-closed before closed,
 * overdue-and-unfinished first among those, then ascending due_date / percent_done —
 * so the important handful survives truncation on large (100s-of-item) parent-project
 * fetches instead of whatever happened to come back from the API first. */
function compareWorkPackages(a: OpWorkPackage, b: OpWorkPackage, today: string): number {
  const rankDiff = sortRank(a, today) - sortRank(b, today);
  if (rankDiff !== 0) return rankDiff;
  const dueA = a.due_date || '9999-12-31';
  const dueB = b.due_date || '9999-12-31';
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  return a.percent_done - b.percent_done;
}

/**
 * Fetch a project's work packages: try live first (`resolveProject` + `--project
 * --structured`, both spawns timeout+try/catch-guarded), falling back to a fuzzy
 * corpus search (src/knowledge/retrieve.ts's `search`) over the ingested SSoT snapshot
 * when live is off, unconfigured, offline, or the spawn/parse fails. `req.projectCandidates`
 * lets a caller offer alternate names to resolve against (e.g. a salient keyword pulled
 * from a free-text description) — each is tried in order before conceding to the
 * snapshot, so a haiku-parsed project string that doesn't match a live project no longer
 * gives up immediately. Never throws.
 */
export async function fetchProjectWorkPackages(
  db: Database.Database,
  req: { project: string; topic?: string; projectCandidates?: string[] },
  exec: OpDataExec = defaultExec,
  searchFn: SearchFn = search,
): Promise<FetchWorkPackagesResult> {
  const liveFirst = getBool(db, 'report_live_first', true);

  if (liveFirst) {
    try {
      const opConfig = findOpenProjectConfig(db);
      if (opConfig) {
        const candidates = [req.project, ...(req.projectCandidates ?? [])]
          .map((c) => c.trim())
          .filter((c, idx, arr) => c && arr.indexOf(c) === idx);
        if (candidates.length) {
          const pythonBin = getSetting(db, 'ingest_openproject_python') || 'python3';
          // One shared --list-projects fetch for every candidate (was one spawn per
          // candidate) -- fewer round trips, and every candidate is ranked against the
          // same snapshot instead of racing separate fetches.
          const listStdout = await exec(pythonBin, buildArgs(opConfig, ['--list-projects']));
          const rows = parseJsonLines(listStdout);

          let resolved: RowMatch | null = null;
          for (const candidate of candidates) {
            const match = bestRowMatch(rows, candidate);
            if (match && (!resolved || match.tier > resolved.tier)) resolved = match;
          }

          if (resolved && resolved.id !== undefined && resolved.id !== null) {
            const project: OpProjectRef = {
              id: String(resolved.id),
              name: typeof resolved.name === 'string' ? resolved.name : String(resolved.id),
            };
            const today = new Date().toISOString().slice(0, 10);
            const stdout = await exec(pythonBin, buildArgs(opConfig, ['--project', project.id, '--structured']));
            const items = parseJsonLines(stdout)
              .map(toWorkPackage)
              .filter((wp): wp is OpWorkPackage => wp !== null)
              .sort((a, b) => compareWorkPackages(a, b, today));
            return { source: 'live', project, items };
          }
        }
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
