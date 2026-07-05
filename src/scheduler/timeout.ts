import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import type { Complexity } from '../config.js';

/**
 * Effective per-run timeout in minutes: an explicit task override wins, otherwise the
 * per-complexity `timeout_<S|M|L>` setting (falling back to the seeded defaults).
 * Single source of truth shared by the orchestrator watchdog, the backstop watchdog,
 * and the board's elapsed-progress indicator.
 */
export function timeoutMinFor(
  db: Database.Database,
  task: { timeout_min: number | null; complexity: Complexity },
): number {
  if (task.timeout_min != null) return task.timeout_min;
  return getNum(db, `timeout_${task.complexity}`, task.complexity === 'S' ? 15 : task.complexity === 'L' ? 120 : 45);
}
