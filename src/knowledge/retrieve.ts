import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import { embed, type EmbedExec } from './embed.js';
import { isVecAvailable, vecKnn } from './vec.js';

/** RRF's standard smoothing constant — see reciprocalRankFusion. */
const RRF_K = 60;
/** How much wider than topK the per-method candidate pool is before fusion (so a chunk
 * ranked, say, #30 in FTS but #1 in vec KNN still has a chance to fuse into the top). */
const CANDIDATE_MULTIPLIER = 4;
const MIN_CANDIDATES = 40;

export interface RetrievedChunk {
  chunk_id: number;
  document_id: number;
  source_id: string;
  source_kind: string;
  path: string;
  uri: string | null;
  section: string | null;
  start_line: number | null;
  end_line: number | null;
  text: string;
  score: number;
}

export interface SearchOpts {
  /** Restrict to documents whose uri starts with this (typically an absolute repo/vault
   * path) — a prefix match, not the knowledge-node 'repo:'/'env:' scope convention. */
  scope?: string;
  /** Restrict to one document kind (the file extension recorded at ingest time, e.g. 'md'). */
  kind?: string;
  /** Max results after fusion (default: rag_top_k setting). */
  topK?: number;
  /** Test injection for embedding the query (see embed.ts). */
  embedExec?: EmbedExec;
}

/**
 * Reciprocal Rank Fusion: combines any number of independently-ranked id lists into one
 * score per id (sum of 1/(k + rank) across every list it appears in, 1-indexed rank).
 * Pure and DB-free so it's directly unit-testable. A single non-empty list degrades to a
 * monotonic transform of that list's own order (i.e. FTS-only or vec-only both "fuse" cleanly).
 */
export function reciprocalRankFusion(rankedLists: number[][], k = RRF_K): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of rankedLists) {
    list.forEach((id, idx) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return scores;
}

interface CandidateFilter {
  kind?: string;
  scope?: string;
  limit: number;
}

/**
 * FTS5 trigram MATCH against chunks_fts, ranked candidate chunk ids. Short queries (<3
 * chars) additionally get a LIKE fallback appended — the trigram tokenizer can't match
 * strings shorter than one trigram (same rationale as store.ts's searchNodes).
 */
function ftsChunkIds(db: Database.Database, q: string, opts: CandidateFilter): number[] {
  const clauses = ['chunks_fts MATCH ?', 'c.invalid_at IS NULL', 'd.invalid_at IS NULL'];
  const params: unknown[] = [`"${q.replace(/"/g, '""')}"`];
  if (opts.kind) {
    clauses.push('d.doc_kind = ?');
    params.push(opts.kind);
  }
  if (opts.scope) {
    clauses.push('d.uri LIKE ?');
    params.push(`${opts.scope}%`);
  }
  params.push(opts.limit);

  let ids: number[] = [];
  try {
    ids = (
      db
        .prepare(
          `SELECT c.id AS id FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             JOIN documents d ON d.id = c.document_id
            WHERE ${clauses.join(' AND ')}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(...params) as { id: number }[]
    ).map((r) => r.id);
  } catch {
    // malformed MATCH query text -- the LIKE fallback below still covers short queries
  }

  if (q.length < 3) {
    const likeClauses = ['(c.text LIKE ? OR c.section LIKE ?)', 'c.invalid_at IS NULL', 'd.invalid_at IS NULL'];
    const likeParams: unknown[] = [`%${q}%`, `%${q}%`];
    if (opts.kind) {
      likeClauses.push('d.doc_kind = ?');
      likeParams.push(opts.kind);
    }
    if (opts.scope) {
      likeClauses.push('d.uri LIKE ?');
      likeParams.push(`${opts.scope}%`);
    }
    likeParams.push(opts.limit);
    const likeIds = (
      db
        .prepare(
          `SELECT c.id AS id FROM chunks c
             JOIN documents d ON d.id = c.document_id
            WHERE ${likeClauses.join(' AND ')}
            LIMIT ?`,
        )
        .all(...likeParams) as { id: number }[]
    ).map((r) => r.id);
    for (const id of likeIds) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Vector KNN candidate ids (ranked by ascending distance). Returns [] — never throws —
 * when rag_enabled is off, the vec0 extension didn't load, or embedding the query failed;
 * callers then naturally degrade to FTS-only via reciprocalRankFusion's single-list case.
 */
async function vecChunkIds(
  db: Database.Database,
  q: string,
  limit: number,
  embedExec?: EmbedExec,
): Promise<number[]> {
  if (!getBool(db, 'rag_enabled') || !isVecAvailable(db)) return [];
  try {
    const [queryVector] = await embed(db, [q], embedExec);
    if (!queryVector) return [];
    return vecKnn(db, 'vec_chunks', queryVector, limit).map((r) => Number(r.refId));
  } catch {
    // embed daemon/one-shot down or errored -- degrade to FTS-only rather than fail the
    // whole search (a task dispatch with rag_inject_task_context on must never break here)
    return [];
  }
}

/**
 * Vector KNN has no metadata filter, so scope/kind are enforced here as a post-filter —
 * a candidate outside the filter is simply dropped rather than backfilled. Fine for the
 * common case (search scoped to one repo/vault whose corpus dominates the candidate pool).
 */
function hydrateChunks(
  db: Database.Database,
  ids: number[],
  scores: Map<number, number>,
  filter: { kind?: string; scope?: string },
): RetrievedChunk[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const clauses = [`c.id IN (${placeholders})`, 'c.invalid_at IS NULL', 'd.invalid_at IS NULL'];
  const params: unknown[] = [...ids];
  if (filter.kind) {
    clauses.push('d.doc_kind = ?');
    params.push(filter.kind);
  }
  if (filter.scope) {
    clauses.push('d.uri LIKE ?');
    params.push(`${filter.scope}%`);
  }
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.document_id AS document_id, c.text AS text, c.section AS section,
              c.start_line AS start_line, c.end_line AS end_line,
              d.path AS path, d.uri AS uri, d.source_id AS source_id, s.kind AS source_kind
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN sources s ON s.id = d.source_id
        WHERE ${clauses.join(' AND ')}`,
    )
    .all(...params) as Omit<RetrievedChunk, 'score'>[];
  return rows
    .map((r) => ({ ...r, score: scores.get(r.chunk_id) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Hybrid RAG search over the corpus layer (documents/chunks): FTS5 trigram keyword
 * ranking fused with vec0 KNN semantic ranking via Reciprocal Rank Fusion, returning
 * citation-bearing results (source/path/lines/score). Degrades cleanly to FTS-only when
 * rag_enabled is off or the vec0 extension isn't loaded — never throws either way.
 */
export async function search(db: Database.Database, q: string, opts: SearchOpts = {}): Promise<RetrievedChunk[]> {
  const topK = opts.topK ?? getNum(db, 'rag_top_k', 8);
  const candidateLimit = Math.max(MIN_CANDIDATES, topK * CANDIDATE_MULTIPLIER);
  const filter = { kind: opts.kind, scope: opts.scope };

  const ftsIds = ftsChunkIds(db, q, { ...filter, limit: candidateLimit });
  const vecIds = await vecChunkIds(db, q, candidateLimit, opts.embedExec);

  const fused = reciprocalRankFusion([ftsIds, vecIds]);
  if (fused.size === 0) return [];

  // Hydrate (and scope/kind-filter) every fused candidate before truncating to topK —
  // truncating first would risk dropping a filter-matching id in favor of one that gets
  // filtered out downstream (vec KNN has no metadata filter of its own; see hydrateChunks).
  const hydrated = hydrateChunks(db, [...fused.keys()], fused, filter);
  return hydrated.slice(0, topK);
}
