import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { getTask } from '../tasks.js';
import { identityOf, IdentityError, type ChatIdentity } from './identity.js';
import { codeRefFor, fileDiff, readSource } from '../review/code.js';
import { artifactPath, latestArtifacts } from '../review/artifacts.js';
import {
  approveTask,
  deliveryZip,
  getTrial,
  listTrials,
  releaseTask,
  requestChanges,
  reviewBundle,
  ReviewError,
  startTrial,
  tickCheck,
  type TrialDeps,
} from '../review/review.js';
import type { Task } from '../types.js';

/**
 * 驗收頁 API (web/task.html). Reading is open to anyone with API access; running code (試跑)
 * follows exec_allowed_users like the chat's 沙盒 tools; 核可 / 退回修改 / 發佈 record who did it.
 */

export interface ReviewRouteOptions extends TrialDeps {
  /** test injection: Gitea fetch + token behind 發佈 */
  releaseFetch?: typeof fetch;
  releaseToken?: string;
  identity?: (req: FastifyRequest) => ChatIdentity;
}

const attachment = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export function registerReviewRoutes(app: FastifyInstance, db: Database.Database, opts: ReviewRouteOptions = {}): void {
  const identity = opts.identity ?? ((req: FastifyRequest) => identityOf(req));

  /** the task + the person, or null once an error reply has been sent */
  const ctx = (req: FastifyRequest, reply: FastifyReply): { task: Task; who: ChatIdentity } | null => {
    const task = getTask(db, (req.params as { id: string }).id);
    if (!task) {
      reply.code(404).send({ error: '沒有這個任務' });
      return null;
    }
    try {
      return { task, who: identity(req) };
    } catch (err) {
      if (err instanceof IdentityError) {
        reply.code(400).send({ error: err.message });
        return null;
      }
      throw err;
    }
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ReviewError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get('/api/tasks/:id/review', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    return { ...reviewBundle(db, c.task, c.who, { releaseToken: opts.releaseToken }), viewer: { label: c.who.label, user_key: c.who.user_key } };
  });

  // ---- 程式碼 ----
  app.get('/api/tasks/:id/code/file', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const q = req.query as { path?: string; side?: string };
    const ref = codeRefFor(db, c.task);
    if (!ref) return reply.code(404).send({ error: '找不到這個任務的程式碼' });
    const f = readSource(ref, q.path ?? '', q.side === 'base' ? 'base' : 'head');
    return f ?? reply.code(404).send({ error: '沒有這個檔案' });
  });

  app.get('/api/tasks/:id/code/diff', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const q = req.query as { path?: string };
    const ref = codeRefFor(db, c.task);
    if (!ref) return reply.code(404).send({ error: '找不到這個任務的程式碼' });
    return { diff: fileDiff(ref, q.path ?? undefined) };
  });

  // ---- 人工驗收清單 ----
  app.post('/api/tasks/:id/checks', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as { index?: unknown; checked?: unknown };
    if (!Number.isInteger(b.index) || typeof b.checked !== 'boolean') return reply.code(400).send({ error: 'index / checked 不對' });
    try {
      return { checklist: tickCheck(db, c.task, b.index as number, b.checked, c.who.label) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- 核可 / 退回修改 ----
  app.post('/api/tasks/:id/approve', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    try {
      return await approveTask(db, c.task, c.who.label);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/tasks/:id/request-changes', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const feedback = String(((req.body ?? {}) as { feedback?: unknown }).feedback ?? '');
    try {
      const t = requestChanges(db, c.task, feedback, c.who.label);
      return { ok: true, status: t.status };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- 試跑 ----
  app.post('/api/tasks/:id/trials', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as { mode?: unknown; command?: unknown; dataset?: unknown };
    const mode = b.mode === 'command' ? 'command' : 'verify';
    try {
      const trial = startTrial(
        db,
        c.task,
        { mode, command: typeof b.command === 'string' ? b.command : null, dataset: typeof b.dataset === 'string' && b.dataset ? b.dataset : null },
        c.who,
        { sandboxRun: opts.sandboxRun },
      );
      return reply.code(202).send(trial);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/tasks/:id/trials', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    return { trials: listTrials(c.task.id) };
  });

  app.get('/api/tasks/:id/trials/:tid', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const t = getTrial((req.params as { tid: string }).tid);
    return t && t.task_id === c.task.id ? t : reply.code(404).send({ error: '沒有這次試跑' });
  });

  // ---- 產出物 ----
  app.get('/api/tasks/:id/artifacts', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const a = latestArtifacts(db, c.task.id);
    return a ?? { run_id: null, manifest: null };
  });

  app.get('/api/tasks/:id/artifacts/file', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const rel = String((req.query as { path?: string }).path ?? '');
    const a = latestArtifacts(db, c.task.id);
    const abs = a ? artifactPath(c.task.id, a.run_id, a.manifest, rel) : null;
    if (!abs) return reply.code(404).send({ error: '沒有這個產出物' });
    reply.header('content-type', 'application/octet-stream').header('content-disposition', attachment(rel.split('/').pop() || 'file'));
    return reply.send(fs.createReadStream(abs));
  });

  app.get('/api/tasks/:id/artifacts.zip', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    try {
      const z = deliveryZip(db, c.task);
      reply.header('content-type', 'application/zip').header('content-disposition', attachment(z.name));
      return reply.send(z.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- 發佈到 Gitea ----
  app.post('/api/tasks/:id/release', async (req, reply) => {
    const c = ctx(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as { tag?: unknown; name?: unknown };
    try {
      return await releaseTask(
        db,
        c.task,
        { tag: typeof b.tag === 'string' ? b.tag : null, name: typeof b.name === 'string' ? b.name : null },
        c.who.label,
        { fetchImpl: opts.releaseFetch, token: opts.releaseToken },
      );
    } catch (err) {
      return fail(reply, err);
    }
  });
}
