import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import type { Complexity } from '../config.js';
import {
  BenchmarkInputError,
  benchmarkMatrix,
  createBenchmark,
  getBenchmark,
  listBenchmarks,
} from '../benchmark/store.js';
import { judgeBenchmark } from '../benchmark/complete.js';
import type { BenchJudgeExec } from '../benchmark/judge.js';

export interface BenchmarkRouteOptions {
  /** Test-only: fake judge so route tests spend zero tokens. */
  judgeExec?: BenchJudgeExec;
}

const TERMINAL = new Set(['review', 'attention', 'failed', 'closed']);

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((s) => String(s).trim()).filter(Boolean)
    : typeof v === 'string'
      ? v.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Benchmark mode API — every route is 404 while benchmark_enabled is off. */
export function registerBenchmarkRoutes(
  app: FastifyInstance,
  db: Database.Database,
  opts: BenchmarkRouteOptions = {},
): void {
  const enabled = () => getBool(db, 'benchmark_enabled', false);
  const off = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'benchmark mode disabled (set benchmark_enabled=true)' });

  app.get('/api/benchmarks', async (_req, reply) => (enabled() ? { benchmarks: listBenchmarks(db) } : off(reply)));

  app.get('/api/benchmarks/matrix', async (_req, reply) => (enabled() ? { matrix: benchmarkMatrix(db) } : off(reply)));

  app.get('/api/benchmarks/:id', async (req, reply) => {
    if (!enabled()) return off(reply);
    const detail = getBenchmark(db, (req.params as { id: string }).id);
    return detail ?? reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/benchmarks', async (req, reply) => {
    if (!enabled()) return off(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const created = createBenchmark(db, {
        title: String(b.title ?? ''),
        goal: String(b.goal ?? ''),
        plan_ref: str(b.plan_ref),
        repo_path: str(b.repo_path),
        base_branch: str(b.base_branch),
        verification_steps: list(b.verification_steps),
        setup_cmd: str(b.setup_cmd),
        verify_rubric: str(b.verify_rubric),
        domain: str(b.domain) ?? undefined,
        complexity: (str(b.complexity) as Complexity | null) ?? undefined,
        models: list(b.models),
        judge_model: str(b.judge_model) ?? undefined,
        priority: Number.isFinite(Number(b.priority)) && b.priority != null ? Number(b.priority) : undefined,
        coding_tool: b.coding_tool === 'mock' ? 'mock' : undefined,
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof BenchmarkInputError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Manual (re-)judge: after judge_failed, or to judge now instead of waiting for the server loop.
  app.post('/api/benchmarks/:id/judge', async (req, reply) => {
    if (!enabled()) return off(reply);
    const detail = getBenchmark(db, (req.params as { id: string }).id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    const { status } = detail.benchmark;
    if (status === 'judged' || status === 'judging') {
      return reply.code(409).send({ error: `benchmark is already ${status}` });
    }
    if (!detail.arms.every((a) => TERMINAL.has(a.task_status ?? 'failed'))) {
      return reply.code(409).send({ error: 'some arms are still running' });
    }
    const benchmark = await judgeBenchmark(db, detail.benchmark.id, opts.judgeExec);
    return benchmark ? { benchmark } : reply.code(409).send({ error: 'judge already in progress' });
  });
}
