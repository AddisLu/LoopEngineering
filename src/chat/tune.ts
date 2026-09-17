import type { NewTaskInput } from '../tasks.js';

/**
 * 調參建議 (parameter-tuning suggestions).
 *
 * The chat page can ask the local model to answer a CF-AOI symptom with a structured suggestion:
 * which file, which parameter, from what to what, why, how risky, how to verify. The model is
 * asked to end its answer with one fenced ```loop-tune block; this module parses that block and
 * turns it into a Loop task.
 *
 * It is a suggestion, never an action: nothing here writes to a machine, a recipe or a config.
 * The only side effect available is a `draft` Loop task that a human still has to queue, and the
 * task body says so explicitly.
 */

export type Risk = 'low' | 'medium' | 'high';

export interface TuneSuggestion {
  file: string;
  param: string;
  /** null when the knowledge base does not state the current value */
  current: string | null;
  proposed: string;
  why: string;
  risk: Risk;
  verify: string;
}

export interface TuneCard {
  symptom: string;
  suggestions: TuneSuggestion[];
}

const MAX_SUGGESTIONS = 20;
const MAX_FIELD = 400;
const FENCE = /```loop-tune(?:\s+json)?\s*\n([\s\S]*?)```/i;

const clamp = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);

function normaliseRisk(v: unknown): Risk {
  const r = String(v ?? '').toLowerCase().trim();
  return r === 'low' || r === 'high' ? r : 'medium';
}

/**
 * Pull the first ```loop-tune block out of an answer. Returns null for anything unusable — a
 * missing block, invalid JSON, or no suggestions — and the page then just shows a normal answer.
 * A local model that ignores the format must never break the page.
 */
export function parseTuneBlock(markdown: string): TuneCard | null {
  const m = FENCE.exec(markdown ?? '');
  if (!m?.[1]) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.suggestions)) return null;

  const suggestions: TuneSuggestion[] = [];
  for (const s of obj.suggestions.slice(0, MAX_SUGGESTIONS)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const file = clamp(o.file);
    const param = clamp(o.param);
    const proposed = clamp(o.proposed);
    // a suggestion without a target or a value is noise, not a suggestion
    if (!file || !param || !proposed) continue;
    const current = o.current == null || clamp(o.current) === '' ? null : clamp(o.current);
    suggestions.push({ file, param, current, proposed, why: clamp(o.why), risk: normaliseRisk(o.risk), verify: clamp(o.verify) });
  }
  if (!suggestions.length) return null;
  return { symptom: clamp(obj.symptom), suggestions };
}

const RISK_LABEL: Record<Risk, string> = { low: '低', medium: '中', high: '高' };

/** The card as a Markdown task goal a human (or a Loop agent) can act on. */
export function tuneGoal(card: TuneCard): string {
  const rows = card.suggestions.map(
    (s) => `| ${s.file} | ${s.param} | ${s.current ?? '（知識庫未記載）'} | ${s.proposed} | ${s.why || '—'} | ${RISK_LABEL[s.risk]} |`,
  );
  return [
    `## 症狀\n\n${card.symptom || '（對話中描述）'}`,
    '## 建議調整\n',
    '| 檔案 | 參數 | 目前 | 建議 | 原因 | 風險 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 驗證方式\n',
    ...card.suggestions.map((s) => `- ${s.param}：${s.verify || '（未指定，實作時補上）'}`),
    '',
    '## 範圍限制',
    '',
    '這是本地模型根據 CF-AOI 知識庫給的建議，**尚未套用**。此任務只負責準備變更與驗證步驟，',
    '不得自動套用到機台或正式設定檔；實際數值要由負責的工程師確認後再改。',
  ].join('\n');
}

export interface TuneTaskContext {
  messageId: string;
  conversationTitle?: string;
  owner?: string | null;
}

export function tuneTaskInput(card: TuneCard, ctx: TuneTaskContext): NewTaskInput {
  const first = card.suggestions[0];
  const subject = card.symptom || `${first?.file ?? ''} ${first?.param ?? ''}`.trim();
  return {
    title: `調參建議：${subject.slice(0, 40)}`,
    goal: tuneGoal(card),
    complexity: 'S',
    verify_mode: 'manual',
    verify_rubric: card.suggestions.map((s) => `${s.param}: ${s.verify}`).filter(Boolean).join('\n') || undefined,
    created_by: 'chat',
    owner: ctx.owner ?? null,
    // one task per answer, however many times the button is pressed (tasks.ts:getTaskBySourceRef)
    source_ref: `chat:${ctx.messageId}`,
  };
}

/** Fallback for 轉成任務 on an ordinary answer that carries no suggestion block. */
export function plainTaskInput(
  opts: { title?: string; goal?: string; content: string; conversationTitle?: string; messageId: string; owner?: string | null },
): NewTaskInput {
  const title = (opts.title ?? '').trim() || `對話：${(opts.conversationTitle || opts.content).slice(0, 36)}`;
  const goal = (opts.goal ?? '').trim() || `${opts.content}\n\n— 來自模型對話（${opts.conversationTitle ?? ''}）`;
  return {
    title: title.slice(0, 120),
    goal,
    complexity: 'S',
    created_by: 'chat',
    owner: opts.owner ?? null,
    source_ref: `chat:${opts.messageId}`,
  };
}
