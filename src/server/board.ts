import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import { listTasks, countByStatus, activeRuns, getTask, latestRun } from '../tasks.js';
import { readUsage } from '../token/usage.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { validateTask } from '../gate/validateTask.js';
import { estimatePct } from '../token/accounting.js';
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
  est_pct: number;
  updated_at: string;
  logTail?: string[];
  branch?: string | null;
  elapsedMin?: number | null;
}

export interface BoardState {
  ts: string;
  paused: boolean;
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

export interface TaskResult {
  id: string;
  status: string;
  pr_url: string | null;
  review_md: string | null;
  fail_detail: string | null;
  log_tail: string[];
  branch: string | null;
  elapsedMin: number | null;
}

/** Parse a stored timestamp (ISO from finishRun, or sqlite "YYYY-MM-DD HH:MM:SS" UTC). */
function tsToMs(s: string): number {
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
}

function tailLog(path: string | null, n = 6): string[] {
  if (!path) return [];
  try {
    const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
    return lines.slice(-n).map((l) => {
      try {
        const e = JSON.parse(l);
        if (e.type === 'result') return `● result: ${e.subtype ?? 'done'}`;
        if (typeof e.text === 'string') return e.text.slice(0, 120);
        if (e.type === 'system') return `○ ${e.subtype ?? 'system'}`;
        return `${e.type ?? 'event'}`;
      } catch {
        return l.slice(0, 120);
      }
    });
  } catch {
    return [];
  }
}

export function boardState(db: Database.Database): BoardState {
  const usage = readUsage();
  const policy = resolvePolicy(db);
  const runs = activeRuns(db);
  const runByTask = new Map(runs.map((r) => [r.task_id, r]));

  const cards: BoardCard[] = listTasks(db).map((t: Task) => {
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
      gate: validateTask(t),
      pr_url: t.pr_url,
      est_pct: estimatePct(db, t.complexity),
      updated_at: t.updated_at,
    };
    if (run) {
      card.logTail = tailLog(run.log_path);
      card.branch = run.branch;
      card.elapsedMin = Math.max(0, Math.round((Date.now() - tsToMs(run.started_at)) / 60000));
    }
    return card;
  });

  const schedRow = db
    .prepare(`SELECT detail FROM task_events WHERE kind = 'scheduler' ORDER BY id DESC LIMIT 1`)
    .get() as { detail: string | null } | undefined;

  return {
    ts: new Date().toISOString(),
    paused: getBool(db, 'scheduler_paused'),
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
 * reason (for failed/blocked), a tail of the run log, branch, and elapsed minutes.
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

  let fail_detail: string | null = null;
  if (t.status === 'failed' || t.status === 'blocked') {
    const ev = db
      .prepare(
        `SELECT detail FROM task_events
          WHERE task_id = ? AND to_status IN ('failed','blocked') AND detail IS NOT NULL
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

  return {
    id: t.id,
    status: t.status,
    pr_url: t.pr_url,
    review_md,
    fail_detail,
    log_tail: run ? tailLog(run.log_path, 12) : [],
    branch: run?.branch ?? null,
    elapsedMin,
  };
}
