import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getTask, getTaskBySourceRef } from '../tasks.js';
import { resolveInside } from '../git/worktree.js';
import type { chatLocal } from '../local/chat.js';
import type { VisionExec } from '../intake/vision.js';
import { AnalysisError, analyseTicket, renderTicket, type AnalyseDeps } from '../intake/analyse.js';
import {
  approveStart,
  cancelTicket,
  createTicket,
  getTicket,
  importedRepoFor,
  issueRefFromUrl,
  listTickets,
  patchTicket,
  rejectStart,
  resolveTicketLink,
  startTicket,
  TicketError,
  ticketImageFile,
  ticketView,
  withdrawStart,
} from '../intake/ticket.js';
import { identityOf, IdentityError, type ChatIdentity } from './identity.js';

/**
 * 問題單 (src/intake/*) — the API the 問題單 page reads (contract: ticket-api.md):
 *   POST   /api/tickets                    create (description, repo, screenshots, issue link) → 201, analysis starts
 *   GET    /api/tickets?mine=1&limit=20    newest first
 *   GET    /api/tickets/:id                the ticket with its 分析卡
 *   PATCH  /api/tickets/:id                改一下 (description / answers re-run the analysis)
 *   POST   /api/tickets/:id/analyse        重試 → 202
 *   POST   /api/tickets/:id/start          開始修 (manager mode: 送出核可)
 *   POST   /api/tickets/:id/approve-start  managers: 核可 → queued
 *   POST   /api/tickets/:id/reject-start   managers: 退回 {reason}
 *   POST   /api/tickets/:id/withdraw       撤回 a request for approval
 *   POST   /api/tickets/:id/cancel         drafts only: the task and its screenshots go
 *   POST   /api/tickets/resolve-link       {url} → repo / issue / PR, imported?, the issue
 *   GET    /api/tickets/:id/images/:n      a screenshot
 *   GET    /api/tickets/:id/plan           the composed PRD (read-only 「看需求文件」)
 */
export interface TicketRouteOptions {
  /** the analysis' seams: checks, the repro runner, git, the ready hook, the PRD review */
  analyseDeps?: AnalyseDeps;
  /** Gitea behind resolve-link and issue tickets (the token is still GITEA_TOKEN) */
  giteaFetch?: typeof fetch;
  /** the local model the analysis asks (proposal, screenshots, review) */
  localChat?: typeof chatLocal;
  /** the OCR runner behind screenshots */
  visionExec?: VisionExec;
}

/** screenshots arrive as base64 data URLs: 6 × 4 MB decoded, well past Fastify's 1 MB default */
const CREATE_BODY_LIMIT = 40 * 1024 * 1024;

// Registered from app.ts before the static handler (the auth hook covers /api/*).
export function registerTicketRoutes(app: FastifyInstance, db: Database.Database, opts: TicketRouteOptions = {}): void {
  const deps: AnalyseDeps = {
    ...opts.analyseDeps,
    localChat: opts.analyseDeps?.localChat ?? opts.localChat,
    visionExec: opts.analyseDeps?.visionExec ?? opts.visionExec,
  };
  const gitea = opts.giteaFetch ? { fetchImpl: opts.giteaFetch } : {};
  const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;
  /** who acts; an unreadable name header is a 400 */
  const me = (req: FastifyRequest, reply: FastifyReply): ChatIdentity | null => {
    try {
      return identityOf(req);
    } catch (err) {
      if (err instanceof IdentityError) {
        reply.code(400).send({ error: err.message });
        return null;
      }
      throw err;
    }
  };
  /** who reads: an unreadable name header only loses can_approve */
  const reader = (req: FastifyRequest): ChatIdentity | null => {
    try {
      return identityOf(req);
    } catch {
      return null;
    }
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof TicketError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof AnalysisError) return reply.code(409).send({ error: err.message });
    throw err;
  };
  const view = (id: string, who: ChatIdentity | null) => ticketView(db, getTask(db, id)!, who);

  app.post('/api/tickets', { bodyLimit: CREATE_BODY_LIMIT }, async (req, reply) => {
    const who = me(req, reply);
    if (!who) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      let issue: { owner: string; repo: string; number: number; url: string } | null = null;
      let sourceRef: string | null = null;
      let repoId = b.repo_id;
      if (typeof b.issue_url === 'string' && b.issue_url.trim()) {
        const ref = issueRefFromUrl(db, b.issue_url);
        if (!ref) throw new TicketError('看不懂這個 issue 連結（要是這台 Gitea 的 …/owner/repo/issues/12）');
        const existing = getTaskBySourceRef(db, ref.source_ref);
        if (existing?.intake_json) return reply.code(200).send({ ticket: ticketView(db, existing, who) });
        if (existing) throw new TicketError(`這個 issue 已經是任務 ${existing.id}`, 409);
        const issueRepo = importedRepoFor(db, ref.owner, ref.repo);
        if (!issueRepo) throw new TicketError(`${ref.owner}/${ref.repo} 還沒匯入 Loop：先匯入這個 repo`, 409, { code: 'repo_not_imported' });
        if (repoId === undefined || repoId === null || repoId === '') repoId = issueRepo.id;
        else if (repoId !== issueRepo.id) throw new TicketError(`這個 issue 屬於 ${ref.owner}/${ref.repo}，不是選的 repo`);
        issue = { owner: ref.owner, repo: ref.repo, number: ref.number, url: ref.url };
        sourceRef = ref.source_ref;
      }
      const t = createTicket(
        db,
        { title: b.title, description: b.description, repo_id: repoId, branch: b.branch, priority: b.priority, model: b.model, kind: b.kind, images: b.images, from: 'ui', issue, source_ref: sourceRef },
        who,
      );
      void analyseTicket(db, t.id, deps);
      return reply.code(201).send({ ticket: view(t.id, who) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/tickets', async (req, reply) => {
    const q = (req.query ?? {}) as { mine?: string; limit?: string };
    let mine: string | null = null;
    if (q.mine === '1' || q.mine === 'true') {
      const who = me(req, reply);
      if (!who) return reply;
      mine = who.user_key;
    }
    const n = Number(q.limit);
    return { tickets: listTickets(db, { mine, limit: Number.isFinite(n) && n > 0 ? n : 20 }) };
  });

  app.post('/api/tickets/resolve-link', async (req) => {
    const b = (req.body ?? {}) as { url?: unknown };
    return resolveTicketLink(db, b.url, gitea);
  });

  app.get('/api/tickets/:id', async (req, reply) => {
    try {
      return { ticket: ticketView(db, getTicket(db, idOf(req)), reader(req)) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch('/api/tickets/:id', async (req, reply) => {
    const who = me(req, reply);
    if (!who) return reply;
    const id = idOf(req);
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    try {
      const r = patchTicket(db, id, b, who);
      if (r.next === 'analyse') void analyseTicket(db, id, deps);
      else if (r.next === 'render') await renderTicket(db, id, deps);
      return { ticket: view(id, who) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/tickets/:id/analyse', async (req, reply) => {
    const id = idOf(req);
    try {
      const t = getTicket(db, id);
      if (t.status !== 'draft') throw new TicketError(`這張單已經開始了（${t.status}），不能重新分析`, 409, { status: t.status });
      void analyseTicket(db, id, deps);
      return reply.code(202).send({ ticket: view(id, reader(req)) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  const action = (name: string, run: (id: string, who: ChatIdentity, body: Record<string, unknown>) => void) => {
    app.post(`/api/tickets/:id/${name}`, async (req, reply) => {
      const who = me(req, reply);
      if (!who) return reply;
      const id = idOf(req);
      try {
        run(id, who, (req.body ?? {}) as Record<string, unknown>);
        return { ticket: view(id, who) };
      } catch (err) {
        return fail(reply, err);
      }
    });
  };
  action('start', (id, who) => startTicket(db, id, who));
  action('approve-start', (id, who) => approveStart(db, id, who));
  action('reject-start', (id, who, b) => rejectStart(db, id, who, b.reason));
  action('withdraw', (id, who) => withdrawStart(db, id, who));

  app.post('/api/tickets/:id/cancel', async (req, reply) => {
    const who = me(req, reply);
    if (!who) return reply;
    try {
      cancelTicket(db, idOf(req), who);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/tickets/:id/images/:n', async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    try {
      const img = /^\d+$/.test(n) ? ticketImageFile(getTicket(db, id), Number(n)) : null;
      if (!img) return reply.code(404).send({ error: '沒有這張截圖' });
      return reply.header('content-type', img.mime).header('x-content-type-options', 'nosniff').send(fs.readFileSync(img.file));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/tickets/:id/plan', async (req, reply) => {
    try {
      const t = getTicket(db, idOf(req));
      const file = t.plan_ref ? resolveInside(paths.plansDir, t.plan_ref) : null;
      if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: '還沒有需求文件（分析完成後才有）' });
      return { markdown: fs.readFileSync(file, 'utf8') };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
