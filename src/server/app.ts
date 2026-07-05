import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { getDb, getSetting, setSetting, getBool, getNum } from '../db/index.js';
import { validateSetting, TUNABLE_KEYS } from '../settings.js';
import { createTask, getTask, setStatus, activeRuns, deleteTask, countByStatus, tasksForPrune } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { readUsage } from '../token/usage.js';
import { killRun } from '../orchestrator/kill.js';
import { cleanupWorktree, resetTaskWorkspace } from '../orchestrator/cleanup.js';
import { pruneTaskArtifacts } from '../git/worktree.js';
import { integrateIntoBase } from '../git/integrate.js';
import { latestRun } from '../tasks.js';
import fs from 'node:fs';
import { boardState, taskResult } from './board.js';
import type { Complexity } from '../config.js';
import { registerKnowledgeRoutes } from './knowledgeRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', '..', 'web');

export interface AppOptions {
  db?: Database.Database;
  apiToken?: string | null;
}

interface CreateTaskBody {
  title?: string;
  goal?: string;
  plan_ref?: string | null;
  plan_kind?: 'md' | 'html' | 'url' | null;
  coding_tool?: string;
  verification_steps?: string[] | string;
  setup_cmd?: string | null;
  repo_path?: string | null;
  base_branch?: string | null;
  complexity?: string;
  priority?: number;
  model?: string | null;
  depends_on?: string | null;
  environment?: string | null;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const db = opts.db ?? getDb();
  // An explicit apiToken (including null, meaning "no auth") always wins; only fall
  // back to the ambient LOOP_API_TOKEN when the caller left it unspecified. Using ??
  // here would let the env var override an intentional `apiToken: null`.
  const apiToken = opts.apiToken !== undefined ? opts.apiToken : (process.env.LOOP_API_TOKEN ?? null);
  const app = Fastify({ logger: false });

  // --- bearer auth on /api/* (Tailscale is the primary boundary; this is layer 2) ---
  app.addHook('onRequest', async (req, reply) => {
    if (!apiToken) return; // dev / no token configured
    if (!req.url.startsWith('/api/')) return;
    const auth = req.headers.authorization;
    const q = (req.query as any)?.token;
    const ok = auth === `Bearer ${apiToken}` || q === apiToken;
    if (!ok) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/status', async () => {
    const u = readUsage();
    return {
      paused: getBool(db, 'scheduler_paused'),
      usage: { session: u.session.percent, weekly: u.weekly.percent, source: u.source },
    };
  });

  app.get('/api/token', async () => readUsage());

  app.get('/api/board', async () => boardState(db));

  app.get('/api/history', async (req) => {
    const limit = Math.min(2000, Number((req.query as any)?.limit ?? 500));
    return db
      .prepare(
        `SELECT session_pct, weekly_pct, session_resets_at, weekly_resets_at, source, created_at
           FROM token_snapshots ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  });

  app.post('/api/tasks', async (req, reply) => {
    const b = (req.body ?? {}) as CreateTaskBody;
    if (!b.title || !b.goal) return reply.code(400).send({ error: 'title and goal required' });
    const steps = Array.isArray(b.verification_steps)
      ? b.verification_steps
      : typeof b.verification_steps === 'string'
        ? b.verification_steps.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const t = createTask(db, {
      title: b.title,
      goal: b.goal,
      plan_ref: b.plan_ref ?? null,
      plan_kind: b.plan_kind ?? null,
      coding_tool: b.coding_tool ?? 'claude-code',
      verification_steps: steps,
      setup_cmd: b.setup_cmd ?? null,
      repo_path: b.repo_path ?? null,
      base_branch: b.base_branch ?? null,
      complexity: (b.complexity as Complexity) ?? 'M',
      priority: b.priority ?? 2,
      model: b.model ?? null,
      depends_on: b.depends_on ?? null,
      environment: b.environment ?? null,
    });
    return { task: t, gate: validateTask(t) };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const t = getTask(db, (req.params as any).id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return { task: t, gate: validateTask(t) };
  });

  app.post('/api/tasks/:id/queue', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    // Only drafts enter the queue here; a troubled task (attention/failed) must go
    // through /restart so its stale branch/worktree is reset first.
    if (t.status !== 'draft') {
      return reply.code(409).send({
        error: `task is ${t.status} — only a draft can be queued; use /restart to requeue it`,
        status: t.status,
      });
    }
    const gate = validateTask(t);
    if (!gate.ok) return reply.code(409).send({ error: 'gate not satisfied', gate });
    // Controlled auto-queue path (used by the MCP, which queues by default): cap how many
    // tasks may be auto-enqueued so a burst of MCP calls can't flood autonomous spend.
    // Manual queueing (from the board/CLI, no `auto` flag) is intentionally uncapped.
    const auto =
      (req.query as any)?.auto === '1' ||
      (req.query as any)?.auto === 'true' ||
      (req.body as any)?.auto === true;
    if (auto) {
      const max = getNum(db, 'max_autoqueue', 3);
      const counts = countByStatus(db);
      const active = (counts.queued ?? 0) + (counts.running ?? 0);
      if (active >= max) {
        return reply.code(429).send({
          error: 'autoqueue limit reached',
          limit: max,
          active,
          message: `Auto-queue limit reached (${active} queued+running ≥ max_autoqueue=${max}). Task left as draft — queue it from the board or raise max_autoqueue.`,
        });
      }
    }
    setStatus(db, id, 'queued', { detail: auto ? 'auto-queued via api' : 'queued via api' });
    return { ok: true };
  });

  // Manual integrate for a task left at merge_status pending/conflict (e.g. no-gh host,
  // or a conflict that has since been resolved on base). Resolves gitDir to the run
  // worktree if it still exists, else the repo, so it works after worktree cleanup.
  app.post('/api/tasks/:id/merge', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (t.status !== 'review')
      return reply.code(409).send({ error: 'task not in review', status: t.status });
    if (t.merge_status !== 'pending' && t.merge_status !== 'conflict')
      return reply.code(409).send({ error: 'task not awaiting merge', merge_status: t.merge_status });
    if (!t.repo_path || !t.base_branch)
      return reply.code(409).send({ error: 'task has no repo/base' });
    const branch = `loop/${t.id}`;
    const run = latestRun(db, id);
    const gitDir = run?.worktree_path && fs.existsSync(run.worktree_path) ? run.worktree_path : t.repo_path;
    const r = integrateIntoBase(t.repo_path, gitDir, branch, t.base_branch);
    db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run(r.outcome, id);
    if (r.outcome === 'merged') cleanupWorktree(db, t);
    return { outcome: r.outcome, detail: r.detail };
  });

  app.post('/api/tasks/:id/close', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    setStatus(db, id, 'closed', { detail: 'closed via api' });
    cleanupWorktree(db, t); // work is done — reclaim the worktree's disk
    return { ok: true };
  });

  // Task result for editors/MCP: PR link, gap-review, failure reason, recent log —
  // so a caller can see the outcome without opening the board.
  app.get('/api/tasks/:id/result', async (req, reply) => {
    const r = taskResult(db, (req.params as any).id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    return r;
  });

  // --- attention (待確認) triage actions ---

  // 續跑: hand an attention task back to the auto-resume path. Clamping (not resetting)
  // resume_count to max_resumes grants exactly ONE more tick-eligible attempt — the
  // scheduler resumes blocked tasks while resume_count <= max_resumes.
  app.post('/api/tasks/:id/resume', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (t.status !== 'attention')
      return reply.code(409).send({ error: 'task not in attention', status: t.status });
    const run = latestRun(db, id);
    if (!run?.session_id) return reply.code(400).send({ error: 'no session — use restart' });
    const maxResumes = getNum(db, 'max_resumes', 2);
    db.prepare('UPDATE tasks SET resume_count = ? WHERE id = ?').run(Math.min(t.resume_count, maxResumes), id);
    setStatus(db, id, 'blocked', { detail: 'manual resume from attention' });
    return { ok: true };
  });

  // 重來: requeue from scratch. resetTaskWorkspace removes the run worktrees AND the
  // loop/<id> branch, so the next dispatch re-cuts from (freshly fetched) base instead
  // of silently reusing the stale branch/dir.
  app.post('/api/tasks/:id/restart', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (t.status !== 'attention' && t.status !== 'failed')
      return reply.code(409).send({ error: 'restart only applies to attention/failed tasks', status: t.status });
    resetTaskWorkspace(db, t);
    db.prepare('UPDATE tasks SET resume_count = 0, pr_url = NULL, merge_status = NULL WHERE id = ?').run(id);
    setStatus(db, id, 'queued', { detail: 'restart: fresh from base' });
    return { ok: true };
  });

  // 放棄: close the triage as a terminal failure; ?cleanup=1 also reclaims the worktree.
  app.post('/api/tasks/:id/abandon', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (t.status !== 'attention')
      return reply.code(409).send({ error: 'task not in attention', status: t.status });
    setStatus(db, id, 'failed', { detail: 'abandoned by user' });
    const cleanup = (req.query as any)?.cleanup === '1' || (req.query as any)?.cleanup === 'true';
    if (cleanup) cleanupWorktree(db, t);
    return { ok: true };
  });

  // 轉待確認: a blocked task auto-resumes on every eligible tick with no way to stop it —
  // hand it to attention instead, since the tick only scans 'blocked'. Note: a hold
  // racing an in-flight tick may still allow one more resume (one-poll window, acceptable).
  app.post('/api/tasks/:id/hold', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (t.status !== 'blocked')
      return reply.code(409).send({ error: 'task not blocked', status: t.status });
    setStatus(db, id, 'attention', { detail: 'held by user (auto-resume stopped)' });
    return { ok: true };
  });

  app.post('/api/tasks/:id/abort', async (req, reply) => {
    const id = (req.params as any).id;
    if (!getTask(db, id)) return reply.code(404).send({ error: 'not found' });
    for (const r of activeRuns(db).filter((r) => r.task_id === id)) {
      killRun(db, { id: r.id, pid: r.pid }, 'user');
    }
    setStatus(db, id, 'failed', { detail: 'aborted via api' });
    return { ok: true };
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { force?: string };
    const force = q?.force === '1' || q?.force === 'true';
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const active = t.status === 'running' || t.status === 'verifying' || t.status === 'queued';
    if (active && !force) {
      return reply
        .code(409)
        .send({ error: 'task is active — abort it first or pass ?force=1', status: t.status });
    }
    // force on an active task: interrupt its run before we drop the rows.
    if (active) for (const r of activeRuns(db).filter((r) => r.task_id === id)) killRun(db, { id: r.id, pid: r.pid }, 'user');
    pruneTaskArtifacts(db, t); // remove worktrees/logs/plan (path-safe) before cascade-delete
    deleteTask(db, id);
    return { ok: true, deleted: id };
  });

  // Batch-prune terminal tasks + their disk artifacts. Never deletes active/blocked/review
  // (tasksForPrune enforces that). dryRun returns the would-delete list without deleting.
  app.post('/api/tasks/prune', async (req) => {
    const b = (req.body ?? {}) as { status?: string[]; olderThanDays?: number; dryRun?: boolean };
    const targets = tasksForPrune(db, { status: b.status, olderThanDays: b.olderThanDays });
    const ids = targets.map((t) => t.id);
    if (b.dryRun) return { count: ids.length, ids, dryRun: true };
    for (const t of targets) {
      pruneTaskArtifacts(db, t);
      deleteTask(db, t.id);
    }
    return { count: ids.length, ids };
  });

  app.post('/api/pause', async (req) => {
    setSetting(db, 'scheduler_paused', 'true');
    const hard = (req.query as any)?.hard === '1' || (req.query as any)?.hard === 'true';
    // reason 'pause' (NOT 'user'): a user abort is terminal, a hard pause must stay
    // resumable — the interrupted task goes to blocked and auto-resumes on unpause.
    if (hard) for (const r of activeRuns(db)) killRun(db, { id: r.id, pid: r.pid }, 'pause');
    return { ok: true, paused: true, hard };
  });

  app.post('/api/resume-scheduler', async () => {
    setSetting(db, 'scheduler_paused', 'false');
    return { ok: true, paused: false };
  });

  // --- tunable scheduler settings (day/night thresholds etc.), read/written from the board ---
  const readSettings = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of TUNABLE_KEYS) out[k] = getSetting(db, k) ?? '';
    return out;
  };
  app.get('/api/settings', async () => ({ settings: readSettings() }));
  app.post('/api/settings', async (req, reply) => {
    const b = (req.body ?? {}) as { settings?: Record<string, unknown>; key?: string; value?: unknown };
    const entries: [string, string][] = b.settings
      ? Object.entries(b.settings).map(([k, v]) => [k, String(v)])
      : b.key != null && b.value != null
        ? [[b.key, String(b.value)]]
        : [];
    if (!entries.length) return reply.code(400).send({ error: 'no settings provided' });
    const errors: Record<string, string> = {};
    for (const [k, v] of entries) {
      const err = validateSetting(k, v);
      if (err) errors[k] = err;
    }
    if (Object.keys(errors).length) return reply.code(400).send({ error: 'validation failed', errors });
    for (const [k, v] of entries) setSetting(db, k, v);
    return { ok: true, settings: readSettings() };
  });

  // --- SSE: push a full board snapshot every second (+ immediately) ---
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = () => {
      try {
        reply.raw.write(`data: ${JSON.stringify(boardState(db))}\n\n`);
      } catch {
        /* client gone */
      }
    };
    send();
    const iv = setInterval(send, 1000);
    req.raw.on('close', () => clearInterval(iv));
  });

  registerKnowledgeRoutes(app, db);

  app.register(fastifyStatic, { root: WEB_DIR, prefix: '/' });

  return app;
}
