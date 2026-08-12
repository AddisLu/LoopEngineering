/** sources.kind — what a registered ingestion source walks. 'github-issues' is reserved
 * (already handled by the existing src/integrations/github.ts issue import — not a
 * file-tree walk, not implemented by walk.ts). 'openproject' is not a file-tree walk
 * either — see src/knowledge/ingest/openproject.ts. 'github' is a REMOTE repo (uri is
 * owner/repo or a clone URL, not a local path): each ingest run syncs an engine-owned
 * clone under the data dir and then walks it exactly like a 'git' source — see
 * src/knowledge/ingest/github.ts. */
export const SOURCE_KIND = ['git', 'folder', 'vault', 'github-issues', 'openproject', 'github'] as const;
export type SourceKind = (typeof SOURCE_KIND)[number];

/** sources.config, parsed. include/exclude are globs matched against each file's path
 * relative to the source root (POSIX separators); branch only applies to kind='git'.
 * op_repo/op_config/kinds only apply to kind='openproject' (source.uri is the resolved
 * op_base_url for that kind, not a filesystem path — see openproject.ts). */
export interface SourceConfig {
  include?: string[];
  exclude?: string[];
  branch?: string;
  /** Local path to the user's OpenProject_Exec_Report repo, reused for its op_api.py
   * client (zero external deps, already wraps auth/pagination/normalize). */
  op_repo?: string;
  /** Override path to that repo's config.json (default: `<op_repo>/config.json`). */
  op_config?: string;
  /** Which item kinds to dump; default ['work_packages', 'projects']. */
  kinds?: string[];
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
