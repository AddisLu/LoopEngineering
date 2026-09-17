/**
 * Question → search keywords, via the local model. Shared by the chat page's knowledge retrieval
 * (src/server/chatRoutes.ts) and the PRD wizard's 「用知識庫找」 (src/prd/assist.ts): the corpus
 * FTS matches a whole query as one phrase, so a colloquial question finds nothing until it is
 * turned into the identifiers and terms that actually appear in code and docs.
 */

export const QUERY_EXPANSION_PROMPT = [
  '你是 CF-AOI 專案的檢索助手，要把使用者的問題轉成搜尋程式碼與文件用的關鍵字。',
  '只輸出一個 JSON 字串陣列（不要其他文字），3–8 個：先放可能出現在原始碼或文件裡的識別字、函式名、類別名、參數名、檔名、命令或錯誤訊息，再放 2–8 字的中文專有名詞。',
  '不要放整句話，不要解釋。',
].join('\n');

export function parseKeywords(text: string): string[] {
  let items: unknown[] | null = null;
  const m = /\[[\s\S]*\]/.exec(text);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = null;
    }
  }
  const raw = items ?? text.split(/[\n,，、]/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== 'string') continue;
    const s = k.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (s.length < 2 || s.length > 60 || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}
