import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  upsertNode,
  getNode,
  listNodes,
  searchNodes,
  deleteNode,
  invalidateNode,
  setStatusNode,
  addEdge,
  deleteEdge,
  graph,
  importNodes,
  type ImportNodeInput,
  type ImportEdgeInput,
} from '../knowledge/store.js';
import { KIND, STATUS, RELATION, type Kind, type Status, type Source } from '../knowledge/types.js';
import { exportClaudeMd } from '../knowledge/export.js';

function isValidScope(scope: unknown): boolean {
  if (typeof scope !== 'string' || !scope) return false;
  return scope === 'global' || scope.startsWith('repo:') || scope.startsWith('env:');
}

/** Returns an error message, or null when the body is well-formed. */
function validateNodeInput(b: Record<string, unknown>): string | null {
  if (!b.title || typeof b.title !== 'string') return 'title is required';
  if (b.kind !== undefined && !(KIND as readonly string[]).includes(b.kind as string)) {
    return `invalid kind: ${b.kind}`;
  }
  if (b.status !== undefined && !(STATUS as readonly string[]).includes(b.status as string)) {
    return `invalid status: ${b.status}`;
  }
  if (b.scope !== undefined && !isValidScope(b.scope)) return `invalid scope: ${b.scope}`;
  if (b.weight !== undefined) {
    const w = Number(b.weight);
    if (!Number.isInteger(w) || w < 1 || w > 5) return 'weight must be an integer 1-5';
  }
  return null;
}

export function registerKnowledgeRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/knowledge', async (req) => {
    const query = req.query as { q?: string; kind?: Kind; scope?: string; status?: Status };
    const nodes = query.q
      ? searchNodes(db, query.q)
      : listNodes(db, { kind: query.kind, scope: query.scope, status: query.status });
    return { nodes };
  });

  app.post('/api/knowledge', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const err = validateNodeInput(b);
    if (err) return reply.code(400).send({ error: err });
    const node = upsertNode(db, {
      title: b.title as string,
      body: b.body as string | undefined,
      kind: b.kind as Kind | undefined,
      tags: b.tags as string[] | undefined,
      scope: b.scope as string | undefined,
      status: b.status as Status | undefined,
      weight: b.weight !== undefined ? Number(b.weight) : undefined,
      source: b.source as Source | undefined,
    });
    return { node };
  });

  app.delete('/api/knowledge/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deleteNode(db, id)) return reply.code(404).send({ error: 'not found' });
    return { ok: true, deleted: id };
  });

  app.post('/api/knowledge/:id/invalidate', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getNode(db, id)) return reply.code(404).send({ error: 'not found' });
    invalidateNode(db, id);
    return { ok: true };
  });

  app.post('/api/knowledge/:id/approve', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getNode(db, id)) return reply.code(404).send({ error: 'not found' });
    setStatusNode(db, id, 'approved');
    return { ok: true };
  });

  app.post('/api/knowledge/:id/reject', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getNode(db, id)) return reply.code(404).send({ error: 'not found' });
    setStatusNode(db, id, 'rejected');
    return { ok: true };
  });

  app.post('/api/knowledge/edges', async (req, reply) => {
    const b = (req.body ?? {}) as { src?: string; dst?: string; relation?: string; note?: string | null };
    if (!b.src || !b.dst) return reply.code(400).send({ error: 'src and dst are required' });
    if (!getNode(db, b.src)) return reply.code(400).send({ error: `unknown src node: ${b.src}` });
    if (!getNode(db, b.dst)) return reply.code(400).send({ error: `unknown dst node: ${b.dst}` });
    if (b.relation !== undefined && !(RELATION as readonly string[]).includes(b.relation)) {
      return reply.code(400).send({ error: `invalid relation: ${b.relation}` });
    }
    const edge = addEdge(db, { src: b.src, dst: b.dst, relation: b.relation, note: b.note });
    return { edge };
  });

  app.delete('/api/knowledge/edges/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deleteEdge(db, id)) return reply.code(404).send({ error: 'not found' });
    return { ok: true, deleted: id };
  });

  app.get('/api/knowledge/graph', async (req) => {
    const query = req.query as { kind?: Kind; scope?: string; nodeId?: string; depth?: string };
    const depth = query.depth !== undefined ? Number(query.depth) : undefined;
    return graph(db, {
      kind: query.kind,
      scope: query.scope,
      nodeId: query.nodeId,
      depth: depth !== undefined && Number.isFinite(depth) ? depth : undefined,
    });
  });

  app.post('/api/knowledge/import', async (req, reply) => {
    const b = (req.body ?? {}) as { items?: ImportNodeInput[]; edges?: ImportEdgeInput[] };
    if (!Array.isArray(b.items)) return reply.code(400).send({ error: 'items array is required' });
    return importNodes(db, b.items, b.edges ?? []);
  });

  app.post('/api/knowledge/export-claude-md', async (req, reply) => {
    const b = (req.body ?? {}) as { repo_path?: string };
    if (!b.repo_path) return reply.code(400).send({ error: 'repo_path is required' });
    const result = exportClaudeMd(db, b.repo_path);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return result;
  });
}
