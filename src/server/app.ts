import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { getDb, getSetting, setSetting, getBool } from '../db/index.js';
import { validateSetting, TUNABLE_KEYS } from '../settings.js';
import { createTask, getTask, setStatus, activeRuns } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { readUsage } from '../token/usage.js';
import { killRun } from '../orchestrator/kill.js';
import { boardState } from './board.js';
import type { Complexity } from '../config.js';

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
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const db = opts.db ?? getDb();
  const apiToken = opts.apiToken ?? process.env.LOOP_API_TOKEN ?? null;
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
    const gate = validateTask(t);
    if (!gate.ok) return reply.code(409).send({ error: 'gate not satisfied', gate });
    setStatus(db, id, 'queued', { detail: 'queued via api' });
    return { ok: true };
  });

  app.post('/api/tasks/:id/close', async (req, reply) => {
    const id = (req.params as any).id;
    if (!getTask(db, id)) return reply.code(404).send({ error: 'not found' });
    setStatus(db, id, 'closed', { detail: 'closed via api' });
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

  app.post('/api/pause', async (req) => {
    setSetting(db, 'scheduler_paused', 'true');
    const hard = (req.query as any)?.hard === '1' || (req.query as any)?.hard === 'true';
    if (hard) for (const r of activeRuns(db)) killRun(db, { id: r.id, pid: r.pid }, 'user');
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

  app.register(fastifyStatic, { root: WEB_DIR, prefix: '/' });

  return app;
}
