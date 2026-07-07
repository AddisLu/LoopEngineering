import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import { generateReport, type ReportDeps } from '../report/generate.js';
import {
  listReportTemplates,
  getReportTemplate,
  upsertReportTemplate,
  importReportTemplates,
  validateReportTemplateDef,
} from '../report/templates.js';

const DISABLED = { error: 'report disabled' };
const TIMED_OUT = Symbol('report route timed out');

/** Races a promise against `ms` -- resolves to TIMED_OUT instead of leaving the caller
 * waiting forever when the promise itself has no (or a much longer) timeout of its own.
 * The raced-away promise keeps running to completion in the background; only the wait
 * is bounded, not the underlying work. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(TIMED_OUT); },
    );
  });
}

/**
 * `POST /api/report` — generate an OpenProject project report from a natural-language
 * description, optionally naming a stored template. `/api/report/templates*` manage the
 * reusable "boss persona" templates themselves. Every route 404s when `report_enabled`
 * is off (default) — zero behavior change for anyone who hasn't opted in, matching
 * voiceRoutes.ts's disabled-feature convention.
 */
export function registerReportRoutes(app: FastifyInstance, db: Database.Database, deps: ReportDeps = {}): void {
  app.post('/api/report', async (req, reply) => {
    if (!getBool(db, 'report_enabled', false)) return reply.code(404).send(DISABLED);
    const body = (req.body ?? {}) as {
      description?: string;
      project?: string;
      topic?: string;
      template?: string;
      save?: boolean;
    };
    const timeoutMs = getNum(db, 'report_timeout_ms', 100_000);
    const outcome = await withTimeout(generateReport(db, body, deps), timeoutMs);
    if (outcome === TIMED_OUT) {
      return reply.code(504).send({ error: 'report generation timed out', timedOut: true });
    }
    return {
      markdown: outcome?.markdown ?? '',
      meta: outcome?.meta,
      ...(outcome?.files ? { files: outcome.files } : {}),
    };
  });

  app.get('/api/report/templates', async (req, reply) => {
    if (!getBool(db, 'report_enabled', false)) return reply.code(404).send(DISABLED);
    return { templates: listReportTemplates(db) };
  });

  app.get('/api/report/templates/:name', async (req, reply) => {
    if (!getBool(db, 'report_enabled', false)) return reply.code(404).send(DISABLED);
    const name = (req.params as { name: string }).name;
    const def = getReportTemplate(db, name);
    if (!def) return reply.code(404).send({ error: `no such report template: ${name}` });
    return { template: def };
  });

  app.post('/api/report/templates', async (req, reply) => {
    if (!getBool(db, 'report_enabled', false)) return reply.code(404).send(DISABLED);
    const v = validateReportTemplateDef(req.body ?? {});
    if (!v.ok) return reply.code(400).send({ error: v.error });
    return { template: upsertReportTemplate(db, v.def) };
  });

  app.post('/api/report/templates/import', async (req, reply) => {
    if (!getBool(db, 'report_enabled', false)) return reply.code(404).send(DISABLED);
    const b = (req.body ?? {}) as { items?: unknown[] };
    if (!Array.isArray(b.items)) return reply.code(400).send({ error: 'items array is required' });
    return importReportTemplates(db, b.items);
  });
}
