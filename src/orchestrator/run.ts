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
import { knowledgeContext, ragTaskContext } from '../knowledge/context.js';
import type { EmbedExec } from '../knowledge/embed.js';
import { writeSettingsLocal } from './settingsLocal.js';
import { runVerification, type VerifyResult, type VerifyStepResult } from './verify.js';
import { resolveShell, runShell } from '../util/shell.js';
import { runLlmJudge, type JudgeExec } from './judge.js';
import { parseSteps, parseVerifyMode } from '../types.js';
import { unmetCapabilities } from '../capabilities.js';
import { runGapReview } from '../review/gapReviewer.js';
import { createPr } from '../git/pr.js';
import { prBody } from './runSummary.js';
import { syncWithBase, pushBranch, stripLoopArtifacts, integrateIntoBase, baseRefFor } from '../git/integrate.js';
import { verifiedShas } from '../review/code.js';
import { createMergeTask } from './mergeTask.js';
import { cleanupWorktree } from './cleanup.js';
import { killRun } from './kill.js';
import { mockAdapter } from './adapters/mock.js';
import { getBackend } from './adapters/registry.js';
import type { Adapter, DispatchResult } from './adapters/types.js';
import { runPlanner, type PlannerExec } from './planner.js';
import { runDeployTask, type DeployExec } from './deployTask.js';
import { getEnvironment } from '../deploy/store.js';
import { isLocalModel, localId, getLocalModel } from '../local/models.js';
import { parseMcpServers, runtimeEnvFor, type McpServerCfg } from '../mcp/config.js';
import { cleanupTaskMcp, writeTaskMcp, execServerForTask, execToolTimeoutMs, EXEC_SERVER, type TaskMcp } from './taskMcp.js';
import { sandboxSettings, verifySandboxRunner, type SandboxDeps } from '../exec/sandbox.js';
import { describeExecHosts, resolveExecTarget } from '../exec/hosts.js';
import { evaluateAcceptance, extractMetrics, formatAcceptance, formatSpecs, parseAcceptance, parseProtected, protectedViolations, type MetricSpec, type MetricsReport } from './acceptance.js';

/**
 * MCP servers a local-model task may use (mcp_servers_json), with the runtime env the chat page
 * would inject — read-only fs roots, Loop's own API. A bad setting means no servers, not a
 * failed dispatch.
 */
function mcpServersForTask(db: Database.Database, runId?: string): McpServerCfg[] {
  let servers: McpServerCfg[];
  try {
    const apiUrl = `http://127.0.0.1:${process.env.LOOP_PORT || 4711}`;
    servers = parseMcpServers(getSetting(db, 'mcp_servers_json') || '').map((s) => ({
      ...s,
      environment: { ...(s.environment ?? {}), ...runtimeEnvFor(s.name, db, { apiUrl, apiToken: process.env.LOOP_API_TOKEN ?? '', dataDir: paths.dataDir }) },
    }));
  } catch {
    servers = [];
  }
  // GPU 執行沙盒: only the engine's own per-run server may carry this name
  servers = servers.filter((s) => s.name !== EXEC_SERVER);
  const exec = runId ? execServerForTask(db, runId) : null;
  return exec ? [...servers, exec] : servers;
}

/**
 * `coding_tool` (task type) and `agent_backend` (setting, see adapters/registry.ts) are
 * separate axes. 'mock' is always the zero-token adapter regardless of agent_backend.
 * 'claude-code' and 'generic' (a persistent-output-dir workspace mode — see runTask)
 * both dispatch through whichever backend `agent_backend` currently selects, so
 * switching that one setting swaps the real backend everywhere at once.
 */
export function pickAdapter(task: Task, db: Database.Database): Adapter {
  if (task.coding_tool === 'mock') return mockAdapter;
  if (task.coding_tool === 'claude-code' || task.coding_tool === 'generic') {
    // 本地模型: a resolved 'local:<id>' model always runs through opencode against vLLM,
    // whatever agent_backend says (that setting only picks the CLOUD backend).
    if (isLocalModel(resolveModel(db, task))) return getBackend('opencode');
    return getBackend(getSetting(db, 'agent_backend') || 'claude-code');
  }
  throw new Error(`unknown coding_tool: ${task.coding_tool}`);
}

/**
 * Resolve the model for a task's IMPLEMENTATION run. Precedence:
 *   1. task.model (non-empty) — the per-task override always wins (unchanged contract).
 *   2. model_routing on -> route_<complexity> (SDD Phase 3): route budget-cheap complexities
 *      to a cheaper model once their specs are precise enough (see sdd_specs). A route slot of
 *      ''/'default' means "fall through to default_model" (NOT the costly interactive CLI
 *      default), so an unset bucket still inherits the board default rather than dropping tiers.
 *   3. default_model.
 * A final ''/'default' -> null (no --model flag, CLI default), exactly as before. With
 * model_routing OFF this reduces to `task.model || default_model || null` — the same dispatch
 * as the previous inline expression (model.test.ts stays green). Routing applies ONLY to
 * implementation runs; the epic planner + SDD spec authoring stay on default_model (planner.ts).
 */
export function resolveModel(db: Database.Database, task: Task): string | null {
  // A per-task model is non-empty => it WINS (incl. the explicit literal 'default', which
  // then resolves to null = CLI default), so a task can always pin/opt-out of routing.
  const perTask = task.model?.trim();
  if (perTask) return perTask === 'default' ? null : perTask;
  let chosen = '';
  if (getBool(db, 'model_routing', false)) {
    const routed = (getSetting(db, `route_${task.complexity}`) ?? '').trim();
    if (routed && routed !== 'default') chosen = routed; // ''/'default' route -> fall through
  }
  if (!chosen) chosen = (getSetting(db, 'default_model') ?? '').trim();
  return chosen && chosen !== 'default' ? chosen : null;
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
  opts: {
    resume?: boolean;
    adapter?: Adapter;
    plannerExec?: PlannerExec;
    deployExec?: DeployExec;
    /** Test injection for the optional RAG task-context pull (see knowledge/context.ts). */
    ragEmbedExec?: EmbedExec;
  } = {},
): Promise<void> {
  // An epic (coding_tool='plan') never touches a worktree/adapter — it's decomposed into
  // a child task chain by runPlanner and closes immediately. Entirely separate lifecycle
  // from the git/mock/generic paths below.
  if (task.coding_tool === 'plan') return runPlanTask(db, task, opts.plannerExec);
  // A deploy task (coding_tool='deploy') never touches a worktree/adapter either — it
  // resolves a target `environments` row and either runs deploy_cmd or hands off a
  // DEPLOY.md package. See deployTask.ts.
  if (task.coding_tool === 'deploy') return runDeployTask(db, task, opts.deployExec);

  const isMock = task.coding_tool === 'mock';
  const isGeneric = task.coding_tool === 'generic';
  // 本地模型 run (model 'local:<id>' -> opencode + vLLM): zero Anthropic spend, so it skips the
  // forced live usage reads, the claude-only budget-guard hook and (by default) the gap review.
  const isLocal = !isMock && isLocalModel(resolveModel(db, task));
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  // Bill the run against a fresh reading at both boundaries. A cached reading (TTL
  // 180s) can make a short run look like ~0% delta and bias the estimator toward
  // zero. Mock runs stay on the cache (zero-token / deterministic tests).
  const beforeReading = readUsage({ force: !isMock && !isLocal });
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

  const disciplineOn = getBool(db, 'prompt_discipline', false);
  // Resolve the model ONCE: raw (null => CLI default, no --model) for dispatch, and a non-null
  // key ('default' when null) for storage + model-aware cost calibration (SDD Phase 3/4).
  const dispatchModel = resolveModel(db, task);
  const modelKey = dispatchModel ?? 'default';
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
    discipline: disciplineOn ? 1 : 0,
    model: modelKey,
  });

  // 任務執行中查知識庫: the read-only MCP servers this run may call (null when disabled).
  // Written outside the worktree so `git add -A` can never sweep it into the task branch.
  const taskMcp: TaskMcp | null = isMock || isGeneric ? null : writeTaskMcp(db, run.id, mcpServersForTask(db, run.id));
  const sandbox = sandboxSettings(db);
  const withSandbox = !!taskMcp?.servers.includes(EXEC_SERVER);
  const taskFilePath = writeTaskFile(worktreePath, task, {
    knowledge: knowledgeContext(db, task),
    rag: await ragTaskContext(db, task, opts.ragEmbedExec),
    discipline: disciplineOn,
    mcpServers: taskMcp?.servers,
    exec: withSandbox ? { image: sandbox.image, timeoutSec: sandbox.timeoutSec, maxTimeoutSec: sandbox.maxTimeoutSec, hosts: describeExecHosts(db) } : null,
  });
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
    const outcome = await runTaskSetup(task, worktreePath, logPath, getSetting(db, 'shell'));
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
  if (!isMock && !isLocal) writeSettingsLocal(worktreePath, hardLimit);

  const est = isLocal ? 0 : estimatePct(db, task.complexity, modelKey);
  db.prepare('UPDATE tasks SET est_session_pct = ? WHERE id = ?').run(est, task.id);
  setStatus(db, task.id, 'running', { run_id: run.id, session_pct: before });
  logEvent(db, {
    task_id: task.id,
    run_id: run.id,
    kind: 'dispatch',
    detail: `tool=${task.coding_tool} est=${est}%${isLocal ? ` model=${dispatchModel}` : ''}${opts.resume ? ' resume' : ''}`,
  });

  const adapter = opts.adapter ?? pickAdapter(task, db);
  const timeoutMs = process.env.LOOP_TEST_TIMEOUT_MS
    ? Number(process.env.LOOP_TEST_TIMEOUT_MS)
    : timeoutMinFor(db, task, dispatchModel) * 60_000;

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
      // resolved once above: per-task model wins; else per-complexity routing (model_routing);
      // else default_model. null/'default' -> no --model (CLI default). See resolveModel.
      model: dispatchModel,
      timeoutMs,
      local: isLocal ? (getLocalModel(db, localId(dispatchModel!)) ?? null) : null,
      localBaseUrl: getSetting(db, 'local_vllm_base_url') || undefined,
      mcpServers: isLocal ? mcpServersForTask(db, run.id) : undefined,
      mcpConfigPath: taskMcp?.configPath ?? null,
      mcpTools: taskMcp?.tools,
      // a sandbox build can outlast Claude Code's default MCP tool timeout
      env: withSandbox ? { MCP_TOOL_TIMEOUT: String(execToolTimeoutMs(sandbox)) } : undefined,
      resumeSessionId: resumeSid,
      resume: !!opts.resume,
      handoff,
      onEvent: (evt) => {
        // claude stream-json carries session_id; opencode --format json carries sessionID
        const sid = evt?.session_id ?? evt?.sessionID;
        if (!sidSaved && typeof sid === 'string' && sid) {
          sidSaved = true;
          updateRun(db, run.id, { session_id: sid });
        }
      },
    });
    updateRun(db, run.id, { pid: handle.pid });

    // Primary per-run watchdog: kill + mark timeout if it overruns.
    const timeoutTimer = setTimeout(() => {
      const cur = getRun(db, run.id);
      if (cur && !cur.finished_at) {
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'timeout', detail: `>${timeoutMinFor(db, task, dispatchModel)}m` });
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
  const afterReading = readUsage({ force: !isMock && !isLocal });
  const after = afterReading.session.percent;
  finishRun(db, run.id, {
    exit_code: result.exitCode,
    // keep the mid-stream session_id if the final event didn't carry one
    ...(result.sessionId ? { session_id: result.sessionId } : {}),
    usage_json: result.usageJson,
    tokens_in: result.tokensIn ?? null,
    tokens_out: result.tokensOut ?? null,
    backend: adapter.name,
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
  // A benchmark arm (task.benchmark_id) never integrates: its branch stays in the worktree until
  // the benchmark judge has read the diff (src/benchmark/complete.ts), so every arm is judged
  // against the same untouched base.
  if (task.benchmark_id && !manualVerify) reviewDetail = 'benchmark arm: verification passed — waiting for the judge';
  if (!isMock && !isGeneric && branch && task.base_branch && task.repo_path && !task.benchmark_id) {
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
          await tryCreatePr(db, task, run.id, worktreePath, branch);
          setStatus(db, task.id, 'review', {
            run_id: run.id,
            detail: `verification passed; merge conflict vs ${sync.baseRef}; resolution task ${mt.id} queued`,
          });
        } else {
          db.prepare('UPDATE tasks SET merge_status = ? WHERE id = ?').run('conflict', task.id);
          await tryCreatePr(db, task, run.id, worktreePath, branch);
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

    // the gap reviewer spawns `claude` — a local run skips it unless local_gap_review is on
    if (!isLocal || getBool(db, 'local_gap_review', false)) {
      try {
        const reviewPath = runGapReview(task, worktreePath);
        if (reviewPath) db.prepare('UPDATE tasks SET review_md_path = ? WHERE id = ?').run(reviewPath, task.id);
      } catch (err) {
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `gap-review skipped: ${String(err)}` });
      }
    }

    // 4. PR (its internal push is now a cheap re-push)
    const prUrl = await tryCreatePr(db, task, run.id, worktreePath, branch);

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

/**
 * Full lifecycle for an epic dispatch: no worktree, no adapter, no verify/git close-out —
 * an epic's "output" is the child task chain the planner materializes. Success closes the
 * epic directly (no review step: there is no diff to review); a planner failure (bad/no
 * LLM output, budget guard) parks it in attention for a human to retry or hand-decompose.
 */
async function runPlanTask(db: Database.Database, task: Task, plannerExec?: PlannerExec): Promise<void> {
  setStatus(db, task.id, 'running', {});
  logEvent(db, { task_id: task.id, kind: 'dispatch', detail: 'tool=plan' });
  const children = await runPlanner(db, task, plannerExec);
  if (!children) {
    setStatus(db, task.id, 'attention', { detail: 'planner failed to produce subtasks' });
    return;
  }
  setStatus(db, task.id, 'closed', { detail: `已拆解為 ${children.length} 個子任務` });
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
  // Test-only: stands in for `docker run` behind `sandbox:` verification steps.
  sandboxDeps?: SandboxDeps,
): Promise<VerifyPipelineOutcome> {
  const modes = parseVerifyMode(task);
  const timeoutMs = (task.verify_timeout_min ?? getNum(db, 'verify_step_timeout_min', 10)) * 60_000;
  let needsManual = modes.has('manual');

  // hardware/environment awareness: this host may lack a capability the task requires
  // (e.g. camera for AOI) — command verification can't meaningfully run here, so skip it
  // and defer to manual instead of failing. Zero-impact when requires is null/all-met.
  // A task's `environment` (e.g. 'company') additionally contributes that environments
  // row's `capabilities` (e.g. os:windows) into the same check — promoting environment
  // from a knowledge label to something the verify pipeline actually understands.
  const envCaps = task.environment ? (getEnvironment(db, task.environment)?.capabilities ?? '') : '';
  const extraRequires = envCaps.split(',').map((s) => s.trim()).filter(Boolean);
  const unmet = unmetCapabilities(task, getSetting(db, 'host_capabilities') ?? '', extraRequires);
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

  // 保護路徑: the evaluation, golden data etc. must be exactly what the base has — checked before
  // anything runs, whatever the verify mode, so a "fix" to the yardstick never gets measured
  const protectedGlobs = parseProtected(task.protected_paths);
  if (protectedGlobs.length && base) {
    let touched: string[] = [];
    try {
      touched = protectedViolations(worktree, baseRefFor(worktree, base), protectedGlobs);
    } catch (err) {
      logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `protected-path check skipped: ${String(err).slice(0, 200)}` });
    }
    if (touched.length) {
      const out = `這些受保護的檔案被改動了，請還原（git checkout ${base} -- <檔案>）再完成任務：\n${touched.map((f) => `- ${f}`).join('\n')}\n受保護的範圍：${protectedGlobs.join(', ')}`;
      recordVerification(db, runId, [{ step: '保護路徑', ok: false, exitCode: null, timedOut: false, output: out }], null, worktree, base);
      handleVerifyFailure(db, task, runId, worktree, { ok: false, results: [{ step: '保護路徑', ok: false, exitCode: null, timedOut: false, output: out }], failedStep: '保護路徑' });
      return 'fail';
    }
  }

  let specs: MetricSpec[] = [];
  try {
    specs = parseAcceptance(task.acceptance_metrics);
  } catch (err) {
    logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `acceptance_metrics ignored: ${(err as Error).message}` });
  }

  if (modes.has('command') && parseSteps(task).length > 0) {
    // `sandbox:` steps run in the same GPU 沙盒 the agent had — null when exec is off, so such
    // a step fails with a clear message instead of silently running on the host
    const sandbox = sandboxSettings(db);
    const vres = await runVerification(
      task,
      worktree,
      timeoutMs,
      { shellSetting: getSetting(db, 'shell') },
      // the task's remote workspace is shared with the agent's own runs (same key): incremental builds
      sandbox.enabled ? verifySandboxRunner(sandbox, sandboxDeps, (name) => resolveExecTarget(db, name), `task-${task.id}`) : null,
    );
    // 驗收指標: whatever the steps reported, compared with the task's thresholds by the engine
    const metrics = specs.length || vres.results.some((r) => r.output.includes('LOOP_METRICS'))
      ? evaluateAcceptance(specs, extractMetrics(vres.results.map((r) => r.output)))
      : null;
    recordVerification(db, runId, vres.results, metrics, worktree, base);
    if (!vres.ok) {
      handleVerifyFailure(db, task, runId, worktree, vres);
      return 'fail';
    }
    if (metrics && !metrics.pass) {
      const out = `驗收指標未達標（門檻由任務設定，不在 repo 裡）：\n${formatAcceptance(metrics)}`;
      handleVerifyFailure(db, task, runId, worktree, { ok: false, results: [...vres.results, { step: '驗收指標', ok: false, exitCode: null, timedOut: false, output: out }], failedStep: '驗收指標' });
      return 'fail';
    }
    if (metrics?.checks.length) {
      logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `驗收指標通過：${metrics.checks.map((c) => `${c.name}=${c.actual}`).join('，')}` });
    }
  } else if (specs.length) {
    // thresholds that could not be measured here are a human's to check, never a silent pass
    logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `驗收指標未檢查（沒有執行 command 驗證）：${formatSpecs(specs)} → 人工驗收` });
    needsManual = true;
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

/**
 * What the last verification of a run found, for the morning report, the PR body and the review
 * page — and which code it looked at (HEAD and its merge-base with the base branch), so the
 * task's diff can still be shown after the worktree is reclaimed.
 */
function recordVerification(
  db: Database.Database,
  runId: string,
  results: VerifyStepResult[],
  metrics: MetricsReport | null,
  worktree: string,
  base: string | null,
): void {
  try {
    updateRun(db, runId, {
      verify_json: JSON.stringify(
        results.map((r) => ({ step: r.step, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, tail: r.output.replace(/\s+$/, '').slice(-600) })),
      ),
      metrics_json: metrics ? JSON.stringify(metrics) : null,
      ...(base ? verifiedShas(worktree, base) : {}),
    });
  } catch {
    /* reporting only — never fail a verification over it */
  }
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

/** Best-effort PR creation; records pr_url + a note on success. Returns the URL or null. On a local
 * Gitea (gitea_url + GITEA_TOKEN) the description carries what was verified (runSummary.prBody). */
async function tryCreatePr(
  db: Database.Database,
  task: Task,
  runId: string,
  worktreePath: string,
  branch: string,
): Promise<string | null> {
  try {
    const giteaUrl = (getSetting(db, 'gitea_url') ?? '').trim();
    const prUrl = await createPr(worktreePath, branch, task.title, {
      base: task.base_branch,
      body: giteaUrl ? prBody(task, getRun(db, runId), worktreePath) : undefined,
      gitea: giteaUrl ? { url: giteaUrl, token: process.env.GITEA_TOKEN ?? '' } : null,
      onError: (msg) => logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: msg }),
    });
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
export async function runTaskSetup(
  task: Task,
  worktreePath: string,
  logPath: string,
  shellSetting?: string,
): Promise<SetupOutcome> {
  const sentinel = worktreeInternalFile(worktreePath, 'loop-setup-done');
  let alreadyDone = false;
  try {
    alreadyDone = fs.readFileSync(sentinel, 'utf8') === task.setup_cmd;
  } catch {
    /* no sentinel yet */
  }
  if (alreadyDone) return { kind: 'skipped' };
  const { exitCode, tail } = await runSetup(task.setup_cmd!, worktreePath, logPath, shellSetting);
  if (exitCode !== 0) return { kind: 'failed', exitCode, tail };
  try {
    fs.writeFileSync(sentinel, task.setup_cmd!);
  } catch {
    /* sentinel is an optimization; ignore write failure */
  }
  return { kind: 'ok' };
}

function runSetup(
  cmd: string,
  cwd: string,
  logPath: string,
  shellSetting?: string,
): Promise<{ exitCode: number | null; tail: string }> {
  const fd = fs.openSync(logPath, 'a');
  let tail = '';
  return runShell(cmd, cwd, {
    timeoutMs: 10 * 60_000,
    shell: resolveShell({ shellSetting }),
    onData: (d) => {
      fs.writeSync(fd, d);
      tail = (tail + d.toString('utf8')).slice(-1500);
    },
  }).then(({ exitCode }) => {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    return { exitCode, tail };
  });
}
