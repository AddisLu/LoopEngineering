import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { getBool, getNum } from '../db/index.js';
import type { Task } from '../types.js';
import type { Kind, KnowledgeNode } from './types.js';
import { repoScope, envScope } from './types.js';
import { search } from './retrieve.js';
import type { EmbedExec } from './embed.js';

/** Injection priority within a tier — lower sorts first. Ties fall through to weight/recency. */
const KIND_RANK: Record<Kind, number> = {
  environment: 0,
  constraint: 0,
  preference: 1,
  repo: 2,
  project: 2,
  tech: 3,
  fact: 4,
  person: 5,
  // facet nodes never reach this section (selectKnowledge skips them); ranks only satisfy the type
  requirement: 9,
  style: 9,
  module: 9,
  pitfall: 9,
  playbook: 9,
  param: 9,
  case: 9,
};

/** Single-line + minimal markdown escape so a node's free-text body can't break the list layout. */
export function mdInline(s: string): string {
  return s
    .replace(/\r?\n+/g, ' ')
    .replace(/[*_`~[\]]/g, (c) => `\\${c}`)
    .trim();
}

function renderLine(n: KnowledgeNode): string {
  return `- **[${n.kind}] ${mdInline(n.title)}**：${mdInline(n.body)}`;
}

interface RankedNode {
  n: KnowledgeNode;
  tier: 0 | 1;
  /** 0..1 overlap with what this task is actually about (see relevance()) */
  score: number;
}

/** Kinds that are about safety/environment: a task must see these even if they look unrelated. */
const CRITICAL: ReadonlySet<Kind> = new Set<Kind>(['environment', 'constraint']);
/** Share of the budget held for CRITICAL nodes before relevance gets the rest. */
const CRITICAL_SHARE = 0.45;

/**
 * Tokens for relevance matching. Latin words ≥3 chars plus CJK bigrams — the same reason
 * the FTS index is trigram: Chinese has no spaces, so whole-string matching finds nothing.
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? '').toLowerCase();
  for (const w of s.match(/[a-z0-9_./-]{3,}/g) ?? []) out.add(w);
  for (const run of s.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/**
 * How much this node looks like it is about the task, 0..1. Title and tags count for more
 * than body text: a node titled "HPE 5945 交換機" is about switches even if its body mentions
 * a dozen other things. Deliberately lexical (no embedding call): injection happens inside
 * dispatch, which must never wait on a model.
 */
export function relevance(n: Pick<KnowledgeNode, 'title' | 'body' | 'tags'>, q: Set<string>): number {
  if (!q.size) return 0;
  const hit = (text: string, weight: number) => {
    const t = tokens(text);
    let m = 0;
    for (const token of q) if (t.has(token)) m += weight;
    return m;
  };
  let tags = '';
  try {
    tags = (JSON.parse(n.tags ?? '[]') as string[]).join(' ');
  } catch {
    tags = '';
  }
  const raw = hit(n.title, 3) + hit(tags, 2) + hit(n.body, 1);
  // normalise by the query size so a long goal does not score everything highly
  return Math.min(1, raw / Math.max(3, q.size));
}

function rank(a: RankedNode, b: RankedNode): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  // relevance leads, in coarse buckets so near-ties keep the old, predictable ordering
  const sa = Math.round(a.score * 20);
  const sb = Math.round(b.score * 20);
  if (sa !== sb) return sb - sa;
  const ka = KIND_RANK[a.n.kind] ?? 9;
  const kb = KIND_RANK[b.n.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  if (a.n.weight !== b.n.weight) return b.n.weight - a.n.weight;
  return b.n.updated_at.localeCompare(a.n.updated_at);
}

export interface KnowledgeItem {
  id: string;
  title: string;
  kind: Kind;
  scope: string;
  weight: number;
  tier: 0 | 1;
  score: number;
  chars: number;
  included: boolean;
}

export interface KnowledgeSelection {
  /** the rendered block, or null when there is nothing to inject */
  text: string | null;
  budget: number;
  used: number;
  /** scopes that were searched (global + this task's repo/env) */
  scopes: string[];
  /** approved nodes that exist but sit in another scope — the usual reason a task gets nothing */
  skipped: Array<{ scope: string; count: number }>;
  items: KnowledgeItem[];
  enabled: boolean;
}

/**
 * Which knowledge a dispatched task gets, and why. knowledgeContext() renders this; the board's
 * preview shows the whole thing so "did my knowledge reach the task" is answerable before the
 * task ever runs.
 *
 * Selection: approved+active nodes seeded by scope (global / this repo / this task's env) plus
 * one active edge hop, scored against the task's own text, then packed into knowledge_budget_chars
 * with a share reserved for environment/constraint nodes so a relevant fact can never push a
 * safety constraint out of the prompt.
 */
export function selectKnowledge(db: Database.Database, task: Task): KnowledgeSelection {
  const budget = getNum(db, 'knowledge_budget_chars', 2500);
  const enabled = getBool(db, 'knowledge_inject', true);
  const seedScopes = ['global'];
  if (task.repo_path) seedScopes.push(repoScope(task.repo_path));
  if (task.environment) seedScopes.push(envScope(task.environment));
  const empty: KnowledgeSelection = { text: null, budget, used: 0, scopes: seedScopes, skipped: [], items: [], enabled };
  if (!enabled) return empty;

  const seedPlaceholders = seedScopes.map(() => '?').join(', ');
  const tier0 = db
    .prepare(
      `SELECT * FROM knowledge_nodes
        WHERE status = 'approved' AND invalid_at IS NULL AND facet IS NULL AND scope IN (${seedPlaceholders})`,
    )
    .all(...seedScopes) as KnowledgeNode[];

  const skipped = db
    .prepare(
      `SELECT scope, COUNT(*) AS count FROM knowledge_nodes
        WHERE status = 'approved' AND invalid_at IS NULL AND facet IS NULL AND scope NOT IN (${seedPlaceholders})
        GROUP BY scope ORDER BY count DESC`,
    )
    .all(...seedScopes) as Array<{ scope: string; count: number }>;

  const tier0Ids = new Set(tier0.map((n) => n.id));
  let tier1: KnowledgeNode[] = [];
  if (tier0.length) {
    const idPlaceholders = tier0.map(() => '?').join(', ');
    const edges = db
      .prepare(
        `SELECT src, dst FROM knowledge_edges
          WHERE invalid_at IS NULL AND status = 'approved'
            AND (src IN (${idPlaceholders}) OR dst IN (${idPlaceholders}))`,
      )
      .all(...tier0.map((n) => n.id), ...tier0.map((n) => n.id)) as { src: string; dst: string }[];

    const neighborIds = new Set<string>();
    for (const e of edges) {
      if (tier0Ids.has(e.src) && !tier0Ids.has(e.dst)) neighborIds.add(e.dst);
      if (tier0Ids.has(e.dst) && !tier0Ids.has(e.src)) neighborIds.add(e.src);
    }
    if (neighborIds.size) {
      const nIds = [...neighborIds];
      const nPlaceholders = nIds.map(() => '?').join(', ');
      tier1 = db
        .prepare(
          `SELECT * FROM knowledge_nodes
            WHERE status = 'approved' AND invalid_at IS NULL AND facet IS NULL AND id IN (${nPlaceholders})`,
        )
        .all(...nIds) as KnowledgeNode[];
    }
  }

  const q = tokens([task.title, task.goal, task.requires ?? '', task.environment ?? ''].join(' '));
  const ranked: RankedNode[] = [
    ...tier0.map((n) => ({ n, tier: 0 as const, score: relevance(n, q) })),
    ...tier1.map((n) => ({ n, tier: 1 as const, score: relevance(n, q) })),
  ].sort(rank);

  if (ranked.length === 0) return { ...empty, skipped };

  // pass 1: safety first, up to its share; pass 2: everything else by relevance
  const chosen = new Set<string>();
  let used = 0;
  const fits = (line: string, cap: number) => used + line.length + (chosen.size ? 1 : 0) <= cap;
  const take = (r: RankedNode, line: string) => {
    used += line.length + (chosen.size ? 1 : 0);
    chosen.add(r.n.id);
  };
  const criticalCap = Math.floor(budget * CRITICAL_SHARE);
  for (const r of ranked) {
    if (!CRITICAL.has(r.n.kind)) continue;
    const line = renderLine(r.n);
    if (fits(line, criticalCap)) take(r, line);
  }
  for (const r of ranked) {
    if (chosen.has(r.n.id)) continue;
    const line = renderLine(r.n);
    if (fits(line, budget)) take(r, line);
  }
  if (!chosen.size) {
    // nothing fit: always include the highest-ranked node, truncated to the budget
    const first = ranked[0]!;
    const line = renderLine(first.n).slice(0, Math.max(0, budget));
    chosen.add(first.n.id);
    used = line.length;
  }

  const lines: string[] = [];
  for (const r of ranked) {
    if (!chosen.has(r.n.id)) continue;
    const line = renderLine(r.n);
    lines.push(line.length <= budget ? line : line.slice(0, Math.max(0, budget)));
  }

  return {
    text: lines.length ? lines.join('\n') : null,
    budget,
    used,
    scopes: seedScopes,
    skipped,
    enabled,
    items: ranked.map((r) => ({
      id: r.n.id,
      title: r.n.title,
      kind: r.n.kind,
      scope: r.n.scope,
      weight: r.n.weight,
      tier: r.tier,
      score: Math.round(r.score * 100) / 100,
      chars: renderLine(r.n).length,
      included: chosen.has(r.n.id),
    })),
  };
}

/**
 * Builds the packed `## Knowledge / Environment` body for a dispatched task. Returns null when
 * knowledge_inject is off or nothing matched — callers must OMIT the section entirely in that
 * case (zero-impact invariant with an empty KB).
 */
export function knowledgeContext(db: Database.Database, task: Task): string | null {
  return selectKnowledge(db, task).text;
}

function renderChunkLine(r: { path: string; start_line: number | null; end_line: number | null; text: string }): string {
  const lineRef = r.start_line != null ? `:${r.start_line}-${r.end_line ?? r.start_line}` : '';
  return `- **[${mdInline(r.path)}${lineRef}]**：${mdInline(r.text)}`;
}

/**
 * Best-effort realpath so a symlinked repo_path dedups to the same corpus scope as its
 * target (same idea as repoScope) — falls back to the raw path if it doesn't exist yet.
 * NOT the same string as repoScope()'s 'repo:<realpath>' knowledge scope: retrieve.ts's
 * `scope` is a plain path prefix matched against documents.uri, a separate convention.
 */
function ragScopePath(repoPath: string): string {
  try {
    return fs.realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

/**
 * Optional RAG-corpus addition to a dispatched task's prompt, gated by
 * `rag_inject_task_context` (default false = never called for real work, matching the
 * zero-impact invariant). When on, hybrid-searches the corpus layer (src/knowledge/retrieve.ts)
 * scoped to the task's repo using its goal as the query, and greedy-packs citation-bearing
 * chunks into knowledge_budget_chars. Returns null when the flag is off, the task has no
 * repo_path, or nothing matched — callers must omit the section entirely in that case,
 * exactly like knowledgeContext's own null contract. Kept as a SEPARATE section/function
 * from knowledgeContext: this is uncurated corpus material, not the small, human-approved
 * knowledge graph, and must never be confused with it in the rendered prompt.
 */
export async function ragTaskContext(db: Database.Database, task: Task, embedExec?: EmbedExec): Promise<string | null> {
  if (!getBool(db, 'rag_inject_task_context', false)) return null;
  if (!task.repo_path) return null;

  const topK = getNum(db, 'rag_top_k', 8);
  const results = await search(db, task.goal, { scope: ragScopePath(task.repo_path), topK, embedExec });
  if (!results.length) return null;

  const budget = getNum(db, 'knowledge_budget_chars', 2500);
  const lines: string[] = [];
  let used = 0;
  for (const r of results) {
    const line = renderChunkLine(r);
    if (lines.length === 0) {
      const first = line.length <= budget ? line : line.slice(0, Math.max(0, budget));
      lines.push(first);
      used = first.length;
      continue;
    }
    const addLen = line.length + 1;
    if (used + addLen > budget) break;
    lines.push(line);
    used += addLen;
  }

  return lines.join('\n');
}
