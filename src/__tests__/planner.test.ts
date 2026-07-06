import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { runTask } from '../orchestrator/run.js';
import { boardState } from '../server/board.js';
import { parsePlan, materializePlan, runPlanner, type PlannedSubtask, type PlannerExec } from '../orchestrator/planner.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let tmpRoots: string[] = [];

const PLAN_BASE = {
  title: 'Epic: ship feature X',
  goal: 'build feature X end to end',
  plan_ref: 'https://example.com/epic-brief.md',
  plan_kind: 'url' as const,
  coding_tool: 'plan',
};

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

// hermetic local git fixture (no network) — children get coding_tool='claude-code', which
// needs a real repo/branch to pass the gate.
function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function makeRepo(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `loop-planner-${tag}-`));
  tmpRoots.push(root);
  const repo = path.join(root, 'repo');
  git(root, ['init', '-b', 'main', 'repo']);
  git(repo, ['config', 'user.email', 'loop@test.local']);
  git(repo, ['config', 'user.name', 'Loop Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'v1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--no-verify', '-m', 'seed']);
  return repo;
}

const twoSubtasks = (): PlannedSubtask[] => [
  { title: 'Sub A', goal: 'do part A', verify_steps: ['npm run typecheck'], complexity: 'S', order: 1 },
  { title: 'Sub B', goal: 'do part B', verify_steps: [], complexity: 'M', verify_mode: 'manual', requires: 'gpu', order: 2 },
];

// ---- 1. gate: coding_tool=plan ----

describe('gate: coding_tool=plan', () => {
  it('no verify_steps, no repo/base — passes on goal+plan_ref alone', () => {
    const t = createTask(db, PLAN_BASE);
    const gate = validateTask(getTask(db, t.id)!);
    expect(gate.ok).toBe(true);
    expect(gate.missing).toEqual([]);
  });

  it('still needs plan_ref (the epic brief)', () => {
    const t = createTask(db, { ...PLAN_BASE, plan_ref: null, plan_kind: null });
    const gate = validateTask(getTask(db, t.id)!);
    expect(gate.ok).toBe(false);
    expect(gate.missing.join(' ')).toMatch(/plan_ref/);
  });

  it('repo_path/base_branch are never checked, even set to a non-existent path', () => {
    const t = createTask(db, { ...PLAN_BASE, repo_path: '/no/such/dir', base_branch: 'nope' });
    expect(validateTask(getTask(db, t.id)!).ok).toBe(true);
  });
});

// ---- 2. parsePlan ----

describe('parsePlan', () => {
  it('parses valid strict JSON into subtasks', () => {
    const out = parsePlan(
      JSON.stringify({
        subtasks: [
          { title: 'Sub A', goal: 'do A', verify_steps: ['npm test'], complexity: 'S', order: 1 },
          { title: 'Sub B', goal: 'do B', verify_steps: [], complexity: 'M', order: 2 },
        ],
      }),
    );
    expect(out).toEqual([
      { title: 'Sub A', goal: 'do A', verify_steps: ['npm test'], complexity: 'S', verify_mode: undefined, requires: undefined, order: 1 },
      { title: 'Sub B', goal: 'do B', verify_steps: [], complexity: 'M', verify_mode: undefined, requires: undefined, order: 2 },
    ]);
  });

  it('returns null for malformed JSON', () => {
    expect(parsePlan('not json {{{')).toBeNull();
  });

  it('returns null when subtasks is missing or not an array', () => {
    expect(parsePlan(JSON.stringify({ nope: [] }))).toBeNull();
    expect(parsePlan(JSON.stringify({ subtasks: 'nope' }))).toBeNull();
  });

  it('drops an item missing title/goal but keeps the valid ones', () => {
    const out = parsePlan(
      JSON.stringify({
        subtasks: [
          { title: '', goal: 'no title', order: 1 },
          { title: 'ok', goal: 'ok goal', order: 2 },
        ],
      }),
    );
    expect(out).toEqual([{ title: 'ok', goal: 'ok goal', verify_steps: [], complexity: 'M', verify_mode: undefined, requires: undefined, order: 2 }]);
  });

  it('returns null (not []) when every item is invalid', () => {
    expect(parsePlan(JSON.stringify({ subtasks: [{ title: '', goal: '' }] }))).toBeNull();
  });

  it('caps at 6 subtasks even when the model returns more', () => {
    const subtasks = Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, goal: `g${i}`, order: i + 1 }));
    const out = parsePlan(JSON.stringify({ subtasks }));
    expect(out).toHaveLength(6);
  });

  it('defaults an invalid complexity to M and a missing order to array position', () => {
    const out = parsePlan(JSON.stringify({ subtasks: [{ title: 't', goal: 'g', complexity: 'XL' }] }));
    expect(out![0].complexity).toBe('M');
    expect(out![0].order).toBe(1);
  });

  it('strips a ```json fenced block before parsing', () => {
    const payload = JSON.stringify({ subtasks: [{ title: 't', goal: 'g', order: 1 }] });
    const out = parsePlan('```json\n' + payload + '\n```');
    expect(out).not.toBeNull();
    expect(out![0].title).toBe('t');
  });
});

// ---- 3. materializePlan ----

describe('materializePlan', () => {
  it('creates N children: parent_id set, chained by depends_on in order, inherit repo/base/env/model', () => {
    const repo = makeRepo('materialize');
    const epic = getTask(
      db,
      createTask(db, { ...PLAN_BASE, repo_path: repo, base_branch: 'main', environment: 'home', model: 'sonnet' }).id,
    )!;
    const children = materializePlan(db, epic, twoSubtasks());
    expect(children).toHaveLength(2);

    const [a, b] = children;
    expect(a.parent_id).toBe(epic.id);
    expect(b.parent_id).toBe(epic.id);
    expect(a.depends_on).toBeNull();
    expect(b.depends_on).toBe(a.id);
    expect(a.coding_tool).toBe('claude-code');
    expect(a.repo_path).toBe(repo);
    expect(a.base_branch).toBe('main');
    expect(a.environment).toBe('home');
    expect(a.model).toBe('sonnet');
    expect(a.plan_ref).toBe(epic.plan_ref); // inherited so the gate can pass (plan_ref is required for every tool)

    // verify_mode/requires passthrough
    expect(b.verify_mode).toBe('manual');
    expect(b.requires).toBe('gpu');
  });

  it('queues the first child (gate permitting) and leaves the rest draft', () => {
    const repo = makeRepo('queue-first');
    const epic = getTask(db, createTask(db, { ...PLAN_BASE, repo_path: repo, base_branch: 'main' }).id)!;
    const children = materializePlan(db, epic, twoSubtasks());
    expect(getTask(db, children[0].id)!.status).toBe('queued');
    expect(getTask(db, children[1].id)!.status).toBe('draft');
  });

  it('leaves the first child draft when its gate fails (e.g. no inherited repo)', () => {
    const epic = getTask(db, createTask(db, PLAN_BASE).id)!; // no repo/base to inherit
    const children = materializePlan(db, epic, twoSubtasks());
    // claude-code child with no repo_path fails the gate -> stays draft, visible on the board
    expect(getTask(db, children[0].id)!.status).toBe('draft');
  });

  it('logs a materialization note on the epic', () => {
    const repo = makeRepo('log-note');
    const epic = getTask(db, createTask(db, { ...PLAN_BASE, repo_path: repo, base_branch: 'main' }).id)!;
    materializePlan(db, epic, twoSubtasks());
    const ev = db
      .prepare(`SELECT detail FROM task_events WHERE task_id=? AND kind='note' ORDER BY id DESC LIMIT 1`)
      .get(epic.id) as { detail: string };
    expect(ev.detail).toMatch(/materialized 2 subtask/);
  });
});

// ---- 4. runPlanner: budget/mock guards ----

describe('runPlanner: guards', () => {
  it('never calls exec for a mock task', async () => {
    const t = getTask(db, createTask(db, { ...PLAN_BASE, coding_tool: 'mock' }).id)!;
    let calls = 0;
    const exec: PlannerExec = async () => {
      calls++;
      return null;
    };
    const result = await runPlanner(db, t, exec);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it('does not call exec when session usage is already at/over hard_limit_pct', async () => {
    setCachedUsage(96, 10); // hard_limit_pct default is 95
    const t = getTask(db, createTask(db, PLAN_BASE).id)!;
    let calls = 0;
    const exec: PlannerExec = async () => {
      calls++;
      return null;
    };
    const result = await runPlanner(db, t, exec);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it('calls exec and materializes children when safely under budget', async () => {
    const repo = makeRepo('runplanner-ok');
    const t = getTask(db, createTask(db, { ...PLAN_BASE, repo_path: repo, base_branch: 'main' }).id)!;
    const exec: PlannerExec = async () => JSON.stringify({ subtasks: twoSubtasks() });
    const result = await runPlanner(db, t, exec);
    expect(result).toHaveLength(2);
  });

  it('returns null when exec output fails to parse', async () => {
    const t = getTask(db, createTask(db, PLAN_BASE).id)!;
    const exec: PlannerExec = async () => 'not json';
    expect(await runPlanner(db, t, exec)).toBeNull();
  });
});

// ---- 5. runTask orchestration: coding_tool=plan (planner exec injected — zero tokens) ----

describe('runTask: coding_tool=plan', () => {
  it('epic -> children created + epic closed with a rollup detail', async () => {
    const repo = makeRepo('runtask-ok');
    const t = createTask(db, { ...PLAN_BASE, repo_path: repo, base_branch: 'main' });
    setStatus(db, t.id, 'queued');
    const exec: PlannerExec = async () => JSON.stringify({ subtasks: twoSubtasks() });
    await runTask(db, getTask(db, t.id)!, { plannerExec: exec });

    const epic = getTask(db, t.id)!;
    expect(epic.status).toBe('closed');
    const ev = db
      .prepare(`SELECT detail FROM task_events WHERE task_id=? AND kind='status' AND to_status='closed' ORDER BY id DESC LIMIT 1`)
      .get(t.id) as { detail: string };
    expect(ev.detail).toMatch(/已拆解為 2 個子任務/);

    const children = db.prepare('SELECT * FROM tasks WHERE parent_id = ?').all(t.id) as { id: string }[];
    expect(children).toHaveLength(2);
  });

  it('a planner failure (bad exec output) routes the epic to attention', async () => {
    const t = createTask(db, PLAN_BASE);
    setStatus(db, t.id, 'queued');
    const exec: PlannerExec = async () => null;
    await runTask(db, getTask(db, t.id)!, { plannerExec: exec });
    expect(getTask(db, t.id)!.status).toBe('attention');
  });

  it('never touches a worktree/adapter (no run row created)', async () => {
    const t = createTask(db, PLAN_BASE);
    setStatus(db, t.id, 'queued');
    const exec: PlannerExec = async () => JSON.stringify({ subtasks: twoSubtasks() });
    await runTask(db, getTask(db, t.id)!, { plannerExec: exec });
    const run = db.prepare('SELECT * FROM task_runs WHERE task_id = ?').get(t.id);
    expect(run).toBeUndefined();
  });
});

// ---- 6. board rollup ----

describe('boardState: epic children rollup', () => {
  it('reports {total, closed, running, failed} on the epic card and a parent_id chip on children', () => {
    const repo = makeRepo('board-rollup');
    const epic = getTask(db, createTask(db, { ...PLAN_BASE, repo_path: repo, base_branch: 'main' }).id)!;
    const children = materializePlan(db, epic, twoSubtasks());
    setStatus(db, children[0].id, 'closed');
    setStatus(db, children[1].id, 'running');

    const state = boardState(db);
    const epicCard = state.cards.find((c) => c.id === epic.id)!;
    expect(epicCard.children).toEqual({ total: 2, closed: 1, running: 1, failed: 0 });

    const childCard = state.cards.find((c) => c.id === children[0].id)!;
    expect(childCard.parent_id).toBe(epic.id);
  });
});
