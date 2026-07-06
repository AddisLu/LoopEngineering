import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getNum, getSetting } from '../db/index.js';
import { readUsage } from '../token/usage.js';
import type { Task } from '../types.js';
import { buildFileListing } from './outputFiles.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 5 * 60_000;
const DIFF_CAP = 12_000;

export type JudgeExec = (prompt: string, cwd: string) => Promise<string>;

/** `pass: null` means inconclusive (never treated as an auto-pass) — see runLlmJudge's guards. */
export interface JudgeResult {
  pass: boolean | null;
  reason: string;
}

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

/** Bounded `git diff <base>...HEAD` for the judge prompt; best-effort (mock/no-repo tasks get a stub). */
function gitDiff(cwd: string, base: string): string {
  try {
    const out = execFileSync('git', ['diff', `${base}...HEAD`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return out.length > DIFF_CAP ? `${out.slice(0, DIFF_CAP)}\n...(truncated)` : out;
  } catch {
    return '(diff unavailable)';
  }
}

function buildPrompt(task: Task, cwd: string, base: string | null): string {
  // base===null means a repo-less (generic) task: judge the output files instead of a
  // git diff. A mock task never reaches here (runLlmJudge returns early for it above).
  const diff = base === null ? buildFileListing(cwd) : gitDiff(cwd, base);
  return `You are judging whether a completed task meets its acceptance criteria.

## Goal
${task.goal}

## Acceptance criteria (rubric)
${task.verify_rubric?.trim() || '(none provided — judge against the goal alone)'}

## Change to judge (${base === null ? 'output files' : 'git diff'})
${diff}

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"pass": true|false, "reason": "..."}`;
}

/** Real one-shot judge call, mirrors knowledge/distill.ts's defaultExec (execFile, 5-minute hard timeout). */
async function defaultExec(prompt: string, cwd: string, model: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--model', model, '--output-format', 'text'],
    { cwd, timeout: TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

function parseJudgeOutput(text: string): JudgeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return { pass: null, reason: `unparseable/failed: ${text.slice(-300)}` };
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { pass?: unknown }).pass !== 'boolean') {
    return { pass: null, reason: `unparseable/failed: ${text.slice(-300)}` };
  }
  const p = parsed as { pass: boolean; reason?: unknown };
  return { pass: p.pass, reason: typeof p.reason === 'string' ? p.reason : '' };
}

/**
 * Run an LLM judge pass over a task's change against its goal/rubric. Guarded so it
 * NEVER auto-passes when it can't run for real: mock tool, no `claude` CLI, or session
 * usage already at/over the hard limit all resolve to {pass:null} (inconclusive — the
 * caller routes that to a manual review gate). `exec` is injectable for zero-token tests.
 */
export async function runLlmJudge(
  db: Database.Database,
  task: Task,
  workdir: string,
  base: string | null,
  exec?: JudgeExec,
): Promise<JudgeResult> {
  if (task.coding_tool === 'mock') return { pass: null, reason: 'skipped' };
  if (!hasClaudeCli()) return { pass: null, reason: 'skipped' };
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  if (readUsage().session.percent >= hardLimit) return { pass: null, reason: 'skipped' };

  const run: JudgeExec = exec ?? ((prompt, cwd) => defaultExec(prompt, cwd, getSetting(db, 'llm_judge_model') || 'haiku'));
  try {
    const out = await run(buildPrompt(task, workdir, base), workdir);
    return parseJudgeOutput(out);
  } catch (err) {
    return { pass: null, reason: `unparseable/failed: ${String(err).slice(-300)}` };
  }
}
