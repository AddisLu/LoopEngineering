import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import { getRun } from '../tasks.js';
import { readVerify } from '../orchestrator/runSummary.js';
import { chatLocal } from '../local/chat.js';
import { profileSectionFor } from '../repo/profileContext.js';

/**
 * 本地自評 (`local_self_review`): after verification passes, the served local model reads the diff
 * and the check results and writes what a reviewer needs first — what changed, why, the risks, and
 * anything outside the task's scope. Stored in tasks.review_json, shown on the 結果 page, put in the
 * PR body and kept in the fix ledger. It never blocks: any failure leaves review_json empty.
 */

export interface SelfReview {
  summary: string[];
  why: string;
  risks: string[];
  out_of_scope: string[];
  confidence: 'high' | 'medium' | 'low';
  model?: string | null;
  at?: string;
}

const DIFF_CAP = 12_000;

const SYSTEM = [
  '你是資深工程師，替同事做程式碼審查前的整理。只根據提供的差異與檢查結果回答，不要臆測沒看到的程式。',
  '用繁體中文。只輸出一個 JSON 物件，不要其他文字：',
  '{"summary":["改了什麼（最多 5 條，一條一句）"],"why":"為什麼這樣改能解決問題（一兩句）","risks":["可能出問題的地方（沒有就空陣列）"],"out_of_scope":["和任務無關的改動（沒有就空陣列）"],"confidence":"high|medium|low"}',
].join('\n');

function gitDiff(cwd: string, base: string): string {
  try {
    const out = execFileSync('git', ['diff', `${base}...HEAD`], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.length > DIFF_CAP ? `${out.slice(0, DIFF_CAP)}\n...(truncated)` : out;
  } catch {
    return '';
  }
}

/** Defensive JSON extraction: the first {...} block, fields coerced to the expected shapes. */
export function parseSelfReview(text: string): SelfReview | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const list = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, n) : []);
  const summary = list(raw.summary, 5);
  if (!summary.length) return null;
  const conf = String(raw.confidence ?? '').toLowerCase();
  return {
    summary,
    why: String(raw.why ?? '').trim().slice(0, 600),
    risks: list(raw.risks, 5),
    out_of_scope: list(raw.out_of_scope, 5),
    confidence: conf === 'high' || conf === 'low' ? conf : 'medium',
  };
}

export interface SelfReviewDeps {
  localChat?: typeof chatLocal;
  diff?: (cwd: string, base: string) => string;
}

export async function runSelfReview(
  db: Database.Database,
  task: Task,
  worktree: string,
  base: string | null,
  runId: string,
  deps: SelfReviewDeps = {},
): Promise<SelfReview | null> {
  const chat = deps.localChat ?? chatLocal;
  const diff = base ? (deps.diff ?? gitDiff)(worktree, base) : '';
  if (!diff.trim()) return null;
  const steps = readVerify(getRun(db, runId));
  const checks = steps.length ? steps.map((s) => `- ${s.ok ? '✓' : '✗'} ${s.step}`).join('\n') : '（沒有檢查紀錄）';
  const prompt = [
    `## 任務\n${task.title}\n\n${task.goal.slice(0, 3000)}`,
    `## 檢查結果\n${checks}`,
    task.protected_paths ? `## 保護路徑（不應修改）\n${task.protected_paths}` : '',
    // 這個 repo 的規範與經驗 (repo_profile_inject): check the diff against the style and the known pitfalls
    (() => {
      const k = profileSectionFor(db, task);
      return k ? `## 這個 repo 的規範與陷阱（檢查差異有沒有違反；違反的寫進 risks）\n${k.text}` : '';
    })(),
    `## 差異\n\`\`\`diff\n${diff}\n\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n');
  let r: Awaited<ReturnType<typeof chatLocal>>;
  try {
    r = await chat(db, { system: SYSTEM, user: prompt, maxTokens: 1500, thinking: false });
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const parsed = parseSelfReview(r.content);
  if (!parsed) return null;
  const review: SelfReview = { ...parsed, model: task.model ?? null, at: new Date().toISOString() };
  db.prepare('UPDATE tasks SET review_json = ? WHERE id = ?').run(JSON.stringify(review), task.id);
  return review;
}

export function readSelfReview(task: Pick<Task, 'review_json'>): SelfReview | null {
  if (!task.review_json) return null;
  try {
    const r = JSON.parse(task.review_json) as SelfReview;
    return Array.isArray(r.summary) ? r : null;
  } catch {
    return null;
  }
}

/** Markdown for the PR body. */
export function renderSelfReview(r: SelfReview): string {
  const lines = ['### Loop 的自評', ...r.summary.map((s) => `- ${s}`)];
  if (r.why) lines.push('', `**為什麼：** ${r.why}`);
  if (r.risks.length) lines.push('', '**風險：**', ...r.risks.map((s) => `- ${s}`));
  if (r.out_of_scope.length) lines.push('', '**範圍外的改動：**', ...r.out_of_scope.map((s) => `- ${s}`));
  return lines.join('\n');
}
