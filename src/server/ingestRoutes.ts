import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createSource, listSources, deleteSource, getSource } from '../knowledge/ingest/sources.js';
import { ingestSource, ingestAll } from '../knowledge/ingest/ingest.js';
import { SOURCE_KIND, type SourceKind } from '../knowledge/ingest/types.js';
import { normalizeGithubUri } from '../knowledge/ingest/github.js';

interface CreateSourceBody {
  kind?: string;
  uri?: string;
  include?: string[];
  exclude?: string[];
  branch?: string;
  enabled?: boolean;
}

export function registerIngestRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/sources', async () => ({ sources: listSources(db) }));

  app.post('/api/sources', async (req, reply) => {
    const b = (req.body ?? {}) as CreateSourceBody;
    if (!b.kind || !(SOURCE_KIND as readonly string[]).includes(b.kind)) {
      return reply.code(400).send({ error: `kind must be one of: ${SOURCE_KIND.join(', ')}` });
    }
    if (!b.uri) return reply.code(400).send({ error: 'uri is required' });
    // Same canonicalization as `loop ingest add --github` — owner/repo and github.com
    // URLs store as https://github.com/<owner>/<repo>; other kinds pass through.
    const uri = b.kind === 'github' ? (normalizeGithubUri(b.uri).webBase ?? b.uri.trim()) : b.uri;
    const source = createSource(db, {
      kind: b.kind as SourceKind,
      uri,
      config: { include: b.include, exclude: b.exclude, branch: b.branch },
      enabled: b.enabled,
    });
    return { source };
  });

  app.delete('/api/sources/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deleteSource(db, id)) return reply.code(404).send({ error: 'not found' });
    return { ok: true, deleted: id };
  });

  // Trigger an ingest run: one source (source_id) or every enabled source.
  app.post('/api/ingest', async (req, reply) => {
    const b = (req.body ?? {}) as { source_id?: string };
    if (b.source_id) {
      const source = getSource(db, b.source_id);
      if (!source) return reply.code(404).send({ error: 'not found' });
      return { results: [await ingestSource(db, source)] };
    }
    return { results: await ingestAll(db) };
  });
}
