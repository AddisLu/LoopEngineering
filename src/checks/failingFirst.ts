import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import { parseCheckSnapshots, type CheckSnapshot } from './render.js';
import { runCheck, type CheckDeps } from './runner.js';

/**
 * 先失敗再修 (`failing_first`): before any token is spent, the engine runs the ticket's 重現 command
 * once in the fresh worktree — still the base — and it must FAIL. A repro that already passes cannot
 * prove the fix, so the task goes to attention instead; a red one hands its output to the agent
 * (LOOP_TASK.md「## 重現輸出（修改前）」). A machine that cannot be reached, or a run that timed
 * out, proves nothing either way: the task goes ahead without the section.
 */

export type FailingFirst =
  | { kind: 'skip' }
  | { kind: 'red'; tail: string; crId: string }
  | { kind: 'passed'; tail: string; crId: string }
  | { kind: 'unknown'; reason: string; crId: string };

/** exit 255 is what ssh returns when it cannot connect (src/exec/remote.ts) */
const UNREACHABLE = 255;

/** The frozen check the gate runs: the first 重現 with a command that is meant to be red on base. */
export function reproCheckOf(task: Pick<Task, 'checks_json'>): CheckSnapshot | null {
  return parseCheckSnapshots(task).find((c) => c.kind === 'repro' && !!c.command?.trim() && c.red_on_base) ?? null;
}

export async function failingFirst(
  db: Database.Database,
  task: Task,
  cwd: string,
  runId: string,
  deps: CheckDeps = {},
): Promise<FailingFirst> {
  const snap = reproCheckOf(task);
  if (!snap) return { kind: 'skip' };
  const out = await runCheck(
    db,
    snap,
    {
      cwd,
      timeoutMs: 20 * 60_000,
      kind: 'repro_before',
      record: true,
      taskId: task.id,
      runId,
      base: task.base_branch,
      // nothing is pushed yet: a machine checks out the base itself
      branch: task.base_branch,
      redGreen: false,
    },
    deps,
  );
  const r = out.result;
  const tail = (r.output ?? '').slice(-3000);
  if (r.timedOut) return { kind: 'unknown', reason: `重現指令逾時（${snap.name}）`, crId: out.crId };
  if (r.exitCode === UNREACHABLE || r.exitCode === null) return { kind: 'unknown', reason: `重現指令沒有跑起來（${snap.name}）：${tail.split('\n').filter(Boolean).pop() ?? ''}`, crId: out.crId };
  return r.ok ? { kind: 'passed', tail, crId: out.crId } : { kind: 'red', tail, crId: out.crId };
}

/**
 * The 分析卡's 試跑 (analysis step 5): the repro command the person typed, run once on the repo's
 * own clone (or its machine) without a check_runs row. `ok` = it exited 0, i.e. it does NOT
 * reproduce. The caller only runs commands a person wrote — never one proposed by a model or
 * copied from a Gitea issue body.
 */
export async function reproDryRun(
  db: Database.Database,
  task: Pick<Task, 'id' | 'base_branch'>,
  repo: { id: string; local_path: string; machine: string | null; default_branch: string },
  repro: { command: string | null; test_file?: string | null },
  deps: CheckDeps = {},
): Promise<{ ok: boolean; exit_code: number | null; ms: number; tail: string }> {
  const snap: CheckSnapshot = {
    id: 'ck_ticket_repro',
    repo_id: repo.id,
    name: '重現',
    kind: 'repro',
    machine: repo.machine,
    command: repro.command,
    pass_rule: 'exit0',
    metrics: null,
    thresholds: null,
    baseline: null,
    baseline_tol: 0,
    dataset: null,
    test_globs: [],
    red_on_base: false,
    timeout_min: 10,
    required: true,
    ord: 0,
    protected_paths: [],
    artifacts: [],
    manual_text: null,
    metric_prefix: null,
  };
  const branch = task.base_branch ?? repo.default_branch;
  const out = await runCheck(
    db,
    snap,
    { cwd: repo.local_path, timeoutMs: 10 * 60_000, kind: 'trial', record: false, taskId: task.id, runId: null, base: branch, branch, redGreen: false },
    deps,
  );
  const r = out.result;
  return { ok: r.ok, exit_code: r.exitCode, ms: r.ms ?? 0, tail: (r.output ?? '').slice(-4000) };
}
