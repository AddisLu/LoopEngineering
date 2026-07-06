import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths, isEngineRepo } from '../config.js';
import { getNum, getBool, getSetting, setSetting, logEvent } from '../db/index.js';
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
import { knowledgeContext } from '../knowledge/context.js';
import { writeSettingsLocal } from './settingsLocal.js';
import { runVerification, type VerifyResult } from './verify.js';
import { runLlmJudge, type JudgeExec } from './judge.js';
import { parseSteps, parseVerifyMode } from '../types.js';
import { unmetCapabilities } from '../capabilities.js';
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
  // 'generic' is the real claude-code adapter dispatched into a persistent output dir
  // instead of a git worktree — see the workspace setup in runTask.
  if (tool === 'claude-code' || tool === 'generic') return claudeCodeAdapter;
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
 * (breaker/timeout aware) -> auto-commit -> verify -> review|blocked|attention|failed.
 * Resolves when the task reaches a terminal-for-now status. Never throws.
 */
export async function runTask(
  db: Database.Database,
  task: Task,
  // `adapter` is a test-only injection point (mirrors runVerifyPipeline's judgeExec):
  // production call sites never set it and get pickAdapter(task.coding_tool). Lets a
  // hermetic test drive the full coding_tool='generic' orchestration path (persistent
  // output dir, no worktree, no git close-out) with the zero-token mock adapter instead
  // of spawning a real `claude` process.
  opts: { resume?: boolean; adapter?: Adapter } = {},
): Promise<void> {
  const isMock = task.coding_tool === 'mock';
  const isGeneric = task.coding_tool === 'generic';
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
    } else if (isGeneric) {
      // Persistent, task-id-keyed dir — NOT a scratch dir: it survives resumes and is
      // never cleaned up on close (it IS the deliverable). branch stays null, so every
      // git-only step below (worktree, commit, push, merge, PR) is skipped for generic.
      worktreePath = path.join(paths.outputsDir, task.id);
      fs.mkdirSync(worktreePath, { recursive: true });
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

  const taskFilePath = writeTaskFile(worktreePath, task, { knowledge: knowledgeContext(db, task) });
  if (!isMock && !isGeneric) {
    // Keep engine-written artifacts out of the task branch/PR: exclude them locally
    // before any commitAll (checkpoint or auto-commit) can `git add -A` them. Generic's
    // output dir is never a git repo, so this git op is skipped entirely for it.
    excludeLocal(worktreePath, ['/LOOP_TASK.md', '/.claude/settings.local.json']);
  }
  if (task.setup_cmd) {
    // Resume reuses the worktree, so setup (npm install, ...) only needs to run once.
    // A sentinel in the worktree's private git dir records the setup_cmd it ran for;
    // skip while unchanged, re-run when the command itself changes. Mock scratch dirs
    // run setup too (harmlessly — no adapter token spend either way), which is what
    // makes the fail-fast path below testable with zero tokens.
    const outcome = await runTaskSetup(task, worktreePath, logPath);
    if (outcome.kind === 'skipped') {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: 'setup skipped (unchanged, already installed)' });
    } else if (outcome.kind === 'failed') {
      // Fail fast: don't spawn the adapter into a broken workspace and burn a whole
      // token budget only to have verify catch it later. Do NOT write the sentinel —
      // a /restart re-runs setup. finishRun BEFORE the adapter's dispatch logEvent,
      // so a triaged run carries no misleading 'dispatch' event.
      finishRun(db, run.id, { error: 'setup failed' });
      setStatus(db, task.id, 'attention', {
        run_id: run.id,
        detail: `setup_cmd failed (exit=${outcome.exitCode}): ${outcome.tail}`,
      });
      return;
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

  const adapter = opts.adapter ?? pickAdapter(task.coding_tool);
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
      // per-task model wins; else the board-wide default_model (keeps costly runs off
      // the interactive default). Empty/'default' -> no --model (CLI default).
      model: task.model || getSetting(db, 'default_model') || null,
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
    dispatchFailed(result)
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
  if (!isMock && !isGeneric && finished.interrupted_by) {
    commitCheckpoint(db, task, run.id, worktreePath, finished.interrupted_by);
  }

  if (finished.interrupted_by === 'timeout') {
    // checkpoint commit already happened above — worktree/session preserved for triage
    setStatus(db, task.id, 'attention', { run_id: run.id, detail: 'watchdog timeout' });
    return;
  }
  if (finished.interrupted_by === 'user') {
    // A user abort is TERMINAL: the abort endpoint/CLI already set 'failed' eagerly;
    // agree with it here instead of overwriting to blocked (which used to auto-resume
    // aborted tasks). pause --hard uses reason 'pause' and stays resumable below.
    setStatus(db, task.id, 'failed', { run_id: run.id, detail: 'aborted by user' });
    return;
  }
  if (
    finished.interrupted_by === 'breaker' ||
    finished.interrupted_by === 'window' ||
    finished.interrupted_by === 'pause'
  ) {
    // WIP was already checkpoint-committed above (commitCheckpoint), for all interrupt
    // types including 'window' — no need to commit again here.
    const resumes = bumpResume(db, task.id);
    const maxResumes = getNum(db, 'max_resumes', 2);
    // Once the resume budget is spent the scheduler would never re-dispatch it
    // (tick only resumes resume_count <= max_resumes), so hand it to a human as
    // 'attention' instead of leaving a zombie 'blocked' task. Mirrors recovery.ts.
    if (resumes > maxResumes) {
      setStatus(db, task.id, 'attention', {
        run_id: run.id,
        detail: `resume limit (${maxResumes}) exceeded; interrupted: ${finished.interrupted_by}`,
      });
    } else {
      setStatus(db, task.id, 'blocked', { run_id: run.id, detail: `interrupted: ${finished.interrupted_by}` });
    }
    return;
  }
  if (dispatchFailed(result)) {
    // Adapter error: the worktree (and any streamed session) is intact — hold for triage.
    setStatus(db, task.id, 'attention', {
      run_id: run.id,
      detail: `exit=${result.exitCode} subtype=${result.resultSubtype} ${result.error ?? ''}`.trim(),
    });
    return;
  }

  // auto-commit insurance (real repos only — generic has no git worktree to commit)
  if (!isMock && !isGeneric) {
    try {
      if (isDirty(worktreePath)) commitAll(worktreePath, `loop(${task.id}): auto-commit`);
    } catch (err) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `auto-commit failed: ${String(err)}` });
    }
  }

  // verify (base=null for a repo-less generic task: judge.ts builds a file-list prompt
  // instead of a git diff when it runs the llm judge)
  setStatus(db, task.id, 'verifying', { run_id: run.id });
  const verifyOutcome = await runVerifyPipeline(db, task, worktreePath, run.id, task.base_branch);
  if (verifyOutcome === 'fail') return; // already routed to blocked/attention inside the pipeline
  let manualVerify = verifyOutcome === 'manual';

  // A manual verify outcome always parks the task in review with merge_status='pending'
  // (reusing the existing pending/合併 button) — true for a mock/repo-less task too, so
  // this is set before the repo-only close-out below (which a mock task never enters).
  // Generic NEVER sets merge_status (there is nothing to merge) — its review detail just
  // notes where the deliverable landed.
  let reviewDetail = 'verification passed';
  if (manualVerify) {
    reviewDetail = isGeneric ? `待人工驗證 — 產出於 outputs/${task.id}` : markManualPending(db, task.id);
  } else if (isGeneric) {
    reviewDetail = `verification passed；產出於 outputs/${task.id}`;
  }

  // post-verify git close-out: push branch (backup) -> merge latest base into branch
  // -> (re-verify on merge) -> diffstat/gap-review/PR -> integrate into base. All
  // host-only and best-effort; with every git_* setting off this reduces to the old
  // diffstat -> gap-review -> PR flow. A 'manual' verify outcome defers auto-integrate
  // entirely (still pushes + opens a backup PR) so a human can merge after verifying on
  // hardware/at the company.
  if (!isMock && !isGeneric && branch && task.base_branch && task.repo_path) {
    const base = task.base_branch;
    const autoPush = getBool(db, 'auto_push_branch', true);
    const autoMerge = getBool(db, 'auto_merge', true) && !manualVerify;

    // 1. early backup push of the loop branch
    if (autoPush) pushBranch(worktreePath, branch);

    // 2. bring the latest base into the branch — ONLY when we intend to integrate.
    //    With auto_merge off (or a manual verify outcome) the branch is left exactly as
    //    the agent committed it, so all-flags-off truly restores the old diffstat ->
    //    gap-review -> PR flow.
    if (autoMerge) {
      const sync = syncWithBase(worktreePath, base, getBool(db, 'git_fetch_base', true));
      if (sync.status === 'merged') {
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'merge', detail: `merged ${sync.baseRef} into ${branch}` });
        // the branch changed — re-verify (command+llm gates only; reaching this branch
        // already proves the first pass was NOT 'manual', since autoMerge would be false)
        setStatus(db, task.id, 'verifying', { run_id: run.id });
        const reOutcome = await runVerifyPipeline(db, task, worktreePath, run.id, base);
        if (reOutcome === 'fail') return;
        if (reOutcome === 'manual') {
          manualVerify = true; // e.g. budget crossed the hard limit between the two passes
          reviewDetail = markManualPending(db, task.id);
        } else if (autoPush) {
          pushBranch(worktreePath, branch);
        }
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

    // 5. integrate into base (skipped entirely for a manual verify outcome)
    let mergeStatus: string | null = null;
    if (autoMerge && !manualVerify) {
      stripLoopArtifacts(worktreePath);
      if (autoPush) pushBranch(worktreePath, branch);
      const r = integrateIntoBase(task.repo_path, worktreePath, branch, base);
      mergeStatus = r.outcome;
      db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run(r.outcome, task.id);
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'merge', detail: r.detail });
      reviewDetail = r.outcome === 'merged'
        ? `verification passed; merged into ${base}`
        : `verification passed; awaiting merge into ${base} (${r.detail})`;
      // the engine just changed its own repo on main — flag a rebuild+restart so later
      // chain tasks run the new code (idle-gated pickup in scheduler/tick.ts).
      if (r.outcome === 'merged' && getBool(db, 'self_update', true) && isEngineRepo(task.repo_path)) {
        setSetting(db, 'self_update_pending', 'true');
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: 'self-update pending: engine repo changed on main' });
      }
    }
    // 6. reclaim the worktree once work is externalized (merged OR a PR link exists);
    //    keep it for pending/conflict-without-PR (and manual review, so VERIFY.md and the
    //    branch stay reachable until a human merges it).
    if (!manualVerify && (mergeStatus === 'merged' || prUrl)) cleanupWorktree(db, task);
  }
  setStatus(db, task.id, 'review', { run_id: run.id, detail: reviewDetail });
}

export type VerifyPipelineOutcome = 'pass' | 'fail' | 'manual';

/**
 * Layered verification: command steps (shell exit 0) -> optional LLM judge (rubric) ->
 * manual human gate. A command or llm-judge FAIL routes through handleVerifyFailure
 * (identical blocked/attention semantics as a plain command failure) and returns 'fail'.
 * An inconclusive LLM judge (no `claude` CLI, mock tool, or over-budget) is NEVER treated
 * as a pass — it downgrades to 'manual', same as an explicit verify_mode=manual. Default
 * verify_mode='command' reduces to the old runVerification call: byte-identical behavior.
 */
export async function runVerifyPipeline(
  db: Database.Database,
  task: Task,
  worktree: string,
  runId: string,
  // null for a repo-less generic task — see judge.ts's file-listing branch.
  base: string | null,
  // Test-only injection point for the LLM judge exec (mirrors distill.ts's DistillExec
  // plumbing) — production call sites omit it and get the real `claude` CLI call.
  judgeExec?: JudgeExec,
): Promise<VerifyPipelineOutcome> {
  const modes = parseVerifyMode(task);
  const timeoutMs = (task.verify_timeout_min ?? getNum(db, 'verify_step_timeout_min', 10)) * 60_000;
  let needsManual = modes.has('manual');

  // hardware/environment awareness: this host may lack a capability the task requires
  // (e.g. camera for AOI) — command verification can't meaningfully run here, so skip it
  // and defer to manual instead of failing. Zero-impact when requires is null/all-met.
  const unmet = unmetCapabilities(task, getSetting(db, 'host_capabilities') ?? '');
  if (unmet.length > 0) {
    logEvent(db, {
      task_id: task.id,
      run_id: runId,
      kind: 'note',
      detail: `capability(s) unavailable here: ${unmet.join(',')} → command verification skipped, deferred to manual`,
    });
    modes.delete('command');
    needsManual = true;
  }

  if (modes.has('command') && parseSteps(task).length > 0) {
    const vres = await runVerification(task, worktree, timeoutMs);
    if (!vres.ok) {
      handleVerifyFailure(db, task, runId, worktree, vres);
      return 'fail';
    }
  }

  if (modes.has('llm')) {
    const judged = await runLlmJudge(db, task, worktree, base, judgeExec);
    if (judged.pass === false) {
      const synthetic: VerifyResult = {
        ok: false,
        results: [{ step: 'LLM judge', ok: false, exitCode: null, timedOut: false, output: judged.reason }],
        failedStep: 'LLM judge',
      };
      handleVerifyFailure(db, task, runId, worktree, synthetic);
      return 'fail';
    }
    if (judged.pass === null) needsManual = true;
  }

  return needsManual ? 'manual' : 'pass';
}

/** Park a task's merge as pending for a manual verify outcome; returns the review detail. */
function markManualPending(db: Database.Database, taskId: string): string {
  db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run('pending', taskId);
  return '待人工驗證 — 見 VERIFY.md；驗過後按合併';
}

/**
 * Shared verify-failure handling for both first-verify and post-merge re-verify, so both
 * paths get IDENTICAL semantics: recoverable (blocked -> auto-resume) while we still have
 * the session and resume budget, else 'attention' (human hold — worktree and
 * LOOP_RESUME_CONTEXT.md kept so 續跑/重來 can pick it up).
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
  writeResumeContext(worktreePath, failedStep, tail); // a manual 續跑 resume still gets the context
  setStatus(db, task.id, 'attention', { run_id: runId, detail: `verify failed at: ${failedStep}\n${tail}` });
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

/**
 * A dispatch that must NOT reach verify: an adapter error, any non-zero exit
 * (regardless of subtype — closes the exit!=0-with-subtype-'success' hole), or an
 * explicit non-success subtype on a clean exit (closes the exit=0-with-subtype-'error'
 * hole). exit=0 with subtype null (final event never flushed but the process exited
 * clean) still passes — auto-commit + verify backstop it. Shared by the failure branch
 * and the cold-start-resume fallback below, so both read the SAME hole-closed signal.
 */
function dispatchFailed(r: DispatchResult): boolean {
  return !!r.error || r.exitCode !== 0 || (r.resultSubtype !== null && r.resultSubtype !== 'success');
}

export type SetupOutcome = { kind: 'skipped' } | { kind: 'ok' } | { kind: 'failed'; exitCode: number | null; tail: string };

/** Run a task's setup_cmd, honoring the per-worktree sentinel. Caller has already checked task.setup_cmd. */
export async function runTaskSetup(task: Task, worktreePath: string, logPath: string): Promise<SetupOutcome> {
  const sentinel = worktreeInternalFile(worktreePath, 'loop-setup-done');
  let alreadyDone = false;
  try {
    alreadyDone = fs.readFileSync(sentinel, 'utf8') === task.setup_cmd;
  } catch {
    /* no sentinel yet */
  }
  if (alreadyDone) return { kind: 'skipped' };
  const { exitCode, tail } = await runSetup(task.setup_cmd!, worktreePath, logPath);
  if (exitCode !== 0) return { kind: 'failed', exitCode, tail };
  try {
    fs.writeFileSync(sentinel, task.setup_cmd!);
  } catch {
    /* sentinel is an optimization; ignore write failure */
  }
  return { kind: 'ok' };
}

function runSetup(cmd: string, cwd: string, logPath: string): Promise<{ exitCode: number | null; tail: string }> {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('bash', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const fd = fs.openSync(logPath, 'a');
      let tail = '';
      const w = (d: Buffer) => {
        fs.writeSync(fd, d);
        tail = (tail + d.toString('utf8')).slice(-1500);
      };
      child.stdout.on('data', w);
      child.stderr.on('data', w);
      const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        resolve({ exitCode: code, tail });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ exitCode: null, tail });
      });
    });
  });
}
