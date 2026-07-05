import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { listRunsForTask } from '../tasks.js';
import { fetchBase, baseRefFor } from './integrate.js';
import type { Task } from '../types.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * Create an isolated worktree for a task on a fresh branch off baseBranch.
 * If the branch/worktree already exists (resume), reuse it.
 */
export function addWorktree(
  repoPath: string,
  branch: string,
  baseBranch: string,
  opts: { fetchBase?: boolean } = {},
): Worktree {
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  const wtPath = path.join(paths.worktreesDir, branch.replace(/[/\\]/g, '_'));

  if (fs.existsSync(wtPath)) return { path: wtPath, branch };

  const branchExists = (() => {
    try {
      git(repoPath, ['rev-parse', '--verify', '--quiet', branch]);
      return true;
    } catch {
      return false;
    }
  })();

  if (branchExists) {
    git(repoPath, ['worktree', 'add', wtPath, branch]);
  } else if (opts.fetchBase) {
    // Cut the new branch from the freshly-fetched origin tip. Resolve to a SHA start point
    // (not the ref) so the branch never picks up accidental upstream tracking.
    fetchBase(repoPath, baseBranch);
    let start = baseBranch;
    try {
      start = git(repoPath, ['rev-parse', baseRefFor(repoPath, baseBranch)]).trim();
    } catch {
      /* fall back to the local base branch */
    }
    git(repoPath, ['worktree', 'add', wtPath, '-b', branch, start]);
  } else {
    git(repoPath, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  }

  return { path: wtPath, branch };
}

/**
 * Resolve a path inside this worktree's PRIVATE git dir (e.g. .git/worktrees/<id>/<name>).
 * Such files are never tracked/committed and are removed together with the worktree — the
 * right place for loop-internal sentinels (setup-done). Falls back to a dotfile in the tree.
 */
export function worktreeInternalFile(worktreePath: string, name: string): string {
  try {
    const p = git(worktreePath, ['rev-parse', '--git-path', name]).trim();
    return path.isAbsolute(p) ? p : path.join(worktreePath, p);
  } catch {
    return path.join(worktreePath, `.${name}`);
  }
}

export function isDirty(worktreePath: string): boolean {
  const out = git(worktreePath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

/**
 * Add local-only ignore patterns to this checkout's info/exclude so `git add -A`
 * (commitAll) never stages them. Used to keep engine-written artifacts
 * (LOOP_TASK.md, .claude/settings.local.json) out of the task branch/PR. Best-effort:
 * worst case the files just show up in the diff. `git rev-parse --git-path` resolves
 * the right exclude file whether this is a plain repo or a linked worktree.
 */
export function excludeLocal(worktreePath: string, patterns: string[]): void {
  try {
    const rel = git(worktreePath, ['rev-parse', '--git-path', 'info/exclude']).trim();
    const abs = path.isAbsolute(rel) ? rel : path.join(worktreePath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let cur = '';
    try {
      cur = fs.readFileSync(abs, 'utf8');
    } catch {
      /* no exclude file yet */
    }
    const have = new Set(cur.split('\n').map((l) => l.trim()));
    const add = patterns.filter((p) => !have.has(p));
    if (add.length === 0) return;
    const prefix = cur.length > 0 && !cur.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(abs, prefix + add.join('\n') + '\n');
  } catch {
    /* best effort */
  }
}

export function commitAll(worktreePath: string, message: string): void {
  git(worktreePath, ['add', '-A']);
  git(worktreePath, ['commit', '--no-verify', '-m', message]);
}

export function diffstat(worktreePath: string, baseBranch: string): string {
  try {
    const ref = baseRefFor(worktreePath, baseBranch);
    return git(worktreePath, ['diff', '--stat', `${ref}...HEAD`]).trim();
  } catch {
    return '';
  }
}

/**
 * Defensive removal — never throw; caller records a manual-cleanup event on failure.
 * When `branch` is given, the (loop-created) branch is deleted too, so pruning a task
 * leaves no dangling ref behind. Branch deletion is best-effort and never fails the call.
 */
export function removeWorktree(repoPath: string, worktreePath: string, branch?: string | null): boolean {
  let ok: boolean;
  try {
    git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    ok = true;
  } catch {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      git(repoPath, ['worktree', 'prune']);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (branch) {
    try {
      git(repoPath, ['branch', '-D', branch]);
    } catch {
      /* branch already gone / checked out elsewhere — cleanup is best-effort */
    }
  }
  return ok;
}

/**
 * Resolve `p` and return it only if it lands strictly INSIDE `baseDir`. This is the
 * safety gate for every artifact deletion: we only ever remove Loop's own products
 * under the data dir, never the user's target repo. Returns null when `p` is empty,
 * equals `baseDir`, or escapes it (`..`, absolute elsewhere, symlink-style traversal).
 */
export function resolveInside(baseDir: string, p: string | null | undefined): string | null {
  if (!p) return null;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(p);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

function safeRm(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface ArtifactCleanup {
  worktrees: string[];
  logs: string[];
  plans: string[];
  /** Paths refused because they resolved OUTSIDE the data dir (never touched). */
  skipped: string[];
}

/**
 * Remove a task's on-disk artifacts: run worktrees (+ their branches), run logs, and
 * a synthesized plan file. SAFETY: every path is re-resolved and must land inside the
 * corresponding data-dir subtree (worktrees/ · logs/ · plans/) — anything outside
 * (e.g. a user-supplied plan.md in their repo) is recorded in `skipped` and never
 * deleted. Call BEFORE deleteTask (it reads task_runs). Never throws.
 */
export function pruneTaskArtifacts(db: Database.Database, task: Task): ArtifactCleanup {
  const out: ArtifactCleanup = { worktrees: [], logs: [], plans: [], skipped: [] };

  for (const run of listRunsForTask(db, task.id)) {
    const wt = resolveInside(paths.worktreesDir, run.worktree_path);
    if (run.worktree_path && !wt) out.skipped.push(run.worktree_path);
    else if (wt && fs.existsSync(wt)) {
      const removed = task.repo_path
        ? removeWorktree(task.repo_path, wt, run.branch)
        : safeRm(wt);
      if (removed) out.worktrees.push(wt);
    }

    const log = resolveInside(paths.logsDir, run.log_path);
    if (run.log_path && !log) out.skipped.push(run.log_path);
    else if (log && fs.existsSync(log) && safeRm(log)) out.logs.push(log);
  }

  // Synthesized plan files live under plans/; a URL or a user-supplied path elsewhere
  // is never ours to delete.
  if (task.plan_ref && task.plan_kind !== 'url') {
    const plan = resolveInside(paths.plansDir, task.plan_ref);
    if (!plan) out.skipped.push(task.plan_ref);
    else if (fs.existsSync(plan) && safeRm(plan)) out.plans.push(plan);
  }

  return out;
}
