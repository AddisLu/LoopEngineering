import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, createRun, getTask, updateRun } from '../tasks.js';
import { recordFix, similarFixes, listFixes, renderSimilarFixes, ftsQuery } from '../repo/ledger.js';
import { parseSelfReview, runSelfReview, renderSelfReview, readSelfReview } from '../review/selfReview.js';
import { prBody } from '../orchestrator/runSummary.js';
import { closeTask } from '../taskActions.js';

let db: Database.Database;
let repo: string;
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeEach(() => {
  db = openTestDb();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.cpp'), 'int a() { return 1; }\n');
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
});
afterEach(() => {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

function ticket(extra: Record<string, unknown> = {}) {
  const t = createTask(db, {
    title: '第二次載入 bypass_edge_x 沒生效',
    goal: 'recipe reload keeps the old value',
    plan_ref: 'https://example.com/p.md',
    coding_tool: 'mock',
    verification_steps: ['true'],
    repo_path: repo,
    base_branch: 'main',
  });
  db.prepare("UPDATE tasks SET repo_id = 'r_1', source_ref = 'gitea:aoi/cf-aoi#12', intake_json = ? WHERE id = ?").run(
    JSON.stringify({ description: '連續兩次 LOAD_RECIPE 後第二次的 bypass_edge_x 沒生效' }),
    t.id,
  );
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(v, t.id);
  const base = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'recipe_loader.cpp'), 'void apply_recipe() {}\n');
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'fix']);
  const head = git(['rev-parse', 'HEAD']);
  const run = createRun(db, { task_id: t.id, attempt: 1, model: 'local:qwen3-coder-next' } as never);
  updateRun(db, run.id, { head_sha: head, base_sha: base } as never);
  return getTask(db, t.id)!;
}

describe('過去修法', () => {
  it('records a ticket once per outcome, with the files its verified run changed', () => {
    const t = ticket();
    const id = recordFix(db, t, 'merged');
    expect(id).toBeGreaterThan(0);
    expect(recordFix(db, t, 'merged')).toBeNull(); // idempotent
    const [row] = listFixes(db, 'r_1');
    expect(row).toMatchObject({ task_id: t.id, issue_ref: 'gitea:aoi/cf-aoi#12', outcome: 'merged', files: 'recipe_loader.cpp' });
    expect(row!.symptom).toContain('LOAD_RECIPE');
    expect(row!.summary).toContain('recipe_loader.cpp');
  });

  it('never records a task that does not belong to an imported repo', () => {
    const t = createTask(db, { title: 'x', goal: 'y', plan_ref: 'https://e/p.md', coding_tool: 'mock', verification_steps: ['true'] });
    expect(recordFix(db, t, 'merged')).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM fix_ledger').get()).toEqual({ n: 0 });
  });

  it('finds similar fixes by trigram search and renders them for the prompt', () => {
    recordFix(db, ticket(), 'merged');
    const hits = similarFixes(db, 'r_1', '載入之後 bypass_edge_x 又沒套用');
    expect(hits).toHaveLength(1);
    expect(similarFixes(db, 'r_2', 'bypass_edge_x')).toEqual([]);
    expect(similarFixes(db, 'r_1', 'xy')).toEqual([]);
    expect(ftsQuery('a "b" apply_recipe 重新載入配方')).toBe('"apply_recipe" OR "重新載入配方"');
    expect(renderSimilarFixes(hits)).toContain('第二次載入 bypass_edge_x 沒生效（已合併 · local:qwen3-coder-next）');
  });

  it('closing a ticket records it; the outcome follows the merge state', () => {
    const t = ticket({ merge_status: 'merged' });
    closeTask(db, t.id);
    expect(listFixes(db, 'r_1')[0]!.outcome).toBe('merged');
  });
});

describe('本地自評', () => {
  it('parses the model answer defensively', () => {
    expect(parseSelfReview('no json')).toBeNull();
    expect(parseSelfReview('{"summary": []}')).toBeNull();
    expect(parseSelfReview('好的：{"summary":["a","b"],"why":"c","risks":["r"],"out_of_scope":[],"confidence":"HIGH"} 以上')).toEqual({
      summary: ['a', 'b'],
      why: 'c',
      risks: ['r'],
      out_of_scope: [],
      confidence: 'high',
    });
  });

  it('stores the review on the task and puts it in the PR body', async () => {
    const t = ticket();
    const run = db.prepare('SELECT id FROM task_runs WHERE task_id = ?').get(t.id) as { id: string };
    const r = await runSelfReview(db, t, repo, 'HEAD~1', run.id, {
      diff: () => 'diff --git a/recipe_loader.cpp b/recipe_loader.cpp',
      localChat: async () => ({ ok: true, content: '{"summary":["apply_recipe 不再提前 return"],"why":"第二次載入也要套用","risks":[],"out_of_scope":[],"confidence":"high"}' }),
    });
    expect(r?.summary).toEqual(['apply_recipe 不再提前 return']);
    const fresh = getTask(db, t.id)!;
    expect(readSelfReview(fresh)?.why).toBe('第二次載入也要套用');
    expect(renderSelfReview(r!)).toContain('### Loop 的自評');
    const body = prBody(fresh, null, null);
    expect(body).toContain('## Loop 的自評');
    expect(body).toContain('- apply_recipe 不再提前 return');
    // no diff, or a model that does not answer: nothing stored, never a throw
    expect(await runSelfReview(db, t, repo, 'HEAD~1', run.id, { diff: () => '', localChat: async () => ({ ok: true, content: '{}' }) })).toBeNull();
    expect(await runSelfReview(db, t, repo, 'HEAD~1', run.id, { diff: () => 'd', localChat: async () => ({ ok: false, reason: 'not_ready', detail: '' }) })).toBeNull();
  });
});
