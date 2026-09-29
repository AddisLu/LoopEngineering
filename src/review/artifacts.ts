import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import type Database from 'better-sqlite3';
import { getNum, logEvent } from '../db/index.js';
import { paths } from '../config.js';
import { globToRegExp } from '../orchestrator/acceptance.js';
import { parseSandboxStep } from '../orchestrator/verify.js';
import { resolveExecTarget, remoteWorkdir, realHostExec, sshArgs, type ExecHost, type HostExec } from '../exec/hosts.js';
import { readMetrics, readVerify } from '../orchestrator/runSummary.js';
import { updateRun } from '../tasks.js';
import type { Task, TaskRun } from '../types.js';

/**
 * 產出物: the files a task produces that people take away — a built binary, an evaluation report,
 * an Nsight Compute report. They are declared per task (tasks.artifacts, CSV globs, usually from
 * the 驗證方案), kept out of the task's commits, and collected after verification passes into
 * <data>/artifacts/<task>/<run>/ with a manifest (sha256, size, which machine, which commit), so
 * they outlive the worktree and can be downloaded or published as a Gitea release.
 */

export interface ArtifactFile {
  path: string;
  size: number;
  sha256: string;
  /** 'local' (the worktree) or the sandbox machine it was built on */
  from: string;
}

export interface ArtifactManifest {
  task_id: string;
  run_id: string;
  title: string;
  repo: string | null;
  base: string | null;
  head_sha: string | null;
  created_at: string;
  globs: string[];
  files: ArtifactFile[];
  skipped: string[];
  metrics: ReturnType<typeof readMetrics>;
  verify: Array<{ step: string; ok: boolean; exitCode: number | null }>;
}

export const artifactsRoot = (): string => path.join(paths.dataDir, 'artifacts');
export const artifactDir = (taskId: string, runId: string): string => path.join(artifactsRoot(), taskId, runId);

export function artifactGlobs(task: Pick<Task, 'artifacts'>): string[] {
  return (task.artifacts ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** gitignore/rsync convention: a pattern without "/" matches the file name at any depth */
const matcher = (globs: string[]) => {
  const res = globs.map((g) => ({ re: globToRegExp(g), anyDepth: !g.includes('/') }));
  return (rel: string) => res.some(({ re, anyDepth }) => re.test(anyDepth ? rel.slice(rel.lastIndexOf('/') + 1) : rel));
};

/**
 * Unstage what matches the task's artifact globs before a commit, so a binary or a report never
 * lands in the branch (and from there in base and Gitea). Leaves the files on disk.
 */
export function unstageArtifacts(worktree: string, globs: string[]): string[] {
  if (!globs.length) return [];
  const match = matcher(globs);
  let staged: string[] = [];
  try {
    staged = execFileSync('git', ['-C', worktree, 'diff', '--cached', '--name-only', '-z'], { encoding: 'utf8', timeout: 30_000 })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
  const hits = staged.filter((p) => match(p));
  for (let i = 0; i < hits.length; i += 200) {
    try {
      execFileSync('git', ['-C', worktree, 'reset', '-q', '--', ...hits.slice(i, i + 200)], { timeout: 30_000 });
    } catch {
      /* best effort: the file stays staged */
    }
  }
  return hits;
}

/** Every file under `root` whose repo-relative path matches (skips .git), bounded. */
function walkMatches(root: string, match: (rel: string) => boolean, limit = 500): string[] {
  const out: string[] = [];
  let budget = 200_000;
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || budget-- <= 0) return;
      if (e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && match(rel)) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

const sha256File = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** The machines the task's `sandbox:` steps ran on (remote ones only — local builds are in the worktree). */
export function remoteHostsFor(db: Database.Database, task: Task): ExecHost[] {
  const hosts = new Map<string, ExecHost>();
  let steps: string[] = [];
  try {
    const v = JSON.parse(task.verification_steps || '[]');
    steps = Array.isArray(v) ? v.map(String) : [];
  } catch {
    steps = [];
  }
  for (const s of steps) {
    const sb = parseSandboxStep(s);
    if (!sb) continue;
    try {
      const t = resolveExecTarget(db, sb.host);
      if (t.kind === 'remote') hosts.set(t.host.name, t.host);
    } catch {
      /* an unknown host already failed verification */
    }
  }
  return [...hosts.values()];
}

export interface CollectDeps {
  hostExec?: HostExec;
}

/**
 * Collect the task's artifacts after a passing verification: from the worktree, then from each
 * remote sandbox machine its steps ran on (rsync back only the matching files; a remote copy wins,
 * it is what was actually built and measured). Never throws; null when nothing is declared.
 */
export async function collectArtifacts(
  db: Database.Database,
  task: Task,
  run: TaskRun,
  worktree: string,
  deps: CollectDeps = {},
): Promise<ArtifactManifest | null> {
  const globs = artifactGlobs(task);
  if (!globs.length) return null;
  const match = matcher(globs);
  const dest = artifactDir(task.id, run.id);
  const filesDir = path.join(dest, 'files');
  const maxBytes = getNum(db, 'artifacts_max_mb', 1024) * 1024 * 1024;
  const found = new Map<string, { abs: string; from: string }>();
  for (const rel of walkMatches(worktree, match)) found.set(rel, { abs: path.join(worktree, rel), from: 'local' });

  const staging: string[] = [];
  const exec = deps.hostExec ?? realHostExec;
  for (const h of remoteHostsFor(db, task)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-artifacts-'));
    staging.push(tmp);
    const remoteDir = remoteWorkdir(h, `task-${task.id}`);
    const r = await exec(
      'rsync',
      ['-a', '--prune-empty-dirs', '--include=*/', ...globs.map((g) => `--include=${g}`), '--exclude=*', '-e', ['ssh', ...sshArgs(h)].join(' '), `${h.ssh_target}:${remoteDir}/`, `${tmp}/`],
      10 * 60_000,
    );
    if (r.code !== 0) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `產出物：從 ${h.name} 收回失敗（${r.code === null ? '沒有 rsync' : r.out.slice(-200)}）` });
      continue;
    }
    for (const rel of walkMatches(tmp, match)) found.set(rel, { abs: path.join(tmp, rel), from: h.name });
  }

  const files: ArtifactFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  try {
    fs.rmSync(filesDir, { recursive: true, force: true });
    for (const [rel, src] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(src.abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (total + st.size > maxBytes) {
        skipped.push(`${rel}（超過 artifacts_max_mb）`);
        continue;
      }
      const to = path.join(filesDir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(src.abs, to);
      total += st.size;
      files.push({ path: rel, size: st.size, sha256: sha256File(to), from: src.from });
    }
  } finally {
    for (const t of staging) fs.rmSync(t, { recursive: true, force: true });
  }

  let head: string | null = null;
  try {
    head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    head = run.head_sha ?? null;
  }
  const manifest: ArtifactManifest = {
    task_id: task.id,
    run_id: run.id,
    title: task.title,
    repo: task.repo_path,
    base: task.base_branch,
    head_sha: head,
    created_at: new Date().toISOString(),
    globs,
    files,
    skipped,
    metrics: readMetrics(run),
    verify: readVerify(run).map((s) => ({ step: s.step, ok: s.ok, exitCode: s.exitCode })),
  };
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  updateRun(db, run.id, { artifacts_json: JSON.stringify({ dir: dest, files, head_sha: head, created_at: manifest.created_at, skipped }) });
  const mb = (total / 1024 / 1024).toFixed(1);
  logEvent(db, {
    task_id: task.id,
    run_id: run.id,
    kind: 'note',
    detail: files.length
      ? `產出物：收進 ${files.length} 個檔案（${mb} MB）${skipped.length ? `；略過 ${skipped.length} 個` : ''}`
      : `產出物：沒有找到符合 ${globs.join(', ')} 的檔案`,
  });
  return manifest;
}

/** The newest collected artifacts of a task. */
export function latestArtifacts(db: Database.Database, taskId: string): { run_id: string; manifest: ArtifactManifest } | null {
  const run = db
    .prepare('SELECT * FROM task_runs WHERE task_id = ? AND artifacts_json IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(taskId) as TaskRun | undefined;
  if (!run) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(artifactDir(taskId, run.id), 'manifest.json'), 'utf8')) as ArtifactManifest;
    return { run_id: run.id, manifest: m };
  } catch {
    return null;
  }
}

/** Absolute path of one collected file, or null when it is not one of them. */
export function artifactPath(taskId: string, runId: string, manifest: ArtifactManifest, rel: string): string | null {
  if (!manifest.files.some((f) => f.path === rel)) return null;
  const base = path.join(artifactDir(taskId, runId), 'files');
  const abs = path.resolve(base, rel);
  return abs.startsWith(path.resolve(base) + path.sep) && fs.existsSync(abs) ? abs : null;
}

// ---- zip -----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A plain ZIP (deflate, UTF-8 names) any OS opens; everything in memory, bounded by artifacts_max_mb. */
export function buildZip(entries: Array<{ name: string; data: Buffer; mtime?: Date }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(e.data);
    const deflate = deflated.length < e.data.length;
    const body = deflate ? deflated : e.data;
    const crc = crc32(e.data);
    const { time, date } = dosTime(e.mtime ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cen = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cen.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cen, end]);
}

/** The delivery package: every collected file, the manifest, and a readable report. */
export function packageZip(taskId: string, runId: string, manifest: ArtifactManifest, report: string): Buffer {
  const base = path.join(artifactDir(taskId, runId), 'files');
  const entries = manifest.files.map((f) => ({ name: `files/${f.path}`, data: fs.readFileSync(path.join(base, f.path)) }));
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  entries.push({ name: 'REPORT.md', data: Buffer.from(report) });
  entries.push({
    name: 'SHA256SUMS',
    data: Buffer.from(manifest.files.map((f) => `${f.sha256}  files/${f.path}`).join('\n') + '\n'),
  });
  return buildZip(entries);
}
