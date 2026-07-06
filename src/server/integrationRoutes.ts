import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { resolveProvider } from '../integrations/config.js';
import { importWorkItems } from '../integrations/import.js';

interface ImportBody {
  provider?: string;
  query?: string;
  repo_path?: string | null;
  base_branch?: string | null;
  verification_steps?: string[] | string;
}

export function registerIntegrationRoutes(app: FastifyInstance, db: Database.Database): void {
  // D5: pull WorkItems (GitHub issues / ADO work items) into Loop tasks, idempotent by
  // source_ref. Fully credential-gated: 'none' (default) or missing creds -> no external
  // calls, just a clear error explaining what to configure.
  app.post('/api/integrations/import', async (req, reply) => {
    const b = (req.body ?? {}) as ImportBody;
    if (!b.query || !b.query.trim()) return reply.code(400).send({ error: 'query is required' });

    const active = (getSetting(db, 'integration_provider') ?? 'none').trim();
    if (active === 'none') {
      return reply.code(409).send({ error: 'integration_provider is "none" — set it (and provider credentials) first' });
    }
    if (b.provider && b.provider !== active) {
      return reply.code(400).send({ error: `provider mismatch: configured=${active}, requested=${b.provider}` });
    }
    const provider = resolveProvider(db);
    if (!provider) {
      return reply.code(409).send({
        error: `provider '${active}' is missing credentials in ~/.config/loop-engineering/env`,
      });
    }

    const steps = Array.isArray(b.verification_steps)
      ? b.verification_steps
      : typeof b.verification_steps === 'string'
        ? b.verification_steps.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

    const result = await importWorkItems(db, provider, b.query, {
      repo_path: b.repo_path ?? null,
      base_branch: b.base_branch ?? null,
      verification_steps: steps,
    });
    return { created: result.created.map((t) => t.id), skipped: result.skipped, tasks: result.created };
  });
}
