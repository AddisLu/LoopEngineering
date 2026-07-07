import fs from 'node:fs';

/** knowledge_nodes.kind — what category of fact a node represents. */
export const KIND = [
  'environment',
  'project',
  'constraint',
  'preference',
  'tech',
  'fact',
  'person',
  'repo',
] as const;
export type Kind = (typeof KIND)[number];

/** knowledge_nodes.source — where a node came from. */
export const SOURCE = ['manual', 'mcp', 'distilled', 'seed'] as const;
export type Source = (typeof SOURCE)[number];

/** knowledge_nodes.status — review state (independent of bi-temporal invalidation). */
export const STATUS = ['approved', 'draft', 'rejected'] as const;
export type Status = (typeof STATUS)[number];

/** knowledge_edges.relation — how two nodes relate. 'links-to' is auto-derived from
 * [[wikilink]]s in a node's body (see src/knowledge/wikilink.ts) — not normally picked
 * by hand, but a valid value like any other relation. */
export const RELATION = ['runs-on', 'constrains', 'deployed-at', 'uses', 'part-of', 'related', 'links-to'] as const;
export type Relation = (typeof RELATION)[number];

export interface KnowledgeNode {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  tags: string; // JSON string[]
  scope: string; // 'global' | 'repo:<realpath>' | 'env:<name>'
  source: Source;
  status: Status;
  weight: number;
  invalid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEdge {
  id: number;
  src: string;
  dst: string;
  relation: string;
  note: string | null;
  status: Status; // approved | draft | rejected — see src/knowledge/relate.ts
  invalid_at: string | null;
  created_at: string;
}

/**
 * 'repo:<realpath>' scope for a filesystem path. Best-effort realpath (same
 * normalization idea as isEngineRepo in src/config.ts) so different relative/symlinked
 * paths to the same repo dedup to one scope; falls back to the raw path if it
 * doesn't exist yet (e.g. a task's repo_path before the worktree is cut).
 */
export function repoScope(repoPath: string): string {
  try {
    return `repo:${fs.realpathSync(repoPath)}`;
  } catch {
    return `repo:${repoPath}`;
  }
}

/** 'env:<name>' scope, e.g. for a task's `environment` label. */
export function envScope(name: string): string {
  return `env:${name}`;
}
