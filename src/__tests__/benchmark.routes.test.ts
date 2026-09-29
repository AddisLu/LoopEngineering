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
import { execFileSync } from 'node:child_process';
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
      expect(bad.json().error).toMatch(/2 個/);

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

    it('manual judge: 409 while arms run, judges once they are done, re-judges afterwards; matrix fills', async () => {
      const { benchmark, arms } = (await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY })).json();
      expect((await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` })).statusCode).toBe(409);

      for (const arm of arms) await runTask(db, getTask(db, arm.task_id)!);
      const judged = await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` });
      expect(judged.statusCode).toBe(200);
      expect(judged.json().benchmark).toMatchObject({ status: 'judged', winner: 'local:qwen38-flash' });
      expect(judgeCalls).toEqual(['opus']);

      // re-judging a judged benchmark is allowed: it is the "the judge got it wrong" button
      const again = await app.inject({ method: 'POST', url: `/api/benchmarks/${benchmark.id}/judge` });
      expect(again.statusCode).toBe(200);
      expect(judgeCalls).toEqual(['opus', 'opus']);
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
      // the dock's summary: record per model + the recent list. Neither arm passed the question's
      // tests, so nobody wins — the appearance still counts, the win does not
      const sum = (await app.inject({ method: 'GET', url: '/api/benchmarks/summary' })).json();
      expect(sum.recent[0]).toMatchObject({ id: benchmark.id, winner_label: null });
      expect(sum.models).toHaveLength(2);
      expect(sum.models.every((m: { n: number; wins: number }) => m.n === 1 && m.wins === 0)).toBe(true);
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

    it('refuses a second benchmark, cancels the first, then allows it', async () => {
      const first = (await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY })).json().benchmark;
      const second = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY });
      expect(second.statusCode).toBe(400);
      expect(second.json().error).toMatch(/已經有一個評比在跑/);

      const cancelled = await app.inject({ method: 'POST', url: `/api/benchmarks/${first.id}/cancel` });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().benchmark.status).toBe('cancelled');
      for (const a of (await app.inject({ method: 'GET', url: `/api/benchmarks/${first.id}` })).json().arms) {
        expect(getTask(db, a.task_id)!.status).toBe('failed');
      }
      expect((await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY })).statusCode).toBe(201);
      // and a cancelled benchmark can be dropped from the list
      expect((await app.inject({ method: 'DELETE', url: `/api/benchmarks/${first.id}` })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/benchmarks/${first.id}` })).statusCode).toBe(404);
    });

    it('a running benchmark cannot be deleted, only cancelled', async () => {
      const b = (await app.inject({ method: 'POST', url: '/api/benchmarks', payload: BODY })).json().benchmark;
      const del = await app.inject({ method: 'DELETE', url: `/api/benchmarks/${b.id}` });
      expect(del.statusCode).toBe(409);
      expect(del.json().error).toMatch(/取消評比/);
      expect((await app.inject({ method: 'DELETE', url: '/api/benchmarks/b_nope' })).statusCode).toBe(404);
    });

    it('a typed-in question is accepted without a plan field and carries display names', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-manual-'));
      tmp.push(repo);
      execFileSync('git', ['init', '-b', 'main', repo]);
      fs.writeFileSync(path.join(repo, 'README.md'), '# x');
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
      const res = await app.inject({
        method: 'POST',
        url: '/api/benchmarks',
        payload: {
          source: { kind: 'manual' },
          models: ['local:qwen38-flash', 'sonnet'],
          overrides: { title: '臨時題目', goal: '做一個小工具', repo_path: repo, base_branch: 'main', verification_steps: ['true'], domain: 'typescript' },
        },
      });
      expect(res.statusCode).toBe(201);
      // the page has no plan field: the question itself is written out as the plan
      expect(res.json().benchmark.plan_ref).toMatch(/\.md$/);
      expect(res.json().arms[0].model_label).toBe('Qwen3.8 Flash Next (NVFP4)');
      await app.inject({ method: 'POST', url: `/api/benchmarks/${res.json().benchmark.id}/cancel` });
      const missing = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { source: { kind: 'manual' }, models: ['local:qwen38-flash', 'sonnet'], overrides: { title: 'x', goal: 'y', verification_steps: ['true'] } } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toContain('題目還缺');
      expect(missing.json().error).toContain('repo 路徑');
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
