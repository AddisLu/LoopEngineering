import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import type { Complexity } from '../config.js';
import {
  activeBenchmark,
  BenchmarkInputError,
  benchmarkHeadToHead,
  benchmarkMatrix,
  benchmarkRecommendations,
  benchmarkSummary,
  cancelBenchmark,
  createBenchmark,
  deleteBenchmark,
  getBenchmark,
  listBenchmarks,
} from '../benchmark/store.js';
import { judgeBenchmark, rejudgeBlocker, remeasureBaseline } from '../benchmark/complete.js';
import { benchmarkReport } from '../benchmark/report.js';
import type { GitExec } from '../benchmark/attempts.js';
import type { SandboxDeps } from '../exec/sandbox.js';
import type { BenchJudgeExec } from '../benchmark/judge.js';
import { listBuiltin, resolveSource, type ResolveDeps, type SourceKind } from '../benchmark/source.js';
import { createScreen, deleteScreen, getScreen, listScreens } from '../benchmark/screen.js';
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
  /** Test-only: how a baseline measurement reaches git and the 沙盒. */
  baselineGit?: GitExec;
  sandboxDeps?: SandboxDeps;
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

  // ?domain=cuda&kind=local|cloud&min_n=2&min_pass=0.5 — which models pass which kind of software
  app.get('/api/benchmarks/matrix', async (req, reply) => {
    if (!enabled()) return off(reply);
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const n = (v?: string) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const kind = q.kind === 'local' || q.kind === 'cloud' ? q.kind : null;
    return { matrix: benchmarkMatrix(db, { domain: str(q.domain), kind, min_n: n(q.min_n), min_pass: n(q.min_pass) }) };
  });

  /** Per software type: the local model to hand that work to, next to the best cloud model. */
  app.get('/api/benchmarks/recommend', async (req, reply) => {
    if (!enabled()) return off(reply);
    const minN = Number((req.query as Record<string, string | undefined>)?.min_n);
    return { recommendations: benchmarkRecommendations(db, { min_n: Number.isFinite(minN) && minN > 0 ? minN : 1 }) };
  });

  /** Model against model: how often one ranked above the other in the judged benchmarks both entered. */
  app.get('/api/benchmarks/h2h', async (req, reply) => {
    if (!enabled()) return off(reply);
    return benchmarkHeadToHead(db, { domain: str((req.query as Record<string, string | undefined>)?.domain) });
  });

  /** What the dock shows: the running one, the last few, and each model's record. */
  app.get('/api/benchmarks/summary', async (_req, reply) => (enabled() ? benchmarkSummary(db) : off(reply)));

  /** The neutral question bank shipped in seed/bench (no CF-AOI content). */
  app.get('/api/benchmarks/builtin', async (_req, reply) => (enabled() ? { questions: listBuiltin(opts.source?.builtinDir) } : off(reply)));

  app.get('/api/benchmarks/:id', async (req, reply) => {
    if (!enabled()) return off(reply);
    const detail = getBenchmark(db, (req.params as { id: string }).id);
    return detail ?? reply.code(404).send({ error: 'not found' });
  });

  /** The benchmark as a Markdown report (a download; ?inline=1 shows it in the browser). */
  app.get('/api/benchmarks/:id/report.md', async (req, reply) => {
    if (!enabled()) return off(reply);
    const id = (req.params as { id: string }).id;
    const md = benchmarkReport(db, id);
    if (md == null) return reply.code(404).send({ error: 'not found' });
    reply.header('content-type', 'text/markdown; charset=utf-8');
    if ((req.query as Record<string, string | undefined>)?.inline !== '1') {
      reply.header('content-disposition', `attachment; filename="benchmark-${id.replace(/[^\w-]/g, '')}.md"`);
    }
    return md;
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
      const minutes = (v: unknown) => (v == null || v === '' ? null : Number(v));
      try {
        const created = createBenchmark(db, {
          ...q,
          // the measured bar every arm shares — from a 驗證方案 and/or set here
          verify_plan_id: str(o.verify_plan_id),
          dataset: str(o.dataset),
          ...(o.acceptance_metrics !== undefined ? { acceptance_metrics: str(o.acceptance_metrics) ?? '' } : {}),
          ...(o.protected_paths !== undefined ? { protected_paths: list(o.protected_paths).join(',') } : {}),
          ...(o.artifacts !== undefined ? { artifacts: list(o.artifacts).join(',') } : {}),
          verify_timeout_min: minutes(o.verify_timeout_min),
          timeout_min: minutes(o.timeout_min),
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
    const why = rejudgeBlocker(detail);
    if (why) return reply.code(409).send({ error: why });
    const judges = list((req.body as Record<string, unknown> | undefined)?.judge_models);
    const benchmark = await judgeBenchmark(db, detail.benchmark.id, opts.judgeExec, { judges: judges.length ? judges : undefined });
    return benchmark ? { benchmark } : reply.code(409).send({ error: '已經有一次評分在進行中。' });
  });

  /**
   * Measure (again) the code the arms started from, with the benchmark's own verification — for a
   * benchmark judged before baselines were kept, or after the question's yardstick changed. It
   * needs the GPU to itself, so not while arms still run or are being judged.
   */
  app.post('/api/benchmarks/:id/baseline', async (req, reply) => {
    if (!enabled()) return off(reply);
    const r = await remeasureBaseline(db, (req.params as { id: string }).id, opts.sandboxDeps, opts.baselineGit);
    return r.ok ? { benchmark: r.benchmark } : reply.code(r.code).send({ error: r.error });
  });

  /** Stop a benchmark that is still running: its unfinished arms are failed and the GPU freed. */
  app.post('/api/benchmarks/:id/cancel', async (req, reply) => {
    if (!enabled()) return off(reply);
    const id = (req.params as { id: string }).id;
    if (!getBenchmark(db, id)) return reply.code(404).send({ error: 'not found' });
    const benchmark = cancelBenchmark(db, id, '使用者取消', { onArmTask: opts.onArmCancel });
    return { benchmark };
  });

  // ---- 模型快篩 (src/benchmark/screen.ts) ------------------------------------------------------

  /** Screen local models on small built-in questions: one row per model × question, back to back. */
  app.post('/api/benchmarks/screen', async (req, reply) => {
    if (!enabled()) return off(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const budget = b.budget_min == null || b.budget_min === '' ? undefined : Number(b.budget_min);
    try {
      const r = createScreen(
        db,
        { models: list(b.models), questions: list(b.questions), budget_min: budget, coding_tool: b.coding_tool === 'mock' ? 'mock' : undefined },
        opts.source,
      );
      return reply.code(201).send({ ...r, screen: getScreen(db, r.group) });
    } catch (err) {
      if (err instanceof BenchmarkInputError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/benchmarks/screens', async (_req, reply) => {
    if (!enabled()) return off(reply);
    return {
      defaults: {
        questions: (getSetting(db, 'bench_screen_questions') || '').split(',').map((s) => s.trim()).filter(Boolean),
        budget_min: getNum(db, 'bench_screen_budget_min', 15),
        builtin: listBuiltin(opts.source?.builtinDir),
      },
      screens: listScreens(db),
    };
  });

  app.get('/api/benchmarks/screens/:group', async (req, reply) => {
    if (!enabled()) return off(reply);
    const g = getScreen(db, (req.params as { group: string }).group);
    return g ? { screen: g } : reply.code(404).send({ error: 'not found' });
  });

  /** Stop a batch: the running row's arm is killed and failed, the waiting rows never start. */
  app.post('/api/benchmarks/screens/:group/cancel', async (req, reply) => {
    if (!enabled()) return off(reply);
    const group = (req.params as { group: string }).group;
    const g = getScreen(db, group);
    if (!g) return reply.code(404).send({ error: 'not found' });
    const live = g.cells.find((c) => c.outcome === 'running' || c.outcome === 'queued');
    if (live) cancelBenchmark(db, live.benchmark_id, '使用者取消快篩', { onArmTask: opts.onArmCancel });
    return { screen: getScreen(db, group) };
  });

  app.delete('/api/benchmarks/screens/:group', async (req, reply) => {
    if (!enabled()) return off(reply);
    try {
      const n = deleteScreen(db, (req.params as { group: string }).group);
      return n ? { ok: true, deleted: n } : reply.code(404).send({ error: 'not found' });
    } catch (err) {
      if (err instanceof BenchmarkInputError) return reply.code(409).send({ error: err.message });
      throw err;
    }
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
