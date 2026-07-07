import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { SourceRow, SourceKind, SourceConfig } from './types.js';

export interface NewSourceInput {
  kind: SourceKind;
  uri: string;
  config?: SourceConfig;
  enabled?: boolean;
}

export function createSource(db: Database.Database, input: NewSourceInput): SourceRow {
  const id = `src_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO sources (id, kind, uri, config, enabled) VALUES (@id, @kind, @uri, @config, @enabled)`,
  ).run({
    id,
    kind: input.kind,
    uri: input.uri,
    config: JSON.stringify(input.config ?? {}),
    enabled: input.enabled === false ? 0 : 1,
  });
  return getSource(db, id)!;
}

export function getSource(db: Database.Database, id: string): SourceRow | undefined {
  return db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as SourceRow | undefined;
}

export interface ListSourcesOpts {
  enabled?: boolean;
}

export function listSources(db: Database.Database, opts: ListSourcesOpts = {}): SourceRow[] {
  if (opts.enabled === undefined) {
    return db.prepare(`SELECT * FROM sources ORDER BY created_at ASC`).all() as SourceRow[];
  }
  return db
    .prepare(`SELECT * FROM sources WHERE enabled = ? ORDER BY created_at ASC`)
    .all(opts.enabled ? 1 : 0) as SourceRow[];
}

/** Hard delete — cascades to documents (and, via documents' own cascade, chunks). */
export function deleteSource(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM sources WHERE id = ?`).run(id).changes > 0;
}

export function setSourceEnabled(db: Database.Database, id: string, enabled: boolean): void {
  db.prepare(`UPDATE sources SET enabled = ?, updated_at = datetime('now') WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function touchSourceIngested(db: Database.Database, id: string): void {
  db.prepare(`UPDATE sources SET last_ingested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(
    id,
  );
}
