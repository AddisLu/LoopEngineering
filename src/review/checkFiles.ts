import fs from 'node:fs';
import path from 'node:path';

/**
 * The files a check run pulled back (<check-runs>/<run id>/: the software's {out}, overlays, logs) —
 * the 結果 page's 圖資回歸 pictures and GET /api/check-runs/:id/files/*. Nothing outside a run's own
 * folder is ever listed or served: the id is a plain name, the path is relative, and `..`, absolute
 * paths and symlinks that lead out are refused.
 */

export const CHECK_RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** <root>/<runId> when the id is a plain name (the folder may not exist). */
export function checkRunDir(root: string, runId: string): string | null {
  return CHECK_RUN_ID_RE.test(runId) ? path.join(root, runId) : null;
}

/** The real path of `rel` inside the run's folder, or null: a bad id or path, missing, not a file, or outside. */
export function resolveCheckRunFile(root: string, runId: string, rel: string): string | null {
  const dir = checkRunDir(root, runId);
  if (!dir || typeof rel !== 'string' || !rel || rel.length > 1024) return null;
  if (/[\0\\]/.test(rel) || path.isAbsolute(rel)) return null;
  if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  let realDir: string;
  let realFile: string;
  try {
    realDir = fs.realpathSync(dir);
    realFile = fs.realpathSync(path.join(dir, rel));
  } catch {
    return null;
  }
  if (!realFile.startsWith(realDir + path.sep)) return null;
  try {
    return fs.statSync(realFile).isFile() ? realFile : null;
  } catch {
    return null;
  }
}

/** Relative paths of the files under the run's folder, sorted; dot-files and symlinks skipped, capped. */
export function listCheckRunFiles(root: string, runId: string, cap = 20_000): string[] {
  const dir = checkRunDir(root, runId);
  if (!dir) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    if (out.length >= cap || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '', 0);
  return out;
}

const INLINE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  tsv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
};

/** Pictures and text are shown in place; anything else (svg and html included) only downloads. */
export function checkRunFileType(file: string): { type: string; inline: boolean } {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? '';
  const type = INLINE[ext];
  return type ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}
