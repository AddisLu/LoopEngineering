import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { baselineBlocker, rejudgeBlocker, remeasureBaseline } from '../benchmark/complete.js';
import { createBenchmark, getBenchmark } from '../benchmark/store.js';
import { mergeBlocker } from '../orchestrator/mergeFlow.js';
import { annotateLocalModel, localLoadGuard } from '../local/guard.js';
import { registerRecipe } from '../local/models.js';
import { checkPrd, linkSubmittedDraft, submitPrd } from '../prd/intake.js';
import { createDraft, getDraft } from '../prd/drafts.js';

// The guards and the draft submit that used to live inside route closures: the routes and
// 對話操作 (src/chatops) now ask the same functions.
let db: Database.Database;
let repo: string;
beforeEach(() => {
  db = openTestDb();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-guards-'));
  fs.mkdirSync(path.join(repo, '.git'));
});
afterEach(() => {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('benchmark guards', () => {
  it('re-judging waits for every arm; a cancelled benchmark refuses; the baseline needs the GPU to itself', async () => {
    setSetting(db, 'benchmark_enabled', 'true');
    const plan = path.join(repo, 'PLAN.md');
    fs.writeFileSync(plan, '# q');
    const { benchmark, arms } = createBenchmark(db, { title: 'q', goal: 'a goal', plan_ref: plan, repo_path: repo, base_branch: 'main', verification_steps: ['true'], models: ['sonnet', 'haiku'], coding_tool: 'mock' });
    expect(rejudgeBlocker(getBenchmark(db, benchmark.id)!)).toBe('還有組別沒跑完。');
    expect(baselineBlocker(getBenchmark(db, benchmark.id)!.benchmark)).toMatch(/評比還在進行/);
    for (const a of arms) setStatus(db, a.task_id, 'review');
    expect(rejudgeBlocker(getBenchmark(db, benchmark.id)!)).toBeNull();
    db.prepare("UPDATE benchmarks SET status = 'cancelled' WHERE id = ?").run(benchmark.id);
    expect(rejudgeBlocker(getBenchmark(db, benchmark.id)!)).toBe('這個評比已取消。');
    // no arm recorded a base commit: nothing to measure
    expect(await remeasureBaseline(db, benchmark.id)).toMatchObject({ ok: false, code: 422 });
    expect(await remeasureBaseline(db, 'b_nope')).toMatchObject({ ok: false, code: 404 });
  });
});

describe('merge guard', () => {
  it('only a reviewed task awaiting a merge, with a repo and base', () => {
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: ['true'] });
    expect(mergeBlocker(getTask(db, t.id)!)).toMatchObject({ error: 'task not in review', extra: { status: 'draft' } });
    setStatus(db, t.id, 'review');
    expect(mergeBlocker(getTask(db, t.id)!)).toMatchObject({ error: 'task not awaiting merge' });
    db.prepare("UPDATE tasks SET merge_status = 'pending' WHERE id = ?").run(t.id);
    expect(mergeBlocker(getTask(db, t.id)!)).toMatchObject({ error: 'task has no repo/base' });
    db.prepare('UPDATE tasks SET repo_path = ?, base_branch = ? WHERE id = ?').run(repo, 'main', t.id);
    expect(mergeBlocker(getTask(db, t.id)!)).toBeNull();
  });
});

describe('local model guard', () => {
  it('names the first thing that stops a switch, and the list says the same', () => {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-hub-'));
    try {
      const m = registerRecipe(db, { recipe: 'tiny', name: 'Tiny', model: 'org/tiny' });
      const guard = localLoadGuard(db, m, { hubDir: hub, dockerProbe: () => true, loaded: null });
      expect(guard).toMatchObject({ code: 409, error: expect.stringContaining('還沒下載') });
      expect(annotateLocalModel(db, m, { hubDir: hub, dockerProbe: () => true })).toMatchObject({ runnable: false, blocked_by: '尚未下載權重' });
    } finally {
      fs.rmSync(hub, { recursive: true, force: true });
    }
  });
});

describe('PRD submit for callers other than the wizard', () => {
  const prd = (r: string) => `# 修正登入逾時

## 目標 (Goal)
現況：登入頁在網路慢時永遠轉圈。
期望：十秒內沒回應就顯示錯誤訊息並可重試。

## 範圍 (Scope)
- src/login.ts

## 非範圍 (Non-goals)
- 不改後端 API

## 驗收標準 (Acceptance)
- [ ] Given 後端不回應 When 登入 Then 十秒內顯示錯誤

## 驗證指令 (Verify)
\`\`\`bash
npm test
\`\`\`

## Repo
- path: ${r}
- branch: main

## 領域 (Domain)
typescript
`;

  it('reuses a check made on the same markdown, records who asked, and links the draft it came from', async () => {
    const md = prd(repo);
    const check = await checkPrd(db, md, { exec: async () => null });
    expect(check.ok).toBe(true);
    const r = await submitPrd(db, md, { precheck: check, queue: false, created_by: 'chat', owner: '小明', source_ref: 'chat:m_1', exec: async () => {
      throw new Error('must not review twice');
    } });
    expect(r.ok && r.kind === 'task').toBe(true);
    if (!r.ok || r.kind !== 'task') return;
    expect(getTask(db, r.task.id)).toMatchObject({ created_by: 'chat', owner: '小明', source_ref: 'chat:m_1', status: 'draft' });
    const d = createDraft(db, 'local', { title: '修正登入逾時', markdown: md });
    linkSubmittedDraft(db, 'local', d.id, r);
    expect(getDraft(db, 'local', d.id)).toMatchObject({ status: 'submitted', task_id: r.task.id });
  });
});
