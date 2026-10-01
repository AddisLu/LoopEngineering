import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logEvent } from '../db/index.js';
import { identityOf, IdentityError } from './identity.js';
import { getRepo, listRepos } from '../repo/store.js';
import { profileView, searchIndex } from '../repo/profileStore.js';
import { repoScope } from '../knowledge/types.js';
import { createReport, DiagError, getReport, listReports, recordCase, runDiagnosis, type DiagnoseDeps } from '../diag/diagnose.js';
import type { DiagInput } from '../diag/types.js';

/**
 * Repo 檔案 and 機況診斷 for the 知識 page:
 *   GET  /api/repos/:id/profile            the profile, its machine fit, facet nodes, 一次改對率
 *   POST /api/repos/:id/profile            {infer?} (re)analyse — 202; the job is opts.runProfile
 *   GET  /api/repos/:id/index?q=&kind=     參數與告警 search
 *   GET  /api/knowledge/facet-drafts       drafts of every repo (待核可)
 *   POST /api/knowledge/approve-many       {ids}
 *   POST /api/diag                         {repo_id?, note?, inputs:[{name,text}]} → {report} (parsed now, diagnosed after)
 *   GET  /api/diag?limit=                  recent reports
 *   GET  /api/diag/:id
 *   POST /api/diag/:id/case                {cause, resolution?} → 記成案例
 */

export interface ProfileRouteOptions {
  /** the profile job (src/repo/profileJob.ts); tests inject a recorder */
  runProfile?: (db: Database.Database, repoId: string, o: { infer: boolean }) => Promise<unknown>;
  diagnose?: DiagnoseDeps;
}

/** screenshots + logs: a few MB of text (5 MB cap is enforced in createReport) */
const DIAG_BODY_LIMIT = 12 * 1024 * 1024;

export function registerProfileRoutes(app: FastifyInstance, db: Database.Database, opts: ProfileRouteOptions = {}): void {
  const who = (req: FastifyRequest): string => {
    try {
      return identityOf(req).label;
    } catch (err) {
      if (err instanceof IdentityError) return 'unknown';
      throw err;
    }
  };
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DiagError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get('/api/repos/:id/profile', async (req, reply) => {
    const v = profileView(db, idOf(req));
    return v ?? reply.code(404).send({ error: '沒有這個 repo' });
  });

  app.post('/api/repos/:id/profile', async (req, reply) => {
    const repo = getRepo(db, idOf(req));
    if (!repo) return reply.code(404).send({ error: '沒有這個 repo' });
    if (!opts.runProfile) return reply.code(501).send({ error: '這個版本還不能分析 repo' });
    const infer = ((req.body ?? {}) as { infer?: unknown }).infer === true;
    void opts.runProfile(db, repo.id, { infer }).catch((err) => console.error('[profile]', err));
    logEvent(db, { kind: 'note', detail: `Repo 檔案：${repo.name} ${infer ? '本地模型補充' : '重新分析'} by ${who(req)}` });
    return reply.code(202).send({ ok: true });
  });

  app.get('/api/repos/:id/index', async (req, reply) => {
    const repo = getRepo(db, idOf(req));
    if (!repo) return reply.code(404).send({ error: '沒有這個 repo' });
    const q = req.query as { q?: string; kind?: string; limit?: string };
    const kinds = new Set(['param', 'param_use', 'log', 'incident', 'error_code']);
    return { entries: searchIndex(db, repo.id, String(q.q ?? '').slice(0, 200), { kind: q.kind && kinds.has(q.kind) ? q.kind : null, limit: Number(q.limit) || 50 }) };
  });

  app.get('/api/knowledge/facet-drafts', async () => {
    const byScope = new Map(listRepos(db).map((r) => [repoScope(r.local_path), { id: r.id, name: r.name }]));
    const rows = db
      .prepare("SELECT id, kind, title, body, scope, source, status, weight, facet, meta_json, updated_at FROM knowledge_nodes WHERE facet IS NOT NULL AND status = 'draft' AND invalid_at IS NULL ORDER BY updated_at DESC LIMIT 300")
      .all() as Array<{ scope: string; meta_json: string | null } & Record<string, unknown>>;
    return {
      nodes: rows.map(({ meta_json, ...n }) => {
        let evidence: unknown[] = [];
        let trigger: unknown = null;
        try {
          const m = JSON.parse(meta_json ?? '{}') as { evidence?: unknown[]; trigger?: unknown };
          evidence = (m.evidence ?? []).slice(0, 5);
          trigger = m.trigger ?? null;
        } catch {
          /* none */
        }
        const repo = byScope.get(n.scope) ?? null;
        return { ...n, evidence, trigger, hits: null, repo };
      }),
    };
  });

  app.post('/api/knowledge/approve-many', async (req, reply) => {
    const ids = ((req.body ?? {}) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string') || ids.length > 500) return reply.code(400).send({ error: 'ids 要是一串 id' });
    const stmt = db.prepare("UPDATE knowledge_nodes SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND status = 'draft'");
    let n = 0;
    db.transaction(() => {
      for (const id of ids) n += stmt.run(id).changes;
    })();
    logEvent(db, { kind: 'note', detail: `知識核可 ${n} 筆 by ${who(req)}` });
    return { ok: true, approved: n };
  });

  app.post('/api/diag', { bodyLimit: DIAG_BODY_LIMIT }, async (req, reply) => {
    const b = (req.body ?? {}) as { repo_id?: unknown; note?: unknown; inputs?: unknown };
    if (!Array.isArray(b.inputs)) return reply.code(400).send({ error: 'inputs 要是 [{name, text}]' });
    const inputs = (b.inputs as unknown[]).filter((x): x is DiagInput => !!x && typeof (x as DiagInput).text === 'string').map((x) => ({ name: String(x.name ?? ''), text: x.text }));
    try {
      const rep = createReport(db, { repo_id: typeof b.repo_id === 'string' ? b.repo_id : null, note: typeof b.note === 'string' ? b.note : null, inputs }, who(req));
      void runDiagnosis(db, rep.id, opts.diagnose ?? {});
      return reply.code(201).send({ report: rep });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/diag', async (req) => ({ reports: listReports(db, Number((req.query as { limit?: string }).limit) || 20) }));

  app.get('/api/diag/:id', async (req, reply) => {
    const r = getReport(db, idOf(req));
    return r ? { report: r } : reply.code(404).send({ error: '沒有這份診斷' });
  });

  app.post('/api/diag/:id/case', async (req, reply) => {
    const b = (req.body ?? {}) as { cause?: unknown; resolution?: unknown };
    try {
      return { report: recordCase(db, idOf(req), { cause: String(b.cause ?? ''), resolution: typeof b.resolution === 'string' ? b.resolution : null }, who(req)) };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
