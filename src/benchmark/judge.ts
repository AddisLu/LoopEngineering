import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import { readUsage } from '../token/usage.js';
import type { Benchmark } from './store.js';

/**
 * Comparative judge for a benchmark: one external high-tier model (bench_judge_model, default
 * opus) reads every arm's verification outcome + capped diff and scores them on four criteria.
 * Arms are anonymised (Arm A/B/…) so the judge can't favour a model name, and the ranking is
 * computed here from the scores — the LLM supplies judgement, never the arithmetic.
 */

export const CRITERIA = ['correctness', 'completeness', 'code_quality', 'adherence'] as const;
export type Criterion = (typeof CRITERIA)[number];

export type BenchJudgeExec = (prompt: string, model: string) => Promise<string>;

export interface ArmEvidence {
  model: string;
  verify_outcome: 'pass' | 'manual' | 'fail';
  failure: string | null;
  diff_stat: string;
  diff: string;
  tokens_out: number | null;
  duration_s: number | null;
}

export interface ArmJudgement {
  model: string;
  label: string;
  scores: Record<Criterion, number>;
  total: number;
  rank: number;
  notes: string;
}

export type BenchJudgeResult =
  | { ok: true; arms: ArmJudgement[]; winner: string | null; summary: string; judge_winner_label: string | null }
  | { ok: false; error: string };

const PLAN_CAP = 4000;
const label = (i: number): string => String.fromCharCode(65 + i);

let claudeCli: boolean | null = null;
export function hasClaudeCli(): boolean {
  if (claudeCli === null) {
    try {
      execFileSync('which', ['claude'], { stdio: 'ignore' });
      claudeCli = true;
    } catch {
      claudeCli = false;
    }
  }
  return claudeCli;
}

function stripFences(s: string): string {
  const t = s.trim();
  return t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? t;
}

function planExcerpt(ref: string | null): string {
  if (!ref) return '(no plan attached)';
  if (/^https?:\/\//i.test(ref)) return `See plan at: ${ref}`;
  try {
    const text = fs.readFileSync(ref, 'utf8');
    return text.length > PLAN_CAP ? `${text.slice(0, PLAN_CAP)}\n...(truncated)` : text;
  } catch {
    return `(could not read plan file: ${ref})`;
  }
}

function verifyLine(a: ArmEvidence): string {
  if (a.verify_outcome === 'pass') return 'PASSED — every verification step exited 0';
  if (a.verify_outcome === 'manual') return 'NOT AUTO-VERIFIED (manual verification required)';
  return `FAILED${a.failure ? ` — ${a.failure}` : ''}`;
}

export function buildBenchPrompt(bench: Benchmark, arms: ArmEvidence[]): string {
  let steps: string[] = [];
  try {
    steps = JSON.parse(bench.verification_steps);
  } catch {
    /* ignore */
  }
  const armBlocks = arms
    .map(
      (a, i) => `## Arm ${label(i)}
- Verification: ${verifyLine(a)}
- Diffstat:
${a.diff_stat.trim() || '(empty)'}
- Diff against the base branch:
\`\`\`diff
${a.diff.trim() || '(no changes)'}
\`\`\``,
    )
    .join('\n\n');

  return `You are a senior engineer comparing ${arms.length} independent implementations of the SAME task.
Each arm was produced by a different coding model; the arms are anonymised. Judge each arm on its own merits.

# Task: ${bench.title}
Domain: ${bench.domain}

## Goal
${bench.goal}

## Plan / spec
${planExcerpt(bench.plan_ref)}

## Acceptance criteria
${bench.verify_rubric?.trim() || '(none provided — judge against the goal and plan)'}

## Verification steps every arm had to pass
${steps.map((s) => `- \`${s}\``).join('\n') || '- (none)'}

${armBlocks}

## Scoring
Score every arm 0-10 on each criterion:
- correctness: the code does what the goal requires and would hold up beyond the given checks. A FAILED verification caps correctness at 4.
- completeness: every requirement in the goal, plan and acceptance criteria is covered.
- code_quality: readable, idiomatic for the domain, sensible structure, no hacks or dead code.
- adherence: follows the plan, stays in scope, no unrelated edits; deleting or weakening tests, or replacing an efficient implementation with a slower one just to pass, must score low.

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"arms":[{"arm":"A","scores":{"correctness":0,"completeness":0,"code_quality":0,"adherence":0},"notes":"one or two sentences"}],"winner":"A","summary":"2-4 sentences comparing the arms"}`;
}

const VERIFY_ORDER = { pass: 0, manual: 1, fail: 2 } as const;

export function parseBenchJudgement(text: string, arms: ArmEvidence[]): BenchJudgeResult {
  let parsed: any;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return { ok: false, error: `unparseable judge output: ${text.slice(-300)}` };
  }
  const list: any[] = Array.isArray(parsed?.arms) ? parsed.arms : [];
  const judged: ArmJudgement[] = [];
  for (let i = 0; i < arms.length; i++) {
    const lbl = label(i);
    const row = list.find((r) => String(r?.arm ?? '').trim().toUpperCase() === lbl);
    if (!row) return { ok: false, error: `judge output is missing Arm ${lbl}` };
    const scores = {} as Record<Criterion, number>;
    for (const c of CRITERIA) {
      const v = Number(row?.scores?.[c]);
      if (!Number.isFinite(v)) return { ok: false, error: `Arm ${lbl}: missing/invalid score '${c}'` };
      scores[c] = Math.max(0, Math.min(10, v));
    }
    const total = Math.round((CRITERIA.reduce((s, c) => s + scores[c], 0) / CRITERIA.length) * 10) / 10;
    judged.push({ model: arms[i]!.model, label: lbl, scores, total, rank: 0, notes: String(row?.notes ?? '').slice(0, 1000) });
  }
  // Rank from the scores: total desc -> verification outcome -> fewer output tokens.
  const order = judged
    .map((j, i) => ({ j, e: arms[i]! }))
    .sort(
      (x, y) =>
        y.j.total - x.j.total ||
        VERIFY_ORDER[x.e.verify_outcome] - VERIFY_ORDER[y.e.verify_outcome] ||
        (x.e.tokens_out ?? Number.MAX_SAFE_INTEGER) - (y.e.tokens_out ?? Number.MAX_SAFE_INTEGER),
    );
  order.forEach((o, i) => (o.j.rank = i + 1));
  const top = order[0]?.j;
  const judgeWinner = typeof parsed?.winner === 'string' ? parsed.winner.trim().toUpperCase() : null;
  return {
    ok: true,
    arms: judged,
    winner: top && top.total > 0 ? top.model : null,
    summary: String(parsed?.summary ?? '').slice(0, 2000),
    judge_winner_label: judgeWinner,
  };
}

/**
 * Real call: `claude -p` with the prompt on stdin (diffs can exceed the 128 KB argv limit),
 * neutral cwd. Exported so 請雲端複核 (src/chat/escalate.ts) runs through the identical path.
 */
export function claudePromptExec(timeoutMs: number): BenchJudgeExec {
  return (prompt, model) =>
    new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', '--model', model, '--output-format', 'text'], {
        cwd: os.tmpdir(), // don't let a repo's CLAUDE.md/settings leak into the judge's context
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`judge timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        // claude -p reports some failures on stdout, not stderr — keep whichever has text
        else reject(new Error(`claude exited ${code}: ${(err.trim() || out.trim() || '(no output)').slice(-300)}`));
      });
      child.stdin.end(prompt);
    });
}

/**
 * Guarded like the other LLM call sites: never spends over the usage hard limit, and without
 * an injected exec requires the `claude` CLI. Never throws.
 */
export async function runBenchJudge(
  db: Database.Database,
  bench: Benchmark,
  arms: ArmEvidence[],
  exec?: BenchJudgeExec,
): Promise<BenchJudgeResult> {
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  const usage = readUsage().session.percent;
  if (usage >= hardLimit) return { ok: false, error: `usage ${usage}% >= hard limit ${hardLimit}% — judge postponed` };
  if (!exec && !hasClaudeCli()) return { ok: false, error: 'claude CLI not found on PATH' };
  const run = exec ?? claudePromptExec(getNum(db, 'bench_judge_timeout_ms', 600_000));
  try {
    return parseBenchJudgement(await run(buildBenchPrompt(bench, arms), bench.judge_model), arms);
  } catch (err) {
    return { ok: false, error: `judge call failed: ${String(err).slice(-300)}` };
  }
}
