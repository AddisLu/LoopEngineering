import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { baseRefFor } from '../git/integrate.js';
import type { Task, TaskRun } from '../types.js';

/**
 * Where a task's code can be read from, for people checking the result (驗收頁) and for the
 * chat's loop_task_result. The run's worktree is reclaimed as soon as its work is merged or a
 * PR exists, so the usual morning case has no worktree: the code is then read from git — the
 * commit verification looked at (task_runs.head_sha) against the base it was measured on
 * (base_sha), or the loop/<id> branch. Local git only, never the network.
 */

export interface CodeRef {
  /** where git runs: the live worktree, else the task's repo (they share one object store) */
  gitDir: string;
  /** the task's version: a sha, or HEAD of a live worktree */
  head: string;
  /** what "changed" is measured against */
  base: string;
  /** set while the worktree still exists (its files can be read and run) */
  worktree: string | null;
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
  path: string;
  old_path?: string;
}

const git = (dir: string, args: string[], maxBuffer = 8 * 1024 * 1024): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });

const exists = (dir: string, rev: string): boolean => {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/** HEAD and merge-base(HEAD, base) of a worktree, recorded with each verification. */
export function verifiedShas(worktree: string, base: string): { head_sha: string | null; base_sha: string | null } {
  try {
    const head = git(worktree, ['rev-parse', 'HEAD']).trim();
    let mb: string | null = null;
    try {
      mb = git(worktree, ['merge-base', 'HEAD', baseRefFor(worktree, base)]).trim() || null;
    } catch {
      mb = null;
    }
    return { head_sha: head || null, base_sha: mb };
  } catch {
    return { head_sha: null, base_sha: null };
  }
}

export function codeRefFor(db: Database.Database, task: Task): CodeRef | null {
  if (!task.repo_path) return null;
  const runs = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC').all(task.id) as TaskRun[];
  const live = runs.find((r) => r.worktree_path && fs.existsSync(r.worktree_path));
  const base = task.base_branch ?? 'main';
  if (live?.worktree_path) {
    const wt = live.worktree_path;
    let mb: string | null = null;
    try {
      mb = git(wt, ['merge-base', 'HEAD', baseRefFor(wt, base)]).trim() || null;
    } catch {
      mb = null;
    }
    const verified = runs.find((r) => r.base_sha);
    return { gitDir: wt, head: 'HEAD', base: mb ?? verified?.base_sha ?? baseRefFor(wt, base), worktree: wt };
  }
  if (!fs.existsSync(task.repo_path)) return null;
  const verified = runs.find((r) => r.head_sha && r.base_sha && exists(task.repo_path!, r.head_sha));
  if (verified) return { gitDir: task.repo_path, head: verified.head_sha!, base: verified.base_sha!, worktree: null };
  const branch = `refs/heads/loop/${task.id}`;
  if (!exists(task.repo_path, branch)) return null;
  let mb: string | null = null;
  try {
    mb = git(task.repo_path, ['merge-base', branch, baseRefFor(task.repo_path, base)]).trim() || null;
  } catch {
    mb = null;
  }
  return mb ? { gitDir: task.repo_path, head: branch, base: mb, worktree: null } : null;
}

/** Changed files, base..head (plus uncommitted edits while the worktree is live). */
export function changedFiles(ref: CodeRef, limit = 300): ChangedFile[] {
  const args = ref.worktree ? ['diff', '--name-status', '-M', ref.base] : ['diff', '--name-status', '-M', `${ref.base}..${ref.head}`];
  let out = '';
  try {
    out = git(ref.gitDir, args);
  } catch {
    return [];
  }
  const files: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = (parts[0] ?? '').charAt(0) as ChangedFile['status'];
    if (code === 'R' || code === 'C') files.push({ status: code, old_path: parts[1], path: parts[2] ?? parts[1]! });
    else if (parts[1]) files.push({ status: code, path: parts[1] });
    if (files.length >= limit) break;
  }
  if (ref.worktree) {
    // new files the agent has not committed yet (auto-commit happens when the run ends)
    try {
      for (const p of git(ref.gitDir, ['ls-files', '--others', '--exclude-standard']).split('\n')) {
        if (p.trim() && files.length < limit && !files.some((f) => f.path === p)) files.push({ status: 'A', path: p });
      }
    } catch {
      /* listing only */
    }
  }
  return files;
}

/** A repo-relative path a caller may ask for: no absolute paths, no .., no backslashes. */
export function safeRepoPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (!s || s.length > 500 || s.startsWith('/') || s.startsWith('-') || /[\\\0]/.test(s)) return null;
  if (s.split('/').some((seg) => seg === '..' || seg === '' || seg === '.git')) return null;
  return s;
}

export interface SourceFile {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
  /** 'worktree' = current files on disk; otherwise the commit it was read from */
  from: string;
}

const MAX_SOURCE = 512 * 1024;

/** One file of the task's version (what `side` = 'base' looked like before, for comparison). */
export function readSource(ref: CodeRef, rel: string, side: 'head' | 'base' = 'head'): SourceFile | null {
  const p = safeRepoPath(rel);
  if (!p) return null;
  let buf: Buffer;
  let from: string;
  if (side === 'head' && ref.worktree) {
    const abs = path.resolve(ref.worktree, p);
    if (!abs.startsWith(path.resolve(ref.worktree) + path.sep)) return null;
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile()) return null;
      buf = fs.readFileSync(abs);
    } catch {
      return null;
    }
    from = 'worktree';
  } else {
    const rev = side === 'head' ? ref.head : ref.base;
    try {
      buf = execFileSync('git', ['-C', ref.gitDir, 'show', `${rev}:${p}`], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
    from = rev;
  }
  const binary = buf.subarray(0, 8000).includes(0);
  const truncated = buf.length > MAX_SOURCE;
  return {
    path: p,
    size: buf.length,
    binary,
    truncated,
    text: binary ? null : buf.subarray(0, MAX_SOURCE).toString('utf8'),
    from,
  };
}

/** Unified diff of one file (or the whole change when rel is omitted), capped. */
export function fileDiff(ref: CodeRef, rel?: string, maxChars = 400_000): string {
  const p = rel === undefined ? null : safeRepoPath(rel);
  if (rel !== undefined && !p) return '';
  const args = ref.worktree ? ['diff', '-M', ref.base] : ['diff', '-M', `${ref.base}..${ref.head}`];
  if (p) args.push('--', p);
  try {
    const out = git(ref.gitDir, args, 32 * 1024 * 1024);
    return out.length > maxChars ? `${out.slice(0, maxChars)}\n… (差異太長，只顯示前 ${maxChars} 字)` : out;
  } catch {
    return '';
  }
}
