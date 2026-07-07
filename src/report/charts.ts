import type { OpWorkPackage } from './opdata.js';

/**
 * Programmatic Mermaid generators over structured WP[] data — the LLM never sees these
 * numbers, it only writes prose around the chart (see generate.ts). Pure functions, no
 * I/O, hermetic: every output is deterministic given items (+ the real clock for
 * overdue/today comparisons, same convention as opdata.ts's sortRank / generate.ts's
 * summarizeWorkPackages). Empty/all-undated input returns '' so the caller can simply
 * skip embedding the chart rather than special-case an empty diagram.
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s: string): boolean {
  return YMD_RE.test(s);
}

/** Strip characters that break Mermaid's unquoted, colon/comma-delimited syntax
 * (gantt task/section names, flowchart edge labels): colons, semicolons, commas, `#`,
 * and newlines all have structural meaning there. */
function escapeLine(s: string, fallback: string): string {
  const cleaned = s
    .replace(/[\r\n]+/g, ' ')
    .replace(/[:;,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

/** For labels that sit inside a Mermaid double-quoted string (pie slices, flowchart
 * node text) — only the quote character itself and newlines are structurally unsafe. */
function escapeQuoted(s: string, fallback: string): string {
  const cleaned = s
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '’')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

/** start~due for the gantt bar: both given -> use as-is (swapped if start > due, a data
 * quality issue Mermaid would otherwise choke on); only one given -> a single-day bar;
 * neither -> null (caller skips the item, per the plan's "無日期者略過"). */
function ganttDates(item: OpWorkPackage): { start: string; end: string } | null {
  const hasStart = isDate(item.start_date);
  const hasDue = isDate(item.due_date);
  if (!hasStart && !hasDue) return null;
  let start = hasStart ? item.start_date : item.due_date;
  let end = hasDue ? item.due_date : item.start_date;
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

function ganttTag(item: OpWorkPackage, today: string): 'done' | 'crit' | null {
  if (item.is_closed) return 'done';
  if (isDate(item.due_date) && item.due_date < today && item.percent_done < 100) return 'crit';
  return null;
}

export interface GanttOptions {
  title?: string;
  /** Section grouping: 'status' (raw OpenProject status text) or 'type' (used as a
   * phase/WBS-level proxy — OpWorkPackage has no dedicated parent/phase field). */
  groupBy?: 'status' | 'type';
}

/**
 * Mermaid `gantt` chart: one section per distinct status/type, one bar per WP with
 * start_date~due_date, tagged `done` when closed and `crit` when overdue-and-unfinished.
 * Items with neither date are skipped. Returns '' for empty/all-undated input.
 */
export function ganttChart(items: OpWorkPackage[], opts: GanttOptions = {}): string {
  if (!items.length) return '';
  const today = new Date().toISOString().slice(0, 10);
  const groupBy = opts.groupBy ?? 'status';

  const groups = new Map<string, OpWorkPackage[]>();
  for (const item of items) {
    if (!ganttDates(item)) continue;
    const key = (groupBy === 'type' ? item.type : item.status) || '未分類';
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  if (!groups.size) return '';

  const lines = ['gantt', `    title ${escapeLine(opts.title ?? '專案進度甘特圖', '專案進度甘特圖')}`, '    dateFormat YYYY-MM-DD'];
  let idx = 0;
  for (const [key, groupItems] of groups) {
    lines.push(`    section ${escapeLine(key, '未分類')}`);
    for (const item of groupItems) {
      const dates = ganttDates(item)!;
      const tag = ganttTag(item, today);
      const fields = [tag, `t${idx++}`, dates.start, dates.end].filter(Boolean).join(', ');
      lines.push(`        ${escapeLine(item.subject, '未命名項目')} :${fields}`);
    }
  }
  return lines.join('\n');
}

/**
 * Mermaid `pie` chart over four mutually-exclusive, programmatically-derived buckets
 * (closed > overdue-and-unfinished > in-progress > not-started — same precedence as
 * opdata.ts's sortRank) rather than raw status text, so the categories stay meaningful
 * regardless of how many custom status names a given OpenProject instance has. Zero-count
 * buckets are omitted (a 0-value pie slice is meaningless). Returns '' for empty input or
 * when every bucket is empty.
 */
export function statusPie(items: OpWorkPackage[]): string {
  if (!items.length) return '';
  const today = new Date().toISOString().slice(0, 10);
  let inProgress = 0;
  let closed = 0;
  let overdue = 0;
  let notStarted = 0;
  for (const item of items) {
    if (item.is_closed) {
      closed++;
      continue;
    }
    const isOverdue = Boolean(item.due_date) && item.due_date < today && item.percent_done < 100;
    if (isOverdue) {
      overdue++;
      continue;
    }
    if (item.percent_done > 0) inProgress++;
    else notStarted++;
  }
  const buckets: [string, number][] = [
    ['進行中', inProgress],
    ['已結案', closed],
    ['逾期', overdue],
    ['未開始', notStarted],
  ];
  const slices = buckets.filter(([, n]) => n > 0);
  if (!slices.length) return '';
  return ['pie title 各狀態計數', ...slices.map(([label, n]) => `    "${escapeQuoted(label, label)}" : ${n}`)].join('\n');
}

/**
 * Optional Mermaid `flowchart`: one node per distinct WP `type` (the closest thing to a
 * "phase" in the current data model — OpWorkPackage has no parent/phase field), labeled
 * with its count and red-flagged (`:::danger`) when it contains any overdue-and-unfinished
 * item, chained left-to-right in first-seen order. Returns '' for empty input.
 */
export function phaseFlow(items: OpWorkPackage[]): string {
  if (!items.length) return '';
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, { count: number; danger: boolean }>();
  for (const item of items) {
    const key = item.type || '未分類';
    const isOverdue = !item.is_closed && Boolean(item.due_date) && item.due_date < today && item.percent_done < 100;
    const g = groups.get(key) ?? { count: 0, danger: false };
    g.count++;
    if (isOverdue) g.danger = true;
    groups.set(key, g);
  }
  if (!groups.size) return '';

  const keys = [...groups.keys()];
  const lines = ['flowchart LR'];
  keys.forEach((key, i) => {
    const g = groups.get(key)!;
    lines.push(`    n${i}["${escapeQuoted(key, '未分類')} (${g.count})"]:::${g.danger ? 'danger' : 'ok'}`);
  });
  for (let i = 0; i < keys.length - 1; i++) lines.push(`    n${i} --> n${i + 1}`);
  lines.push('    classDef danger fill:#f66,stroke:#900,color:#fff');
  lines.push('    classDef ok fill:#eee,stroke:#999,color:#333');
  return lines.join('\n');
}
