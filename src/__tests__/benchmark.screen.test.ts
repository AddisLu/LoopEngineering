import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { getSetting, openTestDb, setSetting } from '../db/index.js';
import { getTask, setStatus } from '../tasks.js';
import { benchmarkMatrix, benchmarkRecommendations, cancelBenchmark, createBenchmark, getBenchmark, listBenchmarks } from '../benchmark/store.js';
import { checkBenchmarks, finishScreen, judgeBenchmark } from '../benchmark/complete.js';
import { createScreen, deleteScreen, getScreen, listScreens, promoteScreens, settleRestore } from '../benchmark/screen.js';
import { validateSetting } from '../settings.js';

// 模型快篩: model × built-in question rows, one at a time, grouped by model; no judge, no final
// measurement; queued behind a running benchmark; feeding the standings without touching judged
// numbers. Arm outcomes are simulated through the arm task's status (review = passed).
let db: Database.Database;
let root: string;
let guard: { hubDir: string; dockerProbe: () => boolean };
const QWEN = 'local:qwen38-flash';
const CODER = 'local:qwen3-coder-next';
const noSwitch = { state: () => ({ loaded: null, wanted: null, status: 'idle' as const, since: null, error: null }), ensureLoaded: () => 'switching' as const };
/** a model manager that records every switch it is asked for */
const recorder = () => {
  const asked: string[] = [];
  return { asked, mm: { ...noSwitch, ensureLoaded: (id: string) => (asked.push(id), 'switching' as const) } };
};
const operatorHas = (id: string) => {
  setSetting(db, 'local_model_status', 'ready');
  setSetting(db, 'local_model_loaded', id);
};
const judgeOk = async () => JSON.stringify({ arms: [{ arm: 'A', scores: { correctness: 8, completeness: 8, code_quality: 8, adherence: 8 }, notes: 'a' }, { arm: 'B', scores: { correctness: 6, completeness: 6, code_quality: 6, adherence: 6 }, notes: 'b' }], winner: 'A', summary: 'A' });
/** weights complete in a fake HF cache (the load guard reads it) */
function fakeWeights(hub: string, servedId: string) {
  const repo = path.join(hub, `models--${servedId.replace(/\//g, '--')}`);
  fs.mkdirSync(path.join(repo, 'snapshots', 'rev1'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'snapshots', 'rev1', 'model.safetensors'), 'w');
  fs.mkdirSync(path.join(repo, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'blobs', 'b1'), 'w');
}

beforeEach(() => {
  db = openTestDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-screen-'));
  setSetting(db, 'benchmark_enabled', 'true');
  setSetting(db, 'local_models_enabled', 'true');
  // loadable on this (pretend) machine: one Spark, recipes from an empty dir, weights on disk, image built
  setSetting(db, 'local_vllm_repo', root);
  guard = { hubDir: path.join(root, 'hub'), dockerProbe: () => true };
  fakeWeights(guard.hubDir, 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4');
  fakeWeights(guard.hubDir, 'Intel/Qwen3-Coder-Next-int4-AutoRound');
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const screen = (models: string[], questions = ['slugify', 'log-analyzer'], budget = 15) => createScreen(db, { models, questions, budget_min: budget }, { repoRoot: root, guard });
/** run a batch to its end, every row passing: one check per row, as the engine's tick does */
async function runOut(group: string, mm: ReturnType<typeof recorder>['mm']) {
  for (let i = 0; i < 20; i++) {
    const running = db.prepare("SELECT id FROM benchmarks WHERE screen_group = ? AND status = 'running'").get(group) as { id: string } | undefined;
    if (!running) break;
    finishArm(running.id, true);
    await checkBenchmarks(db, undefined, { modelManager: mm, guard });
  }
}
const rows = (group: string) => db.prepare('SELECT id, status, source_ref, screen_json FROM benchmarks WHERE screen_group = ? ORDER BY screen_seq').all(group) as Array<{ id: string; status: string; source_ref: string; screen_json: string }>;
const armOf = (id: string) => getBenchmark(db, id)!.arms[0];
const finishArm = (id: string, pass: boolean) => setStatus(db, armOf(id)!.task_id, pass ? 'review' : 'attention', { detail: pass ? 'verified' : 'verify failed at: python3 -m unittest' });

describe('creating a 快篩', () => {
  it('refuses a model this machine cannot start (weights, image, Sparks) instead of letting it hold the queue', () => {
    const empty = { hubDir: path.join(root, 'empty-hub'), dockerProbe: () => true };
    expect(() => createScreen(db, { models: [QWEN] }, { repoRoot: root, guard: empty })).toThrow('權重還沒下載');
    expect(() => createScreen(db, { models: [QWEN] }, { repoRoot: root, guard: { ...guard, dockerProbe: () => false } })).not.toThrow(); // no pinned image in an empty recipe dir
    expect((db.prepare("SELECT COUNT(*) AS n FROM benchmarks WHERE mode = 'screen'").get() as { n: number }).n).toBe(3);
  });

  it('checks models, questions and the time cap before creating anything', () => {
    expect(() => createScreen(db, { models: [] })).toThrow('至少要選 1 個模型');
    expect(() => createScreen(db, { models: ['local:nope'] }, { repoRoot: root })).toThrow('找不到這個本地模型');
    expect(() => createScreen(db, { models: ['sonnet'] }, { repoRoot: root })).toThrow('快篩只測本地模型');
    expect(() => createScreen(db, { models: [QWEN], questions: ['nope'] }, { repoRoot: root, guard })).toThrow('沒有這題內建題');
    expect(() => createScreen(db, { models: [QWEN], budget_min: 1 }, { repoRoot: root, guard })).toThrow('3 到 120');
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
    expect(await checkBenchmarks(db, undefined, { modelManager: noSwitch, guard })).toEqual([r.rows[0]]);
    expect(getBenchmark(db, r.rows[0]!)!.benchmark).toMatchObject({ status: 'judged', winner: null, summary: expect.stringMatching(/^通過/) });
    expect(getBenchmark(db, r.rows[0]!)!.arms[0]).toMatchObject({ verify_outcome: 'pass', judge_score: null, judge_rank: null });
    expect(getTask(db, armOf(r.rows[0]!)!.task_id)!.status).toBe('closed');
    // the next question of the same model was promoted in the same check
    expect(getBenchmark(db, r.rows[1]!)!.benchmark.status).toBe('running');
    finishArm(r.rows[1]!, false);
    await checkBenchmarks(db, undefined, { modelManager: noSwitch, guard });
    const g = getScreen(db, r.group)!;
    expect(g).toMatchObject({ status: 'done', passed: 1, done: 2, total: 2 });
    expect(g.cells.map((c) => c.outcome)).toEqual(['pass', 'fail']);
    expect(g.cells[1]!.failure).toContain('verify failed');
  });

  it("waits behind a running benchmark, starts once it is judged, and the operator's model comes back only at the very end", async () => {
    operatorHas('qwen38-flash');
    const bench = createBenchmark(db, { title: 'CCL', goal: 'fast CCL', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], domain: 'cuda', models: [QWEN, CODER], coding_tool: 'mock' });
    expect(bench.benchmark.restore_model).toBe('qwen38-flash');
    expect(getSetting(db, 'bench_restore_model')).toBe('qwen38-flash');
    setSetting(db, 'local_model_loaded', 'qwen3-coder-next'); // an arm switched the model
    const r = screen([QWEN]);
    expect(r.started).toBeNull();
    expect(r.waiting_for).toContain(bench.benchmark.id);
    expect(rows(r.group).map((x) => x.status)).toEqual(['queued', 'queued']);
    // the model loaded now belongs to the benchmark: the operator's is still the one captured
    expect(getSetting(db, 'bench_restore_model')).toBe('qwen38-flash');
    for (const a of bench.arms) setStatus(db, a.task_id, 'review');
    const { asked, mm } = recorder();
    const judged = await judgeBenchmark(db, bench.benchmark.id, judgeOk, { modelManager: mm });
    expect(judged!.status).toBe('judged');
    // the benchmark did not switch back: the waiting 快篩 would switch again at once
    expect(asked).toEqual([]);
    expect(promoteScreens(db, { guard })).toBe(r.rows[0]);
    await runOut(r.group, mm);
    expect(getScreen(db, r.group)!.status).toBe('done');
    // when the batch ends, the operator's model comes back — once
    expect(asked).toEqual(['qwen38-flash']);
    expect(getSetting(db, 'bench_restore_model')).toBe('');
  });

  it('a benchmark created before the queue-wide record still switches back to its own restore_model', async () => {
    operatorHas('qwen38-flash');
    const bench = createBenchmark(db, { title: 'CCL', goal: 'fast CCL', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], domain: 'cuda', models: [QWEN, CODER], coding_tool: 'mock' });
    setSetting(db, 'bench_restore_model', ''); // as it was before this version
    setSetting(db, 'local_model_loaded', 'qwen3-coder-next');
    for (const a of bench.arms) setStatus(db, a.task_id, 'review');
    const { asked, mm } = recorder();
    await judgeBenchmark(db, bench.benchmark.id, judgeOk, { modelManager: mm });
    expect(asked).toEqual(['qwen38-flash']);
  });

  it("the operator's model comes back whatever ends the queue: a cloud-only benchmark ahead, a cancelled batch, a judge failure", async () => {
    // a cloud-only benchmark never switches anything: the model loaded under it is the operator's
    operatorHas('qwen36-35b');
    const cloud = createBenchmark(db, { title: 'cloud', goal: 'g', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], domain: 'python', models: ['sonnet', 'haiku'], coding_tool: 'mock' });
    expect(getSetting(db, 'bench_restore_model')).toBe('');
    const first = screen([QWEN], ['slugify']);
    const second = screen([CODER], ['slugify']);
    expect(getSetting(db, 'bench_restore_model')).toBe('qwen36-35b');
    // the batch ahead of `second` is cancelled while the benchmark still runs
    cancelBenchmark(db, first.rows[0]!, '不測了');
    for (const a of cloud.arms) setStatus(db, a.task_id, 'review');
    const { asked, mm } = recorder();
    // the benchmark's judge fails: nothing to switch back yet, a 快篩 still waits
    await judgeBenchmark(db, cloud.benchmark.id, async () => 'not json', { modelManager: mm });
    expect(getBenchmark(db, cloud.benchmark.id)!.benchmark.status).toBe('judge_failed');
    await checkBenchmarks(db, undefined, { modelManager: mm, guard });
    expect(asked).toEqual([]);
    setSetting(db, 'local_model_loaded', 'qwen3-coder-next'); // the 快篩 switched
    await runOut(second.group, mm);
    expect(asked).toEqual(['qwen36-35b']);
  });

  it("a batch made while the previous one is still reporting keeps the operator's model, not the one being screened", async () => {
    operatorHas('qwen36-35b');
    const a = screen([QWEN], ['slugify']);
    setSetting(db, 'local_model_loaded', 'qwen38-flash'); // the 快篩 switched
    // a's last row is recorded, its push is still in flight: nothing has settled yet
    finishArm(a.rows[0]!, true);
    db.prepare("UPDATE benchmarks SET status = 'judged' WHERE id = ?").run(a.rows[0]);
    const b = screen([CODER], ['slugify']);
    expect(getSetting(db, 'bench_restore_model')).toBe('qwen36-35b');
    const { asked, mm } = recorder();
    // a finishes settling while b runs: nothing switches
    expect(settleRestore(db, mm)).toBeNull();
    await runOut(b.group, mm);
    expect(asked).toEqual(['qwen36-35b']);
  });

  it('a batch whose last rows end while waiting is still reported, and the model still comes back', async () => {
    operatorHas('qwen36-35b');
    const r = screen([QWEN, CODER], ['slugify']);
    db.prepare("UPDATE local_models SET enabled = 0 WHERE id = 'qwen3-coder-next'").run();
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const { asked, mm } = recorder();
    await runOut(r.group, mm);
    expect(getScreen(db, r.group)!.status).toBe('done');
    const line = db.prepare('SELECT detail FROM task_events WHERE detail LIKE ? ORDER BY id DESC LIMIT 1').get(`模型快篩 ${r.group} 完成：%`) as { detail: string };
    expect(line.detail).toContain('qwen38-flash 1/1');
    expect(line.detail).toContain('qwen3-coder-next 沒有開始（本地模型 local:qwen3-coder-next 已停用）');
    expect(asked).toEqual(['qwen36-35b']);
  });

  it('two batches made in the same second run one after the other, not interleaved', async () => {
    const a = screen([QWEN], ['slugify', 'log-analyzer']);
    const b = screen([CODER], ['slugify', 'log-analyzer']);
    db.prepare("UPDATE benchmarks SET created_at = '2026-09-30 12:00:00' WHERE mode = 'screen'").run();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      const running = db.prepare("SELECT id FROM benchmarks WHERE mode = 'screen' AND status = 'running'").get() as { id: string } | undefined;
      if (!running) break;
      order.push(running.id);
      finishArm(running.id, true);
      await checkBenchmarks(db, undefined, { modelManager: noSwitch, guard });
    }
    expect(order).toEqual([...a.rows, ...b.rows]);
  });

  it("a model vLLM fails to start after its row began is that row's result, not a stuck queue", async () => {
    const r = screen([QWEN, CODER], ['slugify']);
    const failing = { ...noSwitch, state: () => ({ loaded: null, wanted: 'qwen38-flash', status: 'error' as const, since: new Date(Date.now() + 1000).toISOString(), error: 'CUDA out of memory' }) };
    await checkBenchmarks(db, undefined, { modelManager: failing, guard });
    const cell = getScreen(db, r.group)!.cells[0]!;
    expect(cell).toMatchObject({ model: QWEN, outcome: 'fail' });
    expect(cell.failure).toContain('模型載入失敗：CUDA out of memory');
    // the next model's row started instead of the queue waiting on retries
    expect(getBenchmark(db, r.rows[1]!)!.benchmark.status).toBe('running');
    // an error from before a row began does not count against it (the tick retries after its cool-down)
    const stale = { ...noSwitch, state: () => ({ loaded: null, wanted: 'qwen3-coder-next', status: 'error' as const, since: '2026-01-01T00:00:00.000Z', error: 'old' }) };
    await checkBenchmarks(db, undefined, { modelManager: stale, guard });
    expect(getBenchmark(db, r.rows[1]!)!.benchmark.status).toBe('running');
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
    await checkBenchmarks(db, undefined, { modelManager: noSwitch, guard });
    expect(getBenchmark(db, r.rows[0]!)!.benchmark.status).toBe('running');
    expect(getBenchmark(db, r.rows[0]!)!.arms).toHaveLength(1);
  });

  it('a model disabled while its rows waited is skipped with the reason, not run', () => {
    const r = screen([QWEN, CODER], ['slugify']);
    db.prepare("UPDATE local_models SET enabled = 0 WHERE id = 'qwen3-coder-next'").run();
    finishArm(r.rows[0]!, true);
    db.prepare("UPDATE benchmarks SET status = 'judged' WHERE id = ?").run(r.rows[0]);
    expect(promoteScreens(db, { guard })).toBeNull();
    expect(getBenchmark(db, r.rows[1]!)!.benchmark).toMatchObject({ status: 'cancelled', error: expect.stringContaining('已停用') });
  });
});

describe('lists and settings', () => {
  it('the benchmark list leaves 快篩 rows out before its limit, so a long queue cannot hide a benchmark', () => {
    const bench = createBenchmark(db, { title: 'CCL', goal: 'fast CCL', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], domain: 'python', models: [QWEN, CODER], coding_tool: 'mock' });
    for (let i = 0; i < 9; i++) screen([QWEN, CODER], ['slugify', 'log-analyzer', 'csv-parser']);
    expect(listBenchmarks(db).map((b) => b.id)).toEqual([bench.benchmark.id]);
    expect(listBenchmarks(db, 10, { screens: true })).toHaveLength(10);
  });

  it('settings take only what 快篩 accepts', () => {
    for (const bad of ['2', '0', '7.5', '500', 'x']) expect(validateSetting('bench_screen_budget_min', bad), bad).not.toBeNull();
    expect(validateSetting('bench_screen_budget_min', '15')).toBeNull();
    expect(validateSetting('bench_screen_questions', 'a,b,c,d,e,f,g')).not.toBeNull();
    expect(validateSetting('bench_screen_questions', 'slugify,log-analyzer')).toBeNull();
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
    await checkBenchmarks(db, undefined, { modelManager: noSwitch, guard });
    const after = benchmarkMatrix(db).find((m) => m.model === QWEN)!;
    expect(after).toMatchObject({ n: 2, screen_n: 1, win_rate: before.win_rate, avg_score: before.avg_score });
    expect(after.verify_pass_rate).toBe(0.5);
    expect(benchmarkMatrix(db, { screens: false }).find((m) => m.model === QWEN)).toMatchObject({ n: 1, screen_n: 0, verify_pass_rate: before.verify_pass_rate });
    // a model known only from 快篩 says so
    const only = screen([CODER], ['log-analyzer']);
    finishArm(only.rows[0]!, true);
    await checkBenchmarks(db, undefined, { modelManager: noSwitch, guard });
    const rec = benchmarkRecommendations(db).find((x) => x.domain === 'python')!;
    expect(rec.thin).toBe(true);
    expect(benchmarkMatrix(db).find((m) => m.model === CODER && m.domain === 'python')).toMatchObject({ win_rate: expect.any(Number) });
  });
});
