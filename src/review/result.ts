import type { TaskRun } from '../types.js';
import { readVerify, type VerifiedStep } from '../orchestrator/runSummary.js';

/**
 * 結果頁 (web/task.html) for a 問題單: what the checks engine recorded (check_runs), read against the
 * checks the task froze (tasks.checks_json) — the GitHub-checks style list, the 圖資回歸 case-by-case
 * diff, the attempt history and the conclusion line. Pure: reviewBundle does the reading (rows, the
 * files a run pulled back) and hands them over, so every rule here is tested with plain objects.
 * A task that is not a ticket froze no checks and gets empty lists from every builder.
 */

// ---- inputs --------------------------------------------------------------------------------------

/** One row of check_runs (src/db/schema.sql), as stored. */
export interface CheckRunRow {
  id: string;
  check_id: string;
  task_id: string | null;
  run_id: string | null;
  /** trial | baseline | repro_before | verify | reverify | red_green */
  kind: string;
  machine: string | null;
  head_sha: string | null;
  base_sha: string | null;
  ok: number | null;
  exit_code: number | null;
  timed_out: number;
  ms: number | null;
  output_tail: string | null;
  metrics_json: string | null;
  result_json: string | null;
  artifacts_json: string | null;
  started_at: string;
  finished_at: string | null;
}

/** What the page reads of one frozen check (tasks.checks_json: the snapshot, or a raw checks row). */
export interface FrozenCheck {
  id: string;
  name: string;
  /** build | test | repro | dataset | custom | manual */
  kind: string;
  /** machines.name; null = the engine host; 'sandbox:<host>' = the GPU sandbox */
  machine: string | null;
  command: string | null;
  required: boolean;
  manual_text: string | null;
  baseline: { sha: string | null; values: Record<string, number>; run_id: string | null } | null;
  dataset: string | null;
}

// ---- small readers -------------------------------------------------------------------------------

function parseJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (v === true || v === 1 ? true : v === false || v === 0 ? false : null);

function numbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v) ?? {})) {
    const n = num(x);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** 'YYYY-MM-DD HH:MM:SS' (sqlite, UTC) or ISO → ms since epoch (NaN when unreadable). */
export function tsMs(s: string | null | undefined): number {
  if (!s) return NaN;
  return new Date(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`).getTime();
}

export function readFrozenChecks(json: string | null | undefined): FrozenCheck[] {
  const v = parseJson(json);
  if (!Array.isArray(v)) return [];
  const out: FrozenCheck[] = [];
  for (const raw of v) {
    const r = obj(raw);
    const id = str(r?.id);
    const name = str(r?.name);
    if (!r || !id || !name) continue;
    const b = obj(typeof r.baseline_json === 'string' ? parseJson(r.baseline_json) : (r.baseline ?? r.baseline_json));
    const ds = obj(r.dataset);
    out.push({
      id,
      name,
      kind: str(r.kind) ?? 'custom',
      machine: str(r.machine),
      command: str(r.command),
      required: r.required === undefined || r.required === null ? true : bool(r.required) ?? r.required === '1',
      manual_text: str(r.manual_text),
      baseline: b ? { sha: str(b.sha), values: numbers(b.values), run_id: str(b.run_id) } : null,
      dataset: str(ds?.name) ?? str(r.dataset_name),
    });
  }
  return out;
}

/** metrics_json is {values, checks, pass} (a gated check) or the bare values it discovered. */
export function metricValues(json: string | null | undefined): Record<string, number> {
  const m = obj(parseJson(json));
  if (!m) return {};
  return numbers(obj(m.values) ?? m);
}

interface MetricLine {
  name: string;
  op: string;
  target: number;
  actual: number | null;
  pass: boolean;
}
function metricChecks(json: string | null | undefined): MetricLine[] {
  const m = obj(parseJson(json));
  if (!m || !Array.isArray(m.checks)) return [];
  const out: MetricLine[] = [];
  for (const raw of m.checks) {
    const c = obj(raw);
    const name = str(c?.name);
    const target = num(c?.target);
    if (!c || !name || target === null) continue;
    out.push({ name, op: str(c.op) ?? '', target, actual: num(c.actual), pass: c.pass === true });
  }
  return out;
}

export interface ReproSide {
  ok: boolean | null;
  exit_code: number | null;
  tail: string;
}
/** A 重現 check's 紅→綠 result: {before, after}, each {ok, exit_code, tail}. */
export function readRepro(json: string | null | undefined): { before: ReproSide | null; after: ReproSide | null } | null {
  const r = obj(parseJson(json));
  if (!r || (!obj(r.before) && !obj(r.after))) return null;
  const side = (v: unknown): ReproSide | null => {
    const o = obj(v);
    return o ? { ok: bool(o.ok), exit_code: num(o.exit_code), tail: typeof o.tail === 'string' ? o.tail : '' } : null;
  };
  return { before: side(r.before), after: side(r.after) };
}

export interface CaseResultRow {
  case: string;
  expected: string;
  /** null = the software wrote nothing for this case */
  actual: string | null;
  ok: boolean;
  note: string;
}
/** A 圖資回歸 run's per-case rows ([{case, expected, actual, ok, note}], or {cases: [...]}). */
export function readCases(json: string | null | undefined): CaseResultRow[] | null {
  const v = parseJson(json);
  const arr = Array.isArray(v) ? v : Array.isArray(obj(v)?.cases) ? (obj(v)!.cases as unknown[]) : null;
  if (!arr) return null;
  const out: CaseResultRow[] = [];
  for (const raw of arr) {
    const c = obj(raw);
    const name = c ? (typeof c.case === 'string' ? c.case : typeof c.case === 'number' ? String(c.case) : null) : null;
    if (!c || !name) continue;
    out.push({
      case: name,
      expected: c.expected == null ? '' : String(c.expected),
      actual: c.actual == null ? null : String(c.actual),
      ok: c.ok === true || c.ok === 1,
      note: typeof c.note === 'string' ? c.note : '',
    });
  }
  return out;
}

// ---- formatting ----------------------------------------------------------------------------------

export const CHECK_KIND_LABELS: Record<string, string> = { build: '建置', test: '測試', repro: '重現', dataset: '圖資回歸', custom: '自訂', manual: '人工' };

/** Where a check runs, the way people call it: a machine's name, 引擎主機, or GPU 沙盒. */
export function whereLabel(machine: string | null): string {
  if (!machine) return '引擎主機';
  const m = /^sandbox:(.+)$/.exec(machine);
  if (m) return m[1] === 'local' ? 'GPU 沙盒' : `GPU 沙盒（${m[1]}）`;
  return machine;
}

/** 0.8 s · 41 s · 2 分 08 秒 · 1 時 05 分 */
export function fmtMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = ms / 1000;
  if (s < 9.95) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  if (whole < 60) return `${whole} s`;
  const m = Math.floor(whole / 60);
  if (m < 60) return `${m} 分 ${String(whole % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(m / 60)} 時 ${String(m % 60).padStart(2, '0')} 分`;
}

/** 0.987 → 98.7%; a value above 1 is already a percent. */
export function fmtRate(v: number): string {
  return `${(v > 1 ? v : v * 100).toFixed(1)}%`;
}

const OPS: Record<string, string> = { '>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '>': '>', '<': '<' };

// ---- the checks list -----------------------------------------------------------------------------

export type CheckState = 'passed' | 'failed' | 'running' | 'waiting' | 'manual';

export interface ResultCheck {
  id: string;
  name: string;
  kind: string;
  kind_label: string;
  machine: string | null;
  where: string;
  required: boolean;
  state: CheckState;
  ok: boolean | null;
  ms: number | null;
  exit_code: number | null;
  timed_out: boolean;
  /** 「修前 ✗ → 修後 ✓」, 「正確率 98.7% → 99.0% · 5.1 s → 4.9 s」, 「exit 1」, 「41 s」… */
  summary: string;
  command: string | null;
  /** check_runs.id behind 看紀錄 (GET /api/check-runs/:id) */
  run_id: string | null;
  /** only when no check_runs row exists: the verify step's own output tail */
  tail: string | null;
  /** 重現: whether it failed before the change and passes after it */
  repro: { before_ok: boolean | null; after_ok: boolean | null } | null;
  /** 圖資回歸 with per-case rows (看每張) */
  cases: boolean;
}

const VERIFY_KINDS = new Set(['verify', 'reverify', 'red_green']);
const STEP_CHECK_RE = /^\s*check:\s*([A-Za-z0-9_-]+)/;

/**
 * The task run whose checks the page shows: the run in flight while the task works, else the latest
 * run that ran checks, else the latest verified one. `runs` newest first.
 */
export function pickShownRun(runs: Array<Pick<TaskRun, 'id' | 'verify_json'>>, rows: CheckRunRow[], inProgress: boolean): string | null {
  if (!runs.length) return null;
  if (inProgress) return runs[0]!.id;
  const ran = new Set(rows.filter((r) => r.run_id && VERIFY_KINDS.has(r.kind)).map((r) => r.run_id!));
  return (runs.find((r) => ran.has(r.id)) ?? runs.find((r) => r.verify_json) ?? runs[0]!).id;
}

/** The latest verification row of each check within one task run (`rows` oldest first). */
export function latestPerCheck(rows: CheckRunRow[], runId: string | null): Map<string, CheckRunRow> {
  const out = new Map<string, CheckRunRow>();
  if (!runId) return out;
  for (const r of rows) if (r.run_id === runId && VERIFY_KINDS.has(r.kind)) out.set(r.check_id, r);
  return out;
}

/**
 * 修前 for a check: the run its frozen baseline was taken from, else its latest finished baseline,
 * else its latest finished 試跑 — only runs that started before `cutoff` (the shown run), so a 試跑
 * after the fix was merged never passes for "before". `rows` oldest first.
 */
export function pickBeforeRow(check: FrozenCheck, rows: CheckRunRow[], cutoff?: string | null): CheckRunRow | null {
  const own = rows.filter((r) => r.check_id === check.id && r.finished_at);
  const wanted = check.baseline?.run_id;
  if (wanted) {
    const hit = own.find((r) => r.id === wanted);
    if (hit) return hit;
  }
  const limit = tsMs(cutoff);
  const early = Number.isFinite(limit) ? own.filter((r) => !(tsMs(r.started_at) > limit)) : own;
  const last = (kind: string) => [...early].reverse().find((r) => r.kind === kind) ?? null;
  return last('baseline') ?? last('trial');
}

function plainSummary(ok: boolean | null, timedOut: boolean, exit: number | null, ms: number | null): string {
  if (timedOut) return '逾時';
  if (ok === false) return `exit ${exit ?? '?'}`;
  return fmtMs(ms) ?? '通過';
}

function datasetSummary(check: FrozenCheck, row: CheckRunRow, before: CheckRunRow | null): string | null {
  const after = metricValues(row.metrics_json);
  if (after.correct_rate === undefined && after.time_ms === undefined) return null;
  const base = check.baseline && Object.keys(check.baseline.values).length ? check.baseline.values : before ? metricValues(before.metrics_json) : {};
  const parts: string[] = [];
  if (after.correct_rate !== undefined) {
    parts.push(base.correct_rate !== undefined ? `正確率 ${fmtRate(base.correct_rate)} → ${fmtRate(after.correct_rate)}` : `正確率 ${fmtRate(after.correct_rate)}`);
  }
  if (after.time_ms !== undefined) {
    parts.push(base.time_ms !== undefined ? `${fmtMs(base.time_ms)} → ${fmtMs(after.time_ms)}` : fmtMs(after.time_ms)!);
  }
  return parts.join(' · ');
}

function metricSummary(row: CheckRunRow): string | null {
  const lines = metricChecks(row.metrics_json);
  if (!lines.length) return null;
  return [...lines.filter((c) => !c.pass), ...lines.filter((c) => c.pass)]
    .slice(0, 2)
    .map((c) => `${c.name} ${c.actual ?? '沒有回報'} ${OPS[c.op] ?? c.op} ${c.target}`)
    .join(' · ');
}

const mark = (ok: boolean | null | undefined) => (ok === true ? '✓' : ok === false ? '✗' : '？');

/**
 * One entry per frozen check, in the task's order: its latest row in the shown run, or — for a check
 * the engine ran as a plain verify step without a check_runs row — that step's result.
 */
export function buildChecks(checks: FrozenCheck[], shown: Map<string, CheckRunRow>, before: Map<string, CheckRunRow>, steps: VerifiedStep[]): ResultCheck[] {
  return checks.map((c) => {
    const base: ResultCheck = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      kind_label: CHECK_KIND_LABELS[c.kind] ?? c.kind,
      machine: c.machine,
      where: whereLabel(c.machine),
      required: c.required,
      state: 'waiting',
      ok: null,
      ms: null,
      exit_code: null,
      timed_out: false,
      summary: '等待中',
      command: c.kind === 'repro' ? c.command : null,
      run_id: null,
      tail: null,
      repro: null,
      cases: false,
    };
    if (c.kind === 'manual') return { ...base, state: 'manual', summary: c.manual_text ?? '人工驗收' };
    const row = shown.get(c.id);
    if (row) {
      if (row.ok === null && !row.finished_at) return { ...base, state: 'running', summary: '執行中…', run_id: row.id };
      const ok = row.ok === 1;
      const timedOut = !!row.timed_out;
      const repro = c.kind === 'repro' ? readRepro(row.result_json) : null;
      let summary: string | null = null;
      if (repro) summary = `修前 ${mark(repro.before?.ok)} → 修後 ${mark(repro.after?.ok)}`;
      else if (timedOut || (row.exit_code !== null && row.exit_code !== 0)) summary = null;
      else if (c.kind === 'dataset') summary = datasetSummary(c, row, before.get(c.id) ?? null);
      else summary = metricSummary(row);
      return {
        ...base,
        state: ok ? 'passed' : 'failed',
        ok,
        ms: row.ms,
        exit_code: row.exit_code,
        timed_out: timedOut,
        summary: summary ?? plainSummary(ok, timedOut, row.exit_code, row.ms),
        run_id: row.id,
        repro: repro ? { before_ok: repro.before?.ok ?? null, after_ok: repro.after?.ok ?? null } : null,
        cases: c.kind === 'dataset' && !!readCases(row.result_json)?.length,
      };
    }
    const step = steps.find((s) => STEP_CHECK_RE.exec(s.step)?.[1] === c.id || s.step.trim() === c.name);
    if (!step) return base;
    return {
      ...base,
      state: step.ok ? 'passed' : 'failed',
      ok: step.ok,
      ms: step.ms ?? null,
      exit_code: step.exitCode,
      timed_out: step.timedOut,
      summary: plainSummary(step.ok, step.timedOut, step.exitCode, step.ms ?? null),
      tail: step.tail || null,
    };
  });
}

/** How a verify step reads to a person: `check:<id>` becomes the check's name. */
export function stepLabel(step: string, checks: FrozenCheck[]): string {
  const id = STEP_CHECK_RE.exec(step)?.[1];
  const c = id ? checks.find((x) => x.id === id) : undefined;
  return c ? c.name : step;
}

const IN_PROGRESS = new Set(['draft', 'ready', 'queued', 'running', 'verifying', 'blocked']);

/**
 * 結論色塊 of a ticket: 「4 項檢查都過，重現測試從紅變綠」／「沒過：單元測試（aoi-1）」／「正在跑檢查 2/4」.
 * null = nothing the checks can say (the page keeps its usual headline).
 */
export function ticketHeadline(status: string, checks: ResultCheck[]): string | null {
  const auto = checks.filter((c) => c.state !== 'manual');
  if (!auto.length) return null;
  if (status === 'verifying') {
    const done = auto.filter((c) => c.state === 'passed' || c.state === 'failed').length;
    return `正在跑檢查 ${done}/${auto.length}`;
  }
  if (IN_PROGRESS.has(status)) return null;
  const failed = auto.find((c) => c.state === 'failed' && c.required) ?? auto.find((c) => c.state === 'failed');
  if (status === 'attention' || status === 'failed') {
    return failed ? `沒過：${failed.name}${failed.machine ? `（${failed.where}）` : ''}` : null;
  }
  if (auto.every((c) => c.state === 'passed')) {
    const redGreen = auto.some((c) => c.repro && c.repro.before_ok === false && c.repro.after_ok === true);
    return `${auto.length} 項檢查都過${redGreen ? '，重現測試從紅變綠' : ''}`;
  }
  const required = auto.filter((c) => c.required);
  if (failed && !failed.required && required.length && required.every((c) => c.state === 'passed')) {
    return `必過的 ${required.length} 項都過，選用的「${failed.name}」沒過`;
  }
  return null;
}

// ---- 圖資回歸 --------------------------------------------------------------------------------------

export interface FileRef {
  /** check_runs.id: the file is served by GET /api/check-runs/:id/files/<path> */
  run_id: string;
  path: string;
}

export type CaseChange = 'better' | 'worse' | 'same' | 'missing';

export interface DatasetRow {
  case: string;
  expected: string;
  /** what the software answered before the change (null: no answer, or no 修前 run) */
  before: string | null;
  /** null = 沒輸出 */
  after: string | null;
  /** null = the 修前 run has no row for this case (or there is no 修前 run) */
  ok_before: boolean | null;
  ok_after: boolean;
  change: CaseChange;
  note: string;
  /** the input picture (or the best picture there is) for the table's thumbnail */
  image: FileRef | null;
  before_image: FileRef | null;
  after_image: FileRef | null;
}

export interface DatasetView {
  check_id: string;
  name: string;
  dataset: string | null;
  /** short sha the 修前 numbers were measured at */
  baseline_sha: string | null;
  run_id: string;
  before_run_id: string | null;
  counts: { total: number; correct_before: number | null; correct_after: number; better: number; worse: number; missing: number };
  rows: DatasetRow[];
  /** rows were capped: every changed case is kept, unchanged ones fill up to the cap */
  truncated: boolean;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const OVERLAY_SUFFIX = /[._-](overlay|ovl|vis|pred|result)$/i;

/** 'images/val/img001.png' → 'img001' (the same key compare.ts matches cases by). */
export function caseKey(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(png|jpe?g|bmp|tiff?|gif|webp|txt|json|raw|pgm|ppm|npy)$/i, '').trim();
}

interface ImageIndex {
  overlay: Map<string, string>;
  input: Map<string, string>;
  other: Map<string, string>;
}
/** The pictures a run pulled back, by case: overlays (…/overlays/…, *_overlay.png), inputs, the rest. */
export function indexImages(paths: string[]): ImageIndex {
  const idx: ImageIndex = { overlay: new Map(), input: new Map(), other: new Map() };
  for (const p of [...paths].sort()) {
    if (!IMAGE_EXT.test(p)) continue;
    const segs = p.split('/');
    const file = segs.pop()!;
    const dirs = segs.map((s) => s.toLowerCase());
    let key = file.replace(IMAGE_EXT, '');
    let bucket: Map<string, string>;
    if (OVERLAY_SUFFIX.test(key)) {
      key = key.replace(OVERLAY_SUFFIX, '');
      bucket = idx.overlay;
    } else if (dirs.some((d) => d.includes('overlay') || d === 'vis' || d === 'viz')) bucket = idx.overlay;
    else if (dirs.some((d) => /^(inputs?|images?|imgs?|originals?|source|src|raw)$/.test(d))) bucket = idx.input;
    else bucket = idx.other;
    if (key && !bucket.has(key)) bucket.set(key, p);
  }
  return idx;
}

export const DATASET_MAX_ROWS = 2000;

/**
 * Each 圖資回歸 check with per-case rows: its cases against the 修前 run's (better / worse / same /
 * missing), the counts for the chips, and the pictures each run pulled back. `files(runId)` lists
 * the files under that run's folder (relative paths).
 */
export function buildDatasetViews(
  checks: FrozenCheck[],
  shown: Map<string, CheckRunRow>,
  before: Map<string, CheckRunRow>,
  files: (runId: string) => string[],
  maxRows = DATASET_MAX_ROWS,
): DatasetView[] {
  const out: DatasetView[] = [];
  for (const c of checks) {
    if (c.kind !== 'dataset') continue;
    const row = shown.get(c.id);
    const cases = row ? readCases(row.result_json) : null;
    if (!row || !cases?.length) continue;
    const prev = before.get(c.id) ?? null;
    const prevCases = prev ? readCases(prev.result_json) : null;
    const prevBy = new Map((prevCases ?? []).map((x) => [caseKey(x.case), x]));
    const after = indexImages(files(row.id));
    const beforeImgs = prev ? indexImages(files(prev.id)) : null;
    const ref = (runId: string, p: string | undefined): FileRef | null => (p ? { run_id: runId, path: p } : null);
    const rows: DatasetRow[] = cases.map((x) => {
      const key = caseKey(x.case);
      const p = prevCases ? prevBy.get(key) : undefined;
      const okBefore = p ? p.ok : null;
      const change: CaseChange = x.actual === null ? 'missing' : okBefore === null ? 'same' : !okBefore && x.ok ? 'better' : okBefore && !x.ok ? 'worse' : 'same';
      const afterImage = ref(row.id, after.overlay.get(key) ?? after.other.get(key));
      const beforeImage = prev && beforeImgs ? ref(prev.id, beforeImgs.overlay.get(key) ?? beforeImgs.other.get(key)) : null;
      const input = ref(row.id, after.input.get(key)) ?? (prev && beforeImgs ? ref(prev.id, beforeImgs.input.get(key)) : null);
      return {
        case: x.case,
        expected: x.expected,
        before: p ? p.actual : null,
        after: x.actual,
        ok_before: okBefore,
        ok_after: x.ok,
        change,
        note: x.note,
        image: input ?? afterImage ?? beforeImage,
        before_image: beforeImage,
        after_image: afterImage,
      };
    });
    const count = (f: (r: DatasetRow) => boolean) => rows.filter(f).length;
    let kept = rows;
    if (rows.length > maxRows) {
      const keep = new Set<number>();
      rows.forEach((r, i) => {
        if (r.change !== 'same' && keep.size < maxRows) keep.add(i);
      });
      rows.forEach((_r, i) => {
        if (keep.size < maxRows) keep.add(i);
      });
      kept = rows.filter((_r, i) => keep.has(i));
    }
    out.push({
      check_id: c.id,
      name: c.name,
      dataset: c.dataset,
      baseline_sha: (c.baseline?.sha ?? prev?.head_sha ?? null)?.slice(0, 7) ?? null,
      run_id: row.id,
      before_run_id: prev?.id ?? null,
      counts: {
        total: rows.length,
        correct_before: prevCases ? count((r) => r.ok_before === true) : null,
        correct_after: count((r) => r.ok_after),
        better: count((r) => r.change === 'better'),
        worse: count((r) => r.change === 'worse'),
        missing: count((r) => r.change === 'missing'),
      },
      rows: kept,
      truncated: kept.length < rows.length,
    });
  }
  return out;
}

// ---- 嘗試記錄 --------------------------------------------------------------------------------------

export interface Attempt {
  /** 1 = the first run of the task */
  n: number;
  run_id: string;
  model: string | null;
  started_at: string;
  finished_at: string | null;
  minutes: number | null;
  /** true 通過 · false 沒過 / 沒完成 · null 進行中 */
  ok: boolean | null;
  /** 「通過」「沒過 單元測試」「沒過 重現（修後仍紅）」「進行中」「中斷」… */
  outcome: string;
}

/** Every run of the task, oldest first, with what its verification found. `rows`: the task's check_runs. */
export function buildAttempts(runs: TaskRun[], checks: FrozenCheck[], rows: CheckRunRow[]): Attempt[] {
  const ordered = runs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => tsMs(a.r.started_at) - tsMs(b.r.started_at) || a.i - b.i)
    .map((x) => x.r);
  return ordered.map((r, i) => {
    const started = tsMs(r.started_at);
    const finished = tsMs(r.finished_at);
    const minutes = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, Math.round((finished - started) / 60_000)) : null;
    const base = { n: i + 1, run_id: r.id, model: r.model ?? null, started_at: r.started_at, finished_at: r.finished_at, minutes };
    if (!r.finished_at) return { ...base, ok: null, outcome: '進行中' };
    const steps = readVerify(r);
    if (steps.length) {
      const bad = steps.find((s) => !s.ok);
      if (!bad) return { ...base, ok: true, outcome: '通過' };
      const id = STEP_CHECK_RE.exec(bad.step)?.[1];
      const check = checks.find((c) => c.id === id || c.name === bad.step.trim());
      let detail = bad.timedOut ? '（逾時）' : '';
      if (check?.kind === 'repro') {
        const own = latestPerCheck(rows, r.id).get(check.id);
        const rr = own ? readRepro(own.result_json) : null;
        if (rr?.before?.ok === true) detail = '（修前就過了）';
        else if (rr?.after && rr.after.ok === false) detail = '（修後仍紅）';
      }
      return { ...base, ok: false, outcome: `沒過 ${stepLabel(bad.step, checks)}${detail}` };
    }
    const outcome = r.interrupted_by === 'user' ? '中止' : r.interrupted_by ? '中斷' : r.error || (r.exit_code !== null && r.exit_code !== 0) ? '沒完成' : '沒有檢查紀錄';
    return { ...base, ok: false, outcome };
  });
}

// ---- 再試一次（換模型） ------------------------------------------------------------------------------

/** The model 再試一次（換模型） would switch to: the next on fix_escalation that is not the current one. */
export function nextEscalation(ladderCsv: string | null | undefined, current: string | null | undefined, step: number | null | undefined): string | null {
  const ladder = (ladderCsv ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const now = (current ?? '').trim();
  for (let i = Math.max(0, step ?? 0); i < ladder.length; i++) if (ladder[i] !== now) return ladder[i]!;
  return null;
}

// ---- 需求 (the analysis card, read-only) ------------------------------------------------------------

export const TICKET_KIND_LABELS: Record<string, string> = { bugfix: '錯誤修復', feature: '功能', perf: '效能', algo: '演算法' };

export interface AnalysisView {
  kind: string | null;
  kind_label: string | null;
  summary: string | null;
  causes: Array<{ file: string; why: string; line: number | null; evidence: string | null }>;
  repro: { command: string | null; note: string | null } | null;
  questions: string[];
}

/** tasks.analysis_json as the 需求 tab shows it; unknown fields are ignored, null when there is none. */
export function readAnalysis(json: string | null | undefined): AnalysisView | null {
  const a = obj(parseJson(json));
  if (!a) return null;
  const kind = str(a.kind);
  const causes: AnalysisView['causes'] = [];
  for (const raw of Array.isArray(a.causes) ? a.causes : []) {
    const c = obj(raw);
    const file = str(c?.file) ?? str(c?.path);
    if (!c || !file) continue;
    causes.push({ file, why: str(c.why) ?? str(c.reason) ?? '', line: num(c.line), evidence: str(c.evidence) ?? str(c.snippet) });
  }
  const r = obj(a.repro);
  const qs = Array.isArray(a.questions) ? a.questions : Array.isArray(a.uncertain) ? a.uncertain : [];
  return {
    kind,
    kind_label: kind ? (TICKET_KIND_LABELS[kind] ?? kind) : null,
    summary: str(a.summary),
    causes: causes.slice(0, 12),
    repro: r ? { command: str(r.command), note: str(r.note) ?? str(r.how) ?? str(r.mode) } : null,
    questions: qs.map((q) => (typeof q === 'string' ? q : str(obj(q)?.q) ?? str(obj(q)?.question) ?? '')).filter(Boolean),
  };
}
