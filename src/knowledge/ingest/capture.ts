import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { listSources } from './sources.js';
import { ingestSource, type IngestOptions, type IngestSourceResult } from './ingest.js';
import type { SourceRow } from './types.js';

export interface CaptureInput {
  /** Optional; derived from the first line of `body` when omitted (same idiom as
   * loop_remember's title auto-derivation in mcp/loop-mcp.mjs). */
  title?: string;
  body: string;
  tags?: string[];
}

export interface CaptureResult {
  source_id: string;
  filename: string;
  abs_path: string;
  ingest: IngestSourceResult;
}

function firstLine(s: string): string {
  return s.split(/[\n。.!?！?]/)[0]?.trim().slice(0, 80) || 'note';
}

/** Filesystem/frontmatter-safe slug: keeps letters (incl. CJK) and digits, collapses
 * everything else to '-'. Empty input (e.g. an all-punctuation title) falls back to 'note'. */
function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'note';
}

function frontmatter(tags: string[]): string {
  if (!tags.length) return '';
  return `---\ntags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]\n---\n\n`;
}

/** The vault to capture into — the first ENABLED `kind='vault'` source (the common case
 * is exactly one registered vault; see `loop ingest add --vault <path>`). */
function findVaultSource(db: Database.Database): SourceRow | undefined {
  return listSources(db, { enabled: true }).find((s) => s.kind === 'vault');
}

/**
 * Writes a quick note as markdown into the registered SSoT vault, then immediately
 * ingests that source — incremental by content hash (see ingest.ts), so only the new
 * file is walked/chunked/embedded and the note is searchable right away. This is the
 * "capture" write path (MCP `loop_capture` / brain quick-add): a distinct, much lighter
 * flow than the curated `knowledge_nodes` add-dialog — it lands in the RAG corpus layer,
 * not the prompt-injected curated layer. Throws if no vault source is registered (there
 * is nowhere to write); throws on an empty body (nothing to capture).
 */
export async function captureNote(
  db: Database.Database,
  input: CaptureInput,
  opts: IngestOptions = {},
): Promise<CaptureResult> {
  const body = input.body.trim();
  if (!body) throw new Error('body is required');
  const source = findVaultSource(db);
  if (!source) {
    throw new Error('no enabled vault source registered — register one first (loop ingest add --vault <path>)');
  }
  const title = input.title?.trim() || firstLine(body);
  const tags = input.tags ?? [];

  const base = slugify(title);
  let filename = `${base}.md`;
  for (let n = 2; fs.existsSync(path.join(source.uri, filename)); n++) {
    filename = `${base}-${n}.md`;
  }

  const content = `${frontmatter(tags)}# ${title}\n\n${body}\n`;
  fs.mkdirSync(source.uri, { recursive: true });
  const absPath = path.join(source.uri, filename);
  fs.writeFileSync(absPath, content, 'utf8');

  const ingest = await ingestSource(db, source, opts);
  return { source_id: source.id, filename, abs_path: absPath, ingest };
}
