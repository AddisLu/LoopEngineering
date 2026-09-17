import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getSetting, logEvent } from '../db/index.js';
import { createTask, setStatus } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { isModelValue, BENCH_JUDGE_MODELS } from '../settings.js';
import { getLocalModel, isLocalModel, localId } from '../local/models.js';
import type { Complexity } from '../config.js';
import type { Task } from '../types.js';

/**
 * Benchmark mode: the same task handed to N models ("arms"). Each arm is an ordinary task
 * (tasks.benchmark_id) so it goes through the normal tick -> runTask -> verify path — local arms
 * get the model-affinity scheduling for free — but never integrates. complete.ts judges a
 * benchmark once every arm is terminal; judged arms feed benchmarkMatrix (model x domain).
 */

export const BENCH_DOMAINS = ['cuda', 'cv', 'cpp', 'csharp', 'typescript', 'python', 'other'] as const;

export interface Benchmark {
  id: string;
  title: string;
  goal: string;
  plan_ref: string | null;
  repo_path: string | null;
  base_branch: string | null;
  verification_steps: string;
  setup_cmd: string | null;
  verify_rubric: string | null;
  domain: string;
  complexity: Complexity;
  judge_model: string;
  status: 'running' | 'judging' | 'judged' | 'judge_failed';
  winner: string | null;
  summary: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  judged_at: string | null;
}

export interface BenchmarkArm {
  benchmark_id: string;
  model: string;
  task_id: string;
  verify_outcome: 'pass' | 'manual' | 'fail' | null;
  judge_score: number | null;
  judge_rank: number | null;
  scores_json: string | null;
  notes: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_s: number | null;
  diff_stat: string | null;
}

export type BenchmarkArmView = BenchmarkArm & { task_status: string | null; task_title: string | null };

export interface NewBenchmarkInput {
  title: string;
  goal: string;
  plan_ref?: string | null;
  repo_path?: string | null;
  base_branch?: string | null;
  verification_steps: string[];
  setup_cmd?: string | null;
  verify_rubric?: string | null;
  domain?: string;
  complexity?: Complexity;
  models: string[];
  judge_model?: string;
  priority?: number;
  /** dev/test only: 'mock' runs every arm on the zero-token mock adapter. */
  coding_tool?: 'claude-code' | 'mock';
}

export class BenchmarkInputError extends Error {}

function planKind(ref: string | null): 'md' | 'html' | 'url' | null {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return 'url';
  return /\.html?$/i.test(ref) ? 'html' : 'md';
}

export function createBenchmark(
  db: Database.Database,
  input: NewBenchmarkInput,
): { benchmark: Benchmark; arms: BenchmarkArmView[] } {
  const title = input.title?.trim();
  const goal = input.goal?.trim();
  if (!title || !goal) throw new BenchmarkInputError('title and goal are required');

  const models = [...new Set((input.models ?? []).map((m) => String(m).trim()).filter(Boolean))];
  if (models.length < 2) throw new BenchmarkInputError('a benchmark needs at least 2 distinct models');
  for (const m of models) {
    if (!isModelValue(m) || m === 'default') throw new BenchmarkInputError(`invalid model: ${m}`);
    if (isLocalModel(m)) {
      const lm = getLocalModel(db, localId(m));
      if (!lm) throw new BenchmarkInputError(`unknown local model: ${m}`);
      if (!lm.enabled) throw new BenchmarkInputError(`local model ${m} is disabled`);
    }
  }

  const domain = (input.domain ?? 'other').trim().toLowerCase();
  if (!(BENCH_DOMAINS as readonly string[]).includes(domain)) {
    throw new BenchmarkInputError(`domain must be one of: ${BENCH_DOMAINS.join(', ')}`);
  }
  const steps = (input.verification_steps ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (steps.length === 0) {
    throw new BenchmarkInputError('at least one verification step is required — arms are compared against a real check');
  }
  const judgeModel = (input.judge_model || getSetting(db, 'bench_judge_model') || 'opus').trim();
  if (!BENCH_JUDGE_MODELS.has(judgeModel)) {
    throw new BenchmarkInputError(`judge_model must be one of: ${[...BENCH_JUDGE_MODELS].join(', ')}`);
  }

  const codingTool = input.coding_tool ?? 'claude-code';
  const planRef = input.plan_ref?.trim() || null;
  const repoPath = input.repo_path?.trim() || null;
  const baseBranch = input.base_branch?.trim() || null;
  const complexity: Complexity = input.complexity ?? 'M';

  // Gate the shared task definition ONCE before creating anything, so a bad repo/plan never
  // leaves half a benchmark behind.
  const probe = {
    goal,
    plan_ref: planRef,
    coding_tool: codingTool,
    verification_steps: JSON.stringify(steps),
    verify_mode: 'command',
    verify_rubric: input.verify_rubric ?? null,
    repo_path: repoPath,
    base_branch: baseBranch,
    setup_cmd: input.setup_cmd ?? null,
    environment: null,
    requires: null,
  } as unknown as Task;
  const gate = validateTask(probe, getSetting(db, 'host_capabilities') ?? '');
  if (!gate.ok) throw new BenchmarkInputError(`gate not satisfied: ${gate.missing.join('; ')}`);

  const id = `b_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO benchmarks (id, title, goal, plan_ref, repo_path, base_branch, verification_steps, setup_cmd,
       verify_rubric, domain, complexity, judge_model)
     VALUES (@id, @title, @goal, @plan_ref, @repo_path, @base_branch, @verification_steps, @setup_cmd,
       @verify_rubric, @domain, @complexity, @judge_model)`,
  ).run({
    id,
    title,
    goal,
    plan_ref: planRef,
    repo_path: repoPath,
    base_branch: baseBranch,
    verification_steps: JSON.stringify(steps),
    setup_cmd: input.setup_cmd ?? null,
    verify_rubric: input.verify_rubric ?? null,
    domain,
    complexity,
    judge_model: judgeModel,
  });

  const insertArm = db.prepare('INSERT INTO benchmark_arms (benchmark_id, model, task_id) VALUES (?, ?, ?)');
  for (const model of models) {
    const task = createTask(db, {
      title: `[bench] ${title} · ${model}`,
      goal,
      plan_ref: planRef,
      plan_kind: planKind(planRef),
      coding_tool: codingTool,
      verification_steps: steps,
      setup_cmd: input.setup_cmd ?? null,
      repo_path: repoPath,
      base_branch: baseBranch,
      complexity,
      priority: input.priority ?? 2,
      model,
      verify_mode: 'command',
      verify_rubric: input.verify_rubric ?? null,
      experiment: `bench:${id}`,
      benchmark_id: id,
    });
    insertArm.run(id, model, task.id);
    setStatus(db, task.id, 'queued', { detail: `benchmark ${id} arm (${model})` });
  }
  logEvent(db, { kind: 'note', detail: `benchmark ${id} created: ${title} [${models.join(', ')}] domain=${domain}` });
  const created = getBenchmark(db, id)!;
  return { benchmark: created.benchmark, arms: created.arms };
}

export function getBenchmark(
  db: Database.Database,
  id: string,
): { benchmark: Benchmark; arms: BenchmarkArmView[] } | null {
  const benchmark = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(id) as Benchmark | undefined;
  if (!benchmark) return null;
  const arms = db
    .prepare(
      `SELECT a.*, t.status AS task_status, t.title AS task_title
         FROM benchmark_arms a LEFT JOIN tasks t ON t.id = a.task_id
        WHERE a.benchmark_id = ? ORDER BY a.rowid`,
    )
    .all(id) as BenchmarkArmView[];
  return { benchmark, arms };
}

export function listBenchmarks(
  db: Database.Database,
  limit = 50,
): (Benchmark & { arm_count: number; arms_done: number })[] {
  return db
    .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM benchmark_arms a WHERE a.benchmark_id = b.id) AS arm_count,
              (SELECT COUNT(*) FROM benchmark_arms a JOIN tasks t ON t.id = a.task_id
                WHERE a.benchmark_id = b.id AND t.status IN ('review','attention','failed','closed')) AS arms_done
         FROM benchmarks b ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?`,
    )
    .all(limit) as (Benchmark & { arm_count: number; arms_done: number })[];
}

export interface MatrixRow {
  model: string;
  domain: string;
  n: number;
  avg_score: number | null;
  win_rate: number;
  verify_pass_rate: number;
  avg_tokens_out: number | null;
  avg_duration_s: number | null;
}

/** Judged arms aggregated per (model, domain): the "which local model writes which code well" view. */
export function benchmarkMatrix(db: Database.Database): MatrixRow[] {
  const rows = db
    .prepare(
      `SELECT a.model AS model, b.domain AS domain, COUNT(*) AS n,
              AVG(a.judge_score) AS avg_score,
              AVG(CASE WHEN a.judge_rank = 1 THEN 1.0 ELSE 0.0 END) AS win_rate,
              AVG(CASE WHEN a.verify_outcome = 'pass' THEN 1.0 ELSE 0.0 END) AS verify_pass_rate,
              AVG(a.tokens_out) AS avg_tokens_out,
              AVG(a.duration_s) AS avg_duration_s
         FROM benchmark_arms a JOIN benchmarks b ON b.id = a.benchmark_id
        WHERE b.status = 'judged'
        GROUP BY a.model, b.domain
        ORDER BY b.domain, avg_score DESC`,
    )
    .all() as MatrixRow[];
  const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return rows.map((r) => ({
    ...r,
    avg_score: r1(r.avg_score),
    win_rate: r2(r.win_rate),
    verify_pass_rate: r2(r.verify_pass_rate),
    avg_tokens_out: r.avg_tokens_out == null ? null : Math.round(r.avg_tokens_out),
    avg_duration_s: r.avg_duration_s == null ? null : Math.round(r.avg_duration_s),
  }));
}
