import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  upsertEnvironment,
  getEnvironment,
  listEnvironments,
  deleteEnvironment,
  listDeployments,
} from '../deploy/store.js';
import { runRollback } from '../orchestrator/deployTask.js';

interface UpsertEnvironmentBody {
  name?: string;
  kind?: string;
  host?: string | null;
  capabilities?: string;
  deploy_cmd?: string | null;
  auto_deploy?: boolean | string;
}

export function registerDeployRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/environments', async () => ({ environments: listEnvironments(db) }));

  app.post('/api/environments', async (req, reply) => {
    const b = (req.body ?? {}) as UpsertEnvironmentBody;
    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: 'name is required' });
    const env = upsertEnvironment(db, {
      name: b.name.trim(),
      kind: b.kind,
      host: b.host ?? null,
      capabilities: b.capabilities ?? '',
      deploy_cmd: b.deploy_cmd ?? null,
      auto_deploy: b.auto_deploy === true || b.auto_deploy === 'true' || b.auto_deploy === '1',
    });
    return { environment: env };
  });

  app.delete('/api/environments/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!getEnvironment(db, name)) return reply.code(404).send({ error: 'not found' });
    deleteEnvironment(db, name);
    return { ok: true, deleted: name };
  });

  app.get('/api/deployments', async (req) => {
    const env = (req.query as { env?: string }).env;
    return { deployments: listDeployments(db, env) };
  });

  app.post('/api/deployments/:id/rollback', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid deployment id' });
    const result = await runRollback(db, id);
    if (result.error) return reply.code(409).send({ error: result.error });
    return result;
  });
}
