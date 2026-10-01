import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Evidence, GitExec } from './types.js';

/**
 * The shared read-only view of a checkout every analyzer works from: the tracked files
 * (`git ls-files`, minus vendored / build output dirs) and a cached, size-capped, binary-skipping
 * file reader. Nothing here writes to the checkout.
 */

export const MAX_FILE_BYTES = 512 * 1024;
/** source files read for requirements / index at most (a monorepo must not stall the tick) */
export const MAX_SCAN_FILES = 6000;

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'out', 'bin', 'obj', 'vendor', 'third_party', '.git', '__pycache__']);

export const defaultGit: GitExec = (args, cwd) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // `git grep` exits 1 when nothing matched — that is an empty answer, not a failure
    const err = e as { status?: number; stdout?: string };
    if (args.includes('grep') && err.status === 1) return typeof err.stdout === 'string' ? err.stdout : '';
    throw e;
  }
};

export type FileEncoding = 'ascii' | 'utf8' | 'utf8_bom' | 'big5' | 'other';

/** UTF-8 BOM / valid UTF-8 / plausible Big5 / other; pure ASCII is its own answer. */
export function detectEncoding(buf: Buffer): FileEncoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8_bom';
  let ascii = true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i]! >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return 'ascii';
  if (isUtf8(buf)) return 'utf8';
  // Big5: every high byte is a lead 0x81–0xFE followed by a trail 0x40–0x7E / 0xA1–0xFE
  let pairs = 0;
  let bad = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b < 0x80) continue;
    const t = buf[i + 1];
    if (b >= 0x81 && b <= 0xfe && t !== undefined && ((t >= 0x40 && t <= 0x7e) || (t >= 0xa1 && t <= 0xfe))) {
      pairs++;
      i++;
    } else bad++;
  }
  return pairs > 0 && bad / (pairs + bad) < 0.05 ? 'big5' : 'other';
}

function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

let big5Decoder: InstanceType<typeof TextDecoder> | null | undefined;
function decode(buf: Buffer, enc: FileEncoding): string {
  if (enc === 'utf8_bom') return buf.subarray(3).toString('utf8');
  if (enc === 'big5') {
    if (big5Decoder === undefined) {
      try {
        big5Decoder = new TextDecoder('big5');
      } catch {
        big5Decoder = null;
      }
    }
    if (big5Decoder) return big5Decoder.decode(buf);
    return buf.toString('latin1');
  }
  if (enc === 'other') return buf.toString('latin1');
  return buf.toString('utf8');
}

export interface FileContent {
  encoding: FileEncoding;
  text: string;
  lines: string[];
}

export interface RepoCtx {
  dir: string;
  git: GitExec;
  /** tracked files outside skipped dirs, '/'-separated, sorted */
  files: string[];
  fileSet: Set<string>;
  warnings: string[];
  /** cached read; null for missing / > 512 KB / binary files */
  read(file: string): FileContent | null;
  /** 1-based line of a character offset in a file's text */
  lineAt(file: string, index: number): number;
}

export const extOf = (f: string): string => {
  const base = f.slice(f.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};
export const baseOf = (f: string): string => f.slice(f.lastIndexOf('/') + 1);
export const dirOf = (f: string): string => {
  const i = f.lastIndexOf('/');
  return i < 0 ? '.' : f.slice(0, i);
};
export const depthOf = (f: string): number => f.split('/').length - 1;
/** `file` is inside module dir `dir` ('.' = the whole repo) */
export const under = (file: string, dir: string): boolean => dir === '.' || dir === '' || file === dir || file.startsWith(dir + '/');
export const joinRel = (dir: string, rel: string): string => {
  const p = path.posix.normalize((dir === '.' ? '' : dir + '/') + rel.replace(/\\/g, '/'));
  return p.replace(/^\.\//, '');
};

export const CPP_EXT = new Set(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'inl', 'cu', 'cuh', 'ipp']);
export const HEADER_EXT = new Set(['h', 'hh', 'hpp', 'hxx', 'cuh']);
export const CODE_EXT = new Set([...CPP_EXT, 'cs', 'py']);
export const LANG_OF_EXT: Record<string, string> = {
  c: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', inl: 'cpp', ipp: 'cpp',
  cu: 'cuda', cuh: 'cuda', cs: 'csharp', py: 'python', ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript',
  go: 'go', rs: 'rust', java: 'java', sh: 'shell', ps1: 'powershell', bat: 'batch', cmd: 'batch', vb: 'vb', fs: 'fsharp',
};
export const langOf = (f: string): string | null => LANG_OF_EXT[extOf(f)] ?? null;

export function ev(file: string, line?: number | null, text?: string | null): Evidence {
  const t = text == null ? null : text.trim().slice(0, 200);
  return { file, line: line ?? null, text: t || null };
}

export function skipPath(f: string): boolean {
  const parts = f.split('/');
  for (let i = 0; i < parts.length - 1; i++) if (SKIP_DIRS.has(parts[i]!.toLowerCase())) return true;
  return false;
}

export function buildCtx(dir: string, git: GitExec, warnings: string[]): RepoCtx {
  let files: string[] = [];
  try {
    files = git(['ls-files', '-z'], dir)
      .split('\0')
      .filter(Boolean)
      .filter((f) => !skipPath(f))
      .sort();
  } catch (e) {
    warnings.push(`git ls-files 失敗：${(e as Error).message.split('\n')[0]}`);
  }
  const cache = new Map<string, FileContent | null>();
  const starts = new Map<string, number[]>();
  const read = (file: string): FileContent | null => {
    if (cache.has(file)) return cache.get(file)!;
    let out: FileContent | null = null;
    try {
      const abs = path.join(dir, file);
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        const bytes = fs.readFileSync(abs);
        const probe = bytes.subarray(0, 8000);
        if (!probe.includes(0)) {
          const encoding = detectEncoding(bytes);
          const text = decode(bytes, encoding);
          out = { encoding, text, lines: text.split('\n') };
        }
      }
    } catch {
      out = null;
    }
    cache.set(file, out);
    return out;
  };
  const lineAt = (file: string, index: number): number => {
    let s = starts.get(file);
    if (!s) {
      s = [0];
      const t = read(file)?.text ?? '';
      for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) s.push(i + 1);
      starts.set(file, s);
    }
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { dir, git, files, fileSet: new Set(files), warnings, read, lineAt };
}

/** the text of line `n` (1-based) of a file, trimmed */
export function lineText(ctx: RepoCtx, file: string, n: number): string {
  return (ctx.read(file)?.lines[n - 1] ?? '').trim();
}

/** code files to scan (capped, with a warning when the cap bites) */
export function codeFiles(ctx: RepoCtx, exts: Set<string> = CODE_EXT): string[] {
  const all = ctx.files.filter((f) => exts.has(extOf(f)));
  if (all.length > MAX_SCAN_FILES) {
    const msg = `原始碼檔案 ${all.length} 個，只掃描前 ${MAX_SCAN_FILES} 個`;
    if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
    return all.slice(0, MAX_SCAN_FILES);
  }
  return all;
}
