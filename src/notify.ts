import type Database from 'better-sqlite3';
import { getSetting } from './db/index.js';

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
  },
): Promise<void> {
  const server = getSetting(db, 'ntfy_server') || process.env.NTFY_SERVER || '';
  const topic = getSetting(db, 'ntfy_topic') || process.env.NTFY_TOPIC || '';
  if (!server || !topic) return; // notifications disabled

  const headers: Record<string, string> = {
    Title: opts.title,
    Priority: opts.priority ?? 'default',
  };
  if (opts.tags?.length) headers.Tags = opts.tags.join(',');

  if (opts.withPauseAction) {
    const base = process.env.LOOP_PUBLIC_URL || `http://127.0.0.1:${process.env.LOOP_PORT ?? '4711'}`;
    const bearer = process.env.LOOP_API_TOKEN ? `, headers.Authorization=Bearer ${process.env.LOOP_API_TOKEN}` : '';
    headers.Actions = `http, Pause, ${base}/api/pause, method=POST${bearer}`;
  }

  try {
    await fetch(`${server.replace(/\/$/, '')}/${topic}`, {
      method: 'POST',
      headers,
      body: opts.message,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best effort */
  }
}
