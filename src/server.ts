import type Database from 'better-sqlite3';
import { getDb, getNum, logEvent } from './db/index.js';
import { createEngine } from './engine.js';
import { buildApp } from './server/app.js';
import { notify, nearLimitEdge, routeStatusEvent } from './notify.js';
import { readUsage } from './token/usage.js';
import { paths } from './config.js';
import { pumpPushback } from './integrations/pushback.js';

/** Production entry: runs the scheduling loop AND serves the API/board. systemd runs this. */
export async function main(): Promise<void> {
  const db = getDb();
  const engine = createEngine(db);
  const app = buildApp({ db });

  const pollMs = getNum(db, 'poll_interval_sec', 60) * 1000;
  let lastEventId = (db.prepare('SELECT COALESCE(MAX(id),0) n FROM task_events').get() as { n: number }).n;
  let lastActive = -1;
  let nearWarned = false;
  let lastReason: string | null = null;
  let lastPushbackId = lastEventId;

  const loop = () => {
    try {
      const info = engine.tickOnce();
      // Persist the scheduler's "why" only when it CHANGES, so the board can show a live
      // "holding: session 82% >= 65%" and the history stays a compact change-log.
      if (info.reason !== lastReason) {
        lastReason = info.reason;
        logEvent(db, {
          kind: 'scheduler',
          detail: info.reason,
          session_pct: info.reading.session.percent,
          weekly_pct: info.reading.weekly.percent,
        });
      }
    } catch (err) {
      console.error('[tick] error:', err);
    }
    void pumpNotifications(db, lastEventId, lastActive, nearWarned).then((r) => {
      lastEventId = r.lastEventId;
      lastActive = r.lastActive;
      nearWarned = r.nearWarned;
    });
    // D5 pushback: fire-and-forget, never delays the tick loop (see integrations/pushback.ts)
    void pumpPushback(db, lastPushbackId).then((id) => {
      lastPushbackId = id;
    });
  };

  const bind = process.env.LOOP_BIND ?? '127.0.0.1';
  const port = Number(process.env.LOOP_PORT ?? '4711');
  await app.listen({ host: bind, port });
  console.log(`[loop-engineering] http://${bind}:${port}  data=${paths.dataDir}  poll=${pollMs / 1000}s`);
  if (!process.env.LOOP_API_TOKEN) console.warn('[warn] LOOP_API_TOKEN unset — API is unauthenticated (rely on Tailscale)');

  loop();
  const iv = setInterval(loop, pollMs);

  const shutdown = async () => {
    clearInterval(iv);
    engine.stop();
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Turn new status/breaker events into ntfy pushes; return updated cursors. */
async function pumpNotifications(
  db: Database.Database,
  lastEventId: number,
  lastActive: number,
  nearWarned: boolean,
): Promise<{ lastEventId: number; lastActive: number; nearWarned: boolean }> {
  const events = db
    .prepare(
      `SELECT id, task_id, kind, to_status, detail FROM task_events
        WHERE id > ? AND (kind = 'breaker' OR (kind = 'status' AND to_status IN ('review','failed','blocked','attention')))
        ORDER BY id ASC`,
    )
    .all(lastEventId) as { id: number; task_id: string; kind: string; to_status: string | null; detail: string | null }[];

  for (const e of events) {
    lastEventId = Math.max(lastEventId, e.id);
    if (e.kind === 'breaker') {
      await notify(db, {
        title: 'Loop: budget breaker tripped',
        message: `Interrupted running task (${e.detail ?? ''}). Scheduler will resume after reset.`,
        priority: 'high',
        tags: ['warning'],
        withPauseAction: true,
      });
      continue;
    }
    // Enrich review events with the git close-out outcome so the push says how the
    // merge landed; the mapping itself is pure (routeStatusEvent, unit-tested).
    const merge_status =
      e.to_status === 'review'
        ? ((db.prepare('SELECT merge_status FROM tasks WHERE id = ?').get(e.task_id) as
            | { merge_status: string | null }
            | undefined)?.merge_status ?? null)
        : null;
    const push = routeStatusEvent({ task_id: e.task_id, to_status: e.to_status, detail: e.detail, merge_status });
    if (push) await notify(db, push);
  }

  // queue-drained notification (edge-triggered)
  const active = (
    db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','running','verifying')").get() as { n: number }
  ).n;
  if (lastActive > 0 && active === 0) {
    await notify(db, { title: 'Loop: all clear', message: 'Queue drained — nothing running.', tags: ['sparkles'] });
  }

  // pre-emptive near-limit warning (edge-triggered): fire once as session% climbs
  // into the warn band while a run is live, before the breaker actually interrupts.
  const reading = readUsage();
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  const warnMargin = getNum(db, 'warn_margin_pct', 5);
  const runningNow = (
    db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('running','verifying')").get() as { n: number }
  ).n;
  const edge = nearLimitEdge({
    sessionPct: reading.session.percent,
    hardLimitPct: hardLimit,
    warnMarginPct: warnMargin,
    hasActiveRun: runningNow > 0,
    alreadyWarned: nearWarned,
  });
  if (edge.fire) {
    await notify(db, {
      title: 'Loop: approaching usage limit',
      message: `session ${Math.round(reading.session.percent)}% ≥ ${hardLimit - warnMargin}% (hard limit ${hardLimit}%). Breaker will interrupt at ${hardLimit}%.`,
      priority: 'high',
      tags: ['warning'],
      withPauseAction: true,
    });
  }
  return { lastEventId, lastActive: active, nearWarned: edge.warned };
}

const invoked = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
