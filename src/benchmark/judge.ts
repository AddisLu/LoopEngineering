import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import { localPrompt } from '../local/backend.js';
import { readUsage } from '../token/usage.js';
import type { Benchmark } from './store.js';
import type { FinalMeasurement, IterationSummary } from './attempts.js';

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
  /** what the ranking goes by: the final re-measurement when there is one, else the arm's own verification */
  verify_outcome: 'pass' | 'manual' | 'fail';
  failure: string | null;
  diff_stat: string;
  diff: string;
  tokens_out: number | null;
  duration_s: number | null;
  /** the arm's own verification, before the final re-measurement */
  own_outcome?: 'pass' | 'manual' | 'fail';
  /** attempt by attempt: what failed, what was measured, whether it profiled */
  iterations?: IterationSummary | null;
  /** its final code measured again, one arm at a time, when judged */
  final?: FinalMeasurement | null;
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
  const own = a.own_outcome ?? a.verify_outcome;
  if (own === 'pass') return 'PASSED — every verification step exited 0';
  if (own === 'manual') return 'NOT AUTO-VERIFIED (manual verification required)';
  return `FAILED${a.failure ? ` — ${a.failure}` : ''}`;
}

const metricList = (m: Record<string, number | string> | null | undefined) =>
  m ? Object.entries(m).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`).join(', ') : '';

const ATTEMPT_EN: Record<string, string> = {
  pass: 'passed',
  functional: 'a step failed',
  metrics: 'function right, thresholds missed',
  protected: 'changed the protected yardstick',
  unverified: 'ended before verification',
};

/** The measured facts about one arm, in the prompt's language. */
function measuredLines(a: ArmEvidence): string {
  const lines: string[] = [];
  if (a.final) {
    const verdict = a.final.outcome === 'pass' ? 'PASSED' : `FAILED (${ATTEMPT_EN[a.final.outcome] ?? a.final.outcome}${a.final.failed_step ? `: ${a.final.failed_step}` : ''})`;
    lines.push(`- Final re-measurement (every arm's final code, same machine, one arm at a time): ${verdict}${a.final.metrics ? ` — ${metricList(a.final.metrics)}` : ''}`);
  }
  const it = a.iterations;
  if (it?.attempts.length) {
    const steps = it.attempts
      .map((t) => `${t.attempt}) ${ATTEMPT_EN[t.outcome] ?? t.outcome}${t.metrics ? ` [${metricList(t.metrics)}]` : ''}`)
      .join(' → ');
    lines.push(`- Its own verification attempts (the engine sends a failure back to the model): ${steps}`);
    lines.push(`- While working it ran code in the GPU sandbox ${it.self_runs} time(s); used a profiler (ncu/nsys): ${it.profiler ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

export function buildBenchPrompt(bench: Benchmark, arms: ArmEvidence[]): string {
  let steps: string[] = [];
  try {
    steps = JSON.parse(bench.verification_steps);
  } catch {
    /* ignore */
  }
  const measured = arms.some((a) => a.final || a.iterations?.attempts.some((t) => t.metrics));
  const armBlocks = arms
    .map(
      (a, i) => `## Arm ${label(i)}
- Verification: ${verifyLine(a)}${measuredLines(a) ? `\n${measuredLines(a)}` : ''}
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
${bench.acceptance_metrics?.trim() ? `\n## Engine-checked thresholds every arm had to meet\n${bench.acceptance_metrics.trim()}\n` : ''}
${armBlocks}

## Scoring
${measured ? 'The measurements above were taken by the engine, not reported by the models. An arm that FAILED the final re-measurement ranks below every arm that passed whatever its scores (the ranking enforces this); among arms that passed, better measured results within the bar count toward correctness and completeness.\n' : ''}Score every arm 0-10 on each criterion:
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
  // Rank: verification outcome first (an arm that failed never outranks one that passed), then
  // the score, then fewer output tokens.
  const order = judged
    .map((j, i) => ({ j, e: arms[i]! }))
    .sort(
      (x, y) =>
        VERIFY_ORDER[x.e.verify_outcome] - VERIFY_ORDER[y.e.verify_outcome] ||
        y.j.total - x.j.total ||
        (x.e.tokens_out ?? Number.MAX_SAFE_INTEGER) - (y.e.tokens_out ?? Number.MAX_SAFE_INTEGER),
    );
  order.forEach((o, i) => (o.j.rank = i + 1));
  const top = order[0];
  const judgeWinner = typeof parsed?.winner === 'string' ? parsed.winner.trim().toUpperCase() : null;
  return {
    ok: true,
    arms: judged,
    // nobody wins a benchmark nobody passed
    winner: top && top.j.total > 0 && top.e.verify_outcome !== 'fail' ? top.j.model : null,
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
  judgeModel: string = bench.judge_model,
): Promise<BenchJudgeResult> {
  // a local:<id> judge (公司模式) is the served model through chatLocal: no CLI, no usage guard
  const localJudge = !exec && judgeModel.startsWith('local:');
  if (!localJudge) {
    const hardLimit = getNum(db, 'hard_limit_pct', 95);
    const usage = readUsage().session.percent;
    if (usage >= hardLimit) return { ok: false, error: `usage ${usage}% >= hard limit ${hardLimit}% — judge postponed` };
    if (!exec && !hasClaudeCli()) return { ok: false, error: 'claude CLI not found on PATH' };
  }
  const run: BenchJudgeExec =
    exec ??
    (localJudge
      ? async (prompt) => {
          const out = await localPrompt(db, prompt, { maxTokens: 4096 });
          if (out === null) throw new Error('local judge: the served model did not answer');
          return out;
        }
      : claudePromptExec(getNum(db, 'bench_judge_timeout_ms', 600_000)));
  try {
    return parseBenchJudgement(await run(buildBenchPrompt(bench, arms), judgeModel), arms);
  } catch (err) {
    return { ok: false, error: `judge call failed: ${String(err).slice(-300)}` };
  }
}

export interface AggregatedArm {
  model: string;
  /** per-judge totals plus the mean the arms table shows */
  per_judge: Record<string, { scores: Record<Criterion, number>; total: number; rank: number; notes: string }>;
  mean: Record<Criterion, number> & { total: number };
  rank: number;
}

export interface Aggregated {
  arms: AggregatedArm[];
  winner: string | null;
  consensus: 'unanimous' | 'split' | 'single';
  summary: string;
}

/**
 * Several judges, one verdict: each arm's criterion scores are averaged across the judges that
 * answered, ranks are recomputed from the mean (same tie-breaks as a single judge), and the
 * consensus says whether every judge put the same arm first.
 */
export function aggregateJudgements(per: Map<string, BenchJudgeResult>, arms: ArmEvidence[]): Aggregated {
  const ok = [...per.entries()].filter((e): e is [string, Extract<BenchJudgeResult, { ok: true }>] => e[1].ok);
  const byModel = new Map<string, AggregatedArm>();
  for (const e of arms) {
    byModel.set(e.model, { model: e.model, per_judge: {}, mean: { correctness: 0, completeness: 0, code_quality: 0, adherence: 0, total: 0 }, rank: 0 });
  }
  for (const [judge, r] of ok) {
    for (const a of r.arms) {
      const agg = byModel.get(a.model);
      if (agg) agg.per_judge[judge] = { scores: a.scores, total: a.total, rank: a.rank, notes: a.notes };
    }
  }
  const round1 = (v: number) => Math.round(v * 10) / 10;
  for (const agg of byModel.values()) {
    const votes = Object.values(agg.per_judge);
    if (!votes.length) continue;
    for (const c of CRITERIA) agg.mean[c] = round1(votes.reduce((s, v) => s + v.scores[c], 0) / votes.length);
    agg.mean.total = round1(votes.reduce((s, v) => s + v.total, 0) / votes.length);
  }
  const order = arms
    .map((e) => ({ e, a: byModel.get(e.model)! }))
    .sort(
      (x, y) =>
        VERIFY_ORDER[x.e.verify_outcome] - VERIFY_ORDER[y.e.verify_outcome] ||
        y.a.mean.total - x.a.mean.total ||
        (x.e.tokens_out ?? Number.MAX_SAFE_INTEGER) - (y.e.tokens_out ?? Number.MAX_SAFE_INTEGER),
    );
  order.forEach((o, i) => (o.a.rank = i + 1));
  const top = order[0];
  const firsts = new Set(ok.map(([, r]) => r.winner ?? ''));
  const consensus: Aggregated['consensus'] = ok.length <= 1 ? 'single' : firsts.size === 1 ? 'unanimous' : 'split';
  // one judge reads as a plain paragraph; several are labelled so the page can tell them apart
  const summary = ok.length === 1 ? (ok[0]![1].summary ?? '') : ok.map(([judge, r]) => `【${judge}】${r.summary}`).join('\n');
  const winner = top && top.a.mean.total > 0 && top.e.verify_outcome !== 'fail' ? top.a.model : null;
  return { arms: [...byModel.values()], winner, consensus, summary };
}