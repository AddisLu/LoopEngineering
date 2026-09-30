import type Database from 'better-sqlite3';
import { formatSpecs, parseAcceptance, type MetricSpec } from '../orchestrator/acceptance.js';
import type { Task } from '../types.js';
import { DATASET_METRIC_NAMES } from './compare.js';
import { getDataset, type AnswerFormat } from './datasets.js';
import { listChecks, parseBaseline, SANDBOX_MACHINE_RE, type Check, type CheckBaseline, type CheckKind, type PassRule } from './store.js';

/**
 * 檢查 → a task. A task gets a frozen copy of the checks it will run (tasks.checks_json), so a later
 * edit of a repo's checks never changes a queued task; its verification_steps name them as
 * `check:<id>` and everything else a task carries (acceptance_metrics, protected_paths, artifacts,
 * verify_mode) is rendered from the copy — runVerifyGate, prompt.ts, reviewBundle, prBody and the
 * morning report keep seeing the shapes they know. 「不比基準差」 becomes concrete numbers here, at
 * snapshot time, so evaluateAcceptance needs nothing new.
 */

export interface DatasetSnapshot {
  id: string;
  name: string;
  remote_url: string;
  images_dir: string;
  answer_file: string;
  answer_format: AnswerFormat;
}

export interface CheckSnapshot {
  id: string;
  repo_id: string;
  name: string;
  kind: CheckKind;
  machine: string | null;
  command: string | null;
  pass_rule: PassRule;
  /** as the engineer wrote them */
  metrics: string | null;
  /** what is compared at verification: the metrics rule's specs, or the baseline turned into numbers (plain names) */
  thresholds: string | null;
  baseline: CheckBaseline | null;
  baseline_tol: number;
  dataset: DatasetSnapshot | null;
  test_globs: string[];
  /** repro: explicit test files to carry onto base besides test_globs (e.g. the one the analysis proposed) */
  test_files?: string[];
  red_on_base: boolean;
  timeout_min: number | null;
  required: boolean;
  ord: number;
  protected_paths: string[];
  artifacts: string[];
  manual_text: string | null;
  /** 'ck_x.' when another check of the same task reports a metric of the same name: its LOOP_METRICS
   *  keys and thresholds are namespaced (the runner rewrites the check's output the same way) */
  metric_prefix: string | null;
}

export interface RenderedChecks {
  verification_steps: string[];
  acceptance_metrics: string | null;
  protected_paths: string | null;
  artifacts: string | null;
  manual_checks: string[];
  verify_mode: string;
  /** checks name their own machine; nothing extra is required of the engine host */
  requires: string | null;
}

const csv = (s: string | null | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function specsOf(text: string | null | undefined): MetricSpec[] {
  try {
    return parseAcceptance(text);
  } catch {
    return [];
  }
}

// 「不比基準差」 per metric: times may grow by the tolerance, rates and scores must hold (an error /
// miss / false-positive rate or a loss must not grow); counts and unknown names stay informational
const TIME_RE = /(^|[._])(time|latency|duration|elapsed)([._]|$)|_(ms|s|sec|secs|seconds)$/i;
const LOWER_RE = /(^|[._])(error|errors|err|loss|miss|misses|false|fail|failure|failures|wrong)([._]|$)/i;
const HIGHER_RE = /(^|[._])(rate|ratio|accuracy|acc|precision|recall|f1|map|iou|score|fps|throughput)([._]|$)/i;

export function baselineThresholds(values: Record<string, number | string>, tol: number): MetricSpec[] {
  const out: MetricSpec[] = [];
  for (const [name, v] of Object.entries(values)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (TIME_RE.test(name)) {
      if (v > 0) out.push({ name, op: '<=', target: Number((v * (1 + tol)).toFixed(6)) });
    } else if (LOWER_RE.test(name) && /rate|ratio|loss/i.test(name)) {
      out.push({ name, op: '<=', target: v });
    } else if (HIGHER_RE.test(name)) {
      out.push({ name, op: '>=', target: v });
    }
  }
  return out;
}

/** One check as a task will run it (no metric_prefix: that depends on the other checks of the task). */
export function snapshotCheck(db: Database.Database, c: Check): CheckSnapshot {
  const baseline = parseBaseline(c);
  const own = specsOf(c.metrics);
  const specs = c.pass_rule === 'metrics' ? own : c.pass_rule === 'baseline' ? [...(baseline ? baselineThresholds(baseline.values, c.baseline_tol) : []), ...own] : [];
  const ds = c.dataset_id ? getDataset(db, c.dataset_id) : null;
  return {
    id: c.id,
    repo_id: c.repo_id,
    name: c.name,
    kind: c.kind,
    machine: c.machine,
    command: c.command,
    pass_rule: c.pass_rule,
    metrics: c.metrics,
    thresholds: specs.length ? formatSpecs(specs) : null,
    baseline,
    baseline_tol: c.baseline_tol,
    dataset: ds ? { id: ds.id, name: ds.name, remote_url: ds.remote_url, images_dir: ds.images_dir, answer_file: ds.answer_file, answer_format: ds.answer_format } : null,
    test_globs: csv(c.test_globs),
    red_on_base: !!c.red_on_base,
    timeout_min: c.timeout_min,
    required: !!c.required,
    ord: c.ord,
    protected_paths: csv(c.protected_paths),
    artifacts: csv(c.artifacts),
    manual_text: c.manual_text,
    metric_prefix: null,
  };
}

const isSandbox = (s: Pick<CheckSnapshot, 'machine'>): boolean => !!s.machine && SANDBOX_MACHINE_RE.test(s.machine);

/** The metric names a check reports into the task's LOOP_METRICS (exit-0 checks report none that count). */
export function emittedMetricNames(s: CheckSnapshot): string[] {
  if (s.kind === 'manual') return [];
  const names = new Set<string>();
  if (s.kind === 'dataset') for (const n of DATASET_METRIC_NAMES) names.add(n);
  if (s.pass_rule !== 'exit0') {
    for (const sp of specsOf(s.thresholds)) names.add(sp.name);
    if (s.pass_rule === 'baseline') for (const n of Object.keys(s.baseline?.values ?? {})) names.add(n);
  }
  return [...names];
}

/**
 * Two checks reporting the same metric (two 圖資回歸 both say correct_rate) would overwrite each
 * other's value; each of them gets its id as a prefix instead. A GPU 沙盒 check is run by the
 * sandbox runner, which cannot rewrite its output, so it keeps the plain names and the others move.
 */
export function assignMetricPrefixes(snap: CheckSnapshot[]): CheckSnapshot[] {
  const owners = new Map<string, CheckSnapshot[]>();
  for (const s of snap) for (const n of emittedMetricNames(s)) owners.set(n, [...(owners.get(n) ?? []), s]);
  const prefixed = new Set<string>();
  for (const list of owners.values()) if (list.length > 1) for (const s of list) if (!isSandbox(s)) prefixed.add(s.id);
  return snap.map((s) => ({ ...s, metric_prefix: prefixed.has(s.id) ? `${s.id}.` : null }));
}

/**
 * The checks a task of this repo runs: every enabled required check, plus the optional ones named in
 * `include` (the 分析卡's ticked boxes), in the repo's order. Unknown or disabled ids are ignored.
 */
export function snapshotChecks(db: Database.Database, repoId: string, opts: { include?: string[] } = {}): CheckSnapshot[] {
  const inc = new Set(opts.include ?? []);
  const rows = listChecks(db, repoId).filter((c) => c.enabled && (c.required || inc.has(c.id)));
  return assignMetricPrefixes(rows.map((c) => snapshotCheck(db, c)));
}

/** A check's thresholds under the names its output will carry (metric_prefix applied). */
export function prefixedThresholds(s: CheckSnapshot): MetricSpec[] {
  return specsOf(s.thresholds).map((sp) => (s.metric_prefix ? { ...sp, name: `${s.metric_prefix}${sp.name}` } : sp));
}

/** A migrated sandbox check keeps running as the old `sandbox@<host>: <cmd>` step (verifySandboxRunner). */
export function legacySandboxStep(s: CheckSnapshot): string | null {
  const m = s.machine ? SANDBOX_MACHINE_RE.exec(s.machine) : null;
  return m && s.command ? `sandbox@${m[1]}: ${s.command}` : null;
}

const ordered = (snap: CheckSnapshot[]): CheckSnapshot[] => [...snap].sort((a, b) => a.ord - b.ord);
const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function renderChecks(snap: CheckSnapshot[]): RenderedChecks {
  const steps: string[] = [];
  const specs: string[] = [];
  const prot: string[] = [];
  const arts: string[] = [];
  const manual: string[] = [];
  for (const s of ordered(snap)) {
    prot.push(...s.protected_paths);
    arts.push(...s.artifacts);
    if (s.kind === 'manual') {
      manual.push(s.manual_text || s.name);
      continue;
    }
    steps.push(legacySandboxStep(s) ?? `check:${s.id}`);
    for (const sp of prefixedThresholds(s)) specs.push(formatSpecs([sp]));
  }
  const modes = [...(steps.length ? ['command'] : []), ...(manual.length ? ['manual'] : [])];
  return {
    verification_steps: steps,
    acceptance_metrics: specs.length ? uniq(specs).join('; ') : null,
    protected_paths: uniq(prot).join(',') || null,
    artifacts: uniq(arts).join(',') || null,
    manual_checks: manual,
    verify_mode: (modes.length ? modes : ['command']).join(','),
    requires: null,
  };
}

const OP: Record<string, string> = { '>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '>': '>', '<': '<' };
const METRIC_LABEL: Record<string, string> = { correct_rate: '正確率' };
const thresholdText = (s: CheckSnapshot): string =>
  specsOf(s.thresholds)
    .map((sp) => `${METRIC_LABEL[sp.name] ?? sp.name} ${OP[sp.op] ?? sp.op} ${sp.target}`)
    .join('、');

function whereText(s: CheckSnapshot): string {
  if (!s.machine) return '';
  const sb = SANDBOX_MACHINE_RE.exec(s.machine);
  return sb ? `在 GPU 沙盒 ${sb[1]}` : `在 ${s.machine}，引擎代跑`;
}

/**
 * The human line per check for LOOP_TASK.md's 驗收檢查 section (plain metric names: the agent never
 * prints a namespaced one, the engine does the namespacing), e.g.
 * 「- [必過] 單元測試：`ctest --test-dir build`（在 aoi-1，引擎代跑）」
 * 「- 重現：`pytest tests/test_recipe_reload.py`（修改前必須失敗、修改後必須通過）」
 * 「- 圖資回歸：dataset-2026Q2，正確率 ≥ 0.987、time_ms ≤ 5300（引擎比對，不要自己改答案檔）」
 */
export function describeChecks(snap: CheckSnapshot[]): string[] {
  const lines: string[] = [];
  for (const s of ordered(snap)) {
    const where = whereText(s);
    const th = thresholdText(s);
    const cmd = s.command ? `\`${s.command}\`` : '';
    if (s.kind === 'manual') {
      lines.push(`- [人工] ${s.manual_text || s.name}`);
    } else if (s.kind === 'repro') {
      const rule = s.red_on_base ? '修改前必須失敗、修改後必須通過' : '修改後必須通過';
      const tests = s.red_on_base && s.test_globs.length ? `新增的測試放在 ${s.test_globs.join('、')}` : '';
      lines.push(`- ${s.name}：${cmd}（${[rule, tests, where].filter(Boolean).join('；')}）`);
    } else if (s.kind === 'dataset') {
      const how = s.machine && !isSandbox(s) ? `在 ${s.machine} 由引擎執行並比對，不要自己改答案檔` : '引擎比對，不要自己改答案檔';
      lines.push(`- ${s.name}：${s.dataset?.name ?? '（圖資已移除）'}${th ? `，${th}` : ''}（${how}）`);
      if (cmd) lines.push(`  - 引擎執行的指令：${cmd}（{images} 圖片資料夾、{answers} 答案檔、{out} 輸出資料夾）`);
    } else {
      const paren = [th ? `門檻 ${th}` : '', where].filter(Boolean).join('；');
      lines.push(`- ${s.required ? '[必過] ' : ''}${s.name}：${cmd}${paren ? `（${paren}）` : ''}`);
    }
  }
  return lines;
}

/** The frozen checks of a task (tasks.checks_json); [] for a task that has none or a damaged copy. */
export function parseCheckSnapshots(task: Pick<Task, 'checks_json'>): CheckSnapshot[] {
  if (!task.checks_json) return [];
  try {
    const v = JSON.parse(task.checks_json) as unknown;
    return Array.isArray(v) ? (v.filter((s) => s && typeof s === 'object' && typeof (s as CheckSnapshot).id === 'string') as CheckSnapshot[]) : [];
  } catch {
    return [];
  }
}

/** Does any check of the task run on a 機台 (so its branch has to be on origin before verification)? */
export function targetsMachine(snap: CheckSnapshot[]): boolean {
  return snap.some((s) => s.kind !== 'manual' && !!s.machine && !isSandbox(s));
}
