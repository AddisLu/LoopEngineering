import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Task } from '../types.js';
import { parseSteps, parseVerifyMode } from '../types.js';

export interface GateResult {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

const ALLOWED_TOOLS = new Set(['claude-code', 'mock']);

/**
 * Required-fields checklist (no LLM review). A task may only advance
 * draft -> ready -> queued when this returns ok=true.
 */
export function validateTask(task: Task): GateResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!task.goal || !task.goal.trim()) missing.push('goal');

  // plan_ref: file must exist with .md/.html, or be a well-formed URL
  if (!task.plan_ref || !task.plan_ref.trim()) {
    missing.push('plan_ref (plan .md/.html or URL)');
  } else {
    const ref = task.plan_ref.trim();
    if (/^https?:\/\//i.test(ref)) {
      if (!isWellFormedUrl(ref)) missing.push('plan_ref (malformed URL)');
    } else {
      if (!fs.existsSync(ref)) missing.push('plan_ref (file not found)');
      else if (!/\.(md|html?)$/i.test(ref)) missing.push('plan_ref (must be .md/.html)');
    }
  }

  if (!ALLOWED_TOOLS.has(task.coding_tool)) {
    missing.push(`coding_tool (allowed: ${[...ALLOWED_TOOLS].join(', ')})`);
  }

  // verify_mode relaxation: a manual-only task has no automated check to require, so it
  // needs zero verification steps. Any other mode (including 'command' alongside
  // 'llm'/'manual') keeps the old >= 1 step requirement — zero behavior change for the
  // default mode 'command'.
  const modes = parseVerifyMode(task);
  const manualOnly = modes.size === 1 && modes.has('manual');
  if (!manualOnly) {
    const steps = parseSteps(task);
    if (steps.length === 0) missing.push('verification_steps (>= 1 command)');
    else if (steps.some((s) => !s || !s.trim())) missing.push('verification_steps (empty step)');
  }
  if (modes.has('llm') && (!task.verify_rubric || !task.verify_rubric.trim())) {
    missing.push('verify_rubric');
  }

  // repo checks are skipped for the mock tool (mock runs in a scratch dir)
  if (task.coding_tool !== 'mock') {
    if (!task.repo_path || !fs.existsSync(task.repo_path)) {
      missing.push('repo_path (existing directory)');
    } else if (!isGitRepo(task.repo_path)) {
      missing.push('repo_path (not a git repo)');
    } else if (!task.base_branch) {
      missing.push('base_branch');
    } else if (!branchExists(task.repo_path, task.base_branch)) {
      missing.push(`base_branch (not found: ${task.base_branch})`);
    }
  }

  // non-blocking warning
  if (!task.setup_cmd || !task.setup_cmd.trim()) {
    warnings.push('setup_cmd empty — verification may fail if deps are not installed');
  }

  return { ok: missing.length === 0, missing, warnings };
}

function isWellFormedUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function branchExists(dir: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', branch], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
