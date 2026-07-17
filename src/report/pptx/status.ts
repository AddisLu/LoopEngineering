/**
 * LLM status-item candidate generation for the weekly PPTX deck (T3). LLM boundary is
 * JSON-only: this module never decides color (see diff.ts's classifyStatusItems — the
 * only path to 'red' is a human/agent-set highlight, carried through here purely as a
 * suggestion) and never invents numbers (WP data is fetched structurally, only prose is
 * synthesized). Any failure anywhere in the pipeline (usage guard, no CLI, exec throws/
 * returns null, unparseable output) degrades to `{items: [], usedLlm: false}` — the
 * caller (weekly.ts) treats an empty result as "no candidate for this project", which
 * assembleDeckSpec falls back to carrying last week's items forward verbatim (T2's
 * existing all-black-carryover behavior). The deck must never ship blank over an LLM hiccup.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getNum, getSetting } from '../../db/index.js';
import { readUsage } from '../../token/usage.js';
import { mdInline } from '../../knowledge/context.js';
import type { OpWorkPackage } from '../opdata.js';
import type { SourceRef } from './spec.js';
import type { StatusCandidate } from './diff.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 90_000;
const MAX_ITEMS = 2;
const DEFAULT_BUDGET_CHARS = 4000;

export type ContentExec = (prompt: string, model: string) => Promise<string | null>;

// Cached at module scope (computed once): mirrors src/report/generate.ts's hasClaudeCli.
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

/** Real one-shot content-generation call: `claude -p <prompt> --model X --output-format
 * text`, mirrors report/generate.ts's defaultSynthExec (90s timeout — cheaper than the
 * 3-minute report-synthesis budget since this prompt is much smaller). Exported so
 * quality.ts's polish/judge calls share the exact same spawn convention. */
export async function defaultContentExec(prompt: string, model: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', model, '--output-format', 'text'],
      { timeout: TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Union of: WP newly opened (absent from prevWps), WP whose is_closed flipped since
 * prevWps, and WP whose updated_at is newer than its prevWps counterpart. No prior
 * snapshot at all (prevWps===null, e.g. first week) -> every current WP counts as
 * changed. Preserves currentWps's order.
 */
export function detectChangedWps(currentWps: OpWorkPackage[], prevWps: OpWorkPackage[] | null): OpWorkPackage[] {
  if (prevWps === null) return currentWps;
  const prevById = new Map<string, OpWorkPackage>();
  for (const wp of prevWps) prevById.set(String(wp.id), wp);
  return currentWps.filter((wp) => {
    const prev = prevById.get(String(wp.id));
    if (!prev) return true;
    if (prev.is_closed !== wp.is_closed) return true;
    if (wp.updated_at && prev.updated_at && wp.updated_at > prev.updated_at) return true;
    return false;
  });
}

function renderWpLine(wp: OpWorkPackage): string {
  const due = wp.due_date || '未定';
  const closed = wp.is_closed ? '/已結案' : '';
  return `- [wp:${wp.id}] **${mdInline(wp.subject)}**（${mdInline(wp.status)}${closed}, ${wp.percent_done}%）交期:${due}`;
}

/** Greedy-pack changed WPs into a char budget, mirrors report/generate.ts's packItems. */
function packWps(wps: OpWorkPackage[], budget: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const wp of wps) {
    const line = renderWpLine(wp);
    if (lines.length === 0) {
      const first = line.length <= budget ? line : line.slice(0, Math.max(0, budget));
      lines.push(first);
      used = first.length;
      continue;
    }
    const addLen = line.length + 1;
    if (used + addLen > budget) break;
    lines.push(line);
    used += addLen;
  }
  return lines.join('\n');
}

export interface BuildStatusPromptInput {
  projectName: string;
  changedWps: OpWorkPackage[];
  allOpenWps: OpWorkPackage[];
  prevItems: string[];
  maxItemChars: number;
  /** greedy-pack budget for the changedWps section; defaults to DEFAULT_BUDGET_CHARS
   * (callers normally pass the report_budget_chars setting through here). */
  budgetChars?: number;
  /** judge feedback from a failed quality gate — when present, asks the LLM to fix the
   * named problems on this regeneration pass (see quality.ts's regenerate loop). */
  feedback?: string;
}

/**
 * Builds the STRICT-JSON status-generation prompt (Traditional Chinese instructions):
 * changedWps summary (greedy-packed) + last week's status text (so continuing work can
 * reuse the same wording and diff to black) + explicit synthesis/countermeasure/output
 * rules. `allOpenWps` is accepted for future use (broader context) but not yet packed
 * into the prompt — changedWps is the deliberate signal for "what's worth reporting".
 */
export function buildStatusPrompt(input: BuildStatusPromptInput): string {
  const budget = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const parts = [`# 週報 status 項目生成 — ${mdInline(input.projectName)}`];

  const packed = packWps(input.changedWps, budget);
  parts.push(`## 本週變動的工作項目(WP)\n${packed || '（本週無偵測到變動）'}`);

  if (input.prevItems.length) {
    const prevList = input.prevItems.map((t, i) => `${i + 1}. ${mdInline(t)}`).join('\n');
    parts.push(`## 上週 status 原文(延續中、本週沒有實質變化的工作請沿用上週措辭,讓差異比對判定為黑字延續)\n${prevList}`);
  }

  if (input.feedback?.trim()) {
    parts.push(`## 上次生成的品質評分回饋(請針對這些問題修正後重新產出)\n${mdInline(input.feedback)}`);
  }

  parts.push(
    `## 指示\n` +
      `產出至多 2 項 status,每項限單行、不超過 ${input.maxItemChars} 字。\n` +
      `**必須綜合本週多筆變動寫成一句有洞察的話**（現況＋量化進度），**不得照抄任何單一 WP 的標題**，禁止逐字轉貼。\n` +
      `若提到問題或風險，**必附對策**——不能只拋問題不給解法。\n` +
      `延續中、本週沒有實質變化的工作，沿用上週措辭（見上方「上週 status 原文」）。\n` +
      `每項附上你依據的來源 WP，格式 "sources":[{"wp":123}]。\n` +
      `highlight 欄位只是建議（僅供人工參考，預設 false，不影響配色——配色一律由確定性差異比對決定）。\n\n` +
      `Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:\n` +
      `{"items":[{"text":"...","highlight":false,"sources":[{"wp":123}]}]}`,
  );

  return parts.join('\n\n');
}

function parseSourceRef(raw: unknown): SourceRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.wp === 'number' && Number.isFinite(o.wp)) return { wp: o.wp };
  return null;
}

function parseSourceRefs(raw: unknown): SourceRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw.map(parseSourceRef).filter((r): r is SourceRef => r !== null);
  return refs.length ? refs : undefined;
}

/**
 * Strict-JSON parse + fault-tolerant validation, mirrors orchestrator/planner.ts's
 * parsePlan: stripFences -> JSON.parse failure -> null; clamp to MAX_ITEMS; text
 * whitespace-collapsed + trimmed (empty text drops the item); highlight anything other
 * than literal `true` -> omitted (defaults false downstream); sources with invalid
 * entries dropped, empty array omitted. Returns null (not []) when every item was
 * dropped or the top-level shape is wrong.
 */
export function parseStatusItems(text: string): StatusCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    return null;
  }

  const items: StatusCandidate[] = [];
  const raw = (parsed as { items: unknown[] }).items.slice(0, MAX_ITEMS);
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const text2 = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
    if (!text2) continue;
    const highlight = o.highlight === true;
    const sources = parseSourceRefs(o.sources);
    items.push({ text: text2, ...(highlight ? { highlight } : {}), ...(sources ? { sources } : {}) });
  }
  return items.length ? items : null;
}

export interface GenerateStatusCandidatesInput extends BuildStatusPromptInput {}

export interface GenerateStatusCandidatesResult {
  items: StatusCandidate[];
  usedLlm: boolean;
}

/**
 * Guarded one-shot status-candidate generation. `!exec` checked before the host `which
 * claude` probe (never depends on host CLI in injected-exec tests — see CLAUDE.md's
 * hermeticity constraint), then session usage vs hard_limit_pct. Model resolves
 * report_pptx_model -> report_model -> 'sonnet' (empty setting falls through). Any
 * failure (no exec/CLI, over budget, exec throws/returns null, unparseable output) ->
 * `{items: [], usedLlm: false}`, never throws — the caller treats an empty result as
 * "carry last week forward" (see assembleDeckSpec), so the deck never ships blank.
 */
export async function generateStatusCandidates(
  db: Database.Database,
  input: GenerateStatusCandidatesInput,
  exec?: ContentExec,
): Promise<GenerateStatusCandidatesResult> {
  if (!exec && !hasClaudeCli()) return { items: [], usedLlm: false };
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  if (readUsage().session.percent >= hardLimit) return { items: [], usedLlm: false };

  const run: ContentExec = exec ?? defaultContentExec;
  const model = getSetting(db, 'report_pptx_model') || getSetting(db, 'report_model') || 'sonnet';
  try {
    const out = await run(buildStatusPrompt(input), model);
    if (!out) return { items: [], usedLlm: false };
    const items = parseStatusItems(out);
    if (!items) return { items: [], usedLlm: false };
    return { items, usedLlm: true };
  } catch {
    return { items: [], usedLlm: false };
  }
}
