import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getSetting } from '../db/index.js';
import { parseAcceptance, formatSpecs } from '../orchestrator/acceptance.js';
import { BENCH_DOMAINS } from '../benchmark/store.js';
import { getExecHost, LOCAL_HOST, parseDataMounts, realHostExec, sshArgs, type DataMount, type HostExec } from '../exec/hosts.js';

/**
 * 驗證方案: how a change to one piece of software is proven good, written once by an engineer and
 * picked by an operator on the 新工作 page. The plan says where (host), what runs (steps, with
 * {dataset} standing for the image folder the operator picks), what "good" means (metrics), what
 * the implementer may not touch (protected_paths) and what is collected afterwards (artifacts).
 */

export interface VerifyPlan {
  id: string;
  name: string;
  repo_path: string | null;
  description: string | null;
  host: string | null;
  steps: string[];
  dataset_root: string | null;
  dataset_default: string | null;
  metrics: string | null;
  protected_paths: string[];
  artifacts: string[];
  manual_checks: string[];
  domain: string;
  setup_cmd: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Row extends Omit<VerifyPlan, 'steps' | 'protected_paths' | 'artifacts' | 'manual_checks'> {
  steps: string;
  protected_paths: string | null;
  artifacts: string | null;
  manual_checks: string;
}

export interface PlanInput {
  name: string;
  repo_path?: string | null;
  description?: string | null;
  host?: string | null;
  steps: string[];
  dataset_root?: string | null;
  dataset_default?: string | null;
  metrics?: string | null;
  protected_paths?: string[] | string | null;
  artifacts?: string[] | string | null;
  manual_checks?: string[] | null;
  domain?: string | null;
  setup_cmd?: string | null;
}

export class PlanError extends Error {}

const SANDBOX_PREFIX = /^sandbox(?:@[a-z0-9][a-z0-9_-]*)?\s*:/i;
const DATASET_NAME = /^[\w.-][\w .-]{0,119}$/;

const csv = (v: string[] | string | null | undefined): string[] =>
  (Array.isArray(v) ? v : (v ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);

const lines = (v: string[] | null | undefined): string[] => (v ?? []).map((s) => String(s).trim()).filter(Boolean);

/** Repo-relative globs only: the implementer's tree, never the machine's. */
function checkGlobs(label: string, globs: string[]): void {
  const bad = globs.filter((g) => g.startsWith('/') || g.split('/').includes('..') || /[\\\0]/.test(g));
  if (bad.length) throw new PlanError(`${label}要寫 repo 裡的相對路徑或 glob（例如 scripts/eval/**）：${bad.join('、')}`);
}

function normalize(input: PlanInput): Omit<Row, 'id' | 'created_by' | 'updated_by' | 'created_at' | 'updated_at'> {
  const name = (input.name ?? '').trim();
  if (!name) throw new PlanError('方案名稱不能空白');
  if (name.length > 60) throw new PlanError('方案名稱最多 60 字');
  const repo = (input.repo_path ?? '').trim() || null;
  if (repo && !path.isAbsolute(repo)) throw new PlanError('適用軟體要寫 repo 的絕對路徑');
  const host = (input.host ?? '').trim() || null;
  if (host && host !== LOCAL_HOST && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(host)) throw new PlanError(`驗證機台名稱不對：${host}`);
  const steps = lines(input.steps);
  if (!steps.length) throw new PlanError('至少要有一個驗證步驟');
  if (steps.some((s) => s.length > 2000)) throw new PlanError('驗證步驟太長（單行最多 2000 字）');
  if (host && steps.some((s) => SANDBOX_PREFIX.test(s))) throw new PlanError('方案已指定機台，步驟不用再寫 sandbox: 前綴');
  const root = (input.dataset_root ?? '').trim().replace(/\/+$/, '') || null;
  if (root && (!root.startsWith('/') || root.split('/').includes('..'))) throw new PlanError('圖資位置要寫容器裡的絕對路徑，例如 /datasets');
  if (!root && steps.some((s) => s.includes('{dataset}'))) throw new PlanError('步驟用了 {dataset}，要設定圖資位置');
  const def = (input.dataset_default ?? '').trim() || null;
  if (def && !DATASET_NAME.test(def)) throw new PlanError(`預設圖資名稱不對：${def}`);
  let metrics: string | null = null;
  if ((input.metrics ?? '').trim()) {
    try {
      const specs = parseAcceptance(input.metrics);
      metrics = specs.length ? formatSpecs(specs) : null;
    } catch (err) {
      throw new PlanError(`驗收門檻：${(err as Error).message}`);
    }
  }
  const prot = csv(input.protected_paths);
  checkGlobs('保護路徑', prot);
  const arts = csv(input.artifacts);
  checkGlobs('產出物', arts);
  const domain = (input.domain ?? 'other').trim() || 'other';
  if (!(BENCH_DOMAINS as readonly string[]).includes(domain)) throw new PlanError(`領域只能是 ${BENCH_DOMAINS.join(' / ')}`);
  return {
    name,
    repo_path: repo,
    description: (input.description ?? '').trim() || null,
    host,
    steps: JSON.stringify(steps),
    dataset_root: root,
    dataset_default: def,
    metrics,
    protected_paths: prot.length ? prot.join(',') : null,
    artifacts: arts.length ? arts.join(',') : null,
    manual_checks: JSON.stringify(lines(input.manual_checks)),
    domain,
    setup_cmd: (input.setup_cmd ?? '').trim() || null,
  };
}

function fromRow(r: Row): VerifyPlan {
  const arr = (s: string | null): string[] => {
    try {
      const v = JSON.parse(s ?? '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };
  return { ...r, steps: arr(r.steps), protected_paths: csv(r.protected_paths), artifacts: csv(r.artifacts), manual_checks: arr(r.manual_checks) };
}

export function createPlan(db: Database.Database, input: PlanInput, by: string | null = null): VerifyPlan {
  const row = normalize(input);
  const id = `vp_${nanoid(8)}`;
  db.prepare(
    `INSERT INTO verify_plans (id, name, repo_path, description, host, steps, dataset_root, dataset_default, metrics,
       protected_paths, artifacts, manual_checks, domain, setup_cmd, created_by, updated_by)
     VALUES (@id, @name, @repo_path, @description, @host, @steps, @dataset_root, @dataset_default, @metrics,
       @protected_paths, @artifacts, @manual_checks, @domain, @setup_cmd, @by, @by)`,
  ).run({ ...row, id, by });
  return getPlan(db, id)!;
}

export function updatePlan(db: Database.Database, id: string, input: PlanInput, by: string | null = null): VerifyPlan | null {
  if (!getPlan(db, id)) return null;
  const row = normalize(input);
  db.prepare(
    `UPDATE verify_plans SET name=@name, repo_path=@repo_path, description=@description, host=@host, steps=@steps,
       dataset_root=@dataset_root, dataset_default=@dataset_default, metrics=@metrics, protected_paths=@protected_paths,
       artifacts=@artifacts, manual_checks=@manual_checks, domain=@domain, setup_cmd=@setup_cmd, updated_by=@by,
       updated_at=datetime('now')
     WHERE id=@id`,
  ).run({ ...row, id, by });
  return getPlan(db, id);
}

export function getPlan(db: Database.Database, id: string): VerifyPlan | null {
  const r = db.prepare('SELECT * FROM verify_plans WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Plans for a repo (its own first, then the ones offered for every repo); all when repo is omitted. */
export function listPlans(db: Database.Database, repo?: string | null): VerifyPlan[] {
  const rows = (repo
    ? db.prepare('SELECT * FROM verify_plans WHERE repo_path = ? OR repo_path IS NULL ORDER BY repo_path IS NULL, name').all(repo)
    : db.prepare('SELECT * FROM verify_plans ORDER BY name').all()) as Row[];
  return rows.map(fromRow);
}

export function deletePlan(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM verify_plans WHERE id = ?').run(id).changes > 0;
}

/** The container path of a picked 圖資 folder. */
export function datasetPath(plan: VerifyPlan, name: string | null | undefined): string | null {
  const n = (name ?? '').trim() || plan.dataset_default;
  if (!plan.dataset_root || !n) return null;
  if (!DATASET_NAME.test(n)) throw new PlanError(`圖資名稱不對：${n}`);
  return `${plan.dataset_root}/${n}`;
}

/** The verification steps a task gets from this plan: aimed at its machine, {dataset} filled in. */
export function planSteps(plan: VerifyPlan, dataset: string | null): string[] {
  const prefix = !plan.host ? '' : plan.host === LOCAL_HOST ? 'sandbox: ' : `sandbox@${plan.host}: `;
  return plan.steps.map((s) => {
    if (s.includes('{dataset}') && !dataset) throw new PlanError('這個方案要選圖資');
    const cmd = dataset ? s.split('{dataset}').join(dataset) : s;
    return SANDBOX_PREFIX.test(cmd) ? cmd : `${prefix}${cmd}`;
  });
}

export interface Dataset {
  name: string;
  /** what the steps see ({dataset}) */
  path: string;
  /** image files inside (null = not counted) */
  images: number | null;
}

/** Where a container path lives on its machine, through that machine's read-only mounts. */
export function hostPathFor(mounts: DataMount[], containerPath: string): string | null {
  for (const m of mounts) {
    const t = m.target.replace(/\/+$/, '');
    if (containerPath === t) return m.source;
    if (containerPath.startsWith(`${t}/`)) return `${m.source.replace(/\/+$/, '')}${containerPath.slice(t.length)}`;
  }
  return null;
}

const IMAGE = /\.(png|jpe?g|bmp|tiff?)$/i;

function countImages(dir: string, depth = 2, budget = { left: 50_000 }): number {
  let n = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.left-- <= 0) break;
    if (e.isFile() && IMAGE.test(e.name)) n += 1;
    else if (e.isDirectory() && depth > 0) n += countImages(path.join(dir, e.name), depth - 1, budget);
  }
  return n;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The 圖資 an operator can pick for a plan: the sub-folders of its dataset_root on the plan's
 * machine, newest name first, with how many images each holds. Remote machines are asked over
 * ssh in one call.
 */
export async function listDatasets(db: Database.Database, plan: VerifyPlan, exec: HostExec = realHostExec): Promise<Dataset[]> {
  if (!plan.dataset_root) return [];
  const remote = plan.host && plan.host !== LOCAL_HOST ? getExecHost(db, plan.host) : null;
  if (plan.host && plan.host !== LOCAL_HOST && !remote) throw new PlanError(`沒有這台驗證機台：${plan.host}（loop exec host list）`);
  let src: string | null;
  if (!plan.host) {
    src = plan.dataset_root; // the engine's own shell: the path is a real path on this machine
  } else {
    let mounts: DataMount[] = [];
    try {
      mounts = parseDataMounts(remote ? remote.data_mounts : (getSetting(db, 'exec_data_mounts') ?? ''));
    } catch (err) {
      throw new PlanError(`機台的圖資掛載設定有誤：${(err as Error).message}`);
    }
    src = hostPathFor(mounts, plan.dataset_root);
    if (!src) {
      throw new PlanError(
        `圖資位置 ${plan.dataset_root} 不在 ${plan.host} 的唯讀掛載裡（${remote ? `loop exec host add ${plan.host} … --data <那台路徑>:${plan.dataset_root}` : `loop config set exec_data_mounts <路徑>:${plan.dataset_root}`}）`,
      );
    }
  }
  const out: Dataset[] = [];
  if (!remote) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      throw new PlanError(`讀不到圖資資料夾 ${src}`);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || !DATASET_NAME.test(e.name)) continue;
      out.push({ name: e.name, path: `${plan.dataset_root}/${e.name}`, images: countImages(path.join(src, e.name)) });
      if (out.length >= 200) break;
    }
  } else {
    const script =
      `cd ${shq(src)} 2>/dev/null || exit 3; for d in */; do d=\${d%/}; [ -d "$d" ] || continue; ` +
      `n=$(find "$d" -maxdepth 3 -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.bmp' -o -iname '*.tif' -o -iname '*.tiff' \\) 2>/dev/null | head -n 200000 | wc -l); ` +
      `printf '%s\\t%s\\n' "$d" "$n"; done`;
    const r = await exec('ssh', [...sshArgs(remote), remote.ssh_target, script], 60_000);
    if (r.code === null) throw new PlanError('這台 Spark 沒有 ssh 指令');
    if (r.code === 3) throw new PlanError(`${plan.host} 上沒有圖資資料夾 ${src}`);
    if (r.code !== 0) throw new PlanError(`連不上 ${plan.host}：${r.out.slice(-200)}`);
    for (const line of r.out.split('\n')) {
      const [name, n] = line.split('\t');
      if (!name || !DATASET_NAME.test(name)) continue;
      out.push({ name, path: `${plan.dataset_root}/${name}`, images: Number.isFinite(Number(n)) ? Number(n) : null });
      if (out.length >= 200) break;
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}
