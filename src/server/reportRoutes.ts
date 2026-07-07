import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import { generateReport, type ReportDeps } from '../report/generate.js';

/**
 * `POST /api/report` — generate an OpenProject project report from a natural-language
 * description. 404s when `report_enabled` is off (default) — zero behavior change for
 * anyone who hasn't opted in, matching voiceRoutes.ts's disabled-feature convention.
 */
export function registerReportRoutes(app: FastifyInstance, db: Database.Database, deps: ReportDeps = {}): void {
  app.post('/api/report', async (req, reply) => {
    if (!getBool(db, 'report_enabled', false)) {
      return reply.code(404).send({ error: 'report disabled' });
    }
    const body = (req.body ?? {}) as { description?: string; project?: string; topic?: string };
    const result = await generateReport(db, body, deps);
    return { markdown: result?.markdown ?? '', meta: result?.meta };
  });
}
