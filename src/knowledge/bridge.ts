import type Database from 'better-sqlite3';
import { isVecAvailable, vecGetEmbedding, vecKnn, type VecKnnResult, type VecTable } from './vec.js';

/** Synthetic cross-layer edge — never persisted (knowledge_edges' FKs only accept
 * node<->node, see schema.sql), only attached to graph(view='brain'/'brain-full')'s
 * response at read time. `src`/`dst` are a knowledge_nodes.id or a `doc_<documents.id>`
 * pseudo-id, same convention as GraphDocumentLink. */
export interface BridgeEdge {
  src: string;
  dst: string;
  relation: 'related';
}

export type BridgeKnn = (db: Database.Database, table: VecTable, embedding: number[], k: number) => VecKnnResult[];

export interface BridgeOptions {
  /** Nearest neighbors kept per source vector, before threshold filtering. Default 3. */
  topK?: number;
  /** Max distance (vec table's metric) to keep an edge — omit to skip distance filtering. */
  threshold?: number;
}

const DEFAULT_TOP_K = 3;

function curatedNodeIds(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT id FROM knowledge_nodes WHERE status = 'approved' AND invalid_at IS NULL`).all() as {
      id: string;
    }[]
  ).map((r) => r.id);
}

function opProjectDocumentIds(db: Database.Database): number[] {
  return (
    db.prepare(`SELECT id FROM documents WHERE doc_kind = 'op_project' AND invalid_at IS NULL`).all() as {
      id: number;
    }[]
  ).map((r) => r.id);
}

function chunkIdsForDocument(db: Database.Database, documentId: number): number[] {
  return (
    db.prepare(`SELECT id FROM chunks WHERE document_id = ? AND invalid_at IS NULL`).all(documentId) as {
      id: number;
    }[]
  ).map((r) => r.id);
}

function chunkDocumentId(db: Database.Database, chunkId: number): number | null {
  const row = db.prepare(`SELECT document_id FROM chunks WHERE id = ? AND invalid_at IS NULL`).get(chunkId) as
    | { document_id: number }
    | undefined;
  return row?.document_id ?? null;
}

function keepWithinThreshold(distance: number, threshold: number | undefined): boolean {
  return threshold === undefined || distance <= threshold;
}

/** One curated node -> its nearest chunks, deduped to their owning document (closest
 * chunk per document wins), threshold-filtered. */
function nodeToDocumentEdges(
  db: Database.Database,
  nodeId: string,
  topK: number,
  threshold: number | undefined,
  knn: BridgeKnn,
): BridgeEdge[] {
  const vector = vecGetEmbedding(db, 'vec_nodes', nodeId);
  if (!vector) return [];
  const closestByDoc = new Map<number, number>();
  for (const nb of knn(db, 'vec_chunks', vector, topK).slice(0, topK)) {
    const docId = chunkDocumentId(db, Number(nb.refId));
    if (docId == null) continue;
    const prev = closestByDoc.get(docId);
    if (prev === undefined || nb.distance < prev) closestByDoc.set(docId, nb.distance);
  }
  const edges: BridgeEdge[] = [];
  for (const [docId, distance] of closestByDoc) {
    if (keepWithinThreshold(distance, threshold)) edges.push({ src: nodeId, dst: `doc_${docId}`, relation: 'related' });
  }
  return edges;
}

/** One op_project document -> the nearest nodes of each of its chunks, aggregated to the
 * closest distance per node across all chunks, threshold-filtered. Complements
 * nodeToDocumentEdges (same underlying vectors, opposite search direction). */
function documentToNodeEdges(
  db: Database.Database,
  documentId: number,
  topK: number,
  threshold: number | undefined,
  knn: BridgeKnn,
): BridgeEdge[] {
  const closestByNode = new Map<string, number>();
  for (const chunkId of chunkIdsForDocument(db, documentId)) {
    const vector = vecGetEmbedding(db, 'vec_chunks', chunkId);
    if (!vector) continue;
    for (const nb of knn(db, 'vec_nodes', vector, topK).slice(0, topK)) {
      const nodeId = String(nb.refId);
      const prev = closestByNode.get(nodeId);
      if (prev === undefined || nb.distance < prev) closestByNode.set(nodeId, nb.distance);
    }
  }
  const edges: BridgeEdge[] = [];
  for (const [nodeId, distance] of closestByNode) {
    if (keepWithinThreshold(distance, threshold)) edges.push({ src: `doc_${documentId}`, dst: nodeId, relation: 'related' });
  }
  return edges;
}

/**
 * Cross-layer similarity edges (curated node <-> ingested document) for the brain graph
 * view — reuses whatever's already embedded in vec_nodes/vec_chunks (no re-embedding, no
 * external process/GPU call): each curated node's nearest chunks (deduped to their owning
 * document) plus, complementarily, each op_project document's nearest nodes across all its
 * chunks. Deduped undirected (same src+dst pair, either direction, counts once) and capped
 * to `topK` per source regardless of what `knn` returns.
 *
 * `knn` is injectable (defaults to the real vecKnn) so tests can supply canned neighbors
 * without seeding real vector data. Degrades to [] — never throws — when the vec extension
 * isn't loaded or `knn`/a lookup fails for any reason.
 */
export function bridgeEdges(db: Database.Database, opts: BridgeOptions = {}, knn: BridgeKnn = vecKnn): BridgeEdge[] {
  if (!isVecAvailable(db)) return [];
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const { threshold } = opts;
  const seen = new Map<string, BridgeEdge>();
  const add = (edges: BridgeEdge[]) => {
    for (const e of edges) {
      const key = [e.src, e.dst].sort().join(':');
      if (!seen.has(key)) seen.set(key, e);
    }
  };
  try {
    for (const nodeId of curatedNodeIds(db)) add(nodeToDocumentEdges(db, nodeId, topK, threshold, knn));
    for (const docId of opProjectDocumentIds(db)) add(documentToNodeEdges(db, docId, topK, threshold, knn));
  } catch {
    return [];
  }
  return [...seen.values()];
}

/**
 * 快取: the brain view used to recompute every cross-layer edge on every page load — one
 * vector KNN per curated node plus one per OpenProject document, several hundred searches,
 * ~600 ms while the rest of the graph query takes 3 ms. Nothing about those edges changes
 * between two page loads unless the underlying nodes, documents or embeddings changed, so
 * they are materialised once into knowledge_bridge_edges and read back with one indexed
 * SELECT. Same idea as an indexed code-graph server: build on change, answer from the index.
 *
 * The signature is what a rebuild depends on. It is deliberately cheap (four COUNTs and two
 * MAXes, ~0.3 ms) — never a hash of content — so the hit path stays a single comparison.
 */
export function bridgeSignature(db: Database.Database, opts: BridgeOptions = {}): string {
  const one = (sql: string): string => {
    try {
      const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
      return String(Object.values(row ?? {})[0] ?? '');
    } catch {
      return '?';
    }
  };
  return [
    'v1',
    opts.topK ?? DEFAULT_TOP_K,
    opts.threshold ?? '-',
    one(`SELECT COUNT(*) FROM knowledge_nodes WHERE status = 'approved' AND invalid_at IS NULL`),
    one(`SELECT COALESCE(MAX(updated_at), '') FROM knowledge_nodes`),
    one(`SELECT COUNT(*) FROM documents WHERE invalid_at IS NULL`),
    one(`SELECT COALESCE(MAX(updated_at), '') FROM documents`),
    one(`SELECT COUNT(*) FROM chunks WHERE invalid_at IS NULL`),
    one(`SELECT COUNT(*) FROM vec_nodes`),
  ].join('|');
}

/** Drop the cache — used by tests and by anything that knows it invalidated the inputs. */
export function clearBridgeCache(db: Database.Database): void {
  try {
    db.prepare(`DELETE FROM knowledge_bridge_edges`).run();
  } catch {
    /* table not there yet */
  }
}

/**
 * The same edges as bridgeEdges(), served from knowledge_bridge_edges when the inputs have
 * not changed. A miss costs exactly what the old code cost on every call; a hit is one query.
 */
export function bridgeEdgesCached(db: Database.Database, opts: BridgeOptions = {}, knn: BridgeKnn = vecKnn): BridgeEdge[] {
  const signature = bridgeSignature(db, opts);
  try {
    const rows = db.prepare(`SELECT src, dst FROM knowledge_bridge_edges WHERE signature = ?`).all(signature) as {
      src: string;
      dst: string;
    }[];
    // an empty graph caches as one sentinel row, so "no rows" always means "not built yet"
    if (rows.length) return rows.filter((r) => r.src !== SENTINEL).map((r) => ({ src: r.src, dst: r.dst, relation: 'related' as const }));
  } catch {
    return bridgeEdges(db, opts, knn); // no table (older DB) — behave exactly as before
  }

  const edges = bridgeEdges(db, opts, knn);
  try {
    const insert = db.prepare(`INSERT OR REPLACE INTO knowledge_bridge_edges (src, dst, relation, signature) VALUES (?, ?, ?, ?)`);
    db.transaction(() => {
      db.prepare(`DELETE FROM knowledge_bridge_edges`).run();
      for (const e of edges) insert.run(e.src, e.dst, e.relation, signature);
      if (!edges.length) insert.run(SENTINEL, SENTINEL, 'related', signature);
    })();
  } catch {
    /* read-only DB or no table: the answer is still correct, just uncached */
  }
  return edges;
}

/** Marks "built, and the answer was empty" — without it an empty graph rebuilds every load. */
const SENTINEL = '__none__';
