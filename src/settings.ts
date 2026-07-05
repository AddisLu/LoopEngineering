// Shared settings metadata + validation, used by the CLI (`loop config`) and the
// board settings panel (GET/POST /api/settings). One source of truth so both agree.

export const PERCENT_KEYS = new Set([
  'day_session_max', 'day_weekly_max', 'night_session_max', 'night_weekly_max',
  'hard_limit_pct', 'warn_margin_pct', 'safety_reserve_pct', 'est_pct_S', 'est_pct_M', 'est_pct_L',
]);
export const NONNEG_KEYS = new Set([
  'max_concurrency', 'poll_interval_sec', 'min_runway_min', 'max_resumes', 'max_autoqueue',
  'timeout_S', 'timeout_M', 'timeout_L', 'usage_refresh_sec', 'ledger_fallback_after_min',
]);

/** Keys the board settings panel reads/writes (the budget/scheduling knobs). */
export const TUNABLE_KEYS = [
  'day_window',
  'day_session_max', 'day_weekly_max',
  'night_session_max', 'night_weekly_max',
  'hard_limit_pct', 'min_runway_min', 'max_concurrency',
] as const;

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
  } else if (key === 'scheduler_paused') {
    if (value !== 'true' && value !== 'false') return 'scheduler_paused must be true or false';
  }
  return null;
}
