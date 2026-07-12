import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { computeMetrics } from '../server/metrics.js';

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
});

// ---- 1. intake round-trip: experiment persists (or defaults null) ----

describe('createTask: experiment cohort label', () => {
  it('persists a given experiment tag and defaults to null', () => {
    const tagged = getTask(db, createTask(db, { title: 't', goal: 'g', experiment: 'ab_A' }).id)!;
    expect(tagged.experiment).toBe('ab_A');

    const untagged = getTask(db, createTask(db, { title: 't', goal: 'g' }).id)!;
    expect(untagged.experiment).toBeNull();
  });
});

// ---- 2. computeMetrics: experiment_ab grouping ----

describe('computeMetrics: experiment_ab', () => {
  const today = new Date().toISOString().slice(0, 10);
  const createdAt = `${today} 08:00:00`;
  const closedAt = `${today} 09:00:00`; // 60 min cycle

  /** Seed one terminal task in a cohort with a run carrying a session delta. */
  function seed(opts: {
    experiment: string | null;
    status: 'closed' | 'attention' | 'failed' | 'running';
    sessionDelta?: number;
    attentionEvent?: boolean;
    resumeCount?: number;
  }): string {
    const t = createTask(db, {
      title: `${opts.experiment}/${opts.status}`,
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['true'],
      experiment: opts.experiment,
    });
    db.prepare(
      `UPDATE tasks SET created_at = ?, updated_at = ?, status = ?, resume_count = ? WHERE id = ?`,
    ).run(createdAt, closedAt, opts.status, opts.resumeCount ?? 0, t.id);
    if (opts.sessionDelta != null) {
      db.prepare(
        `INSERT INTO task_runs (id, task_id, session_pct_before, session_pct_after, started_at)
         VALUES (@id, @task_id, @before, @after, @started_at)`,
      ).run({
        id: `r_seed_${t.id}`,
        task_id: t.id,
        before: 10,
        after: 10 + opts.sessionDelta,
        started_at: createdAt,
      });
    }
    if (opts.attentionEvent) {
      db.prepare(
        `INSERT INTO task_events (task_id, kind, from_status, to_status, created_at) VALUES (?, 'status', 'running', 'attention', ?)`,
      ).run(t.id, createdAt);
    }
    return t.id;
  }

  it('groups terminal tasks by cohort with correct pass-rate, cost, and rework stats', () => {
    // Cohort ab_B: SDD + cheap model — cheaper, more reliable
    seed({ experiment: 'ab_B', status: 'closed', sessionDelta: 1, resumeCount: 0 });
    seed({ experiment: 'ab_B', status: 'closed', sessionDelta: 1, resumeCount: 0 });
    seed({ experiment: 'ab_B', status: 'attention', sessionDelta: 2, resumeCount: 1, attentionEvent: true });
    // Cohort ab_A: baseline — costlier, less reliable
    seed({ experiment: 'ab_A', status: 'closed', sessionDelta: 4, resumeCount: 1 });
    seed({ experiment: 'ab_A', status: 'failed', sessionDelta: 5, resumeCount: 2 });
    // Noise that must be excluded: no experiment, and a still-running tagged task
    seed({ experiment: null, status: 'closed', sessionDelta: 9 });
    seed({ experiment: 'ab_B', status: 'running', sessionDelta: 9 });

    const groups = computeMetrics(db, { days: 14 }).experiment_ab.groups;
    expect(groups.map((g) => g.experiment)).toEqual(['ab_A', 'ab_B']); // sorted, no null cohort

    const b = groups.find((g) => g.experiment === 'ab_B')!;
    expect(b.count).toBe(3); // running task excluded
    expect(b.passed).toBe(2);
    expect(b.pass_rate).toBeCloseTo(2 / 3);
    expect(b.avg_session_pct).toBeCloseTo((1 + 1 + 2) / 3);
    expect(b.attention_rate).toBeCloseTo(1 / 3);
    expect(b.avg_resume_count).toBeCloseTo(1 / 3);
    expect(b.avg_cycle_min).toBeCloseTo(60); // over closed tasks only

    const a = groups.find((g) => g.experiment === 'ab_A')!;
    expect(a.count).toBe(2);
    expect(a.passed).toBe(1);
    expect(a.pass_rate).toBeCloseTo(0.5);
    expect(a.avg_session_pct).toBeCloseTo(4.5);
    expect(a.attention_rate).toBe(0);
    expect(a.avg_resume_count).toBeCloseTo(1.5);

    // the whole point of the harness: the cheap+SDD arm is cheaper and passes more
    expect(b.avg_session_pct!).toBeLessThan(a.avg_session_pct!);
    expect(b.pass_rate).toBeGreaterThan(a.pass_rate);
  });

  it('empty DB / no tagged tasks -> empty groups, no crash', () => {
    expect(computeMetrics(db, { days: 14 }).experiment_ab.groups).toEqual([]);
    // an untagged closed task must not create a phantom cohort
    seed({ experiment: null, status: 'closed', sessionDelta: 3 });
    expect(computeMetrics(db, { days: 14 }).experiment_ab.groups).toEqual([]);
  });
});
