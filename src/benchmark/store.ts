import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getSetting, logEvent } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
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
  status: 'running' | 'judging' | 'judged' | 'judge_failed' | 'cancelled';
  winner: string | null;
  summary: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  judged_at: string | null;
  /** where the question came from (task | draft | manual | builtin) and its id/key */
  source_kind: string | null;
  source_ref: string | null;
  /** CSV of judge models; judge_model stays the first one for older readers */
  judge_models: string | null;
  /** local model that was serving when the benchmark started — switched back to once judged */
  restore_model: string | null;
  /** unanimous | split | single, once judged */
  consensus: string | null;
}

export interface BenchmarkJudgement {
  benchmark_id: string;
  judge_model: string;
  result_json: string | null;
  summary: string | null;
  winner: string | null;
  error: string | null;
  created_at: string;
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

export type BenchmarkArmView = BenchmarkArm & { task_status: string | null; task_title: string | null; model_label?: string | null };

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
  /** several judges: each scores independently, arms carry the mean (multi-judge) */
  judge_models?: string[];
  priority?: number;
  source_kind?: 'task' | 'draft' | 'manual' | 'builtin';
  source_ref?: string | null;
  /** dev/test only: 'mock' runs every arm on the zero-token mock adapter. */
  coding_tool?: 'claude-code' | 'mock';
  /** 驗收指標 / 保護路徑 from the PRD: every arm is held to the same engine-checked bar */
  acceptance_metrics?: string | null;
  protected_paths?: string | null;
}

/** Human name for a model id: local display name, else the alias itself. */
export function modelLabel(db: Database.Database, model: string | null): string | null {
  if (!model) return null;
  if (isLocalModel(model)) return getLocalModel(db, localId(model))?.display_name ?? model;
  return model;
}

export function judgeList(b: Pick<Benchmark, 'judge_model' | 'judge_models'>): string[] {
  const list = (b.judge_models ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [b.judge_model];
}

export class BenchmarkInputError extends Error {}

/** A benchmark that still owns the GPU / the queue: at most one may exist at a time. */
export function activeBenchmark(db: Database.Database): Benchmark | null {
  return (db.prepare("SELECT * FROM benchmarks WHERE status IN ('running','judging') ORDER BY created_at DESC LIMIT 1").get() as Benchmark | undefined) ?? null;
}

/** The gate speaks in column names; the benchmark page is Chinese, so translate on the way out. */
const GATE_FIELD: Record<string, string> = {
  plan_ref: '計畫檔（.md/.html 或網址）',
  repo_path: 'repo 路徑（要是已存在的 git repo）',
  base_branch: 'base 分支',
  verification_steps: '驗證指令（至少一行）',
  verify_rubric: '驗收標準',
  goal: '目標',
  environment: '部署環境',
};
export function gateReason(missing: string[]): string {
  const seen = new Set<string>();
  for (const m of missing) {
    const field = String(m).split(/[ (]/)[0]!;
    seen.add(GATE_FIELD[field] ?? field);
  }
  return `題目還缺：${[...seen].join('、')}`;
}

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
  if (!title || !goal) throw new BenchmarkInputError('題目要有標題和目標');

  // Two benchmarks at once means two sets of arms fighting over one GPU, only one of them
  // visible in the dock, and the second one recording the first one's arm as "the operator's
  // model" to switch back to. Refuse instead.
  const busy = activeBenchmark(db);
  if (busy) throw new BenchmarkInputError(`已經有一個評比在跑：「${busy.title}」。等它跑完，或先在評比頁按「取消評比」。`);

  const models = [...new Set((input.models ?? []).map((m) => String(m).trim()).filter(Boolean))];
  if (models.length < 2) throw new BenchmarkInputError('評比至少要 2 個不同的參賽模型');
  for (const m of models) {
    if (!isModelValue(m) || m === 'default') throw new BenchmarkInputError(`不能用這個模型：${m}`);
    if (isLocalModel(m)) {
      const lm = getLocalModel(db, localId(m));
      if (!lm) throw new BenchmarkInputError(`找不到這個本地模型：${m}`);
      if (!lm.enabled) throw new BenchmarkInputError(`本地模型 ${m} 已停用，不能參賽`);
    }
  }

  const domain = (input.domain ?? 'other').trim().toLowerCase();
  if (!(BENCH_DOMAINS as readonly string[]).includes(domain)) {
    throw new BenchmarkInputError(`領域只能是：${BENCH_DOMAINS.join('、')}`);
  }
  const steps = (input.verification_steps ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (steps.length === 0) {
    throw new BenchmarkInputError('題目還缺：驗證指令（至少一行）——每一組都要用同一個真的檢查來比');
  }
  const judges = [...new Set((input.judge_models?.length ? input.judge_models : [input.judge_model || getSetting(db, 'bench_judge_model') || 'opus']).map((j) => String(j).trim()).filter(Boolean))];
  for (const j of judges) {
    if (!BENCH_JUDGE_MODELS.has(j)) throw new BenchmarkInputError(`評審只能選：${[...BENCH_JUDGE_MODELS].join('、')}（收到 ${j}）`);
  }
  const judgeModel = judges[0]!;

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
  if (!gate.ok) {
    // the raw field names go to the log, not to the operator's screen
    logEvent(db, { kind: 'note', detail: `benchmark rejected: ${gate.missing.join('; ')}` });
    throw new BenchmarkInputError(gateReason(gate.missing));
  }

  const id = `b_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO benchmarks (id, title, goal, plan_ref, repo_path, base_branch, verification_steps, setup_cmd,
       verify_rubric, domain, complexity, judge_model, judge_models, source_kind, source_ref, restore_model)
     VALUES (@id, @title, @goal, @plan_ref, @repo_path, @base_branch, @verification_steps, @setup_cmd,
       @verify_rubric, @domain, @complexity, @judge_model, @judge_models, @source_kind, @source_ref, @restore_model)`,
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
    judge_models: judges.join(','),
    source_kind: input.source_kind ?? 'manual',
    source_ref: input.source_ref ?? null,
    // the model serving right now — the judge step switches back to it when the arms are done
    restore_model: models.some(isLocalModel) && getSetting(db, 'local_model_status') === 'ready' ? (getSetting(db, 'local_model_loaded') || null) : null,
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
      acceptance_metrics: input.acceptance_metrics ?? null,
      protected_paths: input.protected_paths ?? null,
    });
    insertArm.run(id, model, task.id);
    setStatus(db, task.id, 'queued', { detail: `benchmark ${id} arm (${model})` });
  }
  logEvent(db, { kind: 'note', detail: `benchmark ${id} created: ${title} [${models.join(', ')}] domain=${domain}` });
  const created = getBenchmark(db, id)!;
  return { benchmark: created.benchmark, arms: created.arms };
}

/**
 * Stop a benchmark the operator no longer wants: every arm that has not finished is failed
 * (the caller kills the live process first), the row goes to 'cancelled' and the GPU is free
 * for the next one. Judged/failed benchmarks are left alone — there is nothing to stop.
 */
export function cancelBenchmark(
  db: Database.Database,
  id: string,
  reason = '使用者取消',
  deps: { onArmTask?: (task: Task) => void } = {},
): Benchmark | null {
  const detail = getBenchmark(db, id);
  if (!detail) return null;
  const { benchmark } = detail;
  if (benchmark.status === 'judged' || benchmark.status === 'cancelled') return benchmark;
  const TERMINAL = new Set(['review', 'attention', 'failed', 'closed']);
  for (const arm of detail.arms) {
    const t = getTask(db, arm.task_id);
    if (!t || TERMINAL.has(t.status)) continue;
    deps.onArmTask?.(t);
    setStatus(db, t.id, 'failed', { detail: `benchmark ${id} cancelled: ${reason}` });
  }
  db.prepare("UPDATE benchmarks SET status = 'cancelled', error = ? WHERE id = ?").run(reason, id);
  logEvent(db, { kind: 'note', detail: `benchmark ${id} cancelled: ${reason}` });
  return getBenchmark(db, id)!.benchmark;
}

/** Drop a finished benchmark's rows. The arm tasks stay on the board; only the comparison goes. */
export function deleteBenchmark(db: Database.Database, id: string): boolean {
  const row = db.prepare('SELECT status FROM benchmarks WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) return false;
  if (row.status === 'running' || row.status === 'judging') throw new BenchmarkInputError('評比還在進行，請先按「取消評比」。');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM benchmark_judgements WHERE benchmark_id = ?').run(id);
    db.prepare('DELETE FROM benchmark_arms WHERE benchmark_id = ?').run(id);
    db.prepare('DELETE FROM benchmarks WHERE id = ?').run(id);
  });
  tx();
  logEvent(db, { kind: 'note', detail: `benchmark ${id} deleted` });
  return true;
}

export function getBenchmark(
  db: Database.Database,
  id: string,
): { benchmark: Benchmark; arms: BenchmarkArmView[]; judgements: BenchmarkJudgement[] } | null {
  const benchmark = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(id) as Benchmark | undefined;
  if (!benchmark) return null;
  const arms = db
    .prepare(
      `SELECT a.*, t.status AS task_status, t.title AS task_title
         FROM benchmark_arms a LEFT JOIN tasks t ON t.id = a.task_id
        WHERE a.benchmark_id = ? ORDER BY a.rowid`,
    )
    .all(id) as BenchmarkArmView[];
  for (const a of arms) a.model_label = modelLabel(db, a.model);
  const judgements = db.prepare('SELECT * FROM benchmark_judgements WHERE benchmark_id = ? ORDER BY rowid').all(id) as BenchmarkJudgement[];
  return { benchmark, arms, judgements };
}

export interface BenchmarkListRow extends Benchmark {
  arm_count: number;
  arms_done: number;
  winner_label: string | null;
  judges: string[];
  models: string[];
}

export function listBenchmarks(db: Database.Database, limit = 50): BenchmarkListRow[] {
  const rows = db
    .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM benchmark_arms a WHERE a.benchmark_id = b.id) AS arm_count,
              (SELECT COUNT(*) FROM benchmark_arms a LEFT JOIN tasks t ON t.id = a.task_id
                WHERE a.benchmark_id = b.id AND (t.id IS NULL OR t.status IN ('review','attention','failed','closed'))) AS arms_done,
              (SELECT GROUP_CONCAT(a.model, ',') FROM benchmark_arms a WHERE a.benchmark_id = b.id) AS models_csv
         FROM benchmarks b ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?`,
    )
    .all(limit) as (Benchmark & { arm_count: number; arms_done: number; models_csv: string | null })[];
  return rows.map(({ models_csv, ...b }) => ({
    ...b,
    winner_label: modelLabel(db, b.winner),
    judges: judgeList(b),
    models: (models_csv ?? '').split(',').filter(Boolean),
  }));
}

export interface ModelRecord {
  model: string;
  label: string;
  n: number;
  wins: number;
  avg_score: number | null;
  verify_pass_rate: number;
}

/** What the dock shows: the running one, the last few, and each model's record across judged benchmarks. */
export function benchmarkSummary(db: Database.Database): { running: BenchmarkListRow | null; recent: BenchmarkListRow[]; models: ModelRecord[] } {
  const all = listBenchmarks(db, 200);
  const running = all.find((b) => b.status === 'running' || b.status === 'judging') ?? null;
  const rows = db
    .prepare(
      `SELECT a.model AS model, COUNT(*) AS n,
              SUM(CASE WHEN a.judge_rank = 1 THEN 1 ELSE 0 END) AS wins,
              AVG(a.judge_score) AS avg_score,
              AVG(CASE WHEN a.verify_outcome = 'pass' THEN 1.0 ELSE 0.0 END) AS verify_pass_rate
         FROM benchmark_arms a JOIN benchmarks b ON b.id = a.benchmark_id
        WHERE b.status = 'judged' GROUP BY a.model ORDER BY wins DESC, avg_score DESC`,
    )
    .all() as Array<{ model: string; n: number; wins: number; avg_score: number | null; verify_pass_rate: number }>;
  return {
    running,
    recent: all.slice(0, 8),
    models: rows.map((r) => ({
      model: r.model,
      label: modelLabel(db, r.model) ?? r.model,
      n: r.n,
      wins: r.wins,
      avg_score: r.avg_score == null ? null : Math.round(r.avg_score * 10) / 10,
      verify_pass_rate: Math.round(r.verify_pass_rate * 100) / 100,
    })),
  };
}

export interface MatrixRow {
  model: string;
  model_label?: string | null;
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
    model_label: modelLabel(db, r.model),
    avg_score: r1(r.avg_score),
    win_rate: r2(r.win_rate),
    verify_pass_rate: r2(r.verify_pass_rate),
    avg_tokens_out: r.avg_tokens_out == null ? null : Math.round(r.avg_tokens_out),
    avg_duration_s: r.avg_duration_s == null ? null : Math.round(r.avg_duration_s),
  }));
}
