import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getNum, getSetting } from '../db/index.js';
import { readUsage } from '../token/usage.js';
import type { Complexity } from '../config.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 3 * 60_000;
const TITLE_MAX = 160;
const GOAL_MAX = 2000;

export type TaskType = 'coding' | 'scheduled' | 'generic' | 'unknown';

export interface ClarifyItem {
  field: string;
  question: string;
  options?: string[];
}

export interface TaskFields {
  title: string;
  goal: string;
  verify_steps: string[];
  repo_path: string;
  environment: string;
  coding_tool: string;
  complexity: Complexity;
  /** Best-effort classification so the client can warn before creating a non-coding task. */
  task_type: TaskType;
  /** Key fields the model couldn't confidently fill in (e.g. "repo_path", "verify_steps"). */
  missing: string[];
  /** One follow-up per missing/ambiguous field, options are tap-to-answer choices. */
  clarify: ClarifyItem[];
}

export type StructureExec = (prompt: string) => Promise<string | null>;

const VALID_COMPLEXITY = new Set<Complexity>(['S', 'M', 'L']);
const VALID_TASK_TYPE = new Set<TaskType>(['coding', 'scheduled', 'generic', 'unknown']);

function hasClaudeCli(): boolean {
  try {
    execFileSync('which', ['claude'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

function buildPrompt(transcript: string): string {
  return `這是一段語音轉文字的原始逐字稿，可能中英文夾雜、有口語停頓與贅字。
把它清理、抽成一個精簡可執行的 task。未提到的欄位留空字串（repo_path/environment）
或用合理預設（coding_tool 預設 "claude-code", complexity 預設 "M"）；沒講到驗收方式
就讓 verify_steps 是空陣列。

另外判斷：
- task_type：這是不是一個可執行的 repo coding 任務？"coding"（要改 code、有 repo）、
  "scheduled"（提醒/排程類事項）、"generic"（非 coding 的一次性產出）或講不清楚時
  "unknown"。
- missing：使用者沒講清楚、你沒把握填的關鍵欄位名稱陣列（例如 "repo_path",
  "verify_steps"）；能合理預設的欄位不算 missing。
- clarify：針對每個 missing 欄位，給一個精簡的追問，若適合用選項回答就附上
  2-4 個可點選項（options）。

## 逐字稿
${transcript}

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"title":"...","goal":"...","verify_steps":["..."],"repo_path":"...","environment":"...",
"coding_tool":"...","complexity":"S|M|L","task_type":"coding|scheduled|generic|unknown",
"missing":["..."],"clarify":[{"field":"...","question":"...","options":["..."]}]}`;
}

function parseClarifyItem(v: unknown): ClarifyItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const field = typeof o.field === 'string' ? o.field.trim() : '';
  const question = typeof o.question === 'string' ? o.question.trim() : '';
  if (!field || !question) return null;
  const options = Array.isArray(o.options)
    ? o.options.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : undefined;
  return options && options.length ? { field, question, options } : { field, question };
}

/**
 * Strict-JSON parse + validation of a structure response: bad shape/JSON, or a missing
 * title/goal -> null (mirrors planner.ts's parsePlan). Every other field is defaulted/
 * clamped rather than rejected.
 */
export function parseStructured(text: string): TaskFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, TITLE_MAX) : '';
  const goal = typeof o.goal === 'string' ? o.goal.trim().slice(0, GOAL_MAX) : '';
  if (!title || !goal) return null;
  const verify_steps = Array.isArray(o.verify_steps)
    ? o.verify_steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : [];
  const repo_path = typeof o.repo_path === 'string' ? o.repo_path.trim() : '';
  const environment = typeof o.environment === 'string' ? o.environment.trim() : '';
  const coding_tool = typeof o.coding_tool === 'string' && o.coding_tool.trim() ? o.coding_tool.trim() : 'claude-code';
  const complexity = VALID_COMPLEXITY.has(o.complexity as Complexity) ? (o.complexity as Complexity) : 'M';
  const task_type = VALID_TASK_TYPE.has(o.task_type as TaskType) ? (o.task_type as TaskType) : 'unknown';
  const missing = Array.isArray(o.missing)
    ? o.missing.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : [];
  const clarify = Array.isArray(o.clarify)
    ? o.clarify.map(parseClarifyItem).filter((c): c is ClarifyItem => c !== null)
    : [];
  return { title, goal, verify_steps, repo_path, environment, coding_tool, complexity, task_type, missing, clarify };
}

/** Real one-shot call: `claude -p <prompt> --model <default_model|sonnet> --output-format text`. */
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
 * Clean a messy voice transcript into structured task fields. Guarded so it never runs
 * for real when it can't: no `claude` CLI, or session usage already at/over the hard
 * limit -> null (mirrors judge.ts/planner.ts). `exec` is injectable for zero-token tests.
 */
export async function structureTranscript(
  db: Database.Database,
  transcript: string,
  exec?: StructureExec,
): Promise<TaskFields | null> {
  if (!hasClaudeCli()) return null;
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  if (readUsage().session.percent >= hardLimit) return null;

  const run: StructureExec = exec ?? ((prompt) => defaultExec(prompt, getSetting(db, 'voice_structure_model') || 'haiku'));
  try {
    const out = await run(buildPrompt(transcript));
    if (!out) return null;
    return parseStructured(out);
  } catch {
    return null;
  }
}
