import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { readUsage } from '../token/usage.js';
import { mdInline } from '../knowledge/context.js';
import {
  fetchProjectWorkPackages,
  type OpDataExec,
  type OpWorkPackage,
  type OpSnapshotItem,
  type SearchFn,
} from './opdata.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 3 * 60_000;

export type ReportExec = (prompt: string) => Promise<string | null>;

export interface ReportRequest {
  description?: string;
  project?: string;
  topic?: string;
  templateInstructions?: string;
}

export interface ReportResult {
  markdown: string;
  meta: { source: 'live' | 'snapshot' | 'none'; project?: string; itemCount: number };
}

export interface ReportDeps {
  /** Test injection for the description -> {project, topic} haiku parse (see structure.ts). */
  parseExec?: ReportExec;
  /** Test injection for the OpenProject live/snapshot data fetch (see opdata.ts). */
  dataExec?: OpDataExec;
  /** Test injection for the final report-synthesis call (see planner.ts's defaultExec). */
  synthExec?: ReportExec;
  /** Test injection for the snapshot-search fallback (see retrieve.ts's search). */
  searchFn?: SearchFn;
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

const DEFAULT_TEMPLATE_INSTRUCTIONS = `用以下結構產生一頁式繁體中文報告，主管視角、條列精簡，不要冗長敘述：

## 摘要
（2-3 句話總結整體狀況）

## 進度總覽
（列出各項目的完成度 % 與交期，指出超前/落後）

## PR・備料狀況
（若資料含 PR / 備料 / 採購相關項目，列出目前狀態；沒有相關資料就省略此節）

## 風險與落後項
（列出逾期、卡住、有風險的項目）

## 下一步
（條列建議的下一步行動）`;

function buildParsePrompt(description: string): string {
  return `從下面這句描述擷取「專案名稱」與「主題/重點」，用於產生 OpenProject 專案報告。
看不出明確專案名稱就把 project 留空字串。

## 描述
${description}

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"project":"...","topic":"..."}`;
}

interface ParsedDescription {
  project: string;
  topic: string;
}

function parseDescriptionOutput(text: string): ParsedDescription | null {
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
  if (!project && !topic) return null;
  return { project, topic };
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

function buildSynthPrompt(
  req: ReportRequest,
  project: string,
  topic: string,
  fetched: { source: 'live' | 'snapshot'; project: { name: string } | null },
  packed: string,
): string {
  const parts = [`# 報告產生指示\n${req.templateInstructions?.trim() || DEFAULT_TEMPLATE_INSTRUCTIONS}`];
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
    let project = req.project?.trim() || '';
    let topic = req.topic?.trim() || '';

    if (!project && req.description?.trim()) {
      const parseRun = deps.parseExec ?? defaultParseExec;
      const parsedOut = await parseRun(buildParsePrompt(req.description));
      const parsed = parsedOut ? parseDescriptionOutput(parsedOut) : null;
      if (parsed) {
        project = parsed.project;
        topic = parsed.topic;
      } else {
        topic = req.description.trim();
      }
    }
    // project was given explicitly (haiku parse skipped above) but topic wasn't -- still
    // use the description text as the topic rather than silently dropping it.
    if (!topic && req.description?.trim()) topic = req.description.trim();

    const fetched = await fetchProjectWorkPackages(db, { project, topic }, deps.dataExec, deps.searchFn);
    const budget = getNum(db, 'report_budget_chars', 4000);
    const packed = packItems(fetched.items, budget);

    const synthRun: ReportExec = deps.synthExec ?? ((p) => defaultSynthExec(p, getSetting(db, 'report_model') || 'sonnet'));
    const out = await synthRun(buildSynthPrompt(req, project, topic, fetched, packed));
    if (!out) return null;
    const markdown = stripFences(out);
    if (!markdown) return null;

    return {
      markdown,
      meta: {
        source: fetched.items.length ? fetched.source : 'none',
        project: fetched.project?.name || project || undefined,
        itemCount: fetched.items.length,
      },
    };
  } catch {
    return null;
  }
}
