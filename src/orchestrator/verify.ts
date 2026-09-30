import type { Task } from '../types.js';
import { parseSteps } from '../types.js';
import { resolveShell, runShell, type ResolveShellOptions } from '../util/shell.js';
import type { SandboxStepRunner } from '../exec/sandbox.js';

export interface VerifyStepResult {
  step: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  /** how long the step took (wall clock), so the run history can show time per step */
  ms?: number;
}

export interface VerifyResult {
  ok: boolean;
  results: VerifyStepResult[];
  failedStep: string | null;
}

/**
 * A step written as `sandbox: <command>` runs inside the GPU 執行沙盒 (src/exec/sandbox.ts) with the
 * worktree at /work, instead of on the host — the same environment the agent built and ran in.
 * `sandbox@<host>: <command>` runs it on that registered machine (src/exec/hosts.ts) instead of
 * the default one, e.g. the box that holds the image library.
 */
export const SANDBOX_STEP_PREFIX = 'sandbox:';
const SANDBOX_STEP_RE = /^sandbox(?:@([a-z0-9][a-z0-9_-]*))?\s*:/i;

export function parseSandboxStep(step: string): { host: string | null; command: string } | null {
  const t = step.trimStart();
  const m = SANDBOX_STEP_RE.exec(t);
  return m ? { host: m[1]?.toLowerCase() ?? null, command: t.slice(m[0].length).trim() } : null;
}

/** The command of a `sandbox:` / `sandbox@host:` step, or null for a host step. */
export function sandboxStepCommand(step: string): string | null {
  return parseSandboxStep(step)?.command ?? null;
}

/**
 * A step written as `check:<ck_id>` is one of the repo's 檢查 (src/checks/*), frozen into the task's
 * checks_json: on the engine host, on a 機台, a 圖資回歸 or a 紅→綠 repro — the checks runner
 * decides, and its result carries the check's NAME as the step, so failures read 「單元測試」.
 */
export const CHECK_STEP_PREFIX = 'check:';
const CHECK_STEP_RE = /^check:\s*(ck_[A-Za-z0-9_-]{1,40})\s*$/;

export function parseCheckStep(step: string): string | null {
  return CHECK_STEP_RE.exec(step.trim())?.[1] ?? null;
}

export type CheckStepRunner = (step: string, cwd: string, timeoutMs: number) => Promise<VerifyStepResult>;

/** Run each verification step in the worktree, in order, each with its own timeout. */
export async function runVerification(
  task: Task,
  cwd: string,
  perStepTimeoutMs = 10 * 60_000,
  shellOpts?: ResolveShellOptions,
  // runs `sandbox:` steps; null/absent (exec_enabled off) makes such a step fail with a clear note
  sandbox?: SandboxStepRunner | null,
  // runs `check:` steps (src/checks/runner.ts); null/absent makes such a step fail with a clear note
  checks?: CheckStepRunner | null,
): Promise<VerifyResult> {
  const steps = parseSteps(task);
  const shell = resolveShell(shellOpts);
  const results: VerifyStepResult[] = [];
  for (const step of steps) {
    const ck = parseCheckStep(step);
    if (ck !== null) {
      const started = Date.now();
      const r = await runCheckStep(step, cwd, perStepTimeoutMs, checks ?? null);
      r.ms = Date.now() - started;
      results.push(r);
      if (!r.ok) return { ok: false, results, failedStep: r.step };
      continue;
    }
    const sb = parseSandboxStep(step);
    const started = Date.now();
    const r = sb === null ? await runStep(step, cwd, perStepTimeoutMs, shell) : await runSandboxStep(step, sb.command, sb.host, cwd, perStepTimeoutMs, sandbox ?? null);
    r.ms = Date.now() - started;
    results.push(r);
    if (!r.ok) return { ok: false, results, failedStep: step };
  }
  return { ok: true, results, failedStep: null };
}

async function runCheckStep(step: string, cwd: string, timeoutMs: number, checks: CheckStepRunner | null): Promise<VerifyStepResult> {
  if (!checks) {
    return { step, ok: false, exitCode: null, timedOut: false, output: '這一步是 repo 的檢查（check:），但這裡沒有接上檢查執行器：請從任務的驗證流程執行它。' };
  }
  try {
    return await checks(step, cwd, timeoutMs);
  } catch (err) {
    return { step, ok: false, exitCode: null, timedOut: false, output: `檢查執行失敗：${String((err as Error)?.message ?? err)}` };
  }
}

async function runSandboxStep(
  step: string,
  command: string,
  host: string | null,
  cwd: string,
  timeoutMs: number,
  sandbox: SandboxStepRunner | null,
): Promise<VerifyStepResult> {
  if (!command) return { step, ok: false, exitCode: null, timedOut: false, output: '`sandbox:` 後面沒有指令' };
  if (!sandbox) {
    return {
      step,
      ok: false,
      exitCode: null,
      timedOut: false,
      output: '這一步要在 GPU 執行沙盒裡跑，但沙盒沒有開（loop config set exec_enabled true）；或把它改成一般指令。',
    };
  }
  const r = await sandbox(command, cwd, timeoutMs, host);
  return { step, ...r };
}

async function runStep(
  step: string,
  cwd: string,
  timeoutMs: number,
  shell: ReturnType<typeof resolveShell>,
): Promise<VerifyStepResult> {
  const r = await runShell(step, cwd, { timeoutMs, shell });
  return { step, ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: r.timedOut, output: r.output };
}
