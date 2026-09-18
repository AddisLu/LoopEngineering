import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import type { WebSocket } from 'ws';
import { getBool, getSetting } from '../db/index.js';
import { userWorktreePath } from '../terminal/worktree.js';
import { terminalAccess } from '../terminal/access.js';
import { TerminalError, TerminalManager, type PresetResolver, type SpawnPty, type TerminalClient } from '../terminal/sessions.js';
import { getJobRunner } from '../local/jobs.js';
import { identityOf, type ChatIdentity } from './identity.js';

export interface TerminalRouteOptions {
  /** Test-only: a fake pty factory (the default spawns node-pty). */
  spawnPty?: SpawnPty;
  identity?: (req: FastifyRequest) => ChatIdentity;
  manager?: TerminalManager;
}

/** Server-side presets a browser may open by name — the only non-shell commands allowed. */
export const PRESETS: Record<string, PresetResolver> = {
  joblog: (db) => {
    const job = getJobRunner(db).current();
    if (!job) return null;
    return { file: 'tail', args: ['-n', '200', '-f', job.log_path], title: `log · ${job.kind} ${job.recipe}` };
  },
  vllmlog: (db) => ({ file: 'docker', args: ['logs', '-f', '--tail', '200', getSetting(db, 'local_vllm_container') || 'vllm_node'], title: 'vLLM log' }),
  enginelog: () => ({ file: 'journalctl', args: ['--user', '-u', 'loop-engineering', '-f', '-n', '200', '--no-pager'], title: 'Loop log' }),
};

async function realSpawnPty(): Promise<SpawnPty> {
  const pty = await import('node-pty');
  return (file, args, o) => {
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env as Record<string, string> });
    return {
      pid: p.pid,
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit((e) => cb({ exitCode: e.exitCode })),
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: (sig) => p.kill(sig),
    };
  };
}

type Frame =
  | { t: 'open'; cols?: number; rows?: number; preset?: string | null; title?: string | null }
  | { t: 'attach'; id: string }
  | { t: 'in'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'close'; id: string }
  | { t: 'rename'; id: string; title: string }
  | { t: 'list' };

/**
 * 終端機: REST for access + the session list, one WebSocket for everything interactive. All under
 * /api/ so the bearer hook applies (the token rides as ?token= — browsers cannot set headers on
 * a WebSocket); the allowlist check is the second gate.
 */
export function registerTerminalRoutes(app: FastifyInstance, db: Database.Database, opts: TerminalRouteOptions = {}): void {
  let manager: TerminalManager | null = opts.manager ?? null;
  const spawnPromise: Promise<SpawnPty> = opts.spawnPty ? Promise.resolve(opts.spawnPty) : realSpawnPty();
  const mgr = async (): Promise<TerminalManager> => {
    if (!manager) manager = new TerminalManager({ spawnPty: await spawnPromise, db, presets: PRESETS });
    return manager;
  };
  app.addHook('onClose', async () => {
    manager?.closeAll();
  });
  // a browser cannot set headers on a WebSocket, so the typed name may ride as ?user= (the
  // Tailscale header is added by the proxy on the upgrade request like any other)
  const identity =
    opts.identity ??
    ((req: FastifyRequest): ChatIdentity => {
      const q = (req.query ?? {}) as { user?: string };
      const headers = q.user && !req.headers['x-loop-user'] ? { ...req.headers, 'x-loop-user': q.user } : req.headers;
      return identityOf({ headers } as FastifyRequest);
    });
  const access = (req: FastifyRequest) => terminalAccess(req, db, identity);

  app.get('/api/terminal/access', async (req) => {
    const a = access(req);
    // where a new shell would land, so the drawer can say it without opening one. With
    // terminal_worktree on that is this person's own worktree — computed here, created on open.
    const worktree = Boolean(a.user) && getBool(db, 'terminal_worktree', false);
    const cwd = worktree && a.user ? userWorktreePath(db, a.user) : getSetting(db, 'terminal_cwd') || null;
    return { allowed: a.allowed, reason: a.reason, user_label: a.user?.label ?? null, presets: Object.keys(PRESETS), cwd, worktree };
  });

  app.get('/api/terminal/sessions', async (req, reply) => {
    const a = access(req);
    if (!a.allowed) return reply.code(a.code).send({ error: a.reason });
    return { sessions: (await mgr()).list(a.user!.user_key) };
  });

  app.get('/api/terminal/ws', { websocket: true }, async (socket: WebSocket, req) => {
    const a = access(req);
    if (!a.allowed) {
      socket.close(a.code === 404 ? 4404 : 4403, a.reason ?? 'forbidden');
      return;
    }
    const user = a.user!;
    const m = await mgr();
    const client: TerminalClient = { send: (json) => socket.send(json) };
    const send = (frame: Record<string, unknown>) => socket.send(JSON.stringify(frame));
    const fail = (message: string, id?: string) => send({ t: 'error', id, message });

    socket.on('message', (raw: Buffer | string) => {
      let f: Frame;
      try {
        f = JSON.parse(String(raw));
      } catch {
        socket.close(4400, 'bad frame');
        return;
      }
      try {
        switch (f.t) {
          case 'open': {
            const s = m.open({ user, cols: f.cols, rows: f.rows, preset: f.preset ?? null, title: f.title ?? null });
            m.attach(s.id, user.user_key, client);
            send({ t: 'opened', session: s });
            break;
          }
          case 'attach':
            send({ t: 'attached', session: m.attach(f.id, user.user_key, client) });
            break;
          case 'in':
            m.write(f.id, user.user_key, String(f.data ?? ''));
            break;
          case 'resize':
            m.resize(f.id, user.user_key, Number(f.cols), Number(f.rows));
            break;
          case 'close':
            m.close(f.id, user.user_key);
            break;
          case 'rename':
            send({ t: 'renamed', session: m.rename(f.id, user.user_key, String(f.title ?? '')) });
            break;
          case 'list':
            send({ t: 'list', sessions: m.list(user.user_key) });
            break;
          default:
            fail('unknown frame');
        }
      } catch (err) {
        if (err instanceof TerminalError) fail(err.message, 'id' in f ? f.id : undefined);
        else fail((err as Error).message);
      }
    });
    socket.on('close', () => m.detach(client));
    send({ t: 'hello', user_label: user.label, sessions: m.list(user.user_key) });
  });
}
