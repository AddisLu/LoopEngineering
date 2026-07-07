import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { search } from '../knowledge/retrieve.js';

export function registerRagRoutes(app: FastifyInstance, db: Database.Database): void {
  // Hybrid RAG search over the corpus layer (documents/chunks) — see
  // src/knowledge/retrieve.ts. Degrades to FTS-only when rag_enabled is off.
  app.get('/api/rag/search', async (req, reply) => {
    const q = (req.query as { q?: string }).q;
    if (!q) return reply.code(400).send({ error: 'q is required' });
    const query = req.query as { scope?: string; kind?: string; topK?: string };
    const topK = query.topK !== undefined ? Number(query.topK) : undefined;
    const results = await search(db, q, {
      scope: query.scope,
      kind: query.kind,
      topK: topK !== undefined && Number.isFinite(topK) ? topK : undefined,
    });
    return { results };
  });
}
