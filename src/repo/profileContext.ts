import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import type { Task } from '../types.js';
import { getProfileRow, readFacets } from './profileStore.js';
import { causesOf, matchPitfalls, matchPlaybooks, noteShown, recordHits, renderLearned } from '../knowledge/learn.js';
import { repoScope } from '../knowledge/types.js';

/**
 * LOOP_TASK.md「這個 repo 的規範與經驗」(repo_profile_inject, default off): what the Repo 檔案 and
 * the learned knowledge say that matters for THIS task — the environment it builds in, how the
 * files it will touch are written, the approved 陷阱 and 解法 that fit it, and the meaning of any
 * parameter the task names. Packed into repo_profile_budget_chars; pitfalls first (they are the
 * point), then style, playbooks, parameters, requirements. Null when off or nothing applies.
 */

interface StyleLike {
  module: string;
  encoding?: { dominant?: string | null; big5?: number };
  eol?: string | null;
  indent?: string | null;
  brace?: string | null;
  naming?: string[];
  header_guard?: string | null;
  comment_lang?: string | null;
  error_handling?: string[];
  logging?: string[];
  strings?: string[];
}
interface RequirementLike {
  kind: string;
  name: string;
  version: string | null;
  note?: string | null;
  module?: string | null;
}

const ENC: Record<string, string> = { utf8: 'UTF-8（無 BOM）', utf8_bom: 'UTF-8 with BOM', big5: 'Big5（存檔不要轉成 UTF-8）', mixed: '混用：照原檔的編碼存' };

export function styleLine(s: StyleLike): string {
  const parts = [
    s.encoding?.dominant ? `編碼 ${ENC[s.encoding.dominant] ?? s.encoding.dominant}` : null,
    s.eol ? `換行 ${s.eol === 'crlf' ? 'CRLF' : s.eol === 'lf' ? 'LF' : '照原檔'}` : null,
    s.indent ? `縮排 ${s.indent === 'tab' ? 'Tab' : s.indent === 'mixed' ? '照原檔' : `${s.indent} 格空白`}` : null,
    s.brace ? `大括號${s.brace === 'same_line' ? '不換行' : s.brace === 'next_line' ? '換行' : '照原檔'}` : null,
    s.header_guard === 'pragma_once' ? '標頭用 #pragma once' : s.header_guard === 'ifndef' ? '標頭用 #ifndef 守衛' : null,
    s.naming?.length ? `命名：${s.naming.slice(0, 4).join('、')}` : null,
    s.comment_lang ? `註解用${s.comment_lang === 'zh' ? '中文' : s.comment_lang === 'en' ? '英文' : '中英皆可'}` : null,
    s.error_handling?.length ? `錯誤處理：${s.error_handling.join('、')}` : null,
    s.logging?.length ? `log：${s.logging.slice(0, 3).join('、')}` : null,
    s.strings?.length ? `字串：${s.strings.join('、')}` : null,
  ].filter(Boolean);
  return `- ${s.module || '整個 repo'}：${parts.join('；')}`;
}

/** The style profiles that apply to these files (their modules), else the repo-wide one. */
export function stylesFor(styles: StyleLike[], files: string[]): StyleLike[] {
  const hit = styles.filter((s) => s.module && files.some((f) => f === s.module || f.startsWith(`${s.module.replace(/\/$/, '')}/`)));
  if (hit.length) return hit.slice(0, 3);
  const all = styles.find((s) => !s.module);
  return all ? [all] : styles.slice(0, 2);
}

function paramLines(db: Database.Database, repoId: string, text: string): string[] {
  const rows = db.prepare("SELECT key, section, file, line, value, meaning FROM code_index WHERE repo_id = ? AND kind = 'param'").all(repoId) as Array<{ key: string; section: string | null; file: string; line: number; value: string | null; meaning: string | null }>;
  const named = rows.filter((r) => r.key.length >= 4 && new RegExp(`\\b${r.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)).slice(0, 8);
  const use = db.prepare("SELECT file, line FROM code_index WHERE repo_id = ? AND kind = 'param_use' AND key = ? LIMIT 2");
  const repoPath = (db.prepare('SELECT local_path FROM repos WHERE id = ?').get(repoId) as { local_path: string } | undefined)?.local_path;
  const inferred = db.prepare("SELECT body FROM knowledge_nodes WHERE scope = ? AND kind = 'param' AND status = 'approved' AND invalid_at IS NULL AND title = ? LIMIT 1");
  return named.map((r) => {
    if (!r.meaning && repoPath) r.meaning = (inferred.get(repoScope(repoPath), `[${r.section ?? ''}] ${r.key}`) as { body: string } | undefined)?.body ?? null;
    const where = (use.all(repoId, r.key) as Array<{ file: string; line: number }>).map((u) => `${u.file}:${u.line}`).join('、');
    return `- \`[${r.section ?? ''}] ${r.key}\`（預設 ${r.value ?? '—'}，定義在 ${r.file}:${r.line}${where ? `，程式在 ${where} 讀取` : ''}）${r.meaning ? `：${r.meaning.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
  });
}

export interface ProfileSection {
  text: string;
  /** pitfall + playbook node ids that were included (their hits are counted) */
  shown: string[];
}

export function profileSectionFor(db: Database.Database, task: Task): ProfileSection | null {
  if (!getBool(db, 'repo_profile_inject', false) || !task.repo_path) return null;
  const budget = Math.max(800, getNum(db, 'repo_profile_budget_chars', 3500));
  const files = causesOf(task);
  let kind: string | null = null;
  try {
    kind = (JSON.parse(task.analysis_json ?? '{}') as { kind?: string }).kind ?? null;
  } catch {
    kind = null;
  }
  const text = `${task.title}\n${task.goal}`;
  const pits = matchPitfalls(db, task.repo_path, { text, files, kind }, 5);
  const books = matchPlaybooks(db, task.repo_path, { text, files, kind }, 2);
  const facets = task.repo_id ? readFacets<{ style?: StyleLike[]; requirements?: RequirementLike[] }>(getProfileRow(db, task.repo_id)) : null;
  const rules = db
    .prepare("SELECT title, body FROM knowledge_nodes WHERE scope = ? AND kind = 'style' AND status = 'approved' AND invalid_at IS NULL ORDER BY weight DESC LIMIT 8")
    .all(repoScope(task.repo_path)) as Array<{ title: string; body: string }>;

  const blocks: Array<{ head: string; lines: string[]; ids?: string[] }> = [];
  if (pits.length) blocks.push({ head: '### 陷阱（先讀：這個 repo 以前在這裡卡過）', lines: renderLearned(pits), ids: pits.map((n) => n.id) });
  const styleLines = [...(facets?.style?.length ? stylesFor(facets.style, files).map(styleLine) : []), ...rules.map((r) => `- ${r.title}：${r.body.replace(/\s+/g, ' ').slice(0, 200)}`)];
  if (styleLines.length) blocks.push({ head: '### 寫法（照這個 repo 的風格，存檔編碼不要改）', lines: styleLines });
  if (books.length) blocks.push({ head: '### 這類問題在這個 repo 的解法', lines: renderLearned(books), ids: books.map((n) => n.id) });
  const params = task.repo_id ? paramLines(db, task.repo_id, text) : [];
  if (params.length) blocks.push({ head: '### 任務提到的參數', lines: params });
  const reqs = (facets?.requirements ?? []).slice(0, 10).map((r) => `- ${r.name}${r.version ? ` ${r.version}` : ''}${r.module ? `（${r.module}）` : ''}${r.note ? `：${r.note}` : ''}`);
  if (reqs.length) blocks.push({ head: '### 建置與執行需要', lines: reqs });
  if (!blocks.length) return null;

  // pack: blocks in priority order; a line that does not fit is dropped (and so is the rest of its block)
  const out: string[] = [];
  const shown: string[] = [];
  let used = 0;
  for (const b of blocks) {
    if (used + b.head.length + 2 > budget) break;
    out.push(b.head);
    used += b.head.length + 1;
    for (const [i, l] of b.lines.entries()) {
      if (used + l.length + 1 > budget) break;
      out.push(l);
      used += l.length + 1;
      if (b.ids?.[i]) shown.push(b.ids[i]!);
    }
  }
  return { text: out.join('\n'), shown };
}

/** For run.ts: the section text, counting each included pitfall / playbook as shown once (and noting it on the run). */
export function profileContextFor(db: Database.Database, task: Task, runId?: string): string | null {
  try {
    const s = profileSectionFor(db, task);
    if (!s) return null;
    recordHits(db, s.shown, null);
    if (runId) noteShown(db, task.id, runId, s.shown);
    return s.text;
  } catch {
    return null;
  }
}
