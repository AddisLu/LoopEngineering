import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import type { Task } from '../types.js';
import type { Kind, KnowledgeNode } from './types.js';
import { repoScope, envScope } from './types.js';

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
};

/** Single-line + minimal markdown escape so a node's free-text body can't break the list layout. */
function mdInline(s: string): string {
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
}

function rank(a: RankedNode, b: RankedNode): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const ka = KIND_RANK[a.n.kind] ?? 9;
  const kb = KIND_RANK[b.n.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  if (a.n.weight !== b.n.weight) return b.n.weight - a.n.weight;
  return b.n.updated_at.localeCompare(a.n.updated_at);
}

/**
 * Builds the packed `## Knowledge / Environment` body for a dispatched task: approved+active
 * nodes seeded by scope (global / this repo / this task's environment label) plus one active
 * edge hop out from that seed set, ranked and greedy-packed into knowledge_budget_chars.
 * Returns null when knowledge_inject is off or nothing matched — callers must OMIT the
 * section entirely in that case (zero-impact invariant with an empty KB).
 */
export function knowledgeContext(db: Database.Database, task: Task): string | null {
  if (!getBool(db, 'knowledge_inject', true)) return null;

  const seedScopes = ['global'];
  if (task.repo_path) seedScopes.push(repoScope(task.repo_path));
  if (task.environment) seedScopes.push(envScope(task.environment));

  const seedPlaceholders = seedScopes.map(() => '?').join(', ');
  const tier0 = db
    .prepare(
      `SELECT * FROM knowledge_nodes
        WHERE status = 'approved' AND invalid_at IS NULL AND scope IN (${seedPlaceholders})`,
    )
    .all(...seedScopes) as KnowledgeNode[];

  const tier0Ids = new Set(tier0.map((n) => n.id));
  let tier1: KnowledgeNode[] = [];
  if (tier0.length) {
    const idPlaceholders = tier0.map(() => '?').join(', ');
    const edges = db
      .prepare(
        `SELECT src, dst FROM knowledge_edges
          WHERE invalid_at IS NULL AND (src IN (${idPlaceholders}) OR dst IN (${idPlaceholders}))`,
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
            WHERE status = 'approved' AND invalid_at IS NULL AND id IN (${nPlaceholders})`,
        )
        .all(...nIds) as KnowledgeNode[];
    }
  }

  const ranked: RankedNode[] = [
    ...tier0.map((n) => ({ n, tier: 0 as const })),
    ...tier1.map((n) => ({ n, tier: 1 as const })),
  ].sort(rank);

  if (ranked.length === 0) return null;

  const budget = getNum(db, 'knowledge_budget_chars', 2500);
  const lines: string[] = [];
  let used = 0;
  for (const { n } of ranked) {
    const line = renderLine(n);
    if (lines.length === 0) {
      // always include the first node, truncated to the budget if it doesn't fit alone
      const first = line.length <= budget ? line : line.slice(0, Math.max(0, budget));
      lines.push(first);
      used = first.length;
      continue;
    }
    const addLen = line.length + 1; // +1 for the joining newline
    if (used + addLen > budget) break;
    lines.push(line);
    used += addLen;
  }

  return lines.join('\n');
}
