import { execFileSync } from 'node:child_process';

// Same shape as worktree.ts:git — thin wrapper over `git -C <dir> ...`. Every
// NETWORK-touching call in this file additionally passes { timeout } and is wrapped in
// try/catch: these helpers must NEVER throw and NEVER hang the orchestrator loop.
function git(dir: string, args: string[], opts: { timeout?: number } = {}): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: opts.timeout });
}

const NET_TIMEOUT = 30_000;

/**
 * True when the repo has at least one configured remote. Moved here from pr.ts so the
 * whole git close-out path shares one definition (pr.ts re-imports it). Never throws.
 */
export function hasRemote(dir: string): boolean {
  try {
    return git(dir, ['remote']).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * `git fetch origin <base>` (30s cap). No-op returning false when there is no remote or
 * the fetch fails/hangs — callers fall back to the local base ref.
 */
export function fetchBase(gitDir: string, base: string): boolean {
  if (!hasRemote(gitDir)) return false;
  try {
    git(gitDir, ['fetch', 'origin', base], { timeout: NET_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ref to integrate against: 'origin/<base>' when it resolves (a fetch has populated
 * it), else the local '<base>'. Lets every caller prefer the freshly-fetched remote tip
 * without hard-failing on a remote-less repo.
 */
export function baseRefFor(gitDir: string, base: string): string {
  try {
    git(gitDir, ['rev-parse', '--verify', '--quiet', `origin/${base}`]);
    return `origin/${base}`;
  } catch {
    return base;
  }
}

export interface SyncResult {
  status: 'up-to-date' | 'merged' | 'conflict';
  baseRef: string;
  conflictFiles: string[];
}

/**
 * Bring the latest base into the worktree's branch before we integrate the other way.
 * - up-to-date: base is already an ancestor of HEAD, nothing to do.
 * - merged: a clean merge of base into the branch landed.
 * - conflict: the merge could not auto-resolve; the merge is ABORTED (worktree restored
 *   to its pre-merge state) and the conflicting file list is returned.
 */
export function syncWithBase(worktree: string, base: string, doFetch: boolean): SyncResult {
  if (doFetch) fetchBase(worktree, base);
  const baseRef = baseRefFor(worktree, base);

  // Already contains base?
  try {
    git(worktree, ['merge-base', '--is-ancestor', baseRef, 'HEAD']);
    return { status: 'up-to-date', baseRef, conflictFiles: [] };
  } catch {
    /* base has commits we don't — merge it in */
  }

  try {
    git(worktree, ['merge', '--no-edit', baseRef]);
    return { status: 'merged', baseRef, conflictFiles: [] };
  } catch {
    let conflictFiles: string[] = [];
    try {
      conflictFiles = git(worktree, ['diff', '--name-only', '--diff-filter=U'])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* best-effort file list */
    }
    try {
      git(worktree, ['merge', '--abort']);
    } catch {
      /* best-effort restore */
    }
    return { status: 'conflict', baseRef, conflictFiles };
  }
}

/**
 * Push the loop branch to origin as a backup (30s cap). Host-only and fully guarded:
 * returns false (never throws) with no remote or on any failure.
 */
export function pushBranch(worktree: string, branch: string): boolean {
  if (!hasRemote(worktree)) return false;
  try {
    git(worktree, ['push', '-u', 'origin', branch], { timeout: NET_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove loop-internal handoff artifacts from the branch, committing the removal if any
 * were tracked. Call ONLY after ALL verification passed, right before the final
 * push/integrate — HANDOFF.md must stay available for resume paths until then. Never
 * throws.
 */
export function stripLoopArtifacts(worktree: string): void {
  try {
    git(worktree, ['rm', '-f', '--ignore-unmatch', 'HANDOFF.md', 'LOOP_RESUME_CONTEXT.md']);
    // Anything staged? (a tracked artifact was removed)
    let staged = false;
    try {
      git(worktree, ['diff', '--cached', '--quiet']);
    } catch {
      staged = true;
    }
    if (staged) git(worktree, ['commit', '--no-verify', '-m', 'loop: strip handoff artifacts']);
  } catch {
    /* best-effort */
  }
}

export type IntegrateOutcome = 'merged' | 'pending';

/**
 * Fast-forward the loop branch into the real base. The branch already CONTAINS the
 * latest base (syncWithBase ran first), so the FF is guaranteed unless the user has
 * local unpushed commits on base — in which case we degrade to 'pending' and touch
 * NOTHING (never corrupt a dirty user checkout).
 *
 * `gitDir` is the task worktree when it still exists, else `repoPath` (so a later manual
 * /merge works after worktree cleanup). All network calls are 30s-capped and guarded.
 */
export function integrateIntoBase(
  repoPath: string,
  gitDir: string,
  branch: string,
  base: string,
): { outcome: IntegrateOutcome; detail: string } {
  // From the worktree HEAD already points at the branch; from the bare repoPath we must
  // name the branch explicitly.
  const fromWorktree = gitDir !== repoPath;
  const pushSpec = fromWorktree ? `HEAD:${base}` : `${branch}:${base}`;

  if (hasRemote(gitDir)) {
    let pushed = false;
    try {
      git(gitDir, ['push', 'origin', pushSpec], { timeout: NET_TIMEOUT });
      pushed = true;
    } catch {
      pushed = false;
    }
    if (!pushed) {
      // Non-FF: base advanced on origin since our fetch. Leave everything as-is.
      return { outcome: 'pending', detail: `push rejected (base advanced) — ${branch} not integrated into ${base}` };
    }
    // Merged on origin. Best-effort sync of the user's local base — must never corrupt it.
    const localDetail = syncLocalBase(repoPath, base, branch, true);
    return { outcome: 'merged', detail: `pushed ${branch} into origin/${base}${localDetail}` };
  }

  // No-remote: FF the local base directly.
  const cur = currentBranch(repoPath);
  const clean = isClean(repoPath);
  if (cur === base) {
    if (!clean) return { outcome: 'pending', detail: `base ${base} checked out and dirty — ${branch} not integrated` };
    try {
      git(repoPath, ['merge', '--ff-only', branch]);
      return { outcome: 'merged', detail: `fast-forwarded ${base} to ${branch}` };
    } catch {
      return { outcome: 'pending', detail: `fast-forward of ${base} to ${branch} not possible` };
    }
  }
  // base not checked out — update the ref directly; git refuses to move a checked-out branch.
  try {
    git(repoPath, ['fetch', '.', `${branch}:${base}`]);
    return { outcome: 'merged', detail: `fast-forwarded ${base} to ${branch}` };
  } catch {
    return { outcome: 'pending', detail: `fast-forward of ${base} to ${branch} not possible` };
  }
}

/** Symbolic-ref of the checked-out branch, or null on detached HEAD / failure. */
function currentBranch(repo: string): string | null {
  try {
    return git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

function isClean(repo: string): boolean {
  try {
    return git(repo, ['status', '--porcelain']).trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * After a successful push to origin/<base>, try to fast-forward the user's LOCAL base too
 * so their checkout isn't left behind. Never changes the integrate outcome (already merged
 * on origin) and never touches a dirty checkout. Returns a detail suffix.
 */
function syncLocalBase(repo: string, base: string, _branch: string, didPush: boolean): string {
  if (!didPush) return '';
  const cur = currentBranch(repo);
  try {
    git(repo, ['fetch', 'origin', base], { timeout: NET_TIMEOUT });
  } catch {
    return ' (local base not synced: fetch failed)';
  }
  if (cur === base) {
    if (!isClean(repo)) return ' (local base dirty — not fast-forwarded)';
    try {
      git(repo, ['merge', '--ff-only', `origin/${base}`]);
      return '';
    } catch {
      return ' (local base not fast-forwarded)';
    }
  }
  // base not checked out — FF-only ref update; git refuses to move a checked-out branch.
  try {
    git(repo, ['fetch', '.', `refs/remotes/origin/${base}:refs/heads/${base}`]);
    return '';
  } catch {
    return ' (local base ref not fast-forwarded)';
  }
}
