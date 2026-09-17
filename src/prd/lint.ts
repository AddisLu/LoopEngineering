import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BENCH_DOMAINS } from '../benchmark/store.js';
import { paths, type Complexity } from '../config.js';

/**
 * Deterministic PRD linter — the first half of the PRD gate (review.ts is the second). A PRD
 * handed to a local model must be self-sufficient: the model runs unattended and cannot ask
 * questions, so every structural gap is a hard block, reported in plain Chinese per section.
 * Section headings are matched by alias (zh/en), in any order. See seed/prd-template.md.
 */

export interface PrdDataset {
  /** directory of input images — referenced by path, never copied */
  input: string | null;
  /** expected results: a dir of *_ResultInfo.json or a labels file */
  golden: string | null;
  recipe: string | null;
  /** free text, e.g. 誤判率 ≤ 1%；漏檢 = 0；GL_Mean 容差 0.5 */
  thresholds: string | null;
}

export interface PrdFields {
  title: string | null;
  goal: string;
  scope: string[];
  non_goals: string[];
  acceptance: string[];
  verify_steps: string[];
  repo_path: string | null;
  base_branch: string | null;
  domain: string | null;
  complexity: Complexity | null;
  constraints: string[];
  // ---- optional sections written by the PRD wizard (web/prd-compose.js); absent = old behaviour
  /** 圖集比對: algorithm changes verified against an image set */
  dataset: PrdDataset | null;
  /** 人工驗收: Given/When/Then lines a human ticks off (task runs with verify_mode manual) */
  manual_checks: string[];
  /** 驗證方式: explicit verify_mode tokens; null = derive from the sections present */
  verify_mode: string[] | null;
  /** 需求能力: host capabilities the verification needs, e.g. gpu (CSV as stored on the task) */
  requires: string | null;
  /** 前置指令: build/install commands run before the agent starts (task.setup_cmd) */
  setup_steps: string[];
}

export const VERIFY_MODES = ['command', 'llm', 'manual'] as const;

export interface PrdLint {
  ok: boolean;
  missing: string[];
  warnings: string[];
  fields: PrdFields;
}

export interface LintDeps {
  exists?: (p: string) => boolean;
}

export type SectionKey =
  | 'non_goals'
  | 'manual'
  | 'verify_mode'
  | 'dataset'
  | 'requires'
  | 'setup'
  | 'goal'
  | 'scope'
  | 'acceptance'
  | 'verify'
  | 'repo'
  | 'domain'
  | 'complexity'
  | 'constraints';

// Order matters — matching is by substring, so every heading that CONTAINS another section's
// alias must come first: '非範圍' ⊃ '範圍', 'non-goals' ⊃ 'goal', '人工驗收' ⊃ '驗收',
// '驗證方式' ⊃ '驗證', 'verify mode' ⊃ 'verify'. A unit test pins every entry.
const ALIASES: [SectionKey, string[]][] = [
  ['non_goals', ['非範圍', 'non-goal', 'non goal', 'out of scope', '不做']],
  ['manual', ['人工驗收', '人工檢查', 'manual check', 'manual verification']],
  ['verify_mode', ['驗證方式', 'verify mode', 'verify_mode']],
  ['dataset', ['圖集比對', '圖集', 'dataset', 'image set']],
  ['requires', ['需求能力', 'requires', 'capabilit']],
  ['setup', ['前置指令', 'setup']],
  ['goal', ['目標', 'goal', 'objective', '目的']],
  ['scope', ['範圍', 'scope']],
  ['acceptance', ['驗收', 'acceptance']],
  ['verify', ['驗證', 'verify', 'verification', 'test command', '測試指令']],
  ['repo', ['repo', 'repository', '儲存庫', '程式庫']],
  ['domain', ['領域', 'domain']],
  ['complexity', ['複雜度', 'complexity']],
  ['constraints', ['限制', 'constraint', '約束']],
];

const LABEL: Record<SectionKey, string> = {
  goal: '目標',
  scope: '範圍',
  non_goals: '非範圍',
  acceptance: '驗收標準',
  verify: '驗證指令',
  repo: 'Repo',
  domain: '領域',
  complexity: '複雜度',
  constraints: '限制',
  manual: '人工驗收',
  verify_mode: '驗證方式',
  dataset: '圖集比對',
  requires: '需求能力',
  setup: '前置指令',
};

// Unfilled template text: <中文佔位>, <UPPER_CASE>, TODO / TBD / 待補.
const PLACEHOLDER = /<[^<>\n]*[㐀-鿿][^<>\n]*>|<[A-Z][A-Z0-9 _-]{2,}>|\bTODO\b|\bTBD\b|待補/;

export function sectionKey(heading: string): SectionKey | null {
  const h = heading.toLowerCase();
  for (const [key, aliases] of ALIASES) if (aliases.some((a) => h.includes(a))) return key;
  return null;
}

/** `## heading` → body, first occurrence wins; comments stripped. Shared with compose.ts. */
export function sectionsOf(markdown: string): Map<SectionKey, string> {
  const md = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n');
  const sections = new Map<SectionKey, string>();
  const parts = md.split(/^##\s+(.+)$/m); // [pre, heading1, body1, heading2, body2, …]
  for (let i = 1; i < parts.length; i += 2) {
    const key = sectionKey(parts[i]!);
    if (key && !sections.has(key)) sections.set(key, (parts[i + 1] ?? '').trim());
  }
  return sections;
}

/** `- 標籤: 值` bullets → value, matching the label loosely (zh or en). */
function labelled(text: string, labels: string[]): string | null {
  for (const b of bullets(text)) {
    const m = b.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (!m) continue;
    const key = m[1]!.trim().toLowerCase();
    if (labels.some((l) => key.includes(l))) return m[2]!.trim().replace(/[`，,]+$/, '');
  }
  return null;
}

export function bullets(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)?.[1] ?? null)
    .filter((b): b is string => b !== null)
    .map((b) => b.replace(/^\[[ xX]\]\s*/, '').trim())
    .filter(Boolean);
}

export function verifyCommands(text: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let hadFence = false;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    hadFence = true;
    for (const line of m[1]!.split('\n')) {
      const l = line.trim();
      if (l && !l.startsWith('#')) out.push(l.replace(/^\$\s+/, ''));
    }
  }
  if (!hadFence) for (const b of bullets(text)) out.push((b.match(/^`([^`]+)`/)?.[1] ?? b).trim());
  return out.filter(Boolean);
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function lintPrd(markdown: string, deps: LintDeps = {}): PrdLint {
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const md = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n');
  const missing: string[] = [];
  const warnings: string[] = [];

  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const sections = sectionsOf(md);
  const sec = (k: SectionKey) => sections.get(k) ?? '';

  if (!title) missing.push('缺少標題：第一行用「# 標題」');
  else if (PLACEHOLDER.test(title)) missing.push('標題還是範本的佔位文字');

  const goal = sec('goal');
  if (goal.replace(/\s+/g, '').length < 15) missing.push('「目標」段落缺少或太短：用一兩句話說清楚要達成什麼、為什麼');

  const scope = bullets(sec('scope'));
  if (!sections.has('scope') || scope.length === 0) missing.push('「範圍」至少列一項要做的事（具體到檔案／函式／API）');
  const nonGoals = bullets(sec('non_goals'));
  if (!sections.has('non_goals') || nonGoals.length === 0) missing.push('「非範圍」至少列一項明確不做的事（避免本地模型越做越多）');
  const acceptance = bullets(sec('acceptance'));
  if (acceptance.length === 0) missing.push('「驗收標準」至少一條可驗證的條件');

  // ---- the optional wizard sections ------------------------------------------
  const manualChecks = bullets(sec('manual')).filter((c) => !PLACEHOLDER.test(c));
  let verifyMode: string[] | null = null;
  if (sections.has('verify_mode')) {
    verifyMode = sec('verify_mode')
      .split(/[\s,，、]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const bad = verifyMode.filter((m) => !(VERIFY_MODES as readonly string[]).includes(m));
    if (bad.length || verifyMode.length === 0) missing.push('「驗證方式」只能是 command / llm / manual（可用逗號並列）');
  }

  const verify = verifyCommands(sec('verify'));
  // Effective modes decide whether commands are mandatory: a PRD verified purely by a human
  // checklist runs as verify_mode=manual and legitimately has no commands (validateTask agrees).
  const effective = verifyMode ?? [...(verify.length ? ['command'] : []), ...(manualChecks.length ? ['manual'] : [])];
  const manualOnly = effective.length === 1 && effective[0] === 'manual';
  if (verify.length === 0 && !manualOnly) missing.push('「驗證指令」至少一條可執行的指令（放在 ```bash 區塊）');
  else if (verify.some((c) => PLACEHOLDER.test(c) || /^<.*>$/.test(c))) missing.push('「驗證指令」還有未填的佔位符');

  let dataset: PrdDataset | null = null;
  if (sections.has('dataset')) {
    const ds = sec('dataset');
    dataset = {
      input: labelled(ds, ['輸入圖集', '圖集', 'input', 'images']),
      golden: labelled(ds, ['期望結果', 'golden', 'expected', '基準']),
      recipe: labelled(ds, ['配方', 'recipe']),
      thresholds: labelled(ds, ['門檻', 'threshold']),
    };
    if (dataset.input) dataset.input = expandHome(dataset.input.replace(/（.*）$/, '').trim());
    if (dataset.golden) dataset.golden = expandHome(dataset.golden.replace(/（.*）$/, '').trim());
    if (!dataset.input || PLACEHOLDER.test(dataset.input)) missing.push('「圖集比對」缺少「輸入圖集」的路徑');
    else if (!exists(dataset.input)) missing.push(`圖集路徑不存在：${dataset.input}`);
    else if (dataset.input.startsWith(paths.dataDir)) warnings.push('圖集放在 Loop 資料目錄底下——圖集應留在原地、只以路徑引用');
    if (dataset.golden && !PLACEHOLDER.test(dataset.golden) && !exists(dataset.golden)) missing.push(`期望結果路徑不存在：${dataset.golden}`);
  }

  const setupSteps = verifyCommands(sec('setup'));
  if (setupSteps.some((c) => PLACEHOLDER.test(c) || /^<.*>$/.test(c))) missing.push('「前置指令」還有未填的佔位符');

  let requires: string | null = null;
  if (sections.has('requires')) {
    const tokens = sec('requires')
      .split(/[\s,，、]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== '（無）' && s !== '(none)' && s !== 'none');
    if (tokens.some((x) => !/^[a-z0-9:_.-]+$/.test(x))) missing.push('「需求能力」只能是像 gpu、camera、os:windows 這樣的代號（逗號分隔）');
    requires = tokens.length ? tokens.join(',') : null;
  }

  for (const k of ['goal', 'scope', 'non_goals', 'acceptance'] as const) {
    if (sections.has(k) && PLACEHOLDER.test(sec(k))) missing.push(`「${LABEL[k]}」還有未填的佔位內容（<…>／TODO／TBD）`);
  }

  const repoText = sec('repo');
  let repoPath =
    repoText.match(/(?:path|路徑)\s*[:：]\s*(\S+)/i)?.[1] ?? repoText.match(/(?:^|\s)((?:~|\/)[^\s`]*)/)?.[1] ?? null;
  const baseBranch = repoText.match(/(?:branch|分支)\s*[:：]\s*(\S+)/i)?.[1] ?? null;
  if (repoPath) repoPath = expandHome(repoPath.replace(/[`，,]+$/, ''));
  if (!repoPath || PLACEHOLDER.test(repoText.split('\n').find((l) => /path|路徑/i.test(l)) ?? repoPath)) {
    missing.push('「Repo」缺少 path（主機上的 repo 絕對路徑）');
    repoPath = repoPath && !PLACEHOLDER.test(repoPath) ? repoPath : null;
  } else if (!exists(repoPath)) {
    missing.push(`Repo 路徑不存在：${repoPath}`);
  }
  if (!baseBranch) warnings.push('Repo 未指定 branch，預設 main');

  const domainRaw = sec('domain').split(/\s+/)[0]?.toLowerCase() ?? '';
  const domain = (BENCH_DOMAINS as readonly string[]).includes(domainRaw) ? domainRaw : null;
  if (!domain) missing.push(`「領域」必須是 ${BENCH_DOMAINS.join(' / ')} 其中之一`);

  const cx = sec('complexity').match(/\b([SML])\b/)?.[1] as Complexity | undefined;
  if (!cx) warnings.push('未指定「複雜度」，預設 M');

  const constraints = bullets(sec('constraints')).filter((c) => !PLACEHOLDER.test(c));

  return {
    ok: missing.length === 0,
    missing,
    warnings,
    fields: {
      title: title && !PLACEHOLDER.test(title) ? title : null,
      goal,
      scope,
      non_goals: nonGoals,
      acceptance,
      verify_steps: verify,
      repo_path: repoPath,
      base_branch: baseBranch,
      domain,
      complexity: cx ?? null,
      constraints,
      dataset,
      manual_checks: manualChecks,
      verify_mode: verifyMode,
      requires,
      setup_steps: setupSteps,
    },
  };
}
