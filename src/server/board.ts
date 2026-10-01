import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getSetting } from '../db/index.js';
import { listTasks, countByStatus, activeRuns, getTask, latestRun, dependencyState, activeLocalRunCount } from '../tasks.js';
import { readUsage } from '../token/usage.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { validateTask } from '../gate/validateTask.js';
import { estimatePct, forecastBacklog } from '../token/accounting.js';
import { timeoutMinFor } from '../scheduler/timeout.js';
import { paths } from '../config.js';
import { listOutputFiles, type OutputFile } from '../orchestrator/outputFiles.js';
import { environmentMap, latestDeploymentForTask } from '../deploy/store.js';
import type { Task, TaskRun } from '../types.js';
import { readMetrics, readVerify, type VerifiedStep } from '../orchestrator/runSummary.js';
import type { MetricsReport } from '../orchestrator/acceptance.js';
import { changedFiles, codeRefFor, readSource, type ChangedFile } from '../review/code.js';

export interface BoardCard {
  id: string;
  title: string;
  goal: string;
  status: string;
  complexity: string;
  priority: number;
  model: string | null;
  coding_tool: string;
  verify_count: number;
  gate: { ok: boolean; missing: string[]; warnings: string[] };
  pr_url: string | null;
  merge_status: string | null;
  verify_mode: string;
  est_pct: number;
  updated_at: string;
  fail_detail?: string | null; // latest failure/interrupt detail (attention/failed/blocked)
  logTail?: string[];
  branch?: string | null;
  elapsedMin?: number | null;
  timeoutMin?: number | null;
  elapsedPct?: number | null; // percent of the run's timeout elapsed (may exceed 100)
  depends_on?: string | null;
  dep_state?: string; // waiting | satisfied | dep-failed | dep-missing (absent when no dep)
  requires?: string | null; // CSV of capability tokens this task needs (see capabilities.ts)
  verify_deferred?: string | null; // unmet capabilities that deferred the last run's verify to manual
  output_dir?: string; // coding_tool='generic' only: its persistent outputs/<id> dir
  output_file_count?: number; // coding_tool='generic' only
  parent_id?: string | null; // epic hierarchy: set on a child task materialized by the planner
  children?: EpicRollup; // present only on an epic (a task that IS some other task's parent_id)
  deploy_env?: string; // coding_tool='deploy' only: the target environment name
  deploy_status?: string; // coding_tool='deploy' only: latest deployments.status for this task
  deploy_detail?: string | null; // coding_tool='deploy' only: latest deployments.detail (e.g. DEPLOY.md path)
  pipeline_id?: string | null; // delivery pipeline: shared id across this template instance's stage tasks
  stage_name?: string | null; // delivery pipeline: this task's stage name within its pipeline_id
  source_ref?: string | null; // ADO/GitHub bridge: origin work item this task was imported from
  created_at: string;
  repo?: string | null; // the repo's folder name (the list view's 工作流程 column)
  benchmark_id?: string | null; // benchmark mode: the benchmark this task is one arm of (總覽 groups them)
  parent_task_id?: string | null; // an auto merge-conflict task: the task whose conflict it resolves
  // 問題單 start approval (approval_mode=manager): 'awaiting' | 'approved' | 'rejected', and who
  // asked Loop to start it (the 待核可（開工）inbox item). Absent on every task without one.
  approval_state?: string | null;
  requested_by?: string | null;
  /** a 問題單 (intake_json set): its draft is finished on /fix.html, not the 工作流程 */
  ticket?: boolean;
}

/** Who pressed 開始修 on a ticket (intake_json.start_requested_by), else who opened it. */
function requesterOf(t: Task): string | null {
  try {
    const intake = t.intake_json ? (JSON.parse(t.intake_json) as { start_requested_by?: { label?: unknown } | null; created_label?: unknown }) : null;
    const label = intake?.start_requested_by?.label ?? intake?.created_label;
    if (typeof label === 'string' && label) return label;
  } catch {
    /* unreadable intake: fall back to the key */
  }
  return t.created_by ?? null;
}

export interface EpicRollup {
  total: number;
  closed: number;
  running: number;
  failed: number;
}

export interface PipelineStageStatus {
  stage_name: string;
  task_id: string;
  status: string;
}

/** One instantiated pipeline (grouped by pipeline_id), stages in depends_on chain order. */
export interface PipelineRollup {
  pipeline_id: string;
  name: string;
  stages: PipelineStageStatus[];
}

export interface BoardState {
  ts: string;
  paused: boolean;
  self_update_pending: boolean;
  usage: {
    session: number;
    weekly: number;
    sessionResetsInMin: number | null;
    weeklyResetsInMin: number | null;
    source: string;
    // Why the numbers are not a live reading (login expired, shared 429 cooldown, network) —
    // null when they are. The topbar shows it; otherwise five stale days look like 58%.
    error: string | null;
  };
  policy: { window: string; sessionMax: number; weeklyMax: number };
  // Why the scheduler last held / dispatched (e.g. "session 82% >= 65%"), so the board
  // can answer "why is nothing running?". Persisted by the server loop on each change.
  reason: string | null;
  counts: Record<string, number>;
  cards: BoardCard[];
  pipelines: PipelineRollup[];
  // compact backlog-usage forecast for the topbar chip — see forecastBacklog() for the full shape.
  forecast: { weekly_backlog_pct: number; weekly_headroom: number; capacity_more_M: number; verdict: string };
  // 本地模型 topbar chip: what vLLM serves (ModelManager state persisted in settings) + local runs in flight.
  local: { enabled: boolean; loaded: string | null; status: string; inflight: number };
  // 評比使用中: the chat page greys out model switching while a benchmark owns the GPU
  benchmark: { id: string; title: string; status: string; arms_done: number; arm_count: number; mode: string | null; screen_group: string | null } | null;
  // every benchmark a card on the board belongs to: 總覽 draws each one as a group (question → arms →
  // final measurement → judge), so it needs the title and where the judging stands
  benchmarks: BoardBenchmark[];
}

export interface BoardBenchmark {
  id: string;
  title: string;
  status: string;
  domain: string;
  winner: string | null;
  judge_models: string | null;
  judge_model: string;
  /** 模型快篩: 'screen', its batch, its place in the batch, its question, how the one arm did, the batch size */
  mode: string | null;
  screen_group: string | null;
  screen_seq: number | null;
  source_ref: string | null;
  verify_outcome: string | null;
  screen_total: number | null;
}

/** The benchmarks the given arm tasks belong to (one small query). */
function boardBenchmarks(db: Database.Database, ids: string[]): BoardBenchmark[] {
  if (!ids.length || !getBool(db, 'benchmark_enabled', false)) return [];
  const marks = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT b.id, b.title, b.status, b.domain, b.winner, b.judge_models, b.judge_model, b.mode, b.screen_group, b.screen_seq, b.source_ref,
              (SELECT a.verify_outcome FROM benchmark_arms a WHERE a.benchmark_id = b.id LIMIT 1) AS verify_outcome,
              CASE WHEN b.screen_group IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM benchmarks x WHERE x.screen_group = b.screen_group) END AS screen_total
         FROM benchmarks b WHERE b.id IN (${marks}) ORDER BY b.created_at DESC`,
    )
    .all(...ids) as BoardBenchmark[];
}

/**
 * The entry gate costs two synchronous git calls per task, and the board is rebuilt every second:
 * keep each task's verdict until the task changes, and at most GATE_TTL_MS so a repo or branch
 * that disappears underneath still shows up within a minute.
 */
const GATE_TTL_MS = 60_000;
const gateCache = new Map<string, { key: string; at: number; gate: BoardCard['gate'] }>();
function cachedGate(t: Task, hostCaps: string, envs: ReturnType<typeof environmentMap>, envKey: string): BoardCard['gate'] {
  const key = `${t.updated_at}|${hostCaps}|${envKey}`;
  const hit = gateCache.get(t.id);
  const now = Date.now();
  if (hit && hit.key === key && now - hit.at < GATE_TTL_MS) return hit.gate;
  const gate = validateTask(t, hostCaps, envs);
  gateCache.set(t.id, { key, at: now, gate });
  return gate;
}

/** The benchmark currently occupying the machine, if any (cheap: one indexed row). */
function runningBenchmark(db: Database.Database): BoardState['benchmark'] {
  if (!getBool(db, 'benchmark_enabled', false)) return null;
  const row = db
    .prepare(
      `SELECT b.id, b.title, b.status, b.mode, b.screen_group,
              (SELECT COUNT(*) FROM benchmark_arms a WHERE a.benchmark_id = b.id) AS arm_count,
              (SELECT COUNT(*) FROM benchmark_arms a LEFT JOIN tasks t ON t.id = a.task_id
                WHERE a.benchmark_id = b.id AND (t.id IS NULL OR t.status IN ('review','attention','failed','closed'))) AS arms_done
         FROM benchmarks b WHERE b.status IN ('running','judging') ORDER BY b.created_at DESC LIMIT 1`,
    )
    .get() as BoardState['benchmark'];
  return row ?? null;
}

/** Render one tool_use content block as a compact activity line (→ Edit src/foo.ts). */
function formatToolUse(b: any): string {
  const name = typeof b?.name === 'string' ? b.name : 'tool';
  const input = b?.input ?? {};
  if (name === 'Bash') {
    const cmd = String(input.command ?? '').replace(/\s+/g, ' ').trim();
    return cmd ? `→ Bash: ${cmd.slice(0, 80)}` : '→ Bash';
  }
  const target = input.file_path ?? input.path ?? input.notebook_path ?? input.pattern ?? '';
  return target ? `→ ${name} ${target}` : `→ ${name}`;
}

/**
 * Turn one stream-json event into zero or more display lines. Walks an assistant
 * message's content blocks so tool activity (Edit/Write/Bash/…) surfaces on the board,
 * while still handling text/result/system and the mock adapter's flat-text shape.
 */
/** opencode (本地模型) keeps what happened in `part`: the tool and its input, or the text. */
function formatOpencodeTool(part: any): string {
  const tool = typeof part?.tool === 'string' ? part.tool : 'tool';
  const input = part?.state?.input ?? {};
  const failed = part?.state?.status === 'error' ? ' ✖' : '';
  if (tool === 'bash') {
    const cmd = String(input.command ?? '').replace(/\s+/g, ' ').trim();
    return `→ bash: ${cmd.slice(0, 80)}${failed}`;
  }
  const target = input.filePath ?? input.path ?? input.pattern ?? input.command ?? '';
  return `→ ${tool}${target ? ` ${String(target).slice(0, 100)}` : ''}${failed}`;
}

export function formatEvent(e: any): string[] {
  if (!e || typeof e !== 'object') return [];
  // opencode stream: step_start/step_finish are bookkeeping, the content lives in `part`
  if (e.type === 'step_start' || e.type === 'step_finish') return [];
  if (e.type === 'tool_use' && e.part) return [formatOpencodeTool(e.part)];
  if (e.type === 'text' && e.part) {
    const t = typeof e.part.text === 'string' ? e.part.text.trim() : '';
    return t ? [t.slice(0, 120)] : [];
  }
  if (e.type === 'error') return [`✖ ${String(e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? e.message ?? 'error').slice(0, 160)}`];
  if (e.type === 'result') return [`● result: ${e.subtype ?? 'done'}`];
  if (e.type === 'system') return [`○ ${e.subtype ?? 'system'}`];
  if (e.type === 'assistant') {
    const content = e.message?.content;
    if (Array.isArray(content)) {
      const out: string[] = [];
      for (const b of content) {
        if (b?.type === 'tool_use') out.push(formatToolUse(b));
        else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push(b.text.trim().slice(0, 120));
      }
      return out;
    }
    if (typeof e.text === 'string') return [e.text.slice(0, 120)];
    return [];
  }
  if (typeof e.text === 'string') return [e.text.slice(0, 120)];
  return [`${e.type ?? 'event'}`];
}

export interface TaskResult {
  id: string;
  status: string;
  pr_url: string | null;
  merge_status: string | null;
  review_md: string | null;
  verify_md: string | null;
  fail_detail: string | null;
  log_tail: string[];
  branch: string | null;
  elapsedMin: number | null;
  output_dir?: string | null; // coding_tool='generic' only
  output_files?: OutputFile[] | null; // coding_tool='generic' only (name+size, capped ~50)
  deploy_env?: string | null; // coding_tool='deploy' only
  deploy_status?: string | null; // coding_tool='deploy' only: latest deployments.status
  deploy_detail?: string | null; // coding_tool='deploy' only: latest deployments.detail (e.g. DEPLOY.md path)
  pushback_detail?: string | null; // ADO/GitHub bridge: latest pushback attempt outcome (see integrations/pushback.ts)
  /** the last verification: each step with exit code and the tail of its output */
  verify: VerifiedStep[];
  verify_run: { id: string; attempt: number; finished_at: string | null } | null;
  /** metrics the steps reported vs the task's thresholds (null = none) */
  metrics: MetricsReport | null;
  thresholds: string | null;
  /** what the task changed (null = the code is not reachable any more) */
  changed_files: ChangedFile[] | null;
  /** the page where a person reads the code, re-runs it and signs it off */
  review_url: string;
}

/** A generic task's persistent, non-git workspace — see runTask's isGeneric branch. */
export function outputDirFor(taskId: string): string {
  return path.join(paths.outputsDir, taskId);
}

/** Parse a stored timestamp (ISO from finishRun, or sqlite "YYYY-MM-DD HH:MM:SS" UTC). */
function tsToMs(s: string): number {
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
}

/** The last `bytes` of a file (a run log can be megabytes; the board only shows its tail). */
function readTail(file: string, bytes = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // a cut through the middle of a line (or a multi-byte character) is dropped
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export function tailLog(path: string | null, n = 6): string[] {
  if (!path) return [];
  try {
    const lines = readTail(path).trim().split('\n');
    const out: string[] = [];
    for (const l of lines.slice(-40)) {
      // bound parse work; one assistant event can yield several tool lines
      try {
        out.push(...formatEvent(JSON.parse(l)));
      } catch {
        out.push(l.slice(0, 120));
      }
    }
    return out.slice(-n);
  } catch {
    return [];
  }
}

/** The pipeline's display label, recovered from a stage task's title (see pipeline/
 * materialize.ts's `${label}: ${stage.name}` convention) — no separate name column is
 * kept on tasks, so this just strips the known ": <stage_name>" suffix. */
function pipelineLabel(t: Task): string {
  if (!t.stage_name) return t.title;
  const suffix = `: ${t.stage_name}`;
  return t.title.endsWith(suffix) ? t.title.slice(0, -suffix.length) : t.title;
}

/**
 * Order a pipeline instance's tasks by walking its depends_on chain (robust against
 * same-second created_at ties, unlike an ORDER BY created_at query) — start at the stage
 * whose depends_on doesn't point at another task in this same pipeline_id group, then
 * follow each task's dependent forward. Falls back to input order if the chain is broken.
 */
function pipelineChain(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const next = new Map<string, Task>();
  let head: Task | undefined;
  for (const t of tasks) {
    if (t.depends_on && byId.has(t.depends_on)) next.set(t.depends_on, t);
    else head = head ?? t;
  }
  const chain: Task[] = [];
  const seen = new Set<string>();
  let cur = head;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = next.get(cur.id);
  }
  return chain.length === tasks.length ? chain : tasks;
}

function pipelineRollups(allTasks: Task[]): PipelineRollup[] {
  const byPipeline = new Map<string, Task[]>();
  for (const t of allTasks) {
    if (!t.pipeline_id) continue;
    const arr = byPipeline.get(t.pipeline_id);
    if (arr) arr.push(t);
    else byPipeline.set(t.pipeline_id, [t]);
  }
  return [...byPipeline.entries()].map(([pipeline_id, tasks]) => {
    const chain = pipelineChain(tasks); // always the same length as `tasks` (>= 1, see above)
    return {
      pipeline_id,
      name: pipelineLabel(chain[0]!),
      stages: chain.map((t) => ({ stage_name: t.stage_name ?? '', task_id: t.id, status: t.status })),
    };
  });
}

export function boardState(db: Database.Database): BoardState {
  const usage = readUsage();
  const policy = resolvePolicy(db);
  const hostCaps = getSetting(db, 'host_capabilities') ?? '';
  const envs = environmentMap(db);
  const runs = activeRuns(db);
  const runByTask = new Map(runs.map((r) => [r.task_id, r]));
  const failDetailStmt = db.prepare(
    `SELECT detail FROM task_events
      WHERE task_id = ? AND to_status IN ('attention','failed','blocked') AND detail IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
  );
  const deferredStmt = db.prepare(
    `SELECT detail FROM task_events
      WHERE task_id = ? AND run_id = ? AND kind = 'note' AND detail LIKE 'capability(s) unavailable here%'
      ORDER BY id DESC LIMIT 1`,
  );

  const envKey = JSON.stringify([...envs.values()]);
  const allTasks = listTasks(db);
  // epic hierarchy: group children by parent_id once, so each epic card's rollup is O(1)
  // instead of re-scanning all tasks per card.
  const childrenByParent = new Map<string, Task[]>();
  for (const t of allTasks) {
    if (!t.parent_id) continue;
    const arr = childrenByParent.get(t.parent_id);
    if (arr) arr.push(t);
    else childrenByParent.set(t.parent_id, [t]);
  }

  const cards: BoardCard[] = allTasks.map((t: Task) => {
    let verify: string[] = [];
    try {
      verify = JSON.parse(t.verification_steps);
    } catch {
      /* ignore */
    }
    const run = runByTask.get(t.id);
    const card: BoardCard = {
      id: t.id,
      title: t.title,
      goal: t.goal,
      status: t.status,
      complexity: t.complexity,
      priority: t.priority,
      model: t.model,
      coding_tool: t.coding_tool,
      verify_count: Array.isArray(verify) ? verify.length : 0,
      gate: cachedGate(t, hostCaps, envs, envKey),
      pr_url: t.pr_url,
      merge_status: t.merge_status,
      verify_mode: t.verify_mode,
      est_pct: estimatePct(db, t.complexity),
      updated_at: t.updated_at,
      created_at: t.created_at,
    };
    if (t.repo_path) card.repo = path.basename(t.repo_path);
    if (t.benchmark_id) card.benchmark_id = t.benchmark_id;
    if (t.parent_task_id) card.parent_task_id = t.parent_task_id;
    if (t.requires) card.requires = t.requires;
    if (t.parent_id) card.parent_id = t.parent_id;
    if (t.pipeline_id) {
      card.pipeline_id = t.pipeline_id;
      card.stage_name = t.stage_name;
    }
    if (t.source_ref) card.source_ref = t.source_ref;
    if (t.intake_json) card.ticket = true;
    if (t.approval_state) {
      card.approval_state = t.approval_state;
      card.requested_by = requesterOf(t);
    }
    const kids = childrenByParent.get(t.id);
    if (kids) {
      card.children = {
        total: kids.length,
        closed: kids.filter((k) => k.status === 'closed').length,
        running: kids.filter((k) => k.status === 'running' || k.status === 'verifying').length,
        failed: kids.filter((k) => k.status === 'failed' || k.status === 'attention').length,
      };
    }
    if (t.coding_tool === 'generic') {
      const dir = outputDirFor(t.id);
      card.output_dir = dir;
      card.output_file_count = fs.existsSync(dir) ? listOutputFiles(dir, 1000).length : 0;
    }
    if (t.coding_tool === 'deploy') {
      if (t.environment) card.deploy_env = t.environment;
      const dep = latestDeploymentForTask(db, t.id);
      if (dep) {
        card.deploy_status = dep.status;
        card.deploy_detail = dep.detail;
      }
    }
    if (t.depends_on) {
      card.depends_on = t.depends_on;
      card.dep_state = dependencyState(db, t);
    }
    {
      const lastRunId = run?.id ?? latestRun(db, t.id)?.id;
      if (lastRunId) {
        const ev = deferredStmt.get(t.id, lastRunId) as { detail: string } | undefined;
        if (ev) {
          const m = /^capability\(s\) unavailable here: (.*?) →/.exec(ev.detail);
          card.verify_deferred = m ? m[1] : ev.detail;
        }
      }
    }
    if (t.status === 'attention' || t.status === 'failed' || t.status === 'blocked') {
      const ev = failDetailStmt.get(t.id) as { detail: string } | undefined;
      card.fail_detail = ev?.detail ?? null;
      // attention triage needs the run's last activity; its run is finished, so it is
      // not in the activeRuns map — pull the latest run's log explicitly.
      if (t.status === 'attention' && !run) {
        const last = latestRun(db, t.id);
        if (last) card.logTail = tailLog(last.log_path);
      }
    }
    if (run) {
      card.logTail = tailLog(run.log_path);
      card.branch = run.branch;
      const elapsedMin = Math.max(0, (Date.now() - tsToMs(run.started_at)) / 60000);
      card.elapsedMin = Math.round(elapsedMin);
      const timeoutMin = timeoutMinFor(db, t);
      card.timeoutMin = timeoutMin;
      // % of the run's timeout budget elapsed; the web renders a real progress bar
      // only when timeoutMin is present (never fabricates progress otherwise).
      card.elapsedPct = timeoutMin > 0 ? Math.round((elapsedMin / timeoutMin) * 100) : null;
    }
    return card;
  });

  const schedRow = db
    .prepare(`SELECT detail FROM task_events WHERE kind = 'scheduler' ORDER BY id DESC LIMIT 1`)
    .get() as { detail: string | null } | undefined;

  const fc = forecastBacklog(db);

  return {
    ts: new Date().toISOString(),
    paused: getBool(db, 'scheduler_paused'),
    self_update_pending: getBool(db, 'self_update_pending'),
    usage: {
      session: Math.round(usage.session.percent),
      weekly: Math.round(usage.weekly.percent),
      sessionResetsInMin: usage.session.resetsInMinutes,
      weeklyResetsInMin: usage.weekly.resetsInMinutes,
      source: usage.source,
      error: usage.error ?? null,
    },
    policy: { window: policy.window, sessionMax: policy.sessionMax, weeklyMax: policy.weeklyMax },
    reason: schedRow?.detail ?? null,
    counts: countByStatus(db),
    cards,
    pipelines: pipelineRollups(allTasks),
    local: {
      enabled: getBool(db, 'local_models_enabled', false),
      loaded: getSetting(db, 'local_model_loaded') || null,
      status: getSetting(db, 'local_model_status') || 'idle',
      inflight: activeLocalRunCount(db),
    },
    benchmark: runningBenchmark(db),
    benchmarks: boardBenchmarks(db, [...new Set(allTasks.map((t) => t.benchmark_id).filter((v): v is string => !!v))]),
    forecast: {
      weekly_backlog_pct: fc.weekly_backlog_pct,
      weekly_headroom: fc.weekly_headroom,
      capacity_more_M: fc.capacity_more_M,
      verdict: fc.verdict,
    },
  };
}

/**
 * Full outcome of a task for editors/MCP: PR link, gap-review markdown, the failure
 * reason (for attention/failed/blocked), a tail of the run log, branch, and elapsed minutes.
 */
export function taskResult(db: Database.Database, id: string): TaskResult | null {
  const t = getTask(db, id);
  if (!t) return null;
  const run = latestRun(db, id);

  let review_md: string | null = null;
  if (t.review_md_path) {
    try {
      review_md = fs.readFileSync(t.review_md_path, 'utf8');
    } catch {
      /* review file missing — leave null */
    }
  }

  // best-effort: manual-verify tasks ask the agent to write VERIFY.md in the worktree
  // root; only readable while the worktree still exists (cleanupWorktree deliberately
  // skips manual-pending tasks so this stays visible until a human merges it).
  let verify_md: string | null = null;
  if (run?.worktree_path) {
    try {
      verify_md = fs.readFileSync(path.join(run.worktree_path, 'VERIFY.md'), 'utf8');
    } catch {
      /* absent or worktree gone — fine */
    }
  }

  let fail_detail: string | null = null;
  if (t.status === 'attention' || t.status === 'failed' || t.status === 'blocked') {
    const ev = db
      .prepare(
        `SELECT detail FROM task_events
          WHERE task_id = ? AND to_status IN ('attention','failed','blocked') AND detail IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as { detail: string } | undefined;
    fail_detail = ev?.detail ?? run?.error ?? null;
  }

  let elapsedMin: number | null = null;
  if (run) {
    const endMs = run.finished_at ? tsToMs(run.finished_at) : Date.now();
    elapsedMin = Math.max(0, Math.round((endMs - tsToMs(run.started_at)) / 60000));
  }

  let output_dir: string | null = null;
  let output_files: OutputFile[] | null = null;
  if (t.coding_tool === 'generic') {
    const dir = outputDirFor(t.id);
    output_dir = dir;
    output_files = fs.existsSync(dir) ? listOutputFiles(dir, 50) : [];
  }

  let deployExtra: Pick<TaskResult, 'deploy_env' | 'deploy_status' | 'deploy_detail'> = {};
  if (t.coding_tool === 'deploy') {
    const dep = latestDeploymentForTask(db, t.id);
    deployExtra = { deploy_env: t.environment, deploy_status: dep?.status ?? null, deploy_detail: dep?.detail ?? null };
  }

  let pushback_detail: string | null = null;
  if (t.source_ref) {
    const ev = db
      .prepare(
        `SELECT detail FROM task_events WHERE task_id = ? AND kind = 'note' AND detail LIKE 'pushback:%' ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as { detail: string } | undefined;
    pushback_detail = ev?.detail ?? null;
  }

  // what verification found, and what the task changed — readable after the worktree is gone
  const verified = db
    .prepare('SELECT * FROM task_runs WHERE task_id = ? AND verify_json IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(id) as TaskRun | undefined;
  let changed_files: ChangedFile[] | null = null;
  const ref = t.coding_tool === 'generic' ? null : codeRefFor(db, t);
  if (ref) {
    changed_files = changedFiles(ref, 100);
    if (verify_md === null) verify_md = readSource(ref, 'VERIFY.md')?.text ?? null;
  }
  const publicBase = (process.env.LOOP_PUBLIC_URL || '').replace(/\/$/, '');

  return {
    id: t.id,
    status: t.status,
    pr_url: t.pr_url,
    merge_status: t.merge_status,
    review_md,
    verify_md,
    fail_detail,
    log_tail: run ? tailLog(run.log_path, 12) : [],
    branch: run?.branch ?? null,
    elapsedMin,
    ...(t.coding_tool === 'generic' ? { output_dir, output_files } : {}),
    ...deployExtra,
    ...(t.source_ref ? { pushback_detail } : {}),
    verify: readVerify(verified),
    verify_run: verified ? { id: verified.id, attempt: verified.attempt, finished_at: verified.finished_at } : null,
    metrics: readMetrics(verified),
    thresholds: t.acceptance_metrics ?? null,
    changed_files,
    review_url: `${publicBase}/task.html?id=${encodeURIComponent(t.id)}`,
  };
}
