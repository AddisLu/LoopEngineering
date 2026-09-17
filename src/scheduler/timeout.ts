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
  // 本地模型: the run's resolved model. A 'local:<id>' run decodes far slower than the cloud
  // (~28 t/s on one Spark), so the per-complexity default is scaled by local_timeout_multiplier.
  // An explicit task.timeout_min is always taken as-is.
  model?: string | null,
): number {
  if (task.timeout_min != null) return task.timeout_min;
  const base = getNum(db, `timeout_${task.complexity}`, task.complexity === 'S' ? 15 : task.complexity === 'L' ? 120 : 45);
  if (model && model.startsWith('local:')) return base * Math.max(1, getNum(db, 'local_timeout_multiplier', 2));
  return base;
}
