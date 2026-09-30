import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getBool, getNum, getSetting, logEvent } from '../db/index.js';
import type { Task } from '../types.js';
import { validateTask } from '../gate/validateTask.js';
import { getLocalModel, isLocalModel, localId } from '../local/models.js';
import { isModelValue } from '../settings.js';
import { loadBuiltin, resolveSource, type ResolveDeps } from './source.js';
import { activeBenchmark, BenchmarkInputError, createArm, deleteBenchmark, gateReason, modelLabel, type Benchmark } from './store.js';

/**
 * 模型快篩: a quick look at whether a model can code at all, before it earns a real benchmark.
 * Each (model, built-in question) pair is one benchmark row (mode 'screen'); a batch shares a
 * screen_group. Rows run one at a time, grouped by model (one model switch per model), each capped
 * by its run time limit (timeout_min — the watchdog ends an overrun as a miss). No final
 * re-measurement, no cloud judge: a screen never spends subscription quota. Rows waiting their
 * turn are status 'queued' with no arm yet, so a screen queues behind a running benchmark instead
 * of breaking "one benchmark at a time"; promoteScreens() starts the next row when nothing is active.
 */

export interface ScreenInput {
  /** local:<id> models to screen (any model alias with coding_tool 'mock', for tests) */
  models: string[];
  /** built-in question keys (seed/bench/*.json); default: bench_screen_questions */
  questions?: string[];
  /** each question's time cap in minutes; default: bench_screen_budget_min */
  budget_min?: number;
  /** dev/test only: 'mock' runs every row on the zero-token mock adapter */
  coding_tool?: 'claude-code' | 'mock';
}

interface ScreenConfig {
  model: string;
  coding_tool: 'claude-code' | 'mock';
  budget_min: number;
}

export interface ScreenCell {
  benchmark_id: string;
  model: string;
  model_label: string;
  question: string;
  question_title: string;
  status: Benchmark['status'];
  task_id: string | null;
  task_status: string | null;
  /** pass | fail once finished; running | queued | cancelled before or instead */
  outcome: 'pass' | 'fail' | 'running' | 'queued' | 'cancelled';
  attempts_label: string | null;
  duration_s: number | null;
  tokens_out: number | null;
  failure: string | null;
}

export interface ScreenGroup {
  group: string;
  created_at: string;
  status: 'queued' | 'running' | 'done' | 'cancelled';
  models: string[];
  questions: string[];
  budget_min: number;
  cells: ScreenCell[];
  passed: number;
  done: number;
  total: number;
}

const parse = <T>(s: string | null | undefined): T | null => {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
};

export const screenConfig = (b: Pick<Benchmark, 'screen_json'>): ScreenConfig | null => parse<ScreenConfig>(b.screen_json);

/** Why this model cannot be screened now (null = it can). */
function modelProblem(db: Database.Database, model: string, codingTool: string): string | null {
  if (!isModelValue(model) || model === 'default' || model === '') return `不能用這個模型：${model}`;
  if (!isLocalModel(model)) return codingTool === 'mock' ? null : `快篩只測本地模型（local:<id>）：${model}`;
  const lm = getLocalModel(db, localId(model));
  if (!lm) return `找不到這個本地模型：${model}（先在「模型」面板登錄）`;
  if (!lm.enabled) return `本地模型 ${model} 已停用`;
  return null;
}

/** Start a 模型快篩: validate everything, create every row (queued), then start the first one if nothing else runs. */
export function createScreen(db: Database.Database, input: ScreenInput, deps: ResolveDeps = {}): { group: string; rows: string[]; started: string | null; waiting_for: string | null } {
  const codingTool = input.coding_tool ?? 'claude-code';
  const models = [...new Set((input.models ?? []).map((m) => String(m).trim()).filter(Boolean))];
  if (!models.length) throw new BenchmarkInputError('快篩至少要選 1 個模型');
  if (models.length > 8) throw new BenchmarkInputError('一次最多快篩 8 個模型');
  if (codingTool !== 'mock' && !getBool(db, 'local_models_enabled', false)) throw new BenchmarkInputError('本地模型沒有開（local_models_enabled=false）');
  for (const m of models) {
    const why = modelProblem(db, m, codingTool);
    if (why) throw new BenchmarkInputError(why);
  }
  const defaults = (getSetting(db, 'bench_screen_questions') || 'slugify,log-analyzer,csv-parser').split(',').map((s) => s.trim()).filter(Boolean);
  const questions = [...new Set((input.questions?.length ? input.questions : defaults).map((q) => String(q).trim()).filter(Boolean))];
  if (!questions.length || questions.length > 6) throw new BenchmarkInputError('快篩要 1 到 6 題');
  for (const q of questions) if (!loadBuiltin(q, deps.builtinDir)) throw new BenchmarkInputError(`沒有這題內建題：${q}`);
  const budget = input.budget_min ?? getNum(db, 'bench_screen_budget_min', 15);
  if (!Number.isInteger(budget) || budget < 3 || budget > 120) throw new BenchmarkInputError('每題時限要是 3 到 120 的整數分鐘');

  const group = `sg_${nanoid(8)}`;
  // the model to switch back to when the batch is done: the one serving now — unless something
  // else runs or waits, in which case whatever finishes before this batch hands its own down
  const busy = activeBenchmark(db) || queuedScreens(db) > 0;
  const restore = !busy && getSetting(db, 'local_model_status') === 'ready' ? getSetting(db, 'local_model_loaded') || null : null;
  const insert = db.prepare(
    `INSERT INTO benchmarks (id, title, goal, plan_ref, repo_path, base_branch, verification_steps, setup_cmd, verify_rubric,
       domain, complexity, judge_model, judge_models, status, source_kind, source_ref, restore_model, verify_timeout_min, timeout_min,
       mode, screen_group, screen_seq, screen_json)
     VALUES (@id, @title, @goal, @plan_ref, @repo_path, @base_branch, @verification_steps, @setup_cmd, @verify_rubric,
       @domain, @complexity, 'none', '', 'queued', 'builtin', @source_ref, @restore_model, @verify_timeout_min, @timeout_min,
       'screen', @group, @seq, @screen_json)`,
  );
  const rows: string[] = [];
  const cleanups: Array<() => void> = [];
  try {
    let seq = 0;
    // grouped by model: every question of one model runs before the next model is loaded
    for (const model of models) {
      for (const key of questions) {
        const src = resolveSource(db, 'builtin', key, {}, deps);
        if (src.cleanup) cleanups.push(src.cleanup);
        const gate = validateTask(
          { goal: src.goal, plan_ref: src.plan_ref, coding_tool: codingTool, verification_steps: JSON.stringify(src.verification_steps), verify_mode: 'command', verify_rubric: src.verify_rubric, repo_path: src.repo_path, base_branch: src.base_branch, setup_cmd: src.setup_cmd, environment: null, requires: null } as unknown as Task,
          getSetting(db, 'host_capabilities') ?? '',
        );
        if (!gate.ok) throw new BenchmarkInputError(gateReason(gate.missing));
        const id = `b_${nanoid(10)}`;
        insert.run({
          id,
          title: `快篩：${src.title}`,
          goal: src.goal,
          plan_ref: src.plan_ref,
          repo_path: src.repo_path,
          base_branch: src.base_branch,
          verification_steps: JSON.stringify(src.verification_steps),
          setup_cmd: src.setup_cmd,
          verify_rubric: src.verify_rubric,
          domain: src.domain,
          complexity: src.complexity,
          source_ref: key,
          restore_model: restore,
          verify_timeout_min: Math.min(5, budget),
          timeout_min: budget,
          group,
          seq: seq++,
          screen_json: JSON.stringify({ model, coding_tool: codingTool, budget_min: budget } satisfies ScreenConfig),
        });
        rows.push(id);
      }
    }
  } catch (err) {
    for (const id of rows) db.prepare('DELETE FROM benchmarks WHERE id = ?').run(id);
    for (const c of cleanups) c();
    throw err;
  }
  logEvent(db, { kind: 'note', detail: `模型快篩 ${group}: ${models.join(', ')} × ${questions.join(', ')}（每題 ${budget} 分）` });
  const started = promoteScreens(db);
  const active = activeBenchmark(db);
  return { group, rows, started, waiting_for: started ? null : active ? `${active.id}「${active.title}」` : null };
}

function queuedScreens(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM benchmarks WHERE mode = 'screen' AND status = 'queued'").get() as { n: number }).n;
}

/**
 * Start the next waiting 快篩 row when nothing else holds the queue. Idempotent and cheap: called
 * after every create and on every benchmark check (each tick), so a restart between rows heals.
 */
export function promoteScreens(db: Database.Database): string | null {
  for (;;) {
    if (activeBenchmark(db)) return null;
    const next = db
      .prepare("SELECT * FROM benchmarks WHERE mode = 'screen' AND status = 'queued' ORDER BY created_at, screen_seq, rowid LIMIT 1")
      .get() as Benchmark | undefined;
    if (!next) return null;
    const cfg = screenConfig(next);
    const why = cfg ? modelProblem(db, cfg.model, cfg.coding_tool) : '快篩設定壞了';
    if (why || !cfg) {
      db.prepare("UPDATE benchmarks SET status = 'cancelled', error = ? WHERE id = ?").run(why, next.id);
      logEvent(db, { kind: 'note', detail: `模型快篩 ${next.screen_group}: ${next.id} 沒有開始：${why}` });
      continue;
    }
    const tx = db.transaction(() => {
      createArm(db, next, cfg.model, { codingTool: cfg.coding_tool, label: '[快篩]' });
      db.prepare("UPDATE benchmarks SET status = 'running' WHERE id = ?").run(next.id);
    });
    tx();
    logEvent(db, { kind: 'note', detail: `模型快篩 ${next.screen_group}: ${cfg.model} 開始 ${next.source_ref}` });
    return next.id;
  }
}

/** Is every row of this batch finished (judged or cancelled)? */
export function screenGroupDone(db: Database.Database, group: string): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM benchmarks WHERE screen_group = ? AND status IN ('queued','running','judging')").get(group) as { n: number }).n === 0;
}

/** The model a finished benchmark switches back to — or hands down to the 快篩 rows still waiting. */
export function handOffRestore(db: Database.Database, restore: string | null): 'handed' | 'restore' | 'none' {
  if (!restore) return 'none';
  if (queuedScreens(db) > 0) {
    db.prepare("UPDATE benchmarks SET restore_model = ? WHERE mode = 'screen' AND status = 'queued' AND restore_model IS NULL").run(restore);
    return 'handed';
  }
  return 'restore';
}

/** Drop a finished (or never-started) batch; refused while one of its rows runs. */
export function deleteScreen(db: Database.Database, group: string): number {
  const rows = db.prepare('SELECT id, status FROM benchmarks WHERE screen_group = ?').all(group) as { id: string; status: string }[];
  if (rows.some((r) => r.status === 'running' || r.status === 'judging')) throw new BenchmarkInputError('快篩還在跑，請先取消。');
  let n = 0;
  for (const r of rows) if (deleteBenchmark(db, r.id)) n++;
  return n;
}

interface CellRow extends Benchmark {
  arm_model: string | null;
  task_id: string | null;
  verify_outcome: string | null;
  duration_s: number | null;
  tokens_out: number | null;
  attempts_json: string | null;
  task_status: string | null;
}

function toCell(db: Database.Database, r: CellRow): ScreenCell {
  const cfg = screenConfig(r);
  const model = r.arm_model ?? cfg?.model ?? '';
  const ev = parse<{ evidence?: Array<{ failure?: string | null }> }>(r.result_json)?.evidence?.[0];
  const outcome: ScreenCell['outcome'] =
    r.status === 'judged' ? (r.verify_outcome === 'pass' ? 'pass' : 'fail') : r.status === 'cancelled' ? 'cancelled' : r.status === 'queued' ? 'queued' : 'running';
  return {
    benchmark_id: r.id,
    model,
    model_label: modelLabel(db, model) ?? model,
    question: r.source_ref ?? '',
    question_title: r.title.replace(/^快篩：/, ''),
    status: r.status,
    task_id: r.task_id,
    task_status: r.task_status,
    outcome,
    attempts_label: parse<{ label?: string }>(r.attempts_json)?.label ?? null,
    duration_s: r.duration_s,
    tokens_out: r.tokens_out,
    failure: outcome === 'fail' ? (ev?.failure ?? r.error ?? null)?.split('\n').find((l) => l.trim())?.slice(0, 200) ?? null : r.status === 'cancelled' ? r.error : null,
  };
}

/** The newest 快篩 batches, each with its model × question cells. */
export function listScreens(db: Database.Database, limit = 20, group?: string): ScreenGroup[] {
  const rows = db
    .prepare(
      `SELECT b.*, a.model AS arm_model, a.task_id AS task_id, a.verify_outcome AS verify_outcome, a.duration_s AS duration_s,
              a.tokens_out AS tokens_out, a.attempts_json AS attempts_json, t.status AS task_status
         FROM benchmarks b LEFT JOIN benchmark_arms a ON a.benchmark_id = b.id LEFT JOIN tasks t ON t.id = a.task_id
        WHERE b.mode = 'screen'${group ? ' AND b.screen_group = ?' : ''}
        ORDER BY b.created_at DESC, b.screen_seq`,
    )
    .all(...(group ? [group] : [])) as CellRow[];
  const groups = new Map<string, CellRow[]>();
  for (const r of rows) {
    const g = r.screen_group ?? r.id;
    const list = groups.get(g) ?? [];
    list.push(r);
    groups.set(g, list);
  }
  return [...groups.entries()].slice(0, limit).map(([g, list]) => {
    const cells = [...list].sort((a, b) => (a.screen_seq ?? 0) - (b.screen_seq ?? 0)).map((r) => toCell(db, r));
    const status: ScreenGroup['status'] = cells.some((c) => c.outcome === 'running')
      ? 'running'
      : cells.some((c) => c.outcome === 'queued')
        ? 'queued'
        : cells.every((c) => c.outcome === 'cancelled')
          ? 'cancelled'
          : 'done';
    return {
      group: g,
      created_at: list[list.length - 1]!.created_at,
      status,
      models: [...new Set(cells.map((c) => c.model))],
      questions: [...new Set(cells.map((c) => c.question))],
      budget_min: screenConfig(list[0]!)?.budget_min ?? 15,
      cells,
      passed: cells.filter((c) => c.outcome === 'pass').length,
      done: cells.filter((c) => c.outcome === 'pass' || c.outcome === 'fail' || c.outcome === 'cancelled').length,
      total: cells.length,
    };
  });
}

export function getScreen(db: Database.Database, group: string): ScreenGroup | null {
  return listScreens(db, 1, group)[0] ?? null;
}
