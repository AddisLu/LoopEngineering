import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { getTask } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let app: FastifyInstance;
let judgeCalls = 0;

beforeEach(async () => {
  db = openTestDb();
  setCachedUsage(10, 10);
  process.env.MOCK_SLEEP_MS = '50';
  judgeCalls = 0;
  app = buildApp({
    db,
    apiToken: null,
    benchJudgeExec: async () => {
      judgeCalls += 1;
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
      expect(judgeCalls).toBe(1);

      expect((await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` })).statusCode).toBe(409);
      const matrix = (await app.inject({ method: 'GET', url: '/api/benchmarks/matrix' })).json().matrix;
      expect(matrix.map((r: { model: string }) => r.model)).toEqual(['local:qwen38-flash', 'local:qwen3-coder-next']);
      expect(matrix[0]).toMatchObject({ domain: 'typescript', win_rate: 1, avg_score: 8.8 });
    });
  });
});
