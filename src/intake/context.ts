import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import { getBool, getNum } from '../db/index.js';
import { renderSimilarFixes, similarFixes } from '../repo/ledger.js';
import { describeChecks, parseCheckSnapshots } from '../checks/render.js';
import { SANDBOX_MACHINE_RE } from '../checks/store.js';
import { getMachine } from '../exec/machines.js';
import { describeBox, getHostSpecs, readSpecs } from '../exec/specs.js';

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

/** The task's checks in plain words (replaces the raw check:<id> steps in LOOP_TASK.md). */
export function checkLinesFor(task: Task): string[] | null {
  if (!task.checks_json) return null;
  try {
    const snap = parseCheckSnapshots(task);
    return snap.length ? describeChecks(snap) : null;
  } catch {
    return null;
  }
}

/** The engine host — where the agent itself works — as describeBox lines. */
export function engineBoxLines(db: Database.Database, head = '引擎主機（你現在所在的環境）'): string[] {
  const row = getHostSpecs(db, 'local');
  return describeBox(head, readSpecs(row?.specs_json), { software: row?.software });
}

/** A check's machine (null = the engine host, a machines.name, or sandbox:<host>) as describeBox lines. */
export function machineBoxLines(db: Database.Database, machine: string | null, checks: string[] = []): string[] {
  const runs = checks.length ? `；跑：${checks.join('、')}` : '';
  if (!machine) return engineBoxLines(db, `引擎主機（你現在所在的環境）${runs}`);
  const sb = SANDBOX_MACHINE_RE.exec(machine);
  if (sb) {
    const row = getHostSpecs(db, sb[1]!);
    return describeBox(`GPU 沙盒 ${sb[1]}（Docker 容器，沒有網路）${runs}`, readSpecs(row?.specs_json), { software: row?.software });
  }
  const m = getMachine(db, machine);
  if (!m) return [`- ${machine}（找不到這台機台）${runs}`];
  const os = m.os === 'windows' ? `Windows，${m.shell === 'cmd' ? 'cmd' : 'PowerShell'}` : m.os === 'linux' ? 'Linux，bash' : '作業系統未偵測';
  return describeBox(`${m.name}（${os}，引擎透過 SSH 代跑）${runs}`, readSpecs(m.specs_json), { software: m.software, description: m.description });
}

/**
 * LOOP_TASK.md「## 機台與環境」: where the agent works, then every box the task's checks run on with
 * its 規格, so commands, paths and builds fit each one. Null for a task without checks.
 */
export function machineLinesFor(db: Database.Database, task: Task): string[] | null {
  if (!task.checks_json) return null;
  try {
    const snap = parseCheckSnapshots(task).filter((c) => c.kind !== 'manual');
    if (!snap.length) return null;
    const byBox = new Map<string, string[]>();
    for (const c of snap) {
      const k = c.machine ?? '';
      byBox.set(k, [...(byBox.get(k) ?? []), c.name]);
    }
    const lines = byBox.has('') ? machineBoxLines(db, null, byBox.get('')!) : engineBoxLines(db);
    for (const [k, names] of byBox) if (k) lines.push(...machineBoxLines(db, k, names));
    return lines;
  } catch {
    return null;
  }
}
