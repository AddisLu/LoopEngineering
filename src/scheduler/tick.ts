import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import { countByStatus, listTasks, latestRun } from '../tasks.js';
import { readUsage } from '../token/usage.js';
import { estimatePct } from '../token/accounting.js';
import type { Task, UsageReading } from '../types.js';
import { resolvePolicy, type Policy } from './policy.js';
import { checkBreaker } from './breaker.js';
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

  // 7. candidates: resume blocked first, then queued (ordered)
  let headroom = policy.sessionMax - reading.session.percent;
  const candidates = buildCandidates(db, policy);

  for (const c of candidates) {
    if (cap <= 0) break;
    const est = estimatePct(db, c.task.complexity);
    if (est > headroom) continue; // won't fit; try a cheaper one
    deps.startRun(c.task, { resume: c.resume });
    dispatched.push({ taskId: c.task.id, resume: c.resume });
    headroom -= est;
    cap -= 1;
  }

  return info(false, dispatched.length ? 'dispatched' : 'no fitting candidate');
}

interface Candidate {
  task: Task;
  resume: boolean;
}

function buildCandidates(db: Database.Database, policy: Policy): Candidate[] {
  // resume-priority: blocked tasks with a session_id and resume budget left.
  // resume_count <= max_resumes aligns with run.ts / recovery.ts, which fail a task
  // once its count exceeds max_resumes — so no blocked task is left un-resumable.
  const maxResumes = getNum(db, 'max_resumes', 2);
  const resumes: Candidate[] = listTasks(db, 'blocked')
    .filter((t) => t.resume_count <= maxResumes && latestRun(db, t.id)?.session_id)
    .map((t) => ({ task: t, resume: true }));

  const queued = listTasks(db, 'queued');
  // priority DESC (listTasks already), then window-aware complexity preference
  queued.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ra = COMPLEXITY_RANK[a.complexity];
    const rb = COMPLEXITY_RANK[b.complexity];
    // night: prefer larger (soak the reset); day: prefer smaller (stay responsive)
    return policy.window === 'night' ? rb - ra : ra - rb;
  });

  return resumes.concat(queued.map((t) => ({ task: t, resume: false })));
}
