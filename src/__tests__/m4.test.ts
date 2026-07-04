import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, getNum } from '../db/index.js';
import { createTask } from '../tasks.js';
import { estimatePct, isCalibrated } from '../token/accounting.js';
import { createPr, hasRemote } from '../git/pr.js';
import { runGapReview } from '../review/gapReviewer.js';
import { nanoid } from 'nanoid';

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

/** insert a finished run with a measured session %-point delta for a task's complexity */
function seedRun(taskId: string, before: number, after: number): void {
  db.prepare(
    `INSERT INTO task_runs (id, task_id, attempt, session_pct_before, session_pct_after, finished_at)
     VALUES (?, ?, 1, ?, ?, datetime('now'))`,
  ).run(`r_${nanoid(8)}`, taskId, before, after);
}

describe('estimate calibration', () => {
  it('uses the seed default until 5 samples, then the measured median', () => {
    const t = createTask(db, {
      title: 'x',
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['true'],
      complexity: 'M',
    });
    const seed = getNum(db, 'est_pct_M', 8);
    expect(estimatePct(db, 'M')).toBe(seed);
    expect(isCalibrated(db, 'M')).toBe(false);

    // 5 runs with deltas 4,5,6,7,8 -> median 6
    for (const [b, a] of [
      [10, 14],
      [20, 25],
      [30, 36],
      [40, 47],
      [50, 58],
    ]) {
      seedRun(t.id, b, a);
    }
    expect(isCalibrated(db, 'M')).toBe(true);
    expect(estimatePct(db, 'M')).toBe(6);
  });
});

describe('PR + gap-review guards (host-only, must no-op safely)', () => {
  it('createPr returns null with no remote', () => {
    // a temp dir that is not a git repo with a remote
    expect(createPr('/tmp', 'loop/x', 'title')).toBeNull();
  });

  it('hasRemote is false for a non-repo path', () => {
    expect(hasRemote('/tmp/definitely-not-a-repo-xyz')).toBe(false);
  });

  it('runGapReview returns null for a mock task (never runs claude)', () => {
    const t = createTask(db, {
      title: 'x',
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['true'],
      complexity: 'S',
    });
    expect(runGapReview(t, '/tmp')).toBeNull();
  });
});
