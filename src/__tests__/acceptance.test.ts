import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createRun, createTask, getRun, getTask } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { runVerifyPipeline } from '../orchestrator/run.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import {
  AcceptanceError,
  evaluateAcceptance,
  extractMetrics,
  formatAcceptance,
  globToRegExp,
  parseAcceptance,
  parseProtected,
  protectedViolations,
} from '../orchestrator/acceptance.js';

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
const dir = (tag = 'acc') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-${tag}-`));
  tmp.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** main has the evaluation script + an algorithm file; the task branch is checked out. */
function repo(): string {
  const r = dir('repo');
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t');
  git(r, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(r, 'scripts', 'eval'), { recursive: true });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'scripts', 'eval', 'score.py'), 'THRESH = 0.5\n');
  fs.writeFileSync(path.join(r, 'src', 'detect.cu'), '// v1\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'base');
  git(r, 'checkout', '-q', '-b', 'loop/t1');
  return r;
}

describe('驗收指標: parsing, extraction, evaluation', () => {
  it('parses thresholds written the way people write them', () => {
    expect(parseAcceptance('detection_rate >= 0.98; false_positive_rate<=0.01\n- miss == 0, gl_mean_err ≤ 0.5, fps = 30')).toEqual([
      { name: 'detection_rate', op: '>=', target: 0.98 },
      { name: 'false_positive_rate', op: '<=', target: 0.01 },
      { name: 'miss', op: '==', target: 0 },
      { name: 'gl_mean_err', op: '<=', target: 0.5 },
      { name: 'fps', op: '==', target: 30 },
    ]);
    expect(parseAcceptance('recall >= 98%')).toEqual([{ name: 'recall', op: '>=', target: 98 }]);
    expect(parseAcceptance('')).toEqual([]);
    expect(() => parseAcceptance('檢出率要高')).toThrow(AcceptanceError);
    expect(() => parseAcceptance('detection_rate >= high')).toThrow(/看不懂/);
  });

  it('reads LOOP_METRICS lines from any step output; the later value wins', () => {
    const v = extractMetrics([
      'building…\nLOOP_METRICS {"detection_rate": 0.95, "miss": 2}\n',
      'noise LOOP_METRICS not-at-line-start\nLOOP_METRICS {"detection_rate": 0.991, "note": "set-0615", "fps": "31.5"}\nLOOP_METRICS {bad json}',
    ]);
    expect(v).toEqual({ detection_rate: 0.991, miss: 2, note: 'set-0615', fps: 31.5 });
  });

  it('compares, lists what failed, and says how to report a missing metric', () => {
    const specs = parseAcceptance('detection_rate >= 0.98; miss == 0; false_positive_rate <= 0.01');
    const r = evaluateAcceptance(specs, { detection_rate: 0.985, miss: 1 });
    expect(r.pass).toBe(false);
    expect(r.checks.map((c) => [c.name, c.pass])).toEqual([['detection_rate', true], ['miss', false], ['false_positive_rate', false]]);
    const table = formatAcceptance(r);
    expect(table).toContain('✅ detection_rate = 0.985，要求 >= 0.98');
    expect(table).toContain('❌ miss = 1，要求 == 0');
    expect(table).toContain('LOOP_METRICS {"false_positive_rate"');
    expect(evaluateAcceptance(parseAcceptance('detection_rate >= 0.98'), { detection_rate: 0.98 }).pass).toBe(true); // boundary
  });
});

describe('保護路徑', () => {
  it('matches globs, directories and plain files', () => {
    const m = (g: string, f: string) => globToRegExp(g).test(f);
    expect(m('scripts/eval/**', 'scripts/eval/score.py')).toBe(true);
    expect(m('scripts/eval/**', 'scripts/eval/sub/x.py')).toBe(true);
    expect(m('scripts/eval/', 'scripts/eval/score.py')).toBe(true);
    expect(m('scripts/eval', 'scripts/eval/score.py')).toBe(true);
    expect(m('scripts/eval', 'scripts/evaluate.py')).toBe(false);
    expect(m('*.json', 'recipe.json')).toBe(true);
    expect(m('*.json', 'cfg/recipe.json')).toBe(false);
    expect(m('**/golden/*.json', 'data/sets/golden/a.json')).toBe(true);
    expect(m('src/detect.cu', 'src/detect.cu')).toBe(true);
    expect(parseProtected('scripts/eval/**, `data/golden/**`\n- recipes/*.json')).toEqual(['scripts/eval/**', 'data/golden/**', 'recipes/*.json']);
  });

  it('finds committed and uncommitted changes to protected files only', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'src', 'detect.cu'), '// v2\n');
    git(r, 'commit', '-qam', 'algo');
    expect(protectedViolations(r, 'main', ['scripts/eval/**'])).toEqual([]);
    fs.writeFileSync(path.join(r, 'scripts', 'eval', 'score.py'), 'THRESH = 0.0\n'); // uncommitted
    fs.writeFileSync(path.join(r, 'scripts', 'eval', 'new.py'), 'x\n'); // untracked
    expect(protectedViolations(r, 'main', ['scripts/eval/**'])).toEqual(['scripts/eval/new.py', 'scripts/eval/score.py']);
  });
});

describe('the verify pipeline enforces both', () => {
  const setup = (input: Record<string, unknown>) => {
    const r = repo();
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: ['true'], ...input });
    const run = createRun(db, { task_id: t.id, worktree_path: r });
    return { task: getTask(db, t.id)!, wt: r, runId: run.id };
  };

  it('a touched protected file fails before any step runs, with the files to restore', async () => {
    const { task, wt, runId } = setup({ protected_paths: 'scripts/eval/**', verification_steps: ['touch ran.txt'] });
    fs.writeFileSync(path.join(wt, 'scripts', 'eval', 'score.py'), 'THRESH = 0\n');
    git(wt, 'commit', '-qam', 'cheat');
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('fail');
    expect(fs.existsSync(path.join(wt, 'ran.txt'))).toBe(false);
    const ctx = fs.readFileSync(path.join(wt, 'LOOP_RESUME_CONTEXT.md'), 'utf8');
    expect(ctx).toContain('保護路徑');
    expect(ctx).toContain('scripts/eval/score.py');
    expect(['blocked', 'attention']).toContain(getTask(db, task.id)!.status);
  });

  it('metrics below the task threshold fail verification and hand the table back', async () => {
    const { task, wt, runId } = setup({
      acceptance_metrics: 'detection_rate >= 0.98; miss == 0',
      verification_steps: [`echo 'LOOP_METRICS {"detection_rate": 0.962, "miss": 0}'`],
    });
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('fail');
    const ctx = fs.readFileSync(path.join(wt, 'LOOP_RESUME_CONTEXT.md'), 'utf8');
    expect(ctx).toContain('驗收指標');
    expect(ctx).toContain('❌ detection_rate = 0.962，要求 >= 0.98');
    const run = getRun(db, runId)!;
    expect(JSON.parse(run.metrics_json!)).toMatchObject({ pass: false, values: { detection_rate: 0.962, miss: 0 } });
    expect(JSON.parse(run.verify_json!)[0]).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('metrics that meet it pass, and are recorded for the morning report', async () => {
    const { task, wt, runId } = setup({
      acceptance_metrics: 'detection_rate >= 0.98',
      verification_steps: [`echo 'LOOP_METRICS {"detection_rate": 0.991, "false_positive_rate": 0.004}'`],
    });
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('pass');
    const m = JSON.parse(getRun(db, runId)!.metrics_json!);
    expect(m).toMatchObject({ pass: true, values: { detection_rate: 0.991, false_positive_rate: 0.004 } });
    const notes = db.prepare(`SELECT detail FROM task_events WHERE run_id = ? AND kind = 'note'`).all(runId) as { detail: string }[];
    expect(notes.map((n) => n.detail).join('\n')).toContain('驗收指標通過：detection_rate=0.991');
  });

  it('thresholds that cannot be measured here go to a human instead of passing', async () => {
    const { task, wt, runId } = setup({ acceptance_metrics: 'detection_rate >= 0.98', verify_mode: 'manual', verification_steps: [] });
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('manual');
  });

  it('with neither field set nothing changes (no metrics recorded)', async () => {
    const { task, wt, runId } = setup({ verification_steps: ['true'] });
    expect(await runVerifyPipeline(db, task, wt, runId, 'main')).toBe('pass');
    expect(getRun(db, runId)!.metrics_json).toBeNull();
  });
});

describe('gate and task file', () => {
  it('the gate refuses unreadable thresholds and thresholds nothing can measure', () => {
    const bad = getTask(db, createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: ['true'], acceptance_metrics: '要準' }).id)!;
    expect(validateTask(bad).missing.join()).toContain('acceptance_metrics');
    const none = getTask(db, createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: [], verify_mode: 'command,manual', acceptance_metrics: 'recall >= 0.9' }).id)!;
    expect(validateTask(none).missing.join()).toContain('LOOP_METRICS');
  });

  it('LOOP_TASK.md tells the agent the targets, the line to print, and what not to touch', () => {
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', verification_steps: ['x'], acceptance_metrics: 'detection_rate >= 0.98; miss == 0', protected_paths: 'scripts/eval/**' }).id)!;
    const md = fs.readFileSync(writeTaskFile(dir(), task, {}), 'utf8');
    expect(md).toContain('## 驗收指標（引擎自動檢查');
    expect(md).toContain('`detection_rate >= 0.98`');
    expect(md).toContain('LOOP_METRICS {"detection_rate": 數值');
    expect(md).toContain('## 保護路徑（不得修改）');
    expect(md).toContain('`scripts/eval/**`');
    const plain = getTask(db, createTask(db, { title: 't', goal: 'g', verification_steps: ['x'] }).id)!;
    expect(fs.readFileSync(writeTaskFile(dir(), plain, {}), 'utf8')).not.toMatch(/驗收指標|保護路徑/);
  });
});
