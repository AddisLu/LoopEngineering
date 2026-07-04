import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

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
export function addWorktree(repoPath: string, branch: string, baseBranch: string): Worktree {
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

  if (branchExists) git(repoPath, ['worktree', 'add', wtPath, branch]);
  else git(repoPath, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);

  return { path: wtPath, branch };
}

export function isDirty(worktreePath: string): boolean {
  const out = git(worktreePath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

export function commitAll(worktreePath: string, message: string): void {
  git(worktreePath, ['add', '-A']);
  git(worktreePath, ['commit', '--no-verify', '-m', message]);
}

export function diffstat(worktreePath: string, baseBranch: string): string {
  try {
    return git(worktreePath, ['diff', '--stat', `${baseBranch}...HEAD`]).trim();
  } catch {
    return '';
  }
}

/** Defensive removal — never throw; caller records a manual-cleanup event on failure. */
export function removeWorktree(repoPath: string, worktreePath: string): boolean {
  try {
    git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    return true;
  } catch {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      git(repoPath, ['worktree', 'prune']);
      return true;
    } catch {
      return false;
    }
  }
}
