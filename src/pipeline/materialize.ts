import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { logEvent } from '../db/index.js';
import { createTask, setStatus } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import type { Task } from '../types.js';
import type { PipelineDef } from './types.js';

export interface MaterializePipelineInput {
  goal: string;
  repo_path?: string | null;
  base_branch?: string | null;
  environment?: string | null;
  title?: string | null;
  /** Shared across every command-mode stage — same idea as goal/repo/base: all stages
   * touch the same codebase, so the same test/typecheck commands gate each of them. */
  verification_steps?: string[];
}

/** Every non-deploy stage needs a plan_ref (gate-required for every tool but 'deploy') — one
 * shared brief synthesized from the goal, same idiom as mergeTask.ts's auto-created plan file. */
function writeSharedPlan(pipelineId: string, def: PipelineDef, goal: string): string {
  fs.mkdirSync(paths.plansDir, { recursive: true });
  const stamp = process.hrtime.bigint().toString(36);
  const planPath = path.join(paths.plansDir, `pipeline-${pipelineId}-${stamp}.md`);
  fs.writeFileSync(
    planPath,
    `# Pipeline: ${def.name}\n\n## 目標\n${goal}\n\n> 本計畫由 pipeline "${def.name}" 自動產生，各 stage 共用同一份 goal/plan，以各自的 verify_mode 作為關卡。\n`,
  );
  return planPath;
}

/** Title convention `${label}: ${stage.name}` — the board rollup recovers the pipeline's
 * display label by stripping this known suffix (see server/board.ts's pipelineLabel). */
function stageTitle(label: string, stageName: string): string {
  return `${label}: ${stageName}`;
}

/**
 * Instantiate a pipeline template into a depends_on task chain — the FIXED-decomposition
 * counterpart to planner.ts's materializePlan (AI decomposition). Each stage inherits
 * goal/repo/base/verification_steps from `input` and a shared synthesized plan_ref (a
 * command-mode stage needs the actual commands — the template only fixes ITS verify_mode,
 * not the commands, since those are repo-specific); stage.environment wins over
 * `input.environment` (a deploy stage's own target must never be silently overridden).
 * Tasks are chained by depends_on in template order and share one `pipeline_id`; the first
 * stage is auto-queued when its gate passes (rest stay draft — dep_auto_queue releases them
 * one at a time as each dependency closes, exactly like materializePlan). No parent_id/epic
 * wrapper is created — pipeline_id is the sole linking field for the board rollup.
 */
export function materializePipeline(
  db: Database.Database,
  def: PipelineDef,
  input: MaterializePipelineInput,
): Task[] {
  const pipelineId = `pl_${nanoid(10)}`;
  const label = (input.title && input.title.trim()) || def.name;
  const planPath = writeSharedPlan(pipelineId, def, input.goal);

  const children: Task[] = [];
  let prevId: string | null = null;
  for (const stage of def.stages) {
    const child = createTask(db, {
      title: stageTitle(label, stage.name),
      goal: input.goal,
      plan_ref: planPath,
      plan_kind: 'md',
      coding_tool: stage.coding_tool,
      repo_path: input.repo_path ?? null,
      base_branch: input.base_branch ?? null,
      complexity: stage.complexity ?? 'M',
      verification_steps: input.verification_steps ?? [],
      verify_mode: stage.verify_mode ?? null,
      verify_rubric: stage.rubric_hint ?? null,
      environment: stage.environment ?? input.environment ?? null,
      depends_on: prevId,
      pipeline_id: pipelineId,
      stage_name: stage.name,
    });
    children.push(child);
    prevId = child.id;
  }

  const [first] = children;
  if (first) {
    if (validateTask(first).ok) {
      setStatus(db, first.id, 'queued', { detail: `auto-queued: first stage of pipeline '${def.name}'` });
    } // else stays draft; gate errors are visible on the board (mirrors materializePlan)
    logEvent(db, {
      task_id: first.id,
      kind: 'note',
      detail: `pipeline '${def.name}' instantiated (${pipelineId}): ${children.map((c) => c.id).join(', ')}`,
    });
  }
  return children;
}
