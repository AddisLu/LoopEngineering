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
const MCP_DEFAULT_SERVERS_JSON = JSON.stringify({
  'loop-fs': { type: 'local', command: ['node', path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-fs-mcp.mjs')], enabled: true },
  loop: { type: 'local', command: ['node', path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-mcp.mjs')], enabled: true },
  gh: { type: 'local', command: ['node', path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-gh-mcp.mjs')], enabled: true },
});

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
  // Uploaded voice-intake audio, transcoded/transcribed then deleted (see voiceRoutes.ts).
  voiceDir: path.join(DATA_DIR, 'voice'),
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
  for (const d of [paths.dataDir, paths.logsDir, paths.worktreesDir, paths.plansDir, paths.reviewsDir, paths.outputsDir, paths.voiceDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** faster-whisper venv python (see scripts/transcribe.py); overridable for other hosts. */
export function getVoicePython(): string {
  return expand(
    process.env.LOOP_VOICE_PYTHON ??
      path.join(os.homedir(), '.local', 'share', 'loop-engineering', 'voice-venv', 'bin', 'python'),
  );
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

  // model routing per complexity (SDD Phase 3, src/orchestrator/run.ts resolveModel).
  // Off by default = every implementation run uses default_model, exactly as before. When on,
  // route_<S|M|L> picks the model per complexity; a per-task `model` still overrides. A slot of
  // 'default'/'' falls through to default_model (not the costly CLI default). Only flip route_S
  // to a cheaper model (e.g. haiku) once sdd_specs is on AND the Phase-1 A/B proves it holds up.
  model_routing: 'false',
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

  // which shell runs verify steps / setup_cmd / deploy_cmd (see src/util/shell.ts).
  // 'auto' (default): linux/darwin = bash -lc (byte-identical to the pre-portability
  // behavior); win32 = git-bash if found, else PowerShell, else cmd. Explicit values
  // ('bash' | 'powershell' | 'cmd' | 'git-bash') force that shell on any platform —
  // prep for the Windows company deployment, testable today from Linux.
  shell: 'auto',

  // 模型對話 history (src/chat/store.ts): server-side, per-user transcripts. ON by default —
  // the whole page already sits behind local_models_enabled, so the zero-impact default is
  // satisfied one level up, and a second off-by-default flag would just never get turned on.
  chat_history_enabled: 'true',
  // how many past turns of a resumed conversation are replayed INTO the model (the rest stay
  // visible on screen): validMessages caps at 40 turns and a long thread would blow the context
  chat_context_turns: '12',
  chat_retention_days: '0', // 0 = keep forever (loop chat prune uses this)
  // 請雲端複核 (src/chat/escalate.ts): off by default — it is the one action on the page that
  // leaves the machine and spends subscription usage, so it must be switched on deliberately.
  chat_escalate_enabled: 'false',
  chat_escalate_model: 'opus',
  // Shorter than bench_judge_timeout_ms (this one blocks a browser request), but not too short:
  // a real review of one short answer measured 112 s, so 120 s left no margin. If a proxy does
  // cut the connection first, the review still finishes and is saved — it shows up on reload.
  chat_escalate_timeout_ms: '240000',
  // 分享連結: read-only transcript pages. On by default; the token in the URL is the secret.
  chat_share_enabled: 'true',
  // 上網／工具 (src/chat/tools.ts, toolLoop.ts): off by default, and even when on the page must
  // tick the chip per question — a tool round adds seconds and leaves the machine.
  chat_tools_enabled: 'false',
  chat_search_url: 'http://127.0.0.1:8080', // self-hosted SearXNG (deploy/searxng); '' = no web_search
  chat_tool_max_rounds: '5',
  chat_tool_timeout_ms: '15000',
  chat_tool_wall_ms: '120000',
  chat_tool_result_chars: '12000',
  chat_fetch_max_bytes: '2097152',
  // 終端機 (src/terminal/*): a real shell on this machine through the browser. Off by default,
  // and even when on only the identities in terminal_allowed_users see the button — entries are
  // `ts:<tailscale login>`, `name:<typed name>` (LAN only, unauthenticated) or `local`.
  terminal_enabled: 'false',
  terminal_allowed_users: '',
  // where a new shell starts. Default: this checkout, so the browser terminal is "the Loop repo"
  // and a collaborator lands where the code is. A shell can still cd elsewhere (a pty is not a
  // jail) — this is a starting point and a hint, not a sandbox.
  terminal_cwd: ENGINE_REPO_ROOT,
  // 專屬 worktree: every person who opens a shell gets their own git worktree of terminal_cwd
  // (branch desk/<slug>) and lands there, so the checkout the engine runs its own tasks from
  // never picks up someone else's edits. Off → everyone shares terminal_cwd.
  terminal_worktree: 'true',
  terminal_worktree_root: path.join(os.homedir(), 'Addis', 'loop-worktrees'),
  terminal_idle_min: '30',
  terminal_max_sessions: '4',
  terminal_scrollback_kb: '256',
  // MCP bridge (src/mcp/*): servers in opencode's `mcp` shape, shared by the chat tool loop and
  // the opencode task adapter. Seeded with the three servers under mcp/ (read-only fs, Loop's own
  // API, GitHub via gh). They only start when a question ticks 上網／工具.
  mcp_servers_json: MCP_DEFAULT_SERVERS_JSON,
  mcp_timeout_ms: '30000',
  chat_mcp_enabled: 'true',
  chat_tool_schema_chars: '16000',
  // 轉成任務 → 驗證新技術: where spike repos (and their bare origins under .origins/) are created
  spike_root: path.join(os.homedir(), 'Addis', 'spikes'),
  // PRD 精靈: directories the repo picker / image-set checker may look at, on top of the enabled
  // git/folder knowledge sources. CSV of absolute paths; '' = only registered sources.
  prd_repo_allowlist: '',

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

  // SDD Phase 2 (src/orchestrator/planner.ts): when on, the epic planner asks for a
  // self-contained spec per child and writes each child its OWN plan_ref (spec-*.md) instead
  // of sharing the epic brief — so a cheaper implementation model can do each reliably. Off by
  // default = byte-identical planner prompt + children keep inheriting epic.plan_ref (zero impact).
  sdd_specs: 'false',

  // ADO/GitHub integration bridge (src/integrations/): pull work-items -> Loop tasks and
  // push results back. Off by default = zero external calls; credentials come from
  // ~/.config/loop-engineering/env (GITHUB_TOKEN/GITHUB_API_URL or ADO_PAT/ADO_ORG/ADO_PROJECT),
  // never the DB. 'none' (default) disables both import and pushback regardless of creds.
  integration_provider: 'none',
  integration_pushback: 'false',

  // mobile voice -> task intake (src/voice/, src/server/voiceRoutes.ts): record on the
  // board/voice.html -> faster-whisper (RTX 2080 venv) transcribes -> an LLM cleans the
  // transcript into task fields -> PREFILLS the new-task form (never auto-creates). Off
  // by default = zero behavior change; voice_model/voice_terms_path only matter once enabled.
  voice_intake_enabled: 'false',
  voice_model: 'large-v3',
  voice_terms_path: '/home/addis/Coding/VoiceToTemplate/terms.txt',
  // warm whisper worker (scripts/transcribe_daemon.py, src/voice/daemon.ts): a singleton
  // subprocess keeps the model loaded in VRAM between requests instead of paying the
  // ~1.6s load+CUDA-init cost on every recording. On by default; any daemon failure falls
  // back to the one-shot scripts/transcribe.py transparently. Idle for voice_worker_idle_min
  // minutes -> the worker exits on its own to free VRAM.
  voice_warm_worker: 'true',
  voice_worker_idle_min: '10',
  // model used to clean a transcript into structured task fields (src/voice/structure.ts).
  // haiku is fast/cheap and plenty for this cleanup task; overrides default_model for voice only.
  voice_structure_model: 'haiku',

  // SSoT/RAG Phase 0 (src/knowledge/{vec,embed}.ts): local vector search foundation.
  // Off by default = zero behavior change — nothing calls embed()/vec KNN yet (Phase 1/2
  // ingest+retrieve wire it up). Embeddings run fully on-device (bge-m3, voice-venv);
  // no data leaves the host.
  rag_enabled: 'false',
  embed_model: 'BAAI/bge-m3',
  embed_dim: '1024',
  // shares the voice-venv python (torch + sentence-transformers installed alongside
  // faster-whisper — see plan-SSoT-master.md's out-of-band setup steps).
  embed_python: path.join(os.homedir(), '.local', 'share', 'loop-engineering', 'voice-venv', 'bin', 'python'),
  rag_top_k: '8',
  rag_hybrid_alpha: '0.5',
  // warm embed worker (scripts/embed_daemon.py, reuses src/voice/daemon.ts's WarmWorker):
  // idle minutes before the daemon self-terminates to free VRAM (shared GPU with whisper).
  embed_worker_idle_min: '10',

  // SSoT/RAG Phase 1 (src/knowledge/ingest/*.ts): governed ingest pipeline. Per-file size
  // cap in KB — a file over this never reaches the chunker/embedder (binaries, huge logs,
  // generated dumps). Chunks/embeddings themselves still only happen when rag_enabled.
  ingest_max_file_kb: '1024',

  // SSoT/RAG Phase 4 (src/knowledge/ingest/pump.ts): periodic incremental re-ingest of
  // every enabled source from the server tick loop (mirrors integrations/pushback.ts's
  // pumpPushback cursor idiom, but time-based rather than event-based). Off by default —
  // `loop ingest run` / MCP loop_ingest / POST /api/ingest stay the only triggers unless
  // opted in.
  ingest_auto_pump: 'false',
  ingest_pump_interval_min: '30',

  // SSoT/RAG Phase 2 (src/knowledge/{retrieve,context}.ts): off by default = zero behavior
  // change to LOOP_TASK.md. When on, dispatch additionally pulls top-K corpus chunks
  // (hybrid FTS+vec search scoped to the task's repo) into their own `## 相關語料 (RAG)`
  // section — separate from the curated `## Knowledge / Environment` block above.
  rag_inject_task_context: 'false',

  // OpenProject connector (src/knowledge/ingest/openproject.ts, scripts/openproject_dump.py):
  // stdlib-only, no venv needed (unlike embed_python) — overridable for hosts where the
  // interpreter isn't on PATH as 'python3' (e.g. the Windows company deployment, which
  // uses 'python').
  ingest_openproject_python: 'python3',

  // 報告生成 A（src/report/*.ts, src/server/reportRoutes.ts）：用自然語言描述生成 OpenProject
  // 專案報告。off by default = zero behavior change — POST /api/report 404s and loop_report
  // returns nothing until opted in.
  report_enabled: 'false',
  report_model: 'sonnet',
  // greedy-pack budget (chars) for the work-package/snapshot data section of the prompt —
  // separate knob from knowledge_budget_chars since report data density differs.
  report_budget_chars: '4000',
  // try a live OpenProject query (spawns scripts/openproject_dump.py) before falling back
  // to the ingested corpus snapshot; false skips straight to the snapshot search.
  report_live_first: 'true',
  // POST /api/report always responds within this many ms, even when generateReport is
  // still running (haiku/sonnet calls can legitimately take a minute+) -- past this, the
  // route replies 504 {timedOut:true} instead of leaving the connection open with no
  // response at all. generateReport itself keeps running to completion in the background;
  // this only bounds how long the HTTP caller waits.
  report_timeout_ms: '100000',

  // 報告生成 B（src/report/templates.ts）：reusable "boss persona" report templates.
  // Empty (default) = generateReport falls back to its built-in one-page instructions
  // whenever no template name is given/resolved; set to a seeded/custom template name
  // (e.g. 'plant-manager-onepage') to make it the last-resort default.
  report_default_template: '',

  // 報告生成 C（src/report/{charts,persist}.ts）：Mermaid charts are always embedded when
  // structured WP data is available (no flag — programmatic, never LLM-authored numbers).
  // Persistence to disk stays off by default = zero behavior change; `report_persist=true`
  // (or a single call's `--save`) writes markdown + WP snapshot JSON + each chart's .mmd
  // under report_output_dir/<project>/<date-topic>/ for the user's own git to track.
  report_persist: 'false',
  report_output_dir: path.join(DATA_DIR, 'reports'),

  // 報告生成 D（scripts/report_pptx.py, src/report/pptx/*.ts）：企業週報 PPTX 確定性渲染
  // 器 -- python-pptx fill-only,絕不在執行期生成版面。off by default = zero behavior
  // change -- `loop report pptx *` fail-fasts until opted in. template/manifest empty
  // string = default to <report_pptx_dir>/template/{fillready.pptx,manifest.json} (see
  // src/report/pptx/render.ts's resolveTemplatePath/resolveManifestPath). The real
  // fillready.pptx is company-confidential and never lives in this repo.
  report_pptx_enabled: 'false',
  report_pptx_dir: path.join(DATA_DIR, 'report-pptx'),
  report_pptx_template: '',
  report_pptx_manifest: '',
  report_pptx_python: '',
  report_pptx_timeout_ms: '120000',

  // 報告生成 D 續篇（src/report/pptx/{status,quality}.ts）：LLM status 生成 + 品質閘門(T3)。
  // report_pptx_model empty = fall back to report_model (then 'sonnet') for the content-
  // generation call; judge reuses the board-wide llm_judge_model, not a pptx-specific one.
  // report_pptx_judge on by default (once report_pptx_enabled is already on) — a failed
  // gate never blocks shipping, it only flags quality_flags for human review. explain_agent
  // is registered but not wired to automatic dispatch yet (out of scope this task) —
  // interactive/manual use of seed/report-pptx/explain-agent-prompt.md only.
  report_pptx_model: '',
  report_pptx_judge: 'true',
  report_pptx_explain_agent: 'false',

  // 本地模型（src/local/*.ts, src/orchestrator/adapters/opencode.ts）：用 DGX Spark 上 vLLM 的本地
  // 模型取代 `claude` 做實作。off by default = zero behavior change — a task/default_model of
  // 'local:<id>' stays queued ("local models disabled") and nothing touches docker/vLLM.
  // One model fits the GPU at a time: the ModelManager swaps it (docker stop + run-recipe.sh)
  // only while no local run is in flight. local runs skip every quota gate (zero Anthropic
  // spend) but have their own cap. local_model_loaded / local_model_status are engine STATE
  // written by the ModelManager, not tunables.
  local_models_enabled: 'false',
  local_max_concurrency: '2',
  local_switch_timeout_sec: '900',
  local_switch_retry_min: '10',
  local_timeout_multiplier: '2',
  local_gap_review: 'false',
  local_vllm_repo: path.join(os.homedir(), 'Addis', 'spark-vllm-docker'),
  // How many DGX Sparks this deployment can use. The model switcher only offers models whose
  // recipe fits (a cluster_only recipe needs 2); raise it when the second machine is wired up.
  local_spark_nodes: '1',
  local_vllm_container: 'vllm_node',
  local_vllm_base_url: 'http://127.0.0.1:8000/v1',
  local_model_loaded: '',
  local_model_status: 'idle',
  local_job_json: '', // engine STATE: the one download/build job in flight (src/local/jobs.ts)

  // Benchmark mode（src/benchmark/*.ts）：同一任務交給多個（本地）模型各做一次，全部結束後由外部高階
  // 模型評比排名，累積成 模型 × 領域 矩陣。off by default = routes 404, nothing is judged. The judge
  // call is the only Anthropic spend of a benchmark (one `claude -p` per benchmark).
  benchmark_enabled: 'false',
  bench_judge_model: 'opus',
  bench_diff_cap_chars: '8000',
  bench_judge_timeout_ms: '600000',

  // PRD 閘門（src/prd/*.ts, web/prd.html）：貼上 PRD → 規則檢查 + 已載入的本地模型審查（零 token），
  // 不完整就擋下；通過才建成任務（或 benchmark）。off by default = routes 404.
  // prd_require_llm=true: an unavailable local reviewer blocks instead of passing on lint alone.
  // prd_default_model: implementation model for PRD tasks ('' = default_model when it is local:<id>).
  prd_gate_enabled: 'false',
  prd_require_llm: 'false',
  prd_default_model: '',
  local_chat_timeout_ms: '180000',
};

export const TOKEN_REFRESH_MS = 180_000; // TokenBar cadence

// Cross-tool shared usage cache: this engine, claude-usage-mcp and any other local
// tool read+write the SAME file, so at most one of them hits oauth/usage per TTL
// window (prevents 429 pile-ups when several tools poll concurrently). A custom
// LOOP_DATA_DIR (tests, portable installs) keeps the cache private to that dir so
// hermetic tests never touch the real shared file.
export const USAGE_CACHE_FILE = expand(
  process.env.LOOP_USAGE_CACHE ??
    (process.env.LOOP_DATA_DIR
      ? path.join(DATA_DIR, 'usage-cache.json')
      : path.join(os.homedir(), '.local', 'share', 'claude-usage', 'usage-cache.json')),
);

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
