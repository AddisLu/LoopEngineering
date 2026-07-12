import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import { prepareWeekly, renderWeekly, runWeekly, getWeeklyStatus, type WeeklyDeps } from '../report/pptx/weekly.js';

const DISABLED = { error: 'report_pptx disabled' };
const TIMED_OUT = Symbol('report pptx weekly route timed out');

/** Same race-then-detach pattern as reportRoutes.ts's withTimeout: the raced-away
 * promise keeps running to completion in the background, only the wait is bounded. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(TIMED_OUT); },
    );
  });
}

interface WeeklyRunBody {
  stage?: 'prepare' | 'render' | 'run';
  week?: string;
  qa?: boolean;
  allowUnapproved?: boolean;
  noLlm?: boolean;
}

async function dispatchStage(db: Database.Database, body: WeeklyRunBody, deps: WeeklyDeps): Promise<Record<string, unknown> | null> {
  const stage = body.stage ?? 'run';
  const llm = body.noLlm === true ? false : undefined;

  if (stage === 'prepare') {
    const r = await prepareWeekly(db, { week: body.week, llm }, deps);
    if (!r) return null;
    return { specPath: r.specPath, explainPath: r.explainPath, warnings: r.warnings, qualityFlags: r.qualityFlags };
  }
  if (stage === 'render') {
    const r = await renderWeekly(db, { week: body.week, allowUnapproved: body.allowUnapproved, qa: body.qa }, deps);
    if (!r) return null;
    return { output: r.output, slides: r.slides, warnings: r.warnings, qualityFlags: r.qualityFlags };
  }
  const r = await runWeekly(db, { week: body.week, qa: body.qa, allowUnapproved: body.allowUnapproved, llm }, deps);
  if (!r) return null;
  return {
    specPath: r.specPath,
    explainPath: r.explainPath,
    output: r.output,
    slides: r.slides,
    warnings: r.warnings,
    qualityFlags: r.qualityFlags,
  };
}

/**
 * T4 對外表面 — POST /api/report/weekly dispatches prepare/render/run against
 * src/report/pptx/weekly.ts; GET /api/report/weekly/:week reads back that week's
 * on-disk state with no side effects. Both 404 when report_pptx_enabled is off,
 * matching reportRoutes.ts's report_enabled convention exactly; POST races
 * report_pptx_timeout_ms the same way reportRoutes.ts races report_timeout_ms (the
 * underlying prepare/render/run keeps running in the background past a 504). The
 * approval gate itself lives in weekly.ts and is never bypassed here.
 */
export function registerReportPptxRoutes(app: FastifyInstance, db: Database.Database, deps: WeeklyDeps = {}): void {
  app.post('/api/report/weekly', async (req, reply) => {
    if (!getBool(db, 'report_pptx_enabled', false)) return reply.code(404).send(DISABLED);
    const body = (req.body ?? {}) as WeeklyRunBody;
    const timeoutMs = getNum(db, 'report_pptx_timeout_ms', 120_000);
    const outcome = await withTimeout(dispatchStage(db, body, deps), timeoutMs);
    if (outcome === TIMED_OUT) {
      return reply.code(504).send({ error: 'weekly report generation timed out', timedOut: true });
    }
    if (!outcome) {
      return reply.code(500).send({ ok: false, error: 'weekly stage failed (see server logs)' });
    }
    return { ok: true, ...outcome };
  });

  app.get('/api/report/weekly/:week', async (req, reply) => {
    if (!getBool(db, 'report_pptx_enabled', false)) return reply.code(404).send(DISABLED);
    const week = (req.params as { week: string }).week;
    return getWeeklyStatus(db, week, deps);
  });
}
