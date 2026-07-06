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

export interface TaskFields {
  title: string;
  goal: string;
  verify_steps: string[];
  repo_path: string;
  environment: string;
  coding_tool: string;
  complexity: Complexity;
}

export type StructureExec = (prompt: string) => Promise<string | null>;

const VALID_COMPLEXITY = new Set<Complexity>(['S', 'M', 'L']);

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

## 逐字稿
${transcript}

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"title":"...","goal":"...","verify_steps":["..."],"repo_path":"...","environment":"...","coding_tool":"...","complexity":"S|M|L"}`;
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
  return { title, goal, verify_steps, repo_path, environment, coding_tool, complexity };
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

  const run: StructureExec = exec ?? ((prompt) => defaultExec(prompt, getSetting(db, 'default_model') || 'sonnet'));
  try {
    const out = await run(buildPrompt(transcript));
    if (!out) return null;
    return parseStructured(out);
  } catch {
    return null;
  }
}
