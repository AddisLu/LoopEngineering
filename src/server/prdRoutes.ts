import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import { checkPrd, linkSubmittedDraft, submitPrd, PrdInputError } from '../prd/intake.js';
import { BenchmarkInputError } from '../benchmark/store.js';
import type { PrdReviewExec } from '../prd/review.js';
import { parsePrdToForm } from '../prd/compose.js';
import { allowedRoots, resolveAllowed } from '../prd/repo.js';
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft, PrdDraftError } from '../prd/drafts.js';
import { draftAcceptance, suggestFiles, type AssistDeps } from '../prd/assist.js';
import { IdentityError, identityOf, type ChatIdentity } from './identity.js';

export interface PrdRouteOptions {
  /** Test-only: fake local-model review (zero GPU). */
  reviewExec?: PrdReviewExec;
  /** Test-only seams for the wizard helpers. */
  search?: AssistDeps['search'];
  localChat?: AssistDeps['localChat'];
  identity?: (req: FastifyRequest) => ChatIdentity;
}

// src/server -> repo root in tsx, dist/server -> repo root when built
const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed', 'prd-template.md');

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * PRD gate + wizard API — every route is 404 while prd_gate_enabled is off. A blocked PRD creates
 * nothing (422). The wizard endpoints (repo / stat / parse / drafts / suggest-files /
 * draft-acceptance) exist so an engineer who has never written a PRD can be walked through one
 * (web/prd.html); the gate itself is unchanged.
 */
export function registerPrdRoutes(app: FastifyInstance, db: Database.Database, opts: PrdRouteOptions = {}): void {
  const enabled = () => getBool(db, 'prd_gate_enabled', false);
  const off = (reply: FastifyReply) => reply.code(404).send({ error: 'PRD gate disabled (set prd_gate_enabled=true)' });
  const identity = opts.identity ?? ((req: FastifyRequest) => identityOf(req));
  const assist: AssistDeps = { search: opts.search, localChat: opts.localChat };

  /** gate + identity; null once the error reply has been sent */
  const who = (req: FastifyRequest, reply: FastifyReply): ChatIdentity | null => {
    if (!enabled()) {
      off(reply);
      return null;
    }
    try {
      return identity(req);
    } catch (err) {
      if (err instanceof IdentityError) {
        reply.code(400).send({ error: err.message });
        return null;
      }
      throw err;
    }
  };

  app.get('/api/prd/template', async (_req, reply) => {
    if (!enabled()) return off(reply);
    return { markdown: fs.readFileSync(TEMPLATE, 'utf8') };
  });

  app.post('/api/prd/check', async (req, reply) => {
    if (!enabled()) return off(reply);
    const markdown = text((req.body as { markdown?: unknown } | null)?.markdown);
    if (!markdown.trim()) return reply.code(400).send({ error: 'markdown is required' });
    return checkPrd(db, markdown, { exec: opts.reviewExec });
  });

  // lint only, no model: the wizard uses it to refresh the field summary after a hand edit
  app.post('/api/prd/parse', async (req, reply) => {
    if (!enabled()) return off(reply);
    const markdown = text((req.body as { markdown?: unknown } | null)?.markdown);
    if (!markdown.trim()) return reply.code(400).send({ error: 'markdown is required' });
    return parsePrdToForm(markdown);
  });

  app.post('/api/prd', async (req, reply) => {
    if (!enabled()) return off(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const markdown = text(b.markdown);
    if (!markdown.trim()) return reply.code(400).send({ error: 'markdown is required' });
    const benchModels = Array.isArray(b.benchmark_models) ? b.benchmark_models.map(String).filter(Boolean) : [];
    try {
      const r = await submitPrd(db, markdown, {
        exec: opts.reviewExec,
        model: typeof b.model === 'string' ? b.model : null,
        queue: b.queue !== false,
        verify_llm: b.verify_llm === true,
        benchmark_models: benchModels.length ? benchModels : undefined,
        judge_models: Array.isArray(b.judge_models) ? b.judge_models.map(String).filter(Boolean) : undefined,
        // a 工作流程 started from a 驗證方案 keeps it, so the review page offers its image sets
        verify_plan_id: typeof b.verify_plan_id === 'string' && b.verify_plan_id ? b.verify_plan_id : null,
        // 拆成多個任務: the planner decomposes the PRD into a chain (an epic)
        coding_tool: b.coding_tool === 'plan' ? 'plan' : undefined,
      });
      if (!r.ok) return reply.code(422).send({ error: 'PRD blocked by the gate', check: r.check });
      // a wizard draft that became a task remembers it, so the dock can show 已建任務
      if (typeof b.draft_id === 'string') {
        try {
          linkSubmittedDraft(db, identity(req).user_key, b.draft_id, r);
        } catch {
          /* no identity or foreign draft — the task/benchmark exists either way */
        }
      }
      return reply.code(201).send(r);
    } catch (err) {
      if (err instanceof PrdInputError || err instanceof BenchmarkInputError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // ---- drafts ----------------------------------------------------------------------
  const draftError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PrdDraftError) return reply.code(400).send({ error: err.message });
    throw err;
  };

  app.get('/api/prd/drafts', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    const n = Number((req.query as { limit?: string }).limit);
    return { drafts: listDrafts(db, me.user_key, { limit: Number.isFinite(n) && n > 0 ? n : 20 }) };
  });

  app.post('/api/prd/drafts', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    try {
      return reply.code(201).send(createDraft(db, me.user_key, (req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      return draftError(reply, err);
    }
  });

  app.get('/api/prd/drafts/:id', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    const d = getDraft(db, me.user_key, (req.params as { id: string }).id);
    return d ?? reply.code(404).send({ error: 'draft not found' });
  });

  app.put('/api/prd/drafts/:id', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    const { id } = req.params as { id: string };
    if (!getDraft(db, me.user_key, id)) return reply.code(404).send({ error: 'draft not found' });
    try {
      return updateDraft(db, me.user_key, id, (req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      return draftError(reply, err);
    }
  });

  app.delete('/api/prd/drafts/:id', async (req, reply) => {
    const me = who(req, reply);
    if (!me) return reply;
    if (!deleteDraft(db, me.user_key, (req.params as { id: string }).id)) return reply.code(404).send({ error: 'draft not found' });
    return { ok: true };
  });

  // ---- zero-token helpers ----------------------------------------------------------
  app.post('/api/prd/suggest-files', async (req, reply) => {
    if (!enabled()) return off(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const repoPath = text(b.repo_path).trim();
    const real = repoPath ? resolveAllowed(repoPath, allowedRoots(db)) : null;
    if (!real) return reply.code(403).send({ error: 'repo_path 不在允許清單裡' });
    const r = await suggestFiles(db, { repo_path: real, module: text(b.module) || null, description: text(b.description) }, assist);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });

  app.post('/api/prd/draft-acceptance', async (req, reply) => {
    if (!enabled()) return off(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await draftAcceptance(
      db,
      { description: text(b.description), expected: text(b.expected), method: text(b.method), module: text(b.module) || null },
      assist,
    );
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });
}
