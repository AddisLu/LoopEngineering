import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getNum, getSetting, logEvent } from '../db/index.js';
import { readUsage } from '../token/usage.js';
import { createTask, setStatus } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { knowledgeContext } from '../knowledge/context.js';
import type { Complexity } from '../config.js';
import type { Task } from '../types.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 3 * 60_000;
const MAX_SUBTASKS = 6;
const TITLE_MAX = 160;
const GOAL_MAX = 2000;

export interface PlannedSubtask {
  title: string;
  goal: string;
  verify_steps: string[];
  complexity: Complexity;
  verify_mode?: string;
  requires?: string;
  order: number;
}

export type PlannerExec = (prompt: string) => Promise<string | null>;

function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

/** The epic brief: plan_ref's file content when it's a local .md/.html, else a URL stub. */
function readPlanBrief(task: Task): string {
  const ref = task.plan_ref?.trim();
  if (!ref) return '';
  if (/^https?:\/\//i.test(ref)) return `(plan URL: ${ref})`;
  try {
    return fs.readFileSync(ref, 'utf8').trim();
  } catch {
    return '';
  }
}

function buildPrompt(epic: Task, knowledge: string | null): string {
  const parts = [`# Epic\n${epic.title}`, `## Goal\n${epic.goal}`];
  const brief = readPlanBrief(epic);
  if (brief) parts.push(`## Plan brief\n${brief}`);
  if (knowledge) parts.push(`## Knowledge / Environment\n${knowledge}`);
  parts.push(
    '把這個目標拆成 2–6 個具體、可獨立驗證的子任務，彼此若有先後用 order 表示。\n' +
      'Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:\n' +
      '{"subtasks":[{"title":"...","goal":"...","verify_steps":["..."],"complexity":"S|M|L",' +
      '"verify_mode":"command|llm|manual (optional)","requires":"csv tokens (optional)","order":n}]}',
  );
  return parts.join('\n\n');
}

const VALID_COMPLEXITY = new Set<Complexity>(['S', 'M', 'L']);

/**
 * Strict-JSON parse + validation of a planner response: bad shape/JSON -> null; per-item
 * title/goal required (invalid item dropped), verify_steps/complexity/verify_mode/requires
 * defaulted or clamped, order defaults to array position. Cap MAX_SUBTASKS (clamped, not
 * rejected — mirrors distill.ts's parseDistillerOutput). Returns null when every item was
 * dropped, never throws.
 */
export function parsePlan(text: string): PlannedSubtask[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { subtasks?: unknown }).subtasks)) {
    return null;
  }

  const items: PlannedSubtask[] = [];
  const raw = (parsed as { subtasks: unknown[] }).subtasks.slice(0, MAX_SUBTASKS);
  raw.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const o = r as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, TITLE_MAX) : '';
    const goal = typeof o.goal === 'string' ? o.goal.trim().slice(0, GOAL_MAX) : '';
    if (!title || !goal) return;
    const verify_steps = Array.isArray(o.verify_steps)
      ? o.verify_steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
      : [];
    const complexity = VALID_COMPLEXITY.has(o.complexity as Complexity) ? (o.complexity as Complexity) : 'M';
    const verify_mode = typeof o.verify_mode === 'string' && o.verify_mode.trim() ? o.verify_mode.trim() : undefined;
    const requires = typeof o.requires === 'string' && o.requires.trim() ? o.requires.trim() : undefined;
    const order = typeof o.order === 'number' && Number.isFinite(o.order) ? o.order : i + 1;
    items.push({ title, goal, verify_steps, complexity, verify_mode, requires, order });
  });
  return items.length ? items : null;
}

/**
 * Create one child task per planned subtask: parent_id=epic.id, chained by ascending
 * `order` via depends_on (first has none), inheriting repo_path/base_branch/environment/
 * model from the epic. plan_ref/plan_kind are ALSO inherited from the epic even though the
 * design only calls out repo/base/env/model — plan_ref is gate-required for every
 * coding_tool, so without it no child could ever pass the gate; the epic brief doubles as
 * the shared plan reference for its children. The first child is queued immediately (gate
 * permitting); the rest stay draft and are released one at a time by tick.ts's
 * dep_auto_queue as each dependency closes. Logs a materialization note on the epic.
 */
export function materializePlan(db: Database.Database, epic: Task, subtasks: PlannedSubtask[]): Task[] {
  const ordered = [...subtasks].sort((a, b) => a.order - b.order);
  const children: Task[] = [];
  let prevId: string | null = null;
  for (const st of ordered) {
    const child = createTask(db, {
      title: st.title,
      goal: st.goal,
      plan_ref: epic.plan_ref,
      plan_kind: epic.plan_kind,
      coding_tool: 'claude-code',
      verification_steps: st.verify_steps,
      repo_path: epic.repo_path,
      base_branch: epic.base_branch,
      environment: epic.environment,
      model: epic.model,
      complexity: st.complexity,
      depends_on: prevId,
      verify_mode: st.verify_mode ?? null,
      requires: st.requires ?? null,
      parent_id: epic.id,
    });
    children.push(child);
    prevId = child.id;
  }

  const [first] = children;
  if (first) {
    if (validateTask(first).ok) {
      setStatus(db, first.id, 'queued', { detail: 'auto-queued: first subtask of epic plan' });
    } // else stays draft; gate errors are visible on the board (mirrors dep_auto_queue)
    logEvent(db, {
      task_id: epic.id,
      kind: 'note',
      detail: `materialized ${children.length} subtask(s): ${children.map((c) => c.id).join(', ')}`,
    });
  }
  return children;
}

/**
 * Real one-shot planning call: `claude -p <prompt> --model <default_model|sonnet>
 * --output-format text` — planning benefits from a stronger model than haiku, so this
 * uses the board-wide default_model instead of the distiller's fixed 'haiku'. 3-minute
 * hard timeout via the async execFile (never blocks the event loop). Any failure -> null.
 */
async function defaultExec(prompt: string, model: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', model, '--output-format', 'text'],
      { timeout: TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Guarded planner pass for an epic (coding_tool='plan') task: builds the decomposition
 * prompt (goal + plan brief + knowledge context), calls `exec`, strict-JSON parses the
 * result, and materializes the child chain. Skips (resolves null) for a mock task or when
 * session usage is already at/over the hard limit — mirrors distill.ts's guard style.
 * `exec` is injectable so tests never spawn a real process (zero tokens/network).
 */
export async function runPlanner(
  db: Database.Database,
  task: Task,
  exec?: PlannerExec,
): Promise<Task[] | null> {
  if (task.coding_tool === 'mock') return null;
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  if (readUsage().session.percent >= hardLimit) return null;

  const run: PlannerExec = exec ?? ((prompt) => defaultExec(prompt, getSetting(db, 'default_model') || 'sonnet'));
  try {
    const knowledge = knowledgeContext(db, task);
    const out = await run(buildPrompt(task, knowledge));
    if (!out) return null;
    const subtasks = parsePlan(out);
    if (!subtasks) return null;
    return materializePlan(db, task, subtasks);
  } catch {
    return null;
  }
}
