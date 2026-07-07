import type Database from 'better-sqlite3';
import { getBool, getNum } from '../../db/index.js';
import { ingestAll, type IngestOptions } from './ingest.js';

// Module-level in-flight guard: src/server.ts fires pumpIngest every tick (default 60s)
// without awaiting the previous call, so a slow ingestAll (many/large sources) can still be
// running when the next tick's call comes in. Without this, the two overlapping ingestAll
// passes would race on the same documents/chunks rows. Scoped to the whole process (not
// per-db) since there's only ever one real ingest pump running.
let inFlight = false;

/**
 * Fire-and-forget periodic re-ingest pump — same idiom as integrations/pushback.ts's
 * pumpPushback (called every tick from src/server.ts's loop, cursor advances regardless
 * of whether it did anything), except the "cursor" here is a wall-clock timestamp rather
 * than a task_events id: there is no natural per-source event stream to watch, so this
 * just re-walks every enabled source on an interval and lets ingestSource's own sha256
 * incremental-skip logic do the real work (an unchanged file costs one stat + hash, no
 * re-chunk/re-embed). Gated by `ingest_auto_pump` (default false) — off means this never
 * calls ingestAll, matching the zero-impact-by-default posture of every other SSoT flag.
 * If the previous round's ingestAll is still running, this round is skipped entirely (the
 * cursor is left unadvanced, so the next tick retries once it's due again).
 */
export async function pumpIngest(
  db: Database.Database,
  lastRunAtMs: number,
  nowMs: number,
  opts: IngestOptions = {},
): Promise<number> {
  if (!getBool(db, 'ingest_auto_pump', false)) return lastRunAtMs;
  const intervalMs = getNum(db, 'ingest_pump_interval_min', 30) * 60_000;
  if (nowMs - lastRunAtMs < intervalMs) return lastRunAtMs;
  if (inFlight) return lastRunAtMs;
  inFlight = true;
  try {
    await ingestAll(db, opts);
  } catch {
    // best-effort — a failed pass is retried on the next due interval, never blocks the tick
  } finally {
    inFlight = false;
  }
  return nowMs;
}
