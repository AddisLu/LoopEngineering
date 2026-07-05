import { execFileSync } from 'node:child_process';
import { hasRemote } from './integrate.js';

// hasRemote now lives in integrate.ts (shared with the whole git close-out path); re-export
// so existing importers of pr.ts keep working.
export { hasRemote };

// Network-capped like integrate.ts: a hung push/gh must never block the tick loop.
const NET_TIMEOUT = 30_000;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: NET_TIMEOUT });
}

function has(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
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
      timeout: 60_000,
    }).trim();
    const m = url.match(/https?:\/\/\S+/);
    return m ? m[0] : url || null;
  } catch {
    return null;
  }
}
