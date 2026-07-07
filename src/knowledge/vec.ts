import type Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

/** Injectable so tests can simulate a host where the native extension fails to load
 * (missing binary, unsupported platform, extension loading disabled) without needing
 * to actually break the real one. */
export type VecLoader = (db: Database.Database) => void;

export const realVecLoader: VecLoader = (db) => loadSqliteVec(db);

const availability = new WeakMap<Database.Database, boolean>();

export type VecTable = 'vec_chunks' | 'vec_nodes';

const REF_COLUMN: Record<VecTable, string> = {
  vec_chunks: 'chunk_id',
  vec_nodes: 'node_id',
};

/**
 * Load the vec0 SQLite extension and create the vec_chunks/vec_nodes virtual tables
 * (dimension fixed at creation time — changing `embed_dim` later does not resize an
 * already-created table). Any failure degrades to FTS-only and never throws; callers
 * must check isVecAvailable(db) before using vecUpsert/vecKnn. Memoized per db instance
 * (idempotent — safe to call on every startup).
 */
export function loadVec(db: Database.Database, dim: number, loader: VecLoader = realVecLoader): boolean {
  if (availability.has(db)) return availability.get(db)!;
  try {
    loader(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}], chunk_id INTEGER)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(embedding float[${dim}], node_id TEXT)`);
    availability.set(db, true);
    return true;
  } catch {
    availability.set(db, false);
    return false;
  }
}

export function isVecAvailable(db: Database.Database): boolean {
  return availability.get(db) ?? false;
}

export interface VecKnnResult {
  rowid: number;
  refId: number | string;
  distance: number;
}

/**
 * Upsert one vector. vec0's rowid primary key rejects `INSERT OR REPLACE` (and any
 * plain JS number — "Only integers allowed for primary key"), so this deletes then
 * inserts, always binding rowid (and any numeric refId) as BigInt: better-sqlite3 binds
 * plain JS numbers as SQLite REAL by default, which vec0's strictly-typed INTEGER
 * metadata columns reject outright. No-op when the extension didn't load.
 * `refId` type must match the table's metadata column: vec_chunks.chunk_id is INTEGER
 * (chunks.id), vec_nodes.node_id is TEXT (knowledge_nodes.id).
 */
export function vecUpsert(
  db: Database.Database,
  table: VecTable,
  rowid: number,
  embedding: number[],
  refId: number | string,
): void {
  if (!isVecAvailable(db)) return;
  const col = REF_COLUMN[table];
  const id = BigInt(rowid);
  const refBind = typeof refId === 'number' ? BigInt(refId) : refId;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(id);
    db.prepare(`INSERT INTO ${table}(rowid, embedding, ${col}) VALUES (?, ?, ?)`).run(id, JSON.stringify(embedding), refBind);
  });
  tx();
}

/** K-nearest-neighbor search. Returns [] (never throws) when the extension didn't load. */
export function vecKnn(db: Database.Database, table: VecTable, embedding: number[], k: number): VecKnnResult[] {
  if (!isVecAvailable(db)) return [];
  const col = REF_COLUMN[table];
  const rows = db
    .prepare(`SELECT rowid, ${col} AS refId, distance FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
    .all(JSON.stringify(embedding), k) as { rowid: number | bigint; refId: number | bigint | string; distance: number }[];
  return rows.map((r) => ({
    rowid: Number(r.rowid),
    refId: typeof r.refId === 'bigint' ? Number(r.refId) : r.refId,
    distance: r.distance,
  }));
}
