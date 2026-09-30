import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import { getBool, getNum } from '../db/index.js';
import { renderSimilarFixes, similarFixes } from '../repo/ledger.js';

/**
 * What a ticket adds to LOOP_TASK.md, read at dispatch. Every helper returns null for a task that is
 * not a ticket (no repo_id / no images) or when its flag is off, so writeTaskFile writes exactly what
 * it wrote before for everything else.
 */

/** The repo's map (repos.map_path), trimmed to repo_map_budget_chars — only with repo_map_inject. */
export function repoMapFor(db: Database.Database, task: Task): string | null {
  if (!task.repo_id || !getBool(db, 'repo_map_inject', false)) return null;
  const row = db.prepare('SELECT map_path FROM repos WHERE id = ?').get(task.repo_id) as { map_path: string | null } | undefined;
  if (!row?.map_path) return null;
  let text: string;
  try {
    text = fs.readFileSync(row.map_path, 'utf8');
  } catch {
    return null;
  }
  const budget = Math.max(1000, getNum(db, 'repo_map_budget_chars', 8000));
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf('\n', budget);
  return `${text.slice(0, cut > 0 ? cut : budget)}\n- …（其餘省略）`;
}

/** Similar past fixes of this repo — only with fix_ledger_inject. */
export function similarFixesFor(db: Database.Database, task: Task): string | null {
  if (!task.repo_id || !getBool(db, 'fix_ledger_inject', false)) return null;
  const fixes = similarFixes(db, task.repo_id, `${task.title}\n${task.goal}`, 5).filter((f) => f.task_id !== task.id);
  return renderSimilarFixes(fixes);
}

export interface TaskImage {
  file: string;
  name?: string;
  mime?: string;
  bytes?: number;
  text?: string;
  via?: string;
}

export function readTaskImages(task: Pick<Task, 'images_json'>): TaskImage[] {
  if (!task.images_json) return [];
  try {
    const v = JSON.parse(task.images_json) as TaskImage[];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.file === 'string') : [];
  } catch {
    return [];
  }
}

/** The ticket's screenshots with what was read off them. */
export function attachmentsFor(task: Task): Array<{ path: string; text: string }> | null {
  const imgs = readTaskImages(task).filter((i) => fs.existsSync(i.file));
  return imgs.length ? imgs.map((i) => ({ path: i.file, text: i.text ?? '' })) : null;
}
