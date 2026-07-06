import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask, setStatus, latestRun } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { runTask } from '../orchestrator/run.js';
import { runLlmJudge, type JudgeExec } from '../orchestrator/judge.js';
import { mockAdapter } from '../orchestrator/adapters/mock.js';
import { listOutputFiles } from '../orchestrator/outputFiles.js';
import { paths } from '../config.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
});

const GENERIC_BASE = {
  title: 'generic task',
  goal: 'write a report',
  plan_ref: 'https://example.com/plan.md',
  plan_kind: 'url' as const,
  coding_tool: 'generic',
};

function rmOutputDir(taskId: string): void {
  fs.rmSync(path.join(paths.outputsDir, taskId), { recursive: true, force: true });
}

// ---- 1. gate ----

describe('gate: coding_tool=generic', () => {
  it('no repo/base + verify_mode=manual passes', () => {
    const t = createTask(db, { ...GENERIC_BASE, verify_mode: 'manual', verification_steps: [] });
    const gate = validateTask(getTask(db, t.id)!);
    expect(gate.ok).toBe(true);
    expect(gate.missing).toEqual([]);
  });

  it('no repo/base + verify_mode=llm (with rubric) passes without a command step', () => {
    const t = createTask(db, {
      ...GENERIC_BASE,
      verify_mode: 'llm',
      verify_rubric: 'the report covers X',
      verification_steps: [],
    });
    expect(validateTask(getTask(db, t.id)!).ok).toBe(true);
  });

  it('a command step also satisfies the gate (default verify_mode=command)', () => {
    const t = createTask(db, { ...GENERIC_BASE, verification_steps: ['true'] });
    expect(validateTask(getTask(db, t.id)!).ok).toBe(true);
  });

  it('still needs plan_ref', () => {
    const t = createTask(db, { ...GENERIC_BASE, plan_ref: null, verify_mode: 'manual', verification_steps: [] });
    const gate = validateTask(getTask(db, t.id)!);
    expect(gate.ok).toBe(false);
    expect(gate.missing.join(' ')).toMatch(/plan_ref/);
  });

  it('default verify_mode (command) with zero steps still fails — manual/llm relaxation does not leak to command-only', () => {
    const t = createTask(db, { ...GENERIC_BASE, verification_steps: [] });
    const gate = validateTask(getTask(db, t.id)!);
    expect(gate.ok).toBe(false);
    expect(gate.missing.join(' ')).toMatch(/verification_steps/);
  });

  it('repo_path/base_branch are never checked for generic, even when set to a non-existent path', () => {
    const t = createTask(db, {
      ...GENERIC_BASE,
      verify_mode: 'manual',
      verification_steps: [],
      repo_path: '/no/such/dir',
      base_branch: 'does-not-exist',
    });
    expect(validateTask(getTask(db, t.id)!).ok).toBe(true);
  });
});

// ---- 2. runTask orchestration (mock adapter injected — zero tokens, no real `claude`) ----

describe('runTask: coding_tool=generic', () => {
  it('workspace is outputs/<id> (persistent), no branch/worktree, reaches review with no merge_status', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, { ...GENERIC_BASE, verification_steps: ['true'] });
    setStatus(db, t.id, 'queued');
    try {
      await runTask(db, getTask(db, t.id)!, { adapter: mockAdapter });

      const done = getTask(db, t.id)!;
      expect(done.status).toBe('review');
      expect(done.merge_status).toBeNull();
      expect(done.pr_url).toBeNull();

      const run = latestRun(db, t.id)!;
      expect(run.branch).toBeNull();
      const expectedDir = path.join(paths.outputsDir, t.id);
      expect(run.worktree_path).toBe(expectedDir);
      expect(fs.existsSync(expectedDir)).toBe(true);
      // not a git worktree — never touched by git
      expect(fs.existsSync(path.join(expectedDir, '.git'))).toBe(false);

      const ev = db
        .prepare(`SELECT detail FROM task_events WHERE task_id=? AND kind='status' AND to_status='review' ORDER BY id DESC LIMIT 1`)
        .get(t.id) as { detail: string };
      expect(ev.detail).toMatch(/outputs\//);
    } finally {
      rmOutputDir(t.id);
    }
  });

  it('the workspace is persistent — pre-existing content survives the dispatch (not a fresh scratch dir)', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, { ...GENERIC_BASE, verification_steps: ['true'] });
    const dir = path.join(paths.outputsDir, t.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prior-work.txt'), 'from an earlier attempt');
    setStatus(db, t.id, 'queued');
    try {
      await runTask(db, getTask(db, t.id)!, { adapter: mockAdapter });
      expect(getTask(db, t.id)!.status).toBe('review');
      // mkdirSync({recursive:true}) on an existing dir never wipes it — the whole point
      // of a persistent output dir vs. mock's fresh mkdtempSync scratch dir.
      expect(fs.existsSync(path.join(dir, 'prior-work.txt'))).toBe(true);
    } finally {
      rmOutputDir(t.id);
    }
  });

  it('manual verify mode reaches review with a note but no merge_status set', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, { ...GENERIC_BASE, verify_mode: 'manual', verification_steps: [] });
    setStatus(db, t.id, 'queued');
    try {
      await runTask(db, getTask(db, t.id)!, { adapter: mockAdapter });
      const done = getTask(db, t.id)!;
      expect(done.status).toBe('review');
      expect(done.merge_status).toBeNull();
    } finally {
      rmOutputDir(t.id);
    }
  });

  it('a failing command step routes through the normal blocked/attention failure path (no git ops attempted)', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, { ...GENERIC_BASE, verification_steps: ['false'] });
    setStatus(db, t.id, 'queued');
    try {
      await runTask(db, getTask(db, t.id)!, { adapter: mockAdapter });
      const done = getTask(db, t.id)!;
      expect(['blocked', 'attention']).toContain(done.status);
      expect(done.merge_status).toBeNull();
    } finally {
      rmOutputDir(t.id);
    }
  });
});

// ---- 3. judge.ts with base=null: file-list prompt instead of a git diff ----

describe('runLlmJudge: base=null (generic, repo-less)', () => {
  it('builds a file-listing prompt from the output dir instead of a git diff', async () => {
    const dir = fs.mkdtempSync(path.join(paths.outputsDir, 'judge-test-'));
    fs.writeFileSync(path.join(dir, 'report.md'), '# Findings\nAll good.');
    try {
      const t = getTask(
        db,
        createTask(db, { ...GENERIC_BASE, verify_rubric: 'covers findings' }).id,
      )!;
      let seenPrompt = '';
      const exec: JudgeExec = async (prompt) => {
        seenPrompt = prompt;
        return JSON.stringify({ pass: true, reason: 'ok' });
      };
      const r = await runLlmJudge(db, t, dir, null, exec);
      expect(r.pass).toBe(true);
      expect(seenPrompt).toMatch(/output files/);
      expect(seenPrompt).toMatch(/report\.md/);
      expect(seenPrompt).not.toMatch(/git diff/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listOutputFiles excludes dotfiles and LOOP_TASK.md', () => {
    const dir = fs.mkdtempSync(path.join(paths.outputsDir, 'listfiles-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'LOOP_TASK.md'), 'x');
      fs.writeFileSync(path.join(dir, '.hidden'), 'x');
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'hello');
      const files = listOutputFiles(dir);
      expect(files.map((f) => f.name)).toEqual(['keep.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 4. /api/tasks/:id/result lists output files for a generic task ----

describe('GET /api/tasks/:id/result: generic output files', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('lists files under outputs/<id> (name + size)', async () => {
    app = buildApp({ db, apiToken: null });
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { ...GENERIC_BASE, verify_mode: 'manual', verification_steps: [] },
    });
    const { task } = created.json();
    const dir = path.join(paths.outputsDir, task.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'result.csv'), '1,2,3');
    try {
      const res = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/result` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.output_dir).toBe(dir);
      expect(body.output_files).toEqual([{ name: 'result.csv', size: 5 }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 5. existing claude-code / mock paths are unaffected ----

describe('zero behavior change for claude-code/mock', () => {
  it('claude-code gate still requires repo_path/base_branch', () => {
    const t = createTask(db, {
      title: 't',
      goal: 'g',
      plan_ref: 'https://example.com/p.md',
      plan_kind: 'url',
      coding_tool: 'claude-code',
      verification_steps: ['true'],
    });
    const gate = validateTask(getTask(db, t.id)!);
    expect(gate.ok).toBe(false);
    expect(gate.missing.join(' ')).toMatch(/repo_path/);
  });

  it('mock e2e is unaffected (scratch worktree dir, review, merge_status null)', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 't',
      goal: 'g',
      plan_ref: 'https://example.com/p.md',
      plan_kind: 'url',
      coding_tool: 'mock',
      verification_steps: ['true'],
    });
    setStatus(db, t.id, 'queued');
    await runTask(db, getTask(db, t.id)!, {});
    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');
    expect(done.merge_status).toBeNull();
    const run = latestRun(db, t.id)!;
    expect(run.worktree_path!.startsWith(paths.worktreesDir)).toBe(true);
  });
});
