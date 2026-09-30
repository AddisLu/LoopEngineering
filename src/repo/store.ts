import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { BENCH_DOMAINS } from '../benchmark/store.js';
import { validBranch } from '../git/refs.js';

/**
 * Repo registry (schema.sql `repos`): the software 問題單 / 檢查 / 地圖 hang off, one row per
 * imported clone under git_clone_root. The row remembers what import detected (default branch,
 * build / test / setup commands, the language stack) and what an engineer set on the Repo page.
 * Import lives in import.ts; this file is the rows only.
 */

export interface Repo {
  id: string;
  name: string;
  /** as pasted; credentials are never stored */
  remote_url: string;
  gitea_owner: string | null;
  gitea_repo: string | null;
  local_path: string;
  default_branch: string;
  /** NULL = default_branch */
  pr_base: string | null;
  /** machines.name; NULL = the engine host */
  machine: string | null;
  /** JSON RepoStack */
  stack_json: string | null;
  build_cmd: string | null;
  test_cmd: string | null;
  setup_cmd: string | null;
  domain: string;
  /** Gitea label that auto-opens tickets; NULL = off */
  issue_label: string | null;
  issue_comments: number;
  map_path: string | null;
  map_sha: string | null;
  map_at: string | null;
  /** knowledge sources.id when auto-ingested */
  source_id: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** stack_json, parsed (import.ts detectStack) */
export interface RepoStack {
  /** language share of the tracked code files, 0–1, largest first */
  languages: Record<string, number>;
  /** top-level directories with tracked files */
  dirs: string[];
  /** package.json, CMakeLists.txt, *.csproj, *.sln, pyproject.toml, … */
  entry_points: string[];
  /** tracked files counted */
  files: number;
}

export class RepoError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface NewRepoInput {
  name: string;
  remote_url: string;
  local_path: string;
  gitea_owner?: string | null;
  gitea_repo?: string | null;
  default_branch?: string | null;
  pr_base?: string | null;
  machine?: string | null;
  stack_json?: RepoStack | string | null;
  build_cmd?: string | null;
  test_cmd?: string | null;
  setup_cmd?: string | null;
  domain?: string | null;
  issue_label?: string | null;
  issue_comments?: boolean | number | null;
  source_id?: string | null;
  enabled?: boolean | number | null;
  created_by?: string | null;
}

/** What the Repo page (PATCH) and redetect may change; anything else on the row is fixed at import. */
export interface RepoPatch {
  name?: string;
  default_branch?: string;
  pr_base?: string | null;
  machine?: string | null;
  build_cmd?: string | null;
  test_cmd?: string | null;
  setup_cmd?: string | null;
  domain?: string;
  issue_label?: string | null;
  issue_comments?: boolean | number;
  enabled?: boolean | number;
  stack_json?: RepoStack | string | null;
  map_path?: string | null;
  map_sha?: string | null;
  map_at?: string | null;
  source_id?: string | null;
}

const EDITABLE = [
  'name', 'default_branch', 'pr_base', 'machine', 'build_cmd', 'test_cmd', 'setup_cmd', 'domain', 'issue_label', 'issue_comments',
  'enabled', 'stack_json', 'map_path', 'map_sha', 'map_at', 'source_id',
] as const satisfies ReadonlyArray<keyof RepoPatch>;

/** A folder name under git_clone_root: ASCII word characters, dots and dashes, no leading dot or dash. */
export const REPO_NAME_RE = /^(?![.-])[\w.-]{1,60}$/;
export const validRepoName = (name: string): boolean => REPO_NAME_RE.test(name) && !/^\.+$/.test(name);
const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const realpathOrSelf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const text = (v: unknown, what: string, max: number, o: { required?: boolean; oneLine?: boolean } = {}): string | null => {
  if (v === null || v === undefined) {
    if (o.required) throw new RepoError(`${what}不能是空的`);
    return null;
  }
  if (typeof v !== 'string') throw new RepoError(`${what}要是文字`);
  const s = v.trim();
  if (!s) {
    if (o.required) throw new RepoError(`${what}不能是空的`);
    return null;
  }
  if (s.length > max) throw new RepoError(`${what}太長（最多 ${max} 字）`);
  if (o.oneLine && /[\r\n]/.test(s)) throw new RepoError(`${what}只能一行`);
  return s;
};
const flag = (v: unknown, what: string): number => {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === null || v === undefined) return 0;
  throw new RepoError(`${what}要是 true 或 false`);
};
const branchOf = (v: unknown, what: string, required: boolean): string | null => {
  const s = text(v, what, 200, { required, oneLine: true });
  if (s !== null && !validBranch(s)) throw new RepoError(`「${s}」不是可以用的分支名稱`);
  return s;
};
const domainOf = (v: unknown): string => {
  const s = text(v, '領域', 40, { oneLine: true }) ?? 'other';
  if (!(BENCH_DOMAINS as readonly string[]).includes(s)) throw new RepoError(`領域只能是：${BENCH_DOMAINS.join('、')}`);
  return s;
};
const stackOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return JSON.stringify(parsed);
    } catch {
      throw new RepoError('stack_json 要是 JSON 物件');
    }
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new RepoError('stack_json 要是 JSON 物件');
  return JSON.stringify(v);
};
function machineOf(db: Database.Database, v: unknown): string | null {
  const s = text(v, '機台', 40, { oneLine: true });
  if (s === null || s === 'local' || s === 'engine') return null;
  if (!MACHINE_NAME_RE.test(s)) throw new RepoError(`「${s}」不是可以用的機台名稱`);
  if (!db.prepare('SELECT 1 FROM machines WHERE name = ?').get(s)) throw new RepoError(`沒有這台機台：${s}`);
  return s;
}
/** a display name: anything one line, no path separators */
const displayName = (v: unknown): string => {
  const s = text(v, '名稱', 60, { required: true, oneLine: true })!;
  if (/[/\\]/.test(s) || /[\u0000-\u001f]/.test(s)) throw new RepoError('名稱不能有斜線或控制字元');
  return s;
};

export function createRepo(db: Database.Database, input: NewRepoInput): Repo {
  const id = `r_${nanoid(10)}`;
  const row = {
    id,
    name: displayName(input.name),
    remote_url: text(input.remote_url, '網址', 500, { required: true, oneLine: true })!,
    gitea_owner: text(input.gitea_owner, 'gitea_owner', 100, { oneLine: true }),
    gitea_repo: text(input.gitea_repo, 'gitea_repo', 100, { oneLine: true }),
    local_path: text(input.local_path, '路徑', 1000, { required: true, oneLine: true })!,
    default_branch: branchOf(input.default_branch ?? 'main', '預設分支', true)!,
    pr_base: branchOf(input.pr_base, 'PR 目標分支', false),
    machine: machineOf(db, input.machine),
    stack_json: stackOf(input.stack_json),
    build_cmd: text(input.build_cmd, '建置指令', 4000),
    test_cmd: text(input.test_cmd, '測試指令', 4000),
    setup_cmd: text(input.setup_cmd, '環境準備指令', 4000),
    domain: domainOf(input.domain),
    issue_label: text(input.issue_label, 'issue 標籤', 100, { oneLine: true }),
    issue_comments: input.issue_comments === undefined || input.issue_comments === null ? 1 : flag(input.issue_comments, 'issue_comments'),
    source_id: text(input.source_id, 'source_id', 100, { oneLine: true }),
    enabled: input.enabled === undefined || input.enabled === null ? 1 : flag(input.enabled, 'enabled'),
    created_by: text(input.created_by, 'created_by', 200, { oneLine: true }),
  };
  if (!path.isAbsolute(row.local_path)) throw new RepoError('路徑要是絕對路徑');
  const dup = getRepoByPath(db, row.local_path);
  if (dup) throw new RepoError(`這個路徑已經匯入過了：${dup.name}（${dup.id}）`, 409);
  db.prepare(
    `INSERT INTO repos (id, name, remote_url, gitea_owner, gitea_repo, local_path, default_branch, pr_base, machine, stack_json,
       build_cmd, test_cmd, setup_cmd, domain, issue_label, issue_comments, source_id, enabled, created_by)
     VALUES (@id, @name, @remote_url, @gitea_owner, @gitea_repo, @local_path, @default_branch, @pr_base, @machine, @stack_json,
       @build_cmd, @test_cmd, @setup_cmd, @domain, @issue_label, @issue_comments, @source_id, @enabled, @created_by)`,
  ).run(row);
  return getRepo(db, id)!;
}

export function getRepo(db: Database.Database, id: string): Repo | null {
  return (db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as Repo | undefined) ?? null;
}

/** The repo registered at `localPath`, symlinks and trailing slashes resolved on both sides. */
export function getRepoByPath(db: Database.Database, localPath: string): Repo | null {
  if (!localPath) return null;
  const target = realpathOrSelf(localPath);
  for (const r of listRepos(db)) {
    if (r.local_path === localPath || realpathOrSelf(r.local_path) === target) return r;
  }
  return null;
}

export function listRepos(db: Database.Database): Repo[] {
  return db.prepare('SELECT * FROM repos ORDER BY name COLLATE NOCASE, created_at').all() as Repo[];
}

/**
 * Change the editable columns (name, branches, machine, commands, domain, issue settings,
 * enabled, stack / map / source bookkeeping). Unknown keys are ignored; a bad value throws
 * RepoError (400); null = no such repo.
 */
export function updateRepo(db: Database.Database, id: string, patch: RepoPatch): Repo | null {
  const cur = getRepo(db, id);
  if (!cur) return null;
  const p = patch as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (!(key in p)) continue;
    const v = p[key];
    switch (key) {
      case 'name':
        next.name = displayName(v);
        break;
      case 'default_branch':
        next.default_branch = branchOf(v, '預設分支', true);
        break;
      case 'pr_base':
        next.pr_base = branchOf(v, 'PR 目標分支', false);
        break;
      case 'machine':
        next.machine = machineOf(db, v);
        break;
      case 'build_cmd':
        next.build_cmd = text(v, '建置指令', 4000);
        break;
      case 'test_cmd':
        next.test_cmd = text(v, '測試指令', 4000);
        break;
      case 'setup_cmd':
        next.setup_cmd = text(v, '環境準備指令', 4000);
        break;
      case 'domain':
        next.domain = domainOf(v);
        break;
      case 'issue_label':
        next.issue_label = text(v, 'issue 標籤', 100, { oneLine: true });
        break;
      case 'issue_comments':
        next.issue_comments = flag(v, 'issue_comments');
        break;
      case 'enabled':
        next.enabled = flag(v, 'enabled');
        break;
      case 'stack_json':
        next.stack_json = stackOf(v);
        break;
      case 'map_path':
        next.map_path = text(v, 'map_path', 1000, { oneLine: true });
        break;
      case 'map_sha':
        next.map_sha = text(v, 'map_sha', 64, { oneLine: true });
        break;
      case 'map_at':
        next.map_at = text(v, 'map_at', 40, { oneLine: true });
        break;
      case 'source_id':
        next.source_id = text(v, 'source_id', 100, { oneLine: true });
        break;
    }
  }
  const keys = Object.keys(next);
  if (!keys.length) return cur;
  db.prepare(`UPDATE repos SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...next, id });
  return getRepo(db, id);
}

/** Removes the row only — the clone on disk and the allowlist entry are the caller's (import.ts removeRepo). */
export function deleteRepo(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM repos WHERE id = ?').run(id).changes > 0;
}

/** stack_json parsed, or null when absent / unreadable */
export function parseStack(repo: Pick<Repo, 'stack_json'>): RepoStack | null {
  if (!repo.stack_json) return null;
  try {
    const s = JSON.parse(repo.stack_json) as Partial<RepoStack>;
    return {
      languages: s.languages && typeof s.languages === 'object' ? s.languages : {},
      dirs: Array.isArray(s.dirs) ? s.dirs.map(String) : [],
      entry_points: Array.isArray(s.entry_points) ? s.entry_points.map(String) : [],
      files: typeof s.files === 'number' ? s.files : 0,
    };
  } catch {
    return null;
  }
}
