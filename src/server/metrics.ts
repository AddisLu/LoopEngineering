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
  discipline_ab: {
    groups: {
      discipline: 0 | 1;
      count: number;
      avg_session_pct: number | null;
      attention_rate: number;
      avg_resume_count: number | null;
      avg_cycle_min: number | null;
    }[];
  };
  // SDD Phase 1: free-text A/B cohort comparison (tasks.experiment). Unlike discipline_ab's
  // fixed 0/1 groups, cohorts are whatever labels exist. Counts terminal tasks (closed |
  // attention | failed) so pass_rate has an honest denominator; avg_session_pct is the
  // quota cost of ALL terminal tasks in the cohort (a failed/attention task still burned %).
  experiment_ab: {
    groups: {
      experiment: string;
      count: number; // terminal tasks in the cohort
      passed: number; // status = 'closed'
      pass_rate: number; // passed / count
      avg_session_pct: number | null;
      attention_rate: number;
      avg_resume_count: number | null;
      avg_cycle_min: number | null;
    }[];
  };
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

  // ---- discipline A/B: does prompt_discipline actually reduce tokens/rework? ----
  // Grouped by each closed task's LATEST run's `discipline` flag (0/1) — a task resumed
  // across a setting flip is attributed to whatever it dispatched under most recently.
  // Tasks with no runs, or runs predating this column (discipline IS NULL), are excluded
  // from both groups rather than guessed into one.
  const disciplineRows = db
    .prepare(
      `SELECT
         t.id AS task_id,
         t.resume_count AS resume_count,
         t.created_at AS created_at,
         t.updated_at AS updated_at,
         (SELECT discipline FROM task_runs WHERE task_id = t.id ORDER BY started_at DESC LIMIT 1) AS discipline,
         (SELECT SUM(session_pct_after - session_pct_before) FROM task_runs
            WHERE task_id = t.id AND session_pct_after IS NOT NULL AND session_pct_before IS NOT NULL) AS session_delta,
         (SELECT COUNT(*) FROM task_events WHERE task_id = t.id AND kind = 'status' AND to_status = 'attention') AS attention_count
       FROM tasks t
       WHERE t.status = 'closed' AND t.updated_at >= datetime('now', ?)`,
    )
    .all(since) as {
    task_id: string;
    resume_count: number;
    created_at: string;
    updated_at: string;
    discipline: number | null;
    session_delta: number | null;
    attention_count: number;
  }[];
  const disciplineGroups = ([0, 1] as const).map((flag) => {
    const rows = disciplineRows.filter((r) => r.discipline === flag);
    const sessionDeltas = rows.map((r) => r.session_delta).filter((d): d is number => d != null);
    const cycleMins = rows.map((r) => (tsToMs(r.updated_at) - tsToMs(r.created_at)) / 60000);
    return {
      discipline: flag,
      count: rows.length,
      avg_session_pct: avg(sessionDeltas),
      attention_rate: rows.length ? rows.filter((r) => r.attention_count > 0).length / rows.length : 0,
      avg_resume_count: avg(rows.map((r) => r.resume_count)),
      avg_cycle_min: avg(cycleMins),
    };
  });

  // ---- experiment A/B: does {SDD spec + cheap model} beat {vague goal + sonnet}? ----
  // Cohorts are the distinct tasks.experiment labels. Denominator = TERMINAL tasks so a
  // failed/attention run counts against its cohort's pass_rate (unlike discipline_ab which
  // only looks at closed tasks). Rows predating the column (experiment IS NULL) are excluded.
  const experimentRows = db
    .prepare(
      `SELECT
         t.experiment AS experiment,
         t.status AS status,
         t.resume_count AS resume_count,
         t.created_at AS created_at,
         t.updated_at AS updated_at,
         (SELECT SUM(session_pct_after - session_pct_before) FROM task_runs
            WHERE task_id = t.id AND session_pct_after IS NOT NULL AND session_pct_before IS NOT NULL) AS session_delta,
         (SELECT COUNT(*) FROM task_events WHERE task_id = t.id AND kind = 'status' AND to_status = 'attention') AS attention_count
       FROM tasks t
       WHERE t.experiment IS NOT NULL AND t.experiment <> ''
         AND t.status IN ('closed', 'attention', 'failed')
         AND t.updated_at >= datetime('now', ?)`,
    )
    .all(since) as {
    experiment: string;
    status: string;
    resume_count: number;
    created_at: string;
    updated_at: string;
    session_delta: number | null;
    attention_count: number;
  }[];
  const experimentTags = [...new Set(experimentRows.map((r) => r.experiment))].sort();
  const experimentGroups = experimentTags.map((tag) => {
    const rows = experimentRows.filter((r) => r.experiment === tag);
    const passed = rows.filter((r) => r.status === 'closed');
    const sessionDeltas = rows.map((r) => r.session_delta).filter((d): d is number => d != null);
    // cycle time only means created->closed; non-closed terminal tasks have no real cycle.
    const cycleMins = passed.map((r) => (tsToMs(r.updated_at) - tsToMs(r.created_at)) / 60000);
    return {
      experiment: tag,
      count: rows.length,
      passed: passed.length,
      pass_rate: rows.length ? passed.length / rows.length : 0,
      avg_session_pct: avg(sessionDeltas),
      attention_rate: rows.length ? rows.filter((r) => r.attention_count > 0).length / rows.length : 0,
      avg_resume_count: avg(rows.map((r) => r.resume_count)),
      avg_cycle_min: avg(cycleMins),
    };
  });

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
    discipline_ab: { groups: disciplineGroups },
    experiment_ab: { groups: experimentGroups },
  };
}
