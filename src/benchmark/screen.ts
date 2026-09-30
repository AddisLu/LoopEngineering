import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getBool, getNum, getSetting, logEvent, setSetting } from '../db/index.js';
import type { Task } from '../types.js';
import { validateTask } from '../gate/validateTask.js';
import { localLoadGuard, type LocalGuardDeps } from '../local/guard.js';
import { getLocalModel, isLocalModel, localId } from '../local/models.js';
import { getModelManager, type ModelManager } from '../local/modelManager.js';
import { notify } from '../notify.js';
import { isModelValue } from '../settings.js';
import { activeLocalRunCount, setStatus } from '../tasks.js';
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

/** Test seams on top of the built-in question source: the HF cache and docker probe the load guard reads. */
export type ScreenDeps = ResolveDeps & { guard?: LocalGuardDeps };

/**
 * Why this model cannot be screened now (null = it can): registered, enabled, and loadable on this
 * machine — weights on disk, image built, enough Sparks. A row for a model vLLM cannot start would
 * hold the queue forever (its time cap only starts once the model runs).
 */
function modelProblem(db: Database.Database, model: string, codingTool: string, guard: LocalGuardDeps = {}): string | null {
  if (!isModelValue(model) || model === 'default' || model === '') return `不能用這個模型：${model}`;
  if (!isLocalModel(model)) return codingTool === 'mock' ? null : `快篩只測本地模型（local:<id>）：${model}`;
  const lm = getLocalModel(db, localId(model));
  if (!lm) return `找不到這個本地模型：${model}（先在「模型」面板登錄）`;
  if (!lm.enabled) return `本地模型 ${model} 已停用`;
  if (codingTool === 'mock') return null; // the mock adapter never loads anything
  // loaded: the model itself — "local runs in flight" is about switching now, not about this row
  return localLoadGuard(db, lm, { ...guard, loaded: lm.id })?.error ?? null;
}

/** Start a 模型快篩: validate everything, create every row (queued), then start the first one if nothing else runs. */
export function createScreen(db: Database.Database, input: ScreenInput, deps: ScreenDeps = {}): { group: string; rows: string[]; started: string | null; waiting_for: string | null } {
  const codingTool = input.coding_tool ?? 'claude-code';
  const models = [...new Set((input.models ?? []).map((m) => String(m).trim()).filter(Boolean))];
  if (!models.length) throw new BenchmarkInputError('快篩至少要選 1 個模型');
  if (models.length > 8) throw new BenchmarkInputError('一次最多快篩 8 個模型');
  if (codingTool !== 'mock' && !getBool(db, 'local_models_enabled', false)) throw new BenchmarkInputError('本地模型沒有開（local_models_enabled=false）');
  for (const m of models) {
    const why = modelProblem(db, m, codingTool, deps.guard);
    if (why) throw new BenchmarkInputError(why);
  }
  const defaults = (getSetting(db, 'bench_screen_questions') || 'slugify,log-analyzer,csv-parser').split(',').map((s) => s.trim()).filter(Boolean);
  const questions = [...new Set((input.questions?.length ? input.questions : defaults).map((q) => String(q).trim()).filter(Boolean))];
  if (!questions.length || questions.length > 6) throw new BenchmarkInputError('快篩要 1 到 6 題');
  for (const q of questions) if (!loadBuiltin(q, deps.builtinDir)) throw new BenchmarkInputError(`沒有這題內建題：${q}`);
  const budget = input.budget_min ?? getNum(db, 'bench_screen_budget_min', 15);
  if (!Number.isInteger(budget) || budget < 3 || budget > 120) throw new BenchmarkInputError('每題時限要是 3 到 120 的整數分鐘');

  const group = `sg_${nanoid(8)}`;
  captureRestore(db);
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
          restore_model: null, // the queue-wide bench_restore_model (captureRestore) is what counts
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
  const started = promoteScreens(db, deps);
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
export function promoteScreens(db: Database.Database, deps: { guard?: LocalGuardDeps } = {}): string | null {
  for (;;) {
    if (activeBenchmark(db)) return null;
    // batch by batch, each in its own model-grouped order: rowid is insertion order (created_at has
    // one-second resolution, so two batches made in the same second used to run interleaved)
    const next = db.prepare("SELECT * FROM benchmarks WHERE mode = 'screen' AND status = 'queued' ORDER BY rowid LIMIT 1").get() as Benchmark | undefined;
    if (!next) return null;
    const cfg = screenConfig(next);
    const why = cfg ? modelProblem(db, cfg.model, cfg.coding_tool, deps.guard) : '快篩設定壞了';
    if (why || !cfg) {
      db.prepare("UPDATE benchmarks SET status = 'cancelled', error = ? WHERE id = ? AND status = 'queued'").run(why, next.id);
      logEvent(db, { kind: 'note', detail: `模型快篩 ${next.screen_group}: ${next.id} 沒有開始：${why}` });
      // that may have been the batch's last row: then the batch ends here, so it is reported here
      if (next.screen_group && screenGroupDone(db, next.screen_group)) void reportScreenGroup(db, next.screen_group);
      continue;
    }
    // conditional, under the write lock: the CLI and the engine may both promote — one starts the row
    const started = db
      .transaction(() => {
        if (db.prepare("UPDATE benchmarks SET status = 'running' WHERE id = ? AND status = 'queued'").run(next.id).changes !== 1) return false;
        createArm(db, next, cfg.model, { codingTool: cfg.coding_tool, label: '[快篩]' });
        return true;
      })
      .immediate();
    if (!started) continue;
    logEvent(db, { kind: 'note', detail: `模型快篩 ${next.screen_group}: ${cfg.model} 開始 ${next.source_ref}` });
    return next.id;
  }
}

/** Is every row of this batch finished (judged or cancelled)? */
export function screenGroupDone(db: Database.Database, group: string): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM benchmarks WHERE screen_group = ? AND status IN ('queued','running','judging')").get(group) as { n: number }).n === 0;
}

/** A finished batch in one line — per model, questions passed / run, or why it never started — logged and pushed once. */
export async function reportScreenGroup(db: Database.Database, group: string): Promise<string> {
  const rows = db
    .prepare(
      `SELECT b.status, b.error, b.screen_json, a.model AS arm_model, a.verify_outcome
         FROM benchmarks b LEFT JOIN benchmark_arms a ON a.benchmark_id = b.id
        WHERE b.screen_group = ? ORDER BY b.rowid`,
    )
    .all(group) as Array<{ status: string; error: string | null; screen_json: string | null; arm_model: string | null; verify_outcome: string | null }>;
  const per = new Map<string, { passed: number; ran: number; skipped: string | null }>();
  for (const r of rows) {
    const model = r.arm_model ?? screenConfig(r)?.model ?? '?';
    const m = per.get(model) ?? { passed: 0, ran: 0, skipped: null };
    if (r.arm_model) {
      m.ran++;
      if (r.verify_outcome === 'pass') m.passed++;
    } else if (r.status === 'cancelled') m.skipped ??= r.error;
    per.set(model, m);
  }
  const line = [...per.entries()]
    .map(([model, m]) => `${model.replace(/^local:/, '')} ${m.ran ? `${m.passed}/${m.ran}` : `沒有開始${m.skipped ? `（${m.skipped}）` : ''}`}`)
    .join('・');
  logEvent(db, { kind: 'note', detail: `模型快篩 ${group} 完成：${line}` });
  try {
    await notify(db, { title: 'Loop: 模型快篩完成', message: line || '（沒有跑完的題目）', tags: ['mag'] });
  } catch {
    /* a push that fails is not a batch that failed */
  }
  return line;
}

/**
 * The model to switch back to once benchmarks and 快篩 are all done. Captured once, when automated
 * switching starts from idle, and kept in one place (bench_restore_model) until settleRestore()
 * puts it back — whatever order batches finish, get cancelled or fail in. (Each row used to carry
 * its own and hand it down; a cancel, a judge failure or a cloud-only benchmark ahead lost it.)
 */
export function captureRestore(db: Database.Database): void {
  if (getSetting(db, 'bench_restore_model')) return; // automated work already holds the operator's model
  const ready = getSetting(db, 'local_model_status') === 'ready' ? getSetting(db, 'local_model_loaded') || null : null;
  const active = activeBenchmark(db);
  if (!active) {
    if (ready) setSetting(db, 'bench_restore_model', ready);
    return;
  }
  // a running benchmark captured its own; one with only cloud arms never switched anything
  const localArms = (db.prepare("SELECT COUNT(*) AS n FROM benchmark_arms WHERE benchmark_id = ? AND model LIKE 'local:%'").get(active.id) as { n: number }).n;
  const v = active.restore_model ?? (localArms === 0 ? ready : null);
  if (v) setSetting(db, 'bench_restore_model', v);
}

/**
 * Put the operator's model back once nothing automated holds the queue — no benchmark running or
 * judging, no 快篩 waiting. Called when a benchmark or a batch ends and on every benchmark check,
 * so a cancel, a judge failure or a batch that ended while promoting all land here too. Returns the
 * model it switched back to (null = nothing to do yet, or nothing to do at all). `fallback`: a
 * benchmark's own restore_model, for one created before the queue-wide record existed.
 */
export function settleRestore(db: Database.Database, mm?: Pick<ModelManager, 'state' | 'ensureLoaded'>, fallback?: string | null): string | null {
  const target = getSetting(db, 'bench_restore_model') || fallback || '';
  if (!target) return null;
  if (activeBenchmark(db) || queuedScreens(db) > 0) return null;
  setSetting(db, 'bench_restore_model', '');
  if (activeLocalRunCount(db) !== 0) {
    // someone's own local work has the GPU now: its model stays
    logEvent(db, { kind: 'note', detail: `評比／快篩都結束了；本地任務正在跑，不切回 ${target}` });
    return null;
  }
  const manager = mm ?? getModelManager(db);
  if (manager.state().loaded === target) return null;
  const r = manager.ensureLoaded(target);
  logEvent(db, { kind: 'note', detail: `評比／快篩都結束了：切回 ${target}（${r}）` });
  return target;
}

/**
 * A 快篩 row whose model vLLM failed to start after the row began: that is its result. Without
 * this the row would wait through retry after retry, holding every later row and benchmark.
 */
export function failUnloadableScreens(db: Database.Database, mm: Pick<ModelManager, 'state'>): string[] {
  const st = mm.state();
  if (st.status !== 'error' || !st.wanted) return [];
  const failedAt = Date.parse(st.since ?? '');
  const rows = db
    .prepare(
      `SELECT b.id, b.screen_group, a.model, a.task_id, t.status AS task_status, t.created_at
         FROM benchmarks b JOIN benchmark_arms a ON a.benchmark_id = b.id JOIN tasks t ON t.id = a.task_id
        WHERE b.mode = 'screen' AND b.status = 'running'`,
    )
    .all() as Array<{ id: string; screen_group: string | null; model: string; task_id: string; task_status: string; created_at: string }>;
  const failed: string[] = [];
  for (const r of rows) {
    if (r.task_status !== 'queued' || !isLocalModel(r.model) || localId(r.model) !== st.wanted) continue;
    const startedAt = Date.parse(`${r.created_at.replace(' ', 'T')}Z`);
    if (!(failedAt >= startedAt)) continue; // a failure from before this row began: the tick tries again
    setStatus(db, r.task_id, 'failed', { detail: `模型載入失敗：${st.error ?? '沒有說明'}` });
    logEvent(db, { task_id: r.task_id, kind: 'note', detail: `模型快篩 ${r.screen_group}: ${r.model} 載入失敗，這題記為沒過` });
    failed.push(r.id);
  }
  return failed;
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
