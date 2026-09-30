import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import { listRunsForTask } from '../tasks.js';

/**
 * 過去修法: a per-repo memory of what was fixed, where, and how it ended. Written when a ticket's
 * work is merged, returned or abandoned; read by the 分析 step (and, with `fix_ledger_inject`, by
 * LOOP_TASK.md) as "similar past fixes of this repo". Only tasks that belong to an imported repo
 * (tasks.repo_id) are recorded — every other task is untouched.
 */

export type FixOutcome = 'merged' | 'returned' | 'abandoned';

export interface FixEntry {
  id: number;
  repo_id: string;
  task_id: string | null;
  issue_ref: string | null;
  title: string;
  symptom: string;
  files: string;
  summary: string;
  outcome: FixOutcome;
  model: string | null;
  attempts: number | null;
  created_at: string;
}

type GitRun = (args: string[], cwd: string) => string;

const defaultGit: GitRun = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** What the task's verified run changed, from the shas it recorded (works after the worktree is gone). */
export function filesOfTask(db: Database.Database, task: Task, git: GitRun = defaultGit): string[] {
  if (!task.repo_path) return [];
  const runs = listRunsForTask(db, task.id).filter((r) => r.head_sha && r.base_sha);
  const r = runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
  if (!r) return [];
  try {
    return git(['diff', '--name-only', `${r.base_sha}..${r.head_sha}`], task.repo_path)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
  } catch {
    return [];
  }
}

function symptomOf(task: Task): string {
  try {
    const intake = task.intake_json ? (JSON.parse(task.intake_json) as { description?: string }) : null;
    if (intake?.description) return intake.description.slice(0, 600);
  } catch {
    /* fall back to the goal */
  }
  return task.goal.slice(0, 600);
}

function summaryOf(task: Task, files: string[]): string {
  try {
    const r = task.review_json ? (JSON.parse(task.review_json) as { summary?: string[]; why?: string }) : null;
    if (r?.summary?.length) return [...r.summary, r.why ? `為什麼：${r.why}` : ''].filter(Boolean).join('\n').slice(0, 1500);
  } catch {
    /* no self-review */
  }
  return files.length ? `改了 ${files.length} 個檔案：${files.slice(0, 8).join('、')}` : '';
}

/** Record one outcome of a ticket (idempotent per task + outcome). Returns the row id, or null when skipped. */
export function recordFix(db: Database.Database, task: Task, outcome: FixOutcome, git: GitRun = defaultGit): number | null {
  if (!task.repo_id) return null;
  const dup = db.prepare('SELECT id FROM fix_ledger WHERE task_id = ? AND outcome = ?').get(task.id, outcome) as { id: number } | undefined;
  if (dup) return null;
  const files = filesOfTask(db, task, git);
  const runs = listRunsForTask(db, task.id);
  const model = runs.map((r) => r.model).filter(Boolean).at(-1) ?? task.model ?? null;
  const res = db
    .prepare(
      `INSERT INTO fix_ledger (repo_id, task_id, issue_ref, title, symptom, files, summary, outcome, model, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(task.repo_id, task.id, task.source_ref ?? null, task.title, symptomOf(task), files.join('\n'), summaryOf(task, files), outcome, model, runs.length || null);
  return Number(res.lastInsertRowid);
}

/** Trigram FTS needs ≥ 3 characters per term: quoted terms from the text, OR-ed. */
export function ftsQuery(text: string): string | null {
  const terms = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_./-]{2,}|[一-鿿]{3,}/g)) {
    const t = m[0].replace(/"/g, '');
    if (/^[一-鿿]+$/.test(t) && t.length > 6) {
      // long CJK runs: overlapping 3-grams would all match; take a few windows
      for (let i = 0; i + 3 <= t.length && terms.size < 24; i += 3) terms.add(t.slice(i, i + 3));
    } else if (t.length >= 3) terms.add(t);
    if (terms.size >= 24) break;
  }
  if (!terms.size) return null;
  return [...terms].map((t) => `"${t}"`).join(' OR ');
}

/** The k most similar past fixes of this repo (best first). */
export function similarFixes(db: Database.Database, repoId: string, text: string, k = 5): FixEntry[] {
  const q = ftsQuery(text);
  if (!q) return [];
  try {
    return db
      .prepare(
        `SELECT l.* FROM fix_ledger_fts f JOIN fix_ledger l ON l.id = f.rowid
         WHERE fix_ledger_fts MATCH ? AND l.repo_id = ? ORDER BY bm25(fix_ledger_fts) LIMIT ?`,
      )
      .all(q, repoId, k) as FixEntry[];
  } catch {
    return [];
  }
}

export function listFixes(db: Database.Database, repoId: string, limit = 50): FixEntry[] {
  return db.prepare('SELECT * FROM fix_ledger WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(repoId, limit) as FixEntry[];
}

/** The LOOP_TASK.md block (and the 分析 prompt's context). */
export function renderSimilarFixes(fixes: FixEntry[]): string | null {
  if (!fixes.length) return null;
  const label: Record<FixOutcome, string> = { merged: '已合併', returned: '被退回', abandoned: '放棄' };
  return fixes
    .map((f) => {
      const files = f.files.split('\n').filter(Boolean).slice(0, 6).join('、');
      return `- ${f.title}（${label[f.outcome]}${f.model ? ` · ${f.model}` : ''}）${files ? `\n  改了：${files}` : ''}${f.summary ? `\n  ${f.summary.split('\n')[0]}` : ''}`;
    })
    .join('\n');
}
