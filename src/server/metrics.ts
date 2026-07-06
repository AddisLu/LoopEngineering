import type Database from 'better-sqlite3';
import { countByStatus } from '../tasks.js';

export interface MetricsSnapshot {
  days: number;
  throughput: { by_day: { day: string; count: number }[]; total_closed: number };
  status_counts: Record<string, number>;
  funnel: {
    created: number;
    reached_review: number;
    closed: number;
    went_attention: number;
    went_failed: number;
    review_rate: number;
    close_rate: number;
    attention_rate: number;
    failed_rate: number;
  };
  cycle_time: {
    avg_min: number | null;
    median_min: number | null;
    dispatch_avg_min: number | null;
    sample: number;
  };
  token_cost: {
    avg_pct: number | null;
    recent: { id: string; title: string; est_pct: number | null; closed_at: string }[];
  };
  usage_trend: { session_pct: number | null; weekly_pct: number | null; created_at: string }[];
  autonomy: { self_updates: number; auto_merged: number; merge_conflict_tasks: number };
}

/** Parse a stored timestamp (sqlite "YYYY-MM-DD HH:MM:SS" UTC, or ISO). */
function tsToMs(s: string): number {
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
}

function avg(nums: number[]): number | null {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Last `days` UTC day keys ('YYYY-MM-DD'), oldest first, matching sqlite's date(). */
function dayKeysUTC(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Evenly-spaced downsample to at most `target` points (keeps ordering). */
function downsample<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)]!);
  return out;
}

/**
 * Pure DB-read aggregation for the autonomous-velocity dashboard. Surfaces what ADO's
 * human-velocity dashboards can't: how much of this shipped without a human in the loop.
 * Every query is scoped to a rolling `days` window (except status_counts, which is
 * current live state) so the page can answer "how are we doing lately".
 */
export function computeMetrics(db: Database.Database, opts: { days?: number } = {}): MetricsSnapshot {
  const days = opts.days ?? 14;
  const since = `-${days} days`;

  // ---- throughput: closed/day over the window, zero-filled ----
  const closedRows = db
    .prepare(
      `SELECT date(updated_at) AS day, COUNT(*) AS n
         FROM tasks
        WHERE status = 'closed' AND updated_at >= datetime('now', ?)
        GROUP BY date(updated_at)`,
    )
    .all(since) as { day: string; n: number }[];
  const closedByDay = new Map(closedRows.map((r) => [r.day, r.n]));
  const by_day = dayKeysUTC(days).map((day) => ({ day, count: closedByDay.get(day) ?? 0 }));
  const total_closed = by_day.reduce((a, b) => a + b.count, 0);

  // ---- status funnel/rates over tasks CREATED in the window ----
  const funnelRow = db
    .prepare(
      `SELECT
         COUNT(DISTINCT t.id) AS created,
         COUNT(DISTINCT CASE WHEN e.to_status = 'review'    THEN t.id END) AS reached_review,
         COUNT(DISTINCT CASE WHEN e.to_status = 'closed'    THEN t.id END) AS closed,
         COUNT(DISTINCT CASE WHEN e.to_status = 'attention' THEN t.id END) AS went_attention,
         COUNT(DISTINCT CASE WHEN e.to_status = 'failed'    THEN t.id END) AS went_failed
       FROM tasks t
       LEFT JOIN task_events e ON e.task_id = t.id AND e.kind = 'status'
       WHERE t.created_at >= datetime('now', ?)`,
    )
    .get(since) as {
    created: number;
    reached_review: number;
    closed: number;
    went_attention: number;
    went_failed: number;
  };
  const rate = (n: number): number => (funnelRow.created > 0 ? n / funnelRow.created : 0);

  // ---- cycle time (created->closed) + dispatch latency (queued->running) ----
  const cycleRows = db
    .prepare(
      `SELECT t.created_at AS created_at, t.updated_at AS updated_at,
              (SELECT MIN(created_at) FROM task_events WHERE task_id = t.id AND kind = 'status' AND to_status = 'queued') AS queued_at,
              (SELECT MIN(created_at) FROM task_events WHERE task_id = t.id AND kind = 'status' AND to_status = 'running') AS running_at
         FROM tasks t
        WHERE t.status = 'closed' AND t.updated_at >= datetime('now', ?)`,
    )
    .all(since) as { created_at: string; updated_at: string; queued_at: string | null; running_at: string | null }[];
  const cycleMinutes = cycleRows.map((r) => (tsToMs(r.updated_at) - tsToMs(r.created_at)) / 60000);
  const dispatchMinutes = cycleRows
    .filter((r) => r.queued_at && r.running_at)
    .map((r) => (tsToMs(r.running_at!) - tsToMs(r.queued_at!)) / 60000)
    .filter((m) => m >= 0);

  // ---- token cost: est_session_pct for closed tasks in the window ----
  const tokenRows = db
    .prepare(
      `SELECT id, title, est_session_pct, updated_at
         FROM tasks
        WHERE status = 'closed' AND updated_at >= datetime('now', ?)
        ORDER BY updated_at DESC
        LIMIT 20`,
    )
    .all(since) as { id: string; title: string; est_session_pct: number | null; updated_at: string }[];
  const pctSamples = tokenRows.map((r) => r.est_session_pct).filter((p): p is number => p != null);

  // ---- usage trend: downsampled token_snapshots over the window ----
  const snapRows = db
    .prepare(
      `SELECT session_pct, weekly_pct, created_at
         FROM token_snapshots
        WHERE created_at >= datetime('now', ?)
        ORDER BY created_at ASC
        LIMIT 5000`,
    )
    .all(since) as { session_pct: number | null; weekly_pct: number | null; created_at: string }[];

  // ---- autonomy: self-updates, auto-merges, merge-conflict tasks (window-scoped) ----
  const selfUpdates = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_events
        WHERE kind = 'note' AND detail LIKE '%self-update%' AND created_at >= datetime('now', ?)`,
    )
    .get(since) as { n: number };
  const autoMerged = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE merge_status = 'merged' AND created_at >= datetime('now', ?)`)
    .get(since) as { n: number };
  const mergeConflictTasks = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id IS NOT NULL AND created_at >= datetime('now', ?)`)
    .get(since) as { n: number };

  return {
    days,
    throughput: { by_day, total_closed },
    status_counts: countByStatus(db),
    funnel: {
      created: funnelRow.created,
      reached_review: funnelRow.reached_review,
      closed: funnelRow.closed,
      went_attention: funnelRow.went_attention,
      went_failed: funnelRow.went_failed,
      review_rate: rate(funnelRow.reached_review),
      close_rate: rate(funnelRow.closed),
      attention_rate: rate(funnelRow.went_attention),
      failed_rate: rate(funnelRow.went_failed),
    },
    cycle_time: {
      avg_min: avg(cycleMinutes),
      median_min: median(cycleMinutes),
      dispatch_avg_min: avg(dispatchMinutes),
      sample: cycleRows.length,
    },
    token_cost: {
      avg_pct: avg(pctSamples),
      recent: tokenRows.map((r) => ({ id: r.id, title: r.title, est_pct: r.est_session_pct, closed_at: r.updated_at })),
    },
    usage_trend: downsample(snapRows, 60),
    autonomy: {
      self_updates: selfUpdates.n,
      auto_merged: autoMerged.n,
      merge_conflict_tasks: mergeConflictTasks.n,
    },
  };
}
