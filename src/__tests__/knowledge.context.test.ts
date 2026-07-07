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
import { knowledgeContext, ragTaskContext } from '../knowledge/context.js';
import type { EmbedExec } from '../knowledge/embed.js';
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

// ---- 7. ragTaskContext (SSoT Phase 2): separate, flag-gated corpus section ----

function insertRagSource(kind: string, uri: string): void {
  db.prepare(`INSERT INTO sources (id, kind, uri) VALUES ('src_1', ?, ?)`).run(kind, uri);
}
function insertRagDocument(uri: string, docKind: string, docPath: string): number {
  return Number(
    db
      .prepare(`INSERT INTO documents (source_id, path, uri, doc_kind) VALUES ('src_1', ?, ?, ?)`)
      .run(docPath, uri, docKind).lastInsertRowid,
  );
}
function insertRagChunk(documentId: number, text: string, startLine: number, endLine: number): void {
  db.prepare(
    `INSERT INTO chunks (document_id, ord, text, start_line, end_line) VALUES (?, 0, ?, ?, ?)`,
  ).run(documentId, text, startLine, endLine);
}

describe('ragTaskContext: flag + repo_path gating', () => {
  it('returns null when rag_inject_task_context is off (the default), even with matching chunks', async () => {
    const repo = mkTmpDir('rag-off');
    insertRagSource('git', repo);
    const doc = insertRagDocument(path.join(repo, 'a.ts'), 'ts', 'a.ts');
    insertRagChunk(doc, 'do the thing implementation detail', 1, 5);

    const task = getTask(db, createTask(db, { title: 't', goal: 'do the thing', repo_path: repo }).id)!;
    expect(await ragTaskContext(db, task)).toBeNull();
  });

  it('returns null when the flag is on but the task has no repo_path', async () => {
    setSetting(db, 'rag_inject_task_context', 'true');
    const task = getTask(db, createTask(db, { title: 't', goal: 'do the thing' }).id)!;
    expect(await ragTaskContext(db, task)).toBeNull();
  });
});

describe('ragTaskContext: hybrid search scoped to the repo + citation rendering', () => {
  it('pulls chunks scoped to the repo path, rendered with a path:line citation', async () => {
    setSetting(db, 'rag_inject_task_context', 'true');
    const repo = mkTmpDir('rag-scoped');
    const otherRepo = mkTmpDir('rag-other');
    insertRagSource('git', repo);
    const doc = insertRagDocument(path.join(repo, 'worktree.ts'), 'ts', 'worktree.ts');
    insertRagChunk(doc, 'addWorktree cuts a fresh worktree', 12, 34);

    db.prepare(`INSERT INTO sources (id, kind, uri) VALUES ('src_2', 'git', ?)`).run(otherRepo);
    const otherDoc = Number(
      db
        .prepare(`INSERT INTO documents (source_id, path, uri, doc_kind) VALUES ('src_2', 'b.ts', ?, 'ts')`)
        .run(path.join(otherRepo, 'b.ts')).lastInsertRowid,
    );
    insertRagChunk(otherDoc, 'addWorktree unrelated repo copy', 1, 2);

    const task = getTask(db, createTask(db, { title: 't', goal: 'addWorktree', repo_path: repo }).id)!;
    const out = await ragTaskContext(db, task);
    expect(out).toMatch(/worktree\.ts:12-34/);
    expect(out).toMatch(/addWorktree cuts a fresh worktree/);
    expect(out).not.toMatch(/unrelated repo copy/);
  });

  it('returns null when nothing matches the goal within scope', async () => {
    setSetting(db, 'rag_inject_task_context', 'true');
    const repo = mkTmpDir('rag-nomatch');
    insertRagSource('git', repo);
    const doc = insertRagDocument(path.join(repo, 'a.ts'), 'ts', 'a.ts');
    insertRagChunk(doc, 'completely unrelated content', 1, 2);

    const task = getTask(db, createTask(db, { title: 't', goal: 'xyzxyzxyz_nomatch', repo_path: repo }).id)!;
    expect(await ragTaskContext(db, task)).toBeNull();
  });
});

describe('ragTaskContext: e2e through writeTaskFile/runTask', () => {
  function runRow(taskId: string): any {
    return db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId);
  }

  it('injects its own ## 相關語料 (RAG) section, separate from ## Knowledge / Environment', async () => {
    setSetting(db, 'rag_inject_task_context', 'true');
    setSetting(db, 'rag_enabled', 'true');
    upsertNode(db, { kind: 'fact', title: 'Curated fact', body: 'must be visible', scope: 'global' });

    const repo = mkTmpDir('rag-e2e');
    insertRagSource('git', repo);
    const doc = insertRagDocument(path.join(repo, 'worktree.ts'), 'ts', 'worktree.ts');
    insertRagChunk(doc, 'addWorktree cuts a fresh worktree from base', 1, 3);

    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 'e2e rag task',
      goal: 'addWorktree',
      repo_path: repo,
      coding_tool: 'mock',
      verification_steps: ['true'],
    });

    const fakeEmbed: EmbedExec = async (_bin, _args, texts) => texts.map(() => new Array(1024).fill(0));
    await runTask(db, getTask(db, t.id)!, { ragEmbedExec: fakeEmbed });

    const wt = runRow(t.id).worktree_path as string;
    const md = fs.readFileSync(path.join(wt, 'LOOP_TASK.md'), 'utf8');
    expect(md).toMatch(/## 相關語料 \(RAG\)/);
    expect(md).toMatch(/addWorktree cuts a fresh worktree/);
    expect(md).toMatch(/## Knowledge \/ Environment/);
    expect(md).toMatch(/Curated fact/);
    // RAG section stays between Knowledge/Environment and Plan
    expect(md.indexOf('## Knowledge / Environment')).toBeLessThan(md.indexOf('## 相關語料 (RAG)'));
    expect(md.indexOf('## 相關語料 (RAG)')).toBeLessThan(md.indexOf('## Plan'));
  });

  it('omits the RAG section entirely with the flag off (zero-impact invariant)', async () => {
    const repo = mkTmpDir('rag-e2e-off');
    insertRagSource('git', repo);
    const doc = insertRagDocument(path.join(repo, 'worktree.ts'), 'ts', 'worktree.ts');
    insertRagChunk(doc, 'addWorktree cuts a fresh worktree from base', 1, 3);

    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 'e2e rag off task',
      goal: 'addWorktree',
      repo_path: repo,
      coding_tool: 'mock',
      verification_steps: ['true'],
    });

    await runTask(db, getTask(db, t.id)!, {});

    const wt = runRow(t.id).worktree_path as string;
    const md = fs.readFileSync(path.join(wt, 'LOOP_TASK.md'), 'utf8');
    expect(md).not.toMatch(/相關語料/);
  });
});

// ---- 8. mergeTask environment inheritance ----

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
