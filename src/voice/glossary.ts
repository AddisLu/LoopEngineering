import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { findActiveByTitleScope, upsertNode, listNodes } from '../knowledge/store.js';

export type ReadFileFn = (path: string) => string;

const defaultReadFile: ReadFileFn = (p) => fs.readFileSync(p, 'utf8');

/** Comma/newline-separated terms file -> trimmed, de-duped, non-empty term list. */
function splitTerms(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    for (const t of line.split(',')) {
      const trimmed = t.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  }
  return out;
}

/** A knowledge_nodes row is glossary iff its tags array includes 'glossary'. */
function isGlossaryTags(tagsJson: string): boolean {
  try {
    const tags = JSON.parse(tagsJson) as unknown;
    return Array.isArray(tags) && tags.includes('glossary');
  } catch {
    return false;
  }
}

export interface GlossarySeedResult {
  created: number;
  skipped: number;
}

/**
 * Idempotent one-time import of `voice_terms_path` (terms.txt) into knowledge_nodes as
 * glossary terms (kind='tech', tags=['glossary'], scope='global', status='approved',
 * source='seed'). Safe to call on every intake — a term that already exists (same title
 * + scope) is left alone via upsertNode's dedup, so re-seeding never duplicates rows.
 * A missing/unreadable terms file is not an error — voice intake still works, it just
 * seeds nothing this run.
 */
export function seedGlossaryTerms(
  db: Database.Database,
  termsPath: string,
  readFile: ReadFileFn = defaultReadFile,
): GlossarySeedResult {
  if (!termsPath) return { created: 0, skipped: 0 };
  let raw: string;
  try {
    raw = readFile(termsPath);
  } catch {
    return { created: 0, skipped: 0 };
  }
  let created = 0;
  let skipped = 0;
  for (const title of splitTerms(raw)) {
    if (findActiveByTitleScope(db, title, 'global')) {
      skipped++;
      continue;
    }
    upsertNode(db, { title, kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved', source: 'seed' });
    created++;
  }
  return { created, skipped };
}

/**
 * The glossary whisper `initial_prompt` should be built from: terms.txt content UNION
 * approved, non-invalidated 'glossary'-tagged knowledge_nodes titles (learned via the
 * voice page's "加入詞表" or the knowledge base directly) — de-duped, file order first.
 */
export function mergedGlossaryTerms(
  db: Database.Database,
  termsPath: string,
  readFile: ReadFileFn = defaultReadFile,
): string[] {
  let fromFile: string[] = [];
  if (termsPath) {
    try {
      fromFile = splitTerms(readFile(termsPath));
    } catch {
      fromFile = [];
    }
  }
  const fromKb = listNodes(db, { kind: 'tech', status: 'approved' })
    .filter((n) => isGlossaryTags(n.tags))
    .map((n) => n.title.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const t of [...fromFile, ...fromKb]) {
    if (!seen.has(t)) {
      seen.add(t);
      merged.push(t);
    }
  }
  return merged;
}
