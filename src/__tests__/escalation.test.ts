import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus, latestRun } from '../tasks.js';
import { runTask, attemptHistory } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;

const MOCK_TASK = {
  title: 'mock task',
  goal: 'do a thing',
  plan_ref: 'https://example.com/plan.md',
  plan_kind: 'url' as const,
  coding_tool: 'mock',
  verification_steps: ['false'], // verification always fails
  complexity: 'S' as const,
  model: 'sonnet',
};

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  process.env.MOCK_SLEEP_MS = '50';
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
});

// a mock task gets a fresh scratch worktree per dispatch (a real task reuses loop/<id>): read the newest
const resumeContext = (taskId: string): string => {
  const dir = path.dirname(latestRun(db, taskId)!.worktree_path!);
  const newest = fs
    .readdirSync(dir)
    .filter((d) => d.startsWith(`mock-${taskId}-`))
    .map((d) => path.join(dir, d))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]!;
  return fs.readFileSync(path.join(newest, 'LOOP_RESUME_CONTEXT.md'), 'utf8');
};

describe('fix budget and model escalation ladder', () => {
  it('off by default: a verify failure uses the resume budget exactly as before', async () => {
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    await runTask(db, getTask(db, t.id)!, {});
    const cur = getTask(db, t.id)!;
    expect(cur.status).toBe('blocked');
    expect(cur.resume_count).toBe(1);
    expect(cur.fix_attempts).toBe(0);
    expect(resumeContext(t.id)).not.toContain('## 之前的嘗試');
  });

  it('counts fixes on their own budget, then hands the same branch to the next model with the history', async () => {
    setSetting(db, 'fix_attempts', '1');
    setSetting(db, 'fix_escalation', 'sonnet, local:glm53-flash'); // the failing model itself is skipped
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');

    await runTask(db, getTask(db, t.id)!, {});
    let cur = getTask(db, t.id)!;
    expect(cur.status).toBe('blocked');
    expect(cur.fix_attempts).toBe(1);
    expect(cur.resume_count).toBe(0); // interrupts keep their own max_resumes budget

    await runTask(db, getTask(db, t.id)!, { resume: true });
    cur = getTask(db, t.id)!;
    expect(cur.status).toBe('queued');
    expect(cur.model).toBe('local:glm53-flash');
    expect(cur.ladder_step).toBe(2);
    expect(cur.fix_attempts).toBe(0);

    const ctx = resumeContext(t.id);
    expect(ctx).toContain('## 交接');
    expect(ctx).toContain('前一個模型（sonnet）用完了 1 次修正機會');
    expect(ctx).toContain('## 之前的嘗試');
    expect(attemptHistory(db, t.id)).toEqual([
      expect.stringMatching(/^第 1 次 · sonnet · 沒過「false」（exit 1）/),
      expect.stringMatching(/^第 2 次 · sonnet · 沒過「false」（exit 1）/),
    ]);
  });

  it('with the ladder exhausted the task goes to a person, saying both budgets are spent', async () => {
    setSetting(db, 'fix_attempts', '0');
    const t = createTask(db, MOCK_TASK);
    setStatus(db, t.id, 'queued');
    await runTask(db, getTask(db, t.id)!, {});
    const cur = getTask(db, t.id)!;
    expect(cur.status).toBe('attention');
    expect(cur.model).toBe('sonnet');
    const events = db.prepare("SELECT detail FROM task_events WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(t.id) as { detail: string };
    expect(events.detail).toContain('修正與換模型都用完了');
  });
});
