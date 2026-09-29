import { execFileSync } from 'node:child_process';
import { hasRemote } from './integrate.js';
import { createGiteaPr, giteaRepoFor } from './gitea.js';

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

export interface PrOptions {
  /** the branch the PR targets (Gitea needs it; gh infers it) */
  base?: string | null;
  /** PR description (Gitea); gh keeps using --fill */
  body?: string;
  /** local Gitea: used when origin lives on this server (setting gitea_url + GITEA_TOKEN) */
  gitea?: { url: string; token: string } | null;
  fetchImpl?: typeof fetch;
  /** called with why a Gitea PR could not be opened (the caller logs it on the task) */
  onError?: (msg: string) => void;
}

/**
 * Push the task branch and open a PR: through Gitea's API when origin is the configured Gitea
 * server, otherwise with `gh`. Host-only and fully guarded: returns null (never throws) when
 * there's no remote, no way to open a PR, or anything fails — the task still reaches review,
 * just with a local diff instead of a PR link.
 */
export async function createPr(worktree: string, branch: string, title: string, opts: PrOptions = {}): Promise<string | null> {
  if (!hasRemote(worktree)) return null;
  let giteaRepo = null;
  if (opts.gitea?.url && opts.base) {
    try {
      giteaRepo = giteaRepoFor(opts.gitea.url, git(worktree, ['remote', 'get-url', 'origin']).trim());
    } catch {
      giteaRepo = null;
    }
  }
  if (!giteaRepo && !has('gh')) return null;
  try {
    git(worktree, ['push', '-u', 'origin', branch]);
  } catch {
    return null;
  }
  if (giteaRepo) {
    if (!opts.gitea!.token) {
      opts.onError?.('Gitea PR skipped: GITEA_TOKEN is not set (~/.config/loop-engineering/env)');
      return null;
    }
    const r = await createGiteaPr(opts.gitea!.url, opts.gitea!.token, giteaRepo, { head: branch, base: opts.base!, title, body: opts.body ?? '' }, opts.fetchImpl);
    if (!r.url && r.error) opts.onError?.(r.error);
    return r.url;
  }
  try {
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
