import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function expand(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// This file sits directly under the repo root's `src/` (vitest/tsx) or `dist/`
// (built) — one level up is the engine's own repo root in both layouts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_REPO_ROOT = path.join(__dirname, '..');

/** True when `repoPath` IS the engine's own repo (a self-improvement task). */
export function isEngineRepo(repoPath: string): boolean {
  try {
    return fs.realpathSync(repoPath) === fs.realpathSync(ENGINE_REPO_ROOT);
  } catch {
    return false;
  }
}

const DATA_DIR = expand(
  process.env.LOOP_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'loop-engineering'),
);

export const paths = {
  dataDir: DATA_DIR,
  db: expand(process.env.LOOP_DB_PATH ?? path.join(DATA_DIR, 'loop.sqlite')),
  logsDir: path.join(DATA_DIR, 'logs'),
  worktreesDir: path.join(DATA_DIR, 'worktrees'),
  plansDir: path.join(DATA_DIR, 'plans'),
  reviewsDir: path.join(DATA_DIR, 'reviews'),
  // Persistent per-task workspace for coding_tool='generic' (non-git tasks): unlike a
  // worktree, this directory is NEVER cleaned up on close — it IS the deliverable.
  outputsDir: path.join(DATA_DIR, 'outputs'),
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
  for (const d of [paths.dataDir, paths.logsDir, paths.worktreesDir, paths.plansDir, paths.reviewsDir, paths.outputsDir]) {
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
  // serial task chains: auto-queue a DRAFT whose `depends_on` task is closed (gate must
  // pass). A queued dependent is always held until its dependency closes regardless.
  dep_auto_queue: 'true',

  // model for coding runs when a task doesn't set its own. Defaults to 'sonnet' so
  // autonomous coding does NOT inherit the (costly) interactive CLI default. Per-task
  // `model` overrides this; 'default' / '' means "use the claude CLI default".
  default_model: 'sonnet',

  // which CLI backend dispatches real (non-mock) claude-code/generic runs — see
  // src/orchestrator/adapters/registry.ts. 'claude-code' is the only implemented
  // backend today; 'copilot-cli' is reserved for a future company deployment on
  // GitHub Copilot CLI (needs a PAT + its own adapter — not built yet).
  agent_backend: 'claude-code',

  // usage-fetch cadence + ledger fallback
  usage_refresh_sec: '180',
  ledger_fallback_after_min: '10',

  // --- Git close-out (all default ON; all-off restores the pre-close-out behavior) ---
  // fetch origin/<base> before cutting a worktree and before syncing, so work starts from
  // and integrates against the freshest base.
  git_fetch_base: 'true',
  // push the loop branch to origin as a backup after verify passes.
  auto_push_branch: 'true',
  // after verify, merge latest base into the branch then fast-forward-integrate into base.
  auto_merge: 'true',
  // on a merge conflict, auto-create a queued resolution task (guarded against recursion).
  merge_conflict_task: 'true',

  // notifications (M2)
  ntfy_server: '',
  ntfy_topic: '',

  // self-update: when a task targeting the engine's OWN repo auto-merges into main,
  // set a pending marker; the scheduler tick rebuilds+restarts the engine once idle
  // (see src/scheduler/tick.ts). Off restores the old "human rebuilds manually" flow.
  self_update: 'true',
  // dependency chains release on the dep reaching review+merged (its work is already
  // on main) instead of waiting for a human to close it. true = zero-touch chains;
  // false (default) = human close stays the approval gate for each chain link.
  dep_done_on_merge: 'false',

  // knowledge base: inject a ranked `## Knowledge / Environment` section into
  // LOOP_TASK.md on every dispatch (see src/knowledge/context.ts). Char budget is a
  // greedy-pack cap so the section stays small relative to Goal/Plan.
  knowledge_inject: 'true',
  knowledge_budget_chars: '2500',
  // gated auto-learning: on task close, fire-and-forget a cheap haiku pass over the
  // HANDOFF/gap-review/goal to draft candidate knowledge nodes (status='draft', never
  // injected — see src/knowledge/distill.ts). Off restores the old close-only behavior.
  knowledge_distill: 'true',

  // layered verification (src/orchestrator/judge.ts, verify.ts, run.ts runVerifyPipeline):
  // per-step timeout fallback (minutes) when a task doesn't set verify_timeout_min, and the
  // model used for the optional LLM verify judge.
  verify_step_timeout_min: '10',
  llm_judge_model: 'haiku',

  // hardware/environment awareness (src/capabilities.ts): CSV of what THIS host provides
  // (e.g. "gpu,network,linux"). A task's `requires` tokens not listed here are unmet —
  // command verification is skipped and the run defers to manual (see runVerifyPipeline).
  // Empty (default) means "assume nothing special" — any hardware requirement defers.
  host_capabilities: '',

  // execution-discipline prompt (src/orchestrator/prompt.ts): opt-in `## 執行紀律` block
  // distilled from test-driven-development/systematic-debugging/verification-before-completion
  // (prompt-only — no plugin, no subagents, no clarifying questions). Off by default = zero
  // change to LOOP_TASK.md; measure the effect via computeMetrics' discipline_ab block before
  // ever flipping this on for real work.
  prompt_discipline: 'false',

  // ADO/GitHub integration bridge (src/integrations/): pull work-items -> Loop tasks and
  // push results back. Off by default = zero external calls; credentials come from
  // ~/.config/loop-engineering/env (GITHUB_TOKEN/GITHUB_API_URL or ADO_PAT/ADO_ORG/ADO_PROJECT),
  // never the DB. 'none' (default) disables both import and pushback regardless of creds.
  integration_provider: 'none',
  integration_pushback: 'false',
};

export const TOKEN_REFRESH_MS = 180_000; // TokenBar cadence

export type Complexity = 'S' | 'M' | 'L';
// Lifecycle: draft -> queued -> running -> verifying -> review -> closed, with
// 'blocked' (auto-resumable interrupt), 'attention' (human hold: failure triage with
// worktree/session preserved — 續跑/重來/放棄 from the board) and 'failed' (terminal).
export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'blocked'
  | 'attention'
  | 'review'
  | 'failed'
  | 'closed';
