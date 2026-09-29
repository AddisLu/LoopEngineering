// Shared settings metadata + validation, used by the CLI (`loop config`) and the
// board settings panel (GET/POST /api/settings). One source of truth so both agree.
import { parseMcpServers } from './mcp/config.js';
import { parseDataMounts } from './exec/hosts.js';

export const PERCENT_KEYS = new Set([
  'day_session_max', 'day_weekly_max', 'night_session_max', 'night_weekly_max',
  'hard_limit_pct', 'warn_margin_pct', 'safety_reserve_pct', 'est_pct_S', 'est_pct_M', 'est_pct_L',
  'est_weekly_pct_S', 'est_weekly_pct_M', 'est_weekly_pct_L',
]);
export const NONNEG_KEYS = new Set([
  'max_concurrency', 'poll_interval_sec', 'min_runway_min', 'max_resumes', 'max_autoqueue',
  'timeout_S', 'timeout_M', 'timeout_L', 'usage_refresh_sec', 'ledger_fallback_after_min',
  'chat_context_turns', 'chat_retention_days', 'chat_escalate_timeout_ms', 'local_spark_nodes',
  'chat_tool_max_rounds', 'chat_tool_timeout_ms', 'chat_tool_wall_ms', 'chat_tool_result_chars', 'chat_fetch_max_bytes',
  'terminal_idle_min', 'terminal_max_sessions', 'terminal_scrollback_kb', 'mcp_timeout_ms', 'chat_tool_schema_chars',
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
  // report generation D (PPTX)
  'report_pptx_timeout_ms',
  // 本地模型 (src/local/*.ts)
  'local_max_concurrency', 'local_switch_timeout_sec', 'local_switch_retry_min', 'local_timeout_multiplier',
  // benchmark mode
  'bench_diff_cap_chars', 'bench_judge_timeout_ms',
  // PRD gate
  'local_chat_timeout_ms',
  // GPU 執行沙盒 (src/exec/sandbox.ts)
  'exec_pids', 'exec_timeout_sec', 'exec_max_timeout_sec', 'exec_max_concurrency', 'exec_output_chars',
  'exec_chat_max_rounds', 'exec_chat_wall_ms',
]);
// values must be a number in [0, 1] (a fraction/weight, unlike the 0-100 PERCENT_KEYS)
export const UNIT_INTERVAL_KEYS = new Set(['rag_hybrid_alpha']);
// Phase 3 feature flags: stored as 'true'/'false'.
export const BOOL_KEYS = new Set([
  'chat_history_enabled', 'chat_escalate_enabled', 'chat_share_enabled', 'chat_tools_enabled', 'terminal_enabled', 'terminal_worktree', 'chat_mcp_enabled', 'task_mcp_enabled',
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
  // report generation D (scripts/report_pptx.py, src/report/pptx/*.ts) — off = `loop
  // report pptx *` stays fail-fast disabled
  'report_pptx_enabled',
  // report generation D continued (src/report/pptx/{status,quality}.ts, T3) — quality
  // gate on by default; explain_agent only registered, not wired to auto-dispatch yet
  'report_pptx_judge', 'report_pptx_explain_agent',
  // 本地模型 (src/local/*.ts) — off = local:<id> tasks stay queued, no docker/vLLM access
  'local_models_enabled', 'local_gap_review',
  // benchmark mode (src/benchmark/*.ts)
  'benchmark_enabled',
  // PRD gate (src/prd/*.ts)
  'prd_gate_enabled', 'prd_require_llm',
  // GPU 執行沙盒 (src/exec/sandbox.ts) — off = no sandbox tools, no loop-exec MCP server
  'exec_enabled', 'exec_profiling_cap',
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
  // 本地模型
  'local_models_enabled', 'local_max_concurrency', 'local_spark_nodes', 'local_task_window',
  // 晨報
  'morning_report_time',
  // benchmark mode
  'benchmark_enabled', 'bench_judge_model',
  // PRD gate
  'prd_gate_enabled', 'prd_require_llm', 'prd_default_model', 'prd_repo_allowlist',
] as const;

/** Accepted model aliases for coding runs ('' / 'default' = the claude CLI default). */
export const MODEL_VALUES = new Set(['', 'default', 'sonnet', 'opus', 'haiku', 'fable', 'fable-5']);

/** 本地模型 reference for implementation runs: 'local:<registered id>' (src/local/models.ts). */
export const LOCAL_MODEL_RE = /^local:[A-Za-z0-9][\w.-]*$/;

/** External models allowed to judge a benchmark (src/benchmark/judge.ts). */
export const BENCH_JUDGE_MODELS = new Set(['opus', 'fable', 'fable-5', 'sonnet']);

/** A cloud alias or a local model — valid for default_model / route_* / task.model. */
export function isModelValue(value: string): boolean {
  return MODEL_VALUES.has(value) || LOCAL_MODEL_RE.test(value);
}

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
  } else if (key === 'local_task_window') {
    const m = value.match(/^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d|24:00)$/);
    if (value !== '' && (!m || m[1] === m[2])) return 'local_task_window must be HH:MM-HH:MM (e.g. 19:00-07:00, may wrap midnight) or empty for any time';
  } else if (key === 'morning_report_time') {
    if (value !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return 'morning_report_time must be HH:MM (e.g. 08:00) or empty for no push';
  } else if (BOOL_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') return `${key} must be true or false`;
  } else if (key === 'default_model' || key === 'route_S' || key === 'route_M' || key === 'route_L') {
    // implementation runs may also target a local vLLM model ('local:<id>')
    if (!isModelValue(value)) return `${key} must be one of: ${[...MODEL_VALUES].filter(Boolean).join(', ')}, local:<id> (or empty for CLI default)`;
  } else if (key === 'voice_structure_model' || key === 'report_model' || key === 'report_pptx_model') {
    // these call `claude -p` directly — cloud aliases only
    if (!MODEL_VALUES.has(value)) return `${key} must be one of: ${[...MODEL_VALUES].filter(Boolean).join(', ')} (or empty for CLI default)`;
  } else if (key === 'spike_root') {
    if (!value.startsWith('/') && !value.startsWith('~')) return 'spike_root must be an absolute path';
  } else if (key === 'mcp_servers_json') {
    try {
      parseMcpServers(value);
    } catch (err) {
      return (err as Error).message;
    }
  } else if (key === 'office_python') {
    if (value !== '' && !value.startsWith('/')) return 'office_python must be an absolute path (or empty to auto-detect)';
  } else if (key === 'terminal_cwd') {
    if (value !== '' && !value.startsWith('/')) return 'terminal_cwd must be an absolute path (or empty for the home directory)';
  } else if (key === 'terminal_worktree_root') {
    if (value !== '' && !value.startsWith('/')) return 'terminal_worktree_root must be an absolute path';
  } else if (key === 'terminal_allowed_users' || key === 'exec_allowed_users') {
    const bad = value.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => !/^(ts:\S+|name:\S+|local)$/i.test(s));
    if (bad.length) return `${key} entries must be ts:<login>, name:<name> or local (got: ${bad.join(', ')})`;
  } else if (key === 'gitea_url') {
    if (value !== '' && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(value)) return 'gitea_url must be an http(s) URL (e.g. http://gitea.corp:3000) or empty';
  } else if (key === 'exec_default_host') {
    if (value !== '' && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) return 'exec_default_host must be empty, local, or an exec host name';
  } else if (key === 'exec_data_mounts') {
    try {
      parseDataMounts(value);
    } catch (err) {
      return `exec_data_mounts: ${(err as Error).message}`;
    }
  } else if (key === 'exec_image') {
    if (!/^[\w][\w./:@-]*$/.test(value)) return 'exec_image must be a docker image reference, e.g. nvidia/cuda:13.0.3-devel-ubuntu24.04';
  } else if (key === 'exec_gpus') {
    if (value !== '' && !/^[\w=,:"-]+$/.test(value)) return "exec_gpus must be a docker --gpus value (all, 1, device=0, ...) or empty for no GPU";
  } else if (key === 'exec_memory') {
    if (!/^\d+(\.\d+)?[bkmg]?$/i.test(value)) return 'exec_memory must be a docker memory size, e.g. 16g or 8192m';
  } else if (key === 'exec_cpus') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 'exec_cpus must be a positive number';
  } else if (key === 'chat_search_url') {
    if (value !== '' && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(value)) return 'chat_search_url must be an http(s) URL or empty';
  } else if (key === 'prd_repo_allowlist') {
    const bad = value.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => !s.startsWith('/'));
    if (bad.length) return `prd_repo_allowlist entries must be absolute paths (got: ${bad.join(', ')})`;
  } else if (key === 'prd_default_model') {
    if (value !== '' && !isModelValue(value)) return `prd_default_model must be empty, a model alias or local:<id>`;
  } else if (key === 'bench_judge_model' || key === 'chat_escalate_model') {
    if (!BENCH_JUDGE_MODELS.has(value)) return `${key} must be one of: ${[...BENCH_JUDGE_MODELS].join(', ')}`;
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
