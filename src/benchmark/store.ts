import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getSetting, logEvent, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { isModelValue, BENCH_JUDGE_MODELS } from '../settings.js';
import { getLocalModel, isLocalModel, localId } from '../local/models.js';
import { parseAcceptance } from '../orchestrator/acceptance.js';
import { datasetPath, getPlan, planSteps, type VerifyPlan } from '../plans/store.js';
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
  /** 'queued' only for 快篩 rows waiting their turn (no arm yet) */
  status: 'queued' | 'running' | 'judging' | 'judged' | 'judge_failed' | 'cancelled';
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
  /** 驗收指標 every arm is held to (engine-checked, e.g. "correct == 1; max_ms <= 10") */
  acceptance_metrics: string | null;
  /** CSV globs no arm may change (the yardstick) */
  protected_paths: string | null;
  /** CSV globs collected from each arm after verification */
  artifacts: string | null;
  /** the 驗證方案 the verification came from, if any */
  verify_plan_id: string | null;
  verify_timeout_min: number | null;
  timeout_min: number | null;
  /** BaselineMeasurement: the base commit measured with the same verification (null = not measured) */
  baseline_json: string | null;
  /** 'screen' = one row of a 模型快篩 (src/benchmark/screen.ts); null = an ordinary benchmark */
  mode: string | null;
  screen_group: string | null;
  screen_seq: number | null;
  /** 快篩 row: {"model", "coding_tool", "budget_min"} — the arm is created when its turn comes */
  screen_json: string | null;
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
  /** IterationSummary (attempts.ts): what every attempt of the arm's verification found */
  attempts_json: string | null;
  /** FinalMeasurement (attempts.ts): the re-measurement of the arm's final code, taken when judged */
  final_json: string | null;
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
  /** 產出物 globs collected from every arm */
  artifacts?: string | null;
  /**
   * A 驗證方案 to take the verification from: its steps (sandbox-prefixed for its machine), 驗收指標,
   * 保護路徑, 產出物, setup and domain — each unless the input sets it — and its repo when none is given.
   */
  verify_plan_id?: string | null;
  /** the plan's 圖資 to verify against, when its steps take one (default: the plan's default) */
  dataset?: string | null;
  /** per-step verification timeout (minutes) and per-run time limit (minutes) for every arm */
  verify_timeout_min?: number | null;
  timeout_min?: number | null;
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

  // a 驗證方案 supplies the verification every arm shares; whatever the input sets itself wins
  let plan: VerifyPlan | null = null;
  let planStepList: string[] = [];
  if (input.verify_plan_id) {
    plan = getPlan(db, input.verify_plan_id);
    if (!plan) throw new BenchmarkInputError(`找不到驗證方案：${input.verify_plan_id}`);
    try {
      planStepList = planSteps(plan, datasetPath(plan, input.dataset ?? null));
    } catch (err) {
      throw new BenchmarkInputError(`驗證方案「${plan.name}」：${(err as Error).message}`);
    }
  }

  const domain = (input.domain ?? plan?.domain ?? 'other').trim().toLowerCase();
  if (!(BENCH_DOMAINS as readonly string[]).includes(domain)) {
    throw new BenchmarkInputError(`領域只能是：${BENCH_DOMAINS.join('、')}`);
  }
  const typed = (input.verification_steps ?? []).map((s) => String(s).trim()).filter(Boolean);
  const steps = typed.length ? typed : planStepList;
  if (steps.length === 0) {
    throw new BenchmarkInputError('題目還缺：驗證指令（至少一行）——每一組都要用同一個真的檢查來比');
  }
  const csv = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v.join(',') : (v ?? '')).trim() || null;
  const acceptance = csv(input.acceptance_metrics ?? plan?.metrics);
  try {
    parseAcceptance(acceptance);
  } catch (err) {
    throw new BenchmarkInputError(`驗收指標寫法不對：${(err as Error).message}`);
  }
  const protectedPaths = csv(input.protected_paths ?? plan?.protected_paths);
  const artifacts = csv(input.artifacts ?? plan?.artifacts);
  const minutes = (v: number | null | undefined, what: string) => {
    if (v == null) return null;
    if (!Number.isInteger(v) || v < 1 || v > 1440) throw new BenchmarkInputError(`${what}要是 1 到 1440 的整數分鐘`);
    return v;
  };
  const verifyTimeout = minutes(input.verify_timeout_min, '每個驗證步驟的時間上限');
  const runTimeout = minutes(input.timeout_min, '每一組的執行時間上限');
  const judges = [...new Set((input.judge_models?.length ? input.judge_models : [input.judge_model || getSetting(db, 'bench_judge_model') || 'opus']).map((j) => String(j).trim()).filter(Boolean))];
  for (const j of judges) {
    if (!BENCH_JUDGE_MODELS.has(j)) throw new BenchmarkInputError(`評審只能選：${[...BENCH_JUDGE_MODELS].join('、')}（收到 ${j}）`);
  }
  const judgeModel = judges[0]!;

  const codingTool = input.coding_tool ?? 'claude-code';
  const planRef = input.plan_ref?.trim() || null;
  const repoPath = input.repo_path?.trim() || plan?.repo_path || null;
  const baseBranch = input.base_branch?.trim() || null;
  const complexity: Complexity = input.complexity ?? 'M';
  const setupCmd = input.setup_cmd ?? plan?.setup_cmd ?? null;

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
    setup_cmd: setupCmd,
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
       verify_rubric, domain, complexity, judge_model, judge_models, source_kind, source_ref, restore_model,
       acceptance_metrics, protected_paths, artifacts, verify_plan_id, verify_timeout_min, timeout_min)
     VALUES (@id, @title, @goal, @plan_ref, @repo_path, @base_branch, @verification_steps, @setup_cmd,
       @verify_rubric, @domain, @complexity, @judge_model, @judge_models, @source_kind, @source_ref, @restore_model,
       @acceptance_metrics, @protected_paths, @artifacts, @verify_plan_id, @verify_timeout_min, @timeout_min)`,
  ).run({
    id,
    title,
    goal,
    plan_ref: planRef,
    repo_path: repoPath,
    base_branch: baseBranch,
    verification_steps: JSON.stringify(steps),
    setup_cmd: setupCmd,
    acceptance_metrics: acceptance,
    protected_paths: protectedPaths,
    artifacts,
    verify_plan_id: plan?.id ?? null,
    verify_timeout_min: verifyTimeout,
    timeout_min: runTimeout,
    verify_rubric: input.verify_rubric ?? null,
    domain,
    complexity,
    judge_model: judgeModel,
    judge_models: judges.join(','),
    source_kind: input.source_kind ?? 'manual',
    source_ref: input.source_ref ?? null,
    // the model serving right now — switched back to once benchmarks and 快篩 are all done
    restore_model: models.some(isLocalModel) && getSetting(db, 'local_model_status') === 'ready' ? (getSetting(db, 'local_model_loaded') || null) : null,
  });

  const row = getBenchmark(db, id)!.benchmark;
  // one place for the whole queue (screen.ts settleRestore); a 快篩 queued behind this finds it there
  if (row.restore_model && !getSetting(db, 'bench_restore_model')) setSetting(db, 'bench_restore_model', row.restore_model);
  for (const model of models) createArm(db, row, model, { codingTool, priority: input.priority ?? 2 });
  logEvent(db, { kind: 'note', detail: `benchmark ${id} created: ${title} [${models.join(', ')}] domain=${domain}` });
  const created = getBenchmark(db, id)!;
  return { benchmark: created.benchmark, arms: created.arms };
}

/**
 * One arm: an ordinary task on the benchmark's question for `model` (so it goes through the normal
 * tick -> runTask -> verify path), queued. Shared by createBenchmark and 快篩 (screen.ts), whose
 * arms are created only when their row's turn comes.
 */
export function createArm(
  db: Database.Database,
  b: Benchmark,
  model: string,
  o: { codingTool?: 'claude-code' | 'mock'; priority?: number; label?: string } = {},
): Task {
  let steps: string[] = [];
  try {
    steps = JSON.parse(b.verification_steps) as string[];
  } catch {
    steps = [];
  }
  const task = createTask(db, {
    title: `${o.label ?? '[bench]'} ${b.title} · ${model}`,
    goal: b.goal,
    plan_ref: b.plan_ref,
    plan_kind: planKind(b.plan_ref),
    coding_tool: o.codingTool ?? 'claude-code',
    verification_steps: steps,
    setup_cmd: b.setup_cmd,
    repo_path: b.repo_path,
    base_branch: b.base_branch,
    complexity: b.complexity,
    priority: o.priority ?? 2,
    model,
    timeout_min: b.timeout_min,
    verify_mode: 'command',
    verify_rubric: b.verify_rubric,
    verify_timeout_min: b.verify_timeout_min,
    experiment: `bench:${b.id}`,
    benchmark_id: b.id,
    acceptance_metrics: b.acceptance_metrics,
    protected_paths: b.protected_paths,
    artifacts: b.artifacts,
    verify_plan_id: b.verify_plan_id,
  });
  db.prepare('INSERT INTO benchmark_arms (benchmark_id, model, task_id) VALUES (?, ?, ?)').run(b.id, model, task.id);
  setStatus(db, task.id, 'queued', { detail: `benchmark ${b.id} arm (${model})` });
  return task;
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
  deps: { onArmTask?: (task: Task) => void; single?: boolean } = {},
): Benchmark | null {
  const detail = getBenchmark(db, id);
  if (!detail) return null;
  const { benchmark } = detail;
  // a 快篩 row belongs to its batch: cancelling one stops the whole batch (what is running and what waits)
  if (benchmark.mode === 'screen' && benchmark.screen_group && !deps.single) {
    const rows = db.prepare("SELECT id FROM benchmarks WHERE screen_group = ? AND status IN ('queued','running','judging')").all(benchmark.screen_group) as { id: string }[];
    for (const r of rows) cancelBenchmark(db, r.id, reason, { ...deps, single: true });
    return getBenchmark(db, id)!.benchmark;
  }
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

/** The newest benchmarks. 快篩 rows (one per model × question) have their own list (listScreens) and are left out unless asked for. */
export function listBenchmarks(db: Database.Database, limit = 50, opts: { screens?: boolean } = {}): BenchmarkListRow[] {
  const rows = db
    .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM benchmark_arms a WHERE a.benchmark_id = b.id) AS arm_count,
              (SELECT COUNT(*) FROM benchmark_arms a LEFT JOIN tasks t ON t.id = a.task_id
                WHERE a.benchmark_id = b.id AND (t.id IS NULL OR t.status IN ('review','attention','failed','closed'))) AS arms_done,
              (SELECT GROUP_CONCAT(a.model, ',') FROM benchmark_arms a WHERE a.benchmark_id = b.id) AS models_csv
         FROM benchmarks b
        ${opts.screens ? '' : "WHERE COALESCE(b.mode, '') <> 'screen'"}
        ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?`,
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
              SUM(CASE WHEN a.model = b.winner THEN 1 ELSE 0 END) AS wins,
              AVG(a.judge_score) AS avg_score,
              AVG(CASE WHEN a.verify_outcome = 'pass' THEN 1.0 ELSE 0.0 END) AS verify_pass_rate
         FROM benchmark_arms a JOIN benchmarks b ON b.id = a.benchmark_id
        WHERE b.status = 'judged' AND (b.mode IS NULL OR b.mode != 'screen') GROUP BY a.model ORDER BY wins DESC, avg_score DESC`,
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
  /** a local vLLM model (local:<id>) rather than a cloud one */
  local: boolean;
  domain: string;
  n: number;
  avg_score: number | null;
  /** among judged benchmarks only (快篩 has no judge); null when the row is 快篩 only */
  win_rate: number | null;
  /** how many of the n rows are 快篩 (no judge, no final measurement) */
  screen_n: number;
  /** passed the bar: the final re-measurement when the benchmark had one, else the arm's own verification */
  verify_pass_rate: number;
  /** of the arms with attempt records: passed on the first verification, no send-back needed */
  first_try_rate: number | null;
  /** among the arms that passed: on which attempt, on average */
  avg_passed_at: number | null;
  /** of the arms with attempt records: ran a profiler (ncu / nsys) itself while working */
  profiler_rate: number | null;
  /** how many arms have attempt records (benchmarks judged before they were kept have none) */
  tracked: number;
  avg_tokens_out: number | null;
  avg_duration_s: number | null;
}

export interface MatrixFilter {
  /** software type: one of BENCH_DOMAINS */
  domain?: string | null;
  /** local models, cloud models, or both */
  kind?: 'local' | 'cloud' | 'all' | null;
  /** at least this many judged benchmarks behind a row */
  min_n?: number | null;
  /** at least this pass rate (0-1) */
  min_pass?: number | null;
  /** include 快篩 rows (default true); false = judged benchmarks only */
  screens?: boolean;
}

/**
 * Judged arms aggregated per (model, domain): the "which model writes which kind of software well"
 * view, filterable by software type, local/cloud and how reliably a model passes.
 */
export function benchmarkMatrix(db: Database.Database, filter: MatrixFilter = {}): MatrixRow[] {
  const where = ["b.status = 'judged'"];
  const args: Array<string | number> = [];
  if (filter.domain) {
    where.push('b.domain = ?');
    args.push(filter.domain);
  }
  if (filter.screens === false) where.push("(b.mode IS NULL OR b.mode != 'screen')");
  if (filter.kind === 'local') where.push("a.model LIKE 'local:%'");
  if (filter.kind === 'cloud') where.push("a.model NOT LIKE 'local:%'");
  const having: string[] = [];
  if (filter.min_n) {
    having.push('COUNT(*) >= ?');
    args.push(filter.min_n);
  }
  if (filter.min_pass != null) {
    having.push("AVG(CASE WHEN a.verify_outcome = 'pass' THEN 1.0 ELSE 0.0 END) >= ?");
    args.push(filter.min_pass - 1e-9);
  }
  const tracked = "CASE WHEN a.attempts_json IS NULL THEN NULL WHEN json_extract(a.attempts_json, '$.%s') THEN 1.0 ELSE 0.0 END";
  const rows = db
    .prepare(
      `SELECT a.model AS model, b.domain AS domain, COUNT(*) AS n,
              AVG(a.judge_score) AS avg_score,
              AVG(CASE WHEN b.mode = 'screen' THEN NULL WHEN a.model = b.winner THEN 1.0 ELSE 0.0 END) AS win_rate,
              SUM(CASE WHEN b.mode = 'screen' THEN 1 ELSE 0 END) AS screen_n,
              AVG(CASE WHEN a.verify_outcome = 'pass' THEN 1.0 ELSE 0.0 END) AS verify_pass_rate,
              AVG(${tracked.replace('%s', 'first_try')}) AS first_try_rate,
              AVG(json_extract(a.attempts_json, '$.passed_at')) AS avg_passed_at,
              AVG(${tracked.replace('%s', 'profiler')}) AS profiler_rate,
              COUNT(a.attempts_json) AS tracked,
              AVG(a.tokens_out) AS avg_tokens_out,
              AVG(a.duration_s) AS avg_duration_s
         FROM benchmark_arms a JOIN benchmarks b ON b.id = a.benchmark_id
        WHERE ${where.join(' AND ')}
        GROUP BY a.model, b.domain
        ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
        ORDER BY b.domain, verify_pass_rate DESC, avg_score DESC`,
    )
    .all(...args) as MatrixRow[];
  const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  return rows.map((r) => ({
    ...r,
    model_label: modelLabel(db, r.model),
    local: isLocalModel(r.model),
    avg_score: r1(r.avg_score),
    win_rate: r2(r.win_rate),
    screen_n: r.screen_n ?? 0,
    verify_pass_rate: r2(r.verify_pass_rate)!,
    first_try_rate: r2(r.first_try_rate),
    avg_passed_at: r1(r.avg_passed_at),
    profiler_rate: r2(r.profiler_rate),
    avg_tokens_out: r.avg_tokens_out == null ? null : Math.round(r.avg_tokens_out),
    avg_duration_s: r.avg_duration_s == null ? null : Math.round(r.avg_duration_s),
  }));
}

export interface Recommendation {
  domain: string;
  /** the local model to hand this kind of work to, if any has passed a benchmark of it */
  local: MatrixRow | null;
  /** the best cloud model on the same work, for comparison */
  cloud: MatrixRow | null;
  /** fewer than 3 judged benchmarks behind the local pick: a hint, not a finding */
  thin: boolean;
  /** the verdict as a kind the page can colour: no local data, local cannot, local can, local weaker than cloud */
  kind: 'none' | 'cannot' | 'can' | 'weaker';
  verdict: string;
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const better = (a: MatrixRow, b: MatrixRow) =>
  b.verify_pass_rate - a.verify_pass_rate || (b.first_try_rate ?? -1) - (a.first_try_rate ?? -1) || (b.avg_score ?? -1) - (a.avg_score ?? -1) || b.n - a.n;

/**
 * Which local model fits which kind of software, read off every judged benchmark: per domain the
 * local model that passes most often (then first-try, then score), next to the best cloud model.
 */
export function benchmarkRecommendations(db: Database.Database, opts: { min_n?: number } = {}): Recommendation[] {
  const rows = benchmarkMatrix(db, { min_n: opts.min_n ?? 1 });
  const out: Recommendation[] = [];
  for (const domain of BENCH_DOMAINS) {
    const here = rows.filter((r) => r.domain === domain);
    if (!here.length) continue;
    const local = here.filter((r) => r.local).sort(better)[0] ?? null;
    const cloud = here.filter((r) => !r.local).sort(better)[0] ?? null;
    // 快篩 rows count toward pass rates, but a hint built only on them says so
    const judged = local ? local.n - local.screen_n : 0;
    const thin = !local || judged < 3;
    let verdict: string;
    let kind: Recommendation['kind'];
    if (!local) {
      kind = 'none';
      verdict = '還沒有本地模型評比過這類工作';
    } else if (local.verify_pass_rate === 0) {
      kind = 'cannot';
      verdict = `本地模型還做不來（${local.model_label} 通過率 0%）${cloud ? `，先交給雲端 ${cloud.model_label}` : ''}`;
    } else if (!cloud || local.verify_pass_rate >= cloud.verify_pass_rate) {
      kind = 'can';
      verdict = `可以交給 ${local.model_label}（通過率 ${pct(local.verify_pass_rate)}，一次就過 ${pct(local.first_try_rate)}）`;
    } else {
      kind = 'weaker';
      verdict = `${local.model_label} 做得到但不如雲端（通過率 ${pct(local.verify_pass_rate)} 對 ${cloud.model_label} ${pct(cloud.verify_pass_rate)}），重要的工作交給雲端`;
    }
    const basis = local && judged === 0 ? `；只有快篩結果（${local.n} 題），僅供參考` : thin && local ? `；只有 ${judged} 場評比，僅供參考` : '';
    out.push({ domain, local, cloud, thin, kind, verdict: `${verdict}${basis}` });
  }
  return out;
}

export interface HeadToHead {
  /** the row model and the column model */
  a: string;
  b: string;
  /** benchmarks where both were judged, and how many of them a ranked above b */
  n: number;
  wins: number;
  rate: number;
}

/**
 * Model against model: in every judged benchmark both took part in, did one rank above the other.
 * The LMArena-style pairwise table, read straight off judge_rank (which already puts arms that
 * passed the measured bar above those that did not).
 */
export function benchmarkHeadToHead(
  db: Database.Database,
  filter: { domain?: string | null } = {},
): { models: Array<{ model: string; label: string; local: boolean; n: number }>; pairs: HeadToHead[] } {
  const rows = db
    .prepare(
      `SELECT a.benchmark_id AS bid, a.model AS model, a.judge_rank AS rank
         FROM benchmark_arms a JOIN benchmarks b ON b.id = a.benchmark_id
        WHERE b.status = 'judged' AND a.judge_rank IS NOT NULL${filter.domain ? ' AND b.domain = ?' : ''}`,
    )
    .all(...(filter.domain ? [filter.domain] : [])) as Array<{ bid: string; model: string; rank: number }>;
  const byBench = new Map<string, Array<{ model: string; rank: number }>>();
  const count = new Map<string, number>();
  for (const r of rows) {
    const list = byBench.get(r.bid) ?? [];
    list.push({ model: r.model, rank: r.rank });
    byBench.set(r.bid, list);
    count.set(r.model, (count.get(r.model) ?? 0) + 1);
  }
  const tally = new Map<string, { n: number; wins: number }>();
  for (const arms of byBench.values()) {
    for (const x of arms) {
      for (const y of arms) {
        if (x.model === y.model) continue;
        const k = `${x.model}\u0000${y.model}`;
        const t = tally.get(k) ?? { n: 0, wins: 0 };
        t.n += 1;
        if (x.rank < y.rank) t.wins += 1;
        tally.set(k, t);
      }
    }
  }
  const models = [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, n]) => ({ model, label: modelLabel(db, model) ?? model, local: isLocalModel(model), n }));
  const pairs: HeadToHead[] = [...tally.entries()].map(([k, t]) => {
    const [a, b] = k.split('\u0000') as [string, string];
    return { a, b, n: t.n, wins: t.wins, rate: Math.round((t.wins / t.n) * 100) / 100 };
  });
  return { models, pairs };
}
