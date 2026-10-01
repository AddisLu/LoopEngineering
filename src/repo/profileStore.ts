import type Database from 'better-sqlite3';
import { getRepo } from './store.js';
import { listMachines } from '../exec/machines.js';
import { getHostSpecs, readSpecs } from '../exec/specs.js';
import { repoScope } from '../knowledge/types.js';
import { readMeta } from '../knowledge/learn.js';
import { machineFit, type FitBox, type FitRequirement, type FitResult } from './fit.js';

/**
 * Repo 檔案 storage: one repo_profiles row (stage A's facts as JSON + the job state), the code
 * index rows, and the reads the 知識 page needs — the profile with its machine fit, the facet
 * knowledge nodes of the repo (approved + drafts), the 一次改對率, and the index search.
 * Shapes of the facts are src/repo/profile/types.ts; this file only stores and serves them.
 */

export type ProfileStatus = 'idle' | 'running' | 'ready' | 'failed';

export interface ProfileRow {
  repo_id: string;
  sha: string | null;
  facets_json: string | null;
  status: ProfileStatus;
  stage: string | null;
  error: string | null;
  built_at: string | null;
  inferred_sha: string | null;
  inferred_at: string | null;
}

export interface StoredIndexEntry {
  kind: string;
  key: string;
  section: string | null;
  file: string;
  line: number;
  text: string;
  value: string | null;
  meaning: string | null;
}

export function getProfileRow(db: Database.Database, repoId: string): ProfileRow | null {
  return (db.prepare('SELECT * FROM repo_profiles WHERE repo_id = ?').get(repoId) as ProfileRow | undefined) ?? null;
}

export function setProfileState(db: Database.Database, repoId: string, status: ProfileStatus, o: { stage?: string | null; error?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO repo_profiles (repo_id, status, stage, error) VALUES (@repo, @status, @stage, @error)
     ON CONFLICT(repo_id) DO UPDATE SET status = @status, stage = @stage, error = @error`,
  ).run({ repo: repoId, status, stage: o.stage ?? null, error: o.error ?? null });
}

/** Stage A's result: the facts, and the code index rebuilt from scratch (one transaction). */
export function saveStageA(db: Database.Database, repoId: string, facets: { sha: string | null } & Record<string, unknown>, index: StoredIndexEntry[]): void {
  const ins = db.prepare('INSERT INTO code_index (repo_id, kind, key, section, file, line, text, value, meaning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM code_index WHERE repo_id = ?').run(repoId);
    for (const e of index.slice(0, 20_000)) {
      ins.run(repoId, e.kind, String(e.key).slice(0, 300), e.section, e.file, e.line ?? null, (e.text ?? '').slice(0, 300), e.value, e.meaning ? e.meaning.slice(0, 400) : null);
    }
    db.prepare(
      `INSERT INTO repo_profiles (repo_id, sha, facets_json, status, stage, error, built_at) VALUES (?, ?, ?, 'ready', NULL, NULL, datetime('now'))
       ON CONFLICT(repo_id) DO UPDATE SET sha = excluded.sha, facets_json = excluded.facets_json, status = 'ready', stage = NULL, error = NULL, built_at = excluded.built_at`,
    ).run(repoId, facets.sha, JSON.stringify(facets));
  })();
}

export function readFacets<T = Record<string, unknown>>(row: Pick<ProfileRow, 'facets_json'> | null): T | null {
  if (!row?.facets_json) return null;
  try {
    return JSON.parse(row.facets_json) as T;
  } catch {
    return null;
  }
}

/** Every box a repo could be verified on: the enabled machines and this Spark. */
export function fitBoxes(db: Database.Database): FitBox[] {
  const boxes: FitBox[] = listMachines(db, { enabledOnly: true }).map((m) => ({
    name: m.name,
    where: 'machine',
    specs: readSpecs(m.specs_json),
    text: [m.software, m.description, m.labels].filter(Boolean).join('\n'),
  }));
  const local = getHostSpecs(db, 'local');
  boxes.push({ name: '引擎主機（這台 Spark）', where: 'engine', specs: readSpecs(local?.specs_json), text: local?.software ?? '' });
  return boxes;
}

export function fitFor(db: Database.Database, requirements: FitRequirement[]): FitResult[] {
  return requirements.length ? machineFit(requirements, fitBoxes(db)) : [];
}

export interface FacetNodeView {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  source: string;
  weight: number;
  facet: string | null;
  evidence: Array<{ task?: string; note?: string; file?: string; line?: number }>;
  hits: { shown: number; passed: number } | null;
  trigger: { words: string[]; files: string[]; kinds: string[] } | null;
  updated_at: string;
}

/** The facet nodes of one repo (approved and drafts), grouped by kind. */
export function facetNodes(db: Database.Database, repoPath: string): Record<string, FacetNodeView[]> {
  const rows = db
    .prepare(
      `SELECT id, kind, title, body, status, source, weight, facet, meta_json, updated_at FROM knowledge_nodes
        WHERE scope = ? AND facet IS NOT NULL AND invalid_at IS NULL AND status != 'rejected'
        ORDER BY status = 'draft' DESC, weight DESC, updated_at DESC`,
    )
    .all(repoScope(repoPath)) as Array<Omit<FacetNodeView, 'evidence' | 'hits' | 'trigger'> & { meta_json: string | null }>;
  const out: Record<string, FacetNodeView[]> = {};
  for (const r of rows) {
    const m = readMeta(r);
    let evidence: FacetNodeView['evidence'] = m?.evidence ?? [];
    if (!m && r.meta_json) {
      try {
        evidence = ((JSON.parse(r.meta_json) as { evidence?: FacetNodeView['evidence'] }).evidence ?? []).slice(0, 5);
      } catch {
        /* no evidence */
      }
    }
    const { meta_json: _drop, ...rest } = r;
    (out[r.kind] ??= []).push({ ...rest, evidence, hits: m?.hits ?? null, trigger: m?.trigger ?? null });
  }
  return out;
}

/**
 * 一次改對率 of a repo: of its finished tickets (merged or closed), the share whose first attempt
 * passed every check and that nobody sent back.
 */
export function firstPassRate(db: Database.Database, repoId: string): { rate: number | null; n: number; first: number } {
  const tasks = db.prepare("SELECT id FROM tasks WHERE repo_id = ? AND (status = 'closed' OR merge_status = 'merged')").all(repoId) as Array<{ id: string }>;
  let first = 0;
  for (const t of tasks) {
    const run = db.prepare('SELECT verify_json FROM task_runs WHERE task_id = ? AND verify_json IS NOT NULL ORDER BY started_at, rowid LIMIT 1').get(t.id) as { verify_json: string } | undefined;
    let ok = false;
    try {
      const steps = JSON.parse(run?.verify_json ?? '[]') as Array<{ ok: boolean }>;
      ok = steps.length > 0 && steps.every((s) => s.ok);
    } catch {
      ok = false;
    }
    const returned = db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'status' AND detail LIKE '退回修改%' LIMIT 1").get(t.id);
    if (ok && !returned) first++;
  }
  return { rate: tasks.length ? first / tasks.length : null, n: tasks.length, first };
}

export function indexCounts(db: Database.Database, repoId: string): Record<string, number> {
  const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM code_index WHERE repo_id = ? GROUP BY kind').all(repoId) as Array<{ kind: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

/** 參數與告警 search: exact key first, then full-text (trigram needs ≥ 3 chars), then LIKE. */
export function searchIndex(db: Database.Database, repoId: string, q: string, o: { kind?: string | null; limit?: number } = {}): StoredIndexEntry[] {
  const limit = Math.min(200, Math.max(1, o.limit ?? 50));
  const kindSql = o.kind ? ' AND c.kind = ?' : '';
  const kindArg = o.kind ? [o.kind] : [];
  const term = q.trim();
  const cols = 'c.kind, c.key, c.section, c.file, c.line, c.text, c.value, c.meaning';
  if (!term) {
    return db.prepare(`SELECT ${cols} FROM code_index c WHERE c.repo_id = ?${kindSql} ORDER BY c.kind, c.key LIMIT ?`).all(repoId, ...kindArg, limit) as StoredIndexEntry[];
  }
  const seen = new Set<string>();
  const out: StoredIndexEntry[] = [];
  const push = (rows: StoredIndexEntry[]) => {
    for (const r of rows) {
      const k = `${r.kind}|${r.key}|${r.file}|${r.line}`;
      if (seen.has(k) || out.length >= limit) continue;
      seen.add(k);
      out.push(r);
    }
  };
  push(db.prepare(`SELECT ${cols} FROM code_index c WHERE c.repo_id = ? AND c.key = ?${kindSql} ORDER BY c.kind LIMIT ?`).all(repoId, term, ...kindArg, limit) as StoredIndexEntry[]);
  if (term.length >= 3) {
    try {
      push(
        db
          .prepare(`SELECT ${cols} FROM code_index_fts f JOIN code_index c ON c.id = f.rowid WHERE code_index_fts MATCH ? AND c.repo_id = ?${kindSql} ORDER BY bm25(code_index_fts) LIMIT ?`)
          .all(`"${term.replace(/"/g, '')}"`, repoId, ...kindArg, limit) as StoredIndexEntry[],
      );
    } catch {
      /* an FTS query it cannot parse: LIKE below */
    }
  }
  push(db.prepare(`SELECT ${cols} FROM code_index c WHERE c.repo_id = ? AND (c.key LIKE ? OR c.text LIKE ?)${kindSql} LIMIT ?`).all(repoId, `%${term}%`, `%${term}%`, ...kindArg, limit) as StoredIndexEntry[]);
  return out;
}

/** The whole Repo 檔案 for the page. */
export function profileView(db: Database.Database, repoId: string) {
  const repo = getRepo(db, repoId);
  if (!repo) return null;
  const row = getProfileRow(db, repoId);
  const facets = readFacets<{ requirements?: FitRequirement[] } & Record<string, unknown>>(row);
  return {
    repo: { id: repo.id, name: repo.name, local_path: repo.local_path, default_branch: repo.default_branch, machine: repo.machine },
    status: row?.status ?? 'idle',
    stage: row?.stage ?? null,
    error: row?.error ?? null,
    sha: row?.sha ?? null,
    built_at: row?.built_at ?? null,
    inferred_at: row?.inferred_at ?? null,
    facets,
    fit: fitFor(db, facets?.requirements ?? []),
    nodes: facetNodes(db, repo.local_path),
    first_pass: firstPassRate(db, repoId),
    index_counts: indexCounts(db, repoId),
  };
}
