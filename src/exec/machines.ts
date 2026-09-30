import type Database from 'better-sqlite3';
import type { CheckLine } from './check.js';

/**
 * 機台 registry: bare-shell Linux / Windows boxes the engine reaches over SSH (key login, no
 * password) to run a repo's checks — build, test, repro, 圖資回歸 (src/exec/remote.ts drives them).
 * Nothing but sshd, git and the repo's own toolchain has to be installed there. exec_hosts (the
 * Docker GPU 沙盒, src/exec/hosts.ts) is a separate registry and stays as it is.
 */

export const MACHINE_OS = ['auto', 'linux', 'windows'] as const;
export const MACHINE_SHELLS = ['auto', 'bash', 'powershell', 'cmd'] as const;
export const MACHINE_TRANSPORTS = ['auto', 'gitea', 'copy'] as const;
export type MachineOs = (typeof MACHINE_OS)[number];
export type MachineShell = (typeof MACHINE_SHELLS)[number];
export type MachineTransport = (typeof MACHINE_TRANSPORTS)[number];

/** A check's `machine` can never mean one of these: 'local' is the sandbox on this host, 'engine' the engine host itself. */
export const RESERVED_MACHINE_NAMES: readonly string[] = ['local', 'engine'];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** user@host or host (an ~/.ssh/config alias works too) — never anything ssh could read as an option */
const SSH_TARGET_RE = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LABEL_RE = /^[a-z0-9._-]+$/;
/** work roots go into shell commands on the box, sometimes unquoted: keep them boring (no spaces, no quotes) */
const LINUX_ROOT_RE = /^\/[A-Za-z0-9_./-]*$/;
const WINDOWS_ROOT_RE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]*$/;
const MAX_LABELS = 20;
const MAX_DESCRIPTION = 2000;

export class MachineError extends Error {}

/** One row of `machines` (src/db/schema.sql). */
export interface Machine {
  name: string;
  ssh_target: string;
  ssh_port: number | null;
  /** 'auto' until the health check has seen the box */
  os: MachineOs;
  /** the syntax check commands on this box are written in; 'auto' = bash on Linux, PowerShell on Windows */
  shell: MachineShell;
  /** /srv/loop or C:\loop — repos/<name> and datasets/<name> live under it */
  work_root: string;
  /** CSV: cuda, aoi-v3, camera, gpu */
  labels: string;
  description: string | null;
  /** how the box gets the code: gitea = it fetches the branch itself, copy = the engine sends the tree; 'auto' = decided by the health check */
  transport: MachineTransport;
  enabled: number;
  last_check_json: string | null;
  last_check_at: string | null;
  last_check_ok: number | null;
  created_at: string;
  updated_at: string;
}

/** What a caller (API body, CLI flags) may say; everything but name/ssh_target/work_root is optional. */
export interface MachineInput {
  name: string;
  ssh_target: string;
  ssh_port?: number | string | null;
  os?: string | null;
  shell?: string | null;
  work_root: string;
  labels?: string | string[] | null;
  description?: string | null;
  transport?: string | null;
  enabled?: boolean | number | null;
}

export type MachineFields = Pick<Machine, 'name' | 'ssh_target' | 'ssh_port' | 'os' | 'shell' | 'work_root' | 'labels' | 'description' | 'transport' | 'enabled'>;

/** Is `root` an absolute path for that OS? 'auto' accepts either form. */
export function isWorkRootFor(os: MachineOs, root: string): boolean {
  if (os === 'linux') return LINUX_ROOT_RE.test(root) && root !== '/' && !root.includes('..');
  if (os === 'windows') return WINDOWS_ROOT_RE.test(root) && !/^[A-Za-z]:\\$/.test(root) && !root.includes('..');
  return isWorkRootFor('linux', root) || isWorkRootFor('windows', root);
}

/** `C:/loop//` → `C:\loop`, `/srv/loop/` → `/srv/loop`. */
function normalizeRoot(raw: string): string {
  const s = raw.trim();
  if (/^[A-Za-z]:/.test(s)) {
    let r = s.replace(/\//g, '\\').replace(/\\+/g, '\\');
    if (r.length > 3) r = r.replace(/\\+$/, '');
    return r;
  }
  let r = s.replace(/\/+/g, '/');
  if (r.length > 1) r = r.replace(/\/+$/, '');
  return r;
}

/** "cuda, AOI-v3,,gpu" or ['cuda', 'gpu'] → 'cuda,aoi-v3,gpu' (validated, lower-cased, de-duplicated). */
export function normalizeLabels(raw: string | string[] | null | undefined): string {
  const parts = (Array.isArray(raw) ? raw : (raw ?? '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (!LABEL_RE.test(p) || p.length > 40) throw new MachineError(`標籤只能用小寫英數、.、_、-：${p}`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_LABELS) throw new MachineError(`標籤最多 ${MAX_LABELS} 個`);
  return out.join(',');
}

export function labelsOf(m: Pick<Machine, 'labels'>): string[] {
  return m.labels.split(',').map((s) => s.trim()).filter(Boolean);
}

function enumOf<T extends readonly string[]>(what: string, allowed: T, raw: unknown, fallback: T[number]): T[number] {
  if (raw == null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(v)) throw new MachineError(`${what} 只能是 ${allowed.join('、')}：${String(raw)}`);
  return v as T[number];
}

/** Validate + canonicalise a caller's input into row values. Throws MachineError with the reason a person can act on. */
export function normalizeMachine(input: MachineInput): MachineFields {
  const name = String(input.name ?? '').trim();
  if (!NAME_RE.test(name) || RESERVED_MACHINE_NAMES.includes(name)) {
    throw new MachineError(`機台名稱只能用小寫英數、_、-，最多 40 字，且不能叫 ${RESERVED_MACHINE_NAMES.join(' / ')}：${name || '（空白）'}`);
  }
  const ssh_target = String(input.ssh_target ?? '').trim();
  if (!SSH_TARGET_RE.test(ssh_target)) throw new MachineError(`SSH 目標不合法：${ssh_target || '（空白）'}（例：aoi@aoi-1 或 aoi-1）`);
  let ssh_port: number | null = null;
  if (input.ssh_port != null && input.ssh_port !== '') {
    const n = typeof input.ssh_port === 'number' ? input.ssh_port : Number(String(input.ssh_port).trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new MachineError(`SSH 埠不合法：${String(input.ssh_port)}（1–65535）`);
    ssh_port = n;
  }
  const os = enumOf('作業系統', MACHINE_OS, input.os, 'auto');
  const shell = enumOf('shell', MACHINE_SHELLS, input.shell, 'auto');
  if (os === 'linux' && (shell === 'powershell' || shell === 'cmd')) throw new MachineError(`Linux 機台的 shell 只能是 auto 或 bash：${shell}`);
  if (os === 'windows' && shell === 'bash') throw new MachineError('Windows 機台的 shell 只能是 auto、powershell 或 cmd');
  const work_root = normalizeRoot(String(input.work_root ?? ''));
  if (!isWorkRootFor(os, work_root)) {
    const hint = os === 'windows' ? 'C:\\loop' : os === 'linux' ? '/srv/loop' : '/srv/loop 或 C:\\loop';
    throw new MachineError(`工作目錄要是${os === 'windows' ? ' Windows' : os === 'linux' ? ' Linux' : ''}的絕對路徑（例：${hint}；只能用英數、_、.、-）：${work_root || '（空白）'}`);
  }
  const labels = normalizeLabels(input.labels);
  const description = input.description == null ? null : String(input.description).trim() || null;
  if (description && description.length > MAX_DESCRIPTION) throw new MachineError(`說明太長（上限 ${MAX_DESCRIPTION} 字）`);
  const transport = enumOf('transport', MACHINE_TRANSPORTS, input.transport, 'auto');
  const enabled = input.enabled === false || input.enabled === 0 ? 0 : 1;
  return { name, ssh_target, ssh_port, os, shell, work_root, labels, description, transport, enabled };
}

const COLS = 'name, ssh_target, ssh_port, os, shell, work_root, labels, description, transport, enabled';

export function createMachine(db: Database.Database, input: MachineInput): Machine {
  const f = normalizeMachine(input);
  if (getMachine(db, f.name)) throw new MachineError(`已經有這台機台：${f.name}`);
  db.prepare(`INSERT INTO machines (${COLS}) VALUES (@name, @ssh_target, @ssh_port, @os, @shell, @work_root, @labels, @description, @transport, @enabled)`).run(f);
  return getMachine(db, f.name)!;
}

export function getMachine(db: Database.Database, name: string): Machine | undefined {
  return db.prepare('SELECT * FROM machines WHERE name = ?').get(name) as Machine | undefined;
}

export function listMachines(db: Database.Database, opts: { enabledOnly?: boolean } = {}): Machine[] {
  return db.prepare(`SELECT * FROM machines${opts.enabledOnly ? ' WHERE enabled = 1' : ''} ORDER BY name`).all() as Machine[];
}

/**
 * Change some fields; the rest keep their values and the whole row is validated again. A machine
 * is never renamed (checks refer to it by name) — undefined when there is no such machine.
 */
export function updateMachine(db: Database.Database, name: string, patch: Partial<MachineInput>): Machine | undefined {
  const prev = getMachine(db, name);
  if (!prev) return undefined;
  if (patch.name != null && String(patch.name).trim() !== prev.name) throw new MachineError('機台不能改名：刪掉再加一台');
  const f = normalizeMachine({
    name: prev.name,
    ssh_target: patch.ssh_target ?? prev.ssh_target,
    ssh_port: patch.ssh_port === undefined ? prev.ssh_port : patch.ssh_port,
    os: patch.os ?? prev.os,
    shell: patch.shell ?? prev.shell,
    work_root: patch.work_root ?? prev.work_root,
    labels: patch.labels ?? prev.labels,
    description: patch.description === undefined ? prev.description : patch.description,
    transport: patch.transport ?? prev.transport,
    enabled: patch.enabled === undefined || patch.enabled === null ? prev.enabled : patch.enabled,
  });
  db.prepare(
    `UPDATE machines SET ssh_target = @ssh_target, ssh_port = @ssh_port, os = @os, shell = @shell, work_root = @work_root,
       labels = @labels, description = @description, transport = @transport, enabled = @enabled, updated_at = datetime('now')
     WHERE name = @name`,
  ).run(f);
  return getMachine(db, name);
}

export function deleteMachine(db: Database.Database, name: string): boolean {
  return db.prepare('DELETE FROM machines WHERE name = ?').run(name).changes > 0;
}

/** What the health check found out beyond pass/fail; only ever fills a column that still says 'auto'. */
export interface DetectedMachine {
  os?: MachineOs | null;
  shell?: MachineShell | null;
  transport?: MachineTransport | null;
}

/** Store a health check's result (Screen 5's list) and, where the row says 'auto', what it detected. */
export function recordCheck(db: Database.Database, name: string, lines: CheckLine[], ok: boolean, detected: DetectedMachine = {}): Machine | undefined {
  const pick = <T extends string>(allowed: readonly T[], v: T | null | undefined): T | null => (v && v !== 'auto' && allowed.includes(v) ? v : null);
  db.prepare(
    `UPDATE machines SET
       last_check_json = @json, last_check_at = datetime('now'), last_check_ok = @ok,
       os = CASE WHEN os = 'auto' AND @os IS NOT NULL THEN @os ELSE os END,
       shell = CASE WHEN shell = 'auto' AND @shell IS NOT NULL THEN @shell ELSE shell END,
       transport = CASE WHEN transport = 'auto' AND @transport IS NOT NULL THEN @transport ELSE transport END,
       updated_at = datetime('now')
     WHERE name = @name`,
  ).run({
    name,
    json: JSON.stringify(lines),
    ok: ok ? 1 : 0,
    os: pick(MACHINE_OS, detected.os),
    shell: pick(MACHINE_SHELLS, detected.shell),
    transport: pick(MACHINE_TRANSPORTS, detected.transport),
  });
  return getMachine(db, name);
}

/** Repos whose checks run on this machine (repos.machine), for the health check's Gitea and clone probes. */
export function reposUsingMachine(db: Database.Database, name: string): Array<{ name: string; remoteUrl: string }> {
  try {
    const rows = db.prepare('SELECT name, remote_url FROM repos WHERE machine = ? AND enabled = 1 ORDER BY name').all(name) as Array<{ name: string; remote_url: string }>;
    return rows.map((r) => ({ name: r.name, remoteUrl: r.remote_url }));
  } catch {
    return [];
  }
}

/** 圖資 a dataset check on this machine needs cached there. */
export function datasetsUsingMachine(db: Database.Database, name: string): Array<{ name: string }> {
  try {
    return db
      .prepare('SELECT DISTINCT d.name AS name FROM datasets d JOIN checks c ON c.dataset_id = d.id WHERE c.machine = ? AND c.enabled = 1 ORDER BY d.name')
      .all(name) as Array<{ name: string }>;
  } catch {
    return [];
  }
}

/** The stored check lines, or null when the machine was never checked (or the JSON is unreadable). */
export function lastCheckOf(m: Pick<Machine, 'last_check_json'>): CheckLine[] | null {
  if (!m.last_check_json) return null;
  try {
    const v = JSON.parse(m.last_check_json) as unknown;
    return Array.isArray(v) ? (v as CheckLine[]) : null;
  } catch {
    return null;
  }
}
