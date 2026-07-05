import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { KnowledgeNode, KnowledgeEdge, Kind, Source, Status } from './types.js';

// ---- nodes ----

export interface UpsertNodeInput {
  kind?: Kind;
  title: string;
  body?: string;
  tags?: string[];
  scope?: string;
  source?: Source;
  status?: Status;
  weight?: number;
}

/** Exported for distill.ts's cross-close dedup guard (skip drafting an item that already exists). */
export function findActiveByTitleScope(
  db: Database.Database,
  title: string,
  scope: string,
): KnowledgeNode | undefined {
  return db
    .prepare(`SELECT * FROM knowledge_nodes WHERE title = ? AND scope = ? AND invalid_at IS NULL`)
    .get(title, scope) as KnowledgeNode | undefined;
}

/**
 * Dedup key is (title, scope) among ACTIVE nodes: a matching row is updated in place
 * (body/tags/kind/weight/status) rather than duplicated. ADD-only philosophy — this
 * never deletes; superseding a fact goes through invalidateNode instead.
 */
export function upsertNode(db: Database.Database, input: UpsertNodeInput): KnowledgeNode {
  const scope = input.scope ?? 'global';
  const existing = findActiveByTitleScope(db, input.title, scope);

  if (existing) {
    db.prepare(
      `UPDATE knowledge_nodes
          SET body = @body, tags = @tags, kind = @kind, weight = @weight, status = @status,
              updated_at = datetime('now')
        WHERE id = @id`,
    ).run({
      id: existing.id,
      body: input.body ?? existing.body,
      tags: JSON.stringify(input.tags ?? JSON.parse(existing.tags)),
      kind: input.kind ?? existing.kind,
      weight: input.weight ?? existing.weight,
      status: input.status ?? existing.status,
    });
    return getNode(db, existing.id)!;
  }

  const id = `k_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO knowledge_nodes (id, kind, title, body, tags, scope, source, status, weight)
     VALUES (@id, @kind, @title, @body, @tags, @scope, @source, @status, @weight)`,
  ).run({
    id,
    kind: input.kind ?? 'fact',
    title: input.title,
    body: input.body ?? '',
    tags: JSON.stringify(input.tags ?? []),
    scope,
    source: input.source ?? 'manual',
    status: input.status ?? 'approved',
    weight: input.weight ?? 3,
  });
  return getNode(db, id)!;
}

export function getNode(db: Database.Database, id: string): KnowledgeNode | undefined {
  return db.prepare(`SELECT * FROM knowledge_nodes WHERE id = ?`).get(id) as KnowledgeNode | undefined;
}

export interface ListNodesOpts {
  kind?: Kind;
  scope?: string;
  status?: Status;
  includeInvalid?: boolean;
}

export function listNodes(db: Database.Database, opts: ListNodesOpts = {}): KnowledgeNode[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeInvalid) clauses.push('invalid_at IS NULL');
  if (opts.kind) {
    clauses.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.scope) {
    clauses.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM knowledge_nodes ${where} ORDER BY weight DESC, created_at ASC`)
    .all(...params) as KnowledgeNode[];
}

export interface SearchNodesOpts {
  includeInvalid?: boolean;
  limit?: number;
}

/**
 * FTS MATCH against the trigram index (quoted so punctuation/CJK isn't parsed as FTS5
 * query syntax), unioned with a LIKE '%q%' fallback for queries under 3 characters —
 * the trigram tokenizer cannot match strings shorter than one trigram (e.g. 2-char
 * CJK words like 「只能」), so short queries would otherwise silently return nothing.
 */
export function searchNodes(db: Database.Database, q: string, opts: SearchNodesOpts = {}): KnowledgeNode[] {
  const limit = opts.limit ?? 50;
  const byId = new Map<string, KnowledgeNode>();

  const escaped = `"${q.replace(/"/g, '""')}"`;
  try {
    const ftsRows = db
      .prepare(
        `SELECT n.* FROM knowledge_fts JOIN knowledge_nodes n ON n.rowid = knowledge_fts.rowid
          WHERE knowledge_fts MATCH ? ${opts.includeInvalid ? '' : 'AND n.invalid_at IS NULL'}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(escaped, limit) as KnowledgeNode[];
    for (const row of ftsRows) byId.set(row.id, row);
  } catch {
    // malformed MATCH query text -- the LIKE fallback below still covers short queries
  }

  if (q.length < 3) {
    const likeRows = db
      .prepare(
        `SELECT * FROM knowledge_nodes
          WHERE (title LIKE ? OR body LIKE ?) ${opts.includeInvalid ? '' : 'AND invalid_at IS NULL'}
          LIMIT ?`,
      )
      .all(`%${q}%`, `%${q}%`, limit) as KnowledgeNode[];
    for (const row of likeRows) byId.set(row.id, row);
  }

  return [...byId.values()];
}

/** Bi-temporal supersede: marks invalid_at, keeps the row (never deleted). */
export function invalidateNode(db: Database.Database, id: string): void {
  db.prepare(`UPDATE knowledge_nodes SET invalid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(
    id,
  );
}

/** Hard delete — cascades to knowledge_edges via ON DELETE CASCADE. */
export function deleteNode(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM knowledge_nodes WHERE id = ?`).run(id).changes > 0;
}

export function setStatusNode(db: Database.Database, id: string, status: 'approved' | 'rejected'): void {
  db.prepare(`UPDATE knowledge_nodes SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

// ---- edges ----

export interface NewEdgeInput {
  src: string;
  dst: string;
  relation?: string;
  note?: string | null;
}

export function addEdge(db: Database.Database, input: NewEdgeInput): KnowledgeEdge | undefined {
  const relation = input.relation ?? 'related';
  db.prepare(
    `INSERT OR IGNORE INTO knowledge_edges (src, dst, relation, note) VALUES (@src, @dst, @relation, @note)`,
  ).run({
    src: input.src,
    dst: input.dst,
    relation,
    note: input.note ?? null,
  });
  return db
    .prepare(`SELECT * FROM knowledge_edges WHERE src = ? AND dst = ? AND relation = ?`)
    .get(input.src, input.dst, relation) as KnowledgeEdge | undefined;
}

export function deleteEdge(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM knowledge_edges WHERE id = ?`).run(id).changes > 0;
}

export function edgesFor(
  db: Database.Database,
  nodeIds: string[],
  opts: { includeInvalid?: boolean } = {},
): KnowledgeEdge[] {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => '?').join(', ');
  const invalidSql = opts.includeInvalid ? '' : 'AND invalid_at IS NULL';
  return db
    .prepare(
      `SELECT * FROM knowledge_edges WHERE (src IN (${placeholders}) OR dst IN (${placeholders})) ${invalidSql}`,
    )
    .all(...nodeIds, ...nodeIds) as KnowledgeEdge[];
}

// ---- graph + bulk import ----

export function graph(db: Database.Database): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
  const nodes = db
    .prepare(
      `SELECT * FROM knowledge_nodes
        WHERE invalid_at IS NULL AND status IN ('approved', 'draft')
        ORDER BY weight DESC, created_at ASC`,
    )
    .all() as KnowledgeNode[];
  const edges = edgesFor(
    db,
    nodes.map((n) => n.id),
  );
  return { nodes, edges };
}

export interface ImportNodeInput extends UpsertNodeInput {
  /** Local id (e.g. "N1") for referencing this item from `edges` in the same import batch — never persisted. */
  id?: string;
}

export interface ImportEdgeInput {
  /** Either a local `id` from this batch's `items`, or an existing node id. */
  src: string;
  dst: string;
  relation?: string;
  note?: string | null;
}

/**
 * Idempotent bulk load via upsertNode (dedup by title+scope) plus addEdge (dedup by
 * src+dst+relation). `edges` may reference items by their batch-local `id` (resolved
 * to the real node id here) or by an existing node id already in the database.
 */
export function importNodes(
  db: Database.Database,
  items: ImportNodeInput[],
  edges: ImportEdgeInput[] = [],
): { created: number; updated: number; edges: number } {
  let created = 0;
  let updated = 0;
  const localIds = new Map<string, string>();
  for (const item of items) {
    const scope = item.scope ?? 'global';
    const existed = findActiveByTitleScope(db, item.title, scope) !== undefined;
    const node = upsertNode(db, item);
    if (item.id) localIds.set(item.id, node.id);
    if (existed) updated++;
    else created++;
  }
  let edgeCount = 0;
  for (const e of edges) {
    const src = localIds.get(e.src) ?? e.src;
    const dst = localIds.get(e.dst) ?? e.dst;
    const relation = e.relation ?? 'related';
    const existed = db
      .prepare(`SELECT 1 FROM knowledge_edges WHERE src = ? AND dst = ? AND relation = ?`)
      .get(src, dst, relation);
    addEdge(db, { src, dst, relation, note: e.note });
    if (!existed) edgeCount++;
  }
  return { created, updated, edges: edgeCount };
}
