import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logEvent } from '../db/index.js';
import { identityOf, IdentityError } from './identity.js';
import { getRepo, listRepos, parseStack, RepoError, updateRepo, type Repo, type RepoPatch } from '../repo/store.js';
import { getImportJob, importRepo, listImportJobs, redetectRepo, removeRepo, type ImportDeps } from '../repo/import.js';
import { listFixes } from '../repo/ledger.js';

/**
 * Repo registry + import (src/repo/*) for the Repo page (/repos.html, its own link):
 *   GET    /api/repos                 rows (+ parsed stack), machine names for the picker, running imports
 *   POST   /api/repos/import          {url, name?} → 202 {job}; the page polls the job
 *   GET    /api/repos/import/:jobId   the job with its steps
 *   GET    /api/repos/:id
 *   PATCH  /api/repos/:id             the editable columns (store.ts RepoPatch)
 *   DELETE /api/repos/:id             row + allowlist entry; the clone stays on disk
 *   POST   /api/repos/:id/redetect    re-run the branch / command / stack detection
 *   GET    /api/repos/:id/fixes       過去修法 (src/repo/ledger.ts), newest first; ?limit= 1–200 (default 50)
 */
export interface RepoRouteOptions {
  /** test injection: file:// origins, a temp clone root, a recorded ingest */
  importDeps?: ImportDeps;
}

const PATCH_KEYS: ReadonlyArray<keyof RepoPatch> = ['name', 'default_branch', 'pr_base', 'machine', 'build_cmd', 'test_cmd', 'setup_cmd', 'domain', 'issue_label', 'issue_comments', 'enabled'];

const view = (r: Repo) => ({ ...r, stack: parseStack(r) });

export function registerRepoRoutes(app: FastifyInstance, db: Database.Database, opts: RepoRouteOptions = {}): void {
  const who = (req: FastifyRequest): string => {
    try {
      return identityOf(req).label;
    } catch (err) {
      if (err instanceof IdentityError) return 'unknown';
      throw err;
    }
  };
  const repoError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RepoError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  const machineNames = (): string[] => {
    try {
      return (db.prepare('SELECT name FROM machines WHERE enabled = 1 ORDER BY name').all() as { name: string }[]).map((m) => m.name);
    } catch {
      return [];
    }
  };

  app.get('/api/repos', async () => ({
    repos: listRepos(db).map(view),
    machines: machineNames(),
    imports: listImportJobs().filter((j) => j.status === 'running'),
  }));

  app.post('/api/repos/import', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const job = importRepo(db, { url: String(b.url ?? ''), name: typeof b.name === 'string' ? b.name : null, domain: typeof b.domain === 'string' ? b.domain : null, who: who(req) }, opts.importDeps);
      return reply.code(202).send({ job });
    } catch (err) {
      return repoError(reply, err);
    }
  });

  app.get('/api/repos/import/:jobId', async (req, reply) => {
    const job = getImportJob((req.params as { jobId: string }).jobId);
    return job ? { job } : reply.code(404).send({ error: '沒有這個匯入工作' });
  });

  app.get('/api/repos/:id', async (req, reply) => {
    const r = getRepo(db, (req.params as { id: string }).id);
    return r ? { repo: view(r) } : reply.code(404).send({ error: '沒有這個 repo' });
  });

  app.patch('/api/repos/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of PATCH_KEYS) if (k in b) patch[k] = b[k];
    try {
      const r = updateRepo(db, id, patch as RepoPatch);
      if (!r) return reply.code(404).send({ error: '沒有這個 repo' });
      logEvent(db, { kind: 'note', detail: `repo 設定修改：${r.name}（${r.id}）${Object.keys(patch).length ? `：${Object.keys(patch).join('、')}` : ''} by ${who(req)}` });
      return { repo: view(r) };
    } catch (err) {
      return repoError(reply, err);
    }
  });

  app.delete('/api/repos/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = removeRepo(db, id);
    if (!r) return reply.code(404).send({ error: '沒有這個 repo' });
    logEvent(db, { kind: 'note', detail: `repo 移除登錄：${r.name}（${id}）by ${who(req)}` });
    return { ok: true, local_path: r.local_path };
  });

  // the Repo page's 過去修法 tab: what was fixed in this repo, where, how it ended
  app.get('/api/repos/:id/fixes', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getRepo(db, id)) return reply.code(404).send({ error: '沒有這個 repo' });
    const n = Number((req.query as { limit?: string }).limit);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
    return { fixes: listFixes(db, id, limit) };
  });

  app.post('/api/repos/:id/redetect', async (req, reply) => {
    try {
      const r = await redetectRepo(db, (req.params as { id: string }).id, opts.importDeps);
      return r ? { repo: view(r) } : reply.code(404).send({ error: '沒有這個 repo' });
    } catch (err) {
      return repoError(reply, err);
    }
  });
}
