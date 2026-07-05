import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getNum, getBool, logEvent } from '../db/index.js';
import type { Task } from '../types.js';
import {
  createRun,
  finishRun,
  getRun,
  setStatus,
  updateRun,
  latestRun,
  bumpResume,
} from '../tasks.js';
import { readUsage } from '../token/usage.js';
import { estimatePct } from '../token/accounting.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { addWorktree, isDirty, commitAll, diffstat, excludeLocal, worktreeInternalFile } from '../git/worktree.js';
import { timeoutMinFor } from '../scheduler/timeout.js';
import { writeTaskFile, writeResumeContext, collectResumeContext } from './prompt.js';
import { writeSettingsLocal } from './settingsLocal.js';
import { runVerification, type VerifyResult } from './verify.js';
import { runGapReview } from '../review/gapReviewer.js';
import { createPr } from '../git/pr.js';
import { syncWithBase, pushBranch, stripLoopArtifacts, integrateIntoBase } from '../git/integrate.js';
import { createMergeTask } from './mergeTask.js';
import { cleanupWorktree } from './cleanup.js';
import { killRun } from './kill.js';
import { mockAdapter } from './adapters/mock.js';
import { claudeCodeAdapter } from './adapters/claudeCode.js';
import type { Adapter, DispatchResult } from './adapters/types.js';

function pickAdapter(tool: string): Adapter {
  if (tool === 'mock') return mockAdapter;
  if (tool === 'claude-code') return claudeCodeAdapter;
  throw new Error(`unknown coding_tool: ${tool}`);
}

/**
 * Commit a WIP checkpoint for a run that was interrupted (breaker/timeout/user), so
 * nothing uncommitted is lost and a resume has a base to build on. No-op on a clean
 * worktree. Best-effort: a commit failure is logged, never thrown. Returns true iff
 * a checkpoint commit was actually made.
 */
export function commitCheckpoint(
  db: Database.Database,
  task: Task,
  runId: string | null,
  worktreePath: string,
  reason: string,
): boolean {
  try {
    if (!isDirty(worktreePath)) return false;
    commitAll(worktreePath, `loop(${task.id}): checkpoint (interrupted: ${reason})`);
    return true;
  } catch (err) {
    logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `checkpoint commit failed: ${String(err)}` });
    return false;
  }
}

/**
 * Full lifecycle for one dispatch: prepare workspace -> spawn adapter -> await ->
 * (breaker/timeout aware) -> auto-commit -> verify -> review|failed|blocked.
 * Resolves when the task reaches a terminal-for-now status. Never throws.
 */
export async function runTask(
  db: Database.Database,
  task: Task,
  opts: { resume?: boolean } = {},
): Promise<void> {
  const isMock = task.coding_tool === 'mock';
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  // Bill the run against a fresh reading at both boundaries. A cached reading (TTL
  // 180s) can make a short run look like ~0% delta and bias the estimator toward
  // zero. Mock runs stay on the cache (zero-token / deterministic tests).
  const beforeReading = readUsage({ force: !isMock });
  const before = beforeReading.session.percent;
  const weeklyBefore = beforeReading.weekly.percent;
  // Window this run is dispatched under, so the tick can checkpoint it if the
  // day/night window flips beneath a long run (Phase 3 #1).
  const dispatchWindow = resolvePolicy(db).window;

  let worktreePath: string;
  let branch: string | null = null;
  let resumeSessionId: string | null = null;
  let resumeOf: string | null = null;

  try {
    if (opts.resume) {
      const prev = latestRun(db, task.id);
      resumeSessionId = prev?.session_id ?? null;
      resumeOf = prev?.id ?? null;
    }

    if (isMock) {
      worktreePath = fs.mkdtempSync(path.join(paths.worktreesDir, `mock-${task.id}-`));
    } else {
      branch = `loop/${task.id}`;
      const wt = addWorktree(task.repo_path!, branch, task.base_branch!, {
        fetchBase: getBool(db, 'git_fetch_base', true),
      });
      worktreePath = wt.path;
    }
  } catch (err) {
    setStatus(db, task.id, 'failed', { detail: `workspace error: ${String(err)}` });
    return;
  }

  const logPath = path.join(paths.logsDir, `${task.id}-${Date.now()}.jsonl`);
  const run = createRun(db, {
    task_id: task.id,
    resume_of: resumeOf,
    attempt: (task.resume_count ?? 0) + 1,
    worktree_path: worktreePath,
    branch,
    log_path: logPath,
    session_pct_before: before,
    weekly_pct_before: weeklyBefore,
    dispatch_window: dispatchWindow,
  });

  const taskFilePath = writeTaskFile(worktreePath, task);
  if (!isMock) {
    // Keep engine-written artifacts out of the task branch/PR: exclude them locally
    // before any commitAll (checkpoint or auto-commit) can `git add -A` them.
    excludeLocal(worktreePath, ['/LOOP_TASK.md', '/.claude/settings.local.json']);
  }
  if (!isMock && task.setup_cmd) {
    // Resume reuses the worktree, so setup (npm install, ...) only needs to run once.
    // A sentinel in the worktree's private git dir records the setup_cmd it ran for;
    // skip while unchanged, re-run when the command itself changes.
    const sentinel = worktreeInternalFile(worktreePath, 'loop-setup-done');
    let alreadyDone = false;
    try {
      alreadyDone = fs.readFileSync(sentinel, 'utf8') === task.setup_cmd;
    } catch {
      /* no sentinel yet */
    }
    if (alreadyDone) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: 'setup skipped (unchanged, already installed)' });
    } else {
      // best-effort setup; failures surface at verification
      try {
        await runSetup(task.setup_cmd, worktreePath, logPath);
        try {
          fs.writeFileSync(sentinel, task.setup_cmd);
        } catch {
          /* sentinel is an optimization; ignore write failure */
        }
      } catch {
        /* ignore; verification will catch real breakage */
      }
    }
  }
  if (!isMock) writeSettingsLocal(worktreePath, hardLimit);

  const est = estimatePct(db, task.complexity);
  db.prepare('UPDATE tasks SET est_session_pct = ? WHERE id = ?').run(est, task.id);
  setStatus(db, task.id, 'running', { run_id: run.id, session_pct: before });
  logEvent(db, {
    task_id: task.id,
    run_id: run.id,
    kind: 'dispatch',
    detail: `tool=${task.coding_tool} est=${est}%${opts.resume ? ' resume' : ''}`,
  });

  const adapter = pickAdapter(task.coding_tool);
  const timeoutMs = process.env.LOOP_TEST_TIMEOUT_MS
    ? Number(process.env.LOOP_TEST_TIMEOUT_MS)
    : timeoutMinFor(db, task) * 60_000;

  // On resume, restore the prior work state (verify-failure context + HANDOFF.md) so the
  // resume prompt can point the agent at where it left off instead of restarting.
  const handoff = opts.resume ? collectResumeContext(worktreePath) : null;

  // One dispatch attempt: spawn, arm the per-run watchdog, await, disarm. Extracted so
  // a failed --resume can be retried once as a cold start (see below).
  const dispatchOnce = async (resumeSid: string | null): Promise<DispatchResult> => {
    // Persist session_id the moment it streams in, so resume survives an early kill
    // (breaker/timeout) even if the final result event never flushes on exit.
    let sidSaved = false;
    const handle = adapter.dispatch({
      task,
      run,
      cwd: worktreePath,
      taskFilePath,
      logPath,
      model: task.model,
      timeoutMs,
      resumeSessionId: resumeSid,
      resume: !!opts.resume,
      handoff,
      onEvent: (evt) => {
        if (!sidSaved && evt?.session_id) {
          sidSaved = true;
          updateRun(db, run.id, { session_id: evt.session_id });
        }
      },
    });
    updateRun(db, run.id, { pid: handle.pid });

    // Primary per-run watchdog: kill + mark timeout if it overruns.
    const timeoutTimer = setTimeout(() => {
      const cur = getRun(db, run.id);
      if (cur && !cur.finished_at) {
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'timeout', detail: `>${timeoutMinFor(db, task)}m` });
        killRun(db, { id: run.id, pid: handle.pid }, 'timeout');
      }
    }, timeoutMs);

    const r = await handle.wait;
    clearTimeout(timeoutTimer);
    return r;
  };

  let result = await dispatchOnce(resumeSessionId);

  // Cold-start fallback: if a --resume attempt failed to even start (stale/expired
  // session id) — and it was not a breaker/timeout/user interrupt — re-dispatch ONCE
  // without --resume. The worktree + HANDOFF.md still hold the state, so this recovers
  // rather than losing progress. Bounded to a single retry.
  if (
    opts.resume &&
    resumeSessionId &&
    !getRun(db, run.id)?.interrupted_by &&
    isStartupFailure(result)
  ) {
    logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: 'resume failed; cold-start fallback (no --resume)' });
    result = await dispatchOnce(null);
  }

  // Force a live read at the closing boundary so the recorded delta reflects real
  // spend (see the `before` note); the calibrator depends on this being accurate.
  const afterReading = readUsage({ force: !isMock });
  const after = afterReading.session.percent;
  finishRun(db, run.id, {
    exit_code: result.exitCode,
    // keep the mid-stream session_id if the final event didn't carry one
    ...(result.sessionId ? { session_id: result.sessionId } : {}),
    usage_json: result.usageJson,
    session_pct_after: after,
    weekly_pct_after: afterReading.weekly.percent,
    error: result.error ?? null,
  });

  // How did it end? (breaker/timeout/user set interrupted_by before/while killing)
  const finished = getRun(db, run.id)!;

  // Interrupted mid-flight: commit a WIP checkpoint BEFORE the early-return branches
  // below, so uncommitted work isn't lost and a resume has something to build on.
  // (The old auto-commit insurance sits after these returns and never ran for them.)
  if (!isMock && finished.interrupted_by) {
    commitCheckpoint(db, task, run.id, worktreePath, finished.interrupted_by);
  }

  if (finished.interrupted_by === 'timeout') {
    setStatus(db, task.id, 'failed', { run_id: run.id, detail: 'watchdog timeout' });
    return;
  }
  if (
    finished.interrupted_by === 'breaker' ||
    finished.interrupted_by === 'user' ||
    finished.interrupted_by === 'window'
  ) {
    // WIP was already checkpoint-committed above (commitCheckpoint), for all interrupt
    // types including 'window' — no need to commit again here.
    const resumes = bumpResume(db, task.id);
    const maxResumes = getNum(db, 'max_resumes', 2);
    // Once the resume budget is spent the scheduler would never re-dispatch it
    // (tick only resumes resume_count <= max_resumes), so escalate to failed
    // instead of leaving a zombie 'blocked' task. Mirrors recovery.ts.
    if (resumes > maxResumes) {
      setStatus(db, task.id, 'failed', {
        run_id: run.id,
        detail: `resume limit (${maxResumes}) exceeded; interrupted: ${finished.interrupted_by}`,
      });
    } else {
      setStatus(db, task.id, 'blocked', { run_id: run.id, detail: `interrupted: ${finished.interrupted_by}` });
    }
    return;
  }
  if (result.error || (result.exitCode !== 0 && result.resultSubtype !== 'success')) {
    setStatus(db, task.id, 'failed', {
      run_id: run.id,
      detail: `exit=${result.exitCode} subtype=${result.resultSubtype} ${result.error ?? ''}`.trim(),
    });
    return;
  }

  // auto-commit insurance (real repos only)
  if (!isMock) {
    try {
      if (isDirty(worktreePath)) commitAll(worktreePath, `loop(${task.id}): auto-commit`);
    } catch (err) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `auto-commit failed: ${String(err)}` });
    }
  }

  // verify
  setStatus(db, task.id, 'verifying', { run_id: run.id });
  const vres = await runVerification(task, worktreePath);
  if (!vres.ok) {
    handleVerifyFailure(db, task, run.id, worktreePath, vres);
    return;
  }

  // post-verify git close-out: push branch (backup) -> merge latest base into branch
  // -> (re-verify on merge) -> diffstat/gap-review/PR -> integrate into base. All
  // host-only and best-effort; with every git_* setting off this reduces to the old
  // diffstat -> gap-review -> PR flow.
  let reviewDetail = 'verification passed';
  if (!isMock && branch && task.base_branch && task.repo_path) {
    const base = task.base_branch;
    const autoPush = getBool(db, 'auto_push_branch', true);
    const autoMerge = getBool(db, 'auto_merge', true);

    // 1. early backup push of the loop branch
    if (autoPush) pushBranch(worktreePath, branch);

    // 2. bring the latest base into the branch — ONLY when we intend to integrate.
    //    With auto_merge off the branch is left exactly as the agent committed it,
    //    so all-flags-off truly restores the old diffstat -> gap-review -> PR flow.
    if (autoMerge) {
      const sync = syncWithBase(worktreePath, base, getBool(db, 'git_fetch_base', true));
      if (sync.status === 'merged') {
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'merge', detail: `merged ${sync.baseRef} into ${branch}` });
        // the branch changed — re-verify with identical failure semantics
        setStatus(db, task.id, 'verifying', { run_id: run.id });
        const reVres = await runVerification(task, worktreePath);
        if (!reVres.ok) {
          handleVerifyFailure(db, task, run.id, worktreePath, reVres);
          return;
        }
        if (autoPush) pushBranch(worktreePath, branch);
      } else if (sync.status === 'refused') {
        // Not a content conflict (e.g. dirty tracked files from a verify step) — skip
        // sync and continue; integrate below still FFs or degrades to 'pending'.
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'merge', detail: `sync skipped: merge refused (dirty worktree?) vs ${sync.baseRef}` });
      } else if (sync.status === 'conflict') {
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'merge', detail: `conflict: ${sync.conflictFiles.join(', ') || '(unknown files)'}` });
        // Recursion guard: a task that IS a merge-resolution task (parent_task_id set)
        // never spawns another merge task.
        if (getBool(db, 'merge_conflict_task', true) && !task.parent_task_id) {
          const mt = createMergeTask(db, task, sync.conflictFiles, sync.baseRef);
          db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run('conflict', task.id);
          // still attempt a backup PR for the branch, but skip integrate
          tryCreatePr(db, task, run.id, worktreePath, branch);
          setStatus(db, task.id, 'review', {
            run_id: run.id,
            detail: `verification passed; merge conflict vs ${sync.baseRef}; resolution task ${mt.id} queued`,
          });
        } else {
          db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run('conflict', task.id);
          tryCreatePr(db, task, run.id, worktreePath, branch);
          setStatus(db, task.id, 'review', {
            run_id: run.id,
            detail: `verification passed; merge conflict vs ${sync.baseRef} — awaiting manual merge`,
          });
        }
        return;
      }
      // sync.status === 'up-to-date' falls through
    }

    // 3. diffstat + gap-review (unchanged)
    const stat = diffstat(worktreePath, base);
    if (stat) logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `diffstat:\n${stat}` });

    try {
      const reviewPath = runGapReview(task, worktreePath);
      if (reviewPath) db.prepare('UPDATE tasks SET review_md_path = ? WHERE id = ?').run(reviewPath, task.id);
    } catch (err) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `gap-review skipped: ${String(err)}` });
    }

    // 4. PR (its internal push is now a cheap re-push)
    const prUrl = tryCreatePr(db, task, run.id, worktreePath, branch);

    // 5. integrate into base
    let mergeStatus: string | null = null;
    if (autoMerge) {
      stripLoopArtifacts(worktreePath);
      if (autoPush) pushBranch(worktreePath, branch);
      const r = integrateIntoBase(task.repo_path, worktreePath, branch, base);
      mergeStatus = r.outcome;
      db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run(r.outcome, task.id);
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'merge', detail: r.detail });
      reviewDetail = r.outcome === 'merged'
        ? `verification passed; merged into ${base}`
        : `verification passed; awaiting merge into ${base} (${r.detail})`;
    }

    // 6. reclaim the worktree once work is externalized (merged OR a PR link exists);
    //    keep it for pending/conflict-without-PR so the local diff stays reachable.
    if (mergeStatus === 'merged' || prUrl) cleanupWorktree(db, task);
  }
  setStatus(db, task.id, 'review', { run_id: run.id, detail: reviewDetail });
}

/**
 * Shared verify-failure handling for both first-verify and post-merge re-verify, so both
 * paths get IDENTICAL semantics: recoverable (blocked -> auto-resume) while we still have
 * the session and resume budget, else terminally failed.
 */
function handleVerifyFailure(
  db: Database.Database,
  task: Task,
  runId: string,
  worktreePath: string,
  vres: VerifyResult,
): void {
  const tail = vres.results.at(-1)?.output.slice(-1500) ?? '';
  const failedStep = vres.failedStep ?? '(unknown step)';
  const maxResumes = getNum(db, 'max_resumes', 2);
  const finishedRun = getRun(db, runId)!;
  if (finishedRun.session_id && task.resume_count < maxResumes) {
    writeResumeContext(worktreePath, failedStep, tail);
    bumpResume(db, task.id);
    setStatus(db, task.id, 'blocked', {
      run_id: runId,
      detail: `verify failed (resumable ${task.resume_count + 1}/${maxResumes}) at: ${failedStep}`,
    });
    return;
  }
  setStatus(db, task.id, 'failed', { run_id: runId, detail: `verify failed at: ${failedStep}\n${tail}` });
}

/** Best-effort PR creation; records pr_url + a note on success. Returns the URL or null. */
function tryCreatePr(
  db: Database.Database,
  task: Task,
  runId: string,
  worktreePath: string,
  branch: string,
): string | null {
  try {
    const prUrl = createPr(worktreePath, branch, task.title);
    if (prUrl) {
      db.prepare('UPDATE tasks SET pr_url = ? WHERE id = ?').run(prUrl, task.id);
      logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `PR: ${prUrl}` });
    }
    return prUrl;
  } catch (err) {
    logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `PR skipped: ${String(err)}` });
    return null;
  }
}

/** A dispatch that failed to produce a successful result (no clean exit / errored). */
function isStartupFailure(result: DispatchResult): boolean {
  return !!result.error || (result.exitCode !== 0 && result.resultSubtype !== 'success');
}

function runSetup(cmd: string, cwd: string, logPath: string): Promise<void> {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('bash', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const fd = fs.openSync(logPath, 'a');
      const w = (d: Buffer) => fs.writeSync(fd, d);
      child.stdout.on('data', w);
      child.stderr.on('data', w);
      const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}
