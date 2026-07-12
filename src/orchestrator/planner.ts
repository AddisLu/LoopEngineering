import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getNum, getBool, getSetting, logEvent } from '../db/index.js';
import { paths } from '../config.js';
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
// SDD Phase 2: cap an inline per-child spec so a chatty model can't bloat one plan file /
// blow the strict-JSON parse. 8k chars is ample for a self-contained subtask spec.
const SPEC_MAX = 8000;

export interface PlannedSubtask {
  title: string;
  goal: string;
  verify_steps: string[];
  complexity: Complexity;
  verify_mode?: string;
  requires?: string;
  order: number;
  spec?: string; // SDD Phase 2: self-contained markdown spec for THIS subtask (sdd_specs on)
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

function buildPrompt(epic: Task, knowledge: string | null, sddSpecs = false): string {
  const parts = [`# Epic\n${epic.title}`, `## Goal\n${epic.goal}`];
  const brief = readPlanBrief(epic);
  if (brief) parts.push(`## Plan brief\n${brief}`);
  if (knowledge) parts.push(`## Knowledge / Environment\n${knowledge}`);
  // SDD Phase 2 (sdd_specs on): ask for a self-contained spec per child so a CHEAPER
  // implementation model can do it reliably. Flag off -> the exact original instruction
  // string (byte-identical prompt, so planner behavior/calibration is unchanged).
  parts.push(
    sddSpecs
      ? '把這個目標拆成 2–6 個具體、可獨立驗證的子任務，彼此若有先後用 order 表示。\n' +
          '每個子任務都要附一份自足規格 spec（Markdown）：讓一個沒有其他背景的實作者只讀這份 spec 就能正確完成。spec 必須包含：\n' +
          '- 背景與目的（為什麼要做、屬於整體的哪一塊）\n' +
          '- 驗收情境（Given/When/Then 或可觀察行為的條列）\n' +
          '- 限制與不可違反的約束（沿用整體計畫與 Knowledge/Environment）\n' +
          '- 明確的 out-of-scope（這個子任務「不」碰什麼，避免範疇擴張）\n' +
          'Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:\n' +
          '{"subtasks":[{"title":"...","goal":"...","spec":"<self-contained markdown spec>","verify_steps":["..."],"complexity":"S|M|L",' +
          '"verify_mode":"command|llm|manual (optional)","requires":"csv tokens (optional)","order":n}]}'
      : '把這個目標拆成 2–6 個具體、可獨立驗證的子任務，彼此若有先後用 order 表示。\n' +
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
    // SDD Phase 2: tolerant — undefined when absent (flag off never emits it), capped so a
    // runaway spec can't bloat the plan file. materializePlan decides whether to persist it.
    const spec = typeof o.spec === 'string' && o.spec.trim() ? o.spec.trim().slice(0, SPEC_MAX) : undefined;
    items.push({ title, goal, verify_steps, complexity, verify_mode, requires, order, spec });
  });
  return items.length ? items : null;
}

/**
 * Create one child task per planned subtask: parent_id=epic.id, chained by ascending
 * `order` via depends_on (first has none), inheriting repo_path/base_branch/environment/
 * model from the epic.
 *
 * plan_ref: by default each child inherits the epic's brief (plan_ref is gate-required for
 * every coding_tool, so without it no child could ever pass the gate). With SDD Phase 2
 * (opts.writeSpecs) AND an inline `st.spec`, the child instead gets its OWN self-contained
 * spec written under paths.plansDir — the whole point of SDD: each child is independently
 * specified so a cheaper model can implement it. Falls back to the epic brief per-child when
 * a spec is missing, so a partial planner response never produces a gate-breaking null ref.
 *
 * The first child is queued immediately (gate permitting); the rest stay draft and are
 * released one at a time by tick.ts's dep_auto_queue as each dependency closes. Logs a
 * materialization note on the epic.
 */
export function materializePlan(
  db: Database.Database,
  epic: Task,
  subtasks: PlannedSubtask[],
  opts: { writeSpecs?: boolean } = {},
): Task[] {
  const ordered = [...subtasks].sort((a, b) => a.order - b.order);
  const children: Task[] = [];
  let prevId: string | null = null;
  for (const st of ordered) {
    let plan_ref = epic.plan_ref;
    let plan_kind = epic.plan_kind;
    if (opts.writeSpecs && st.spec) {
      // Same file-writing idiom as mergeTask.ts: plansDir + an hrtime stamp (no Date.now()
      // so tests stay deterministic). The child's ## Plan section is now its own spec.
      fs.mkdirSync(paths.plansDir, { recursive: true });
      const stamp = process.hrtime.bigint().toString(36);
      const specPath = path.join(paths.plansDir, `spec-${epic.id}-${st.order}-${stamp}.md`);
      fs.writeFileSync(specPath, st.spec);
      plan_ref = specPath;
      plan_kind = 'md';
    }
    const child = createTask(db, {
      title: st.title,
      goal: st.goal,
      plan_ref,
      plan_kind,
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

  const sddSpecs = getBool(db, 'sdd_specs', false);
  const run: PlannerExec = exec ?? ((prompt) => defaultExec(prompt, getSetting(db, 'default_model') || 'sonnet'));
  try {
    const knowledge = knowledgeContext(db, task);
    const out = await run(buildPrompt(task, knowledge, sddSpecs));
    if (!out) return null;
    const subtasks = parsePlan(out);
    if (!subtasks) return null;
    return materializePlan(db, task, subtasks, { writeSpecs: sddSpecs });
  } catch {
    return null;
  }
}
