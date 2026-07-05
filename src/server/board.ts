import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import { listTasks, countByStatus, activeRuns } from '../tasks.js';
import { readUsage } from '../token/usage.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { validateTask } from '../gate/validateTask.js';
import { estimatePct } from '../token/accounting.js';
import { timeoutMinFor } from '../scheduler/timeout.js';
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
  timeoutMin?: number | null;
  elapsedPct?: number | null; // percent of the run's timeout elapsed (may exceed 100)
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
      const elapsedMin = Math.max(0, (Date.now() - startedMs) / 60000);
      card.elapsedMin = Math.round(elapsedMin);
      const timeoutMin = timeoutMinFor(db, t);
      card.timeoutMin = timeoutMin;
      // % of the run's timeout budget elapsed; the web renders a real progress bar
      // only when timeoutMin is present (never fabricates progress otherwise).
      card.elapsedPct = timeoutMin > 0 ? Math.round((elapsedMin / timeoutMin) * 100) : null;
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
