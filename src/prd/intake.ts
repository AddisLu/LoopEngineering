import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths, type Complexity } from '../config.js';
import { getBool, getSetting, logEvent } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { validateTask, type GateResult } from '../gate/validateTask.js';
import { isModelValue } from '../settings.js';
import { isLocalModel } from '../local/models.js';
import { createBenchmark, type Benchmark, type BenchmarkArmView } from '../benchmark/store.js';
import { lintPrd, type LintDeps, type PrdFields } from './lint.js';
import { reviewPrd, type PrdReviewExec } from './review.js';
import type { Task } from '../types.js';
import { markSubmitted } from './drafts.js';
import { linkDraftTask } from '../chat/store.js';

/**
 * PRD intake: check = deterministic lint + local-model review; submit = check again, persist the
 * PRD as the plan file, then create a queued task (or a benchmark) from its fields. Shared by the
 * API (prdRoutes.ts), the CLI (`loop prd`) and the MCP server.
 */

export interface PrdCheck {
  ok: boolean;
  missing: string[];
  warnings: string[];
  fields: PrdFields;
  llm: {
    status: 'ok' | 'unavailable' | 'error' | 'skipped';
    ok: boolean | null;
    /** why the review failed (status 'error': truncated / unparseable / HTTP) */
    error?: string;
    missing: string[];
    questions: string[];
    risk_notes: string[];
  };
}

export class PrdInputError extends Error {}

export interface PrdOptions {
  exec?: PrdReviewExec;
  lintDeps?: LintDeps;
}

export async function checkPrd(db: Database.Database, markdown: string, opts: PrdOptions = {}): Promise<PrdCheck> {
  const lint = lintPrd(markdown, opts.lintDeps);
  let llm: PrdCheck['llm'] = { status: 'skipped', ok: null, missing: [], questions: [], risk_notes: [] };
  // Only review a structurally complete PRD — a model review of a skeleton is noise.
  if (lint.ok) {
    const r = await reviewPrd(db, markdown, lint, opts.exec);
    if (r === null) llm = { ...llm, status: 'unavailable' };
    else if ('error' in r) llm = { ...llm, status: 'error', error: r.error };
    else llm = { status: 'ok', ...r };
  }
  const requireLlm = getBool(db, 'prd_require_llm', false);
  const missing = [...lint.missing];
  const warnings = [...lint.warnings];
  if (llm.status === 'error' && !requireLlm) {
    warnings.push(`本地模型審查失敗：${llm.error}（未擋下；設 prd_require_llm=true 可改為擋下）`);
  }
  if (llm.status === 'ok' && llm.ok === false) {
    missing.push(...(llm.missing.length ? llm.missing.map((m) => `審查：${m}`) : ['審查：本地模型判定這份 PRD 無法可靠實作（見問題清單）']));
  }
  if (lint.ok && requireLlm && llm.status === 'unavailable') {
    missing.push('本地模型審查無法執行（模型未載入？），而 prd_require_llm=true');
  }
  if (lint.ok && requireLlm && llm.status === 'error') {
    missing.push(`本地模型審查失敗（prd_require_llm=true）：${llm.error}`);
  }
  return { ok: missing.length === 0, missing, warnings, fields: lint.fields, llm };
}

export interface SubmitOptions extends PrdOptions {
  /** also run the cloud `claude -p` judge against the acceptance rubric (spends token) */
  verify_llm?: boolean;
  /** Implementation model; default prd_default_model, else default_model when it is local:<id>. */
  model?: string | null;
  /** false = leave the task as a draft. */
  queue?: boolean;
  /** 2+ models: create a benchmark from the PRD instead of a single task. */
  benchmark_models?: string[];
  /** several cloud judges for the benchmark branch (defaults to bench_judge_model) */
  judge_models?: string[];
  /** the 驗證方案 a 新工作 was composed from (kept on the task for the record) */
  verify_plan_id?: string | null;
  /** 'plan': an epic — the planner splits the PRD into a chain of subtasks instead of one task */
  coding_tool?: 'claude-code' | 'plan';
  /** a check already made on exactly this markdown (the caller vouches for that): skips reviewing it twice */
  precheck?: PrdCheck;
  /** who asked for it (tasks.created_by / owner / source_ref); defaults to the PRD intake itself */
  created_by?: string;
  owner?: string | null;
  source_ref?: string | null;
}

export type SubmitResult =
  | { ok: false; check: PrdCheck }
  | { ok: true; kind: 'task'; check: PrdCheck; plan_ref: string; task: Task; gate: GateResult }
  | { ok: true; kind: 'benchmark'; check: PrdCheck; plan_ref: string; benchmark: Benchmark; arms: BenchmarkArmView[] };

export function resolvePrdModel(db: Database.Database, explicit?: string | null): string | null {
  const pick = explicit?.trim();
  if (pick) {
    if (!isModelValue(pick)) throw new PrdInputError(`invalid model: ${pick}`);
    return pick;
  }
  const prdDefault = getSetting(db, 'prd_default_model')?.trim();
  if (prdDefault) return prdDefault;
  const def = getSetting(db, 'default_model')?.trim();
  return isLocalModel(def) ? def : null; // null = the task inherits default_model at dispatch
}

/** Persists the PRD as a plan file under plansDir (the task's plan_ref) and returns its path. */
export function writePlanFile(markdown: string, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'prd';
  fs.mkdirSync(paths.plansDir, { recursive: true });
  const file = path.join(paths.plansDir, `prd-${slug}-${Date.now()}.md`);
  fs.writeFileSync(file, markdown);
  return file;
}

/** The task columns a PRD decides (taskFieldsFromPrd): what submitPrd creates and applyPrdToTask updates. */
export interface PrdTaskFields {
  title: string;
  goal: string;
  plan_ref: string;
  repo_path: string | null;
  base_branch: string;
  verification_steps: string[];
  verify_rubric: string;
  complexity: Complexity;
  verify_mode: string;
  requires: string | null;
  setup_cmd: string | null;
  acceptance_metrics: string | null;
  protected_paths: string | null;
  artifacts: string | null;
  /** the PRD's 領域 (BENCH_DOMAINS), null when it has none */
  domain: string | null;
}

/**
 * The PRD's fields → the task columns: rubric (acceptance + metrics + the human checklist),
 * verify_mode, requires, setup, metrics, protected paths, artifacts. Pure; shared by submitPrd
 * (create) and the 問題單 analysis (applyPrdToTask, update).
 */
export function taskFieldsFromPrd(f: PrdFields, planRef: string, opts: { verify_llm?: boolean } = {}): PrdTaskFields {
  // the human checklist rides along in the rubric so both the llm judge and VERIFY.md see it
  const rubric = [
    ...f.acceptance.map((a) => `- ${a}`),
    ...(f.acceptance_metrics ? ['', `驗收指標（引擎自動檢查）：${f.acceptance_metrics}`] : []),
    ...(f.manual_checks.length ? ['', '人工驗收：', ...f.manual_checks.map((m) => `- ${m}`)] : []),
  ].join('\n');
  // verify_mode follows what the PRD actually provides: commands → command, a human checklist →
  // manual, an explicit 驗證方式 section wins. 圖集比對 implies the GPU (the IP pipeline is CUDA);
  // an unmet capability makes the engine skip command verification and defer to a human.
  const modes = new Set(
    f.verify_mode ?? [...(f.verify_steps.length ? ['command'] : []), ...(f.manual_checks.length ? ['manual'] : [])],
  );
  if (opts.verify_llm) modes.add('llm');
  if (modes.size === 0) modes.add('command');
  return {
    title: f.title ?? '',
    goal: f.goal,
    plan_ref: planRef,
    repo_path: f.repo_path,
    base_branch: f.base_branch ?? 'main',
    verification_steps: f.verify_steps,
    verify_rubric: rubric,
    complexity: f.complexity ?? 'M',
    verify_mode: [...modes].join(','),
    // a local image set needs this machine's GPU; one on a sandbox host is measured over there
    requires: f.requires ?? (f.dataset && !f.dataset.host ? 'gpu' : null),
    setup_cmd: f.setup_steps.length ? f.setup_steps.join(' && ') : null,
    acceptance_metrics: f.acceptance_metrics,
    protected_paths: f.protected_paths.length ? f.protected_paths.join(',') : null,
    artifacts: f.artifacts.length ? f.artifacts.join(',') : null,
    domain: f.domain,
  };
}

/**
 * The "update half" of submitPrd: an existing DRAFT task takes the PRD's fields (a 問題單 whose
 * analysis just composed its PRD). Status, model, priority, owner and the ticket columns are left
 * alone; an empty title / goal keeps the current one. Throws PrdInputError for a missing or
 * non-draft task.
 */
export function applyPrdToTask(db: Database.Database, taskId: string, fields: PrdTaskFields): Task {
  const cur = getTask(db, taskId);
  if (!cur) throw new PrdInputError(`task not found: ${taskId}`);
  if (cur.status !== 'draft') throw new PrdInputError(`task ${taskId} is ${cur.status} — only a draft takes a PRD`);
  db.prepare(
    `UPDATE tasks SET title = @title, goal = @goal, plan_ref = @plan_ref, plan_kind = 'md', repo_path = @repo_path,
       base_branch = @base_branch, verification_steps = @verification_steps, verify_rubric = @verify_rubric,
       complexity = @complexity, verify_mode = @verify_mode, requires = @requires, setup_cmd = @setup_cmd,
       acceptance_metrics = @acceptance_metrics, protected_paths = @protected_paths, artifacts = @artifacts,
       domain = @domain, updated_at = datetime('now')
     WHERE id = @id AND status = 'draft'`,
  ).run({
    id: taskId,
    title: fields.title.trim() || cur.title,
    goal: fields.goal.trim() || cur.goal,
    plan_ref: fields.plan_ref,
    repo_path: fields.repo_path,
    base_branch: fields.base_branch,
    verification_steps: JSON.stringify(fields.verification_steps),
    verify_rubric: fields.verify_rubric || null,
    complexity: fields.complexity,
    verify_mode: fields.verify_mode.trim() || 'command',
    requires: fields.requires?.trim() || null,
    setup_cmd: fields.setup_cmd?.trim() || null,
    acceptance_metrics: fields.acceptance_metrics?.trim() || null,
    protected_paths: fields.protected_paths?.trim() || null,
    artifacts: fields.artifacts?.trim() || null,
    domain: fields.domain?.trim() || null,
  });
  return getTask(db, taskId)!;
}

export async function submitPrd(db: Database.Database, markdown: string, opts: SubmitOptions = {}): Promise<SubmitResult> {
  const model = opts.benchmark_models?.length ? null : resolvePrdModel(db, opts.model); // validate before any write
  const check = opts.precheck ?? (await checkPrd(db, markdown, opts));
  if (!check.ok) return { ok: false, check };
  const f = check.fields;
  const title = f.title!;
  const planRef = writePlanFile(markdown, title);
  const tf = taskFieldsFromPrd(f, planRef, { verify_llm: opts.verify_llm });
  const common = {
    title: tf.title,
    goal: tf.goal,
    plan_ref: tf.plan_ref,
    repo_path: tf.repo_path,
    base_branch: tf.base_branch,
    verification_steps: tf.verification_steps,
    verify_rubric: tf.verify_rubric,
    complexity: tf.complexity,
  };

  if (opts.benchmark_models?.length) {
    const { benchmark, arms } = createBenchmark(db, {
      ...common,
      domain: tf.domain ?? 'other',
      models: opts.benchmark_models,
      judge_models: opts.judge_models,
      setup_cmd: tf.setup_cmd,
      source_kind: 'draft',
      acceptance_metrics: tf.acceptance_metrics,
      protected_paths: tf.protected_paths,
    });
    logEvent(db, { kind: 'note', detail: `PRD intake: benchmark ${benchmark.id} from ${path.basename(planRef)}` });
    return { ok: true, kind: 'benchmark', check, plan_ref: planRef, benchmark, arms };
  }

  const created = createTask(db, {
    ...common,
    plan_kind: 'md',
    coding_tool: opts.coding_tool === 'plan' ? 'plan' : 'claude-code',
    model,
    verify_mode: tf.verify_mode,
    requires: tf.requires,
    setup_cmd: tf.setup_cmd,
    created_by: opts.created_by ?? 'prd',
    owner: opts.owner ?? null,
    source_ref: opts.source_ref ?? null,
    acceptance_metrics: tf.acceptance_metrics,
    protected_paths: tf.protected_paths,
    artifacts: tf.artifacts,
    verify_plan_id: opts.verify_plan_id ?? null,
    domain: tf.domain,
  });
  const gate = validateTask(created, getSetting(db, 'host_capabilities') ?? '');
  if (gate.ok && opts.queue !== false) setStatus(db, created.id, 'queued', { detail: 'queued from PRD intake' });
  return { ok: true, kind: 'task', check, plan_ref: planRef, task: getTask(db, created.id)!, gate };
}

/**
 * A 工作流程 draft that was submitted remembers what it became, so the draft list shows 已送出 and
 * the chat answer it came from shows 已建任務. Best-effort: a foreign draft changes nothing.
 */
export function linkSubmittedDraft(db: Database.Database, userKey: string, draftId: string, r: SubmitResult): void {
  if (!r.ok) return;
  if (r.kind === 'benchmark') {
    db.prepare('UPDATE benchmarks SET source_ref = ? WHERE id = ?').run(draftId, r.benchmark.id);
    markSubmitted(db, userKey, draftId, r.benchmark.id);
    return;
  }
  markSubmitted(db, userKey, draftId, r.task.id);
  linkDraftTask(db, draftId, r.task.id);
}
