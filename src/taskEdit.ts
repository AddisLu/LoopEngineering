import type Database from 'better-sqlite3';
import { logEvent } from './db/index.js';
import { getTask } from './tasks.js';
import { parseAcceptance } from './orchestrator/acceptance.js';
import type { Task } from './types.js';

/** The verification settings a task can still change after it was created. */
export interface VerificationPatch {
  verification_steps?: string[];
  verify_mode?: string | null;
  acceptance_metrics?: string | null;
  artifacts?: string | null;
  protected_paths?: string | null;
  verify_timeout_min?: number | null;
}

export class TaskEditError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const VERIFY_MODES = new Set(['command', 'llm', 'manual']);
const MAX_STEP_CHARS = 2000;

/**
 * Change how a task is verified after it was created: move a step into the GPU 沙盒 (`sandbox: …`)
 * so the review page can re-run it, or add 驗收指標 / 產出物 / 保護路徑. The next verification — the
 * engine's, a 合併's, `loop verify` — uses them; results already on record stay as they were.
 * Refused while the task runs, since the pass in flight would mix the old rules with the new.
 * `updated_at` is left alone: it dates the task's status (pruning ages closed tasks by it).
 */
export function updateVerification(db: Database.Database, id: string, patch: VerificationPatch, by: string | null = null): Task {
  const task = getTask(db, id);
  if (!task) throw new TaskEditError('not found', 404);
  if (task.status === 'running' || task.status === 'verifying') {
    throw new TaskEditError(`task is ${task.status} — change its verification after this run`, 409);
  }

  const cols: string[] = [];
  const values: Array<string | number | null> = [];
  const put = (col: string, value: string | number | null) => {
    cols.push(col);
    values.push(value);
  };

  if (patch.verification_steps !== undefined) {
    if (!Array.isArray(patch.verification_steps) || patch.verification_steps.some((s) => typeof s !== 'string')) {
      throw new TaskEditError('verification_steps must be a list of commands');
    }
    const steps = patch.verification_steps.map((s) => s.trim()).filter(Boolean);
    if (steps.some((s) => s.length > MAX_STEP_CHARS)) throw new TaskEditError(`a verification step is longer than ${MAX_STEP_CHARS} characters`);
    put('verification_steps', JSON.stringify(steps));
  }
  if (patch.verify_mode !== undefined) {
    const modes = (patch.verify_mode ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = modes.filter((m) => !VERIFY_MODES.has(m));
    if (bad.length) throw new TaskEditError(`verify_mode takes command, llm and/or manual (got: ${bad.join(', ')})`);
    put('verify_mode', modes.length ? [...new Set(modes)].join(',') : null);
  }
  if (patch.acceptance_metrics !== undefined) {
    const text = (patch.acceptance_metrics ?? '').trim();
    try {
      parseAcceptance(text);
    } catch (err) {
      throw new TaskEditError((err as Error).message);
    }
    put('acceptance_metrics', text || null);
  }
  for (const col of ['artifacts', 'protected_paths'] as const) {
    if (patch[col] === undefined) continue;
    const csv = (patch[col] ?? '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(',');
    put(col, csv || null);
  }
  if (patch.verify_timeout_min !== undefined) {
    const v = patch.verify_timeout_min;
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 1440)) {
      throw new TaskEditError('verify_timeout_min must be whole minutes from 1 to 1440, or null for the default');
    }
    put('verify_timeout_min', v);
  }
  if (!cols.length) throw new TaskEditError('nothing to change');

  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
  logEvent(db, { task_id: id, kind: 'note', detail: `驗證設定已修改${by ? `（${by}）` : ''}：${cols.join(', ')}` });
  return getTask(db, id)!;
}
