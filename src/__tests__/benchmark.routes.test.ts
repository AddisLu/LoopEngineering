import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { getTask } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';
import { createTask } from '../tasks.js';
import { createDraft } from '../prd/drafts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let db: Database.Database;
let app: FastifyInstance;
let judgeCalls: string[] = [];
let benchRoot = '';
let tmp: string[] = [];

beforeEach(async () => {
  db = openTestDb();
  setCachedUsage(10, 10);
  process.env.MOCK_SLEEP_MS = '50';
  judgeCalls = [];
  benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-routes-'));
  tmp.push(benchRoot);
  app = buildApp({
    db,
    apiToken: null,
    benchSource: { repoRoot: benchRoot },
    prdReviewExec: async () => JSON.stringify({ verdict: 'ready', missing: [], risks: [], questions: [], notes: '' }),
    benchJudgeExec: async (_prompt, model) => {
      judgeCalls.push(model);
      return JSON.stringify({
        arms: [
          { arm: 'A', scores: { correctness: 9, completeness: 9, code_quality: 8, adherence: 9 }, notes: 'good' },
          { arm: 'B', scores: { correctness: 4, completeness: 5, code_quality: 5, adherence: 6 }, notes: 'meh' },
        ],
        winner: 'A',
        summary: 'A wins.',
      });
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  delete process.env.MOCK_SLEEP_MS;
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

const BODY = {
  title: 'toy',
  goal: 'do the toy thing',
  plan_ref: 'https://example.com/plan.md',
  verification_steps: 'true',
  domain: 'typescript',
  models: 'local:qwen38-flash, local:qwen3-coder-next',
  coding_tool: 'mock',
};

describe('/api/benchmarks', () => {
  it('every route is 404 while benchmark mode is off', async () => {
    for (const [method, url] of [
      ['GET', '/api/benchmarks'],
      ['GET', '/api/benchmarks/matrix'],
      ['GET', '/api/benchmarks/b_x'],
      ['POST', '/api/benchmarks'],
      ['POST', '/api/benchmarks/b_x/judge'],
    ] as const) {
      expect((await app.inject({ method, url, payload: method === 'POST' ? BODY : undefined })).statusCode).toBe(404);
    }
  });

  describe('enabled', () => {
    beforeEach(() => setSetting(db, 'benchmark_enabled', 'true'));

    it('validates input (400) and creates arms from CSV fields (201)', async () => {
      const bad = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { ...BODY, models: 'local:qwen38-flash' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/at least 2/);

      const res = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY });
      expect(res.statusCode).toBe(201);
      const { benchmark, arms } = res.json();
      expect(arms).toHaveLength(2);
      expect(arms.every((a: { task_status: string }) => a.task_status === 'queued')).toBe(true);

      const listed = (await app.inject({ method: 'GET', url: '/api/benchmarks' })).json().benchmarks;
      expect(listed[0]).toMatchObject({ id: benchmark.id, arm_count: 2, arms_done: 0 });
      expect((await app.inject({ method: 'GET', url: `/api/benchmarks/${benchmark.id}` })).json().benchmark.id).toBe(benchmark.id);
      expect((await app.inject({ method: 'GET', url: '/api/benchmarks/b_missing' })).statusCode).toBe(404);
    });

    it('manual judge: 409 while arms run, judges once they are done, 409 afterwards; matrix fills', async () => {
      const { benchmark, arms } = (await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY })).json();
      expect((await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` })).statusCode).toBe(409);

      for (const arm of arms) await runTask(db, getTask(db, arm.task_id)!);
      const judged = await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` });
      expect(judged.statusCode).toBe(200);
      expect(judged.json().benchmark).toMatchObject({ status: 'judged', winner: 'local:qwen38-flash' });
      expect(judgeCalls).toEqual(['opus']);

      expect((await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` })).statusCode).toBe(409);
      const matrix = (await app.inject({ method: 'GET', url: '/api/benchmarks/matrix' })).json().matrix;
      expect(matrix.map((r: { model: string }) => r.model)).toEqual(['local:qwen38-flash', 'local:qwen3-coder-next']);
      expect(matrix[0]).toMatchObject({ domain: 'typescript', win_rate: 1, avg_score: 8.8 });
    });

    it('starts from a built-in question, several judges, and reports the consensus', async () => {
      const builtin = (await app.inject({ method: 'GET', url: '/api/benchmarks/builtin' })).json().questions;
      expect(builtin.length).toBeGreaterThanOrEqual(6);
      const res = await app.inject({
        method: 'POST',
        url: '/api/benchmarks',
        payload: { source: { kind: 'builtin', ref: 'lru-cache' }, models: ['local:qwen38-flash', 'local:qwen3-coder-next'], judge_models: ['opus', 'sonnet'], coding_tool: 'mock' },
      });
      expect(res.statusCode).toBe(201);
      const { benchmark, arms } = res.json();
      expect(benchmark).toMatchObject({ source_kind: 'builtin', source_ref: 'lru-cache', judge_models: 'opus,sonnet', domain: 'python' });
      expect(benchmark.repo_path.startsWith(path.join(benchRoot, '.bench'))).toBe(true);

      // the question's own tests fail against the mock adapter's output — that is a fair arm
      // outcome, but it must be terminal for the judge, so no resume loop here
      setSetting(db, 'max_resumes', '0');
      for (const arm of arms) await runTask(db, getTask(db, arm.task_id)!);
      const judged = await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` });
      expect(judged.statusCode).toBe(200);
      expect(judgeCalls).toEqual(['opus', 'sonnet']);
      expect(judged.json().benchmark.consensus).toBe('unanimous');
      const detail = (await app.inject({ method: 'GET', url: `/api/benchmarks/${benchmark.id}` })).json();
      expect(detail.judgements.map((j: { judge_model: string }) => j.judge_model)).toEqual(['opus', 'sonnet']);
      expect(JSON.parse(detail.arms[0].scores_json)).toHaveProperty('mean');
      // the dock's summary: record per model + the recent list
      const sum = (await app.inject({ method: 'GET', url: '/api/benchmarks/summary' })).json();
      expect(sum.recent[0]).toMatchObject({ id: benchmark.id, winner_label: 'Qwen3.8 Flash Next (NVFP4)' });
      expect(sum.models[0]).toMatchObject({ model: 'local:qwen38-flash', wins: 1 });
    });

    it('starts from a task or a PRD draft, and says why a draft cannot be used', async () => {
      const t = createTask(db, { title: '從任務來的題目', goal: 'g', plan_ref: 'https://example.com/p', verification_steps: ['true'], complexity: 'S' });
      const fromTask = await app.inject({
        method: 'POST',
        url: '/api/benchmarks',
        payload: { source: { kind: 'task', ref: t.id }, models: ['local:qwen38-flash', 'sonnet'], coding_tool: 'mock' },
      });
      expect(fromTask.statusCode).toBe(201);
      expect(fromTask.json().benchmark).toMatchObject({ title: '從任務來的題目', source_kind: 'task', source_ref: t.id, complexity: 'S' });
      expect((await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { source: { kind: 'task', ref: 't_nope' }, models: ['local:qwen38-flash', 'sonnet'] } })).statusCode).toBe(400);

      // a draft has to pass the PRD gate first, and it has to have content
      setSetting(db, 'prd_gate_enabled', 'true');
      const empty = createDraft(db, 'local', { title: 'x', form: {}, markdown: '' });
      const bad = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { source: { kind: 'draft', ref: empty.id }, models: ['local:qwen38-flash', 'sonnet'] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('檢查');
      expect((await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { source: { kind: 'draft', ref: 'd_nope' }, models: ['local:qwen38-flash', 'sonnet'] } })).statusCode).toBe(404);
    });

    it('the board snapshot says a benchmark owns the machine', async () => {
      const before = (await app.inject({ method: 'GET', url: '/api/board' })).json();
      expect(before.benchmark).toBeNull();
      const { benchmark, arms } = (await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY })).json();
      const during = (await app.inject({ method: 'GET', url: '/api/board' })).json();
      expect(during.benchmark).toMatchObject({ id: benchmark.id, title: 'toy', status: 'running', arm_count: 2, arms_done: 0 });
      for (const arm of arms) await runTask(db, getTask(db, arm.task_id)!);
      await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` });
      expect((await app.inject({ method: 'GET', url: '/api/board' })).json().benchmark).toBeNull();
    });
  });
});
