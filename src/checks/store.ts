import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { formatSpecs, parseAcceptance } from '../orchestrator/acceptance.js';

/**
 * 檢查: what proves a change to one repo good — set up once per repo by an engineer (the Repo page's
 * 檢查 tab), run by the engine on every ticket like CI checks. The engineer only answers 「怎麼跑」
 * (a command, where it runs) and 「怎麼算過」 (exit 0, thresholds, or 「不比基準差」); LOOP_METRICS,
 * `{dataset}`, `sandbox:` and metric names are the engine's business (src/checks/render.ts,
 * src/checks/runner.ts). Mirrors src/plans/store.ts: rows are validated here, callers pass input.
 */

export const CHECK_KINDS = ['build', 'test', 'repro', 'dataset', 'custom', 'manual'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const PASS_RULES = ['exit0', 'metrics', 'baseline'] as const;
export type PassRule = (typeof PASS_RULES)[number];

/** A bad input (400), a missing row (404) or a state conflict (409) — the routes map `status`. */
export class CheckError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** One row of `checks`, exactly as stored. */
export interface Check {
  id: string;
  repo_id: string;
  name: string;
  kind: CheckKind;
  /** machines.name; null = the engine host; 'sandbox:<exec host|local>' = the Docker sandbox (legacy plans) */
  machine: string | null;
  /** null for kind = manual; a dataset check's template uses {images} {answers} {out} */
  command: string | null;
  pass_rule: PassRule;
  /** "correct_rate >= 0.98; time_ms <= 5300" (normalized by formatSpecs) */
  metrics: string | null;
  /** {sha, values, ms, at, run_id} — see parseBaseline */
  baseline_json: string | null;
  baseline_tol: number;
  dataset_id: string | null;
  /** repro: CSV globs of the test files carried onto base for the 紅→綠 check */
  test_globs: string | null;
  red_on_base: number;
  timeout_min: number | null;
  required: number;
  ord: number;
  protected_paths: string | null;
  artifacts: string | null;
  manual_text: string | null;
  enabled: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** What 「設為基準」 copied from a run: the values a 「不比基準差」 rule compares with, and where they came from. */
export interface CheckBaseline {
  sha: string | null;
  values: Record<string, number | string>;
  ms: number | null;
  at: string;
  run_id?: string | null;
}

/** Create / update input; on update, a field left undefined keeps its value and null clears it. */
export interface CheckInput {
  name?: string | null;
  kind?: string | null;
  machine?: string | null;
  command?: string | null;
  pass_rule?: string | null;
  metrics?: string | null;
  baseline_tol?: number | string | null;
  dataset_id?: string | null;
  test_globs?: string | string[] | null;
  red_on_base?: boolean | number | string | null;
  timeout_min?: number | string | null;
  required?: boolean | number | string | null;
  ord?: number | string | null;
  protected_paths?: string | string[] | null;
  artifacts?: string | string[] | null;
  manual_text?: string | null;
  enabled?: boolean | number | string | null;
}

/** Same shape as machines.name and exec_hosts.name. */
export const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** A check that still runs in the GPU Docker sandbox (migrated 驗證方案): `sandbox:<exec host|local>`. */
export const SANDBOX_MACHINE_RE = /^sandbox:([a-z0-9][a-z0-9_-]{0,39})$/;
const PLACEHOLDER_RE = /\{(images|answers|out)\}/;
const STEP_PREFIX_RE = /^\s*(?:sandbox(?:@[a-z0-9][a-z0-9_-]*)?|check)\s*:/i;
const MAX_COMMAND = 2000;

const csv = (v: string | string[] | null | undefined): string[] =>
  (Array.isArray(v) ? v : (v ?? '').split(/[,\n]/))
    .map((s) => String(s).replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);

/** Repo-relative globs only: the implementer's tree, never a machine's disk. */
function checkGlobs(label: string, globs: string[]): void {
  const bad = globs.filter((g) => g.startsWith('/') || /^[A-Za-z]:/.test(g) || g.split('/').includes('..') || /[\\\0]/.test(g));
  if (bad.length) throw new CheckError(`${label}要寫 repo 裡的相對路徑或 glob（例如 tests/**）：${bad.join('、')}`);
}

function flag(v: boolean | number | string | null | undefined, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  throw new CheckError(`看不懂的是非值：${String(v)}`);
}

function intOrNull(label: string, v: number | string | null | undefined, min: number, max: number): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new CheckError(`${label}要是 ${min}–${max} 的整數`);
  return n;
}

/** machine: '' / 'engine' = the engine host (null); a machines.name; or 'sandbox:<name|local>'. */
export function normalizeMachine(raw: string | null | undefined): string | null {
  const m = (raw ?? '').trim();
  if (!m || m === 'engine') return null;
  if (m === 'local') throw new CheckError("'local' 是保留字：在引擎主機跑請留空，要在 GPU 沙盒跑請寫 sandbox:local");
  if (m.startsWith('sandbox:')) {
    if (!SANDBOX_MACHINE_RE.test(m)) throw new CheckError(`GPU 沙盒主機名稱不對：${m}（格式 sandbox:<主機> 或 sandbox:local）`);
    return m;
  }
  if (!MACHINE_NAME_RE.test(m)) throw new CheckError(`機台名稱不對：${m}（小寫英數、- 或 _，最多 40 字）`);
  return m;
}

export function repoExists(db: Database.Database, repoId: string): boolean {
  return !!db.prepare('SELECT 1 FROM repos WHERE id = ?').get(repoId);
}

type Row = Omit<Check, 'id' | 'repo_id' | 'baseline_json' | 'created_by' | 'updated_by' | 'created_at' | 'updated_at'>;

function normalize(db: Database.Database, input: CheckInput, ordFallback: number): Row {
  const name = (input.name ?? '').trim();
  if (!name) throw new CheckError('檢查名稱不能空白');
  if (name.length > 60) throw new CheckError('檢查名稱最多 60 字');
  const kind = (input.kind ?? '').trim() as CheckKind;
  if (!(CHECK_KINDS as readonly string[]).includes(kind)) throw new CheckError(`類型只能是 ${CHECK_KINDS.join(' / ')}`);
  const passRule = ((input.pass_rule ?? '').trim() || 'exit0') as PassRule;
  if (!(PASS_RULES as readonly string[]).includes(passRule)) throw new CheckError(`怎麼算過只能是 ${PASS_RULES.join(' / ')}`);
  const machine = normalizeMachine(input.machine);

  let command: string | null = (input.command ?? '').trim() || null;
  if (kind === 'manual') {
    command = null;
  } else {
    if (!command) throw new CheckError('要寫一行指令（在哪裡跑、跑什麼）');
    if (command.length > MAX_COMMAND) throw new CheckError(`指令太長（最多 ${MAX_COMMAND} 字）`);
    if (command.includes('\0')) throw new CheckError('指令裡有不合法的字元');
    if (STEP_PREFIX_RE.test(command)) throw new CheckError('指令不用寫 sandbox:／check: 前綴；在哪裡跑請用「在哪裡跑」選');
    if (kind === 'dataset') {
      if (!command.includes('{out}')) throw new CheckError('圖資回歸的指令要用 {out} 指定輸出資料夾（Loop 會把它收回來比對），例如 run_inference --in {images} --out {out}');
    } else if (PLACEHOLDER_RE.test(command)) {
      throw new CheckError('只有圖資回歸可以用 {images} {answers} {out}');
    }
  }
  if (machine?.startsWith('sandbox:') && (kind === 'dataset' || kind === 'repro')) {
    throw new CheckError('圖資回歸和重現要在引擎主機或機台上跑（GPU 沙盒只支援一般指令）');
  }

  let metrics: string | null = null;
  if ((input.metrics ?? '').trim()) {
    try {
      const specs = parseAcceptance(input.metrics);
      metrics = specs.length ? formatSpecs(specs) : null;
    } catch (err) {
      throw new CheckError(`門檻：${(err as Error).message}`);
    }
  }
  if (passRule === 'metrics' && !metrics) {
    throw new CheckError('「指標門檻」要寫至少一條門檻（例如 correct_rate >= 0.98）；還不知道指標名稱就先用 exit 0 存檔、試跑一次');
  }

  const tolRaw = input.baseline_tol;
  const tol = tolRaw === undefined || tolRaw === null || tolRaw === '' ? 0.1 : Number(tolRaw);
  if (!Number.isFinite(tol) || tol < 0 || tol > 5) throw new CheckError('基準的時間容許值要在 0–5 之間（0.1 = 慢 10% 以內）');

  const datasetId = (input.dataset_id ?? '').trim() || null;
  if (kind === 'dataset') {
    if (!datasetId) throw new CheckError('圖資回歸要選一個圖資');
    if (!db.prepare('SELECT 1 FROM datasets WHERE id = ?').get(datasetId)) throw new CheckError(`沒有這個圖資：${datasetId}`);
  } else if (datasetId && !db.prepare('SELECT 1 FROM datasets WHERE id = ?').get(datasetId)) {
    throw new CheckError(`沒有這個圖資：${datasetId}`);
  }

  const testGlobs = csv(input.test_globs);
  checkGlobs('測試檔案', testGlobs);
  const prot = csv(input.protected_paths);
  checkGlobs('保護路徑', prot);
  const arts = csv(input.artifacts);
  checkGlobs('產出物', arts);

  const manualText = (input.manual_text ?? '').trim() || null;
  if (manualText && manualText.length > 500) throw new CheckError('人工檢查的說明最多 500 字');

  return {
    name,
    kind,
    machine,
    command,
    pass_rule: passRule,
    metrics,
    baseline_tol: tol,
    dataset_id: datasetId,
    test_globs: testGlobs.length ? testGlobs.join(',') : null,
    red_on_base: flag(input.red_on_base, 1),
    timeout_min: intOrNull('逾時（分鐘）', input.timeout_min, 1, 240),
    required: flag(input.required, 1),
    ord: intOrNull('順序', input.ord, 0, 100_000) ?? ordFallback,
    protected_paths: prot.length ? prot.join(',') : null,
    artifacts: arts.length ? arts.join(',') : null,
    manual_text: manualText,
    enabled: flag(input.enabled, 1),
  };
}

export function createCheck(db: Database.Database, repoId: string, input: CheckInput, by: string | null = null): Check {
  if (!repoExists(db, repoId)) throw new CheckError(`沒有這個 repo：${repoId}`, 404);
  const next = (db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM checks WHERE repo_id = ?').get(repoId) as { n: number }).n;
  const row = normalize(db, input, next);
  const id = `ck_${nanoid(8)}`;
  db.prepare(
    `INSERT INTO checks (id, repo_id, name, kind, machine, command, pass_rule, metrics, baseline_tol, dataset_id, test_globs,
       red_on_base, timeout_min, required, ord, protected_paths, artifacts, manual_text, enabled, created_by, updated_by)
     VALUES (@id, @repo_id, @name, @kind, @machine, @command, @pass_rule, @metrics, @baseline_tol, @dataset_id, @test_globs,
       @red_on_base, @timeout_min, @required, @ord, @protected_paths, @artifacts, @manual_text, @enabled, @by, @by)`,
  ).run({ ...row, id, repo_id: repoId, by });
  return getCheck(db, id)!;
}

export function getCheck(db: Database.Database, id: string): Check | null {
  return (db.prepare('SELECT * FROM checks WHERE id = ?').get(id) as Check | undefined) ?? null;
}

/** A repo's checks in run order (disabled ones included — the editor shows them greyed out). */
export function listChecks(db: Database.Database, repoId: string): Check[] {
  return db.prepare('SELECT * FROM checks WHERE repo_id = ? ORDER BY ord, created_at, id').all(repoId) as Check[];
}

function inputOfCheck(c: Check): CheckInput {
  return {
    name: c.name,
    kind: c.kind,
    machine: c.machine,
    command: c.command,
    pass_rule: c.pass_rule,
    metrics: c.metrics,
    baseline_tol: c.baseline_tol,
    dataset_id: c.dataset_id,
    test_globs: c.test_globs,
    red_on_base: c.red_on_base,
    timeout_min: c.timeout_min,
    required: c.required,
    ord: c.ord,
    protected_paths: c.protected_paths,
    artifacts: c.artifacts,
    manual_text: c.manual_text,
    enabled: c.enabled,
  };
}

/** PATCH semantics: only the fields present in `patch` change; the result is validated as a whole. */
export function updateCheck(db: Database.Database, id: string, patch: CheckInput, by: string | null = null): Check | null {
  const cur = getCheck(db, id);
  if (!cur) return null;
  const merged: CheckInput = { ...inputOfCheck(cur) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  const row = normalize(db, merged, cur.ord);
  db.prepare(
    `UPDATE checks SET name=@name, kind=@kind, machine=@machine, command=@command, pass_rule=@pass_rule, metrics=@metrics,
       baseline_tol=@baseline_tol, dataset_id=@dataset_id, test_globs=@test_globs, red_on_base=@red_on_base,
       timeout_min=@timeout_min, required=@required, ord=@ord, protected_paths=@protected_paths, artifacts=@artifacts,
       manual_text=@manual_text, enabled=@enabled, updated_by=@by, updated_at=datetime('now')
     WHERE id=@id`,
  ).run({ ...row, id, by });
  return getCheck(db, id);
}

/** Tasks already created keep their frozen copy (tasks.checks_json); check_runs keep their history. */
export function deleteCheck(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM checks WHERE id = ?').run(id).changes > 0;
}

/** Drag-sorting: `ids` first in the given order, anything not named keeps its relative order after them. */
export function reorderChecks(db: Database.Database, repoId: string, ids: string[]): Check[] {
  if (!repoExists(db, repoId)) throw new CheckError(`沒有這個 repo：${repoId}`, 404);
  const all = listChecks(db, repoId);
  const known = new Set(all.map((c) => c.id));
  const want = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
  const foreign = want.filter((id) => !known.has(id));
  if (foreign.length) throw new CheckError(`不是這個 repo 的檢查：${foreign.join('、')}`);
  const order = [...want, ...all.map((c) => c.id).filter((id) => !want.includes(id))];
  const set = db.prepare('UPDATE checks SET ord = ? WHERE id = ?');
  db.transaction(() => order.forEach((id, i) => set.run(i, id)))();
  return listChecks(db, repoId);
}

export function parseBaseline(check: Pick<Check, 'baseline_json'>): CheckBaseline | null {
  if (!check.baseline_json) return null;
  try {
    const b = JSON.parse(check.baseline_json) as Partial<CheckBaseline>;
    if (!b || typeof b !== 'object' || !b.values || typeof b.values !== 'object') return null;
    return { sha: b.sha ?? null, values: b.values, ms: typeof b.ms === 'number' ? b.ms : null, at: String(b.at ?? ''), run_id: b.run_id ?? null };
  } catch {
    return null;
  }
}

/** 「設為基準」 (src/checks/baseline.ts) — null clears it. */
export function writeBaseline(db: Database.Database, id: string, baseline: CheckBaseline | null, by: string | null = null): Check | null {
  const r = db
    .prepare("UPDATE checks SET baseline_json = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
    .run(baseline ? JSON.stringify(baseline) : null, by, id);
  return r.changes ? getCheck(db, id) : null;
}
