import type { Task } from '../types.js';
import { parseSteps } from '../types.js';
import { resolveShell, runShell, type ResolveShellOptions } from '../util/shell.js';

export interface VerifyStepResult {
  step: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export interface VerifyResult {
  ok: boolean;
  results: VerifyStepResult[];
  failedStep: string | null;
}

/** Run each verification step in the worktree, in order, each with its own timeout. */
export async function runVerification(
  task: Task,
  cwd: string,
  perStepTimeoutMs = 10 * 60_000,
  shellOpts?: ResolveShellOptions,
): Promise<VerifyResult> {
  const steps = parseSteps(task);
  const shell = resolveShell(shellOpts);
  const results: VerifyStepResult[] = [];
  for (const step of steps) {
    const r = await runStep(step, cwd, perStepTimeoutMs, shell);
    results.push(r);
    if (!r.ok) return { ok: false, results, failedStep: step };
  }
  return { ok: true, results, failedStep: null };
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
