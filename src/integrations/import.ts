import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getNum } from '../db/index.js';
import { createTask, getTask, getTaskBySourceRef, countByStatus, setStatus } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import type { Task } from '../types.js';
import { buildSourceRef } from './sourceRef.js';
import type { WorkItem, WorkProvider } from './types.js';

export interface ImportOptions {
  repo_path?: string | null;
  base_branch?: string | null;
  verification_steps?: string[];
}

export interface ImportResult {
  created: Task[];
  skipped: string[]; // source_refs that already had a task (idempotent re-import)
}

/** One shared plan file per imported item, synthesized from its body — same idiom as
 * pipeline/materialize.ts's writeSharedPlan (a gate-required plan_ref for every task). */
function writeItemPlan(item: WorkItem): string {
  fs.mkdirSync(paths.plansDir, { recursive: true });
  const stamp = process.hrtime.bigint().toString(36);
  const planPath = path.join(paths.plansDir, `import-${stamp}.md`);
  fs.writeFileSync(
    planPath,
    `# ${item.title || '(untitled)'}\n\n${item.body?.trim() || '(no description)'}\n\n> imported from ${item.url || item.id}\n`,
  );
  return planPath;
}

/**
 * Pull WorkItems from `provider` and materialize each as a Loop task, skipping any whose
 * `source_ref` already exists (idempotent — safe to re-run the same query). Created tasks
 * are auto-queued up to `max_autoqueue` (gate permitting), same headroom the MCP's
 * auto-queue path respects; the rest stay draft for manual queueing.
 */
export async function importWorkItems(
  db: Database.Database,
  provider: WorkProvider,
  query: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const items = await provider.listWorkItems(query);
  const created: Task[] = [];
  const skipped: string[] = [];
  const maxAutoqueue = getNum(db, 'max_autoqueue', 3);

  for (const item of items) {
    const sourceRef = buildSourceRef(provider.name, item);
    if (getTaskBySourceRef(db, sourceRef)) {
      skipped.push(sourceRef);
      continue;
    }

    const planPath = writeItemPlan(item);
    let task = createTask(db, {
      title: item.title?.trim() || sourceRef,
      goal: item.body?.trim() || item.title?.trim() || sourceRef,
      plan_ref: planPath,
      plan_kind: 'md',
      repo_path: opts.repo_path ?? null,
      base_branch: opts.base_branch ?? null,
      verification_steps: opts.verification_steps ?? [],
      source_ref: sourceRef,
    });

    const counts = countByStatus(db);
    const active = (counts.queued ?? 0) + (counts.running ?? 0);
    if (active < maxAutoqueue && validateTask(task).ok) {
      setStatus(db, task.id, 'queued', { detail: `auto-queued from ${sourceRef}` });
      task = getTask(db, task.id)!;
    }
    created.push(task);
  }

  return { created, skipped };
}
