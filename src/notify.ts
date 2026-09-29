import type Database from 'better-sqlite3';
import { getSetting } from './db/index.js';

/**
 * Edge-triggered decision for the pre-emptive "approaching usage limit" warning.
 * Fires exactly once when session% first crosses (hard_limit_pct - warn_margin_pct)
 * WHILE a run is active, then stays quiet until usage drops back below the threshold
 * (which re-arms it). Being above the threshold with nothing running keeps it armed
 * but silent, so a warning still fires the moment a run starts.
 *
 * `alreadyWarned` is the caller-held edge state; feed back the returned `warned`.
 */
export function nearLimitEdge(opts: {
  sessionPct: number;
  hardLimitPct: number;
  warnMarginPct: number;
  hasActiveRun: boolean;
  alreadyWarned: boolean;
}): { fire: boolean; warned: boolean } {
  const warnAt = opts.hardLimitPct - opts.warnMarginPct;
  if (!(opts.sessionPct >= warnAt)) return { fire: false, warned: false }; // below -> re-arm
  if (opts.alreadyWarned) return { fire: false, warned: true }; // already fired this excursion
  if (!opts.hasActiveRun) return { fire: false, warned: false }; // armed, waiting for a run
  return { fire: true, warned: true };
}

export interface StatusNotification {
  title: string;
  message: string;
  priority: 'min' | 'low' | 'default' | 'high' | 'urgent';
  tags?: string[];
}

/**
 * Pure status-event → push mapping for the server's notification pump (unit-testable).
 * `merge_status` is looked up by the caller for review events, so this stays DB-free.
 * Returns null for statuses that don't notify.
 */
export function routeStatusEvent(e: {
  task_id: string;
  to_status: string | null;
  detail: string | null;
  merge_status?: string | null;
}): StatusNotification | null {
  switch (e.to_status) {
    case 'attention':
      // human hold — worktree/session/HANDOFF preserved, someone must decide
      return {
        title: 'Loop: 任務待確認',
        message: `${e.task_id} — ${e.detail ?? '執行出問題，已保留現場'}`,
        priority: 'high',
        tags: ['warning'],
      };
    case 'blocked':
      // was dead code: the old pump SQL selected blocked events but never handled them
      return {
        title: 'Loop: task interrupted',
        message: `${e.task_id} — interrupted; will auto-resume${e.detail ? ` (${e.detail})` : ''}`,
        priority: 'default',
      };
    case 'review': {
      if (e.merge_status === 'conflict') {
        return {
          title: 'Loop: task ready for review',
          message: `${e.task_id}（合併衝突—已建解衝突任務）`,
          priority: 'high',
          tags: ['warning'],
        };
      }
      const suffix =
        e.merge_status === 'merged' ? '（已自動併入 main）' : e.merge_status === 'pending' ? '（待合併）' : '';
      return {
        title: 'Loop: task ready for review',
        message: `${e.task_id}${suffix}`,
        priority: 'default',
        tags: ['white_check_mark'],
      };
    }
    case 'failed':
      return {
        title: 'Loop: task failed',
        message: `${e.task_id} — ${e.detail ?? ''}`,
        priority: 'high',
        tags: ['x'],
      };
    default:
      return null;
  }
}

/**
 * HTTP header values must be Latin-1 — fetch throws on anything else, so a Chinese title used to
 * drop the whole push. ntfy decodes RFC 2047 encoded-words in its headers; ASCII passes as is.
 */
export function headerValue(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/**
 * Fire-and-forget ntfy push. warning/critical notifications carry a Pause action
 * button that POSTs /api/pause (with the bearer header) so you can stop the
 * scheduler from the phone notification shade — before the board even exists.
 */
export async function notify(
  db: Database.Database,
  opts: {
    title: string;
    message: string;
    priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
    tags?: string[];
    withPauseAction?: boolean;
    /** opened when the notification is tapped (e.g. the morning report page) */
    click?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const server = getSetting(db, 'ntfy_server') || process.env.NTFY_SERVER || '';
  const topic = getSetting(db, 'ntfy_topic') || process.env.NTFY_TOPIC || '';
  if (!server || !topic) return; // notifications disabled

  const headers: Record<string, string> = {
    Title: headerValue(opts.title),
    Priority: opts.priority ?? 'default',
  };
  if (opts.tags?.length) headers.Tags = opts.tags.join(',');
  if (opts.click) headers.Click = headerValue(opts.click);

  if (opts.withPauseAction) {
    const base = process.env.LOOP_PUBLIC_URL || `http://127.0.0.1:${process.env.LOOP_PORT ?? '4711'}`;
    const bearer = process.env.LOOP_API_TOKEN ? `, headers.Authorization=Bearer ${process.env.LOOP_API_TOKEN}` : '';
    headers.Actions = `http, Pause, ${base}/api/pause, method=POST${bearer}`;
  }

  try {
    await fetchImpl(`${server.replace(/\/$/, '')}/${topic}`, {
      method: 'POST',
      headers,
      body: opts.message,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best effort */
  }
}
