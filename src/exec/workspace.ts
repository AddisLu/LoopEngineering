import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

/**
 * The host side of the sandbox's /work: where the chat page keeps one scratch directory per
 * conversation, and the file helpers its tools use. Every path a model hands us is resolved
 * against the workspace root and must stay inside it — `..`, absolute paths and symlinks that
 * point out (a container can create those in /work) are all refused.
 */

export class WorkspaceError extends Error {}

export function execRoot(): string {
  return path.join(paths.dataDir, 'exec');
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** `<dataDir>/exec/chat/<conversation id>` — not created here. */
export function chatWorkspaceDir(conversationId: string): string {
  if (!SAFE_ID.test(conversationId)) throw new WorkspaceError(`不合法的對話 id：${conversationId}`);
  return path.join(execRoot(), 'chat', conversationId);
}

/** mkdir -p, then the real path (the root every confinement check compares against). */
export function ensureWorkspace(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** Best-effort: a conversation's scratch files go with it. */
export function removeChatWorkspace(conversationId: string): boolean {
  let dir: string;
  try {
    dir = chatWorkspaceDir(conversationId);
  } catch {
    return false;
  }
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/**
 * Resolve `rel` (relative, or under the /work the model sees) to an absolute path inside `root`.
 * The deepest part of the path that already exists must also realpath inside the root, so a
 * symlink can't be used to walk out.
 */
export function resolveInWorkspace(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new WorkspaceError('path 不可為空');
  const cleaned = rel.trim().replace(/^\/work(\/|$)/, '');
  if (path.isAbsolute(cleaned)) throw new WorkspaceError(`只能用工作目錄裡的相對路徑（或 /work/…）：${rel}`);
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, cleaned || '.');
  if (!within(realRoot, abs)) throw new WorkspaceError(`路徑跑出工作目錄：${rel}`);
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  if (!within(realRoot, fs.realpathSync(probe))) throw new WorkspaceError(`路徑經由符號連結跑出工作目錄：${rel}`);
  return abs;
}

const rel = (root: string, abs: string): string => path.relative(fs.realpathSync(root), abs) || '.';

export const MAX_WRITE_BYTES = 1024 * 1024;

export function writeWorkspaceFile(root: string, p: unknown, content: unknown): { path: string; bytes: number } {
  if (typeof content !== 'string') throw new WorkspaceError('content 必須是字串');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) throw new WorkspaceError(`檔案太大（${bytes} bytes，上限 ${MAX_WRITE_BYTES}）`);
  const abs = resolveInWorkspace(root, p);
  if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) throw new WorkspaceError(`是資料夾，不是檔案：${String(p)}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // O_NOFOLLOW: a symlink swapped in after the check above still can't redirect the write
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return { path: rel(root, abs), bytes };
}

export const MAX_READ_BYTES = 64 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;

/** A window of lines from a text file (line numbers 1-based), capped at MAX_READ_BYTES of output. */
export function readWorkspaceFile(
  root: string,
  p: unknown,
  opts: { startLine?: unknown; maxLines?: unknown } = {},
): { path: string; text: string; totalLines: number; truncated: boolean } {
  const abs = resolveInWorkspace(root, p);
  if (!fs.existsSync(abs)) throw new WorkspaceError(`找不到：${String(p)}`);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new WorkspaceError(`是資料夾，不是檔案：${String(p)}（用 sandbox_list）`);
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.min(st.size, SCAN_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.subarray(0, 8192).includes(0)) throw new WorkspaceError(`二進位檔，不讀：${String(p)}`);
  const lines = buf.toString('utf8').split('\n');
  const start = Math.max(1, Math.floor(Number(opts.startLine) || 1));
  const max = Math.min(2000, Math.max(1, Math.floor(Number(opts.maxLines) || 400)));
  let out = '';
  let shown = 0;
  let cut = false;
  for (let i = start - 1; i < lines.length && shown < max; i++) {
    const line = `${String(i + 1).padStart(5)}| ${lines[i]}\n`;
    if (out.length + line.length > MAX_READ_BYTES) {
      cut = true;
      break;
    }
    out += line;
    shown++;
  }
  const more = start - 1 + shown < lines.length;
  const partial = st.size > SCAN_BYTES;
  return {
    path: rel(root, abs),
    text: out + (more || cut ? `…（還有 ${lines.length - (start - 1 + shown)} 行${partial ? '，檔案只掃描了前 8 MB' : ''}）` : ''),
    totalLines: lines.length,
    truncated: more || cut || partial,
  };
}

/** Recursive listing with sizes, depth- and count-limited. */
export function listWorkspace(root: string, p: unknown = '.', opts: { maxEntries?: number; depth?: number } = {}): string {
  const abs = resolveInWorkspace(root, typeof p === 'string' && p.trim() ? p : '.');
  if (!fs.existsSync(abs)) throw new WorkspaceError(`找不到：${String(p)}`);
  if (!fs.statSync(abs).isDirectory()) throw new WorkspaceError(`不是資料夾：${String(p)}`);
  const maxEntries = opts.maxEntries ?? 300;
  const maxDepth = opts.depth ?? 4;
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      const full = path.join(dir, e.name);
      const shown = rel(root, full);
      if (e.isDirectory()) {
        out.push(`${shown}/`);
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (e.isSymbolicLink()) {
        out.push(`${shown} -> (符號連結)`);
      } else {
        let size = '';
        try {
          size = ` (${fs.statSync(full).size} B)`;
        } catch {
          /* vanished */
        }
        out.push(`${shown}${size}`);
      }
    }
  };
  walk(abs, 1);
  if (!out.length) return '（空的）';
  return out.length >= maxEntries ? `${out.join('\n')}\n…（超過 ${maxEntries} 項，已截斷）` : out.join('\n');
}
