import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import { listTasks, countByStatus, activeRuns } from '../tasks.js';
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
  counts: Record<string, number>;
  cards: BoardCard[];
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
      const startedMs = new Date(run.started_at.replace(' ', 'T') + 'Z').getTime();
      card.elapsedMin = Math.max(0, Math.round((Date.now() - startedMs) / 60000));
    }
    return card;
  });

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
    counts: countByStatus(db),
    cards,
  };
}
