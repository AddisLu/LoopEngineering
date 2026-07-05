import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { createTask, setStatus } from '../tasks.js';
import type { Task } from '../types.js';

/**
 * Auto-create a queued task that resolves a merge conflict between an original task's
 * branch and its base. The new task's branch starts at the original work (so the agent
 * only has to re-merge base and resolve), while its `base_branch` stays the REAL base.
 *
 * Recursion guard lives at the call site (run.ts): a task with a non-null parent_task_id
 * never spawns another merge task.
 */
export function createMergeTask(
  db: Database.Database,
  orig: Task,
  conflictFiles: string[],
  baseRef: string,
): Task {
  const base = orig.base_branch!;
  const repo = orig.repo_path!;

  // 1. Create the task first — createTask generates the id we need for the branch name.
  //    The plan file is written under plansDir before createTask so the intake gate
  //    (which requires an existing .md) passes for the new task.
  fs.mkdirSync(paths.plansDir, { recursive: true });
  // A stable-ish, collision-resistant filename without Date.now() dependence in tests:
  // include the orig id and the current runs count is not available, so use a hrtime tag.
  const stamp = process.hrtime.bigint().toString(36);
  const planPath = path.join(paths.plansDir, `merge-${orig.id}-${stamp}.md`);
  const fileList = conflictFiles.length ? conflictFiles.map((f) => `- \`${f}\``).join('\n') : '- (see `git status`)';
  const originBranch = `loop/${orig.id}`;
  fs.writeFileSync(
    planPath,
    `# Merge-conflict resolution for ${orig.id}

## Goal
Resolve the merge conflict between the branch \`loop/<this task id>\` (which already
starts at the work of ${orig.id}) and the base branch \`${base}\`, then get all
verification steps green.

## Situation
The original task ${orig.id} produced work on its branch, but merging the latest base
(\`${baseRef}\`) into it hit conflicts. This branch was pre-created starting from that
original work, so you do NOT need to redo it — you only need to bring in the latest base
and resolve the conflicts.

## Steps
1. If the repo has a remote: \`git fetch origin ${base}\` then \`git merge origin/${base}\`.
   Otherwise: \`git merge ${base}\`.
2. Resolve the conflicts in these files, PRESERVING BOTH SIDES' INTENT (do not blindly
   discard either the original work or the incoming base changes):
${fileList}
3. Commit the merge.
4. Run ALL verification steps and fix until they pass.
`,
  );

  const mt = createTask(db, {
    title: `[merge] ${orig.title}`,
    goal: `Resolve merge conflict of ${orig.id} against ${base} and pass verification.`,
    plan_ref: planPath,
    plan_kind: 'md',
    coding_tool: orig.coding_tool,
    verification_steps: JSON.parse(orig.verification_steps),
    setup_cmd: orig.setup_cmd,
    repo_path: repo,
    base_branch: base,
    complexity: 'S',
    priority: orig.priority + 1,
    model: orig.model,
  });

  // 2. Pre-create the branch loop/<newId> at the original work tip, so addWorktree's
  //    existing-branch path reuses it while base_branch remains the real base.
  try {
    execFileSync('git', ['-C', repo, 'branch', `loop/${mt.id}`, originBranch], { stdio: 'ignore' });
  } catch {
    /* best-effort: worktree add will fall back to cutting from base if the branch is absent */
  }

  db.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?').run(orig.id, mt.id);
  setStatus(db, mt.id, 'queued', { detail: `auto: merge-conflict resolution for ${orig.id}` });

  return { ...mt, parent_task_id: orig.id, status: 'queued' };
}
