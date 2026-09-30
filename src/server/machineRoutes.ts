import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logEvent } from '../db/index.js';
import { identityOf, IdentityError } from './identity.js';
import { describeExecHosts, realHostExec, type HostExec } from '../exec/hosts.js';
import {
  createMachine,
  datasetsUsingMachine,
  deleteMachine,
  getMachine,
  labelsOf,
  lastCheckOf,
  listMachines,
  MachineError,
  recordCheck,
  reposUsingMachine,
  updateMachine,
  type Machine,
  type MachineInput,
} from '../exec/machines.js';
import { checkMachine, withMachineLock } from '../exec/remote.js';

/**
 * 機台 registry + health check (src/exec/{machines,remote}.ts) for the 機台 page and the CLI:
 * GET/POST /api/machines, GET/PATCH/DELETE /api/machines/:name, POST /api/machines/:name/check.
 * The GPU 沙盒 hosts (exec_hosts) ride along read-only as `sandbox_hosts` on the list.
 */

export interface MachineRouteOptions {
  /** test injection: ssh/rsync/scp behind the health check (zero network in tests) */
  hostExec?: HostExec;
}

const FIELDS = ['name', 'ssh_target', 'ssh_port', 'os', 'shell', 'work_root', 'labels', 'description', 'transport', 'enabled'] as const;

/** Only the keys the body names, so a PATCH leaves the rest alone. */
function patchOf(body: unknown): Partial<MachineInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (b[k] !== undefined) out[k] = b[k];
  if (typeof out.enabled === 'string') out.enabled = !['false', '0', 'no', 'off'].includes(out.enabled.toLowerCase());
  return out as Partial<MachineInput>;
}

function view(m: Machine) {
  return { ...m, labels_list: labelsOf(m), last_check: lastCheckOf(m) };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function registerMachineRoutes(app: FastifyInstance, db: Database.Database, opts: MachineRouteOptions = {}): void {
  const who = (req: FastifyRequest): string => {
    try {
      return identityOf(req).label;
    } catch (err) {
      if (err instanceof IdentityError) return 'unknown';
      throw err;
    }
  };
  const machineError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof MachineError) return reply.code(400).send({ error: err.message });
    throw err;
  };
  const nameOf = (req: FastifyRequest): string => (req.params as { name: string }).name;

  app.get('/api/machines', async () => ({ machines: listMachines(db).map(view), sandbox_hosts: describeExecHosts(db) }));

  app.get('/api/machines/:name', async (req, reply) => {
    const m = getMachine(db, nameOf(req));
    return m ? view(m) : reply.code(404).send({ error: '沒有這台機台' });
  });

  app.post('/api/machines', async (req, reply) => {
    const patch = patchOf(req.body);
    const name = str(patch.name);
    if (name && getMachine(db, name)) return reply.code(409).send({ error: `已經有這台機台：${name}` });
    try {
      const m = createMachine(db, { name, ssh_target: '', work_root: '', ...patch });
      logEvent(db, { kind: 'note', detail: `機台新增：${m.name}（${m.ssh_target}）by ${who(req)}` });
      return reply.code(201).send(view(m));
    } catch (err) {
      return machineError(reply, err);
    }
  });

  app.patch('/api/machines/:name', async (req, reply) => {
    try {
      const m = updateMachine(db, nameOf(req), patchOf(req.body));
      if (!m) return reply.code(404).send({ error: '沒有這台機台' });
      logEvent(db, { kind: 'note', detail: `機台修改：${m.name} by ${who(req)}` });
      return view(m);
    } catch (err) {
      return machineError(reply, err);
    }
  });

  app.delete('/api/machines/:name', async (req, reply) => {
    const name = nameOf(req);
    if (!deleteMachine(db, name)) return reply.code(404).send({ error: '沒有這台機台' });
    logEvent(db, { kind: 'note', detail: `機台刪除：${name} by ${who(req)}` });
    return { ok: true };
  });

  // Screen 5's list; what it found out (os / shell / transport) fills in a row that still says auto
  app.post('/api/machines/:name/check', async (req, reply) => {
    const m = getMachine(db, nameOf(req));
    if (!m) return reply.code(404).send({ error: '沒有這台機台' });
    const b = (req.body ?? {}) as { repos?: unknown; datasets?: unknown };
    const repos = Array.isArray(b.repos)
      ? b.repos
          .map((r) => {
            const o = (r ?? {}) as Record<string, unknown>;
            return { name: str(o.name), remoteUrl: str(o.remote_url) || str(o.remoteUrl) };
          })
          .filter((r) => r.name && r.remoteUrl)
      : reposUsingMachine(db, m.name);
    const datasets = Array.isArray(b.datasets)
      ? b.datasets.map((d) => ({ name: str((d as Record<string, unknown> | null)?.name) })).filter((d) => d.name)
      : datasetsUsingMachine(db, m.name);
    const result = await withMachineLock(m.name, () => checkMachine(m, opts.hostExec ?? realHostExec, { repos, datasets }));
    const saved = recordCheck(db, m.name, result.lines, result.ok, result.detected);
    const broken = result.lines.filter((l) => l.ok === false).map((l) => l.label);
    logEvent(db, { kind: 'note', detail: `機台檢查：${m.name} ${result.ok ? '正常' : `有問題（${broken.join('、')}）`} by ${who(req)}` });
    return { ...result, machine: saved ? view(saved) : null };
  });
}
