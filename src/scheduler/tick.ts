import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting, setSetting, logEvent } from '../db/index.js';
import { countByStatus, listTasks, latestRun, activeRunCosts, dependencyState, setStatus } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
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
  // Rebuild+restart the engine (real impl spawns a detached process; tests inject a
  // spy). Invoked by the tick when self_update_pending is set and the engine is idle.
  selfUpdate?(): void;
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

  // 4a. self-update: a task targeting the engine's OWN repo merged into main — rebuild
  // + restart once idle, so later chain tasks run the new code. An in-flight run keeps
  // the marker armed (checked again next tick); idle clears it, hands off to
  // selfUpdate(), and skips dispatch entirely this tick (a rebuild racing a live run
  // would restart out from under it).
  if (getBool(db, 'self_update_pending') && deps.inflightCount() === 0) {
    setSetting(db, 'self_update_pending', 'false');
    logEvent(db, { kind: 'note', detail: 'self-update: rebuilding + restarting engine' });
    try {
      deps.selfUpdate?.();
    } catch (err) {
      // spawn failed (or the injected spy threw) — re-arm so the next tick retries.
      setSetting(db, 'self_update_pending', 'true');
      logEvent(db, { kind: 'note', detail: `self-update failed: ${String(err)}` });
    }
    return info(false, 'self-updating');
  }

  // 4b. serial chains: a DRAFT created with `depends_on` is intent to run after its
  // dependency — auto-queue it the moment the dependency is closed (gate must pass).
  // Cheap and idempotent; runs before the capacity check so a chain link releases
  // even on ticks that can't dispatch anything.
  if (getBool(db, 'dep_auto_queue', true)) {
    for (const t of listTasks(db, 'draft')) {
      if (!t.depends_on) continue;
      if (dependencyState(db, t) !== 'satisfied') continue;
      if (!validateTask(t, getSetting(db, 'host_capabilities') ?? '').ok) continue; // stays draft; gate errors are visible on the board
      setStatus(db, t.id, 'queued', { detail: `auto-queued: dependency ${t.depends_on} closed` });
      logEvent(db, { task_id: t.id, kind: 'note', detail: 'released by dependency chain' });
    }
  }

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

  // 7. packing budget. Two separate concepts (do not conflate — safety depends on it):
  //    - `sessionMax` (step 6) is only the soft START gate: don't BEGIN work once high.
  //    - the per-run FIT BUDGET packs against the HARD limit minus `safety_reserve_pct`,
  //      so we can use the sessionMax->hard_limit band while keeping a margin an
  //      under-estimate can't shove past the breaker (Phase 2 reclaimed band).
  //    On top of that, fit against WEEKLY headroom too (#2) and reserve each in-flight
  //    run's unspent estimated cost so raising concurrency can't over-commit (#3).
  const weeklyPacking = getBool(db, 'weekly_packing', true);
  const safetyReserve = getNum(db, 'safety_reserve_pct', 5);
  let headroom = hardLimit - safetyReserve - reading.session.percent;
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
  // resume-priority: blocked tasks with a session_id and resume budget left.
  // resume_count <= max_resumes aligns with run.ts / recovery.ts, which fail a task
  // once its count exceeds max_resumes — so no blocked task is left un-resumable.
  const maxResumes = getNum(db, 'max_resumes', 2);
  const resumes: Candidate[] = listTasks(db, 'blocked')
    .filter((t) => t.resume_count <= maxResumes && latestRun(db, t.id)?.session_id)
    .map((t) => ({ task: t, resume: true, waitedMin: 0 }));

  // Dependency hold: a queued task whose chain link isn't satisfied never dispatches
  // (covers manual queueing of a dependent task — visible as a chip on its board card).
  const queued = listTasks(db, 'queued').filter((t) => {
    const dep = dependencyState(db, t);
    return dep === 'none' || dep === 'satisfied';
  });
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
