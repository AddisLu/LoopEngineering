import { execFile } from 'node:child_process';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';

/**
 * GPU 執行沙盒 on other machines. A host is a Linux box with Docker + the NVIDIA Container Toolkit
 * that the engine reaches over SSH (key auth, BatchMode). Before each run the local workspace is
 * rsync'ed to <work_root>/<key> on that box, then the container is started there with
 * `docker -H ssh://…` — the same isolation policy as the local sandbox (src/exec/sandbox.ts), plus
 * the host's read-only data mounts (e.g. the AOI image library, which never leaves that machine).
 */

export const LOCAL_HOST = 'local';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** remote paths go into --rsync-path and --mount unquoted: keep them boring */
const REMOTE_PATH_RE = /^\/[A-Za-z0-9_./-]*$/;

export class ExecHostError extends Error {}

export interface ExecHost {
  name: string;
  ssh_target: string;
  ssh_port: number | null;
  work_root: string;
  image: string | null;
  gpus: string | null;
  memory: string | null;
  cpus: string | null;
  data_mounts: string;
  description: string | null;
  remote_uid: number | null;
  remote_gid: number | null;
  enabled: number;
  created_at: string;
}

export interface DataMount {
  source: string;
  target: string;
}

/** "/nas/aoi:/datasets,/nas/golden:/golden" → mounts (always read-only). Throws on anything odd. */
export function parseDataMounts(csv: string | null | undefined): DataMount[] {
  const out: DataMount[] = [];
  for (const raw of (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = raw.lastIndexOf(':');
    const source = i > 0 ? raw.slice(0, i) : raw;
    const target = i > 0 ? raw.slice(i + 1) : `/data/${path.posix.basename(raw)}`;
    for (const p of [source, target]) {
      if (!REMOTE_PATH_RE.test(p) || p.includes('..')) throw new ExecHostError(`資料掛載路徑不合法：${p}（只能是絕對路徑，字元限英數與 _ . / -）`);
    }
    if (target === '/work' || target.startsWith('/work/')) throw new ExecHostError(`資料不能掛到 /work：${raw}`);
    out.push({ source, target });
  }
  return out;
}

export interface UpsertExecHostInput {
  name: string;
  ssh_target: string;
  ssh_port?: number | null;
  work_root: string;
  image?: string | null;
  gpus?: string | null;
  memory?: string | null;
  cpus?: string | null;
  data_mounts?: string;
  description?: string | null;
  enabled?: boolean;
}

export function validateExecHost(input: UpsertExecHostInput): void {
  if (!NAME_RE.test(input.name) || input.name === LOCAL_HOST) throw new ExecHostError(`主機名稱只能用小寫英數、_、-（且不能叫 ${LOCAL_HOST}）：${input.name}`);
  if (!/^[A-Za-z0-9_.@-]+$/.test(input.ssh_target)) throw new ExecHostError(`ssh 目標不合法：${input.ssh_target}（例：loop@aoi-gpu）`);
  if (input.ssh_port != null && (!Number.isInteger(input.ssh_port) || input.ssh_port < 1 || input.ssh_port > 65535)) throw new ExecHostError('ssh port 不合法');
  if (!REMOTE_PATH_RE.test(input.work_root) || input.work_root === '/' || input.work_root.includes('..')) {
    throw new ExecHostError(`work_root 不合法：${input.work_root}（遠端的絕對路徑，例如 /srv/loop-exec）`);
  }
  parseDataMounts(input.data_mounts ?? '');
}

export function upsertExecHost(db: Database.Database, input: UpsertExecHostInput): ExecHost {
  validateExecHost(input);
  const prev = getExecHost(db, input.name);
  const row = {
    name: input.name,
    ssh_target: input.ssh_target,
    ssh_port: input.ssh_port ?? null,
    work_root: input.work_root.replace(/\/+$/, ''),
    image: input.image ?? null,
    gpus: input.gpus ?? null,
    memory: input.memory ?? null,
    cpus: input.cpus ?? null,
    data_mounts: input.data_mounts ?? '',
    description: input.description ?? null,
    enabled: input.enabled === false ? 0 : 1,
    // a different machine means different ids: learn them again on the next check/run
    keep_ids: prev && prev.ssh_target === input.ssh_target && prev.ssh_port === (input.ssh_port ?? null) ? 1 : 0,
  };
  db.prepare(
    `INSERT INTO exec_hosts (name, ssh_target, ssh_port, work_root, image, gpus, memory, cpus, data_mounts, description, enabled)
     VALUES (@name, @ssh_target, @ssh_port, @work_root, @image, @gpus, @memory, @cpus, @data_mounts, @description, @enabled)
     ON CONFLICT(name) DO UPDATE SET
       ssh_target = excluded.ssh_target, ssh_port = excluded.ssh_port, work_root = excluded.work_root,
       image = excluded.image, gpus = excluded.gpus, memory = excluded.memory, cpus = excluded.cpus,
       data_mounts = excluded.data_mounts, description = excluded.description, enabled = excluded.enabled,
       remote_uid = CASE WHEN @keep_ids = 1 THEN remote_uid ELSE NULL END,
       remote_gid = CASE WHEN @keep_ids = 1 THEN remote_gid ELSE NULL END`,
  ).run(row);
  return getExecHost(db, input.name)!;
}

export function getExecHost(db: Database.Database, name: string): ExecHost | undefined {
  return db.prepare('SELECT * FROM exec_hosts WHERE name = ?').get(name) as ExecHost | undefined;
}

export function listExecHosts(db: Database.Database): ExecHost[] {
  return db.prepare('SELECT * FROM exec_hosts ORDER BY name').all() as ExecHost[];
}

export function deleteExecHost(db: Database.Database, name: string): boolean {
  return db.prepare('DELETE FROM exec_hosts WHERE name = ?').run(name).changes > 0;
}

export function setHostIds(db: Database.Database, name: string, uid: number, gid: number): void {
  db.prepare('UPDATE exec_hosts SET remote_uid = ?, remote_gid = ? WHERE name = ?').run(uid, gid, name);
}

/** Where a run goes: this machine, or one of the registered hosts. */
export type ExecTarget = { kind: 'local' } | { kind: 'remote'; host: ExecHost };

/**
 * Resolve a host name the model/agent/verify step asked for. Empty → exec_default_host (empty or
 * 'local' = this machine). Unknown or disabled hosts are an error the caller shows as-is.
 */
export function resolveExecTarget(db: Database.Database, name?: string | null): ExecTarget {
  const want = (name ?? '').trim() || (getSetting(db, 'exec_default_host') ?? '').trim();
  if (!want || want === LOCAL_HOST) return { kind: 'local' };
  const host = getExecHost(db, want);
  if (!host) throw new ExecHostError(`沒有這台沙盒主機：${want}（loop exec host list）`);
  if (!host.enabled) throw new ExecHostError(`沙盒主機 ${want} 已停用`);
  return { kind: 'remote', host };
}

/** Host names + what they are for, as offered to a model. Local first. */
export function describeExecHosts(db: Database.Database): Array<{ name: string; description: string; data: DataMount[]; default: boolean }> {
  const def = (getSetting(db, 'exec_default_host') ?? '').trim() || LOCAL_HOST;
  let localData: DataMount[] = [];
  try {
    localData = parseDataMounts(getSetting(db, 'exec_data_mounts') ?? '');
  } catch {
    /* a bad setting is reported by `loop exec check` */
  }
  const out = [{ name: LOCAL_HOST, description: '這台主機（Spark）', data: localData, default: def === LOCAL_HOST }];
  for (const h of listExecHosts(db)) {
    if (!h.enabled) continue;
    let data: DataMount[] = [];
    try {
      data = parseDataMounts(h.data_mounts);
    } catch {
      /* ditto */
    }
    out.push({ name: h.name, description: h.description || h.ssh_target, data, default: def === h.name });
  }
  return out;
}

// ---- ssh / rsync ---------------------------------------------------------------------------------

export type HostExec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string }>;

/** code null = the binary does not exist; any other failure is a non-zero code. */
export const realHostExec: HostExec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (!err) return resolve({ code: 0, out });
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT') return resolve({ code: null, out });
      resolve({ code: typeof code === 'number' ? code : 1, out: out || err.message });
    });
  });

/** ssh options every call uses: never prompt, fail fast. */
export function sshArgs(h: Pick<ExecHost, 'ssh_port'>): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', ...(h.ssh_port ? ['-p', String(h.ssh_port)] : [])];
}

/** `docker -H` value: docker runs the system ssh, so ~/.ssh/config aliases and keys apply. */
export function dockerHostUrl(h: Pick<ExecHost, 'ssh_target' | 'ssh_port'>): string {
  return `ssh://${h.ssh_target}${h.ssh_port ? `:${h.ssh_port}` : ''}`;
}

/** <work_root>/<key> on the remote box; the key names the workspace (task-…, chat-…, cli). */
export function remoteWorkdir(h: Pick<ExecHost, 'work_root'>, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_').slice(0, 100) || 'default';
  return path.posix.join(h.work_root, safe);
}

/**
 * Mirror the local workspace to the remote one. Files .gitignore'd (build outputs) are neither
 * sent nor deleted, so incremental builds survive between runs; everything else matches exactly.
 */
export async function syncToRemote(
  h: ExecHost,
  localDir: string,
  remoteDir: string,
  exec: HostExec = realHostExec,
  timeoutMs = 10 * 60_000,
): Promise<{ ok: boolean; out: string }> {
  const ssh = ['ssh', ...sshArgs(h)].join(' ');
  const r = await exec(
    'rsync',
    [
      '-a',
      '--delete',
      '--filter=:- .gitignore',
      '--exclude=.git',
      `--rsync-path=mkdir -p ${remoteDir} && rsync`,
      '-e',
      ssh,
      `${localDir.replace(/\/+$/, '')}/`,
      `${h.ssh_target}:${remoteDir}/`,
    ],
    timeoutMs,
  );
  if (r.code === null) return { ok: false, out: '找不到 rsync（Spark 上請安裝 rsync）' };
  return { ok: r.code === 0, out: r.out };
}

/** The remote account's uid/gid, so files the container writes stay the ssh user's to rsync over. */
export async function remoteIds(h: ExecHost, exec: HostExec = realHostExec): Promise<{ uid: number; gid: number } | null> {
  if (h.remote_uid != null && h.remote_gid != null) return { uid: h.remote_uid, gid: h.remote_gid };
  const r = await exec('ssh', [...sshArgs(h), h.ssh_target, 'id -u; id -g'], 20_000);
  const [uid, gid] = r.out.split('\n').map((s) => Number(s.trim()));
  return r.code === 0 && Number.isInteger(uid) && Number.isInteger(gid) ? { uid: uid!, gid: gid! } : null;
}
