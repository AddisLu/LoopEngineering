import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus, createRun, latestRun, updateRun } from '../tasks.js';
import { addWorktree } from '../git/worktree.js';
import { buildApp } from '../server/app.js';
import { reverifyTask } from '../review/review.js';
import { setCachedUsage } from '../token/usage.js';
import type { Task } from '../types.js';

/**
 * 合併 (and 核可並合併) used to fast-forward only, so a task whose base moved on after it finished
 * could never land and stayed pending until someone merged it by hand — with no verification on
 * record. Now the latest base goes into the branch, the command steps run again on the result, and
 * only a pass integrates. Hermetic: file:// bare origins, host-shell steps, no network.
 */

let db: Database.Database;
let app: FastifyInstance | undefined;
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-mergeflow-${tag}-`));
  tmpRoots.push(d);
  return d;
}
function writeCommit(dir: string, file: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-m', msg]);
}
/** a bare origin seeded with base.txt on main, and the user's clone of it (main checked out, clean) */
function originAndUser(tag: string): { origin: string; user: string } {
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
/** someone else pushes to origin/main after the task finished */
function advanceOrigin(origin: string, file: string, content: string): void {
  const root = mkTmp('adv');
  const c = path.join(root, 'adv');
  git(root, ['clone', origin, 'adv']);
  configIdentity(c);
  writeCommit(c, file, content, `advance ${file}`);
  git(c, ['push', 'origin', 'main']);
}

/** a finished task parked in review, merge deferred, its branch holding one commit of work */
function parkedTask(user: string, steps: string[], work: { file: string; content: string } = { file: 'feat.txt', content: 'a\n' }): { task: Task; worktree: string } {
  const t = createTask(db, {
    title: 'kernel work',
    goal: 'g',
    plan_ref: 'https://example.com/p.md',
    plan_kind: 'url',
    coding_tool: 'claude-code',
    verification_steps: steps,
    repo_path: user,
    base_branch: 'main',
    complexity: 'S',
  });
  git(user, ['branch', `loop/${t.id}`, 'main']);
  const wt = addWorktree(user, `loop/${t.id}`, 'main');
  configIdentity(wt.path);
  writeCommit(wt.path, work.file, work.content, 'work');
  createRun(db, { task_id: t.id, worktree_path: wt.path, branch: `loop/${t.id}` });
  setStatus(db, t.id, 'review', { detail: 'verification passed' });
  db.prepare("UPDATE tasks SET merge_status = 'pending' WHERE id = ?").run(t.id);
  return { task: getTask(db, t.id)!, worktree: wt.path };
}

const merge = async (id: string) => {
  app ??= buildApp({ db, apiToken: null });
  return app.inject({ method: 'POST', url: `/api/tasks/${id}/merge` });
};
const mergeEvents = (id: string) =>
  (db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'merge' ORDER BY id").all(id) as Array<{ detail: string }>).map((e) => e.detail);
const onOrigin = (origin: string, file: string) => {
  try {
    git(origin, ['cat-file', '-e', `main:${file}`]);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(15, 25);
  setSetting(db, 'self_update', 'false');
  app = undefined;
  tmpRoots = [];
});
afterEach(async () => {
  await app?.close();
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

describe('合併 a task whose base moved on', () => {
  it('brings the new base in, re-verifies on the result, records it, then lands on origin and the user checkout', async () => {
    const { origin, user } = originAndUser('pass');
    const { task } = parkedTask(user, ['test -f feat.txt && test -f other.txt']);
    advanceOrigin(origin, 'other.txt', 'b\n');

    const res = await merge(task.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'merged' });
    expect(res.json().detail).toContain('合併前已重新驗證');
    expect(onOrigin(origin, 'feat.txt') && onOrigin(origin, 'other.txt')).toBe(true);
    expect(fs.existsSync(path.join(user, 'feat.txt'))).toBe(true); // clean checkout fast-forwarded
    expect(getTask(db, task.id)!.merge_status).toBe('merged');
    const run = latestRun(db, task.id)!;
    expect(JSON.parse(run.verify_json!)).toEqual([expect.objectContaining({ ok: true, step: 'test -f feat.txt && test -f other.txt' })]);
    expect(mergeEvents(task.id).some((d) => d.startsWith('merged origin/main into'))).toBe(true);
  });

  it('declines when the re-verification fails: nothing lands, the task stays in review (nobody is resumed)', async () => {
    const { origin, user } = originAndUser('fail');
    const { task } = parkedTask(user, ['test ! -f other.txt']);
    advanceOrigin(origin, 'other.txt', 'b\n');

    const res = await merge(task.id);

    expect(res.json()).toMatchObject({ outcome: 'pending' });
    expect(res.json().detail).toContain('重新驗證沒有通過');
    expect(onOrigin(origin, 'feat.txt')).toBe(false);
    const t = getTask(db, task.id)!;
    expect(t.status).toBe('review');
    expect(t.merge_status).toBe('pending');
    expect(JSON.parse(latestRun(db, task.id)!.verify_json!)[0]).toMatchObject({ ok: false });
  });

  it('a conflict queues one resolution task; pressing again points at it instead of queueing another', async () => {
    const { origin, user } = originAndUser('conflict');
    const { task } = parkedTask(user, ['true'], { file: 'base.txt', content: 'branch\n' });
    advanceOrigin(origin, 'base.txt', 'origin\n');

    const first = (await merge(task.id)).json();
    expect(first.outcome).toBe('conflict');
    expect(first.merge_task_id).toBeTruthy();
    expect(getTask(db, first.merge_task_id)!.parent_task_id).toBe(task.id);

    const again = (await merge(task.id)).json();
    expect(again).toMatchObject({ outcome: 'conflict', merge_task_id: first.merge_task_id });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?').get(task.id)).toEqual({ n: 1 });
    expect(getTask(db, task.id)!.merge_status).toBe('conflict');
  });

  it('checks the branch out again when its worktree was already reclaimed, and cleans up after', async () => {
    const { origin, user } = originAndUser('reclaimed');
    const { task, worktree } = parkedTask(user, ['test -f feat.txt']);
    git(user, ['worktree', 'remove', '--force', worktree]);
    advanceOrigin(origin, 'other.txt', 'b\n');

    const res = await merge(task.id);

    expect(res.json()).toMatchObject({ outcome: 'merged' });
    expect(onOrigin(origin, 'feat.txt')).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(git(user, ['worktree', 'list'])).not.toContain(worktree);
  });

  it('a branch that already contains base lands without running anything again', async () => {
    const { origin, user } = originAndUser('current');
    const { task } = parkedTask(user, ['false']); // would fail if it ran
    const res = await merge(task.id);
    expect(res.json()).toMatchObject({ outcome: 'merged', detail: '已合併到 main' });
    expect(onOrigin(origin, 'feat.txt')).toBe(true);
    expect(latestRun(db, task.id)!.verify_json).toBeNull();
  });
});

describe('loop verify (reverifyTask)', () => {
  it('records a fresh verification on a merged task without touching its status or the commits on record', async () => {
    const { user } = originAndUser('reverify');
    const { task, worktree } = parkedTask(user, ['test -f feat.txt']);
    const head = git(worktree, ['rev-parse', 'HEAD']).trim();
    const base = git(user, ['rev-parse', 'main']).trim();
    // merged by hand, before the engine kept verification records
    git(user, ['merge', '--ff-only', `loop/${task.id}`]);
    git(user, ['worktree', 'remove', '--force', worktree]);
    db.prepare("UPDATE tasks SET merge_status = 'merged' WHERE id = ?").run(task.id);
    updateRun(db, latestRun(db, task.id)!.id, { head_sha: head, base_sha: base });

    const r = await reverifyTask(db, getTask(db, task.id)!);

    expect(r).toMatchObject({ ok: true, ran: true });
    const run = latestRun(db, task.id)!;
    expect(JSON.parse(run.verify_json!)[0]).toMatchObject({ ok: true });
    expect({ head: run.head_sha, base: run.base_sha }).toEqual({ head, base }); // not collapsed to head..head
    expect(getTask(db, task.id)!.status).toBe('review');
  });
});
