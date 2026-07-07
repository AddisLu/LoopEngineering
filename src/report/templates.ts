import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ENGINE_REPO_ROOT } from '../config.js';

const SEED_DIR = path.join(ENGINE_REPO_ROOT, 'seed', 'report-templates');

/**
 * A reusable "boss persona" report template — instructions is free-text prose (format +
 * tone + what the audience cares about) that generateReport injects verbatim in place of
 * its built-in default one-page instructions (see generate.ts's DEFAULT_TEMPLATE_INSTRUCTIONS).
 */
export interface ReportTemplateDef {
  name: string;
  description?: string;
  audience?: string;
  format?: string;
  instructions: string;
  sections?: string[];
  default_project?: string;
  model?: string;
}

function validateDef(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) return 'name is required';
  if (typeof o.instructions !== 'string' || !o.instructions.trim()) return 'instructions is required';
  for (const key of ['description', 'audience', 'format', 'default_project', 'model'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'string') return `${key} must be a string`;
  }
  if (o.sections !== undefined) {
    if (!Array.isArray(o.sections) || o.sections.some((s) => typeof s !== 'string')) {
      return 'sections must be an array of strings';
    }
  }
  return null;
}

function toDef(raw: Record<string, unknown>): ReportTemplateDef {
  const def: ReportTemplateDef = {
    name: (raw.name as string).trim(),
    instructions: (raw.instructions as string).trim(),
  };
  if (typeof raw.description === 'string' && raw.description.trim()) def.description = raw.description.trim();
  if (typeof raw.audience === 'string' && raw.audience.trim()) def.audience = raw.audience.trim();
  if (typeof raw.format === 'string' && raw.format.trim()) def.format = raw.format.trim();
  if (typeof raw.default_project === 'string' && raw.default_project.trim()) def.default_project = raw.default_project.trim();
  if (typeof raw.model === 'string' && raw.model.trim()) def.model = raw.model.trim();
  if (Array.isArray(raw.sections)) {
    const sections = (raw.sections as string[]).map((s) => s.trim()).filter(Boolean);
    if (sections.length) def.sections = sections;
  }
  return def;
}

/** Parse + validate; returns the rejection reason instead of swallowing it (mirrors
 * pipeline/types.ts's validatePipelineDef). */
export function validateReportTemplateDef(raw: unknown): { ok: true; def: ReportTemplateDef } | { ok: false; error: string } {
  const err = validateDef(raw);
  if (err) return { ok: false, error: err };
  return { ok: true, def: toDef(raw as Record<string, unknown>) };
}

/** Same as validateReportTemplateDef, but never throws / swallows the reason (for the
 * seed loader, where a malformed file must never block engine startup). */
export function parseReportTemplateDef(raw: unknown): ReportTemplateDef | null {
  const v = validateReportTemplateDef(raw);
  return v.ok ? v.def : null;
}

export interface ReportTemplateRow {
  name: string;
  description: string | null;
  def: string; // JSON (ReportTemplateDef)
  created_at: string;
}

/** Dedup key is `name` — a re-import updates the existing row in place (mirrors
 * pipeline/store.ts's upsertPipeline). */
export function upsertReportTemplate(db: Database.Database, def: ReportTemplateDef): ReportTemplateDef {
  db.prepare(
    `INSERT INTO report_templates (name, description, def) VALUES (@name, @description, @def)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description, def = excluded.def`,
  ).run({
    name: def.name,
    description: def.description ?? null,
    def: JSON.stringify(def),
  });
  return getReportTemplate(db, def.name)!;
}

/** Parsed def for a stored template, or undefined if missing/corrupted (never throws). */
export function getReportTemplate(db: Database.Database, name: string): ReportTemplateDef | undefined {
  const row = db.prepare('SELECT * FROM report_templates WHERE name = ?').get(name) as ReportTemplateRow | undefined;
  if (!row) return undefined;
  try {
    return parseReportTemplateDef(JSON.parse(row.def)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function listReportTemplates(db: Database.Database): ReportTemplateDef[] {
  const rows = db.prepare('SELECT * FROM report_templates ORDER BY name ASC').all() as ReportTemplateRow[];
  const out: ReportTemplateDef[] = [];
  for (const r of rows) {
    try {
      const def = parseReportTemplateDef(JSON.parse(r.def));
      if (def) out.push(def);
    } catch {
      /* corrupted row — skip rather than fail the whole list */
    }
  }
  return out;
}

export interface ImportReportTemplatesResult {
  created: number;
  updated: number;
  rejected: { index: number; error: string }[];
}

/** Bulk import (mirrors pipeline/store.ts's importPipelineDefs): each raw item is
 * validated — a bad one is rejected (reported, not silently dropped) while the rest
 * still import. */
export function importReportTemplates(db: Database.Database, items: unknown[]): ImportReportTemplatesResult {
  let created = 0;
  let updated = 0;
  const rejected: { index: number; error: string }[] = [];
  items.forEach((raw, index) => {
    const v = validateReportTemplateDef(raw);
    if (!v.ok) {
      rejected.push({ index, error: v.error });
      return;
    }
    const existed = getReportTemplate(db, v.def.name) !== undefined;
    upsertReportTemplate(db, v.def);
    if (existed) updated++;
    else created++;
  });
  return { created, updated, rejected };
}

/**
 * First-run seed for the built-in personas (廠長一頁綜覽/經理 PR 週報/PM 詳細進度) from
 * seed/report-templates/*.json — same idiom as pipeline/store.ts's seedPipelines.
 * INSERT OR IGNORE so a user's own edits (via the templates API/CLI) are never
 * clobbered on a later startup. Missing/unreadable seed dir or a malformed seed file
 * is silently skipped — this must never block engine startup.
 */
export function seedReportTemplates(db: Database.Database): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO report_templates (name, description, def) VALUES (@name, @description, @def)`,
  );
  const tx = db.transaction(() => {
    for (const f of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8'));
      } catch {
        continue;
      }
      const def = parseReportTemplateDef(raw);
      if (!def) continue;
      insert.run({ name: def.name, description: def.description ?? null, def: JSON.stringify(def) });
    }
  });
  tx();
}
