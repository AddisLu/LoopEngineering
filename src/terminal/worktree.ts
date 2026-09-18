import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { ENGINE_REPO_ROOT } from '../config.js';
import type { TerminalUser } from './sessions.js';

/**
 * 專屬 worktree: every person who opens a browser shell gets their own git worktree of the Loop
 * repo, and the shell starts there.
 *
 * Why this exists: the engine cuts its own worktrees from this checkout and self-updates from it,
 * and a dirty working tree downgrades every running task's auto-merge to `pending`. So a guest
 * editing the live checkout does not just risk their own work — it silently changes what the
 * engine does. `git worktree add` never touches the main checkout's HEAD, index or branches, so
 * everyone can branch freely while the checkout the engine runs from stays clean.
 *
 * Failure is never fatal: a shell that cannot get a worktree opens in the repo root with a line
 * saying why (see TerminalManager.open).
 */

export class WorktreeError extends Error {}

export interface WorktreeDeps {
  /** injected in tests; returns stdout, throws on a non-zero exit */
  git?: (args: string[], cwd: string) => string;
  home?: string;
}

export interface UserWorktree {
  path: string;
  branch: string;
  created: boolean;
}

const GIT_TIMEOUT_MS = 15_000;

/** Local git, always bounded: a hung git must never block a shell from opening. */
function defaultGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A directory-safe name for a user_key ('ts:<login>' | 'name:<name>' | 'local'). The readable part
 * is kept when it survives sanitising (a Chinese name does not), and a short hash of the whole key
 * keeps two people from landing in one directory.
 */
export function worktreeSlug(user: Pick<TerminalUser, 'user_key'>): string {
  const key = user.user_key.trim();
  if (key === 'local') return 'local';
  const raw = key.replace(/^(ts|name):/, '').split('@')[0] ?? '';
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 24);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 4);
  return base ? `${base}-${hash}` : `u-${hash}`;
}

/** Where the per-user worktrees live (setting terminal_worktree_root). */
export function worktreeRoot(db: Database.Database, home = os.homedir()): string {
  const set = (getSetting(db, 'terminal_worktree_root') ?? '').trim();
  return set || path.join(home, 'Addis', 'loop-worktrees');
}

/** The repo the worktrees are cut from: terminal_cwd when it is a git repo, else this checkout. */
export function worktreeSource(db: Database.Database, git = defaultGit): string {
  const want = (getSetting(db, 'terminal_cwd') ?? '').trim();
  if (want) {
    try {
      git(['rev-parse', '--git-dir'], want);
      return want;
    } catch {
      /* not a repo (or gone) — fall back to the engine's own checkout */
    }
  }
  return ENGINE_REPO_ROOT;
}

/** Where this user's shell would land. Pure: computes the path, creates nothing. */
export function userWorktreePath(db: Database.Database, user: Pick<TerminalUser, 'user_key'>, home = os.homedir()): string {
  return path.join(worktreeRoot(db, home), worktreeSlug(user));
}

/** The branch a user's worktree checks out. One per person, reused across sessions. */
export function userBranch(user: Pick<TerminalUser, 'user_key'>): string {
  return `desk/${worktreeSlug(user)}`;
}

/** The branch a new worktree starts from: `main` when it exists, else whatever HEAD points at. */
function baseRef(repo: string, git: (args: string[], cwd: string) => string): string {
  for (const ref of ['refs/heads/main', 'refs/heads/master']) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref], repo);
      return ref.replace('refs/heads/', '');
    } catch {
      /* try the next one */
    }
  }
  return 'HEAD';
}

function isWorktree(dir: string, git: (args: string[], cwd: string) => string): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * This user's worktree, made if it is not there yet. Never touches the source checkout's HEAD or
 * any checked-out branch — `git worktree add` only writes the new directory plus its own metadata.
 */
export function ensureUserWorktree(db: Database.Database, user: Pick<TerminalUser, 'user_key'>, deps: WorktreeDeps = {}): UserWorktree {
  const git = deps.git ?? defaultGit;
  const home = deps.home ?? os.homedir();
  const dir = userWorktreePath(db, user, home);
  const branch = userBranch(user);
  if (fs.existsSync(dir)) {
    if (isWorktree(dir, git)) return { path: dir, branch, created: false };
    throw new WorktreeError(`${dir} 已經存在但不是 git worktree`);
  }

  const repo = worktreeSource(db, git);
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch (err) {
    throw new WorktreeError(`建不了 ${path.dirname(dir)}：${(err as Error).message}`);
  }
  try {
    git(['worktree', 'prune'], repo); // a directory someone deleted by hand would block the add
    const known = (() => {
      try {
        git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo);
        return true;
      } catch {
        return false;
      }
    })();
    // reuse the person's branch across worktrees; only cut a new one the first time
    if (known) git(['worktree', 'add', dir, branch], repo);
    else git(['worktree', 'add', '-b', branch, dir, baseRef(repo, git)], repo);
  } catch (err) {
    const msg = (err as Error & { stderr?: Buffer | string }).stderr?.toString().trim() || (err as Error).message;
    throw new WorktreeError(`git worktree add 失敗：${msg.slice(0, 200)}`);
  }
  return { path: dir, branch, created: true };
}
