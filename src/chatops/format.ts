/**
 * The fixed reply formats of 對話操作. The engine writes these Markdown blocks and the chat model
 * pastes them as they are — numbers, ids and links never pass through the model's own wording.
 * Short on purpose: a table never has more than MAX_ROWS rows, and every row carries its id.
 */

export const MAX_ROWS = 8;

export const TASK_WORD: Record<string, string> = {
  draft: '草稿',
  ready: '就緒',
  queued: '排隊中',
  blocked: '等續跑',
  running: '執行中',
  verifying: '驗證中',
  review: '待核可',
  attention: '需要處理',
  failed: '失敗',
  closed: '已結案',
};

export const BENCH_WORD: Record<string, string> = {
  running: '進行中',
  judging: '評分中',
  judged: '已評分',
  judge_failed: '評分失敗',
  cancelled: '已取消',
};

/** 'local:qwen38-flash' → 'qwen38-flash'; cloud aliases as they are. */
export const modelName = (m: string | null | undefined): string => (m ? String(m).replace(/^local:/, '') : '預設模型');

/** One table cell: no pipes or newlines, and at most `max` characters. */
export function cell(v: unknown, max = 40): string {
  const s = String(v ?? '')
    .replace(/\|/g, '／')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s || '—';
}

/** A Markdown table; rows past MAX_ROWS become one "還有 N 筆" line under it. */
export function table(headers: string[], rows: unknown[][], more = ''): string {
  if (!rows.length) return '';
  const shown = rows.slice(0, MAX_ROWS);
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...shown.map((r) => `| ${r.map((c) => cell(c, 60)).join(' | ')} |`)];
  if (rows.length > MAX_ROWS) out.push('', `…還有 ${rows.length - MAX_ROWS} 筆${more ? `（${more}）` : ''}`);
  return out.join('\n');
}

/** sqlite writes "YYYY-MM-DD HH:MM:SS" in UTC; ISO elsewhere. */
export function toMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = new Date(String(ts).includes('T') ? ts : `${String(ts).replace(' ', 'T')}Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** "09/30 06:12" in the server's local time (the Spark sits where its users are). */
export function when(ts: string | null | undefined): string {
  const t = toMs(ts);
  if (t == null) return '—';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "12 分" / "1 時 48 分" */
export function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} 時 ${m % 60} 分` : `${m} 分`;
}

export const pct = (v: number | null | undefined): string => (v == null ? '—' : `${Math.round(v * 100)}%`);

/** Where to look: a task's flow and review page, a benchmark's dashboard, a draft. */
export const link = {
  task: (id: string) => ({ title: `${id} 工作流程`, url: `/flow.html?task=${encodeURIComponent(id)}` }),
  review: (id: string) => ({ title: `${id} 驗收頁`, url: `/task.html?id=${encodeURIComponent(id)}` }),
  bench: (id: string) => ({ title: `${id} 評比`, url: `/benchmarks.html#b=${encodeURIComponent(id)}` }),
  draft: (id: string) => ({ title: '工作流程草稿', url: `/flow.html?draft=${encodeURIComponent(id)}` }),
  board: () => ({ title: '總覽', url: '/board.html' }),
  plan: (id: string) => ({ title: `${id} 驗證方案`, url: `/plans.html#${encodeURIComponent(id)}` }),
};
