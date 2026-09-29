import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, logEvent } from '../db/index.js';
import { createRun, createTask, setStatus } from '../tasks.js';
import { createBenchmark } from '../benchmark/store.js';
import { findView, nextSayings, overviewView, showView, standingsView, templatesView } from '../chatops/views.js';
import { MAX_ROWS, table } from '../chatops/format.js';
import { missingFacts, improves, measure } from '../chatops/templates.js';
import type { UsageReading } from '../types.js';

// The read-only side of 對話操作: fixed formats the chat model pastes as they are.
let db: Database.Database;
let repo: string;
beforeEach(() => {
  db = openTestDb();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-views-'));
  fs.mkdirSync(path.join(repo, '.git'));
});
afterEach(() => {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

const usage = (): UsageReading => ({
  ok: true,
  subscription: null,
  fetchedAt: new Date().toISOString(),
  session: { percent: 12, resetsAt: null, resetsInMinutes: 100, severity: 'normal' },
  weekly: { percent: 31, resetsAt: null, resetsInMinutes: 4000, severity: 'normal' },
  source: 'cache',
});
const mk = (title: string, status: string, extra: Record<string, unknown> = {}) => {
  const t = createTask(db, { title, goal: 'a goal long enough', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true'], complexity: 'S' });
  if (status !== 'draft') setStatus(db, t.id, status as never, status === 'attention' ? { detail: 'verify failed (resumable 1/2) at: 驗收指標' } : {});
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(v, t.id);
  return t.id;
};

describe('the overview', () => {
  it('lists what needs the person with the sentences they can say, and what runs and waits', () => {
    const a = mk('修正登入逾時', 'attention');
    const r = mk('加排序', 'review', { merge_status: 'pending', verify_mode: 'command,manual' });
    const run = mk('壓 kernel 時間', 'running');
    createRun(db, { task_id: run, worktree_path: '/tmp/x' });
    mk('排隊的', 'queued');
    const v = overviewView(db, {}, { usage, localState: () => ({ loaded: 'qwen38-flash', status: 'ready' }) });
    expect(v.markdown).toContain('需要你處理 1｜執行中 1｜排隊／等續跑 1｜待核可 1');
    expect(v.markdown).toContain('5 小時 12%・本週 31%');
    expect(v.markdown).toContain('qwen38-flash（就緒）');
    expect(v.markdown).toContain(`${a} 修正登入逾時`);
    expect(v.markdown).toContain('驗證沒過：驗收指標');
    expect(v.markdown).toContain(`續跑 ${a}／重來 ${a}／放棄 ${a}`);
    expect(v.markdown).toContain(`核可 ${r}`);
    expect(v.markdown).toContain('待人工核可');
    expect(v.data).toMatchObject({ need: [a], review: [r], running: [run] });
  });

  it('says so when nothing is going on', () => {
    expect(overviewView(db, {}, { usage }).markdown).toContain('目前沒有進行中或要你處理的任務');
  });
});

describe('find and show', () => {
  it('finds tasks and benchmarks by words, id and state', () => {
    const a = mk('CCL kernel 壓到 10 ms', 'attention');
    mk('別的任務', 'draft');
    const plan = path.join(repo, 'PLAN.md');
    fs.writeFileSync(plan, '# q');
    setSetting(db, 'benchmark_enabled', 'true');
    const { benchmark } = createBenchmark(db, { title: 'CCL 評比', goal: 'g', plan_ref: plan, repo_path: repo, base_branch: 'main', verification_steps: ['true'], models: ['sonnet', 'haiku'], coding_tool: 'mock' });
    const f = findView(db, { q: 'CCL' });
    expect(f.markdown).toContain(a);
    expect(f.markdown).toContain(benchmark.id);
    expect(f.markdown).not.toContain('別的任務');
    expect(findView(db, { status: 'attention', kind: 'task' }).markdown).toContain(a);
    expect(findView(db, { q: '沒有這種東西' }).markdown).toContain('沒有找到');
  });

  it('a task card says where it stands and what can be said next; a benchmark shows its table', () => {
    const r = mk('加排序', 'review', { merge_status: 'merged' });
    const v = showView(db, r)!;
    expect(v.markdown).toContain(`## ${r} 加排序`);
    expect(v.markdown).toContain('已合併，待結案');
    expect(v.markdown).toContain(`「結案 ${r}」`);
    expect(v.links.map((l) => l.url)).toEqual([`/flow.html?task=${r}`, `/task.html?id=${r}`]);
    expect(showView(db, 't_nope')).toBeNull();
    setSetting(db, 'benchmark_enabled', 'true');
    const plan = path.join(repo, 'PLAN.md');
    fs.writeFileSync(plan, '# q');
    const { benchmark } = createBenchmark(db, { title: 'CCL', goal: 'g', plan_ref: plan, repo_path: repo, base_branch: 'main', verification_steps: ['true'], acceptance_metrics: 'max_ms <= 10', models: ['sonnet', 'local:qwen38-flash'], coding_tool: 'mock' });
    const b = showView(db, benchmark.id)!;
    expect(b.markdown).toContain('門檻：max_ms <= 10');
    expect(b.markdown).toContain('qwen38-flash');
  });

  it('what can be said follows the state', () => {
    expect(nextSayings({ id: 't_1', status: 'running' } as never)).toEqual(['中止 t_1']);
    expect(nextSayings({ id: 't_1', status: 'review', merge_status: 'pending', verify_mode: 'command' } as never)).toEqual(['合併 t_1', '退回修改 t_1']);
    expect(nextSayings({ id: 't_1', status: 'running', benchmark_id: 'b_1' } as never)).toEqual(['看評比 b_1']);
  });
});

describe('standings and templates', () => {
  it('standings say plainly when nothing has been judged; templates list every topic', () => {
    expect(standingsView(db).markdown).toContain('還沒有評完的評比');
    const work = templatesView(db, { topic: 'work' }).markdown;
    for (const k of ['algo', 'bugfix', 'feature', 'perf', 'spike', 'epic']) expect(work).toContain(`- ${k}（`);
    expect(templatesView(db, { topic: 'plans' }).markdown).toContain('還沒有驗證方案');
    expect(templatesView(db, { topic: 'models' }).markdown).toContain('雲端：sonnet');
    expect(templatesView(db, { topic: 'benchmark' }).markdown).toContain('重賽某一場');
    logEvent(db, { kind: 'note', detail: 'x' });
  });
});

describe('formats and template checks', () => {
  it('tables stop at MAX_ROWS and say how many more', () => {
    const rows = Array.from({ length: MAX_ROWS + 3 }, (_, i) => [i, 'a|b']);
    const t = table(['n', 'v'], rows);
    expect(t.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| n'))).toHaveLength(MAX_ROWS);
    expect(t).toContain('還有 3 筆');
    expect(t).toContain('a／b');
  });

  it('perf needs numbers that improve; every kind asks its own questions', () => {
    expect(measure('p95 ≤ 300 ms')).toEqual({ value: 300, unit: 'ms' });
    expect(improves('420 ms', '300 ms')).toBe(true);
    expect(improves('30 fps', '20 fps')).toBe(false);
    const q = missingFacts({ kind: 'perf', title: '加速單張處理', expected: '更快', baseline: '很慢', target: '快一點' });
    expect(q.map((m) => m.fact)).toEqual(['expected', 'baseline', 'target']);
    expect(missingFacts({ kind: 'perf', title: '加速單張處理', expected: '單張處理時間降到 300 ms 以內', baseline: '420 ms', target: '500 ms' })).toEqual([
      { fact: 'target', question: '目標要比現況好（例：現況 420 ms → 目標 300 ms）' },
    ]);
    expect(missingFacts({ kind: 'bugfix', title: '修正登入逾時', expected: '網路慢時十秒內顯示錯誤並可重試' }).map((m) => m.fact)).toEqual(['repro']);
    expect(missingFacts({ kind: 'spike', title: '評估套件', expected: '能不能用' }).map((m) => m.fact)).toEqual(['urls', 'expected']);
    expect(missingFacts({ kind: 'epic', title: '大改版', expected: '全部做完後，三個畫面都改成新版並且有回歸測試守住', parts: ['先量現況', '改 kernel'] })).toEqual([]);
  });
});
