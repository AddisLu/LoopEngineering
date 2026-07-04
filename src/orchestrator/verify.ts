import { spawn } from 'node:child_process';
import type { Task } from '../types.js';
import { parseSteps } from '../types.js';

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
): Promise<VerifyResult> {
  const steps = parseSteps(task);
  const results: VerifyStepResult[] = [];
  for (const step of steps) {
    const r = await runStep(step, cwd, perStepTimeoutMs);
    results.push(r);
    if (!r.ok) return { ok: false, results, failedStep: step };
  }
  return { ok: true, results, failedStep: null };
}

function runStep(step: string, cwd: string, timeoutMs: number): Promise<VerifyStepResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', step], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const cap = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ step, ok: false, exitCode: null, timedOut: true, output: out });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ step, ok: code === 0, exitCode: code, timedOut: false, output: out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ step, ok: false, exitCode: null, timedOut: false, output: String(err) });
    });
  });
}
