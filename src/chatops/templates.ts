import { KINDS } from '../../web/prd-kinds.js';

/**
 * The work templates of 對話操作 — where the quality comes from. The chat model only collects
 * FACTS (what is wrong, what it should do, how to prove it); each template decides which facts it
 * needs, checks them, and supplies the rest of the PRD (non-goals, constraints, acceptance,
 * verification, domain, size). A fact that is missing or too vague comes back as the exact
 * question to ask, so the model never fills a gap by inventing.
 *
 * algo / bugfix / feature / perf take their PRD defaults from web/prd-kinds.js — the same presets
 * the 工作流程 page uses; spike and epic exist only here.
 */

export type WorkKind = 'algo' | 'bugfix' | 'feature' | 'perf' | 'spike' | 'epic';
export const WORK_KINDS: WorkKind[] = ['algo', 'bugfix', 'feature', 'perf', 'spike', 'epic'];

/** What the chat model collected from the person (ops_prepare_work's arguments). */
export interface WorkFacts {
  kind: WorkKind;
  title: string;
  expected: string;
  symptom?: string;
  repro?: string;
  repo?: string;
  branch?: string;
  files?: string[];
  /** a 驗證方案 name or id, or t_… to reuse that task's verification */
  plan?: string;
  dataset?: string;
  /** verification commands the person gave in this conversation */
  verify?: string[];
  baseline?: string;
  target?: string;
  urls?: string[];
  parts?: string[];
  model?: string;
  size?: 'S' | 'M' | 'L';
  notes?: string[];
}

export interface Missing {
  fact: string;
  question: string;
}

/** Where the verification may come from, in order of preference; see verify.ts. */
export type VerifySource = 'plan' | 'task' | 'user' | 'detected';

export interface WorkTemplate {
  kind: WorkKind;
  label: string;
  /** when to pick this template — read by the chat model */
  when: string;
  /** facts beyond the title and the expectation, each with its check and follow-up question */
  facts: Array<{ fact: keyof WorkFacts; question: string; ok: (f: WorkFacts) => boolean }>;
  verifySources: VerifySource[];
  /** what "verified" must include: a command, or a command or a manual checklist, or nothing (spike) */
  needs: 'command' | 'command_or_manual' | 'none';
  nonGoals: string[];
  constraints: string[];
  acceptance: (f: WorkFacts) => string[];
  manual: (f: WorkFacts) => string[];
  domain: string;
  complexity: 'S' | 'M' | 'L';
  /** task = one task; spike = an evaluation repo (createSpike); epic = the planner splits it */
  flow: 'task' | 'spike' | 'epic';
}

const text = (s: string | undefined | null): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const long = (s: string | undefined | null, n: number): boolean => text(s).replace(/\s/g, '').length >= n;

/** "420 ms", "p95 ≤ 300 ms", "30 fps", "2 倍" → the number and its unit (null when there is none). */
export function measure(s: string | undefined | null): { value: number; unit: string } | null {
  const m = /(-?\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒|%|fps|mb|gb|kb|x|倍)/i.exec(String(s ?? '').normalize('NFKC'));
  if (!m) return null;
  const unit = m[2]!.toLowerCase().replace('毫秒', 'ms').replace('秒', 's');
  return { value: Number(m[1]), unit };
}
const HIGHER_IS_BETTER = new Set(['fps', 'x', '倍']);

/** A target that is actually better than where things are now (same unit, the right direction). */
export function improves(baseline: string | undefined, target: string | undefined): boolean {
  const b = measure(baseline);
  const t = measure(target);
  if (!b || !t) return false;
  if (b.unit !== t.unit) return true; // different units: nothing to compare, the numbers themselves are the point
  return HIGHER_IS_BETTER.has(t.unit) ? t.value > b.value : t.value < b.value;
}

const preset = (k: 'algo' | 'bugfix' | 'feature' | 'perf') => KINDS[k];

export const WORK_TEMPLATES: Record<WorkKind, WorkTemplate> = {
  algo: {
    kind: 'algo',
    label: preset('algo').label,
    when: '判錯／漏檢／誤判：改影像處理或判定規則，要用圖集證明沒有退步',
    facts: [
      { fact: 'symptom', question: '哪一批圖、哪個區域、現在判成什麼？（例：20260615 那批，X 區的亮缺陷被判成暗缺陷）', ok: (f) => long(f.symptom, 10) },
    ],
    verifySources: ['plan', 'task', 'user'],
    needs: 'command',
    nonGoals: preset('algo').nonGoals,
    constraints: preset('algo').constraints,
    acceptance: (f) => [`Given ${text(f.symptom)} When 用修改後的程式重跑 Then ${text(f.expected)}`, ...preset('algo').acceptance],
    manual: () => ['看過圖集比對結果，確認沒有其他缺陷判定改變'],
    domain: preset('algo').domain,
    complexity: preset('algo').complexity,
    flow: 'task',
  },
  bugfix: {
    kind: 'bugfix',
    label: preset('bugfix').label,
    when: '程式錯誤：有明確的重現方式，先寫會失敗的測試再修',
    facts: [
      { fact: 'repro', question: '怎麼重現？給操作步驟，或一個現在會失敗的指令／測試', ok: (f) => long(f.repro, 8) || long(f.symptom, 25) },
    ],
    verifySources: ['plan', 'task', 'user', 'detected'],
    needs: 'command',
    nonGoals: preset('bugfix').nonGoals,
    constraints: preset('bugfix').constraints,
    acceptance: (f) => [
      `Given ${text(f.repro) || text(f.symptom)} When 修正後照同樣步驟執行 Then ${text(f.expected)}`,
      ...preset('bugfix').acceptance,
      'Given 既有測試 When 修正後全部重跑 Then 全數通過',
    ],
    manual: () => [],
    domain: preset('bugfix').domain,
    complexity: preset('bugfix').complexity,
    flow: 'task',
  },
  feature: {
    kind: 'feature',
    label: preset('feature').label,
    when: '多一個功能或畫面：要有具體例子、測試，也要有人看過一眼',
    facts: [
      { fact: 'symptom', question: '給一個具體例子：在什麼情況下、使用者做什麼、應該看到什麼？', ok: (f) => long(f.symptom, 10) || long(f.repro, 10) },
    ],
    verifySources: ['plan', 'task', 'user', 'detected'],
    needs: 'command_or_manual',
    nonGoals: preset('feature').nonGoals,
    constraints: preset('feature').constraints,
    acceptance: (f) => [`Given ${text(f.symptom) || text(f.repro)} When 使用新功能 Then ${text(f.expected)}`, 'Given 既有測試 When 修改後全部重跑 Then 全數通過'],
    manual: (f) => [`實際操作一次：${text(f.expected).slice(0, 80)}`],
    domain: preset('feature').domain,
    complexity: preset('feature').complexity,
    flow: 'task',
  },
  perf: {
    kind: 'perf',
    label: preset('perf').label,
    when: '要更快、更省，但結果不能變：現況與目標都要是數字',
    facts: [
      { fact: 'baseline', question: '現在大約多少？寫數字和單位（例：單張 420 ms）', ok: (f) => measure(f.baseline) !== null },
      { fact: 'target', question: '目標寫數字和單位（例：p95 ≤ 300 ms）', ok: (f) => measure(f.target) !== null },
      { fact: 'target', question: '目標要比現況好（例：現況 420 ms → 目標 300 ms）', ok: (f) => !measure(f.baseline) || !measure(f.target) || improves(f.baseline, f.target) },
    ],
    verifySources: ['plan', 'task', 'user'],
    needs: 'command',
    nonGoals: preset('perf').nonGoals,
    constraints: preset('perf').constraints,
    acceptance: (f) => [
      `Given 同一組資料 When 修改前後各量一次 Then 從 ${text(f.baseline)} 進步到 ${text(f.target)}`,
      'Given 同一組輸入 When 修改前後各跑一次 Then 輸出結果 bit-exact 一致',
    ],
    manual: () => [],
    domain: preset('perf').domain,
    complexity: preset('perf').complexity,
    flow: 'task',
  },
  spike: {
    kind: 'spike',
    label: '外部專案評估',
    when: '想知道一個 GitHub 專案、套件或方法能不能用：另開實驗 repo 裝起來試，寫一份報告',
    facts: [
      { fact: 'urls', question: '要評估的專案網址是？', ok: (f) => (f.urls ?? []).some((u) => /^https?:\/\//.test(u)) },
      { fact: 'expected', question: '要回答什麼問題、怎樣算有結論？（例：能不能在 8192×5000 上 10 ms 內跑完）', ok: (f) => long(f.expected, 15) },
    ],
    verifySources: [],
    needs: 'none',
    nonGoals: ['不改任何既有軟體，只在實驗 repo 裡試'],
    constraints: ['結論寫進 REPORT.md：能不能用、怎麼量的、數字、限制'],
    acceptance: () => [],
    manual: () => [],
    domain: 'other',
    complexity: 'M',
    flow: 'spike',
  },
  epic: {
    kind: 'epic',
    label: '拆成多個任務',
    when: '一件大工作：由 AI 拆成 2–6 個依序執行、各自能驗證的子任務',
    facts: [
      { fact: 'parts', question: '要拆成哪幾塊？列 2–6 項（例：1. 先量現況 2. 改 kernel 3. 加回歸測試）', ok: (f) => (f.parts ?? []).filter((p) => long(p, 2)).length >= 2 },
      { fact: 'expected', question: '全部做完後應該怎樣？至少一兩句（30 字左右）', ok: (f) => long(f.expected, 20) },
    ],
    verifySources: ['plan', 'task', 'user', 'detected'],
    needs: 'command',
    nonGoals: ['不做與目標無關的重構、改名或格式調整'],
    constraints: ['每一個子任務都要能單獨驗證、單獨合併'],
    acceptance: (f) => [`Given 全部子任務結案 When 照期望檢查 Then ${text(f.expected)}`],
    manual: () => [],
    domain: 'other',
    complexity: 'L',
    flow: 'epic',
  },
};

/** The facts this template still needs — each with the question to ask, in one pass. */
export function missingFacts(f: WorkFacts): Missing[] {
  const t = WORK_TEMPLATES[f.kind];
  const out: Missing[] = [];
  if (!long(f.title, 2)) out.push({ fact: 'title', question: '一句話說這次要做什麼（標題）' });
  if (!long(f.expected, 8) && !t.facts.some((x) => x.fact === 'expected')) out.push({ fact: 'expected', question: '改好之後應該怎樣？寫得出數字就寫數字' });
  for (const x of t.facts) {
    if (!x.ok(f) && !out.some((m) => m.fact === x.fact)) out.push({ fact: String(x.fact), question: x.question });
  }
  return out;
}

/** One line per template for ops_templates: what it is for and what the person will be asked. */
export function templateLines(): string[] {
  return WORK_KINDS.map((k) => {
    const t = WORK_TEMPLATES[k];
    const asks = t.facts.map((x) => x.fact).filter((v, i, a) => a.indexOf(v) === i);
    return `- ${k}（${t.label}）：${t.when}${asks.length ? `；必問：${asks.join('、')}` : ''}`;
  });
}
