import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { listPipelineDefs, getPipelineDef, importPipelineDefs } from '../pipeline/store.js';
import { materializePipeline } from '../pipeline/materialize.js';

interface RunPipelineBody {
  goal?: string;
  repo_path?: string | null;
  base_branch?: string | null;
  environment?: string | null;
  title?: string | null;
  verification_steps?: string[] | string;
}

export function registerPipelineRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/pipelines', async () => ({ pipelines: listPipelineDefs(db) }));

  app.get('/api/pipelines/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const def = getPipelineDef(db, name);
    if (!def) return reply.code(404).send({ error: `no such pipeline: ${name}` });
    return { pipeline: def };
  });

  app.post('/api/pipelines/import', async (req, reply) => {
    const b = (req.body ?? {}) as { items?: unknown[] };
    if (!Array.isArray(b.items)) return reply.code(400).send({ error: 'items array is required' });
    return importPipelineDefs(db, b.items);
  });

  app.post('/api/pipelines/:name/run', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const def = getPipelineDef(db, name);
    if (!def) return reply.code(404).send({ error: `no such pipeline: ${name}` });
    const b = (req.body ?? {}) as RunPipelineBody;
    if (!b.goal || !b.goal.trim()) return reply.code(400).send({ error: 'goal is required' });
    const steps = Array.isArray(b.verification_steps)
      ? b.verification_steps
      : typeof b.verification_steps === 'string'
        ? b.verification_steps.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const tasks = materializePipeline(db, def, {
      goal: b.goal,
      repo_path: b.repo_path ?? null,
      base_branch: b.base_branch ?? null,
      environment: b.environment ?? null,
      title: b.title ?? null,
      verification_steps: steps,
    });
    return { pipeline: name, task_ids: tasks.map((t) => t.id), tasks };
  });
}
