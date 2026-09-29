import { execFileSync } from 'node:child_process';

/**
 * 驗收指標 + 保護路徑: acceptance the ENGINE checks, so an unattended implementer cannot talk its way
 * past it.
 *
 * - A verify step (typically the image-library evaluation, `sandbox@aoi-gpu: python3 eval.py …`)
 *   prints one line `LOOP_METRICS {"detection_rate":0.991,"false_positive_rate":0.004,"miss":0}`.
 *   The task's acceptance_metrics ("detection_rate >= 0.98; false_positive_rate <= 0.01; miss == 0")
 *   come from the PRD — written by a person / the high-end model, stored on the task, never in the
 *   repo — and the engine compares. Falling short fails verification like a failing step: the agent
 *   is resumed with the table and tries again.
 * - protected_paths (globs, e.g. scripts/eval/**, data/golden/**) must be unchanged versus the base:
 *   the implementer may not "fix" the evaluation instead of the algorithm.
 */

export class AcceptanceError extends Error {}

export type MetricOp = '>=' | '<=' | '>' | '<' | '==' | '!=';

export interface MetricSpec {
  name: string;
  op: MetricOp;
  target: number;
}

export interface MetricCheck extends MetricSpec {
  actual: number | null;
  pass: boolean;
}

export interface MetricsReport {
  /** everything the steps reported, including metrics no threshold mentions */
  values: Record<string, number | string>;
  checks: MetricCheck[];
  pass: boolean;
}

const SPEC_RE = /^([A-Za-z_][\w.-]*)\s*(>=|<=|==|!=|>|<|≥|≤|=)\s*(-?\d+(?:\.\d+)?)\s*%?$/;
const OP_ALIAS: Record<string, MetricOp> = { '≥': '>=', '≤': '<=', '=': '==' };

/** "detection_rate >= 0.98; miss == 0" (also `,` or newlines, ≥ ≤ =) → specs. Throws on anything else. */
export function parseAcceptance(text: string | null | undefined): MetricSpec[] {
  const out: MetricSpec[] = [];
  for (const raw of (text ?? '').split(/[;,\n]/)) {
    const part = raw.replace(/^\s*[-*]\s*/, '').trim();
    if (!part) continue;
    const m = SPEC_RE.exec(part);
    if (!m) throw new AcceptanceError(`看不懂的驗收指標：「${part}」（格式：名稱 >= 數字，例如 detection_rate >= 0.98）`);
    out.push({ name: m[1]!, op: OP_ALIAS[m[2]!] ?? (m[2] as MetricOp), target: Number(m[3]) });
  }
  return out;
}

export function formatSpecs(specs: MetricSpec[]): string {
  return specs.map((s) => `${s.name} ${s.op} ${s.target}`).join('; ');
}

const METRICS_LINE = /^\s*LOOP_METRICS\s+(\{.*\})\s*$/gm;

/** Every `LOOP_METRICS {json}` line across the outputs, merged in order (a later value wins). */
export function extractMetrics(outputs: string[]): Record<string, number | string> {
  const values: Record<string, number | string> = {};
  for (const text of outputs) {
    for (const m of text.matchAll(METRICS_LINE)) {
      let obj: unknown;
      try {
        obj = JSON.parse(m[1]!);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
        else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) values[k] = Number(v);
        else if (typeof v === 'string') values[k] = v.slice(0, 200);
      }
    }
  }
  return values;
}

function compare(actual: number, op: MetricOp, target: number): boolean {
  const eps = 1e-12;
  switch (op) {
    case '>=':
      return actual >= target - eps;
    case '<=':
      return actual <= target + eps;
    case '>':
      return actual > target;
    case '<':
      return actual < target;
    case '==':
      return Math.abs(actual - target) <= eps;
    case '!=':
      return Math.abs(actual - target) > eps;
  }
}

export function evaluateAcceptance(specs: MetricSpec[], values: Record<string, number | string>): MetricsReport {
  const checks = specs.map((s) => {
    const v = values[s.name];
    const actual = typeof v === 'number' ? v : null;
    return { ...s, actual, pass: actual !== null && compare(actual, s.op, s.target) };
  });
  return { values, checks, pass: checks.every((c) => c.pass) };
}

/** The table an agent (resume context), a PR body and the morning report all show. */
export function formatAcceptance(r: MetricsReport): string {
  const rows = r.checks.map((c) => `${c.pass ? '✅' : '❌'} ${c.name} = ${c.actual ?? '（沒有輸出）'}，要求 ${c.op} ${c.target}`);
  const missing = r.checks.filter((c) => c.actual === null).map((c) => c.name);
  if (missing.length) {
    rows.push(`驗證步驟沒有輸出 ${missing.join('、')}：評估程式要印出一行 LOOP_METRICS {"${missing[0]}": 數值, …}（放在輸出的最後）。`);
  }
  return rows.join('\n');
}

// ---- protected paths ----------------------------------------------------------------------------

/** git-style glob → RegExp: `**` any depth, `*` within a segment, `?` one char; a bare dir name
 * or `dir/` protects everything under it. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '').replace(/^\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') i++;
        re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // a pattern without wildcards also covers everything below it (a directory)
  return /[*?]/.test(g) ? new RegExp(`^${re}$`) : new RegExp(`^${re}(/.*)?$`);
}

export function parseProtected(csv: string | null | undefined): string[] {
  return (csv ?? '')
    .split(/[,\n]/)
    .map((s) => s.replace(/^\s*[-*]\s*/, '').trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
}

export type GitRun = (cwd: string, args: string[]) => string;
const realGit: GitRun = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 });

/** Files changed on the branch versus `baseRef` (committed + anything still in the tree) that match. */
export function protectedViolations(worktree: string, baseRef: string, globs: string[], git: GitRun = realGit): string[] {
  if (!globs.length) return [];
  const res = globs.map(globToRegExp);
  const changed = new Set<string>();
  for (const f of git(worktree, ['diff', '--name-only', `${baseRef}...HEAD`]).split('\n')) if (f.trim()) changed.add(f.trim());
  // uncommitted edits (tracked and new files) count too
  for (const line of git(worktree, ['status', '--porcelain', '--untracked-files=all']).split('\n')) {
    const f = line.slice(3).trim().replace(/^"|"$/g, '');
    if (f) changed.add(f.includes(' -> ') ? f.split(' -> ')[1]! : f);
  }
  return [...changed].filter((f) => res.some((r) => r.test(f))).sort();
}
