import type Database from 'better-sqlite3';
import { getNum, getSetting } from '../db/index.js';

export interface Policy {
  window: 'day' | 'night';
  sessionMax: number;
  weeklyMax: number;
}

/** Minutes since local midnight for an "HH:MM" string. */
function hhmm(s: string): number {
  const [h, m] = s.split(':').map((x) => Number(x));
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Resolve day vs night thresholds. Day window is inclusive of start, exclusive of
 * end; anything outside is night. Night deliberately runs hotter — session quota
 * resets every 5h and evaporates unused, so late-night is "free" capacity.
 */
export function resolvePolicy(db: Database.Database, now: Date = new Date()): Policy {
  const win = getSetting(db, 'day_window') ?? '08:00-23:00';
  const [start, end] = win.split('-');
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = hhmm(start ?? '08:00');
  const e = hhmm(end ?? '23:00');
  const isDay = s <= e ? cur >= s && cur < e : cur >= s || cur < e;

  if (isDay) {
    return {
      window: 'day',
      sessionMax: getNum(db, 'day_session_max', 65),
      weeklyMax: getNum(db, 'day_weekly_max', 80),
    };
  }
  return {
    window: 'night',
    sessionMax: getNum(db, 'night_session_max', 92),
    weeklyMax: getNum(db, 'night_weekly_max', 88),
  };
}
