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

/** insert a clean, fully-completed first run with a measured session %-point delta; returns run id */
function seedRun(
  taskId: string,
  before: number,
  after: number,
  opts: { exitCode?: number | null; interruptedBy?: string | null; resumeOf?: string | null } = {},
): string {
  const id = `r_${nanoid(8)}`;
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, attempt, session_pct_before, session_pct_after, exit_code, interrupted_by, resume_of, finished_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    id,
    taskId,
    before,
    after,
    opts.exitCode === undefined ? 0 : opts.exitCode,
    opts.interruptedBy ?? null,
    opts.resumeOf ?? null,
  );
  return id;
}

describe('estimate calibration', () => {
  it('uses the seed default until 5 clean samples, then a high-percentile estimate', () => {
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

    // 5 clean runs with deltas 4,5,6,7,8 -> p75 = 7 (safety margin over median 6)
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
    expect(estimatePct(db, 'M')).toBe(7);
  });

  it('ignores interrupted / non-zero-exit / resume-leg samples', () => {
    const t = createTask(db, {
      title: 'x',
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['true'],
      complexity: 'M',
    });
    const seed = getNum(db, 'est_pct_M', 8);
    // truncated / dirty samples must NOT count toward calibration
    seedRun(t.id, 10, 11, { interruptedBy: 'breaker' });
    seedRun(t.id, 10, 11, { interruptedBy: 'timeout' });
    seedRun(t.id, 10, 11, { exitCode: 1 });
    seedRun(t.id, 10, 11, { exitCode: null });
    const parent = seedRun(t.id, 10, 11, { interruptedBy: 'breaker' });
    seedRun(t.id, 10, 11, { resumeOf: parent }); // resume leg: clean but must be skipped
    expect(isCalibrated(db, 'M')).toBe(false);
    expect(estimatePct(db, 'M')).toBe(seed);
  });
});

describe('PR + gap-review guards (host-only, must no-op safely)', () => {
  it('createPr returns null with no remote', async () => {
    // a temp dir that is not a git repo with a remote
    expect(await createPr('/tmp', 'loop/x', 'title')).toBeNull();
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
