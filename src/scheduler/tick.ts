import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import { countByStatus, listTasks, latestRun, activeRunCosts } from '../tasks.js';
import { readUsage } from '../token/usage.js';
import { estimatePct, estimateWeeklyPct } from '../token/accounting.js';
import type { Task, UsageReading } from '../types.js';
import { resolvePolicy, type Policy } from './policy.js';
import { checkBreaker, checkWindowSwitch } from './breaker.js';
import { checkWatchdog } from './watchdog.js';
import { updatePower } from './power.js';
import type { Complexity } from '../config.js';

export interface TickDeps {
  inflightCount(): number;
  startRun(task: Task, opts: { resume?: boolean }): void;
  now?: Date;
}

export interface TickInfo {
  reading: UsageReading;
  policy: Policy;
  paused: boolean;
  breakerTripped: boolean;
  dispatched: { taskId: string; resume: boolean }[];
  reason: string;
}

const COMPLEXITY_RANK: Record<Complexity, number> = { S: 1, M: 2, L: 3 };

export function tick(db: Database.Database, deps: TickDeps): TickInfo {
  const now = deps.now ?? new Date();
  const reading = readUsage();
  const policy = resolvePolicy(db, now);
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  const dispatched: TickInfo['dispatched'] = [];

  // 1. snapshot (always, paused or not)
  db.prepare(
    `INSERT INTO token_snapshots (session_pct, weekly_pct, session_resets_at, weekly_resets_at, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    reading.session.percent,
    reading.weekly.percent,
    reading.session.resetsAt,
    reading.weekly.resetsAt,
    reading.source,
  );

  // 2. safety runs regardless of pause (a live run can still blow the budget)
  const breakerTripped = checkBreaker(db, reading, hardLimit);
  checkWatchdog(db, now);
  // #1 day/night window checkpoint: re-budget runs whose dispatch window has flipped.
  if (getBool(db, 'window_checkpoint')) checkWindowSwitch(db, policy.window);

  // 3. power: keep awake while there is work
  const counts = countByStatus(db);
  const active = (counts.running ?? 0) + (counts.verifying ?? 0) + (counts.queued ?? 0) + deps.inflightCount();
  updatePower(active > 0);

  const info = (paused: boolean, reason: string): TickInfo => ({
    reading,
    policy,
    paused,
    breakerTripped,
    dispatched,
    reason,
  });

  // 4. pause only blocks NEW dispatch
  if (getBool(db, 'scheduler_paused')) return info(true, 'paused');
  if (breakerTripped) return info(false, 'breaker tripped');

  // 5. capacity
  let cap = getNum(db, 'max_concurrency', 1) - deps.inflightCount();
  if (cap <= 0) return info(false, 'at concurrency');

  // 6. task-independent safe-to-run gates
  if (reading.session.percent >= policy.sessionMax) return info(false, `session ${reading.session.percent}% >= ${policy.sessionMax}%`);
  if (reading.weekly.percent >= policy.weeklyMax) return info(false, `weekly ${reading.weekly.percent}% >= ${policy.weeklyMax}%`);

  const minRunway = getNum(db, 'min_runway_min', 20);
  const runway = reading.session.resetsInMinutes;
  if (runway != null && runway < minRunway && reading.session.percent >= policy.sessionMax - 10) {
    return info(false, `near reset (${runway}m) and high — waiting`);
  }

  // 7. packing budget. Fit against BOTH session and weekly headroom (#2), and reserve
  //    each in-flight run's unspent estimated cost so concurrency can't over-commit (#3).
  const weeklyPacking = getBool(db, 'weekly_packing', true);
  let headroom = policy.sessionMax - reading.session.percent;
  let weeklyHeadroom = policy.weeklyMax - reading.weekly.percent;

  if (getBool(db, 'concurrency_reserve', true)) {
    for (const rc of activeRunCosts(db)) {
      const spentS = rc.session_pct_before != null ? reading.session.percent - rc.session_pct_before : 0;
      headroom -= Math.max(0, estimatePct(db, rc.complexity) - Math.max(0, spentS));
      if (weeklyPacking) {
        const spentW = rc.weekly_pct_before != null ? reading.weekly.percent - rc.weekly_pct_before : 0;
        weeklyHeadroom -= Math.max(0, estimateWeeklyPct(db, rc.complexity) - Math.max(0, spentW));
      }
    }
  }

  // 8. candidates: resume blocked first, then queued (aging-aware order #4)
  const aging = getBool(db, 'priority_aging', false);
  const starveMin = getNum(db, 'starve_min', 60);
  const candidates = buildCandidates(db, policy, now, aging ? getNum(db, 'age_step_min', 30) : 0);

  let starveReserved = false;
  for (const c of candidates) {
    if (cap <= 0) break;
    const est = estimatePct(db, c.task.complexity);
    const estW = weeklyPacking ? estimateWeeklyPct(db, c.task.complexity) : 0;
    if (est > headroom || estW > weeklyHeadroom) {
      // #4 anti-starvation reserve: if the highest-priority QUEUED task has aged past the
      // threshold but doesn't fit yet, stop here — don't let cheaper, lower-priority work
      // (later in this priority-sorted list) keep stealing the headroom it needs.
      if (aging && !c.resume && c.waitedMin >= starveMin) {
        starveReserved = true;
        break;
      }
      continue; // won't fit; try a cheaper one
    }
    deps.startRun(c.task, { resume: c.resume });
    dispatched.push({ taskId: c.task.id, resume: c.resume });
    headroom -= est;
    weeklyHeadroom -= estW;
    cap -= 1;
  }

  return info(
    false,
    dispatched.length ? 'dispatched' : starveReserved ? 'reserving headroom for aged task' : 'no fitting candidate',
  );
}

interface Candidate {
  task: Task;
  resume: boolean;
  waitedMin: number;
}

/** Minutes a task has waited in its current status (updated_at is UTC "YYYY-MM-DD HH:MM:SS"). */
function minutesSince(ts: string, now: Date): number {
  const t = new Date(ts.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 60_000);
}

/**
 * @param ageStepMin  minutes of queue-wait per +1 effective priority; 0 disables aging (#4).
 */
function buildCandidates(db: Database.Database, policy: Policy, now: Date, ageStepMin: number): Candidate[] {
  // resume-priority: blocked tasks with a session_id and resume budget left
  const resumes: Candidate[] = listTasks(db, 'blocked')
    .filter((t) => t.resume_count < 2 && latestRun(db, t.id)?.session_id)
    .map((t) => ({ task: t, resume: true, waitedMin: 0 }));

  const queued = listTasks(db, 'queued');
  const waited = new Map<string, number>(queued.map((t) => [t.id, minutesSince(t.updated_at, now)]));
  const effPriority = (t: Task): number =>
    ageStepMin > 0 ? t.priority + Math.floor((waited.get(t.id) ?? 0) / ageStepMin) : t.priority;

  // effective priority DESC, then window-aware complexity preference
  queued.sort((a, b) => {
    const pa = effPriority(a);
    const pb = effPriority(b);
    if (pb !== pa) return pb - pa;
    const ra = COMPLEXITY_RANK[a.complexity];
    const rb = COMPLEXITY_RANK[b.complexity];
    // night: prefer larger (soak the reset); day: prefer smaller (stay responsive)
    return policy.window === 'night' ? rb - ra : ra - rb;
  });

  return resumes.concat(queued.map((t) => ({ task: t, resume: false, waitedMin: waited.get(t.id) ?? 0 })));
}
