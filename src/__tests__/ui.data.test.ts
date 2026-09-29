import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { logEvent, openTestDb, setSetting } from '../db/index.js';
import { createRun, createTask, getTask, setStatus, updateRun } from '../tasks.js';
import { setCachedUsage } from '../token/usage.js';
import { stagesFor, taskHistory, failedStage } from '../orchestrator/history.js';
import { runVerification } from '../orchestrator/verify.js';
import { armIterations, measureBaseline } from '../benchmark/attempts.js';
import { benchmarkHeadToHead, benchmarkRecommendations, createBenchmark, getBenchmark } from '../benchmark/store.js';
import { judgeBenchmark } from '../benchmark/complete.js';
import { boardState, tailLog } from '../server/board.js';
import { buildApp } from '../server/app.js';

/**
 * The data the 總覽 / 工作流程 / 評比 pages draw: where each lifecycle stage of a task stands, its
 * attempts with time and tokens, a benchmark's baseline, model-vs-model standings, and the board's
 * grouping fields. Hermetic: in-memory DB, temp git repos, host-shell steps.
 */

let db: Database.Database;
let app: FastifyInstance | undefined;
let tmp: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const mk = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-ui-${tag}-`));
  tmp.push(d);
  return d;
};

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  app = undefined;
  tmp = [];
});
afterEach(async () => {
  await app?.close();
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const base = { merge_status: null, verify_mode: 'command', approved_at: null, setup_cmd: null, coding_tool: 'claude-code' } as const;

describe('where each stage of a task stands (the 工作流程 canvas)', () => {
  it('walks the lifecycle: queued, setting up, implementing, verifying', () => {
    expect(stagesFor({ ...base, status: 'draft' }, null, false).stages.trigger).toBe('warn');
    expect(stagesFor({ ...base, status: 'queued' }, null, false)).toMatchObject({ focus: 'trigger', stages: { trigger: 'warn', setup: 'idle' } });
    expect(stagesFor({ ...base, status: 'queued' }, null, true)).toMatchObject({ focus: 'setup', stages: { trigger: 'ok', setup: 'active' } });
    expect(stagesFor({ ...base, status: 'running' }, null, true)).toMatchObject({ focus: 'implement', stages: { setup: 'ok', implement: 'active', verify: 'idle' } });
    expect(stagesFor({ ...base, status: 'verifying' }, null, true)).toMatchObject({ focus: 'verify', stages: { implement: 'ok', verify: 'active' } });
  });

  it('a gate that sends the work back lights the fail edge; a pause only holds the implementation', () => {
    const back = stagesFor({ ...base, status: 'blocked' }, 'verify failed (resumable 1/2) at: 驗收指標', false);
    expect(back).toMatchObject({ focus: 'gate', stages: { verify: 'ok', gate: 'fail', implement: 'warn' } });
    const paused = stagesFor({ ...base, status: 'blocked' }, 'interrupted: breaker', false);
    expect(paused).toMatchObject({ focus: 'implement', stages: { implement: 'warn', gate: 'idle' } });
  });

  it('points a stop at the stage that caused it', () => {
    expect(failedStage('setup_cmd failed (exit=2): make: no rule')).toBe('setup');
    expect(failedStage('verify failed at: 驗收指標')).toBe('gate');
    expect(failedStage('watchdog timeout')).toBe('implement');
    expect(stagesFor({ ...base, status: 'attention' }, 'setup_cmd failed (exit=1): x', false)).toMatchObject({ focus: 'setup', stages: { setup: 'fail', implement: 'idle' } });
    expect(stagesFor({ ...base, status: 'failed' }, 'aborted by user', false)).toMatchObject({ focus: 'implement', stages: { implement: 'fail' } });
  });

  it('after verification: 人工核可 waits for a person, 合併 shows merged / pending / conflict, 結案 closes it', () => {
    const manual = stagesFor({ ...base, status: 'review', verify_mode: 'command,manual', merge_status: 'pending' }, null, false);
    expect(manual).toMatchObject({ focus: 'approve', stages: { gate: 'ok', approve: 'active', merge: 'warn' } });
    const merged = stagesFor({ ...base, status: 'review', merge_status: 'merged' }, null, false);
    expect(merged).toMatchObject({ focus: 'done', stages: { approve: 'skip', merge: 'ok', done: 'warn' } });
    expect(stagesFor({ ...base, status: 'review', merge_status: 'conflict' }, null, false)).toMatchObject({ focus: 'merge', stages: { merge: 'fail' } });
    expect(stagesFor({ ...base, status: 'closed', merge_status: 'merged' }, null, false).stages).toMatchObject({ merge: 'ok', done: 'ok', approve: 'skip' });
    expect(stagesFor({ ...base, status: 'review', coding_tool: 'generic' }, null, false).stages.merge).toBe('skip');
  });

  it('GET /api/tasks/:id/runs: every attempt with time, tokens and steps, the events, and the stages', async () => {
    const t = createTask(db, { title: 'k', goal: 'make it fast', plan_ref: 'https://example.com/p.md', verification_steps: ['bash bench.sh'], complexity: 'S' });
    const r1 = createRun(db, { task_id: t.id, worktree_path: '/tmp/x' });
    db.prepare('UPDATE task_runs SET started_at = ?, finished_at = ?, tokens_in = 1000, tokens_out = 200 WHERE id = ?').run('2026-09-29 10:00:00', '2026-09-29T10:22:10.000Z', r1.id);
    updateRun(db, r1.id, {
      verify_json: JSON.stringify([{ step: 'bash bench.sh', ok: true, exitCode: 0, timedOut: false, tail: '', ms: 13000 }]),
      metrics_json: JSON.stringify({ values: { max_ms: 28 }, checks: [{ name: 'max_ms', op: '<=', target: 10, actual: 28, pass: false }], pass: false }),
    });
    logEvent(db, { task_id: t.id, run_id: r1.id, kind: 'note', detail: '沙盒：ncu --metrics gpu__time_duration.sum ./k → exit 0 · 4 s' });
    setStatus(db, t.id, 'blocked', { run_id: r1.id, detail: 'verify failed (resumable 1/2) at: 驗收指標' });

    const h = taskHistory(db, t.id)!;
    expect(h.stages.gate).toBe('fail');
    expect(h.retry).toEqual({ used: 0, max: 2 });
    expect(h.last_detail).toContain('verify failed');
    const a = h.iterations.attempts[0]!;
    expect(a).toMatchObject({ outcome: 'metrics', duration_s: 1330, tokens_in: 1000, tokens_out: 200, self_runs: 1, profiler: true });
    expect(a.steps[0]).toMatchObject({ step: 'bash bench.sh', ms: 13000 });
    expect(h.events.map((e) => e.kind)).toContain('note');

    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${t.id}/runs` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ task: { id: t.id, status: 'blocked' }, focus: 'gate' });
    expect((await app.inject({ method: 'GET', url: '/api/tasks/t_nope/runs' })).statusCode).toBe(404);
  });

  it('verification keeps how long each step took', async () => {
    const dir = mk('verify');
    const t = createTask(db, { title: 'v', goal: 'g', plan_ref: 'https://example.com/p.md', verification_steps: ['true', 'sleep 0.05'], complexity: 'S' });
    const res = await runVerification(getTask(db, t.id)!, dir);
    expect(res.ok).toBe(true);
    expect(res.results.every((r) => typeof r.ms === 'number')).toBe(true);
    expect(res.results[1]!.ms!).toBeGreaterThanOrEqual(40);
  });
});

describe('a benchmark baseline: the code the arms started from, measured the same way', () => {
  /** a repo whose `bash bench.sh` reports the ms kept in ms.txt (20 ms at the base commit) */
  function benchRepo(): { repo: string; sha: string } {
    const repo = mk('repo');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'bench.sh'), 'echo "LOOP_METRICS {\\"correct\\":1,\\"max_ms\\":$(cat ms.txt)}"\n');
    fs.writeFileSync(path.join(repo, 'ms.txt'), '20\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const sha = git(repo, 'rev-parse', 'HEAD').trim();
    // the base moves on after the arms started: the baseline must still measure where they began
    fs.writeFileSync(path.join(repo, 'ms.txt'), '15\n');
    git(repo, 'commit', '-qam', 'later');
    return { repo, sha };
  }

  function benchmarkWithArms(repo: string, sha: string | null) {
    setSetting(db, 'benchmark_enabled', 'true');
    const { benchmark } = createBenchmark(db, {
      title: 'kernel budget',
      goal: 'max_ms <= 10',
      plan_ref: 'https://example.com/p.md',
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['bash bench.sh'],
      acceptance_metrics: 'correct == 1; max_ms <= 10',
      domain: 'cuda',
      models: ['local:qwen38-flash', 'sonnet'],
      coding_tool: 'mock',
    });
    const arms = getBenchmark(db, benchmark.id)!.arms;
    for (const a of arms) {
      const run = createRun(db, { task_id: a.task_id, worktree_path: '/definitely/gone' });
      if (sha) db.prepare('UPDATE task_runs SET base_sha = ? WHERE id = ?').run(sha, run.id);
      setStatus(db, a.task_id, 'attention', { detail: 'verify failed at: 驗收指標' });
    }
    return { benchmark, arms };
  }

  it('checks out the recorded base on its own, measures it, and removes the checkout', async () => {
    const { repo, sha } = benchRepo();
    const { arms } = benchmarkWithArms(repo, sha);
    const b = await measureBaseline(db, arms.map((a) => a.task_id));
    expect(b).toMatchObject({ base_sha: sha, outcome: 'metrics', metrics: { max_ms: 20 } });
    expect(b!.checks!.find((c) => c.name === 'max_ms')).toMatchObject({ actual: 20, pass: false });
    // the throwaway checkout is gone again
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('no recorded base, no baseline', async () => {
    const { repo } = benchRepo();
    const { arms } = benchmarkWithArms(repo, null);
    expect(await measureBaseline(db, arms.map((a) => a.task_id))).toBeNull();
  });

  it('judging a measured benchmark keeps its baseline; the route re-measures one on demand', async () => {
    const { repo, sha } = benchRepo();
    const { benchmark } = benchmarkWithArms(repo, sha);
    const judge = async () =>
      JSON.stringify({
        arms: ['A', 'B'].map((arm) => ({ arm, scores: { correctness: 5, completeness: 5, code_quality: 5, adherence: 5 }, notes: '' })),
        winner: 'A',
        summary: 's',
      });
    await judgeBenchmark(db, benchmark.id, judge);
    const judged = getBenchmark(db, benchmark.id)!.benchmark;
    expect(JSON.parse(judged.baseline_json!)).toMatchObject({ base_sha: sha, metrics: { max_ms: 20 } });

    app = buildApp({ db, apiToken: null });
    db.prepare('UPDATE benchmarks SET baseline_json = NULL WHERE id = ?').run(benchmark.id);
    const res = await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/baseline` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.json().benchmark.baseline_json)).toMatchObject({ metrics: { max_ms: 20 } });
    db.prepare("UPDATE benchmarks SET status = 'running' WHERE id = ?").run(benchmark.id);
    expect((await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/baseline` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/benchmarks/b_nope/baseline' })).statusCode).toBe(404);
  });
});

describe('standings: model against model, and what the verdict means', () => {
  function judged(id: string, domain: string, ranks: Record<string, number>) {
    db.prepare("INSERT INTO benchmarks (id, title, goal, domain, status) VALUES (?, 't', 'g', ?, 'judged')").run(id, domain);
    for (const [model, rank] of Object.entries(ranks)) {
      db.prepare('INSERT INTO benchmark_arms (benchmark_id, model, task_id, verify_outcome, judge_score, judge_rank) VALUES (?, ?, ?, ?, 5, ?)').run(
        id,
        model,
        `t_${id}_${model}`,
        rank === 1 ? 'pass' : 'fail',
        rank,
      );
    }
  }

  it('counts, per pair, the shared benchmarks and how often the row model ranked higher', () => {
    judged('b1', 'cuda', { sonnet: 1, 'local:qwen38-flash': 2, 'local:qwen3-coder-next': 3 });
    judged('b2', 'cuda', { sonnet: 2, 'local:qwen3-coder-next': 1 });
    judged('b3', 'other', { 'local:qwen38-flash': 1, sonnet: 2 });
    const all = benchmarkHeadToHead(db);
    const pair = (a: string, b: string) => all.pairs.find((p) => p.a === a && p.b === b);
    expect(pair('sonnet', 'local:qwen3-coder-next')).toMatchObject({ n: 2, wins: 1, rate: 0.5 });
    expect(pair('sonnet', 'local:qwen38-flash')).toMatchObject({ n: 2, wins: 1 });
    expect(pair('local:qwen38-flash', 'local:qwen3-coder-next')).toMatchObject({ n: 1, wins: 1, rate: 1 });
    expect(all.models[0]).toMatchObject({ model: 'sonnet', n: 3, local: false });
    const cuda = benchmarkHeadToHead(db, { domain: 'cuda' });
    expect(cuda.pairs.find((p) => p.a === 'local:qwen38-flash' && p.b === 'sonnet')).toMatchObject({ n: 1, wins: 0 });
  });

  it('recommendations carry a kind the page can colour', () => {
    judged('b1', 'cuda', { sonnet: 1, 'local:qwen38-flash': 2 });
    judged('b2', 'other', { 'local:qwen38-flash': 1, sonnet: 2 });
    const rec = benchmarkRecommendations(db);
    expect(rec.find((r) => r.domain === 'cuda')).toMatchObject({ kind: 'cannot' });
    expect(rec.find((r) => r.domain === 'other')).toMatchObject({ kind: 'can' });
  });
});

describe('the board payload the 總覽 groups by', () => {
  it('every card says when it was made, which repo, benchmark or conflicting task it belongs to', () => {
    setSetting(db, 'benchmark_enabled', 'true');
    const repo = mk('board');
    const { benchmark } = createBenchmark(db, {
      title: 'grouped',
      goal: 'g',
      plan_ref: 'https://example.com/p.md',
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['true'],
      domain: 'cuda',
      models: ['sonnet', 'opus'],
      coding_tool: 'mock',
    });
    const parent = createTask(db, { title: 'p', goal: 'g', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], complexity: 'S', repo_path: repo });
    const fix = createTask(db, { title: '[merge] p', goal: 'g', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], complexity: 'S' });
    db.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?').run(parent.id, fix.id);

    const s = boardState(db);
    const arm = s.cards.find((c) => c.benchmark_id === benchmark.id)!;
    expect(arm).toBeTruthy();
    expect(arm.created_at).toBeTruthy();
    expect(s.cards.find((c) => c.id === parent.id)!.repo).toBe(path.basename(repo));
    expect(s.cards.find((c) => c.id === fix.id)!.parent_task_id).toBe(parent.id);
    expect(s.benchmarks).toEqual([expect.objectContaining({ id: benchmark.id, title: 'grouped', status: 'running', domain: 'cuda' })]);
  });

  it('reads only the end of a long run log', () => {
    const dir = mk('log');
    const p = path.join(dir, 'run.log');
    const filler = 'x'.repeat(200) + '\n';
    fs.writeFileSync(p, filler.repeat(2000) + JSON.stringify({ type: 'text', text: 'the last line' }) + '\n');
    expect(tailLog(p, 1)).toEqual(['the last line']);
  });
});

describe('attempts carry their time and tokens (the iteration timeline)', () => {
  it('reads started / finished / tokens off each run', () => {
    const t = createTask(db, { title: 'a', goal: 'g', plan_ref: 'https://example.com/p.md', verification_steps: ['true'], complexity: 'S' });
    const r = createRun(db, { task_id: t.id, worktree_path: '/tmp/x' });
    db.prepare('UPDATE task_runs SET started_at = ?, finished_at = NULL, tokens_out = 42 WHERE id = ?').run('2026-09-29 10:00:00', r.id);
    const a = armIterations(db, t.id).attempts[0]!;
    expect(a).toMatchObject({ started_at: '2026-09-29 10:00:00', finished_at: null, duration_s: null, tokens_out: 42, steps: [] });
  });
});
