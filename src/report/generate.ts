import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { paths } from '../config.js';
import { readUsage } from '../token/usage.js';
import { mdInline } from '../knowledge/context.js';
import {
  fetchProjectWorkPackages,
  type OpDataExec,
  type OpWorkPackage,
  type OpSnapshotItem,
  type SearchFn,
} from './opdata.js';
import { getReportTemplate, listReportTemplates, type ReportTemplateDef } from './templates.js';
import { ganttChart, statusPie, phaseFlow } from './charts.js';
import { persistReport, type PersistWriteFns } from './persist.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 3 * 60_000;

export type ReportExec = (prompt: string) => Promise<string | null>;

export interface ReportRequest {
  description?: string;
  project?: string;
  topic?: string;
  templateInstructions?: string;
  /** Reusable "boss persona" template name (see templates.ts) — its instructions
   * replace DEFAULT_TEMPLATE_INSTRUCTIONS and its default_project/model fill in
   * where the request leaves them unset. Unknown name falls back to the built-in
   * default instead of throwing. */
  template?: string;
  /** Force persistence (see persist.ts) for this one call even when the `report_persist`
   * setting is off — the CLI's `report generate --save` sets this. */
  save?: boolean;
}

/** Aggregate counts for the deck's KPI tiles — always derived programmatically from the
 * structured WP[] data (never the LLM), same source of truth as summarizeWorkPackages /
 * charts.ts. Present in meta only for a live/structured fetch. */
export interface ReportStats {
  total: number;
  open: number;
  closed: number;
  overdue: number;
  /** Mean percent_done across all items, rounded to an integer (0–100). */
  donePercent: number;
}

/** A trimmed, presentation-ready projection of one work package for the deck's native
 * progress panel (the signature `.gline` bars) — precise numbers straight from the data,
 * so the panel never depends on parsing the LLM's prose. */
export interface ReportDeckItem {
  subject: string;
  status: string;
  percent: number;
  closed: boolean;
  overdue: boolean;
  due: string;
  assignee: string;
}

export interface ReportResult {
  markdown: string;
  meta: {
    source: 'live' | 'snapshot' | 'none';
    project?: string;
    itemCount: number;
    template?: string;
    /** Which Mermaid charts (see charts.ts) actually got embedded — 'gantt'/'pie'/'flow'
     * subset, in the order they appear in the markdown. Empty when the fetch wasn't
     * structured WP data (e.g. a snapshot-search fallback) or produced no chartable items. */
    charts: string[];
    /** Programmatic aggregate KPIs — present only for a live/structured WP fetch, absent
     * for a snapshot-search report (zero-impact: no structured data → no stats). */
    stats?: ReportStats;
    /** Top-N work packages (overdue-first, same sort as the packed data) for the deck's
     * native progress panel. Capped at DECK_ITEM_CAP; present only for a live fetch. */
    items?: ReportDeckItem[];
  };
  /** Paths written by persist.ts — present only when `report_persist` is on or the
   * request set `save`, and the write actually succeeded. */
  files?: string[];
}

export interface ReportDeps {
  /** Test injection for the description -> {project, topic, template?} haiku parse — one
   * merged call that also picks the best-fitting stored template when none was given
   * explicitly (see buildParsePrompt). */
  parseExec?: ReportExec;
  /** Test injection for the OpenProject live/snapshot data fetch (see opdata.ts). */
  dataExec?: OpDataExec;
  /** Test injection for the final report-synthesis call (see planner.ts's defaultExec). */
  synthExec?: ReportExec;
  /** Test injection for the snapshot-search fallback (see retrieve.ts's search). */
  searchFn?: SearchFn;
  /** Test injection for persist.ts's mkdir/writeFile (see PersistWriteFns). */
  persistFns?: PersistWriteFns;
}

// Cached at module scope (computed once): mirrors src/knowledge/relate.ts's hasClaudeCli —
// `which` is a real process spawn.
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

// 報告已在文字之後附上程式化產生的甘特圖／狀態分布 Mermaid 圖表（見 charts.ts）——逐筆進度、
// 交期、完成度已經由圖表呈現，指示 LLM 不要用長表格重述，只寫摘要/風險/下一步。
const DEFAULT_TEMPLATE_INSTRUCTIONS = `用以下結構產生一頁式繁體中文報告，主管視角、條列精簡，不要冗長敘述。報告最後會附上程式化產生的甘特圖與狀態分布圖表，逐筆進度／交期／完成度已經由圖表呈現，這裡不要用長表格重述：

## 摘要
（2-3 句話總結整體狀況）

## 風險與落後項
（列出逾期、卡住、有風險的項目）

## 下一步
（條列建議的下一步行動）`;

/** One haiku call covers both the project/topic parse and (when no explicit template was
 * given) picking the best-fitting stored template — folded into a single prompt/JSON
 * shape instead of two separate round trips (see generateReport's needsProjectParse /
 * needsTemplatePick). `templates` is only ever non-empty when a template pick is actually
 * needed, so an explicit-template request's prompt never even mentions templates. */
function buildParsePrompt(description: string, templates: ReportTemplateDef[]): string {
  const parts = [
    `從下面這句描述擷取「專案名稱關鍵詞」與「主題/重點」，用於產生 OpenProject 專案報告。
project 欄位只填「專案名稱」本身的關鍵詞（例如公司內部代號、產品/專案代稱），要去除 PR、進度、週報、report、one page、彙整、摘要、現況、狀態 等與專案名稱無關的通用詞；看不出明確專案名稱就把 project 留空字串。
topic 欄位放這句描述裡除了專案名稱以外的重點/主題。`,
  ];
  if (templates.length) {
    const list = templates
      .map((t) => `- ${t.name}：${[t.description, t.audience && `對象:${t.audience}`].filter(Boolean).join('，')}`)
      .join('\n');
    parts.push(`同時，以下是可用的報告範本清單，若這句描述明顯適合其中一個就在 template 欄位填該範本的 name，選不出來就留空字串：\n${list}`);
  }
  parts.push(`## 描述\n${description}`);
  const shape = templates.length ? `{"project":"...","topic":"...","template":"..."}` : `{"project":"...","topic":"..."}`;
  parts.push(`Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:\n${shape}`);
  return parts.join('\n\n');
}

// Generic reporting/PR boilerplate that carries no project-identifying signal — stripped
// from a free-text description to surface the remaining salient keyword(s) as a second
// resolveProject candidate, for when the haiku parse's `project` field doesn't match any
// live project name (see generateReport's projectCandidates).
const GENERIC_DESCRIPTION_WORDS = [
  'one page',
  'onepage',
  'report',
  'Report',
  'PR',
  'pr',
  '最新進度',
  '進度',
  '週報',
  '報告',
  '彙整',
  '總結',
  '摘要',
  '現況',
  '狀態',
  '一頁式',
  '一頁',
];

function extractSalientKeyword(description: string): string {
  let text = description;
  for (const word of GENERIC_DESCRIPTION_WORDS) {
    text = text.split(word).join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

interface ParsedDescription {
  project: string;
  topic: string;
  templateDef?: ReportTemplateDef;
}

function parseDescriptionOutput(text: string, templates: ReportTemplateDef[]): ParsedDescription | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const project = typeof o.project === 'string' ? o.project.trim() : '';
  const topic = typeof o.topic === 'string' ? o.topic.trim() : '';
  const templateName = typeof o.template === 'string' ? o.template.trim() : '';
  if (!project && !topic && !templateName) return null;
  const templateDef = templateName ? templates.find((t) => t.name === templateName) : undefined;
  return { project, topic, templateDef };
}

async function defaultParseExec(prompt: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', 'haiku', '--output-format', 'text'],
      { timeout: TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

async function defaultSynthExec(prompt: string, model: string): Promise<string | null> {
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

function isWorkPackage(item: OpWorkPackage | OpSnapshotItem): item is OpWorkPackage {
  return 'subject' in item;
}

function renderItemLine(item: OpWorkPackage | OpSnapshotItem): string {
  if (isWorkPackage(item)) {
    const due = item.due_date || '未定';
    const assignee = item.assignee_name || '未指派';
    const closed = item.is_closed ? '/已結案' : '';
    const desc = item.description ? ` — ${mdInline(item.description)}` : '';
    return `- **${mdInline(item.subject)}**（${mdInline(item.status)}${closed}, ${item.percent_done}%）負責人:${mdInline(assignee)} 交期:${due} 工時:${item.spent_hours}/${item.estimated_hours}h${desc}`;
  }
  return `- **[${mdInline(item.path)}]**：${mdInline(item.text)}`;
}

/** How many work packages the deck's native progress panel shows (overdue-first). Keeps
 * the API response small while covering a single slide's worth of rows. */
const DECK_ITEM_CAP = 14;

function isOverdue(item: OpWorkPackage, today: string): boolean {
  return !item.is_closed && !!item.due_date && item.due_date < today && item.percent_done < 100;
}

/** One aggregate stats line (counts + overdue) so the LLM knows the true totals even when
 * a large parent project's work packages get truncated by the char budget below. */
function summarizeWorkPackages(items: OpWorkPackage[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const closed = items.filter((i) => i.is_closed).length;
  const overdue = items.filter((i) => isOverdue(i, today)).length;
  return `**整體彙整**：共 ${items.length} 筆（未結案 ${items.length - closed}、已結案 ${closed}、逾期 ${overdue}）`;
}

/** Aggregate KPIs for the deck (see ReportStats) — same today/overdue definition as
 * summarizeWorkPackages and charts.ts, computed from the full item set (never truncated). */
function buildStats(items: OpWorkPackage[]): ReportStats {
  const today = new Date().toISOString().slice(0, 10);
  const closed = items.filter((i) => i.is_closed).length;
  const overdue = items.filter((i) => isOverdue(i, today)).length;
  const sumPercent = items.reduce((acc, i) => acc + (Number.isFinite(i.percent_done) ? i.percent_done : 0), 0);
  return {
    total: items.length,
    open: items.length - closed,
    closed,
    overdue,
    donePercent: items.length ? Math.round(sumPercent / items.length) : 0,
  };
}

/** Top-N (overdue-first, the incoming sort) presentation projection for the deck's native
 * progress panel — precise fields only, so the panel never parses the LLM's prose. */
function buildDeckItems(items: OpWorkPackage[]): ReportDeckItem[] {
  const today = new Date().toISOString().slice(0, 10);
  return items.slice(0, DECK_ITEM_CAP).map((i) => ({
    subject: i.subject,
    status: i.status,
    percent: Number.isFinite(i.percent_done) ? i.percent_done : 0,
    closed: i.is_closed,
    overdue: isOverdue(i, today),
    due: i.due_date || '',
    assignee: i.assignee_name || '',
  }));
}

/** Greedy-pack items into report_budget_chars, mirroring context.ts's ragTaskContext loop. */
function packItems(items: (OpWorkPackage | OpSnapshotItem)[], budget: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const line = renderItemLine(item);
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

interface ChartBlock {
  kind: string;
  label: string;
  mmd: string;
}

/** Programmatically produce the report's charts from structured WP[] data (never from
 * the LLM) — gantt + status pie always attempted, phase flow only when there's more
 * than one distinct WP type to actually chart a flow between. Each entry's `mmd` is
 * raw Mermaid source, embedded verbatim (see buildChartsMarkdown) rather than asked of
 * the LLM, so the numbers can never be hallucinated/mangled in transcription. */
function buildCharts(items: OpWorkPackage[]): ChartBlock[] {
  const charts: ChartBlock[] = [];
  const gantt = ganttChart(items);
  if (gantt) charts.push({ kind: 'gantt', label: '甘特圖', mmd: gantt });
  const pie = statusPie(items);
  if (pie) charts.push({ kind: 'pie', label: '狀態分布', mmd: pie });
  const distinctTypes = new Set(items.map((i) => i.type || '未分類')).size;
  if (distinctTypes > 1) {
    const flow = phaseFlow(items);
    if (flow) charts.push({ kind: 'flow', label: '相位流程', mmd: flow });
  }
  return charts;
}

/** Appended after the LLM's prose as its own `## 圖表` section — one fenced ```mermaid
 * block per chart, in generation order. Returns '' when there are no charts to embed. */
function buildChartsMarkdown(charts: ChartBlock[]): string {
  if (!charts.length) return '';
  const parts = charts.map((c) => `### ${c.label}\n\n\`\`\`mermaid\n${c.mmd}\n\`\`\``);
  return ['## 圖表', ...parts].join('\n\n');
}

function buildSynthPrompt(
  instructions: string | undefined,
  project: string,
  topic: string,
  fetched: { source: 'live' | 'snapshot'; project: { name: string } | null },
  packed: string,
): string {
  const parts = [`# 報告產生指示\n${instructions?.trim() || DEFAULT_TEMPLATE_INSTRUCTIONS}`];
  const ask = [project && `專案：${project}`, topic && `重點：${topic}`].filter(Boolean).join('；');
  if (ask) parts.push(`## 使用者需求\n${ask}`);
  const sourceLabel = fetched.source === 'live' ? '即時查詢' : '既有語料快照（可能非最新）';
  parts.push(`## 資料（來源：${sourceLabel}${fetched.project ? `，專案：${fetched.project.name}` : ''}）\n${packed || '（無可用資料）'}`);
  return parts.join('\n\n');
}

/**
 * Generate an OpenProject project report from a natural-language description. Guarded
 * like planner.ts/relate.ts: off by default (`report_enabled`), `!exec` checked before
 * the `which claude` host probe (never depends on host CLI in injected-exec tests), and
 * skipped when session usage is already at/over hard_limit_pct. Never throws.
 */
export async function generateReport(
  db: Database.Database,
  req: ReportRequest,
  deps: ReportDeps = {},
): Promise<ReportResult | null> {
  if (!getBool(db, 'report_enabled', false)) return null;
  if (!deps.synthExec && !hasClaudeCli()) return null;
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  if (readUsage().session.percent >= hardLimit) return null;

  try {
    // Resolve an explicit template up front (an unknown name falls through to the
    // built-in default rather than throwing).
    let templateDef: ReportTemplateDef | undefined;
    if (req.template?.trim()) {
      templateDef = getReportTemplate(db, req.template.trim());
    }

    let project = req.project?.trim() || '';
    let topic = req.topic?.trim() || '';
    let projectCandidates: string[] = [];
    if (!project && templateDef?.default_project) project = templateDef.default_project;

    // One merged haiku call covers both the project/topic parse and (when no explicit
    // template was given) picking the best-fitting stored template — previously two
    // separate round trips, now at most one.
    const needsProjectParse = !project && !!req.description?.trim();
    const needsTemplatePick = !templateDef && !!req.description?.trim();
    if (needsProjectParse || needsTemplatePick) {
      const templates = needsTemplatePick ? listReportTemplates(db) : [];
      const parseRun = deps.parseExec ?? defaultParseExec;
      const parsedOut = await parseRun(buildParsePrompt(req.description!, templates));
      const parsed = parsedOut ? parseDescriptionOutput(parsedOut, templates) : null;
      if (needsProjectParse) {
        if (parsed) {
          project = parsed.project;
          topic = parsed.topic;
        } else {
          topic = req.description!.trim();
        }
        // The haiku-parsed project string may not match any live project name (or parsing
        // may have failed outright) -- offer the description's remaining salient keyword
        // (generic report/PR words stripped) as a second resolveProject candidate, so a
        // description-only request still resolves live instead of giving up to snapshot.
        const salient = extractSalientKeyword(req.description!);
        if (salient && salient !== project) projectCandidates = [salient];
      }
      if (needsTemplatePick && parsed?.templateDef) templateDef = parsed.templateDef;
    }
    if (!templateDef) {
      const fallbackName = getSetting(db, 'report_default_template');
      if (fallbackName) templateDef = getReportTemplate(db, fallbackName);
    }
    // project was given explicitly (parse skipped above) but topic wasn't -- still use
    // the description text as the topic rather than silently dropping it.
    if (!topic && req.description?.trim()) topic = req.description.trim();

    const fetched = await fetchProjectWorkPackages(db, { project, topic, projectCandidates }, deps.dataExec, deps.searchFn);
    // Align the "使用者需求" label with whatever actually resolved live (e.g. a fallback
    // keyword candidate, or the canonical name behind an abbreviation), not the raw guess.
    if (fetched.source === 'live' && fetched.project) project = fetched.project.name;
    const budget = getNum(db, 'report_budget_chars', 4000);
    const packedItems = packItems(fetched.items, budget);
    const firstItem = fetched.items[0];
    // Charts (see charts.ts) only ever come from structured WP[] data, never the
    // snapshot-search fallback's free-text chunks.
    const workItems = firstItem && isWorkPackage(firstItem) ? (fetched.items as OpWorkPackage[]) : [];
    const summary = workItems.length ? summarizeWorkPackages(workItems) : '';
    const packed = summary ? `${summary}\n${packedItems}` : packedItems;

    const synthRun: ReportExec =
      deps.synthExec ?? ((p) => defaultSynthExec(p, templateDef?.model || getSetting(db, 'report_model') || 'sonnet'));
    const instructions = templateDef?.instructions || req.templateInstructions;
    const out = await synthRun(buildSynthPrompt(instructions, project, topic, fetched, packed));
    if (!out) return null;
    const synthMarkdown = stripFences(out);
    if (!synthMarkdown) return null;

    const charts = buildCharts(workItems);
    const chartsMarkdown = buildChartsMarkdown(charts);
    const markdown = [synthMarkdown, chartsMarkdown].filter(Boolean).join('\n\n');

    let files: string[] | undefined;
    if (getBool(db, 'report_persist', false) || req.save) {
      const outputDir = getSetting(db, 'report_output_dir') || path.join(paths.dataDir, 'reports');
      const persisted = persistReport(
        {
          outputDir,
          project: fetched.project?.name || project || '',
          topic,
          markdown,
          items: fetched.items,
          charts: charts.map((c) => ({ kind: c.kind, mmd: c.mmd })),
        },
        deps.persistFns,
      );
      if (persisted) files = persisted.files;
    }

    return {
      markdown,
      meta: {
        source: fetched.items.length ? fetched.source : 'none',
        project: fetched.project?.name || project || undefined,
        itemCount: fetched.items.length,
        template: templateDef?.name,
        charts: charts.map((c) => c.kind),
        // KPI tiles + native progress panel come from structured WP data only; a
        // snapshot-search report has neither (zero-impact: fields simply absent).
        ...(workItems.length ? { stats: buildStats(workItems), items: buildDeckItems(workItems) } : {}),
      },
      ...(files ? { files } : {}),
    };
  } catch {
    return null;
  }
}
