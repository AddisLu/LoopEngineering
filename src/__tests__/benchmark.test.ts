import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { getTask } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';
import { activeBenchmark, cancelBenchmark, createBenchmark, deleteBenchmark, getBenchmark, benchmarkMatrix, listBenchmarks, type NewBenchmarkInput } from '../benchmark/store.js';
import { checkBenchmarks, judgeBenchmark } from '../benchmark/complete.js';
import { deleteTask } from '../tasks.js';
import { parseBenchJudgement, type ArmEvidence } from '../benchmark/judge.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  process.env.MOCK_SLEEP_MS = '50';
  setSetting(db, 'max_resumes', '0'); // a failed verify goes straight to attention (terminal)
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
});

const INPUT: NewBenchmarkInput = {
  title: 'matmul kernel',
  goal: 'implement a tiled matmul',
  plan_ref: 'https://example.com/plan.md',
  verification_steps: ['true'],
  domain: 'cuda',
  models: ['local:qwen38-flash', 'local:qwen3-coder-next'],
  coding_tool: 'mock',
};

const S = (c: number, co: number, q: number, ad: number, notes = 'n') => ({
  scores: { correctness: c, completeness: co, code_quality: q, adherence: ad },
  notes,
});
const judgeJson = (a: object, b: object) =>
  JSON.stringify({ arms: [{ arm: 'A', ...a }, { arm: 'B', ...b }], winner: 'B', summary: 'B is cleaner.' });

async function runArms(benchId: string, failModel?: string) {
  for (const arm of getBenchmark(db, benchId)!.arms) {
    if (arm.model === failModel) {
      db.prepare('UPDATE tasks SET verification_steps = ? WHERE id = ?').run(JSON.stringify(['false']), arm.task_id);
    }
    await runTask(db, getTask(db, arm.task_id)!);
  }
}

describe('createBenchmark', () => {
  it('materializes one queued arm task per model, tagged for the matrix', () => {
    const { benchmark, arms } = createBenchmark(db, INPUT);
    expect(benchmark).toMatchObject({ status: 'running', domain: 'cuda', judge_model: 'opus' });
    expect(arms.map((a) => a.model)).toEqual(['local:qwen38-flash', 'local:qwen3-coder-next']);
    for (const arm of arms) {
      const t = getTask(db, arm.task_id)!;
      expect(t).toMatchObject({ status: 'queued', model: arm.model, benchmark_id: benchmark.id, experiment: `bench:${benchmark.id}` });
      expect(JSON.parse(t.verification_steps)).toEqual(['true']);
    }
    expect(listBenchmarks(db)[0]).toMatchObject({ id: benchmark.id, arm_count: 2, arms_done: 0 });
  });

  it('rejects inputs that cannot produce a fair comparison', () => {
    expect(() => createBenchmark(db, { ...INPUT, models: ['local:qwen38-flash', 'local:qwen38-flash'] })).toThrow(/2 個不同的參賽模型/);
    expect(() => createBenchmark(db, { ...INPUT, models: ['local:qwen38-flash', 'local:nope'] })).toThrow(/找不到這個本地模型/);
    expect(() => createBenchmark(db, { ...INPUT, models: ['local:qwen38-flash', 'local:qwen36-35b'] })).toThrow(/已停用/);
    expect(() => createBenchmark(db, { ...INPUT, domain: 'cobol' })).toThrow(/領域只能是/);
    expect(() => createBenchmark(db, { ...INPUT, verification_steps: [] })).toThrow(/驗證指令/);
    expect(() => createBenchmark(db, { ...INPUT, judge_model: 'haiku' })).toThrow(/評審只能選/);
    expect(() => createBenchmark(db, { ...INPUT, coding_tool: 'claude-code', repo_path: '/nope' })).toThrow(/題目還缺：repo 路徑/);
    expect(listBenchmarks(db)).toEqual([]); // nothing half-created
  });

  it('a cloud baseline arm is allowed next to local arms', () => {
    const { arms } = createBenchmark(db, { ...INPUT, models: ['local:qwen38-flash', 'sonnet'] });
    expect(arms.map((a) => a.model)).toEqual(['local:qwen38-flash', 'sonnet']);
  });

  it('only one benchmark may own the machine at a time', () => {
    const first = createBenchmark(db, INPUT).benchmark;
    expect(activeBenchmark(db)?.id).toBe(first.id);
    // two at once means two sets of arms on one GPU and only one of them visible
    expect(() => createBenchmark(db, INPUT)).toThrow(/已經有一個評比在跑/);
    cancelBenchmark(db, first.id);
    expect(activeBenchmark(db)).toBeNull();
    const second = createBenchmark(db, INPUT).benchmark;
    expect(second.id).not.toBe(first.id);
  });
});

describe('cancel and delete', () => {
  it('cancelling fails the unfinished arms, frees the machine, and can be deleted afterwards', () => {
    const { benchmark, arms } = createBenchmark(db, INPUT);
    const seen: string[] = [];
    expect(() => deleteBenchmark(db, benchmark.id)).toThrow(/還在進行/);
    const after = cancelBenchmark(db, benchmark.id, '使用者取消', { onArmTask: (t) => seen.push(t.id) })!;
    expect(after.status).toBe('cancelled');
    expect(after.error).toBe('使用者取消');
    expect(seen).toEqual(arms.map((a) => a.task_id)); // the live run is killed before the row changes
    for (const a of arms) expect(getTask(db, a.task_id)!.status).toBe('failed');
    expect(deleteBenchmark(db, benchmark.id)).toBe(true);
    expect(getBenchmark(db, benchmark.id)).toBeNull();
    // the arm tasks stay on the board; only the comparison is gone
    for (const a of arms) expect(getTask(db, a.task_id)).toBeTruthy();
    expect(deleteBenchmark(db, benchmark.id)).toBe(false);
  });

  it('an arm whose task was deleted counts as done and never gets judged as a loser', async () => {
    const { benchmark, arms } = createBenchmark(db, INPUT);
    await runTask(db, getTask(db, arms[0]!.task_id)!);
    deleteTask(db, arms[1]!.task_id);
    // the deleted arm used to hold arms_done below arm_count forever
    expect(listBenchmarks(db)[0]).toMatchObject({ arm_count: 2, arms_done: 2 });
    const judged = await judgeBenchmark(db, benchmark.id, async () => '{}');
    expect(judged).toMatchObject({ status: 'cancelled' });
    expect(judged!.error).toMatch(/參賽組不足/);
  });
});

describe('judging', () => {
  beforeEach(() => setSetting(db, 'benchmark_enabled', 'true'));

  it('waits until every arm is terminal; never judges while disabled', async () => {
    const { benchmark, arms } = createBenchmark(db, INPUT);
    await runTask(db, getTask(db, arms[0]!.task_id)!);
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return judgeJson(S(5, 5, 5, 5), S(5, 5, 5, 5));
    };
    expect(await checkBenchmarks(db, exec)).toEqual([]);

    await runTask(db, getTask(db, arms[1]!.task_id)!);
    setSetting(db, 'benchmark_enabled', 'false');
    expect(await checkBenchmarks(db, exec)).toEqual([]);
    expect(calls).toBe(0);
    expect(getBenchmark(db, benchmark.id)!.benchmark.status).toBe('running');
  });

  it('a benchmark left at judging by a restart is picked up again', async () => {
    const { benchmark } = createBenchmark(db, INPUT);
    await runArms(benchmark.id);
    // the in-flight guard lives in memory: a crash mid-judge leaves only the row behind
    db.prepare("UPDATE benchmarks SET status = 'judging' WHERE id = ?").run(benchmark.id);
    const done = await checkBenchmarks(db, async () => judgeJson(S(6, 6, 6, 6), S(8, 8, 8, 8)));
    expect(done).toEqual([benchmark.id]);
    expect(getBenchmark(db, benchmark.id)!.benchmark.status).toBe('judged');
  });

  it('anonymises arms, ranks from the scores, stores results, closes arms and feeds the matrix', async () => {
    const { benchmark } = createBenchmark(db, INPUT);
    await runArms(benchmark.id);
    const seen: { prompt: string; model: string }[] = [];
    const done = await checkBenchmarks(db, async (prompt, model) => {
      seen.push({ prompt, model });
      return judgeJson(S(6, 6, 6, 6, 'ok'), S(8, 9, 8, 9, 'clean'));
    });
    expect(done).toEqual([benchmark.id]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe('opus');
    expect(seen[0]!.prompt).toContain('## Arm A');
    expect(seen[0]!.prompt).toContain('## Arm B');
    expect(seen[0]!.prompt).not.toMatch(/qwen/);

    const d = getBenchmark(db, benchmark.id)!;
    expect(d.benchmark).toMatchObject({ status: 'judged', winner: 'local:qwen3-coder-next', summary: 'B is cleaner.' });
    const byModel = Object.fromEntries(d.arms.map((a) => [a.model, a]));
    expect(byModel['local:qwen3-coder-next']).toMatchObject({ judge_rank: 1, judge_score: 8.5, verify_outcome: 'pass', notes: 'clean' });
    expect(byModel['local:qwen38-flash']).toMatchObject({ judge_rank: 2, judge_score: 6 });
    expect(d.arms.every((a) => a.task_status === 'closed')).toBe(true);

    const matrix = benchmarkMatrix(db);
    expect(matrix).toHaveLength(2);
    expect(matrix[0]).toMatchObject({ model: 'local:qwen3-coder-next', domain: 'cuda', n: 1, avg_score: 8.5, win_rate: 1, verify_pass_rate: 1 });
    expect(matrix[1]).toMatchObject({ model: 'local:qwen38-flash', win_rate: 0 });
  });

  it('records a failed verification and breaks a score tie in favour of the passing arm', async () => {
    const { benchmark } = createBenchmark(db, INPUT);
    await runArms(benchmark.id, 'local:qwen38-flash');
    await checkBenchmarks(db, async (prompt) => {
      expect(prompt).toMatch(/Verification: FAILED/);
      return judgeJson(S(7, 7, 7, 7), S(7, 7, 7, 7));
    });
    const byModel = Object.fromEntries(getBenchmark(db, benchmark.id)!.arms.map((a) => [a.model, a]));
    expect(byModel['local:qwen38-flash']).toMatchObject({ verify_outcome: 'fail', judge_rank: 2 });
    expect(byModel['local:qwen3-coder-next']).toMatchObject({ verify_outcome: 'pass', judge_rank: 1 });
  });

  it('malformed judge output -> judge_failed, and a retry succeeds', async () => {
    const { benchmark } = createBenchmark(db, INPUT);
    await runArms(benchmark.id);
    await checkBenchmarks(db, async () => 'I think B is better');
    expect(getBenchmark(db, benchmark.id)!.benchmark).toMatchObject({ status: 'judge_failed' });
    expect(getBenchmark(db, benchmark.id)!.benchmark.error).toMatch(/unparseable/);
    expect(await checkBenchmarks(db, async () => judgeJson(S(1, 1, 1, 1), S(2, 2, 2, 2)))).toEqual([]); // only 'running' auto-judges

    await judgeBenchmark(db, benchmark.id, async () => '```json\n' + judgeJson(S(9, 9, 9, 9), S(2, 2, 2, 2)) + '\n```');
    expect(getBenchmark(db, benchmark.id)!.benchmark).toMatchObject({ status: 'judged', winner: 'local:qwen38-flash' });
  });

  it('over the usage hard limit the judge is never called', async () => {
    const { benchmark } = createBenchmark(db, INPUT);
    await runArms(benchmark.id);
    setCachedUsage(99, 99);
    let called = false;
    await checkBenchmarks(db, async () => {
      called = true;
      return '';
    });
    expect(called).toBe(false);
    expect(getBenchmark(db, benchmark.id)!.benchmark.error).toMatch(/hard limit/);
  });
});

describe('parseBenchJudgement', () => {
  const ev = (model: string, verify_outcome: ArmEvidence['verify_outcome'] = 'pass'): ArmEvidence => ({
    model, verify_outcome, failure: null, diff_stat: '', diff: '', tokens_out: 10, duration_s: 1,
  });

  it('requires every arm and every criterion; clamps scores to 0-10', () => {
    expect(parseBenchJudgement(JSON.stringify({ arms: [{ arm: 'A', ...S(1, 1, 1, 1) }] }), [ev('x'), ev('y')])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/missing Arm B/),
    });
    const r = parseBenchJudgement(judgeJson(S(15, 10, 10, 10), { scores: { correctness: 5 } }), [ev('x'), ev('y')]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Arm B: missing\/invalid score 'completeness'/) });
    const ok = parseBenchJudgement(judgeJson(S(15, 10, 10, 10), S(0, 0, 0, 0)), [ev('x'), ev('y')]);
    expect(ok.ok && ok.arms[0]!.scores.correctness).toBe(10);
    expect(ok.ok && ok.winner).toBe('x');
  });
});
