import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { captureNote } from '../knowledge/ingest/capture.js';

interface CaptureBody {
  title?: string;
  body?: string;
  tags?: string[];
}

export function registerCaptureRoutes(app: FastifyInstance, db: Database.Database): void {
  // SSoT Phase 4: quick-capture into the registered vault + immediate ingest — see
  // src/knowledge/ingest/capture.ts. Distinct from POST /api/knowledge (the curated,
  // prompt-injected knowledge_nodes layer): this lands in the RAG corpus (documents/chunks).
  app.post('/api/capture', async (req, reply) => {
    const b = (req.body ?? {}) as CaptureBody;
    if (!b.body || !b.body.trim()) return reply.code(400).send({ error: 'body is required' });
    try {
      const result = await captureNote(db, { title: b.title, body: b.body, tags: b.tags });
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
