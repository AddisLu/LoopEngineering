import type { Complexity, TaskStatus } from './config.js';

export interface Task {
  id: string;
  title: string;
  goal: string;
  plan_ref: string | null;
  plan_kind: 'md' | 'html' | 'url' | null;
  coding_tool: string;
  verification_steps: string; // JSON array (stored)
  setup_cmd: string | null;
  repo_path: string | null;
  base_branch: string | null;
  complexity: Complexity;
  priority: number;
  model: string | null;
  timeout_min: number | null;
  depends_on: string | null;
  verify_mode: string;
  verify_rubric: string | null;
  verify_timeout_min: number | null;
  requires: string | null;
  status: TaskStatus;
  resume_count: number;
  pr_url: string | null;
  review_md_path: string | null;
  est_session_pct: number | null;
  merge_status: string | null;
  parent_task_id: string | null;
  parent_id: string | null; // epic hierarchy: this task's parent epic (coding_tool='plan'), distinct from depends_on (ordering) and parent_task_id (merge-conflict lineage)
  pipeline_id: string | null; // delivery pipeline: shared id across a template's materialized stage tasks (see src/pipeline/materialize.ts)
  stage_name: string | null; // delivery pipeline: this task's stage name within its pipeline_id (e.g. "implement", "deploy-home")
  source_ref: string | null; // ADO/GitHub bridge: 'provider:repo#id' or 'provider:id' this task was imported from (see src/integrations/)
  environment: string | null;
  owner: string | null; // team-prep: unused passthrough, reserves the multi-user path
  created_by: string | null; // team-prep: unused passthrough, reserves the multi-user path
  experiment: string | null; // A/B cohort label (SDD Phase 1); write-only from intake, read only by metrics.experiment_ab
  benchmark_id: string | null; // benchmark mode: this task is one arm of benchmarks.id (never integrates; judged)
  acceptance_metrics?: string | null; // 驗收指標: e.g. "detection_rate >= 0.98; miss == 0" (src/orchestrator/acceptance.ts)
  protected_paths?: string | null; // 保護路徑: CSV globs the agent must not change (e.g. scripts/eval/**)
  created_at: string;
  updated_at: string;
}

export interface TaskRun {
  id: string;
  task_id: string;
  resume_of: string | null;
  attempt: number;
  session_id: string | null;
  pid: number | null;
  worktree_path: string | null;
  branch: string | null;
  log_path: string | null;
  exit_code: number | null;
  error: string | null;
  interrupted_by: string | null;
  usage_json: string | null;
  session_pct_before: number | null;
  session_pct_after: number | null;
  weekly_pct_before: number | null;
  weekly_pct_after: number | null;
  dispatch_window: string | null;
  discipline: number | null;
  model: string | null; // SDD Phase 4: resolved model at dispatch, for model-aware cost calibration
  tokens_in: number | null; // 本地模型: tokens parsed from the adapter stream (null = not reported)
  tokens_out: number | null;
  backend: string | null; // adapter that ran it: claude-code | opencode | mock
  verify_json?: string | null; // last verification: [{step, ok, exitCode, timedOut, tail}] (+ skipped note)
  metrics_json?: string | null; // last metrics: {values, checks[{name, op, target, actual, pass}], pass}
  started_at: string;
  finished_at: string | null;
}

/** Normalized reading returned by TokenBar's usage-core (and our port). */
export interface UsageReading {
  ok: boolean;
  subscription: string | null;
  fetchedAt: string;
  session: UsageLimit;
  weekly: UsageLimit;
  source: 'api' | 'cache' | 'ledger';
  error?: string;
}

export interface UsageLimit {
  percent: number;
  resetsAt: string | null;
  resetsInMinutes: number | null;
  severity: string;
}

export function parseSteps(task: Pick<Task, 'verification_steps'>): string[] {
  try {
    const arr = JSON.parse(task.verification_steps);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** Parsed verify_mode CSV, defaulting to {'command'} when null/empty (zero behavior change). */
export function parseVerifyMode(task: Pick<Task, 'verify_mode'>): Set<string> {
  const modes = (task.verify_mode ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(modes.length ? modes : ['command']);
}
