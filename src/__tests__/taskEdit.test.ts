import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { updateVerification, TaskEditError } from '../taskEdit.js';
import { buildApp } from '../server/app.js';
import { parseSteps } from '../types.js';

/**
 * A task's verification could not change after it was created — moving a step into the GPU 沙盒 so
 * the review page's 試跑 could run it meant editing the database by hand. PATCH /api/tasks/:id and
 * `loop edit` change the verification fields only, and never while the task runs.
 */

let db: Database.Database;
let app: FastifyInstance | undefined;

const task = () =>
  createTask(db, {
    title: 'cuda',
    goal: 'g',
    plan_ref: 'https://example.com/p.md',
    plan_kind: 'url',
    coding_tool: 'claude-code',
    verification_steps: ['bash arith_ncu/run_ncu.sh'],
    complexity: 'S',
  });

beforeEach(() => {
  db = openTestDb();
  app = undefined;
});
afterEach(async () => {
  await app?.close();
  db.close();
});

describe('updateVerification', () => {
  it('moves a step into the sandbox and adds thresholds, artifacts and a timeout — and says so in the log', () => {
    const t = task();
    setStatus(db, t.id, 'review', { detail: 'verification passed' });
    const after = updateVerification(
      db,
      t.id,
      {
        verification_steps: ['  sandbox: bash arith_ncu/run_ncu.sh ', ''],
        verify_mode: 'command, manual',
        acceptance_metrics: 'pass == 4; ncu == 1',
        artifacts: 'arith_ncu/*.ncu-rep,\n  ',
        verify_timeout_min: 15,
      },
      '呂侑儒',
    );
    expect(parseSteps(after)).toEqual(['sandbox: bash arith_ncu/run_ncu.sh']);
    expect(after).toMatchObject({ verify_mode: 'command,manual', acceptance_metrics: 'pass == 4; ncu == 1', artifacts: 'arith_ncu/*.ncu-rep', verify_timeout_min: 15, status: 'review' });
    const note = db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 1").get(t.id) as { detail: string };
    expect(note.detail).toContain('驗證設定已修改（呂侑儒）');
  });

  it('clears a field with an empty value', () => {
    const t = task();
    updateVerification(db, t.id, { acceptance_metrics: 'pass == 4', artifacts: 'x/*.bin' });
    const after = updateVerification(db, t.id, { acceptance_metrics: '', artifacts: '' });
    expect(after.acceptance_metrics).toBeNull();
    expect(after.artifacts).toBeNull();
  });

  it('rejects what verification could not use', () => {
    const t = task();
    expect(() => updateVerification(db, t.id, { acceptance_metrics: 'fast enough' })).toThrow(TaskEditError);
    expect(() => updateVerification(db, t.id, { verify_mode: 'command,vibes' })).toThrow(/verify_mode/);
    expect(() => updateVerification(db, t.id, { verify_timeout_min: 0 })).toThrow(/verify_timeout_min/);
    expect(() => updateVerification(db, t.id, { verification_steps: ['x'.repeat(2001)] })).toThrow(/longer than/);
    expect(() => updateVerification(db, t.id, {})).toThrow(/nothing to change/);
    expect(getTask(db, t.id)!.verification_steps).toBe('["bash arith_ncu/run_ncu.sh"]');
  });

  it('refuses while the task runs', () => {
    const t = task();
    setStatus(db, t.id, 'running', { detail: 'dispatched' });
    try {
      updateVerification(db, t.id, { verification_steps: ['true'] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TaskEditError);
      expect((err as TaskEditError).status).toBe(409);
    }
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('edits the verification fields and answers with the task', async () => {
    const t = task();
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t.id}`,
      payload: { verification_steps: ['sandbox: bash arith_ncu/run_ncu.sh'], artifacts: 'arith_ncu/*.ncu-rep' },
    });
    expect(res.statusCode).toBe(200);
    expect(parseSteps(res.json().task)).toEqual(['sandbox: bash arith_ncu/run_ncu.sh']);
    expect(res.json().task.artifacts).toBe('arith_ncu/*.ncu-rep');
  });

  it('400 on a bad threshold, 404 on an unknown task', async () => {
    const t = task();
    app = buildApp({ db, apiToken: null });
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, payload: { acceptance_metrics: 'soon' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/t_nope', payload: { artifacts: 'x' } })).statusCode).toBe(404);
  });
});
