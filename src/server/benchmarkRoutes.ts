import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import type { Complexity } from '../config.js';
import {
  activeBenchmark,
  BenchmarkInputError,
  benchmarkMatrix,
  benchmarkSummary,
  cancelBenchmark,
  createBenchmark,
  deleteBenchmark,
  getBenchmark,
  listBenchmarks,
} from '../benchmark/store.js';
import { isJudging, judgeBenchmark } from '../benchmark/complete.js';
import type { BenchJudgeExec } from '../benchmark/judge.js';
import { listBuiltin, resolveSource, type ResolveDeps, type SourceKind } from '../benchmark/source.js';
import { getDraft } from '../prd/drafts.js';
import { submitPrd } from '../prd/intake.js';
import { identityOf } from './identity.js';
import type { PrdReviewExec } from '../prd/review.js';
import type { Task } from '../types.js';

export interface BenchmarkRouteOptions {
  /** Test-only: fake judge so route tests spend zero tokens. */
  judgeExec?: BenchJudgeExec;
  /** Test-only: where built-in questions and their throwaway repos live. */
  source?: ResolveDeps;
  /** Test-only: the PRD reviewer used when a benchmark starts from a wizard draft. */
  prdReviewExec?: PrdReviewExec;
  /** Kill an arm's live run before the cancel marks it failed (the server wires this to killRun). */
  onArmCancel?: (task: Task) => void;
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

  /** What the dock shows: the running one, the last few, and each model's record. */
  app.get('/api/benchmarks/summary', async (_req, reply) => (enabled() ? benchmarkSummary(db) : off(reply)));

  /** The neutral question bank shipped in seed/bench (no CF-AOI content). */
  app.get('/api/benchmarks/builtin', async (_req, reply) => (enabled() ? { questions: listBuiltin(opts.source?.builtinDir) } : off(reply)));

  app.get('/api/benchmarks/:id', async (req, reply) => {
    if (!enabled()) return off(reply);
    const detail = getBenchmark(db, (req.params as { id: string }).id);
    return detail ?? reply.code(404).send({ error: 'not found' });
  });

  /**
   * Start a benchmark. The question comes from a source (an existing task, a PRD-wizard draft,
   * a built-in question, or the fields typed on the page); `models` compete, `judge_models`
   * score. The pre-source body shape (title/goal/repo_path/…) still works and means `manual`.
   */
  app.post('/api/benchmarks', async (req, reply) => {
    if (!enabled()) return off(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const src = (b.source ?? {}) as { kind?: unknown; ref?: unknown };
    const kind = (typeof src.kind === 'string' ? src.kind : 'manual') as SourceKind;
    const ref = str(src.ref);
    const o = (b.overrides ?? b) as Record<string, unknown>;
    const models = list(b.models);
    const judges = list(b.judge_models);
    const overrides = {
      ...(str(o.title) ? { title: str(o.title)! } : {}),
      ...(str(o.goal) ? { goal: str(o.goal)! } : {}),
      ...(str(o.plan_ref) ? { plan_ref: str(o.plan_ref) } : {}),
      ...(str(o.repo_path) ? { repo_path: str(o.repo_path) } : {}),
      ...(str(o.base_branch) ? { base_branch: str(o.base_branch) } : {}),
      ...(list(o.verification_steps).length ? { verification_steps: list(o.verification_steps) } : {}),
      ...(str(o.setup_cmd) ? { setup_cmd: str(o.setup_cmd) } : {}),
      ...(str(o.verify_rubric) ? { verify_rubric: str(o.verify_rubric) } : {}),
      ...(str(o.domain) ? { domain: str(o.domain)! } : {}),
      ...(str(o.complexity) ? { complexity: str(o.complexity) as Complexity } : {}),
    };
    try {
      // submitPrd writes a plan file and can create a task, so everything that can be judged
      // without writing anything is judged first — a bad model list must never reach it.
      if (models.length < 2) throw new BenchmarkInputError('評比至少要 2 個不同的參賽模型（至少選兩個）');
      // a wizard draft goes through the PRD gate first: the same markdown, the same review
      if (kind === 'draft') {
        const me = identityOf(req);
        const draft = ref ? getDraft(db, me.user_key, ref) : null;
        if (!draft) return reply.code(404).send({ error: `找不到草稿：${ref ?? ''}` });
        if (!draft.markdown.trim()) return reply.code(400).send({ error: '這份草稿還沒有內容——先在精靈按「檢查」' });
        const busy = activeBenchmark(db);
        if (busy) throw new BenchmarkInputError(`已經有一個評比在跑：「${busy.title}」。等它跑完，或先按「取消評比」。`);
        const r = await submitPrd(db, draft.markdown, { exec: opts.prdReviewExec, benchmark_models: models, judge_models: judges.length ? judges : undefined });
        if (!r.ok) return reply.code(422).send({ error: 'PRD blocked by the gate', check: r.check });
        if (r.kind !== 'benchmark') return reply.code(400).send({ error: 'a benchmark needs at least 2 distinct models' });
        db.prepare('UPDATE benchmarks SET source_ref = ? WHERE id = ?').run(draft.id, r.benchmark.id);
        return reply.code(201).send({ benchmark: r.benchmark, arms: r.arms });
      }
      const q = resolveSource(db, kind, ref, overrides, opts.source);
      try {
        const created = createBenchmark(db, {
          ...q,
          models,
          judge_model: str(b.judge_model) ?? undefined,
          judge_models: judges.length ? judges : undefined,
          priority: Number.isFinite(Number(b.priority)) && b.priority != null ? Number(b.priority) : undefined,
          coding_tool: b.coding_tool === 'mock' ? 'mock' : undefined,
        });
        return reply.code(201).send(created);
      } catch (err) {
        q.cleanup?.(); // a built-in question builds its repo before this point
        throw err;
      }
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
    // Re-judging a finished benchmark is the whole point of the button; only a judge run that is
    // actually in flight *in this process* blocks it (a 'judging' row can outlive a restart).
    if (status === 'judging' && isJudging(detail.benchmark.id)) {
      return reply.code(409).send({ error: '這個評比正在評分中，等它跑完再試。' });
    }
    if (status === 'cancelled') return reply.code(409).send({ error: '這個評比已取消。' });
    if (!detail.arms.every((a) => TERMINAL.has(a.task_status ?? 'failed'))) {
      return reply.code(409).send({ error: '還有組別沒跑完。' });
    }
    const judges = list((req.body as Record<string, unknown> | undefined)?.judge_models);
    const benchmark = await judgeBenchmark(db, detail.benchmark.id, opts.judgeExec, { judges: judges.length ? judges : undefined });
    return benchmark ? { benchmark } : reply.code(409).send({ error: '已經有一次評分在進行中。' });
  });

  /** Stop a benchmark that is still running: its unfinished arms are failed and the GPU freed. */
  app.post('/api/benchmarks/:id/cancel', async (req, reply) => {
    if (!enabled()) return off(reply);
    const id = (req.params as { id: string }).id;
    if (!getBenchmark(db, id)) return reply.code(404).send({ error: 'not found' });
    const benchmark = cancelBenchmark(db, id, '使用者取消', { onArmTask: opts.onArmCancel });
    return { benchmark };
  });

  /** Drop a finished benchmark from the list. The arm tasks stay on the board. */
  app.delete('/api/benchmarks/:id', async (req, reply) => {
    if (!enabled()) return off(reply);
    try {
      return deleteBenchmark(db, (req.params as { id: string }).id)
        ? { ok: true }
        : reply.code(404).send({ error: 'not found' });
    } catch (err) {
      if (err instanceof BenchmarkInputError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
}
