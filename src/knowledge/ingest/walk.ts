import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SourceRow, SourceConfig } from './types.js';
import { parseSourceConfig } from './types.js';

export interface WalkedFile {
  /** Path relative to the source root, POSIX separators. */
  path: string;
  /** Already read + governance-gated (size cap, binary sniff) — decoded utf8. */
  text: string;
  bytes: number;
  /** ISO mtime; null when unavailable (e.g. a git ref file not present in the working tree). */
  mtime: string | null;
}

/** Injectable so tests never shell out to a real `git` binary for the branch-listing
 * path; the default runs local (no-network) git commands, so no timeout is needed —
 * unlike the network git calls in src/git/{integrate,pr}.ts. */
export type GitListExec = (repoDir: string, args: string[]) => string;
export const realGitExec: GitListExec = (repoDir, args) =>
  execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });

// ---- governance: default excludes, size cap, secret filenames ----

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git']);
const LOCK_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
]);
const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|ico|webp|svg|mp3|mp4|wav|mov|avi|zip|tar|gz|tgz|7z|rar|pdf|exe|dll|so|dylib|bin|woff2?|ttf|eot|class|jar|pyc|o|a)$/i;
const SECRET_FILENAME = [
  /(^|\/)\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /credentials\.json$/i,
];

/** Minimal glob -> RegExp: `**` matches across path segments, `*` within one segment,
 * `?` matches one char. No external dependency — the patterns used here (include/exclude
 * lists on sources.config) are simple enough not to need a full glob library. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === undefined) continue;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(relPath: string, globs: string[] | undefined): boolean {
  if (!globs || !globs.length) return false;
  return globs.some((g) => globToRegExp(g).test(relPath));
}

function isDefaultExcluded(relPath: string): string | null {
  const parts = relPath.split('/');
  if (parts.some((p) => DEFAULT_EXCLUDE_DIRS.has(p))) return 'default-exclude';
  const base = parts[parts.length - 1] ?? '';
  if (LOCK_FILES.has(base)) return 'lockfile';
  if (BINARY_EXT.test(base)) return 'binary-ext';
  if (SECRET_FILENAME.some((re) => re.test(relPath))) return 'secret-filename';
  return null;
}

/** Governance gate applied uniformly regardless of source kind: default excludes,
 * include/exclude globs from the source's own config, and a per-file size cap. */
export function isGoverned(
  relPath: string,
  bytes: number,
  config: SourceConfig,
  maxFileKb: number,
): { allowed: boolean; reason?: string } {
  const defaultReason = isDefaultExcluded(relPath);
  if (defaultReason) return { allowed: false, reason: defaultReason };
  if (matchesAny(relPath, config.exclude)) return { allowed: false, reason: 'exclude-glob' };
  if (config.include && config.include.length && !matchesAny(relPath, config.include)) {
    return { allowed: false, reason: 'not-included' };
  }
  if (bytes > maxFileKb * 1024) return { allowed: false, reason: 'too-large' };
  return { allowed: true };
}

const SNIFF_BYTES = 512;

/** Reads + gates a single on-disk file: size cap, default/glob excludes, and a cheap
 * NUL-byte sniff for binaries whose extension isn't in BINARY_EXT. Best-effort — any
 * read error (race, permissions) is treated as skipped, never thrown. */
function readGoverned(
  absPath: string,
  relPath: string,
  config: SourceConfig,
  maxFileKb: number,
): WalkedFile | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const gate = isGoverned(relPath, stat.size, config, maxFileKb);
  if (!gate.allowed) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) return null; // binary sniff
  return {
    path: relPath,
    text: buf.toString('utf8'),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

/**
 * Git source: lists tracked files via `git ls-files` (respects .gitignore, tracked-only)
 * or, when config.branch is set, `git ls-tree` of that ref. Content is always read from
 * the on-disk working tree — a branch other than the checked-out one only narrows which
 * paths are considered; a listed path missing on disk is skipped (best-effort, same as
 * outputFiles.ts elsewhere in this repo).
 */
export function walkGitSource(source: SourceRow, maxFileKb: number, gitExec: GitListExec = realGitExec): WalkedFile[] {
  const config = parseSourceConfig(source.config);
  const repoDir = source.uri;
  const listing = config.branch
    ? gitExec(repoDir, ['ls-tree', '-r', '--name-only', config.branch])
    : gitExec(repoDir, ['ls-files']);
  const rels = listing
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out: WalkedFile[] = [];
  for (const rel of rels) {
    const file = readGoverned(path.join(repoDir, rel), rel, config, maxFileKb);
    if (file) out.push(file);
  }
  return out;
}

/** Folder/vault source: plain recursive walk (generalizes src/orchestrator/outputFiles.ts —
 * no cap, governance-gated instead of extension-allowlisted). */
export function walkFolderSource(source: SourceRow, maxFileKb: number): WalkedFile[] {
  const config = parseSourceConfig(source.config);
  const root = source.uri;
  const out: WalkedFile[] = [];
  function recurse(curAbs: string, curRel: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(curAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = curRel ? `${curRel}/${e.name}` : e.name;
      const abs = path.join(curAbs, e.name);
      if (e.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
        recurse(abs, rel);
      } else if (e.isFile()) {
        const file = readGoverned(abs, rel, config, maxFileKb);
        if (file) out.push(file);
      }
    }
  }
  recurse(root, '');
  return out;
}

/** Dispatch by source.kind. 'github-issues' is not a file-tree walk (see types.ts) and
 * returns no files here — that source kind is ingested through the existing GitHub issue
 * import path instead. */
export function walkSource(source: SourceRow, maxFileKb: number, gitExec: GitListExec = realGitExec): WalkedFile[] {
  if (source.kind === 'git') return walkGitSource(source, maxFileKb, gitExec);
  if (source.kind === 'folder' || source.kind === 'vault') return walkFolderSource(source, maxFileKb);
  return [];
}

// ---- secret scanning: content-level masking for files that otherwise passed governance ----

const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style secret key
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  // generic "key/secret/token/password = '...'" assignments (common high-signal pattern)
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9+/_=\-]{16,}['"]/gi,
];

/** Redacts common secret patterns (private key blocks, cloud/API tokens, generic
 * key/secret/token/password assignments) from otherwise-ingestable file content. Governs
 * content that SLIPPED PAST the filename-level exclusions above (e.g. a hardcoded key
 * inside an ordinary .ts file) — never throws, always returns text (masked or original). */
export function maskSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const re of SECRET_CONTENT_PATTERNS) {
    out = out.replace(re, () => {
      redactions++;
      return '[REDACTED]';
    });
  }
  return { text: out, redactions };
}
