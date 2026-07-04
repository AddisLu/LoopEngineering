import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../types.js';
import { parseSteps } from '../types.js';

/** Resolve the plan content to inline into LOOP_TASK.md (best effort). */
function planContent(task: Task): string {
  const ref = task.plan_ref?.trim();
  if (!ref) return '(no plan attached)';
  if (/^https?:\/\//i.test(ref)) return `See plan at: ${ref}`;
  try {
    return fs.readFileSync(ref, 'utf8');
  } catch {
    return `(could not read plan file: ${ref})`;
  }
}

/**
 * Write LOOP_TASK.md into the worktree. The dispatch prompt only tells the agent to
 * read this file, so all task context lives here (goal, plan, verification, rules).
 */
export function writeTaskFile(cwd: string, task: Task): string {
  const steps = parseSteps(task);
  const file = path.join(cwd, 'LOOP_TASK.md');
  const body = `# Loop task: ${task.title}

## Goal
${task.goal}

## Plan
${planContent(task)}

## Verification steps (must all pass before you finish)
${steps.map((s) => `- \`${s}\``).join('\n') || '- (none)'}

## Rules
- Only modify files needed for this task; do not touch anything outside its scope.
- Commit your work in small, conventional commits.
- Before finishing, run the verification steps yourself and fix until they pass.
- If you cannot complete the task, clearly explain the blocker and stop — do not force a workaround.
`;
  fs.writeFileSync(file, body);
  return file;
}
