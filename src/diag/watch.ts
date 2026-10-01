import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getNum, getSetting, logEvent } from '../db/index.js';
import { listRepos } from '../repo/store.js';
import { parseDiag } from './parse.js';
import { createReport, runDiagnosis, type DiagnoseDeps } from './diagnose.js';

/**
 * 機況 from the line, without anyone pasting: `diag_watch_dirs` lists folders the machines write
 * their flight-recorder output to (a shared folder, or a Loop-owned clone of a Gitea repo the
 * machines push to — that one is `git pull --ff-only`ed first). Every pump (diag_watch_interval_min)
 * takes the new or changed incident_*.json / *.jsonl / *.log files, and when they hold an incident
 * or an error, opens one 機況診斷 report (source 'watch') for that folder and diagnoses it. Files are
 * remembered in diag_seen so nothing is diagnosed twice. Off while diag_watch_dirs is empty.
 *
 *   diag_watch_dirs: one entry per line or comma: `<repo name or id>=<folder>` (the repo the
 *   output belongs to; `=<folder>` alone = no repo)
 */

const FILE_RE = /(^incident_.*\.json$|\.jsonl$|\.log$)/i;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 40;

export interface WatchEntry {
  repoId: string | null;
  dir: string;
}

export function parseWatchDirs(db: Database.Database, raw: string): WatchEntry[] {
  const repos = listRepos(db);
  return raw
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf('=');
      const name = i >= 0 ? x.slice(0, i).trim() : '';
      const dir = (i >= 0 ? x.slice(i + 1) : x).trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
      const repo = name ? repos.find((r) => r.id === name || r.name === name) : null;
      return { repoId: repo?.id ?? null, dir };
    })
    .filter((e) => path.isAbsolute(e.dir));
}

function walk(dir: string, depth = 3, out: string[] = []): string[] {
  if (depth < 0 || out.length > 5000) return out;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out);
    else if (e.isFile() && FILE_RE.test(e.name)) out.push(p);
  }
  return out;
}

export interface WatchDeps {
  diagnose?: DiagnoseDeps;
  /** git pull of a watched clone (tests inject) */
  pull?: (dir: string) => void;
}

const defaultPull = (dir: string) => {
  try {
    execFileSync('git', ['-C', dir, 'pull', '--ff-only', '-q'], { timeout: 30_000, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch {
    /* offline or diverged: read what is there */
  }
};

/** One pass over every watched folder; returns the report ids it opened. */
export async function scanWatchDirs(db: Database.Database, deps: WatchDeps = {}): Promise<string[]> {
  const entries = parseWatchDirs(db, getSetting(db, 'diag_watch_dirs') ?? '');
  const opened: string[] = [];
  const seen = db.prepare('SELECT mtime_ms FROM diag_seen WHERE path = ?');
  const mark = db.prepare(`INSERT INTO diag_seen (path, mtime_ms, seen_at) VALUES (?, ?, datetime('now')) ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, seen_at = excluded.seen_at`);
  for (const e of entries) {
    if (!fs.existsSync(e.dir)) continue;
    if (fs.existsSync(path.join(e.dir, '.git'))) (deps.pull ?? defaultPull)(e.dir);
    const fresh: Array<{ file: string; mtime: number }> = [];
    for (const file of walk(e.dir)) {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE) continue;
      const prev = seen.get(file) as { mtime_ms: number } | undefined;
      if (prev && prev.mtime_ms >= Math.floor(st.mtimeMs)) continue;
      fresh.push({ file, mtime: Math.floor(st.mtimeMs) });
    }
    if (!fresh.length) continue;
    fresh.sort((a, b) => a.mtime - b.mtime);
    const batch = fresh.slice(-MAX_FILES);
    const inputs = batch.map((f) => ({ name: path.relative(e.dir, f.file), text: fs.readFileSync(f.file, 'utf8') }));
    db.transaction(() => {
      for (const f of fresh) mark.run(f.file, f.mtime);
    })();
    // only what went wrong becomes a report: plain session lines are just remembered
    const parsed = parseDiag(inputs);
    if (!parsed.incidents.length && !parsed.errors.length) continue;
    try {
      const rep = createReport(db, { repo_id: e.repoId, inputs, source: 'watch', note: `自動：${e.dir} 有 ${batch.length} 個新的機況檔` }, 'diag-watch');
      opened.push(rep.id);
      logEvent(db, { kind: 'note', detail: `機況監看：${e.dir} → 診斷 ${rep.id}（incident ${parsed.incidents.length}、錯誤 ${parsed.errors.length}）` });
      await runDiagnosis(db, rep.id, deps.diagnose ?? {});
    } catch (err) {
      logEvent(db, { kind: 'note', detail: `機況監看：${e.dir} 讀取失敗：${(err as Error).message.slice(0, 200)}` });
    }
  }
  return opened;
}

let lastPump = 0;
let pumping = false;

/** The tick's pump: throttled to diag_watch_interval_min, one pass at a time, never throws. */
export async function pumpDiagWatch(db: Database.Database, now = Date.now(), deps: WatchDeps = {}): Promise<void> {
  if (pumping || !(getSetting(db, 'diag_watch_dirs') ?? '').trim()) return;
  const every = Math.max(1, getNum(db, 'diag_watch_interval_min', 10)) * 60_000;
  if (now - lastPump < every) return;
  lastPump = now;
  pumping = true;
  try {
    await scanWatchDirs(db, deps);
  } catch (err) {
    console.error('[diag-watch]', err);
  } finally {
    pumping = false;
  }
}
