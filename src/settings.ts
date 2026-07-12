// Shared settings metadata + validation, used by the CLI (`loop config`) and the
// board settings panel (GET/POST /api/settings). One source of truth so both agree.

export const PERCENT_KEYS = new Set([
  'day_session_max', 'day_weekly_max', 'night_session_max', 'night_weekly_max',
  'hard_limit_pct', 'warn_margin_pct', 'safety_reserve_pct', 'est_pct_S', 'est_pct_M', 'est_pct_L',
  'est_weekly_pct_S', 'est_weekly_pct_M', 'est_weekly_pct_L',
]);
export const NONNEG_KEYS = new Set([
  'max_concurrency', 'poll_interval_sec', 'min_runway_min', 'max_resumes', 'max_autoqueue',
  'timeout_S', 'timeout_M', 'timeout_L', 'usage_refresh_sec', 'ledger_fallback_after_min',
  'age_step_min', 'starve_min', 'knowledge_budget_chars', 'verify_step_timeout_min',
  'voice_worker_idle_min',
  // SSoT/RAG Phase 0
  'embed_dim', 'rag_top_k', 'embed_worker_idle_min',
  // SSoT/RAG Phase 1
  'ingest_max_file_kb',
  // SSoT/RAG Phase 4
  'ingest_pump_interval_min',
  // report generation A
  'report_budget_chars', 'report_timeout_ms',
]);
// values must be a number in [0, 1] (a fraction/weight, unlike the 0-100 PERCENT_KEYS)
export const UNIT_INTERVAL_KEYS = new Set(['rag_hybrid_alpha']);
// Phase 3 feature flags: stored as 'true'/'false'.
export const BOOL_KEYS = new Set([
  'scheduler_paused',
  'window_checkpoint', 'weekly_packing', 'concurrency_reserve', 'priority_aging',
  'dep_auto_queue',
  // git close-out flags
  'git_fetch_base', 'auto_push_branch', 'auto_merge', 'merge_conflict_task',
  // self-update / dependency-release flags
  'self_update', 'dep_done_on_merge',
  // knowledge base
  'knowledge_inject', 'knowledge_distill',
  // execution-discipline prompt (experimental, opt-in)
  'prompt_discipline',
  // SDD Phase 2: per-child self-contained specs from the epic planner (opt-in)
  'sdd_specs',
  // SDD Phase 3: per-complexity model routing (opt-in)
  'model_routing',
  // ADO/GitHub integration bridge
  'integration_pushback',
  // mobile voice -> task intake
  'voice_intake_enabled', 'voice_warm_worker',
  // SSoT/RAG Phase 0 (src/knowledge/{vec,embed}.ts) — off = zero behavior change
  'rag_enabled',
  // SSoT/RAG Phase 2 (src/knowledge/context.ts) — off = zero LOOP_TASK.md change
  'rag_inject_task_context',
  // SSoT/RAG Phase 4 (src/knowledge/ingest/pump.ts) — off = no periodic auto re-ingest
  'ingest_auto_pump',
  // report generation A (src/report/*.ts) — off = POST /api/report stays disabled
  'report_enabled', 'report_live_first',
  // report generation C (src/report/persist.ts) — off = never writes report files to disk
  'report_persist',
]);

/** Accepted `integration_provider` values ('none' = the bridge is fully off). */
export const INTEGRATION_PROVIDER_VALUES = new Set(['none', 'github', 'ado']);

/** Documented `agent_backend` ids (see src/orchestrator/adapters/registry.ts).
 * 'copilot-cli' is reserved — no adapter ships for it yet. Unlike
 * INTEGRATION_PROVIDER_VALUES, an unknown value here is NOT hard-blocked (only
 * warned): getBackend() falls back to 'claude-code' at dispatch time regardless. */
export const AGENT_BACKEND_VALUES = new Set(['claude-code', 'copilot-cli']);

/** Accepted `shell` values (see src/util/shell.ts resolveShell). */
export const SHELL_VALUES = new Set(['auto', 'bash', 'powershell', 'cmd', 'git-bash']);

/** Keys the board settings panel reads/writes (the budget/scheduling knobs). */
export const TUNABLE_KEYS = [
  'day_window',
  'day_session_max', 'day_weekly_max',
  'night_session_max', 'night_weekly_max',
  'hard_limit_pct', 'min_runway_min', 'max_concurrency',
  // git close-out (Git 收尾) group
  'git_fetch_base', 'auto_push_branch', 'auto_merge', 'merge_conflict_task',
  // execution model
  'default_model',
  // per-complexity model routing (SDD Phase 3, opt-in)
  'model_routing', 'route_S', 'route_M', 'route_L',
  // execution-discipline prompt (experimental, opt-in)
  'prompt_discipline',
  // mobile voice -> task intake
  'voice_intake_enabled',
] as const;

/** Accepted model aliases for coding runs ('' / 'default' = the claude CLI default). */
export const MODEL_VALUES = new Set(['', 'default', 'sonnet', 'opus', 'haiku', 'fable', 'fable-5']);

/** Light validation for the settings people actually tune; unknown keys pass through. */
export function validateSetting(key: string, value: string): string | null {
  if (PERCENT_KEYS.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) return `${key} must be a number between 0 and 100`;
  } else if (NONNEG_KEYS.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return `${key} must be a non-negative number`;
  } else if (UNIT_INTERVAL_KEYS.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) return `${key} must be a number between 0 and 1`;
  } else if (key === 'day_window') {
    if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(value)) return 'day_window must be HH:MM-HH:MM (e.g. 08:00-23:00)';
  } else if (BOOL_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') return `${key} must be true or false`;
  } else if (
    key === 'default_model' || key === 'voice_structure_model' || key === 'report_model' ||
    key === 'route_S' || key === 'route_M' || key === 'route_L'
  ) {
    if (!MODEL_VALUES.has(value)) return `${key} must be one of: ${[...MODEL_VALUES].filter(Boolean).join(', ')} (or empty for CLI default)`;
  } else if (key === 'integration_provider') {
    if (!INTEGRATION_PROVIDER_VALUES.has(value)) return `integration_provider must be one of: ${[...INTEGRATION_PROVIDER_VALUES].join(', ')}`;
  } else if (key === 'agent_backend') {
    if (!AGENT_BACKEND_VALUES.has(value)) {
      console.warn(`warning: agent_backend '${value}' is not a recognized backend id (known: ${[...AGENT_BACKEND_VALUES].join(', ')}) — dispatch falls back to claude-code`);
    }
  } else if (key === 'shell') {
    if (!SHELL_VALUES.has(value)) return `shell must be one of: ${[...SHELL_VALUES].join(', ')}`;
  }
  return null;
}
