import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask, setStatus, latestRun, createRun } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import {
  fetchBase,
  baseRefFor,
  syncWithBase,
  pushBranch,
  stripLoopArtifacts,
  integrateIntoBase,
} from '../git/integrate.js';
import { addWorktree } from '../git/worktree.js';
import { createMergeTask } from '../orchestrator/mergeTask.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';
import { paths } from '../config.js';
import type { Task } from '../types.js';

// ---- hermetic git fixtures (never touch the network) ----

let tmpRoots: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function configIdentity(dir: string): void {
  git(dir, ['config', 'user.email', 'loop@test.local']);
  git(dir, ['config', 'user.name', 'Loop Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}
function mkTmp(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-merge-${tag}-`));
  tmpRoots.push(d);
  return d;
}
function writeCommit(dir: string, file: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-m', msg]);
}

/**
 * Build: a bare origin.git seeded with one commit on `main` (from a seed clone), plus a
 * `user` clone of it. Returns their paths. A caller can make a SECOND clone to advance
 * origin without touching the user repo (drift).
 */
function makeOriginAndUser(tag: string): { origin: string; user: string } {
  const root = mkTmp(tag);
  const origin = path.join(root, 'origin.git');
  git(root, ['init', '--bare', '-b', 'main', 'origin.git']);

  const seed = path.join(root, 'seed');
  git(root, ['clone', origin, 'seed']);
  configIdentity(seed);
  writeCommit(seed, 'base.txt', 'v1\n', 'seed');
  git(seed, ['push', 'origin', 'main']);

  const user = path.join(root, 'user');
  git(root, ['clone', origin, 'user']);
  configIdentity(user);
  return { origin, user };
}

/** A throwaway clone used to advance origin/main behind the user repo's back. */
function advanceOrigin(origin: string, tag: string, file: string, content: string, msg: string): void {
  const root = mkTmp(`${tag}-adv`);
  const c = path.join(root, 'adv');
  git(root, ['clone', origin, 'adv']);
  configIdentity(c);
  writeCommit(c, file, content, msg);
  git(c, ['push', 'origin', 'main']);
}

let db: Database.Database;
let app: FastifyInstance | undefined;

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(15, 25);
  app = undefined;
  tmpRoots = [];
});
afterEach(async () => {
  await app?.close();
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

describe('addWorktree fetchBase', () => {
  it('cuts from origin/<base> when local base is stale (fetchBase:true), old behavior otherwise', () => {
    const { origin, user } = makeOriginAndUser('wt');
    // advance origin/main so the user repo's local main is stale
    advanceOrigin(origin, 'wt', 'base.txt', 'v2\n', 'advance');

    // fresh cut: worktree should contain the NEW origin commit
    const fresh = addWorktree(user, 'loop/fresh', 'main', { fetchBase: true });
    expect(fs.readFileSync(path.join(fresh.path, 'base.txt'), 'utf8')).toBe('v2\n');

    // default opts: stale cut off the local main (still v1)
    const stale = addWorktree(user, 'loop/stale', 'main');
    expect(fs.readFileSync(path.join(stale.path, 'base.txt'), 'utf8')).toBe('v1\n');

    // cleanup worktrees so the tmp dir removal is clean
    git(user, ['worktree', 'remove', '--force', fresh.path]);
    git(user, ['worktree', 'remove', '--force', stale.path]);
  });
});

describe('syncWithBase', () => {
  it('up-to-date when the branch already contains base', () => {
    const { user } = makeOriginAndUser('sync-utd');
    git(user, ['checkout', '-b', 'loop/x']);
    writeCommit(user, 'feat.txt', 'a\n', 'feat');
    const r = syncWithBase(user, 'main', false);
    expect(r.status).toBe('up-to-date');
  });

  it('merges when origin advanced after the branch was cut', () => {
    const { origin, user } = makeOriginAndUser('sync-merge');
    git(user, ['checkout', '-b', 'loop/x']);
    writeCommit(user, 'feat.txt', 'a\n', 'feat');
    advanceOrigin(origin, 'sync-merge', 'other.txt', 'z\n', 'advance non-conflicting');
    const r = syncWithBase(user, 'main', true); // fetch brings origin/main forward
    expect(r.status).toBe('merged');
    expect(r.baseRef).toBe('origin/main');
    // merge landed: both files present, worktree clean
    expect(fs.existsSync(path.join(user, 'other.txt'))).toBe(true);
    expect(git(user, ['status', '--porcelain']).trim()).toBe('');
  });

  it('conflict returns the file list and leaves the worktree clean', () => {
    const { origin, user } = makeOriginAndUser('sync-conflict');
    git(user, ['checkout', '-b', 'loop/x']);
    writeCommit(user, 'base.txt', 'branch-change\n', 'branch edits base.txt');
    advanceOrigin(origin, 'sync-conflict', 'base.txt', 'origin-change\n', 'origin edits base.txt');
    const r = syncWithBase(user, 'main', true);
    expect(r.status).toBe('conflict');
    expect(r.conflictFiles).toContain('base.txt');
    // merge aborted -> worktree restored, clean
    expect(git(user, ['status', '--porcelain']).trim()).toBe('');
    expect(fs.readFileSync(path.join(user, 'base.txt'), 'utf8')).toBe('branch-change\n');
  });

  it('refused (not conflict) when dirty tracked files block the merge from starting', () => {
    const { origin, user } = makeOriginAndUser('sync-refused');
    git(user, ['checkout', '-b', 'loop/x']);
    writeCommit(user, 'feat.txt', 'a\n', 'feat');
    advanceOrigin(origin, 'sync-refused', 'base.txt', 'v2\n', 'origin edits base.txt');
    // dirty TRACKED file overlapping the incoming change -> git refuses to start the merge
    fs.writeFileSync(path.join(user, 'base.txt'), 'uncommitted-dirt\n');
    const r = syncWithBase(user, 'main', true);
    expect(r.status).toBe('refused'); // NOT 'conflict' -> no spurious merge task
    expect(r.conflictFiles).toEqual([]);
    // the dirt is preserved untouched
    expect(fs.readFileSync(path.join(user, 'base.txt'), 'utf8')).toBe('uncommitted-dirt\n');
  });
});

describe('pushBranch', () => {
  it('creates the branch on the bare origin', () => {
    const { origin, user } = makeOriginAndUser('push');
    git(user, ['checkout', '-b', 'loop/push']);
    writeCommit(user, 'feat.txt', 'a\n', 'feat');
    expect(pushBranch(user, 'loop/push')).toBe(true);
    const refs = git(origin, ['for-each-ref', '--format=%(refname)']);
    expect(refs).toContain('refs/heads/loop/push');
  });
});

describe('integrateIntoBase — remote', () => {
  it('fast-forwards origin/<base> and a CLEAN checked-out user base to the branch tip', () => {
    const { origin, user } = makeOriginAndUser('int-remote');
    git(user, ['checkout', '-b', 'loop/x']);
    writeCommit(user, 'feat.txt', 'a\n', 'feat');
    const branchTip = git(user, ['rev-parse', 'loop/x']).trim();
    // leave main checked out & clean so the local-sync cur===base FF path runs
    git(user, ['checkout', 'main']);
    const r = integrateIntoBase(user, user, 'loop/x', 'main');
    expect(r.outcome).toBe('merged');
    // origin/main advanced to the branch tip
    expect(git(origin, ['rev-parse', 'refs/heads/main']).trim()).toBe(branchTip);
    // the CLEAN checked-out user base was fast-forwarded too
    expect(git(user, ['rev-parse', 'main']).trim()).toBe(branchTip);
  });

  it('push rejected (origin advanced past our fetch) -> pending; user repo untouched', () => {
    const { origin, user } = makeOriginAndUser('int-reject');
    git(user, ['checkout', '-b', 'loop/x']);
    writeCommit(user, 'feat.txt', 'a\n', 'feat');
    // origin/main advances so our branch is NOT a fast-forward of it
    advanceOrigin(origin, 'int-reject', 'base.txt', 'v2\n', 'advance base');
    const userMainBefore = git(user, ['rev-parse', 'main']).trim();
    const r = integrateIntoBase(user, user, 'loop/x', 'main');
    expect(r.outcome).toBe('pending');
    // user's local main is untouched
    expect(git(user, ['rev-parse', 'main']).trim()).toBe(userMainBefore);
  });
});

describe('integrateIntoBase — no remote', () => {
  it('clean checked-out base -> merged; dirty base -> pending and file untouched', () => {
    // no-remote repo: init a plain repo, seed main, cut a branch
    const root = mkTmp('int-local');
    const repo = path.join(root, 'repo');
    git(root, ['init', '-b', 'main', 'repo']);
    configIdentity(repo);
    writeCommit(repo, 'base.txt', 'v1\n', 'seed');

    // branch with work
    git(repo, ['checkout', '-b', 'loop/y']);
    writeCommit(repo, 'feat.txt', 'a\n', 'feat');
    git(repo, ['checkout', 'main']);

    // CLEAN base checkout -> merged (FF)
    const r1 = integrateIntoBase(repo, repo, 'loop/y', 'main');
    expect(r1.outcome).toBe('merged');
    expect(fs.existsSync(path.join(repo, 'feat.txt'))).toBe(true);

    // Now make more work on the branch and dirty the base checkout -> pending, untouched
    git(repo, ['checkout', 'loop/y']);
    writeCommit(repo, 'feat2.txt', 'b\n', 'feat2');
    git(repo, ['checkout', 'main']);
    const dirtyPath = path.join(repo, 'dirty.txt');
    fs.writeFileSync(dirtyPath, 'uncommitted-user-work\n');
    const r2 = integrateIntoBase(repo, repo, 'loop/y', 'main');
    expect(r2.outcome).toBe('pending');
    expect(fs.readFileSync(dirtyPath, 'utf8')).toBe('uncommitted-user-work\n');
  });
});

describe('stripLoopArtifacts', () => {
  it('removes committed HANDOFF.md + LOOP_RESUME_CONTEXT.md, leaves other files', () => {
    const root = mkTmp('strip');
    const repo = path.join(root, 'repo');
    git(root, ['init', '-b', 'main', 'repo']);
    configIdentity(repo);
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'k\n');
    fs.writeFileSync(path.join(repo, 'HANDOFF.md'), 'h\n');
    fs.writeFileSync(path.join(repo, 'LOOP_RESUME_CONTEXT.md'), 'r\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--no-verify', '-m', 'seed with artifacts']);

    stripLoopArtifacts(repo);

    expect(fs.existsSync(path.join(repo, 'HANDOFF.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'LOOP_RESUME_CONTEXT.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'keep.txt'))).toBe(true);
    // clean tree (the removal was committed)
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
  });
});

describe('createMergeTask', () => {
  function origTask(repo: string): Task {
    const t = createTask(db, {
      title: 'do a thing',
      goal: 'make it work',
      plan_ref: 'https://example.com/p.md',
      plan_kind: 'url',
      coding_tool: 'claude-code',
      verification_steps: ['true'],
      setup_cmd: null,
      repo_path: repo,
      base_branch: 'main',
      complexity: 'M',
      priority: 2,
    });
    return getTask(db, t.id)!;
  }

  it('gates ok, pre-creates branch at the original tip, sets lineage + queued status', () => {
    const { user } = makeOriginAndUser('mt');
    // pretend the original task ran: create its branch loop/<origId> with work
    const orig = origTask(user);
    git(user, ['branch', `loop/${orig.id}`, 'main']);
    // put a commit on the original branch
    const wt = addWorktree(user, `loop/${orig.id}`, 'main');
    writeCommit(wt.path, 'feat.txt', 'a\n', 'orig work');
    const origTip = git(user, ['rev-parse', `loop/${orig.id}`]).trim();
    git(user, ['worktree', 'remove', '--force', wt.path]);

    const mt = createMergeTask(db, orig, ['base.txt'], 'origin/main');

    // gate passes on the new task (plan .md exists in plansDir)
    const fresh = getTask(db, mt.id)!;
    expect(validateTask(fresh).ok).toBe(true);
    expect(fresh.parent_task_id).toBe(orig.id);
    expect(fresh.status).toBe('queued');
    expect(fresh.base_branch).toBe('main');
    // branch loop/<newId> exists at the original tip
    expect(git(user, ['rev-parse', `loop/${mt.id}`]).trim()).toBe(origTip);
    // plan file exists in plansDir
    expect(fresh.plan_ref && fresh.plan_ref.startsWith(paths.plansDir)).toBe(true);
    expect(fs.existsSync(fresh.plan_ref!)).toBe(true);

    // cleanup created plan file + branches
    fs.rmSync(fresh.plan_ref!, { force: true });
  });

  it('recursion guard: the call-site condition skips a task that already has a parent', () => {
    const { user } = makeOriginAndUser('mt-guard');
    const orig = origTask(user);
    // simulate a merge-resolution task
    db.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?').run('t_parent', orig.id);
    const guarded = getTask(db, orig.id)!;
    // the guard used in run.ts: merge_conflict_task && !task.parent_task_id
    const wouldSpawn = !guarded.parent_task_id;
    expect(wouldSpawn).toBe(false);
  });
});

describe('POST /api/tasks/:id/merge', () => {
  it('integrates a review + pending task', () => {
    // no-remote repo with a branch ready to FF into main
    const root = mkTmp('api-merge');
    const repo = path.join(root, 'repo');
    git(root, ['init', '-b', 'main', 'repo']);
    configIdentity(repo);
    writeCommit(repo, 'base.txt', 'v1\n', 'seed');

    const t = createTask(db, {
      title: 'merge me',
      goal: 'g',
      plan_ref: 'https://example.com/p.md',
      plan_kind: 'url',
      coding_tool: 'claude-code',
      verification_steps: ['true'],
      repo_path: repo,
      base_branch: 'main',
      complexity: 'S',
    });
    // the loop branch, cut from main with work
    git(repo, ['branch', `loop/${t.id}`, 'main']);
    const wt = addWorktree(repo, `loop/${t.id}`, 'main');
    writeCommit(wt.path, 'feat.txt', 'a\n', 'work');
    // move main checkout away so cur !== base path (avoids checked-out-branch FF refusal
    // being needed) — actually keep main checked out & clean so cur===base + clean.
    setStatus(db, t.id, 'review', { detail: 'verification passed' });
    db.prepare("UPDATE tasks SET merge_status = 'pending' WHERE id = ?").run(t.id);
    // record a run so latestRun resolves the worktree
    createRun(db, { task_id: t.id, worktree_path: wt.path, branch: `loop/${t.id}` });

    return (async () => {
      app = buildApp({ db, apiToken: null });
      const res = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/merge` });
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe('merged');
      expect(getTask(db, t.id)!.merge_status).toBe('merged');
      // main now contains the branch work
      expect(fs.existsSync(path.join(repo, 'feat.txt'))).toBe(true);
    })();
  });

  it('409s when the task is not review+pending/conflict', async () => {
    const t = createTask(db, {
      title: 'x',
      goal: 'g',
      plan_ref: 'https://example.com/p.md',
      plan_kind: 'url',
      coding_tool: 'mock',
      verification_steps: ['true'],
      complexity: 'S',
    });
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/merge` });
    expect(res.statusCode).toBe(409);
  });
});

describe('helpers on a remote-less repo', () => {
  it('fetchBase false / baseRefFor local when no remote', () => {
    const root = mkTmp('noremote');
    const repo = path.join(root, 'repo');
    git(root, ['init', '-b', 'main', 'repo']);
    configIdentity(repo);
    writeCommit(repo, 'base.txt', 'v1\n', 'seed');
    expect(fetchBase(repo, 'main')).toBe(false);
    expect(baseRefFor(repo, 'main')).toBe('main');
    expect(pushBranch(repo, 'main')).toBe(false);
  });
});
