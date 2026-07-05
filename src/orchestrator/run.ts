import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getNum, logEvent } from '../db/index.js';
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
import { addWorktree, isDirty, commitAll, diffstat } from '../git/worktree.js';
import { writeTaskFile } from './prompt.js';
import { writeSettingsLocal } from './settingsLocal.js';
import { runVerification } from './verify.js';
import { runGapReview } from '../review/gapReviewer.js';
import { createPr } from '../git/pr.js';
import { killRun } from './kill.js';
import { mockAdapter } from './adapters/mock.js';
import { claudeCodeAdapter } from './adapters/claudeCode.js';
import type { Adapter } from './adapters/types.js';

function pickAdapter(tool: string): Adapter {
  if (tool === 'mock') return mockAdapter;
  if (tool === 'claude-code') return claudeCodeAdapter;
  throw new Error(`unknown coding_tool: ${tool}`);
}

function timeoutMinFor(db: Database.Database, task: Task): number {
  if (task.timeout_min != null) return task.timeout_min;
  return getNum(db, `timeout_${task.complexity}`, task.complexity === 'S' ? 15 : task.complexity === 'L' ? 120 : 45);
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
  const before = readUsage().session.percent;

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
      const wt = addWorktree(task.repo_path!, branch, task.base_branch!);
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
  });

  const taskFilePath = writeTaskFile(worktreePath, task);
  if (!isMock && task.setup_cmd) {
    // best-effort setup; failures surface at verification
    try {
      await runSetup(task.setup_cmd, worktreePath, logPath);
    } catch {
      /* ignore; verification will catch real breakage */
    }
  }
  if (!isMock) writeSettingsLocal(worktreePath, hardLimit);

  const est = estimatePct(db, task.complexity);
  db.prepare('UPDATE tasks SET est_session_pct = ? WHERE id = ?').run(est, task.id);
  setStatus(db, task.id, 'running', { run_id: run.id, session_pct: before });
  logEvent(db, { task_id: task.id, run_id: run.id, kind: 'dispatch', detail: `tool=${task.coding_tool} est=${est}%` });

  const adapter = pickAdapter(task.coding_tool);
  const timeoutMs = process.env.LOOP_TEST_TIMEOUT_MS
    ? Number(process.env.LOOP_TEST_TIMEOUT_MS)
    : timeoutMinFor(db, task) * 60_000;

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
    resumeSessionId,
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

  const result = await handle.wait;
  clearTimeout(timeoutTimer);

  const after = readUsage().session.percent;
  finishRun(db, run.id, {
    exit_code: result.exitCode,
    // keep the mid-stream session_id if the final event didn't carry one
    ...(result.sessionId ? { session_id: result.sessionId } : {}),
    usage_json: result.usageJson,
    session_pct_after: after,
    error: result.error ?? null,
  });

  // How did it end? (breaker/timeout/user set interrupted_by before/while killing)
  const finished = getRun(db, run.id)!;
  if (finished.interrupted_by === 'timeout') {
    setStatus(db, task.id, 'failed', { run_id: run.id, detail: 'watchdog timeout' });
    return;
  }
  if (finished.interrupted_by === 'breaker' || finished.interrupted_by === 'user') {
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
    const tail = vres.results.at(-1)?.output.slice(-800) ?? '';
    setStatus(db, task.id, 'failed', { run_id: run.id, detail: `verify failed at: ${vres.failedStep}\n${tail}` });
    return;
  }

  // post-verify: diffstat, gap-review, PR (all guarded/best-effort, host-only)
  if (!isMock && branch && task.base_branch && task.repo_path) {
    const stat = diffstat(worktreePath, task.base_branch);
    if (stat) logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `diffstat:\n${stat}` });

    try {
      const reviewPath = runGapReview(task, worktreePath);
      if (reviewPath) db.prepare('UPDATE tasks SET review_md_path = ? WHERE id = ?').run(reviewPath, task.id);
    } catch (err) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `gap-review skipped: ${String(err)}` });
    }

    try {
      const prUrl = createPr(worktreePath, branch, task.title);
      if (prUrl) {
        db.prepare('UPDATE tasks SET pr_url = ? WHERE id = ?').run(prUrl, task.id);
        logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `PR: ${prUrl}` });
      }
    } catch (err) {
      logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `PR skipped: ${String(err)}` });
    }
  }
  setStatus(db, task.id, 'review', { run_id: run.id, detail: 'verification passed' });
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
