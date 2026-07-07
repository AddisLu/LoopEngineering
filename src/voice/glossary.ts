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
 * The glossary whisper `initial_prompt` is built from the knowledge base alone — approved,
 * non-invalidated 'glossary'-tagged knowledge_nodes titles (learned via the voice page's
 * "加入詞表" or the knowledge base directly) — so the knowledge base is the single source
 * of truth and terms.txt/KB copies of the same term can't drift apart. terms.txt is only
 * consulted as a one-off fallback when the knowledge base has no glossary nodes at all
 * (e.g. seeding hasn't run yet, or every seeded node has since been invalidated).
 */
export function glossaryTermsForPrompt(
  db: Database.Database,
  termsPath: string,
  readFile: ReadFileFn = defaultReadFile,
): string[] {
  const seen = new Set<string>();
  const fromKb: string[] = [];
  for (const n of listNodes(db, { status: 'approved' })) {
    if (!isGlossaryTags(n.tags)) continue;
    const title = n.title.trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      fromKb.push(title);
    }
  }
  if (fromKb.length > 0) return fromKb;

  if (!termsPath) return [];
  try {
    return splitTerms(readFile(termsPath));
  } catch {
    return [];
  }
}
