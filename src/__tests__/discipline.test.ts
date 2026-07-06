import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import { runTask } from '../orchestrator/run.js';
import { computeMetrics } from '../server/metrics.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-discipline-${tag}-`));
  tmpRoots.push(d);
  return d;
}

// ---- 1. writeTaskFile: opt-in 執行紀律 block ----

describe('writeTaskFile: prompt_discipline block', () => {
  it('includes ## 執行紀律 when discipline=true, omits it when false/absent', () => {
    const t = getTask(db, createTask(db, { title: 't', goal: 'g', verification_steps: ['true'] }).id)!;

    const onDir = mkTmpDir('on');
    const onPath = writeTaskFile(onDir, t, { discipline: true });
    const onMd = fs.readFileSync(onPath, 'utf8');
    expect(onMd).toMatch(/## 執行紀律/);
    expect(onMd).toMatch(/TDD/);
    expect(onMd).toMatch(/絕不停下反問/);

    const offDir = mkTmpDir('off');
    const offMd = fs.readFileSync(writeTaskFile(offDir, t, { discipline: false }), 'utf8');
    expect(offMd).not.toMatch(/執行紀律/);

    const absentDir = mkTmpDir('absent');
    const absentMd = fs.readFileSync(writeTaskFile(absentDir, t, {}), 'utf8');
    expect(absentMd).not.toMatch(/執行紀律/);

    // byte-identical to calling writeTaskFile with no extras at all (the pre-existing shape)
    const noExtrasDir = mkTmpDir('noextras');
    const noExtrasMd = fs.readFileSync(writeTaskFile(noExtrasDir, t), 'utf8');
    expect(offMd).toBe(noExtrasMd);
    expect(absentMd).toBe(noExtrasMd);
  });
});

// ---- 2. e2e via runTask (mock adapter): records task_runs.discipline ----

describe('runTask: records task_runs.discipline from the prompt_discipline setting', () => {
  function runRow(taskId: string): any {
    return db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId);
  }

  it('discipline=1 + LOOP_TASK.md has the block when prompt_discipline is on', async () => {
    setSetting(db, 'prompt_discipline', 'true');
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 'discipline-on task',
      goal: 'do the thing',
      coding_tool: 'mock',
      verification_steps: ['true'],
    });

    await runTask(db, getTask(db, t.id)!, {});

    const row = runRow(t.id);
    expect(row.discipline).toBe(1);
    const md = fs.readFileSync(path.join(row.worktree_path, 'LOOP_TASK.md'), 'utf8');
    expect(md).toMatch(/## 執行紀律/);
  });

  it('discipline=0 + LOOP_TASK.md omits the block when prompt_discipline is off (default)', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 'discipline-off task',
      goal: 'do the other thing',
      coding_tool: 'mock',
      verification_steps: ['true'],
    });

    await runTask(db, getTask(db, t.id)!, {});

    const row = runRow(t.id);
    expect(row.discipline).toBe(0);
    const md = fs.readFileSync(path.join(row.worktree_path, 'LOOP_TASK.md'), 'utf8');
    expect(md).not.toMatch(/執行紀律/);
  });
});

// ---- 3. computeMetrics: discipline_ab grouping ----

describe('computeMetrics: discipline_ab', () => {
  /** Seed a closed task with one run carrying a given discipline flag + session delta. */
  function seedDisciplineTask(opts: {
    discipline: 0 | 1;
    sessionDelta: number;
    attention?: boolean;
    resumeCount?: number;
  }): string {
    const t = createTask(db, {
      title: `discipline=${opts.discipline}`,
      goal: 'g',
      coding_tool: 'mock',
      verification_steps: ['true'],
    });
    const today = new Date().toISOString().slice(0, 10);
    const createdAt = `${today} 08:00:00`;
    const closedAt = `${today} 09:00:00`; // 60 min cycle
    db.prepare(
      `UPDATE tasks SET created_at = ?, updated_at = ?, status = 'closed', resume_count = ? WHERE id = ?`,
    ).run(createdAt, closedAt, opts.resumeCount ?? 0, t.id);
    db.prepare(
      `INSERT INTO task_runs (id, task_id, discipline, session_pct_before, session_pct_after, started_at)
       VALUES (@id, @task_id, @discipline, @before, @after, @started_at)`,
    ).run({
      id: `r_seed_${t.id}`,
      task_id: t.id,
      discipline: opts.discipline,
      before: 10,
      after: 10 + opts.sessionDelta,
      started_at: createdAt,
    });
    if (opts.attention) {
      db.prepare(
        `INSERT INTO task_events (task_id, kind, from_status, to_status, created_at) VALUES (?, 'status', 'running', 'attention', ?)`,
      ).run(t.id, createdAt);
    }
    return t.id;
  }

  it('groups closed tasks by their latest run discipline flag with correct per-group stats', () => {
    seedDisciplineTask({ discipline: 0, sessionDelta: 10, resumeCount: 1 });
    seedDisciplineTask({ discipline: 0, sessionDelta: 20, attention: true, resumeCount: 2 });
    seedDisciplineTask({ discipline: 1, sessionDelta: 4 });
    seedDisciplineTask({ discipline: 1, sessionDelta: 6 });

    const ab = computeMetrics(db, { days: 14 }).discipline_ab;
    const off = ab.groups.find((g) => g.discipline === 0)!;
    const on = ab.groups.find((g) => g.discipline === 1)!;

    expect(off.count).toBe(2);
    expect(off.avg_session_pct).toBeCloseTo(15);
    expect(off.attention_rate).toBeCloseTo(0.5);
    expect(off.avg_resume_count).toBeCloseTo(1.5);
    expect(off.avg_cycle_min).toBeCloseTo(60);

    expect(on.count).toBe(2);
    expect(on.avg_session_pct).toBeCloseTo(5);
    expect(on.attention_rate).toBe(0);
    expect(on.avg_resume_count).toBe(0);
    expect(on.avg_cycle_min).toBeCloseTo(60);
  });

  it('empty DB -> zero-count groups, no crash', () => {
    const ab = computeMetrics(db, { days: 14 }).discipline_ab;
    expect(ab.groups).toHaveLength(2);
    for (const g of ab.groups) {
      expect(g.count).toBe(0);
      expect(g.avg_session_pct).toBeNull();
      expect(g.attention_rate).toBe(0);
      expect(g.avg_resume_count).toBeNull();
      expect(g.avg_cycle_min).toBeNull();
    }
  });
});

// ---- 4. default-off zero-impact regression ----

describe('prompt_discipline default is off (zero-impact invariant)', () => {
  it('DEFAULT_SETTINGS seeds prompt_discipline=false', async () => {
    const { getSetting } = await import('../db/index.js');
    expect(getSetting(db, 'prompt_discipline')).toBe('false');
  });
});
