import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { KnowledgeNode, KnowledgeEdge, Kind, Source, Status } from './types.js';
import { resyncNodeWikilinks } from './wikilink.js';

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
    resyncNodeWikilinks(db);
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
  resyncNodeWikilinks(db);
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
  resyncNodeWikilinks(db); // drop links-to edges other nodes had pointing at the now-inactive node
}

/** Hard delete — cascades to knowledge_edges via ON DELETE CASCADE. */
export function deleteNode(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM knowledge_nodes WHERE id = ?`).run(id).changes > 0;
}

export function setStatusNode(db: Database.Database, id: string, status: 'approved' | 'rejected'): void {
  db.prepare(`UPDATE knowledge_nodes SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  resyncNodeWikilinks(db); // a rejected node drops out of wikilink resolution just like an invalidated one
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

// ---- node <-> chunk evidence links (SSoT Phase 4) ----

/**
 * Records that `chunkIds` support `nodeId` — used right after the distiller drafts a
 * node (see src/knowledge/distill.ts) so a reviewer can see WHY it was suggested.
 * INSERT OR IGNORE (unique on node_id+chunk_id+relation) so re-linking is a no-op.
 */
export function linkNodeToChunks(
  db: Database.Database,
  nodeId: string,
  chunkIds: number[],
  relation = 'evidences',
): void {
  if (!chunkIds.length) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO node_chunk_links (node_id, chunk_id, relation) VALUES (?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const chunkId of chunkIds) insert.run(nodeId, chunkId, relation);
  });
  tx();
}

export interface NodeEvidence {
  chunk_id: number;
  document_id: number;
  path: string;
  uri: string | null;
  section: string | null;
  start_line: number | null;
  end_line: number | null;
  text: string;
  relation: string;
}

/**
 * Citation-bearing corpus chunks that support a (typically drafted) node — joined with
 * their document for path/line display. Excludes chunks/documents since superseded or
 * invalidated (bi-temporal); a node with no evidence links, or whose evidence has since
 * been invalidated, simply returns [].
 */
export function evidenceForNode(db: Database.Database, nodeId: string): NodeEvidence[] {
  return db
    .prepare(
      `SELECT c.id AS chunk_id, c.document_id AS document_id, c.text AS text, c.section AS section,
              c.start_line AS start_line, c.end_line AS end_line, d.path AS path, d.uri AS uri,
              l.relation AS relation
         FROM node_chunk_links l
         JOIN chunks c ON c.id = l.chunk_id AND c.invalid_at IS NULL
         JOIN documents d ON d.id = c.document_id AND d.invalid_at IS NULL
        WHERE l.node_id = ?
        ORDER BY l.created_at ASC`,
    )
    .all(nodeId) as NodeEvidence[];
}

// ---- graph + bulk import ----

export interface GraphOpts {
  kind?: Kind;
  scope?: string;
  /** Center a multi-hop traversal on this vertex: a knowledge_nodes.id ('k_...') or a
   * document pseudo-id ('doc_<documents.id>'). Omit for the whole (kind/scope-filtered)
   * graph. An id matching neither a node nor a linked document degrades to an empty result. */
  nodeId?: string;
  /** Hop limit from nodeId (default DEFAULT_GRAPH_DEPTH, capped at MAX_GRAPH_DEPTH). Ignored without nodeId. */
  depth?: number;
}

export interface GraphDocumentLink {
  target_title: string;
  target_kind: 'node' | 'document';
  target_id: string | number;
}

/** A markdown document shown as a distinct vertex type in the graph (see
 * src/knowledge/wikilink.ts's resyncDocumentWikilinks) — only documents that
 * participate in at least one resolved [[wikilink]] are graph-worthy; an ingested
 * corpus can be huge, an unlinked document belongs in RAG search, not here. */
export interface GraphDocument {
  id: number;
  title: string;
  path: string;
  uri: string | null;
  doc_kind: string | null;
  source_id: string;
  links: GraphDocumentLink[];
}

const DEFAULT_GRAPH_DEPTH = 2;
const MAX_GRAPH_DEPTH = 6;

function loadGraphDocuments(db: Database.Database): GraphDocument[] {
  const docs = db
    .prepare(
      `SELECT id, path, uri, title, doc_kind, source_id FROM documents
        WHERE invalid_at IS NULL AND doc_kind IN ('md', 'markdown', 'mdx')`,
    )
    .all() as {
    id: number;
    path: string;
    uri: string | null;
    title: string | null;
    doc_kind: string | null;
    source_id: string;
  }[];
  if (!docs.length) return [];

  // node-kind targets are re-checked against currently-active nodes here: doc_links is
  // only rebuilt on ingest, so a node invalidated/rejected since the last ingest would
  // otherwise leave a dangling reference (nodes it points at aren't in the `nodes` output).
  const activeNodeIds = new Set(
    (
      db
        .prepare(`SELECT id FROM knowledge_nodes WHERE invalid_at IS NULL AND status IN ('approved', 'draft')`)
        .all() as { id: string }[]
    ).map((r) => r.id),
  );

  const linkRows = db.prepare(`SELECT document_id, target_title, target_document_id, target_node_id FROM doc_links`).all() as {
    document_id: number;
    target_title: string;
    target_document_id: number | null;
    target_node_id: string | null;
  }[];

  const linksByDoc = new Map<number, GraphDocumentLink[]>();
  const connected = new Set<number>();
  for (const r of linkRows) {
    if (r.target_node_id != null && !activeNodeIds.has(r.target_node_id)) continue;
    if (r.target_document_id == null && r.target_node_id == null) continue; // unresolved -- not graph-worthy yet
    const link: GraphDocumentLink =
      r.target_node_id != null
        ? { target_title: r.target_title, target_kind: 'node', target_id: r.target_node_id }
        : { target_title: r.target_title, target_kind: 'document', target_id: r.target_document_id! };
    const arr = linksByDoc.get(r.document_id) ?? [];
    arr.push(link);
    linksByDoc.set(r.document_id, arr);
    connected.add(r.document_id);
    if (link.target_kind === 'document') connected.add(link.target_id as number);
  }

  return docs
    .filter((d) => connected.has(d.id))
    .map((d) => ({
      id: d.id,
      title: d.title ?? d.path,
      path: d.path,
      uri: d.uri,
      doc_kind: d.doc_kind,
      source_id: d.source_id,
      links: linksByDoc.get(d.id) ?? [],
    }));
}

/** Undirected adjacency over the combined curated-node + document vertex space, used
 * only for multi-hop BFS — relation direction doesn't matter for "what's near this node". */
function buildGraphAdjacency(
  nodeIds: string[],
  edges: KnowledgeEdge[],
  documents: GraphDocument[],
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const ensure = (v: string): Set<string> => {
    let s = adj.get(v);
    if (!s) {
      s = new Set();
      adj.set(v, s);
    }
    return s;
  };
  const link = (a: string, b: string) => {
    ensure(a).add(b);
    ensure(b).add(a);
  };
  for (const id of nodeIds) ensure(id);
  for (const e of edges) link(e.src, e.dst);
  for (const d of documents) {
    const docVid = `doc_${d.id}`;
    ensure(docVid);
    for (const l of d.links) link(docVid, l.target_kind === 'node' ? String(l.target_id) : `doc_${l.target_id}`);
  }
  return adj;
}

function bfsVisited(adj: Map<string, Set<string>>, start: string, depth: number): Set<string> {
  const visited = new Set([start]);
  let frontier = [start];
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const nb of adj.get(v) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

/**
 * Curated graph, extended for SSoT Phase 3: without `nodeId`, the whole graph
 * (optionally kind/scope-filtered, same as the original behavior). With `nodeId`, a
 * `depth`-hop BFS neighborhood around one vertex — a knowledge_nodes.id or a document
 * pseudo-id — so the brain UI can do "expand this node" without ever pulling the entire
 * graph. `documents` is additive (existing callers reading only nodes/edges are unaffected).
 */
export function graph(
  db: Database.Database,
  opts: GraphOpts = {},
): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; documents: GraphDocument[] } {
  const clauses = [`invalid_at IS NULL`, `status IN ('approved', 'draft')`];
  const params: unknown[] = [];
  if (opts.kind) {
    clauses.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.scope) {
    clauses.push('scope = ?');
    params.push(opts.scope);
  }
  let nodes = db
    .prepare(`SELECT * FROM knowledge_nodes WHERE ${clauses.join(' AND ')} ORDER BY weight DESC, created_at ASC`)
    .all(...params) as KnowledgeNode[];
  // edgesFor only requires ONE endpoint in the given id list (see its OR clause) — a
  // manual edge to a node excluded by kind/scope, or since invalidated, would otherwise
  // dangle (an edge referencing a node absent from `nodes`). Both endpoints must be
  // in the returned node set for an edge to be graph-worthy.
  const baseNodeIds = new Set(nodes.map((n) => n.id));
  let edges = edgesFor(db, [...baseNodeIds]).filter((e) => baseNodeIds.has(e.src) && baseNodeIds.has(e.dst));
  let documents = loadGraphDocuments(db);

  if (opts.nodeId) {
    const depth = Math.min(Math.max(opts.depth ?? DEFAULT_GRAPH_DEPTH, 1), MAX_GRAPH_DEPTH);
    const adj = buildGraphAdjacency(
      nodes.map((n) => n.id),
      edges,
      documents,
    );
    const visited = bfsVisited(adj, opts.nodeId, depth);
    nodes = nodes.filter((n) => visited.has(n.id));
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => nodeIdSet.has(e.src) && nodeIdSet.has(e.dst));
    documents = documents
      .filter((d) => visited.has(`doc_${d.id}`))
      .map((d) => ({
        ...d,
        links: d.links.filter((l) =>
          l.target_kind === 'node' ? nodeIdSet.has(String(l.target_id)) : visited.has(`doc_${l.target_id}`),
        ),
      }));
  }

  return { nodes, edges, documents };
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
