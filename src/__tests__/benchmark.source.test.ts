import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { BENCH_SEED_DIR, listBuiltin, loadBuiltin, resolveSource } from '../benchmark/source.js';
import { aggregateJudgements, type ArmEvidence, type BenchJudgeResult } from '../benchmark/judge.js';
import { BenchmarkInputError, benchmarkSummary, createBenchmark, getBenchmark, judgeList, listBenchmarks, modelLabel } from '../benchmark/store.js';
import { judgeBenchmark } from '../benchmark/complete.js';

let db: Database.Database;
let tmp: string[] = [];
const tmpdir = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmp.push(d);
  return d;
};

beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'benchmark_enabled', 'true');
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

describe('built-in question bank', () => {
  it('ships neutral questions that carry their own tests and no CF-AOI content', () => {
    const qs = listBuiltin();
    expect(qs.length).toBeGreaterThanOrEqual(6);
    for (const q of qs) {
      expect(q.key).toMatch(/^[a-z0-9-]+$/);
      expect(q.verification_steps.length).toBeGreaterThan(0);
      expect(q.file_count).toBeGreaterThan(2);
      const full = loadBuiltin(q.key)!;
      const text = JSON.stringify(full);
      // the bank is public-safe: no plant paths, hostnames or internal module names
      expect(text).not.toMatch(/cf-aoi|appsettings|192\.168\.|tailffdb68|IP02_/i);
      expect(Object.keys(full.files)).toContain('PLAN.md');
      expect(Object.keys(full.files).some((f) => f.startsWith('tests/'))).toBe(true);
    }
    expect(loadBuiltin('../../etc/passwd')).toBeNull();
    expect(loadBuiltin('nope')).toBeNull();
    expect(listBuiltin(path.join(BENCH_SEED_DIR, 'missing'))).toEqual([]);
  });

  it('builds a throwaway repo with its own origin, and the arms pass the gate', () => {
    const root = tmpdir('bench-root-');
    const q = resolveSource(db, 'builtin', 'slugify', {}, { repoRoot: root });
    expect(q.source_kind).toBe('builtin');
    expect(q.source_ref).toBe('slugify');
    expect(q.repo_path!.startsWith(path.join(root, '.bench'))).toBe(true);
    expect(fs.existsSync(path.join(q.repo_path!, 'tests'))).toBe(true);
    // the engine cuts worktrees from origin/<base>
    expect(execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: q.repo_path!, encoding: 'utf8' }).trim()).toMatch(/^[0-9a-f]{40}$/);
    const { benchmark, arms } = createBenchmark(db, { ...q, models: ['local:qwen38-flash', 'sonnet'] });
    expect(benchmark).toMatchObject({ source_kind: 'builtin', source_ref: 'slugify', domain: 'python' });
    for (const a of arms) expect(validateTask(getTask(db, a.task_id)!).missing).toEqual([]);
    expect(() => resolveSource(db, 'builtin', 'nope', {}, { repoRoot: root })).toThrow(BenchmarkInputError);
  });
});

describe('resolveSource', () => {
  it('copies an existing task, and refuses an unknown one', () => {
    const t = createTask(db, {
      title: 'RDMA 收圖改用 SEND/RECV',
      goal: '把 slot 覆寫問題修掉',
      plan_ref: 'https://example.com/plan',
      repo_path: '/r/cf',
      base_branch: 'develop',
      verification_steps: ['npm test', 'ctest'],
      setup_cmd: 'npm ci',
      complexity: 'L',
    });
    const q = resolveSource(db, 'task', t.id);
    expect(q).toMatchObject({
      title: 'RDMA 收圖改用 SEND/RECV',
      repo_path: '/r/cf',
      base_branch: 'develop',
      verification_steps: ['npm test', 'ctest'],
      setup_cmd: 'npm ci',
      complexity: 'L',
      source_kind: 'task',
      source_ref: t.id,
    });
    // the page may override anything it shows
    expect(resolveSource(db, 'task', t.id, { title: '改一下', domain: 'cpp' }).title).toBe('改一下');
    expect(() => resolveSource(db, 'task', 't_nope')).toThrow(/找不到任務/);
    expect(() => resolveSource(db, 'manual', null, { title: 'x' })).toThrow(/goal/);
    expect(() => resolveSource(db, 'zzz' as never, null)).toThrow(/task, draft, builtin or manual/);
  });
});

describe('multi-judge', () => {
  const evidence: ArmEvidence[] = [
    { model: 'local:a', verify_outcome: 'pass', failure: null, diff_stat: '', diff: '', tokens_out: 100, duration_s: 10 },
    { model: 'local:b', verify_outcome: 'pass', failure: null, diff_stat: '', diff: '', tokens_out: 200, duration_s: 20 },
  ];
  const verdict = (a: number, b: number, notes = 'n'): BenchJudgeResult => ({
    ok: true,
    arms: [
      { model: 'local:a', label: 'A', scores: { correctness: a, completeness: a, code_quality: a, adherence: a }, total: a, rank: a >= b ? 1 : 2, notes },
      { model: 'local:b', label: 'B', scores: { correctness: b, completeness: b, code_quality: b, adherence: b }, total: b, rank: b > a ? 1 : 2, notes },
    ],
    winner: a >= b ? 'local:a' : 'local:b',
    summary: `${a} vs ${b}`,
    judge_winner_label: a >= b ? 'A' : 'B',
  });

  it('averages the criteria, re-ranks from the mean and reports the consensus', () => {
    const agreed = aggregateJudgements(new Map([['opus', verdict(9, 6)], ['sonnet', verdict(8, 5)]]), evidence);
    expect(agreed.consensus).toBe('unanimous');
    expect(agreed.winner).toBe('local:a');
    const a = agreed.arms.find((x) => x.model === 'local:a')!;
    expect(a.mean.total).toBe(8.5);
    expect(Object.keys(a.per_judge)).toEqual(['opus', 'sonnet']);
    expect(a.rank).toBe(1);

    const split = aggregateJudgements(new Map([['opus', verdict(9, 6)], ['sonnet', verdict(4, 8)]]), evidence);
    expect(split.consensus).toBe('split');
    expect(split.summary).toContain('【opus】');
    expect(split.summary).toContain('【sonnet】');
    // 6.5 vs 7.0 → the mean decides, not the first judge
    expect(split.winner).toBe('local:b');

    const solo = aggregateJudgements(new Map([['opus', verdict(9, 6)]]), evidence);
    expect(solo.consensus).toBe('single');
    expect(solo.summary).toBe('9 vs 6');

    // a judge that failed simply does not vote
    const partial = aggregateJudgements(new Map([['opus', verdict(9, 6)], ['sonnet', { ok: false, error: 'boom' }]]), evidence);
    expect(partial.consensus).toBe('single');
    expect(Object.keys(partial.arms[0]!.per_judge)).toEqual(['opus']);
  });
});

describe('judgeBenchmark with several judges', () => {
  const INPUT = {
    title: 'bench',
    goal: 'do it',
    plan_ref: 'https://example.com/p',
    verification_steps: ['true'],
    models: ['local:qwen38-flash', 'local:qwen3-coder-next'],
    coding_tool: 'mock' as const,
  };
  const scored = (first: string) =>
    JSON.stringify({
      arms: [
        { arm: 'A', scores: { correctness: first === 'A' ? 9 : 5, completeness: 8, code_quality: 8, adherence: 8 }, notes: 'a' },
        { arm: 'B', scores: { correctness: first === 'B' ? 9 : 5, completeness: 8, code_quality: 8, adherence: 8 }, notes: 'b' },
      ],
      winner: first,
      summary: `${first} wins`,
    });

  it('stores one row per judge, keeps going when one fails, and switches the model back', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const { benchmark } = createBenchmark(db, { ...INPUT, judge_models: ['opus', 'sonnet'] });
    expect(benchmark.judge_models).toBe('opus,sonnet');
    expect(benchmark.restore_model).toBe('qwen38-flash');
    expect(judgeList(benchmark)).toEqual(['opus', 'sonnet']);

    const ensured: string[] = [];
    const mm = { state: () => ({ loaded: 'qwen3-coder-next', wanted: null, status: 'ready' as const, since: null, error: null }), ensureLoaded: (id: string) => { ensured.push(id); return 'switching' as const; } };
    const judged = await judgeBenchmark(db, benchmark.id, async (_p, model) => (model === 'sonnet' ? Promise.reject(new Error('cloud hiccup')) : scored('A')), { modelManager: mm });

    expect(judged).toMatchObject({ status: 'judged', consensus: 'single' });
    expect(judged!.error).toContain('sonnet');
    const d = getBenchmark(db, benchmark.id)!;
    expect(d.judgements.map((j) => j.judge_model)).toEqual(['opus', 'sonnet']);
    expect(d.judgements.find((j) => j.judge_model === 'sonnet')!.error).toContain('cloud hiccup');
    expect(d.judgements.find((j) => j.judge_model === 'opus')!.winner).toBe('local:qwen38-flash');
    // the benchmark's arms moved vLLM; the operator's model comes back
    expect(ensured).toEqual(['qwen38-flash']);

    const listed = listBenchmarks(db)[0]!;
    expect(listed).toMatchObject({ winner_label: 'Qwen3.8 Flash Next (NVFP4)', judges: ['opus', 'sonnet'] });
    expect(listed.models.sort()).toEqual(['local:qwen38-flash', 'local:qwen3-coder-next'].sort());
    const sum = benchmarkSummary(db);
    expect(sum.running).toBeNull();
    expect(sum.recent).toHaveLength(1);
    expect(sum.models.find((m) => m.model === 'local:qwen38-flash')).toMatchObject({ wins: 1, n: 1, label: 'Qwen3.8 Flash Next (NVFP4)' });
    expect(modelLabel(db, 'sonnet')).toBe('sonnet');
  });

  it('every judge failing is still judge_failed', async () => {
    const { benchmark } = createBenchmark(db, { ...INPUT, judge_models: ['opus', 'sonnet'] });
    const judged = await judgeBenchmark(db, benchmark.id, async () => Promise.reject(new Error('down')));
    expect(judged).toMatchObject({ status: 'judge_failed' });
    expect(judged!.error).toContain('opus');
    expect(judged!.error).toContain('sonnet');
  });
});
