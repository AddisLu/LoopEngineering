/** sources.kind — what a registered ingestion source walks. 'github-issues' is reserved
 * (already handled by the existing src/integrations/github.ts issue import — not a
 * file-tree walk, not implemented by walk.ts). */
export const SOURCE_KIND = ['git', 'folder', 'vault', 'github-issues'] as const;
export type SourceKind = (typeof SOURCE_KIND)[number];

/** sources.config, parsed. include/exclude are globs matched against each file's path
 * relative to the source root (POSIX separators); branch only applies to kind='git'. */
export interface SourceConfig {
  include?: string[];
  exclude?: string[];
  branch?: string;
}

export interface SourceRow {
  id: string;
  kind: SourceKind;
  uri: string;
  config: string; // JSON — see SourceConfig
  enabled: number; // 0|1 (better-sqlite3 has no native boolean)
  last_ingested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: number;
  source_id: string;
  path: string;
  uri: string | null;
  title: string | null;
  doc_kind: string | null;
  sha256: string | null;
  bytes: number | null;
  mtime: string | null;
  lang: string | null;
  invalid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: number;
  document_id: number;
  ord: number;
  text: string;
  section: string | null;
  start_line: number | null;
  end_line: number | null;
  sha256: string | null;
  invalid_at: string | null;
  created_at: string;
}

/** Best-effort parse — a malformed/missing config degrades to "no extra rules" rather
 * than failing the whole ingest run. */
export function parseSourceConfig(raw: string): SourceConfig {
  try {
    const c = JSON.parse(raw);
    return c && typeof c === 'object' ? (c as SourceConfig) : {};
  } catch {
    return {};
  }
}
