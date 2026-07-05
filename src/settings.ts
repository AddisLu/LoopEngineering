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
  'age_step_min', 'starve_min',
]);
// Phase 3 feature flags: stored as 'true'/'false'.
export const BOOL_KEYS = new Set([
  'scheduler_paused',
  'window_checkpoint', 'weekly_packing', 'concurrency_reserve', 'priority_aging',
  'dep_auto_queue',
  // git close-out flags
  'git_fetch_base', 'auto_push_branch', 'auto_merge', 'merge_conflict_task',
  // self-update / dependency-release flags
  'self_update', 'dep_done_on_merge',
]);

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
  } else if (key === 'day_window') {
    if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(value)) return 'day_window must be HH:MM-HH:MM (e.g. 08:00-23:00)';
  } else if (BOOL_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') return `${key} must be true or false`;
  } else if (key === 'default_model') {
    if (!MODEL_VALUES.has(value)) return `default_model must be one of: ${[...MODEL_VALUES].filter(Boolean).join(', ')} (or empty for CLI default)`;
  }
  return null;
}
