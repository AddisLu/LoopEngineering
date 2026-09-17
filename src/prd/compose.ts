import { bullets, lintPrd, sectionsOf, verifyCommands, type LintDeps, type PrdLint } from './lint.js';

/**
 * PRD Markdown → wizard form. The inverse of web/prd-compose.js `composePrd`, built on the same
 * linter the gate uses, so the wizard can reopen any PRD — its own or a hand-written one — and
 * show the engineer where the fields came from. Lossy for free-form PRDs by design: whatever
 * does not fit a field lands in the raw goal / extra bullets rather than being dropped.
 */

export interface PrdFormFile {
  path: string;
  why: string;
}
export interface PrdFormManual {
  given: string;
  when: string;
  then: string;
}
export interface PrdFormDataset {
  input: string;
  golden: string;
  recipe: string;
  fp_rate: number | null;
  miss: number | null;
  tol: number | null;
  commands: string[];
  requires: string[];
}
export interface PrdForm {
  kind: 'algo' | 'feature' | 'bugfix' | 'perf' | null;
  repo: { path: string; branch: string; module: string | null };
  change: { title: string; symptom: string; expected: string; files: PrdFormFile[]; extra: string[] };
  verify: { commands: string[]; dataset: PrdFormDataset | null; manual: PrdFormManual[]; llm: boolean };
  scope: { non_goals: string[]; constraints: string[]; domain: string; complexity: 'S' | 'M' | 'L'; setup: string[] };
  acceptance: string[];
  markdown_override: string | null;
}

const KIND_BY_LABEL: Record<string, PrdForm['kind']> = { 演算法修正: 'algo', 功能新增: 'feature', 錯誤修復: 'bugfix', 效能: 'perf' };
const DATASET_NOTICE_RE = /圖集只以路徑引用/;
// the composer writes `- （無）` for an empty list so the section is never blank; it is not content
const NONE_RE = /^[（(]\s*(無|none)\s*[）)]$/i;

function splitFence(text: string): { tests: string[]; dataset: string[] } {
  // the composer separates the two groups with `# ---- … ----` comment lines
  const tests: string[] = [];
  const dataset: string[] = [];
  let bucket = tests;
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let sawMarker = false;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    for (const raw of m[1]!.split('\n')) {
      const l = raw.trim();
      if (!l) continue;
      if (/^#\s*----\s*圖集/.test(l)) {
        bucket = dataset;
        sawMarker = true;
        continue;
      }
      if (/^#\s*----\s*測試/.test(l)) {
        bucket = tests;
        sawMarker = true;
        continue;
      }
      if (l.startsWith('#')) continue;
      bucket.push(l.replace(/^\$\s+/, ''));
    }
  }
  if (!sawMarker && tests.length === 0) tests.push(...verifyCommands(text));
  return { tests, dataset };
}

function gwtRow(line: string): PrdFormManual {
  const m = /^Given\s+(.*?)\s+When\s+(.*?)\s+Then\s+(.*)$/i.exec(line);
  return m ? { given: m[1]!, when: m[2]!, then: m[3]! } : { given: '', when: '', then: line };
}

function num(text: string | null, re: RegExp): number | null {
  const m = text ? re.exec(text) : null;
  return m ? Number(m[1]) : null;
}

export function parsePrdToForm(markdown: string, deps: LintDeps = {}): { form: PrdForm; lint: PrdLint } {
  const lint = lintPrd(markdown, deps);
  const f = lint.fields;
  const sec = sectionsOf(markdown);
  const goal = sec.get('goal') ?? '';

  const kind = KIND_BY_LABEL[/改動類型：([^｜\n]+)/.exec(goal)?.[1]?.trim() ?? ''] ?? null;
  const module = /影響模組：([^｜\n]+)/.exec(goal)?.[1]?.trim() ?? null;
  const symptomM = /現況／症狀：(.*)/.exec(goal);
  const expectedM = /期望行為：(.*)/.exec(goal);

  const files: PrdFormFile[] = [];
  const extra: string[] = [];
  for (const b of f.scope) {
    const m = /^`([^`]+)`(?:\s*[:：]\s*(.*))?$/.exec(b);
    if (m) files.push({ path: m[1]!, why: (m[2] ?? '').trim() });
    else extra.push(b);
  }

  const { tests, dataset: dsCmds } = splitFence(sec.get('verify') ?? '');
  const ds = f.dataset;
  const requiresTokens = f.requires ? f.requires.split(',') : [];
  const dataset: PrdFormDataset | null = ds
    ? {
        input: ds.input ?? '',
        golden: ds.golden ?? '',
        recipe: ds.recipe ?? 'DEFAULT',
        fp_rate: num(ds.thresholds, /誤判率\s*[≤<=]+\s*([\d.]+)/),
        miss: num(ds.thresholds, /漏檢\s*[=＝]\s*([\d.]+)/),
        tol: num(ds.thresholds, /容差\s*([\d.]+)/),
        commands: dsCmds,
        requires: requiresTokens.length ? requiresTokens : ['gpu'],
      }
    : null;

  const modes = f.verify_mode ?? [];
  const acceptance = f.acceptance.filter((a) => !(ds && /^Given 圖集 /.test(a)));

  const form: PrdForm = {
    kind,
    repo: { path: f.repo_path ?? '', branch: f.base_branch ?? 'main', module },
    change: {
      title: f.title ?? '',
      symptom: symptomM ? symptomM[1]!.trim() : goal.trim(),
      expected: expectedM ? expectedM[1]!.trim() : '',
      files,
      extra,
    },
    verify: { commands: tests, dataset, manual: f.manual_checks.map(gwtRow), llm: modes.includes('llm') },
    scope: {
      non_goals: f.non_goals.filter((c) => !NONE_RE.test(c)),
      constraints: f.constraints.filter((c) => !DATASET_NOTICE_RE.test(c) && !NONE_RE.test(c)),
      domain: f.domain ?? 'other',
      complexity: f.complexity ?? 'M',
      setup: f.setup_steps,
    },
    acceptance,
    markdown_override: null,
  };
  return { form, lint };
}
