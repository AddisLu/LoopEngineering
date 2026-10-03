import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting, setSetting, logEvent } from '../db/index.js';
import {
  countByStatus,
  listTasks,
  latestRun,
  activeRunCosts,
  activeLocalRunCount,
  dependencyState,
  setStatus,
} from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { readUsage, claudeLoginExpired } from '../token/usage.js';
import { estimatePct, estimateWeeklyPct } from '../token/accounting.js';
import { resolveModel } from '../orchestrator/run.js';
import { isLocalModel, localId } from '../local/models.js';
import type { ModelManager } from '../local/modelManager.js';
import type { Task, UsageReading } from '../types.js';
import { inTimeWindow, resolvePolicy, type Policy } from './policy.js';
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
  // 本地模型: loads/switches the vLLM model (src/local/modelManager.ts; tests inject a stub).
  // Only consulted when local_models_enabled is on.
  modelManager?: Pick<ModelManager, 'state' | 'ensureLoaded' | 'unavailable' | 'refresh'>;
  // 對話操作 (src/chatops/execute.ts): a confirmed chat action still running — a self-update
  // restart would cut it off, so the rebuild waits like it does for task runs.
  opsBusy?(): boolean;
  // the host's Claude login has expired (src/token/usage.ts); tests inject
  authExpired?(): boolean;
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

  // 3b. a crashed vLLM must stop saying 就緒: check what it really serves, paused or not and with no
  // local work queued — dispatchLocal's own check only ran when local tasks were waiting (throttled
  // inside refresh(); with local models off this never probes, as before).
  if (getBool(db, 'local_models_enabled', false)) deps.modelManager?.refresh();

  // 本地模型 status fragment appended to the scheduler reason (null when there is no local work,
  // so with local models off every reason string is exactly what it was before).
  let localReason: string | null = null;
  const info = (paused: boolean, reason: string): TickInfo => ({
    reading,
    policy,
    paused,
    breakerTripped,
    dispatched,
    reason: localReason ? `${reason}; ${localReason}` : reason,
  });

  // 4. pause only blocks NEW dispatch
  if (getBool(db, 'scheduler_paused')) return info(true, 'paused');
  // Local runs cost no Anthropic quota, so with local models on a tripped breaker must not hold
  // them: its return moves below the local dispatch step (4c). Off = the original order.
  const localEnabled = getBool(db, 'local_models_enabled', false);
  if (breakerTripped && !localEnabled) return info(false, 'breaker tripped');

  // 4a. self-update: a task targeting the engine's OWN repo merged into main — rebuild
  // + restart once idle, so later chain tasks run the new code. An in-flight run keeps
  // the marker armed (checked again next tick); idle clears it, hands off to
  // selfUpdate(), and skips dispatch entirely this tick (a rebuild racing a live run
  // would restart out from under it).
  if (getBool(db, 'self_update_pending') && deps.inflightCount() === 0 && !deps.opsBusy?.()) {
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

  const aging = getBool(db, 'priority_aging', false);
  const ageStepMin = aging ? getNum(db, 'age_step_min', 30) : 0;

  // 4c. 本地模型 dispatch: candidates whose resolved model is 'local:<id>' run on the vLLM box —
  // no session/weekly/fit gates (zero Anthropic spend), but one GPU: only the LOADED model's
  // tasks dispatch (local_max_concurrency), and a switch waits until no local run is in flight.
  if (localEnabled) {
    localReason = dispatchLocal(db, deps, buildCandidates(db, policy, now, ageStepMin), dispatched, now);
  }
  if (breakerTripped) return info(false, 'breaker tripped');

  // 5. capacity (cloud). Local runs have their own cap (4c) and don't consume cloud slots.
  const localInflight = localEnabled ? activeLocalRunCount(db) : 0;
  let cap = getNum(db, 'max_concurrency', 1) - Math.max(0, deps.inflightCount() - localInflight);
  if (cap <= 0) return info(false, 'at concurrency');

  // 5b. this host's Claude login has expired: a cloud run would fail at once (and usage cannot be
  // read), so cloud tasks wait in the queue — local-model tasks above are unaffected
  if ((deps.authExpired ?? claudeLoginExpired)()) return info(false, 'auth expired: Claude Code login on this host');

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
      // Phase 4: reserve against the in-flight run's OWN model estimate (rc.model), so a cheap
      // run doesn't over-reserve at the sonnet seed. Null (pre-migration rows) -> legacy estimate.
      const spentS = rc.session_pct_before != null ? reading.session.percent - rc.session_pct_before : 0;
      headroom -= Math.max(0, estimatePct(db, rc.complexity, rc.model) - Math.max(0, spentS));
      if (weeklyPacking) {
        const spentW = rc.weekly_pct_before != null ? reading.weekly.percent - rc.weekly_pct_before : 0;
        weeklyHeadroom -= Math.max(0, estimateWeeklyPct(db, rc.complexity, rc.model) - Math.max(0, spentW));
      }
    }
  }

  // 8. candidates: resume blocked first, then queued (aging-aware order #4)
  const starveMin = getNum(db, 'starve_min', 60);
  const candidates = buildCandidates(db, policy, now, ageStepMin);

  let starveReserved = false;
  let heldLocal = 0;
  for (const c of candidates) {
    if (cap <= 0) break;
    // Phase 4: fit against the model this task will actually dispatch under (routing-aware),
    // so a cheaper model's smaller footprint lets the gate pack more work into the same headroom.
    const cModel = resolveModel(db, c.task) ?? 'default';
    // 本地模型 tasks never take the cloud path (dispatched in 4c, or held while local models are off).
    if (isLocalModel(cModel)) {
      heldLocal += 1;
      continue;
    }
    const est = estimatePct(db, c.task.complexity, cModel);
    const estW = weeklyPacking ? estimateWeeklyPct(db, c.task.complexity, cModel) : 0;
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
  if (!localEnabled && heldLocal > 0) localReason = `${heldLocal} local task(s) held: local_models_enabled=false`;

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

/**
 * Tick step 4c (本地模型). Returns a short scheduler-reason fragment, or null when no candidate
 * uses a local model. Stay on the loaded model while it still has work (a switch costs ~6 min);
 * otherwise move to the highest-priority model that isn't in an error cool-down — but only once
 * every local run has finished, because a switch restarts vLLM under them.
 *
 * `local_task_window` ("19:00-07:00"; empty = any time) keeps local work to the night, when the
 * GPU box and the sandbox machines are free: outside it nothing new starts and no model is
 * loaded for queued work. A run already going when the window closes is left to finish.
 */
function dispatchLocal(
  db: Database.Database,
  deps: TickDeps,
  candidates: Candidate[],
  dispatched: TickInfo['dispatched'],
  now: Date,
): string | null {
  const local: (Candidate & { localModel: string })[] = [];
  for (const c of candidates) {
    const m = resolveModel(db, c.task);
    if (isLocalModel(m)) local.push({ ...c, localModel: localId(m) });
  }
  if (local.length === 0) return null;

  const win = getSetting(db, 'local_task_window') ?? '';
  if (win && !inTimeWindow(win, now)) return `${local.length} local task(s) wait for local_task_window ${win}`;

  const mm = deps.modelManager;
  if (!mm) return `${local.length} local task(s) held: no model manager`;
  mm.refresh();
  const st = mm.state();
  const inflight = activeLocalRunCount(db);

  const wanted =
    st.loaded && local.some((x) => x.localModel === st.loaded)
      ? st.loaded
      : (local.map((x) => x.localModel).find((m) => !mm.unavailable(m)) ?? null);
  if (!wanted) return `local: no loadable model (${st.error ?? 'cooling down'})`;

  if (st.status === 'ready' && st.loaded === wanted) {
    let cap = getNum(db, 'local_max_concurrency', 2) - inflight;
    let n = 0;
    for (const x of local) {
      if (cap <= 0) break;
      if (x.localModel !== wanted) continue;
      deps.startRun(x.task, { resume: x.resume });
      dispatched.push({ taskId: x.task.id, resume: x.resume });
      cap -= 1;
      n += 1;
    }
    return n > 0 ? `local: dispatched ${n} on ${wanted}` : `local: at concurrency on ${wanted}`;
  }
  if (inflight > 0) return `local: ${inflight} run(s) still in flight; switch to ${wanted} waits`;
  return mm.ensureLoaded(wanted) === 'busy'
    ? `local: ${wanted} unavailable (${st.error ?? st.status})`
    : `local: loading ${wanted}`;
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
