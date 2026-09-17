import type Database from 'better-sqlite3';
import { chatLocal } from '../local/chat.js';
import type { PrdLint } from './lint.js';

/**
 * Second half of the PRD gate: the LOADED local model (zero tokens) reads a structurally valid
 * PRD as the unattended implementer would, and blocks it when that implementer would have to
 * guess, would likely build the wrong thing, or couldn't prove it's done.
 *
 * reviewPrd returns the review, `{ error }` when the model answered badly (truncated, unparseable,
 * HTTP/network failure), or null when no local model is available at all — the caller decides
 * whether the last two block (prd_require_llm).
 */

/** Test seam: resolve to the model's raw reply, null = no model available, throw = model failure. */
export type PrdReviewExec = (prompt: { system: string; user: string }) => Promise<string | null>;

export interface PrdReview {
  ok: boolean;
  missing: string[];
  questions: string[];
  risk_notes: string[];
}

export interface PrdReviewFailure {
  error: string;
}

const SYSTEM =
  '你是嚴格的技術 PRD 審查員。這份 PRD 會交給一個能力有限的本地 coding 模型在無人值守下實作，' +
  '實作者不能反問、只能照字面做。你的工作是找出會讓它猜測、做錯、或無法證明已完成的地方。只輸出 JSON。';

export function buildPrdReviewPrompt(markdown: string, lint: PrdLint): { system: string; user: string } {
  const f = lint.fields;
  const user = `## PRD 原文
${markdown}

## 解析出的欄位（供參考）
- 驗收標準 ${f.acceptance.length} 條、驗證指令：${f.verify_steps.map((s) => `\`${s}\``).join('、') || '(無)'}
- Repo：${f.repo_path ?? '(無)'} @ ${f.base_branch ?? 'main'}；領域：${f.domain ?? '(無)'}；複雜度：${f.complexity ?? 'M'}

## 請檢查
1. 目標是否只有一種合理解讀？關鍵名稱（檔案、函式、API、資料格式）是否寫明？
2. 每條驗收標準是否可被客觀驗證？驗證指令是否真的檢查到這些標準（還是只跑了不相關的測試）？
3. 範圍與非範圍是否互相矛盾、或與驗收標準衝突？
4. 是否缺少實作者一定需要、卻無法從 repo 推得的資訊（例如外部服務、硬體、效能門檻的數值）？

只有在「實作者很可能做錯或無法完成」時才判定 ok=false；小瑕疵放進 risk_notes 即可。
missing 放必須補的項目，questions 放實作者會想問的問題，每項一句話、繁體中文。

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"ok":true,"missing":["..."],"questions":["..."],"risk_notes":["..."]}`;
  return { system: SYSTEM, user };
}

function stripFences(s: string): string {
  const t = s.trim();
  return t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? t;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim().slice(0, 300))
        .slice(0, 10)
    : [];

export function parsePrdReview(text: string): PrdReview | null {
  let parsed: any;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    // tolerate prose around the object
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed.ok !== 'boolean') return null;
  return { ok: parsed.ok, missing: strList(parsed.missing), questions: strList(parsed.questions), risk_notes: strList(parsed.risk_notes) };
}

export async function reviewPrd(
  db: Database.Database,
  markdown: string,
  lint: PrdLint,
  exec?: PrdReviewExec,
): Promise<PrdReview | PrdReviewFailure | null> {
  const run: PrdReviewExec =
    exec ??
    (async (p) => {
      const r = await chatLocal(db, { ...p, maxTokens: 4096 });
      if (r.ok) return r.content;
      if (r.reason === 'disabled' || r.reason === 'not_ready') return null;
      throw new Error(r.detail);
    });
  let text: string | null;
  try {
    text = await run(buildPrdReviewPrompt(markdown, lint));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (text == null) return null;
  return parsePrdReview(text) ?? { error: `unparseable reply: ${text.slice(0, 200)}` };
}
