import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getBool, getNum } from '../../db/index.js';
import { embed, type EmbedExec } from '../embed.js';
import { vecUpsert } from '../vec.js';
import { listSources, getSource, touchSourceIngested } from './sources.js';
import { walkSource, maskSecrets, realGitExec, type GitListExec } from './walk.js';
import { chunkDocument, type ChunkPiece } from './chunk.js';
import type { SourceRow, DocumentRow } from './types.js';
import { resyncDocumentWikilinks } from '../wikilink.js';
import { dumpOpenProjectSource, type OpenProjectDumpExec, type OpenProjectDoc } from './openproject.js';

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const MD_EXT = new Set(['md', 'markdown', 'mdx']);

function extOf(relPath: string): string {
  return path.extname(relPath).replace(/^\./, '').toLowerCase();
}

export interface IngestOptions {
  /** Test injection for the git-source file listing (see walk.ts). */
  gitExec?: GitListExec;
  /** Test injection for embedding (see embed.ts) — only reached when rag_enabled. */
  embedExec?: EmbedExec;
  /** Test injection for the OpenProject dump script exec (see openproject.ts). */
  openProjectExec?: OpenProjectDumpExec;
}

export interface IngestSourceResult {
  source_id: string;
  documents_created: number;
  documents_replaced: number;
  documents_invalidated: number;
  chunks_created: number;
  skipped_unchanged: number;
}

function activeDocumentsByPath(db: Database.Database, sourceId: string): Map<string, DocumentRow> {
  const rows = db
    .prepare(`SELECT * FROM documents WHERE source_id = ? AND invalid_at IS NULL`)
    .all(sourceId) as DocumentRow[];
  return new Map(rows.map((r) => [r.path, r]));
}

/** Bi-temporal supersede: marks the document (and its still-active chunks) invalid,
 * never deletes the rows — history stays queryable via includeInvalid-style access. */
function invalidateDocument(db: Database.Database, doc: DocumentRow): void {
  db.prepare(`UPDATE documents SET invalid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(
    doc.id,
  );
  db.prepare(`UPDATE chunks SET invalid_at = datetime('now') WHERE document_id = ? AND invalid_at IS NULL`).run(
    doc.id,
  );
}

/** Inserts chunk rows, then — only when rag_enabled — embeds their text and upserts the
 * vectors into vec_chunks (a no-op inside vecUpsert if the extension never loaded). Off
 * by default: `loop ingest run` alone never spawns the embed daemon/GPU unless the user
 * opted into rag_enabled, matching the zero-impact-by-default posture of Phase 0. */
async function embedAndStoreChunks(
  db: Database.Database,
  documentId: number,
  pieces: ChunkPiece[],
  embedExec?: EmbedExec,
): Promise<number> {
  if (!pieces.length) return 0;
  const insert = db.prepare(
    `INSERT INTO chunks (document_id, ord, text, section, start_line, end_line, sha256)
     VALUES (@document_id, @ord, @text, @section, @start_line, @end_line, @sha256)`,
  );
  const ids: number[] = [];
  const tx = db.transaction(() => {
    for (const p of pieces) {
      const info = insert.run({
        document_id: documentId,
        ord: p.ord,
        text: p.text,
        section: p.section,
        start_line: p.start_line,
        end_line: p.end_line,
        sha256: sha256(p.text),
      });
      ids.push(Number(info.lastInsertRowid));
    }
  });
  tx();

  if (getBool(db, 'rag_enabled')) {
    const vectors = await embed(
      db,
      pieces.map((p) => p.text),
      embedExec,
    );
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const vector = vectors[i];
      if (id !== undefined && vector) vecUpsert(db, 'vec_chunks', id, vector, id);
    }
  }
  return pieces.length;
}

/**
 * OpenProject documents arrive pre-extracted (ext_id/title/text/uri/doc_kind/updated_at)
 * from the dump script rather than as on-disk files, so incremental comparison keys off
 * the external `updated_at` timestamp (authoritative when present) instead of walk.ts's
 * content-sha256-only approach — falling back to sha256 for a doc with no updated_at.
 * `documents.path` doubles as the external id here, mirroring how walk.ts uses it as a
 * source-relative file path for git/folder/vault sources.
 */
async function ingestOpenProjectDocs(
  db: Database.Database,
  source: SourceRow,
  docs: OpenProjectDoc[],
  embedExec?: EmbedExec,
): Promise<IngestSourceResult> {
  const existing = activeDocumentsByPath(db, source.id);
  const seenPaths = new Set<string>();

  const result: IngestSourceResult = {
    source_id: source.id,
    documents_created: 0,
    documents_replaced: 0,
    documents_invalidated: 0,
    chunks_created: 0,
    skipped_unchanged: 0,
  };

  const insertDoc = db.prepare(
    `INSERT INTO documents (source_id, path, uri, title, doc_kind, sha256, bytes, mtime)
     VALUES (@source_id, @path, @uri, @title, @doc_kind, @sha256, @bytes, @mtime)`,
  );

  for (const doc of docs) {
    seenPaths.add(doc.ext_id);
    const digest = sha256(doc.text);
    const prior = existing.get(doc.ext_id);
    const unchanged = prior ? (doc.updated_at ? prior.mtime === doc.updated_at : prior.sha256 === digest) : false;

    if (unchanged) {
      result.skipped_unchanged++;
      continue;
    }
    if (prior) {
      invalidateDocument(db, prior);
      result.documents_replaced++;
    } else {
      result.documents_created++;
    }

    const pieces = chunkDocument(doc.text, doc.doc_kind);
    const info = insertDoc.run({
      source_id: source.id,
      path: doc.ext_id,
      uri: doc.uri,
      title: doc.title,
      doc_kind: doc.doc_kind,
      sha256: digest,
      bytes: Buffer.byteLength(doc.text, 'utf8'),
      mtime: doc.updated_at,
    });
    const documentId = Number(info.lastInsertRowid);
    result.chunks_created += await embedAndStoreChunks(db, documentId, pieces, embedExec);
  }

  for (const [p, doc] of existing) {
    if (!seenPaths.has(p)) {
      invalidateDocument(db, doc);
      result.documents_invalidated++;
    }
  }

  touchSourceIngested(db, source.id);
  resyncDocumentWikilinks(db);
  return result;
}

/**
 * Ingest one source: walk -> (per new/changed file) mask secrets -> chunk -> store
 * documents/chunks -> embed(Phase0). Incremental by sha256 of the (masked) file content;
 * a changed file bi-temporally supersedes its prior document version, an unchanged file
 * is skipped entirely, and a file no longer present in the walk invalidates its document
 * (delete-as-invalidate — history is never dropped).
 *
 * 'openproject' sources are not a file-tree walk — they dispatch to
 * ingestOpenProjectDocs (see openproject.ts for the dump/parse side).
 */
export async function ingestSource(
  db: Database.Database,
  source: SourceRow,
  opts: IngestOptions = {},
): Promise<IngestSourceResult> {
  if (source.kind === 'openproject') {
    const docs = await dumpOpenProjectSource(db, source, opts.openProjectExec);
    return ingestOpenProjectDocs(db, source, docs, opts.embedExec);
  }

  const maxFileKb = getNum(db, 'ingest_max_file_kb', 1024);
  const files = walkSource(source, maxFileKb, opts.gitExec ?? realGitExec);
  const existing = activeDocumentsByPath(db, source.id);
  const seenPaths = new Set<string>();

  const result: IngestSourceResult = {
    source_id: source.id,
    documents_created: 0,
    documents_replaced: 0,
    documents_invalidated: 0,
    chunks_created: 0,
    skipped_unchanged: 0,
  };

  const insertDoc = db.prepare(
    `INSERT INTO documents (source_id, path, uri, title, doc_kind, sha256, bytes, mtime)
     VALUES (@source_id, @path, @uri, @title, @doc_kind, @sha256, @bytes, @mtime)`,
  );

  for (const file of files) {
    seenPaths.add(file.path);
    const { text: masked } = maskSecrets(file.text);
    const digest = sha256(masked);
    const prior = existing.get(file.path);

    if (prior && prior.sha256 === digest) {
      result.skipped_unchanged++;
      continue;
    }
    if (prior) {
      invalidateDocument(db, prior);
      result.documents_replaced++;
    } else {
      result.documents_created++;
    }

    const ext = extOf(file.path);
    const pieces = chunkDocument(masked, ext);

    const info = insertDoc.run({
      source_id: source.id,
      path: file.path,
      uri: path.join(source.uri, file.path),
      title: path.basename(file.path),
      doc_kind: ext || null,
      sha256: digest,
      bytes: file.bytes,
      mtime: file.mtime,
    });
    const documentId = Number(info.lastInsertRowid);
    result.chunks_created += await embedAndStoreChunks(db, documentId, pieces, opts.embedExec);
  }

  for (const [p, doc] of existing) {
    if (!seenPaths.has(p)) {
      invalidateDocument(db, doc);
      result.documents_invalidated++;
    }
  }

  touchSourceIngested(db, source.id);
  // SSoT Phase 3: rebuild the [[wikilink]] graph over every active markdown document —
  // wholesale, not scoped to this source, since a link's target may live in a different
  // source (see resyncDocumentWikilinks). Cheap relative to the walk/chunk/embed work above.
  resyncDocumentWikilinks(db);
  return result;
}

/** Runs every enabled source. */
export async function ingestAll(db: Database.Database, opts: IngestOptions = {}): Promise<IngestSourceResult[]> {
  const sources = listSources(db, { enabled: true });
  const out: IngestSourceResult[] = [];
  for (const s of sources) out.push(await ingestSource(db, s, opts));
  return out;
}

/** Runs a single source by id regardless of its enabled flag (an explicit request
 * overrides the auto-run filter that ingestAll applies). Returns undefined if not found. */
export async function ingestOne(
  db: Database.Database,
  sourceId: string,
  opts: IngestOptions = {},
): Promise<IngestSourceResult | undefined> {
  const source = getSource(db, sourceId);
  if (!source) return undefined;
  return ingestSource(db, source, opts);
}
