/**
 * Skywork-grade quality gate for weekly PPTX status content (T3): a cheap haiku polish
 * pass (grammar/redundancy/single-line compression) followed by an llm_judge_model
 * rubric score. Both stages are best-effort — polish failure returns the original items
 * untouched, judge failure/uncertainty resolves to an *inconclusive pass* (mirrors
 * orchestrator/judge.ts's "never auto-fail on inconclusive" spirit, but flipped: this
 * gate defaults to shipping rather than blocking, leaning on quality_flags + human
 * review as the backstop). Neither stage ever throws.
 */
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getNum, getSetting } from '../../db/index.js';
import { readUsage } from '../../token/usage.js';
import { mdInline } from '../../knowledge/context.js';
import type { ExplainPage } from './spec.js';
import type { StatusCandidate } from './diff.js';
import { defaultContentExec, type ContentExec } from './status.js';

// Cached at module scope (computed once): mirrors status.ts's/report/generate.ts's hasClaudeCli.
let claudeCliCache: boolean | null = null;

function hasClaudeCli(): boolean {
  if (claudeCliCache === null) {
    try {
      execFileSync('which', ['claude'], { stdio: 'ignore' });
      claudeCliCache = true;
    } catch {
      claudeCliCache = false;
    }
  }
  return claudeCliCache;
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:[a-zA-Z]*)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? trimmed).trim();
}

function buildPolishPrompt(items: StatusCandidate[], maxItemChars: number): string {
  const list = items.map((it, i) => `${i + 1}. ${mdInline(it.text)}`).join('\n');
  return [
    `# 週報 status 潤稿`,
    `## 待潤稿項目\n${list}`,
    `## 指示\n修正語法、贅字，壓縮到單行不超過 ${maxItemChars} 字（語意濃縮優先於截斷）；黑/藍/紅語意相關用詞（延續中／新進度／需關注）維持一致。語意未變的項目盡量保留原本措辭，避免被誤判為新項目。項目數量與順序不得改變，只回傳文字內容。\n\n` +
      `Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:\n{"items":[{"text":"..."}]}`,
  ].join('\n\n');
}

/** items.length must match expectedCount and every entry must have non-empty text —
 * anything else is treated as a failed polish (caller falls back to the original items). */
function parsePolishOutput(text: string, expectedCount: number): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    return null;
  }
  const raw = (parsed as { items: unknown[] }).items;
  if (raw.length !== expectedCount) return null;
  const texts: string[] = [];
  for (const r of raw) {
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
    const t = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
    if (!t) return null;
    texts.push(t);
  }
  return texts;
}

/**
 * One cheap haiku call (model fixed 'haiku' — mirrors knowledge/distill.ts's cheap-step
 * convention, not the configurable report_pptx_model/llm_judge_model settings) that
 * fixes grammar/redundancy and compresses each item to one line. Preserves
 * `highlight`/`sources` exactly — only `text` is ever replaced, and only when the
 * response parses cleanly with the same item count. Guarded like generateStatusCandidates
 * (`!exec` before the host CLI probe, then the usage hard limit); any failure anywhere
 * (no exec/CLI, over budget, exec throws/returns null, unparseable/mismatched output)
 * returns `items` unchanged — polish is strictly best-effort, never a hard requirement.
 */
export async function polishItems(
  db: Database.Database,
  items: StatusCandidate[],
  maxItemChars: number,
  exec?: ContentExec,
): Promise<StatusCandidate[]> {
  if (!items.length) return items;
  if (!exec && !hasClaudeCli()) return items;
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  if (readUsage().session.percent >= hardLimit) return items;

  const run: ContentExec = exec ?? defaultContentExec;
  try {
    const out = await run(buildPolishPrompt(items, maxItemChars), 'haiku');
    if (!out) return items;
    const texts = parsePolishOutput(out, items.length);
    if (!texts) return items;
    return items.map((it, i) => ({ ...it, text: texts[i] ?? it.text }));
  } catch {
    return items;
  }
}

export interface QualityVerdict {
  pass: boolean;
  score: number;
  feedback: string;
}

/** `judge inconclusive` — used for every guard/failure path. Deliberately `pass:true`
 * (opposite direction from orchestrator/judge.ts's `pass:null`-inconclusive, which the
 * caller there routes to a manual gate): an unavailable judge must never block shipping
 * the deck, it just forfeits its say and leans on quality_flags + human review instead. */
const INCONCLUSIVE: QualityVerdict = { pass: true, score: -1, feedback: 'judge inconclusive' };

export interface JudgeDeckContentInput {
  projectName: string;
  items: StatusCandidate[];
  explainPages: ExplainPage[];
  changedWpCount: number;
}

function sourceLabel(item: StatusCandidate): string {
  if (!item.sources?.length) return '（無）';
  return item.sources.map((s) => ('wp' in s ? `wp:${s.wp}` : 'commit' in s ? `commit:${s.commit}` : `node:${s.node}`)).join(',');
}

function buildJudgePrompt(input: JudgeDeckContentInput): string {
  const itemList = input.items.length
    ? input.items.map((it, i) => `${i + 1}. ${mdInline(it.text)}（sources: ${sourceLabel(it)}）`).join('\n')
    : '（無 status 項目）';

  const explainList = input.explainPages.length
    ? input.explainPages.map((p, i) => `${i + 1}. ${mdInline(p.title)}：${mdInline(p.note)}`).join('\n')
    : '（本週無說明頁）';

  return [
    `# 週報內容品質評分 — ${mdInline(input.projectName)}`,
    `## 待評分 status 項目(本週偵測到 ${input.changedWpCount} 筆 WP 變動)\n${itemList}`,
    `## 待評分說明頁\n${explainList}`,
    `## 評分規則(rubric，全數符合才 pass:true)\n` +
      `(a) 是否綜合本週多筆變動而非照抄單一 WP 標題\n` +
      `(b) 提到問題/風險時是否附對策\n` +
      `(c) 每項是否單行且在長度限制內\n` +
      `(d) 是否附上可追溯的 sources\n` +
      `(e) 說明頁選材是否為本週最有影響力的新產出（無說明頁時此項不扣分）\n\n` +
      `Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:\n` +
      `{"pass": true|false, "score": 0-100, "feedback": "..."}`,
  ].join('\n\n');
}

function parseQualityVerdict(text: string): QualityVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { pass?: unknown }).pass !== 'boolean') {
    return null;
  }
  const o = parsed as { pass: boolean; score?: unknown; feedback?: unknown };
  const score = typeof o.score === 'number' && Number.isFinite(o.score) ? Math.max(0, Math.min(100, Math.round(o.score))) : 0;
  const feedback = typeof o.feedback === 'string' ? o.feedback.trim() : '';
  return { pass: o.pass, score, feedback };
}

/**
 * Rubric-scored quality gate over one project's generated status items (+ explain-page
 * selection, when any). Model resolves `llm_judge_model` -> 'haiku' (judge.ts's exact
 * convention). Guarded the same way as generateStatusCandidates; any guard trip or
 * unparseable output resolves to INCONCLUSIVE (pass:true) rather than throwing or
 * blocking — see INCONCLUSIVE's doc comment for why this is the opposite default from
 * orchestrator/judge.ts.
 */
export async function judgeDeckContent(
  db: Database.Database,
  input: JudgeDeckContentInput,
  exec?: ContentExec,
): Promise<QualityVerdict> {
  if (!exec && !hasClaudeCli()) return INCONCLUSIVE;
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  if (readUsage().session.percent >= hardLimit) return INCONCLUSIVE;

  const run: ContentExec = exec ?? defaultContentExec;
  const model = getSetting(db, 'llm_judge_model') || 'haiku';
  try {
    const out = await run(buildJudgePrompt(input), model);
    if (!out) return INCONCLUSIVE;
    const verdict = parseQualityVerdict(out);
    return verdict ?? INCONCLUSIVE;
  } catch {
    return INCONCLUSIVE;
  }
}
