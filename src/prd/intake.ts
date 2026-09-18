import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getBool, getSetting, logEvent } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { validateTask, type GateResult } from '../gate/validateTask.js';
import { isModelValue } from '../settings.js';
import { isLocalModel } from '../local/models.js';
import { createBenchmark, type Benchmark, type BenchmarkArmView } from '../benchmark/store.js';
import { lintPrd, type LintDeps, type PrdFields } from './lint.js';
import { reviewPrd, type PrdReviewExec } from './review.js';
import type { Task } from '../types.js';

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

function writePlanFile(markdown: string, title: string): string {
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

export async function submitPrd(db: Database.Database, markdown: string, opts: SubmitOptions = {}): Promise<SubmitResult> {
  const model = opts.benchmark_models?.length ? null : resolvePrdModel(db, opts.model); // validate before any write
  const check = await checkPrd(db, markdown, opts);
  if (!check.ok) return { ok: false, check };
  const f = check.fields;
  const title = f.title!;
  const planRef = writePlanFile(markdown, title);
  // the human checklist rides along in the rubric so both the llm judge and VERIFY.md see it
  const rubric = [
    ...f.acceptance.map((a) => `- ${a}`),
    ...(f.manual_checks.length ? ['', '人工驗收：', ...f.manual_checks.map((m) => `- ${m}`)] : []),
  ].join('\n');
  const common = {
    title,
    goal: f.goal,
    plan_ref: planRef,
    repo_path: f.repo_path,
    base_branch: f.base_branch ?? 'main',
    verification_steps: f.verify_steps,
    verify_rubric: rubric,
    complexity: f.complexity ?? 'M',
  };

  if (opts.benchmark_models?.length) {
    const { benchmark, arms } = createBenchmark(db, {
      ...common,
      domain: f.domain ?? 'other',
      models: opts.benchmark_models,
      judge_models: opts.judge_models,
      setup_cmd: f.setup_steps?.length ? f.setup_steps.join(' && ') : null,
      source_kind: 'draft',
    });
    logEvent(db, { kind: 'note', detail: `PRD intake: benchmark ${benchmark.id} from ${path.basename(planRef)}` });
    return { ok: true, kind: 'benchmark', check, plan_ref: planRef, benchmark, arms };
  }

  // verify_mode follows what the PRD actually provides: commands → command, a human checklist →
  // manual, an explicit 驗證方式 section wins. 圖集比對 implies the GPU (the IP pipeline is CUDA);
  // an unmet capability makes the engine skip command verification and defer to a human.
  const modes = new Set(
    f.verify_mode ?? [...(f.verify_steps.length ? ['command'] : []), ...(f.manual_checks.length ? ['manual'] : [])],
  );
  if (opts.verify_llm) modes.add('llm');
  if (modes.size === 0) modes.add('command');
  const created = createTask(db, {
    ...common,
    plan_kind: 'md',
    coding_tool: 'claude-code',
    model,
    verify_mode: [...modes].join(','),
    requires: f.requires ?? (f.dataset ? 'gpu' : null),
    setup_cmd: f.setup_steps.length ? f.setup_steps.join(' && ') : null,
    created_by: 'prd',
  });
  const gate = validateTask(created, getSetting(db, 'host_capabilities') ?? '');
  if (gate.ok && opts.queue !== false) setStatus(db, created.id, 'queued', { detail: 'queued from PRD intake' });
  return { ok: true, kind: 'task', check, plan_ref: planRef, task: getTask(db, created.id)!, gate };
}
