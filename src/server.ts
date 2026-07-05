import type Database from 'better-sqlite3';
import { getDb, getNum } from './db/index.js';
import { createEngine } from './engine.js';
import { buildApp } from './server/app.js';
import { notify, nearLimitEdge } from './notify.js';
import { readUsage } from './token/usage.js';
import { paths } from './config.js';

/** Production entry: runs the scheduling loop AND serves the API/board. systemd runs this. */
export async function main(): Promise<void> {
  const db = getDb();
  const engine = createEngine(db);
  const app = buildApp({ db });

  const pollMs = getNum(db, 'poll_interval_sec', 60) * 1000;
  let lastEventId = (db.prepare('SELECT COALESCE(MAX(id),0) n FROM task_events').get() as { n: number }).n;
  let lastActive = -1;
  let nearWarned = false;

  const loop = () => {
    try {
      engine.tickOnce();
    } catch (err) {
      console.error('[tick] error:', err);
    }
    void pumpNotifications(db, lastEventId, lastActive, nearWarned).then((r) => {
      lastEventId = r.lastEventId;
      lastActive = r.lastActive;
      nearWarned = r.nearWarned;
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
        WHERE id > ? AND (kind = 'breaker' OR (kind = 'status' AND to_status IN ('review','failed','blocked')))
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
    } else if (e.to_status === 'review') {
      await notify(db, { title: 'Loop: task ready for review', message: e.task_id, tags: ['white_check_mark'] });
    } else if (e.to_status === 'failed') {
      await notify(db, { title: 'Loop: task failed', message: `${e.task_id} — ${e.detail ?? ''}`, priority: 'high', tags: ['x'] });
    }
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
