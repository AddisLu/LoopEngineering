import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { upsertNode, invalidateNode, addEdge } from '../knowledge/store.js';
import { repoScope } from '../knowledge/types.js';
import { knowledgeContext } from '../knowledge/context.js';
import { runTask } from '../orchestrator/run.js';
import { createMergeTask } from '../orchestrator/mergeTask.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
  delete process.env.MOCK_EXIT;
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-know-${tag}-`));
  tmpRoots.push(d);
  return d;
}

// ---- 1. scope selection ----

describe('knowledgeContext: scope selection', () => {
  it('includes a global node regardless of task repo/environment', () => {
    upsertNode(db, { title: 'Global rule', body: 'always applies', scope: 'global' });
    const task = getTask(db, createTask(db, { title: 't', goal: 'g' }).id)!;

    const out = knowledgeContext(db, task);
    expect(out).toMatch(/Global rule/);
  });

  it('matches repo:<realpath> for a task whose repo_path is a symlink to the same dir', () => {
    const real = mkTmpDir('real');
    const linkParent = mkTmpDir('link-parent');
    const link = path.join(linkParent, 'link-to-real');
    fs.symlinkSync(real, link, 'dir');

    upsertNode(db, { title: 'Repo secret', body: 'only for this repo', scope: repoScope(real) });
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', repo_path: link }).id)!;

    const out = knowledgeContext(db, task);
    expect(out).toMatch(/Repo secret/);
  });

  it("matches env:<name> for the task's environment label", () => {
    upsertNode(db, { title: 'Prod caution', body: 'be careful', scope: 'env:prod-cluster' });
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', environment: 'prod-cluster' }).id)!;

    const out = knowledgeContext(db, task);
    expect(out).toMatch(/Prod caution/);

    const otherEnvTask = getTask(db, createTask(db, { title: 't2', goal: 'g', environment: 'staging' }).id)!;
    expect(knowledgeContext(db, otherEnvTask)).toBeNull();
  });
});

// ---- 2. one-edge-hop expansion ----

describe('knowledgeContext: edge-hop expansion', () => {
  it('pulls a node linked to the seed set by one active edge, but not a second hop away', () => {
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', repo_path: '/tmp/some-repo-xyz' }).id)!;
    const seedScope = repoScope('/tmp/some-repo-xyz');

    const seedNode = upsertNode(db, { title: 'This repo', body: 'seed', scope: seedScope });
    const linkedEnv = upsertNode(db, { title: 'Linked environment', body: 'one hop away', scope: 'env:linked-env' });
    const twoHopsAway = upsertNode(db, { title: 'Too far', body: 'two hops away', scope: 'env:far-env' });

    addEdge(db, { src: seedNode.id, dst: linkedEnv.id, relation: 'deployed-at' });
    addEdge(db, { src: linkedEnv.id, dst: twoHopsAway.id, relation: 'related' });

    const out = knowledgeContext(db, task);
    expect(out).toMatch(/Linked environment/);
    expect(out).not.toMatch(/Too far/);
  });
});

// ---- 3. ordering + status filtering ----

describe('knowledgeContext: ordering + status filtering', () => {
  it('ranks constraint before fact at equal weight, higher weight first within a kind, and excludes non-approved/invalidated', () => {
    upsertNode(db, { kind: 'fact', title: 'Fact node', body: 'x', scope: 'global', weight: 5 });
    upsertNode(db, { kind: 'constraint', title: 'Constraint node', body: 'x', scope: 'global', weight: 5 });
    upsertNode(db, { kind: 'fact', title: 'Heavy fact', body: 'x', scope: 'global', weight: 5 });
    upsertNode(db, { kind: 'fact', title: 'Light fact', body: 'x', scope: 'global', weight: 1 });

    const draft = upsertNode(db, { kind: 'fact', title: 'Draft fact', body: 'x', scope: 'global', status: 'draft' });
    upsertNode(db, { kind: 'fact', title: 'Rejected fact', body: 'x', scope: 'global', status: 'rejected' });
    const toInvalidate = upsertNode(db, { kind: 'fact', title: 'Invalidated fact', body: 'x', scope: 'global' });
    invalidateNode(db, toInvalidate.id);
    expect(draft.status).toBe('draft'); // sanity: upsertNode honored the requested status

    const task = getTask(db, createTask(db, { title: 't', goal: 'g' }).id)!;
    const out = knowledgeContext(db, task)!;
    const lines = out.split('\n');

    expect(out).not.toMatch(/Draft fact|Rejected fact|Invalidated fact/);

    const idx = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(idx('Constraint node')).toBeGreaterThanOrEqual(0);
    expect(idx('Constraint node')).toBeLessThan(idx('Fact node'));
    expect(idx('Heavy fact')).toBeLessThan(idx('Light fact'));
  });
});

// ---- 4. char-budget truncation ----

describe('knowledgeContext: char-budget packing', () => {
  it('greedy-packs into knowledge_budget_chars and always includes the first node (truncated if needed)', () => {
    upsertNode(db, { kind: 'fact', title: 'Alpha', body: 'first body text', scope: 'global', weight: 3 });
    upsertNode(db, { kind: 'fact', title: 'Beta', body: 'second body text', scope: 'global', weight: 2 });
    upsertNode(db, { kind: 'fact', title: 'Gamma', body: 'third body text', scope: 'global', weight: 1 });

    const task = getTask(db, createTask(db, { title: 't', goal: 'g' }).id)!;

    setSetting(db, 'knowledge_budget_chars', '10000');
    const full = knowledgeContext(db, task)!;
    const fullLines = full.split('\n');
    expect(fullLines).toHaveLength(3);
    const [line0, line1] = fullLines;

    // budget too small even for the first line whole -> first line still present, truncated
    setSetting(db, 'knowledge_budget_chars', '5');
    const tiny = knowledgeContext(db, task)!;
    expect(tiny).toBe(line0.slice(0, 5));

    // budget fits exactly the first line, no room for a second -> only one line
    setSetting(db, 'knowledge_budget_chars', String(line0.length));
    const oneLine = knowledgeContext(db, task)!;
    expect(oneLine.split('\n')).toHaveLength(1);
    expect(oneLine).toBe(line0);

    // budget fits first + second line exactly -> two lines, third dropped
    setSetting(db, 'knowledge_budget_chars', String(line0.length + 1 + line1.length));
    const twoLines = knowledgeContext(db, task)!;
    expect(twoLines.split('\n')).toEqual([line0, line1]);
  });
});

// ---- 5. null cases ----

describe('knowledgeContext: null cases', () => {
  it('returns null with an empty KB, and null when knowledge_inject is false even with matching nodes', () => {
    const task = getTask(db, createTask(db, { title: 't', goal: 'g' }).id)!;
    expect(knowledgeContext(db, task)).toBeNull();

    upsertNode(db, { title: 'Global rule', body: 'x', scope: 'global' });
    expect(knowledgeContext(db, task)).not.toBeNull();

    setSetting(db, 'knowledge_inject', 'false');
    expect(knowledgeContext(db, task)).toBeNull();
  });
});

// ---- 6. e2e via runTask (mock adapter) ----

describe('knowledgeContext: e2e through writeTaskFile/runTask', () => {
  function runRow(taskId: string): any {
    return db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId);
  }

  it('injects the section + preamble into the scratch worktree LOOP_TASK.md', async () => {
    upsertNode(db, { kind: 'fact', title: 'Injected fact', body: 'must be visible', scope: 'global' });
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 'e2e knowledge task',
      goal: 'do the thing',
      coding_tool: 'mock',
      verification_steps: ['true'],
    });

    await runTask(db, getTask(db, t.id)!, {});

    const wt = runRow(t.id).worktree_path as string;
    const md = fs.readFileSync(path.join(wt, 'LOOP_TASK.md'), 'utf8');
    expect(md).toMatch(/## Knowledge \/ Environment/);
    expect(md).toMatch(/以下為使用者的長期環境／偏好／限制知識/);
    expect(md).toMatch(/Injected fact/);
    // still between Goal and Plan
    expect(md.indexOf('## Goal')).toBeLessThan(md.indexOf('## Knowledge / Environment'));
    expect(md.indexOf('## Knowledge / Environment')).toBeLessThan(md.indexOf('## Plan'));
  });

  it('omits the section entirely with an empty KB (zero-impact invariant)', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 'e2e no-knowledge task',
      goal: 'do the other thing',
      coding_tool: 'mock',
      verification_steps: ['true'],
    });

    await runTask(db, getTask(db, t.id)!, {});

    const wt = runRow(t.id).worktree_path as string;
    const md = fs.readFileSync(path.join(wt, 'LOOP_TASK.md'), 'utf8');
    expect(md).not.toMatch(/## Knowledge \/ Environment/);
  });
});

// ---- 7. mergeTask environment inheritance ----

describe('createMergeTask: environment inheritance', () => {
  function git(dir: string, args: string[]): string {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  }

  function makeRepo(tag: string): string {
    const root = mkTmpDir(`merge-${tag}`);
    const repo = path.join(root, 'repo');
    git(root, ['init', '-b', 'main', 'repo']);
    git(repo, ['config', 'user.email', 'loop@test.local']);
    git(repo, ['config', 'user.name', 'Loop Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'v1\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--no-verify', '-m', 'seed']);
    return repo;
  }

  it("copies orig.environment into the new task's environment", () => {
    const repo = makeRepo('env-inherit');
    const orig = getTask(
      db,
      createTask(db, {
        title: 'orig',
        goal: 'do it',
        repo_path: repo,
        base_branch: 'main',
        environment: 'prod-cluster',
      }).id,
    )!;
    git(repo, ['branch', `loop/${orig.id}`, 'main']);

    const mt = createMergeTask(db, orig, ['base.txt'], 'origin/main');
    expect(getTask(db, mt.id)!.environment).toBe('prod-cluster');
  });
});
