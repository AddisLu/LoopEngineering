import { execFileSync } from 'node:child_process';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function has(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function hasRemote(repo: string): boolean {
  try {
    return git(repo, ['remote']).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Push the task branch and open a PR with `gh`. Host-only and fully guarded: returns
 * null (never throws) when there's no remote, gh is missing, or anything fails — the
 * task still reaches review, just with a local diff instead of a PR link.
 */
export function createPr(worktree: string, branch: string, title: string): string | null {
  if (!hasRemote(worktree) || !has('gh')) return null;
  try {
    git(worktree, ['push', '-u', 'origin', branch]);
    const url = execFileSync('gh', ['pr', 'create', '--fill', '--title', title, '--head', branch], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim();
    const m = url.match(/https?:\/\/\S+/);
    return m ? m[0] : url || null;
  } catch {
    return null;
  }
}
