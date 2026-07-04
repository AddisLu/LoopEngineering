import type Database from 'better-sqlite3';
import { getDb, getNum } from './db/index.js';
import type { Task } from './types.js';
import { runTask } from './orchestrator/run.js';
import { recoverOnStartup } from './orchestrator/recovery.js';
import { tick, type TickInfo } from './scheduler/tick.js';
import { releasePower } from './scheduler/power.js';
import { paths } from './config.js';

export interface Engine {
  db: Database.Database;
  tickOnce(now?: Date): TickInfo;
  inflightCount(): number;
  stop(): void;
}

/**
 * Create the scheduling engine. `startRun` fires runTask and tracks the promise so
 * the tick loop knows real concurrency; a run that ends frees its slot.
 */
export function createEngine(db: Database.Database = getDb()): Engine {
  const inflight = new Map<string, Promise<void>>();

  // Let the budget-guard hook (spawned inside claude) find the shared cache + limit.
  process.env.LOOP_USAGE_CACHE = process.env.LOOP_USAGE_CACHE ?? `${paths.dataDir}/usage-cache.json`;
  process.env.LOOP_HARD_LIMIT_PCT = String(getNum(db, 'hard_limit_pct', 95));

  function startRun(task: Task, opts: { resume?: boolean }): void {
    if (inflight.has(task.id)) return;
    const p = runTask(db, task, opts)
      .catch((err) => {
        // runTask is supposed to never throw; guard anyway
        console.error(`[engine] runTask ${task.id} threw:`, err);
      })
      .finally(() => {
        inflight.delete(task.id);
      });
    inflight.set(task.id, p);
  }

  const deps = {
    inflightCount: () => inflight.size,
    startRun,
  };

  recoverOnStartup(db);

  return {
    db,
    tickOnce: (now?: Date) => tick(db, { ...deps, now }),
    inflightCount: () => inflight.size,
    stop: () => releasePower(),
  };
}

/** Long-running loop entry (used by systemd on the host). */
export async function main(): Promise<void> {
  const db = getDb();
  const engine = createEngine(db);
  const pollMs = getNum(db, 'poll_interval_sec', 60) * 1000;

  const shutdown = () => {
    engine.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[engine] started; poll=${pollMs / 1000}s data=${paths.dataDir}`);
  const loop = () => {
    try {
      const info = engine.tickOnce();
      if (info.dispatched.length || info.breakerTripped) {
        console.log(
          `[tick] ${info.reason}; session=${info.reading.session.percent}% weekly=${info.reading.weekly.percent}% (${info.policy.window})`,
        );
      }
    } catch (err) {
      console.error('[tick] error:', err);
    }
  };
  loop();
  setInterval(loop, pollMs);
}

// run when invoked directly (tsx src/engine.ts or node dist/engine.js)
const invoked = process.argv[1] && /engine\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
