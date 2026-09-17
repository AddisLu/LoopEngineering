import path from 'node:path';
import type Database from 'better-sqlite3';
import { chatLocal, type LocalChatResult } from '../local/chat.js';
import { search as ragSearch, type RetrievedChunk } from '../knowledge/retrieve.js';
import { QUERY_EXPANSION_PROMPT, parseKeywords } from '../chat/keywords.js';

/**
 * Zero-token helpers for the PRD wizard: find the files a change probably touches, and draft
 * acceptance criteria. Both lean on the local model and the knowledge base and both degrade
 * honestly — a ranking the model could not produce comes back as the plain retrieval order with
 * `ranked: false`, and a model that is not loaded is a 503 with a sentence the page can show.
 */

export type SearchFn = (db: Database.Database, q: string, opts: { scope?: string; topK?: number }) => Promise<RetrievedChunk[]>;
export type LocalChatFn = typeof chatLocal;

export interface AssistDeps {
  search?: SearchFn;
  localChat?: LocalChatFn;
}

export interface SuggestedFile {
  /** relative to the repo root */
  path: string;
  lines: string | null;
  why: string;
  score: number;
}

export type SuggestResult =
  | { ok: true; files: SuggestedFile[]; ranked: boolean; keywords: string[] }
  | { ok: false; status: number; error: string };

export type AcceptanceResult = { ok: true; items: string[] } | { ok: false; status: number; error: string };

const RANK_SYSTEM = [
  '你是這個程式庫的資深工程師。使用者描述了要改的東西，下面是知識庫檢索出的候選檔案片段。',
  '挑出真正需要修改或必須先讀懂的檔案，最多 8 個，依重要性排序。',
  '只輸出 JSON 陣列：[{"path": "候選清單裡的路徑", "why": "一句話說明為什麼", "lines": "起-迄行或 null"}]。不要輸出其他文字。',
].join('\n');

const ACCEPTANCE_SYSTEM = [
  '你是嚴格的驗收工程師。依據使用者的修改描述，寫出 3 到 6 條可以客觀驗證的驗收標準。',
  '每條用「Given …, When …, Then …」的格式，一行一條，Then 要有可量測的結果（數值、檔案、回傳值、畫面上的具體內容）。',
  '不要寫模糊的詞（例如「正常」「順利」）。只輸出 JSON 字串陣列，不要其他文字。',
].join('\n');

function parseJsonArray(text: string): unknown[] | null {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const unavailable = (r: LocalChatResult & { ok: false }): { status: number; error: string } =>
  r.reason === 'disabled' || r.reason === 'not_ready'
    ? { status: 503, error: `本地模型未載入（${r.detail}）` }
    : { status: 502, error: `本地模型沒有回答：${r.detail}` };

export async function suggestFiles(
  db: Database.Database,
  input: { repo_path: string; module?: string | null; description: string },
  deps: AssistDeps = {},
): Promise<SuggestResult> {
  const search = deps.search ?? ((d, q, o) => ragSearch(d, q, o));
  const chat = deps.localChat ?? chatLocal;
  const description = input.description.trim();
  if (!description) return { ok: false, status: 400, error: 'description: 先描述要改什麼' };
  if (!input.repo_path) return { ok: false, status: 400, error: 'repo_path: 必填' };
  const scope = input.module ? path.join(input.repo_path, input.module) : input.repo_path;

  // keywords are what the trigram index can actually hit; a failure here just means fewer queries
  let keywords: string[] = [];
  const kw = await chat(db, { system: QUERY_EXPANSION_PROMPT, user: description, maxTokens: 200 });
  if (kw.ok) keywords = parseKeywords(kw.content);

  const best = new Map<string, RetrievedChunk>();
  for (const q of [description, ...keywords]) {
    let hits: RetrievedChunk[] = [];
    try {
      hits = await search(db, q, { scope, topK: 12 });
    } catch {
      hits = [];
    }
    for (const h of hits) {
      const have = best.get(h.path);
      if (!have || h.score > have.score) best.set(h.path, h);
    }
  }
  const candidates = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  if (!candidates.length) {
    return { ok: false, status: 503, error: '知識庫沒有這個 repo 的索引，或找不到相關片段——先用 loop ingest 登錄並建索引' };
  }

  const fallback = (): SuggestResult => ({
    ok: true,
    ranked: false,
    keywords,
    files: candidates.map((c) => ({
      path: c.path,
      lines: c.start_line != null ? `${c.start_line}-${c.end_line ?? c.start_line}` : null,
      why: c.section ?? '',
      score: c.score,
    })),
  });

  const listing = candidates
    .map((c, i) => `[${i + 1}] ${c.path}${c.start_line != null ? ` (L${c.start_line}-${c.end_line ?? c.start_line})` : ''}\n${c.text.slice(0, 600)}`)
    .join('\n\n');
  const ranked = await chat(db, { system: RANK_SYSTEM, user: `修改描述：${description}\n\n候選：\n\n${listing}`, maxTokens: 1024 });
  if (!ranked.ok) return fallback();
  const arr = parseJsonArray(ranked.content);
  if (!arr) return fallback();
  const byPath = new Map(candidates.map((c) => [c.path, c]));
  const files: SuggestedFile[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const p = typeof o.path === 'string' ? o.path.trim() : '';
    const c = byPath.get(p);
    if (!c || files.some((f) => f.path === p)) continue; // the model may only pick from the candidates
    files.push({
      path: p,
      lines: typeof o.lines === 'string' && o.lines.trim() ? o.lines.trim().slice(0, 40) : c.start_line != null ? `${c.start_line}-${c.end_line ?? c.start_line}` : null,
      why: typeof o.why === 'string' ? o.why.trim().slice(0, 300) : '',
      score: c.score,
    });
    if (files.length >= 8) break;
  }
  return files.length ? { ok: true, ranked: true, keywords, files } : fallback();
}

export async function draftAcceptance(
  db: Database.Database,
  input: { description: string; expected?: string; method?: string; module?: string | null },
  deps: AssistDeps = {},
): Promise<AcceptanceResult> {
  const chat = deps.localChat ?? chatLocal;
  const description = input.description.trim();
  if (!description) return { ok: false, status: 400, error: 'description: 先描述要改什麼' };
  const user = [
    input.module ? `模組：${input.module}` : null,
    `修改描述：${description}`,
    input.expected?.trim() ? `期望行為：${input.expected.trim()}` : null,
    input.method ? `驗證方式：${input.method}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const r = await chat(db, { system: ACCEPTANCE_SYSTEM, user, maxTokens: 800 });
  if (!r.ok) return { ok: false, ...unavailable(r) };
  const arr = parseJsonArray(r.content);
  const items = (arr ?? r.content.split('\n'))
    .map((x) => String(x ?? '').replace(/^\s*(?:[-*•]|\d+[.)]|\[ \])\s*/, '').trim())
    .filter((s) => s.length >= 12 && s.length <= 400) // a real Given/When/Then is never this short
    .slice(0, 6);
  if (!items.length) return { ok: false, status: 502, error: '本地模型沒有給出可用的驗收條件，請手動填寫' };
  return { ok: true, items };
}
