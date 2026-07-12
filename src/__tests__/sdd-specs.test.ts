import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, getSetting } from '../db/index.js';
import { paths } from '../config.js';
import { createTask, getTask } from '../tasks.js';
import { materializePlan, runPlanner, type PlannerExec } from '../orchestrator/planner.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let tmpRoots: string[] = [];
let writtenSpecs: string[] = [];

// A url plan_ref makes the epic's inherited brief obviously distinct from any written .md.
const EPIC = {
  title: 'Epic: ship X',
  goal: 'build X',
  plan_ref: 'https://example.com/brief.md',
  plan_kind: 'url' as const,
  coding_tool: 'plan',
};

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safely under hard_limit_pct so runPlanner proceeds
  tmpRoots = [];
  writtenSpecs = [];
});
afterEach(() => {
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  for (const f of writtenSpecs) fs.rmSync(f, { force: true });
});

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-sdd-'));
  tmpRoots.push(d);
  return d;
}

describe('SDD Phase 2: per-child specs', () => {
  it('flag ON: prompt asks for a spec; each child gets its own spec-*.md; writeTaskFile inlines it', async () => {
    setSetting(db, 'sdd_specs', 'true');
    const epic = getTask(db, createTask(db, EPIC).id)!;
    let captured = '';
    const exec: PlannerExec = async (prompt) => {
      captured = prompt;
      return JSON.stringify({
        subtasks: [
          { title: 'A', goal: 'ga', spec: '# Spec A\n\n## 驗收\n- a works', verify_steps: ['true'], complexity: 'S', order: 1 },
          { title: 'B', goal: 'gb', spec: '# Spec B\n\n## 驗收\n- b works', verify_steps: ['true'], complexity: 'M', order: 2 },
        ],
      });
    };

    const children = (await runPlanner(db, epic, exec))!;
    // the decomposition prompt actually requested per-child specs
    expect(captured).toMatch(/自足規格 spec/);
    expect(captured).toMatch(/"spec"/);

    expect(children).toHaveLength(2);
    const [a, b] = children;
    writtenSpecs.push(a.plan_ref!, b.plan_ref!);

    // each child points at its OWN spec file under plansDir (not the shared epic brief)
    expect(a.plan_ref).not.toBe(b.plan_ref);
    expect(a.plan_ref).not.toBe(epic.plan_ref);
    expect(a.plan_ref!.startsWith(paths.plansDir)).toBe(true);
    expect(a.plan_kind).toBe('md');
    expect(fs.readFileSync(a.plan_ref!, 'utf8')).toBe('# Spec A\n\n## 驗收\n- a works');

    // and that spec is what lands in the child's ## Plan section of LOOP_TASK.md
    const md = fs.readFileSync(writeTaskFile(mkTmp(), getTask(db, a.id)!), 'utf8');
    expect(md).toMatch(/# Spec A/);
    expect(md).toMatch(/a works/);
  });

  it('flag OFF (default): prompt omits the spec ask; children inherit epic.plan_ref even if exec returns a stray spec', async () => {
    const epic = getTask(db, createTask(db, EPIC).id)!;
    let captured = '';
    const exec: PlannerExec = async (prompt) => {
      captured = prompt;
      return JSON.stringify({
        subtasks: [{ title: 'A', goal: 'ga', spec: '# stray', verify_steps: ['true'], complexity: 'S', order: 1 }],
      });
    };

    const children = (await runPlanner(db, epic, exec))!;
    expect(captured).not.toMatch(/自足規格/);
    expect(captured).not.toMatch(/"spec"/);
    // byte-identical to today: inherit the epic brief, no file written
    expect(children[0].plan_ref).toBe(epic.plan_ref);
    expect(children[0].plan_kind).toBe(epic.plan_kind);
  });

  it('flag ON but a child has no spec -> that child falls back to epic.plan_ref (never a gate-breaking null)', () => {
    const epic = getTask(db, createTask(db, EPIC).id)!;
    const children = materializePlan(
      db,
      epic,
      [
        { title: 'A', goal: 'ga', spec: '# Spec A', verify_steps: [], complexity: 'S', order: 1 },
        { title: 'B', goal: 'gb', verify_steps: [], complexity: 'S', order: 2 }, // no spec
      ],
      { writeSpecs: true },
    );
    writtenSpecs.push(children[0].plan_ref!);
    expect(children[0].plan_ref!.startsWith(paths.plansDir)).toBe(true);
    expect(children[1].plan_ref).toBe(epic.plan_ref); // fallback, not null
  });

  it('sdd_specs default seed is off (zero-impact invariant)', () => {
    expect(getSetting(db, 'sdd_specs')).toBe('false');
  });
});
