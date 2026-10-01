import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getBool, logEvent } from '../db/index.js';
import { listRunsForTask } from '../tasks.js';
import { readVerify } from '../orchestrator/runSummary.js';
import { chatLocal } from '../local/chat.js';
import type { Task } from '../types.js';
import { repoScope } from './types.js';

/**
 * 解法與陷阱: what Loop learns from its own runs, so the next local model knows where this repo
 * bites and how a kind of problem was solved here.
 *
 * - learnFromTask: when a task closes, merges or is sent back, and it did not go right the first
 *   time (a check failed, a model was swapped, a person sent it back), the served local model reads
 *   that history and writes at most two 陷阱 (pitfall) and two 解法 (playbook) as DRAFT knowledge
 *   nodes of the task's repo. A person approves them on the 知識 page; drafts never reach a prompt.
 * - matchPitfalls: the approved pitfalls of a repo that fit some text (an error tail, a task) —
 *   their trigger words, the files a task touches, and full-text overlap.
 * - recordHits: how often a pitfall was shown and whether the run then passed, so the ones that
 *   never help sink.
 *
 * `learn_from_runs` (default off) switches the learning on; injection is `repo_profile_inject`.
 */

export interface Trigger {
  /** words or error fragments that mean this pitfall applies (matched case-insensitively) */
  words: string[];
  /** repo-relative files or dirs it is about */
  files: string[];
  /** ticket kinds it is about: bugfix | feature | perf | algo */
  kinds: string[];
}

export interface LearnedMeta {
  key: string;
  trigger: Trigger;
  evidence: Array<{ task: string; note?: string }>;
  hits: { shown: number; passed: number };
  /** pitfall: what goes wrong / why / how to avoid; playbook: the problem class and the steps */
  symptom?: string;
  cause?: string;
  avoid?: string;
  problem?: string;
  steps?: string[];
  verify?: string;
}

export interface FacetNode {
  id: string;
  kind: string;
  title: string;
  body: string;
  scope: string;
  status: string;
  weight: number;
  facet: string | null;
  meta_json: string | null;
}

const LEARN_SYSTEM = [
  '你是資深工程師，替團隊整理「這個 repo 會卡在哪、這類問題怎麼解」的經驗，給之後接手的本地模型看。',
  '只根據提供的任務歷程回答（每次嘗試沒過的檢查與錯誤、換模型的紀錄、人退回的意見、最後改了哪些檔案）；看不出教訓就給空陣列，不要編造。',
  '陷阱要具體：哪種改法或哪個檔案會出什麼錯、為什麼、怎麼避免。解法要能照做：遇到這類問題先做什麼、再做什麼、怎麼驗證。',
  'words 放能在錯誤訊息或任務描述裡出現、用來辨認這個陷阱的字（錯誤字串片段、函式名、參數名），2–6 個。',
  '用繁體中文。只輸出一個 JSON 物件，不要其他文字：',
  '{"pitfalls":[{"title":"一句話","symptom":"會看到什麼錯","cause":"為什麼","avoid":"怎麼避免","words":["…"],"files":["repo 相對路徑"]}],"playbooks":[{"title":"一句話","problem":"適用的問題","steps":["…"],"verify":"怎麼確認修好","files":["…"]}]}',
  '各最多 2 個。',
].join('\n');

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (v: unknown, n: number, each = 120): string[] => (Array.isArray(v) ? v.map((x) => clip(x, each)).filter(Boolean).slice(0, n) : []);

export function readMeta(n: Pick<FacetNode, 'meta_json'>): LearnedMeta | null {
  if (!n.meta_json) return null;
  try {
    const m = JSON.parse(n.meta_json) as LearnedMeta;
    return m && typeof m === 'object' ? { ...m, trigger: { words: m.trigger?.words ?? [], files: m.trigger?.files ?? [], kinds: m.trigger?.kinds ?? [] }, evidence: m.evidence ?? [], hits: m.hits ?? { shown: 0, passed: 0 } } : null;
  } catch {
    return null;
  }
}

/** What went wrong on the way, in lines a model can read: failed checks with their last error lines, model swaps, 退回 notes. */
export function taskStory(db: Database.Database, task: Task): { lines: string[]; troubled: boolean } {
  const lines: string[] = [];
  let troubled = false;
  const runs = listRunsForTask(db, task.id)
    .slice()
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  let prevModel: string | null = null;
  runs.forEach((r, i) => {
    const model = r.model || '預設模型';
    if (prevModel && model !== prevModel) {
      lines.push(`換模型：${prevModel} → ${model}`);
      troubled = true;
    }
    prevModel = model;
    const steps = readVerify(r);
    const bad = steps.find((s) => !s.ok);
    if (bad) {
      troubled = true;
      const tail = (bad.tail ?? '').trim().split('\n').filter(Boolean).slice(-6).join(' / ').slice(0, 600);
      lines.push(`第 ${i + 1} 次（${model}）沒過「${bad.step}」${bad.timedOut ? '（逾時）' : ''}：${tail}`);
    } else if (steps.length) {
      lines.push(`第 ${i + 1} 次（${model}）檢查都過了`);
    } else if (r.error) {
      troubled = true;
      lines.push(`第 ${i + 1} 次（${model}）沒完成：${clip(r.error, 200)}`);
    }
  });
  const events = db
    .prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'status' AND (detail LIKE '退回修改%' OR detail LIKE '重現指令在修改前就通過了%' OR detail LIKE 'setup_cmd failed%') ORDER BY id")
    .all(task.id) as Array<{ detail: string | null }>;
  for (const e of events) {
    if (!e.detail) continue;
    troubled = true;
    lines.push(clip(e.detail, 400));
  }
  return { lines, troubled };
}

function filesOf(db: Database.Database, taskId: string): string[] {
  const row = db.prepare('SELECT files FROM fix_ledger WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as { files: string | null } | undefined;
  return (row?.files ?? '').split('\n').filter(Boolean).slice(0, 30);
}

function parseLearned(text: string): { pitfalls: Array<Record<string, unknown>>; playbooks: Array<Record<string, unknown>> } | null {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>;
    const arr = (x: unknown) => (Array.isArray(x) ? (x.filter((y) => y && typeof y === 'object') as Array<Record<string, unknown>>).slice(0, 2) : []);
    return { pitfalls: arr(v.pitfalls), playbooks: arr(v.playbooks) };
  } catch {
    return null;
  }
}

const keyOf = (kind: string, title: string) => `${kind}:${createHash('sha1').update(title.replace(/\s+/g, '')).digest('hex').slice(0, 12)}`;

/**
 * A learned node: a new draft, or — when the same lesson exists (same key, or a title that
 * full-text-matches closely) — one more piece of evidence on it.
 */
export function upsertLearned(
  db: Database.Database,
  scope: string,
  kind: 'pitfall' | 'playbook',
  title: string,
  body: string,
  meta: Omit<LearnedMeta, 'key' | 'hits'>,
): { id: string; created: boolean } {
  const key = keyOf(kind, title);
  const same = db
    .prepare("SELECT id, meta_json FROM knowledge_nodes WHERE scope = ? AND kind = ? AND invalid_at IS NULL AND status != 'rejected' AND json_extract(meta_json, '$.key') = ?")
    .get(scope, kind, key) as { id: string; meta_json: string | null } | undefined;
  if (same) {
    const m = readMeta(same) ?? { key, trigger: meta.trigger, evidence: [], hits: { shown: 0, passed: 0 } };
    for (const e of meta.evidence) if (!m.evidence.some((x) => x.task === e.task)) m.evidence.push(e);
    m.trigger.words = [...new Set([...m.trigger.words, ...meta.trigger.words])].slice(0, 12);
    m.trigger.files = [...new Set([...m.trigger.files, ...meta.trigger.files])].slice(0, 12);
    db.prepare("UPDATE knowledge_nodes SET meta_json = ?, weight = MIN(5, weight + 1), updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(m), same.id);
    return { id: same.id, created: false };
  }
  const id = `k_${nanoid(10)}`;
  const full: LearnedMeta = { key, ...meta, hits: { shown: 0, passed: 0 } };
  db.prepare(
    `INSERT INTO knowledge_nodes (id, kind, title, body, tags, scope, source, status, weight, facet, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, 'learned', 'draft', 3, ?, ?)`,
  ).run(id, kind, title, body, JSON.stringify(meta.trigger.words), scope, kind, JSON.stringify(full));
  return { id, created: true };
}

export interface LearnDeps {
  localChat?: typeof chatLocal;
}

/** Learn from one finished task (never throws; nothing happens when off, not a repo task, or it went right first time). */
export async function learnFromTask(db: Database.Database, task: Task, outcome: 'merged' | 'returned' | 'abandoned', deps: LearnDeps = {}): Promise<{ pitfalls: number; playbooks: number } | null> {
  try {
    if (!getBool(db, 'learn_from_runs', false) || !task.repo_path) return null;
    const story = taskStory(db, task);
    if (!story.troubled) return null;
    const files = filesOf(db, task.id);
    const kind = (() => {
      try {
        return (JSON.parse(task.analysis_json ?? '{}') as { kind?: string }).kind ?? null;
      } catch {
        return null;
      }
    })();
    const user = [
      `## 任務（${outcome === 'merged' ? '已合併' : outcome === 'returned' ? '被退回修改' : '放棄'}）\n${task.title}\n\n${task.goal.slice(0, 2500)}`,
      `## 歷程\n${story.lines.map((l) => `- ${l}`).join('\n')}`,
      files.length ? `## 最後改到的檔案\n${files.map((f) => `- ${f}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const chat = deps.localChat ?? chatLocal;
    const r = await chat(db, { system: LEARN_SYSTEM, user, maxTokens: 1200, thinking: false });
    if (!r.ok) return null;
    const parsed = parseLearned(r.content);
    if (!parsed) return null;
    const scope = repoScope(task.repo_path);
    const evidence = [{ task: task.id, note: outcome }];
    let pitfalls = 0;
    let playbooks = 0;
    for (const p of parsed.pitfalls) {
      const title = clip(p.title, 80);
      if (!title) continue;
      const meta = { trigger: { words: list(p.words, 6, 60), files: list(p.files, 6, 200).length ? list(p.files, 6, 200) : files.slice(0, 4), kinds: kind ? [kind] : [] }, evidence, symptom: clip(p.symptom, 300), cause: clip(p.cause, 300), avoid: clip(p.avoid, 300) };
      const body = [meta.symptom && `會看到：${meta.symptom}`, meta.cause && `原因：${meta.cause}`, meta.avoid && `避免：${meta.avoid}`].filter(Boolean).join('；');
      upsertLearned(db, scope, 'pitfall', title, body, meta);
      pitfalls++;
    }
    for (const p of parsed.playbooks) {
      const title = clip(p.title, 80);
      const steps = list(p.steps, 8, 200);
      if (!title || !steps.length) continue;
      const meta = { trigger: { words: [], files: list(p.files, 6, 200).length ? list(p.files, 6, 200) : files.slice(0, 4), kinds: kind ? [kind] : [] }, evidence, problem: clip(p.problem, 300), steps, verify: clip(p.verify, 300) };
      const body = [meta.problem && `適用：${meta.problem}`, `步驟：${steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`, meta.verify && `驗證：${meta.verify}`].filter(Boolean).join('；');
      upsertLearned(db, scope, 'playbook', title, body, meta);
      playbooks++;
    }
    if (pitfalls || playbooks) logEvent(db, { task_id: task.id, kind: 'note', detail: `學到 ${pitfalls} 個陷阱、${playbooks} 個解法（草稿，待核可）` });
    return { pitfalls, playbooks };
  } catch {
    return null;
  }
}

// ---- using what was learned ---------------------------------------------------------------------

export interface MatchQuery {
  /** free text: an error tail, a task's title + goal */
  text: string;
  /** files the work is about (the analysis' causes, the run's diff) */
  files?: string[];
  kind?: string | null;
}

function ftsWords(text: string): string {
  // trigram FTS: quote ≥3-char runs (Latin words, CJK runs) as phrases, OR them
  const words = [...new Set((text.match(/[A-Za-z_][A-Za-z0-9_.:]{2,}|[㐀-鿿]{3,}/g) ?? []).map((w) => w.slice(0, 40)))].slice(0, 40);
  return words.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
}

/** The approved nodes of one kind in a repo that fit the query, best first. */
export function matchNodes(db: Database.Database, repoPath: string, kind: 'pitfall' | 'playbook', q: MatchQuery, limit = 5): FacetNode[] {
  const scope = repoScope(repoPath);
  const rows = db
    .prepare("SELECT id, kind, title, body, scope, status, weight, facet, meta_json, rowid FROM knowledge_nodes WHERE scope = ? AND kind = ? AND status = 'approved' AND invalid_at IS NULL")
    .all(scope, kind) as Array<FacetNode & { rowid: number }>;
  if (!rows.length) return [];
  const text = q.text.toLowerCase();
  const fts = new Map<number, number>();
  const match = ftsWords(q.text);
  if (match) {
    try {
      const hits = db.prepare('SELECT rowid, bm25(knowledge_fts) AS s FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY s LIMIT 50').all(match) as Array<{ rowid: number; s: number }>;
      hits.forEach((h, i) => fts.set(h.rowid, 1 - i / 50));
    } catch {
      /* a query FTS cannot parse: lexical triggers only */
    }
  }
  const files = (q.files ?? []).map((f) => f.toLowerCase());
  const scored = rows.map((n) => {
    const m = readMeta(n);
    let s = 0;
    for (const w of m?.trigger.words ?? []) if (w && text.includes(w.toLowerCase())) s += 3;
    for (const f of m?.trigger.files ?? []) {
      const lf = f.toLowerCase();
      if (files.some((x) => x === lf || x.startsWith(lf.endsWith('/') ? lf : `${lf}/`) || lf.startsWith(x))) s += 2;
    }
    if (q.kind && m?.trigger.kinds.includes(q.kind)) s += 1;
    s += 2 * (fts.get(n.rowid) ?? 0);
    // a pitfall that was shown often and never helped sinks
    if (m && m.hits.shown >= 5 && m.hits.passed === 0) s *= 0.5;
    return { n, s: s + n.weight * 0.1 };
  });
  return scored
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.n);
}

export const matchPitfalls = (db: Database.Database, repoPath: string, q: MatchQuery, limit = 5) => matchNodes(db, repoPath, 'pitfall', q, limit);
export const matchPlaybooks = (db: Database.Database, repoPath: string, q: MatchQuery, limit = 2) => matchNodes(db, repoPath, 'playbook', q, limit);

/** Markdown lines for a prompt. */
export function renderLearned(nodes: FacetNode[]): string[] {
  return nodes.map((n) => `- **${n.title.replace(/[*`]/g, '')}**：${n.body.replace(/\s*\n\s*/g, ' ').slice(0, 500)}`);
}

/** Count that these nodes were shown to a run (and, later, whether it passed). */
export function recordHits(db: Database.Database, ids: string[], passed: boolean | null): void {
  for (const id of ids) {
    const row = db.prepare('SELECT meta_json FROM knowledge_nodes WHERE id = ?').get(id) as { meta_json: string | null } | undefined;
    const m = row ? readMeta(row) : null;
    if (!m) continue;
    if (passed === null) m.hits.shown += 1;
    else if (passed) m.hits.passed += 1;
    db.prepare('UPDATE knowledge_nodes SET meta_json = ? WHERE id = ?').run(JSON.stringify(m), id);
  }
}

/** 「這個錯誤以前見過」for LOOP_RESUME_CONTEXT.md: approved pitfalls that fit a failure (only with repo_profile_inject). */
export function seenBefore(db: Database.Database, task: Pick<Task, 'id' | 'repo_path' | 'goal' | 'title' | 'analysis_json'>, failedStep: string, tail: string): string[] {
  if (!task.repo_path || !getBool(db, 'repo_profile_inject', false)) return [];
  try {
    const nodes = matchPitfalls(db, task.repo_path, { text: `${failedStep}\n${tail}`, files: causesOf(task) }, 3);
    recordHits(db, nodes.map((n) => n.id), null);
    return renderLearned(nodes);
  } catch {
    return [];
  }
}

/** The files the 分析 named as likely causes (a ticket), else []. */
export function causesOf(task: Pick<Task, 'analysis_json'>): string[] {
  try {
    const a = JSON.parse(task.analysis_json ?? '{}') as { causes?: Array<{ file?: string }> };
    return (a.causes ?? []).map((c) => c.file ?? '').filter(Boolean);
  } catch {
    return [];
  }
}
