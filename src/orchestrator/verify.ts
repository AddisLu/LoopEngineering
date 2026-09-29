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
}

export interface VerifyResult {
  ok: boolean;
  results: VerifyStepResult[];
  failedStep: string | null;
}

/**
 * A step written as `sandbox: <command>` runs inside the GPU 執行沙盒 (src/exec/sandbox.ts) with the
 * worktree at /work, instead of on the host — the same environment the agent built and ran in.
 */
export const SANDBOX_STEP_PREFIX = 'sandbox:';

export function sandboxStepCommand(step: string): string | null {
  const t = step.trimStart();
  return t.toLowerCase().startsWith(SANDBOX_STEP_PREFIX) ? t.slice(SANDBOX_STEP_PREFIX.length).trim() : null;
}

/** Run each verification step in the worktree, in order, each with its own timeout. */
export async function runVerification(
  task: Task,
  cwd: string,
  perStepTimeoutMs = 10 * 60_000,
  shellOpts?: ResolveShellOptions,
  // runs `sandbox:` steps; null/absent (exec_enabled off) makes such a step fail with a clear note
  sandbox?: SandboxStepRunner | null,
): Promise<VerifyResult> {
  const steps = parseSteps(task);
  const shell = resolveShell(shellOpts);
  const results: VerifyStepResult[] = [];
  for (const step of steps) {
    const inner = sandboxStepCommand(step);
    const r = inner === null ? await runStep(step, cwd, perStepTimeoutMs, shell) : await runSandboxStep(step, inner, cwd, perStepTimeoutMs, sandbox ?? null);
    results.push(r);
    if (!r.ok) return { ok: false, results, failedStep: step };
  }
  return { ok: true, results, failedStep: null };
}

async function runSandboxStep(
  step: string,
  command: string,
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
  const r = await sandbox(command, cwd, timeoutMs);
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
