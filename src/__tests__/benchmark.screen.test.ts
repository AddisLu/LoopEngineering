import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { getTask, setStatus } from '../tasks.js';
import { benchmarkMatrix, benchmarkRecommendations, cancelBenchmark, createBenchmark, getBenchmark } from '../benchmark/store.js';
import { checkBenchmarks, finishScreen, judgeBenchmark } from '../benchmark/complete.js';
import { createScreen, deleteScreen, getScreen, listScreens, promoteScreens } from '../benchmark/screen.js';

// 模型快篩: model × built-in question rows, one at a time, grouped by model; no judge, no final
// measurement; queued behind a running benchmark; feeding the standings without touching judged
// numbers. Arm outcomes are simulated through the arm task's status (review = passed).
let db: Database.Database;
let root: string;
const QWEN = 'local:qwen38-flash';
const CODER = 'local:qwen3-coder-next';
const noSwitch = { state: () => ({ loaded: null, wanted: null, status: 'idle' as const, since: null, error: null }), ensureLoaded: () => 'switching' as const };

beforeEach(() => {
  db = openTestDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-screen-'));
  setSetting(db, 'benchmark_enabled', 'true');
  setSetting(db, 'local_models_enabled', 'true');
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const screen = (models: string[], questions = ['slugify', 'log-analyzer'], budget = 15) => createScreen(db, { models, questions, budget_min: budget }, { repoRoot: root });
const rows = (group: string) => db.prepare('SELECT id, status, source_ref, screen_json FROM benchmarks WHERE screen_group = ? ORDER BY screen_seq').all(group) as Array<{ id: string; status: string; source_ref: string; screen_json: string }>;
const armOf = (id: string) => getBenchmark(db, id)!.arms[0];
const finishArm = (id: string, pass: boolean) => setStatus(db, armOf(id)!.task_id, pass ? 'review' : 'attention', { detail: pass ? 'verified' : 'verify failed at: python3 -m unittest' });

describe('creating a 快篩', () => {
  it('checks models, questions and the time cap before creating anything', () => {
    expect(() => createScreen(db, { models: [] })).toThrow('至少要選 1 個模型');
    expect(() => createScreen(db, { models: ['local:nope'] }, { repoRoot: root })).toThrow('找不到這個本地模型');
    expect(() => createScreen(db, { models: ['sonnet'] }, { repoRoot: root })).toThrow('快篩只測本地模型');
    expect(() => createScreen(db, { models: [QWEN], questions: ['nope'] }, { repoRoot: root })).toThrow('沒有這題內建題');
    expect(() => createScreen(db, { models: [QWEN], budget_min: 1 }, { repoRoot: root })).toThrow('3 到 120');
    setSetting(db, 'local_models_enabled', 'false');
    expect(() => createScreen(db, { models: [QWEN] }, { repoRoot: root })).toThrow('local_models_enabled');
    expect((db.prepare("SELECT COUNT(*) AS n FROM benchmarks").get() as { n: number }).n).toBe(0);
  });

  it('one row per model × question, grouped by model; only the first one starts', () => {
    const r = screen([QWEN, CODER]);
    expect(r.rows).toHaveLength(4);
    expect(r.started).toBe(r.rows[0]);
    const list = rows(r.group);
    expect(list.map((x) => [JSON.parse(x.screen_json).model, x.source_ref, x.status])).toEqual([
      [QWEN, 'slugify', 'running'],
      [QWEN, 'log-analyzer', 'queued'],
      [CODER, 'slugify', 'queued'],
      [CODER, 'log-analyzer', 'queued'],
    ]);
    const b = getBenchmark(db, r.rows[0]!)!;
    expect(b.benchmark).toMatchObject({ mode: 'screen', judge_model: 'none', timeout_min: 15, verify_timeout_min: 5, domain: 'python', title: '快篩：slugify：URL 友善的字串正規化' });
    expect(b.arms).toHaveLength(1);
    expect(getTask(db, b.arms[0]!.task_id)).toMatchObject({ status: 'queued', model: QWEN, timeout_min: 15, benchmark_id: r.rows[0] });
    // the rest have no arm until their turn: nothing else can be dispatched early
    expect(getBenchmark(db, r.rows[1]!)!.arms).toHaveLength(0);
  });
});

describe('running a 快篩', () => {
  it('a finished row records pass/fail without a judge, and the next row starts', async () => {
    const r = screen([QWEN]);
    finishArm(r.rows[0]!, true);
    expect(await checkBenchmarks(db)).toEqual([r.rows[0]]);
    expect(getBenchmark(db, r.rows[0]!)!.benchmark).toMatchObject({ status: 'judged', winner: null, summary: expect.stringMatching(/^通過/) });
    expect(getBenchmark(db, r.rows[0]!)!.arms[0]).toMatchObject({ verify_outcome: 'pass', judge_score: null, judge_rank: null });
    expect(getTask(db, armOf(r.rows[0]!)!.task_id)!.status).toBe('closed');
    // the next question of the same model was promoted in the same check
    expect(getBenchmark(db, r.rows[1]!)!.benchmark.status).toBe('running');
    finishArm(r.rows[1]!, false);
    await checkBenchmarks(db);
    const g = getScreen(db, r.group)!;
    expect(g).toMatchObject({ status: 'done', passed: 1, done: 2, total: 2 });
    expect(g.cells.map((c) => c.outcome)).toEqual(['pass', 'fail']);
    expect(g.cells[1]!.failure).toContain('verify failed');
  });

  it('waits behind a running benchmark, starts once it is judged, and inherits the model to switch back to', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const bench = createBenchmark(db, { title: 'CCL', goal: 'fast CCL', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], domain: 'cuda', models: [QWEN, CODER], coding_tool: 'mock' });
    expect(bench.benchmark.restore_model).toBe('qwen38-flash');
    setSetting(db, 'local_model_loaded', 'qwen3-coder-next'); // an arm switched the model
    const r = screen([QWEN]);
    expect(r.started).toBeNull();
    expect(r.waiting_for).toContain(bench.benchmark.id);
    expect(rows(r.group).map((x) => x.status)).toEqual(['queued', 'queued']);
    // no restore captured: the model loaded now belongs to the benchmark, not the operator
    expect(getBenchmark(db, r.rows[0]!)!.benchmark.restore_model).toBeNull();
    for (const a of bench.arms) setStatus(db, a.task_id, 'review');
    const asked: string[] = [];
    const judged = await judgeBenchmark(db, bench.benchmark.id, async () => JSON.stringify({ arms: [{ arm: 'A', scores: { correctness: 8, completeness: 8, code_quality: 8, adherence: 8 }, notes: 'a' }, { arm: 'B', scores: { correctness: 6, completeness: 6, code_quality: 6, adherence: 6 }, notes: 'b' }], winner: 'A', summary: 'A' }), {
      modelManager: { ...noSwitch, ensureLoaded: (id: string) => (asked.push(id), 'switching' as const) },
    });
    expect(judged!.status).toBe('judged');
    // the benchmark did not switch back: the waiting 快篩 would switch again at once
    expect(asked).toEqual([]);
    expect(getBenchmark(db, r.rows[0]!)!.benchmark.restore_model).toBe('qwen38-flash');
    expect(promoteScreens(db)).toBe(r.rows[0]);
    // when the batch ends, the operator's model comes back
    finishArm(r.rows[0]!, true);
    await finishScreen(db, r.rows[0]!, { modelManager: noSwitch });
    promoteScreens(db);
    finishArm(r.rows[1]!, true);
    const back: string[] = [];
    await finishScreen(db, r.rows[1]!, { modelManager: { ...noSwitch, ensureLoaded: (id: string) => (back.push(id), 'switching' as const) } });
    expect(back).toEqual(['qwen38-flash']);
  });

  it('cancelling any row cancels the whole batch; a batch can then be deleted', () => {
    const r = screen([QWEN, CODER]);
    const running = armOf(r.rows[0]!)!;
    cancelBenchmark(db, r.rows[2]!, '不測了');
    expect(rows(r.group).map((x) => x.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    expect(getTask(db, running.task_id)!.status).toBe('failed');
    expect(getScreen(db, r.group)!.status).toBe('cancelled');
    expect(deleteScreen(db, r.group)).toBe(4);
    expect(listScreens(db)).toEqual([]);
  });

  it('a row left waiting (say, by a restart) is started by the next check', async () => {
    const r = screen([QWEN], ['slugify']);
    db.prepare("UPDATE benchmarks SET status = 'queued' WHERE id = ?").run(r.rows[0]);
    db.prepare('DELETE FROM benchmark_arms WHERE benchmark_id = ?').run(r.rows[0]);
    await checkBenchmarks(db);
    expect(getBenchmark(db, r.rows[0]!)!.benchmark.status).toBe('running');
    expect(getBenchmark(db, r.rows[0]!)!.arms).toHaveLength(1);
  });

  it('a model disabled while its rows waited is skipped with the reason, not run', () => {
    const r = screen([QWEN, CODER], ['slugify']);
    db.prepare("UPDATE local_models SET enabled = 0 WHERE id = 'qwen3-coder-next'").run();
    finishArm(r.rows[0]!, true);
    db.prepare("UPDATE benchmarks SET status = 'judged' WHERE id = ?").run(r.rows[0]);
    expect(promoteScreens(db)).toBeNull();
    expect(getBenchmark(db, r.rows[1]!)!.benchmark).toMatchObject({ status: 'cancelled', error: expect.stringContaining('已停用') });
  });
});

describe('the standings', () => {
  it('快篩 counts toward pass rates but never toward wins, judge scores or head-to-head', async () => {
    const bench = createBenchmark(db, { title: 'CCL', goal: 'fast CCL', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], domain: 'python', models: [QWEN, CODER], coding_tool: 'mock' });
    for (const a of bench.arms) setStatus(db, a.task_id, 'review');
    await judgeBenchmark(db, bench.benchmark.id, async () => JSON.stringify({ arms: [{ arm: 'A', scores: { correctness: 9, completeness: 9, code_quality: 9, adherence: 9 }, notes: 'a' }, { arm: 'B', scores: { correctness: 5, completeness: 5, code_quality: 5, adherence: 5 }, notes: 'b' }], winner: 'A', summary: 'A' }), { modelManager: noSwitch });
    const before = benchmarkMatrix(db).find((m) => m.model === QWEN)!;
    const r = screen([QWEN], ['slugify']);
    finishArm(r.rows[0]!, false);
    await checkBenchmarks(db);
    const after = benchmarkMatrix(db).find((m) => m.model === QWEN)!;
    expect(after).toMatchObject({ n: 2, screen_n: 1, win_rate: before.win_rate, avg_score: before.avg_score });
    expect(after.verify_pass_rate).toBe(0.5);
    expect(benchmarkMatrix(db, { screens: false }).find((m) => m.model === QWEN)).toMatchObject({ n: 1, screen_n: 0, verify_pass_rate: before.verify_pass_rate });
    // a model known only from 快篩 says so
    const only = screen([CODER], ['log-analyzer']);
    finishArm(only.rows[0]!, true);
    await checkBenchmarks(db);
    const rec = benchmarkRecommendations(db).find((x) => x.domain === 'python')!;
    expect(rec.thin).toBe(true);
    expect(benchmarkMatrix(db).find((m) => m.model === CODER && m.domain === 'python')).toMatchObject({ win_rate: expect.any(Number) });
  });
});
