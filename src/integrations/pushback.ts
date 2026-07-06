import type Database from 'better-sqlite3';
import { getBool, logEvent } from '../db/index.js';
import { getTask } from '../tasks.js';
import { resolveProvider } from './config.js';
import { parseSourceRef } from './sourceRef.js';
import type { WorkProvider } from './types.js';

/**
 * Fire-and-forget pushback pump — same cursor idiom as server.ts's pumpNotifications:
 * scan task_events for status transitions into review/closed, and for any task with a
 * source_ref, comment the PR link + outcome back onto the origin work item. Gated by the
 * `integration_pushback` setting (default false) — off means this never calls a provider,
 * only advances the cursor. `opts.provider` overrides resolveProvider() for tests.
 */
export async function pumpPushback(
  db: Database.Database,
  lastEventId: number,
  opts: { provider?: WorkProvider | null } = {},
): Promise<number> {
  const events = db
    .prepare(
      `SELECT id, task_id FROM task_events
        WHERE id > ? AND kind = 'status' AND to_status IN ('review','closed')
        ORDER BY id ASC`,
    )
    .all(lastEventId) as { id: number; task_id: string | null }[];

  let cursor = lastEventId;
  for (const e of events) {
    cursor = Math.max(cursor, e.id);
    if (!e.task_id) continue;
    if (!getBool(db, 'integration_pushback', false)) continue;

    const task = getTask(db, e.task_id);
    if (!task || !task.source_ref) continue;

    const provider = opts.provider !== undefined ? opts.provider : resolveProvider(db);
    if (!provider) continue;

    const item = parseSourceRef(task.source_ref, task);
    if (!item) continue;

    try {
      await provider.pushResult(item, { pr_url: task.pr_url, status: task.status, merge_status: task.merge_status });
      logEvent(db, { task_id: task.id, kind: 'note', detail: `pushback: ok (${provider.name} ${task.source_ref})` });
    } catch {
      logEvent(db, { task_id: task.id, kind: 'note', detail: `pushback: failed (${provider.name} ${task.source_ref})` });
    }
  }
  return cursor;
}
