import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ENGINE_REPO_ROOT } from '../config.js';
import { parsePipelineDef, validatePipelineDef, type PipelineDef } from './types.js';

const SEED_DIR = path.join(ENGINE_REPO_ROOT, 'seed', 'pipelines');

export interface PipelineRow {
  name: string;
  description: string | null;
  def: string; // JSON (PipelineDef)
  created_at: string;
}

/** Dedup key is `name` — a re-import updates the existing row in place (ADD-only, mirrors upsertNode). */
export function upsertPipeline(db: Database.Database, def: PipelineDef): PipelineRow {
  db.prepare(
    `INSERT INTO pipelines (name, description, def) VALUES (@name, @description, @def)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description, def = excluded.def`,
  ).run({
    name: def.name,
    description: def.description ?? null,
    def: JSON.stringify(def),
  });
  return getPipelineRow(db, def.name)!;
}

export function getPipelineRow(db: Database.Database, name: string): PipelineRow | undefined {
  return db.prepare('SELECT * FROM pipelines WHERE name = ?').get(name) as PipelineRow | undefined;
}

/** Parsed def for a stored template, or undefined if missing/corrupted (never throws). */
export function getPipelineDef(db: Database.Database, name: string): PipelineDef | undefined {
  const row = getPipelineRow(db, name);
  if (!row) return undefined;
  try {
    return parsePipelineDef(JSON.parse(row.def)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function listPipelineDefs(db: Database.Database): PipelineDef[] {
  const rows = db.prepare('SELECT * FROM pipelines ORDER BY name ASC').all() as PipelineRow[];
  const out: PipelineDef[] = [];
  for (const r of rows) {
    try {
      const def = parsePipelineDef(JSON.parse(r.def));
      if (def) out.push(def);
    } catch {
      /* corrupted row — skip rather than fail the whole list */
    }
  }
  return out;
}

export function deletePipeline(db: Database.Database, name: string): boolean {
  return db.prepare('DELETE FROM pipelines WHERE name = ?').run(name).changes > 0;
}

export interface ImportPipelinesResult {
  created: number;
  updated: number;
  rejected: { index: number; error: string }[];
}

/**
 * Bulk import (mirrors knowledge/store.ts's importNodes): each raw item is validated —
 * a bad one is rejected (reported, not silently dropped or defaulted) while the rest
 * still import.
 */
export function importPipelineDefs(db: Database.Database, items: unknown[]): ImportPipelinesResult {
  let created = 0;
  let updated = 0;
  const rejected: { index: number; error: string }[] = [];
  items.forEach((raw, index) => {
    const v = validatePipelineDef(raw);
    if (!v.ok) {
      rejected.push({ index, error: v.error });
      return;
    }
    const existed = getPipelineRow(db, v.def.name) !== undefined;
    upsertPipeline(db, v.def);
    if (existed) updated++;
    else created++;
  });
  return { created, updated, rejected };
}

/**
 * First-run seed for the built-in templates (feature/fix/ship) from seed/pipelines/*.json —
 * same idiom as seedEnvironments in db/index.ts. INSERT OR IGNORE (via ON CONFLICT no-op
 * would overwrite; we want the opposite) so a user's own edits (via `loop pipeline import`
 * or the API) are never clobbered on a later startup. Missing/unreadable seed dir or a
 * malformed seed file is silently skipped — this must never block engine startup.
 */
export function seedPipelines(db: Database.Database): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pipelines (name, description, def) VALUES (@name, @description, @def)`,
  );
  const tx = db.transaction(() => {
    for (const f of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8'));
      } catch {
        continue;
      }
      const def = parsePipelineDef(raw);
      if (!def) continue;
      insert.run({ name: def.name, description: def.description ?? null, def: JSON.stringify(def) });
    }
  });
  tx();
}
