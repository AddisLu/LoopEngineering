import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function expand(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

const DATA_DIR = expand(
  process.env.LOOP_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'loop-engineering'),
);

export const paths = {
  dataDir: DATA_DIR,
  db: expand(process.env.LOOP_DB_PATH ?? path.join(DATA_DIR, 'loop.sqlite')),
  logsDir: path.join(DATA_DIR, 'logs'),
  worktreesDir: path.join(DATA_DIR, 'worktrees'),
  reviewsDir: path.join(DATA_DIR, 'reviews'),
  // TokenBar integration (host)
  tokenbarMcpDir: process.env.TOKENBAR_MCP_DIR ? expand(process.env.TOKENBAR_MCP_DIR) : null,
  tokenCache: expand(
    process.env.TOKENBAR_TOKEN_CACHE ?? path.join(os.homedir(), '.config', 'claude-usage-bar', 'token'),
  ),
  tokenHistory: expand(
    process.env.TOKENBAR_HISTORY ??
      path.join(os.homedir(), '.local', 'share', 'claude-usage-mcp', 'history.jsonl'),
  ),
  credentials: expand(path.join(os.homedir(), '.claude', '.credentials.json')),
} as const;

export function ensureDirs(): void {
  for (const d of [paths.dataDir, paths.logsDir, paths.worktreesDir, paths.reviewsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * Default settings, seeded into the `settings` table on first run.
 * All values are stored as strings; parse with helpers in db/index.ts.
 * Thresholds are session/weekly usage PERCENT (MAX subscription: quota, not money).
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  scheduler_paused: 'false',
  max_concurrency: '1',
  poll_interval_sec: '60',

  // day/night policy windows (local time)
  day_window: '08:00-23:00',
  day_session_max: '65',
  day_weekly_max: '80',
  night_session_max: '92',
  night_weekly_max: '88',

  // three-layer protection
  hard_limit_pct: '95', // circuit breaker
  min_runway_min: '20',
  // pre-emptive warning margin below hard_limit_pct (edge-triggered ntfy while a run
  // is active), so you hear about it before the breaker actually interrupts.
  warn_margin_pct: '5',
  // per-run fit budget is computed against the hard limit minus this reserve, so an
  // under-estimate can't push a fresh dispatch into the breaker (see scheduler/tick.ts)
  safety_reserve_pct: '5',

  // resume policy: max auto-resume attempts before a blocked task escalates to failed
  // (shared by the orchestrator, scheduler tick, and crash recovery)
  max_resumes: '2',
  // cap on tasks the MCP may AUTO-queue (queued+running) before it must be queued by hand
  max_autoqueue: '3',

  // timeouts (minutes) per complexity
  timeout_S: '15',
  timeout_M: '45',
  timeout_L: '120',

  // model routing per complexity
  route_S: 'sonnet',
  route_M: 'default',
  route_L: 'default',

  // estimate seed (session %-points), auto-calibrated after 5 real runs
  est_pct_S: '3',
  est_pct_M: '8',
  est_pct_L: '20',

  // --- Phase 3: core scheduling semantics (all feature-flagged) ---
  // #1 checkpoint an in-flight run when the day/night window flips under it, so it
  //    re-enters under the new window's budget (SIGINT -> commit WIP -> blocked -> resume).
  //    Off by default: it interrupts live work, so it is opt-in.
  window_checkpoint: 'false',
  // #2 fit/pack against the weekly budget too (not just session). Strictly more
  //    conservative, so on by default. weekly %-point estimate seeds (auto-calibrated).
  weekly_packing: 'true',
  est_weekly_pct_S: '1',
  est_weekly_pct_M: '3',
  est_weekly_pct_L: '6',
  // #3 reserve each in-flight run's unspent estimated cost before packing, so raising
  //    max_concurrency cannot over-commit the budget. No effect at max_concurrency=1.
  concurrency_reserve: 'true',
  // #4 priority aging + starvation reserve. Off by default (changes dispatch ordering).
  //    effective priority += floor(waitMinutes / age_step_min); a top task waiting longer
  //    than starve_min reserves headroom (cheaper low-priority work stops jumping ahead).
  priority_aging: 'false',
  age_step_min: '30',
  starve_min: '60',

  // usage-fetch cadence + ledger fallback
  usage_refresh_sec: '180',
  ledger_fallback_after_min: '10',

  // notifications (M2)
  ntfy_server: '',
  ntfy_topic: '',
};

export const TOKEN_REFRESH_MS = 180_000; // TokenBar cadence

export type Complexity = 'S' | 'M' | 'L';
export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'blocked'
  | 'review'
  | 'failed'
  | 'closed';
