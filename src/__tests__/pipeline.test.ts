import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { getTask, setStatus, dependencyState } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { upsertEnvironment, environmentMap } from '../deploy/store.js';
import { boardState } from '../server/board.js';
import { parsePipelineDef, validatePipelineDef, type PipelineDef } from '../pipeline/types.js';
import {
  upsertPipeline,
  getPipelineDef,
  listPipelineDefs,
  importPipelineDefs,
  seedPipelines,
} from '../pipeline/store.js';
import { materializePipeline } from '../pipeline/materialize.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function makeRepo(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `loop-pipeline-${tag}-`));
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

const THREE_STAGE_DEF: PipelineDef = {
  name: 'test-feature',
  description: 'implement -> llm-gate -> deploy home',
  stages: [
    { name: 'implement', coding_tool: 'claude-code', verify_mode: 'command', complexity: 'M' },
    { name: 'review-gate', coding_tool: 'claude-code', verify_mode: 'llm', rubric_hint: 'meets the spec', complexity: 'S' },
    { name: 'deploy-home', coding_tool: 'deploy', environment: 'home' },
  ],
};

// ---- 1. template parse/validate ----

describe('parsePipelineDef / validatePipelineDef', () => {
  it('parses a well-formed template', () => {
    const def = parsePipelineDef(THREE_STAGE_DEF);
    expect(def).toEqual(THREE_STAGE_DEF);
  });

  it('rejects a bad shape (not an object, missing name, empty stages)', () => {
    expect(parsePipelineDef('nope')).toBeNull();
    expect(parsePipelineDef({ stages: [] })).toBeNull();
    expect(parsePipelineDef({ name: 'x', stages: [] })).toBeNull();
    expect(parsePipelineDef({ name: '', stages: [{ name: 'a', coding_tool: 'mock' }] })).toBeNull();
  });

  it('rejects the WHOLE template when any stage is bad — no partial success', () => {
    const bad = {
      name: 'bad-pipeline',
      stages: [
        { name: 'implement', coding_tool: 'claude-code' },
        { name: 'oops', coding_tool: 'not-a-real-tool' }, // invalid coding_tool
      ],
    };
    expect(parsePipelineDef(bad)).toBeNull();
    const v = validatePipelineDef(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/coding_tool/);
  });

  it('rejects a stage missing a name', () => {
    const bad = { name: 'p', stages: [{ coding_tool: 'mock' }] };
    expect(parsePipelineDef(bad)).toBeNull();
  });

  it('rejects an invalid complexity', () => {
    const bad = { name: 'p', stages: [{ name: 'a', coding_tool: 'mock', complexity: 'XL' }] };
    expect(parsePipelineDef(bad)).toBeNull();
  });

  it('accepts a minimal single-stage template (the "fix" shape)', () => {
    const def = parsePipelineDef({
      name: 'fix',
      stages: [{ name: 'implement', coding_tool: 'claude-code', verify_mode: 'command' }],
    });
    expect(def).not.toBeNull();
    expect(def!.stages).toHaveLength(1);
  });
});

// ---- 2. store: seeded built-ins + CRUD + import ----

describe('pipeline/store: seeded built-ins', () => {
  it('seeds feature/fix/ship on first run (openTestDb calls seedPipelines)', () => {
    const names = listPipelineDefs(db).map((d) => d.name).sort();
    expect(names).toEqual(['feature', 'fix', 'ship']);
  });

  it('a re-seed never clobbers a user edit (INSERT OR IGNORE, like environments)', () => {
    upsertPipeline(db, { name: 'feature', description: 'edited', stages: [{ name: 'x', coding_tool: 'mock' }] });
    // simulate a fresh boot on the same db — seeding again must not overwrite the edit
    seedPipelines(db);
    expect(getPipelineDef(db, 'feature')?.description).toBe('edited');
  });
});

describe('pipeline/store: CRUD + import', () => {
  it('upsertPipeline creates then updates in place by name', () => {
    upsertPipeline(db, THREE_STAGE_DEF);
    expect(getPipelineDef(db, 'test-feature')?.stages).toHaveLength(3);
    upsertPipeline(db, { ...THREE_STAGE_DEF, description: 'v2' });
    expect(listPipelineDefs(db).filter((d) => d.name === 'test-feature')).toHaveLength(1);
    expect(getPipelineDef(db, 'test-feature')?.description).toBe('v2');
  });

  it('importPipelineDefs reports created/updated and rejects bad items without failing the batch', () => {
    const result = importPipelineDefs(db, [
      THREE_STAGE_DEF,
      { name: 'bad', stages: [{ name: 'a', coding_tool: 'nope-tool' }] },
      { name: 'test-fix-like', stages: [{ name: 'implement', coding_tool: 'mock' }] },
    ]);
    expect(result.created).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].error).toMatch(/coding_tool/);
    expect(getPipelineDef(db, 'test-feature')).toBeTruthy();
    expect(getPipelineDef(db, 'bad')).toBeUndefined();
  });
});

// ---- 3. materializePipeline: instantiate a template into a task chain ----

describe('materializePipeline', () => {
  it('N stages -> N tasks, depends_on chained in order, shared pipeline_id, per-stage verify_mode/environment/complexity', () => {
    const repo = makeRepo('materialize');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, {
      goal: 'ship the thing',
      repo_path: repo,
      base_branch: 'main',
    });
    expect(tasks).toHaveLength(3);
    const [implement, review, deploy] = tasks;

    // shared pipeline_id, distinct stage_name
    expect(implement.pipeline_id).toBeTruthy();
    expect(implement.pipeline_id).toBe(review.pipeline_id);
    expect(implement.pipeline_id).toBe(deploy.pipeline_id);
    expect([implement.stage_name, review.stage_name, deploy.stage_name]).toEqual([
      'implement',
      'review-gate',
      'deploy-home',
    ]);

    // depends_on chain in stage order
    expect(implement.depends_on).toBeNull();
    expect(review.depends_on).toBe(implement.id);
    expect(deploy.depends_on).toBe(review.id);

    // per-stage fields
    expect(implement.verify_mode).toBe('command');
    expect(implement.complexity).toBe('M');
    expect(review.verify_mode).toBe('llm');
    expect(review.verify_rubric).toBe('meets the spec');
    expect(review.complexity).toBe('S');
    expect(deploy.coding_tool).toBe('deploy');
    expect(deploy.environment).toBe('home');

    // shared goal/repo/base
    for (const t of tasks) {
      expect(t.goal).toBe('ship the thing');
      expect(t.repo_path).toBe(repo);
      expect(t.base_branch).toBe('main');
      expect(t.plan_ref).toBeTruthy(); // synthesized shared plan brief (gate-required for every tool but deploy)
    }

    // title convention: "<label>: <stage name>"
    expect(implement.title).toBe('test-feature: implement');
  });

  it('queues the first stage (gate permitting) and leaves the rest draft', () => {
    const repo = makeRepo('queue-first');
    upsertEnvironment(db, { name: 'home', auto_deploy: false }); // seeded already, but keep explicit for clarity
    const tasks = materializePipeline(db, THREE_STAGE_DEF, {
      goal: 'g',
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['true'],
    });
    expect(getTask(db, tasks[0].id)!.status).toBe('queued');
    expect(getTask(db, tasks[1].id)!.status).toBe('draft');
    expect(getTask(db, tasks[2].id)!.status).toBe('draft');
  });

  it('leaves the first stage draft when its gate fails (e.g. no repo)', () => {
    const tasks = materializePipeline(db, THREE_STAGE_DEF, { goal: 'g' }); // no repo/base
    expect(getTask(db, tasks[0].id)!.status).toBe('draft');
  });

  it('a title override becomes the shared label for every stage', () => {
    const repo = makeRepo('title-override');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, {
      goal: 'g',
      repo_path: repo,
      base_branch: 'main',
      title: 'Q3 launch',
    });
    expect(tasks.map((t) => t.title)).toEqual(['Q3 launch: implement', 'Q3 launch: review-gate', 'Q3 launch: deploy-home']);
  });

  it("a top-level environment fills in for a stage that doesn't set its own, but never overrides one that does", () => {
    const repo = makeRepo('env-override');
    const def: PipelineDef = {
      name: 'env-test',
      stages: [
        { name: 'implement', coding_tool: 'claude-code' }, // no stage-level environment
        { name: 'deploy-home', coding_tool: 'deploy', environment: 'home' }, // stage-level wins
      ],
    };
    const tasks = materializePipeline(db, def, {
      goal: 'g',
      repo_path: repo,
      base_branch: 'main',
      environment: 'company',
    });
    expect(tasks[0].environment).toBe('company'); // filled in from the top-level override
    expect(tasks[1].environment).toBe('home'); // stage's own environment untouched
  });

  it('the single-stage "fix" shape produces exactly one queued task', () => {
    const repo = makeRepo('fix-shape');
    const fixDef = getPipelineDef(db, 'fix')!;
    const tasks = materializePipeline(db, fixDef, {
      goal: 'quick fix',
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['true'],
    });
    expect(tasks).toHaveLength(1);
    expect(getTask(db, tasks[0].id)!.status).toBe('queued');
  });

  it('logs a materialization note on the first stage', () => {
    const repo = makeRepo('log-note');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, { goal: 'g', repo_path: repo, base_branch: 'main' });
    const ev = db
      .prepare(`SELECT detail FROM task_events WHERE task_id=? AND kind='note' ORDER BY id DESC LIMIT 1`)
      .get(tasks[0].id) as { detail: string };
    expect(ev.detail).toMatch(/pipeline 'test-feature' instantiated/);
  });
});

// ---- 4. gate: templates instantiate gate-passing tasks (per V-chain modes) ----

describe('gate: materialized stages satisfy validateTask per their own verify_mode', () => {
  it('the llm-gate stage requires a rubric, which materializePipeline supplies from rubric_hint', () => {
    const repo = makeRepo('gate-llm');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, {
      goal: 'g',
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['true'],
    });
    const review = getTask(db, tasks[1].id)!;
    expect(validateTask(review).ok).toBe(true);
  });

  it('the deploy stage passes the gate against the seeded home environment', () => {
    const repo = makeRepo('gate-deploy');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, { goal: 'g', repo_path: repo, base_branch: 'main' });
    const deploy = getTask(db, tasks[2].id)!;
    expect(validateTask(deploy, '', environmentMap(db)).ok).toBe(true);
  });
});

// ---- 5. a failing stage halts downstream via dep-state (no new execution semantics) ----

describe('failing stage halts the chain', () => {
  it('downstream stage is dep-failed once its dependency fails, and dep_auto_queue never queues it', () => {
    const repo = makeRepo('halt-chain');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, { goal: 'g', repo_path: repo, base_branch: 'main' });
    const [implement, review] = tasks;

    setStatus(db, implement.id, 'failed', { detail: 'boom' });

    const reviewTask = getTask(db, review.id)!;
    expect(dependencyState(db, reviewTask)).toBe('dep-failed');
    expect(reviewTask.status).toBe('draft'); // never auto-queued
  });

  it('a closed (not failed) stage satisfies its dependent, which then can auto-queue', () => {
    const repo = makeRepo('chain-progress');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, { goal: 'g', repo_path: repo, base_branch: 'main' });
    const [implement, review] = tasks;
    setStatus(db, implement.id, 'closed');
    expect(dependencyState(db, getTask(db, review.id)!)).toBe('satisfied');
  });
});

// ---- 6. board pipeline rollup ----

describe('boardState: pipeline rollup', () => {
  it('summarizes stage statuses in depends_on chain order, under the recovered template label', () => {
    const repo = makeRepo('board-rollup');
    const tasks = materializePipeline(db, THREE_STAGE_DEF, { goal: 'g', repo_path: repo, base_branch: 'main' });
    setStatus(db, tasks[0].id, 'closed');
    setStatus(db, tasks[1].id, 'running');
    // tasks[2] stays draft

    const state = boardState(db);
    const rollup = state.pipelines.find((p) => p.pipeline_id === tasks[0].pipeline_id)!;
    expect(rollup).toBeTruthy();
    expect(rollup.name).toBe('test-feature');
    expect(rollup.stages).toEqual([
      { stage_name: 'implement', task_id: tasks[0].id, status: 'closed' },
      { stage_name: 'review-gate', task_id: tasks[1].id, status: 'running' },
      { stage_name: 'deploy-home', task_id: tasks[2].id, status: 'draft' },
    ]);

    // each card carries pipeline_id/stage_name passthrough
    const card = state.cards.find((c) => c.id === tasks[0].id)!;
    expect(card.pipeline_id).toBe(tasks[0].pipeline_id);
    expect(card.stage_name).toBe('implement');
  });

  it('a task with no pipeline_id never appears in the pipelines rollup', () => {
    const state = boardState(db);
    expect(state.pipelines).toEqual([]);
  });
});
