import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getSetting } from '../db/index.js';
import { listTasks, countByStatus, activeRuns, getTask, latestRun, dependencyState } from '../tasks.js';
import { readUsage } from '../token/usage.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { validateTask } from '../gate/validateTask.js';
import { estimatePct } from '../token/accounting.js';
import { timeoutMinFor } from '../scheduler/timeout.js';
import { paths } from '../config.js';
import { listOutputFiles, type OutputFile } from '../orchestrator/outputFiles.js';
import type { Task } from '../types.js';

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
}

export interface EpicRollup {
  total: number;
  closed: number;
  running: number;
  failed: number;
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
  };
  policy: { window: string; sessionMax: number; weeklyMax: number };
  // Why the scheduler last held / dispatched (e.g. "session 82% >= 65%"), so the board
  // can answer "why is nothing running?". Persisted by the server loop on each change.
  reason: string | null;
  counts: Record<string, number>;
  cards: BoardCard[];
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
export function formatEvent(e: any): string[] {
  if (!e || typeof e !== 'object') return [];
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
}

/** A generic task's persistent, non-git workspace — see runTask's isGeneric branch. */
export function outputDirFor(taskId: string): string {
  return path.join(paths.outputsDir, taskId);
}

/** Parse a stored timestamp (ISO from finishRun, or sqlite "YYYY-MM-DD HH:MM:SS" UTC). */
function tsToMs(s: string): number {
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
}

export function tailLog(path: string | null, n = 6): string[] {
  if (!path) return [];
  try {
    const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
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

export function boardState(db: Database.Database): BoardState {
  const usage = readUsage();
  const policy = resolvePolicy(db);
  const hostCaps = getSetting(db, 'host_capabilities') ?? '';
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
      gate: validateTask(t, hostCaps),
      pr_url: t.pr_url,
      merge_status: t.merge_status,
      verify_mode: t.verify_mode,
      est_pct: estimatePct(db, t.complexity),
      updated_at: t.updated_at,
    };
    if (t.requires) card.requires = t.requires;
    if (t.parent_id) card.parent_id = t.parent_id;
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
    },
    policy: { window: policy.window, sessionMax: policy.sessionMax, weeklyMax: policy.weeklyMax },
    reason: schedRow?.detail ?? null,
    counts: countByStatus(db),
    cards,
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
  };
}
