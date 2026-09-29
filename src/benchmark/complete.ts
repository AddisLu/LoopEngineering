import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getBool, getNum, logEvent } from '../db/index.js';
import { getTask, latestRun, listRunsForTask, setStatus } from '../tasks.js';
import { baseRefFor } from '../git/integrate.js';
import { cleanupWorktree } from '../orchestrator/cleanup.js';
import type { SandboxDeps } from '../exec/sandbox.js';
import { armIterations, measureArm, type FinalMeasurement } from './attempts.js';
import { notify } from '../notify.js';
import { getBenchmark, judgeList, type Benchmark, type BenchmarkArmView } from './store.js';
import { aggregateJudgements, runBenchJudge, type ArmEvidence, type BenchJudgeExec, type BenchJudgeResult } from './judge.js';
import { getModelManager, type ModelManager } from '../local/modelManager.js';
import { activeLocalRunCount } from '../tasks.js';
import { isLocalModel, localId } from '../local/models.js';

/**
 * Benchmark completion: once every arm task is terminal, collect each arm's evidence (verify
 * outcome, capped diff, tokens, time), run the comparative judge, store scores/ranks, push one
 * ntfy, then reclaim the arm worktrees (their loop/<id> branches stay for inspection) and close
 * the arms. Driven fire-and-forget from the server loop; an in-memory guard prevents re-entry.
 */

const TERMINAL = new Set(['review', 'attention', 'failed', 'closed']);
const judging = new Set<string>();

/** Is this benchmark being judged by THIS process right now? (a DB row can outlive the process) */
export function isJudging(id: string): boolean {
  return judging.has(id);
}

/** Judge every running benchmark whose arms have all finished. Returns the ids judged this call. */
export async function checkBenchmarks(db: Database.Database, exec?: BenchJudgeExec): Promise<string[]> {
  if (!getBool(db, 'benchmark_enabled', false)) return [];
  const done: string[] = [];
  // 'judging' is also picked up: the in-flight guard lives in memory, so a restart during
  // judging used to leave the row stuck at 'judging' with nothing left to finish it.
  const running = db.prepare("SELECT id FROM benchmarks WHERE status IN ('running','judging')").all() as { id: string }[];
  for (const { id } of running) {
    const detail = getBenchmark(db, id);
    if (!detail || judging.has(id)) continue;
    if (!detail.arms.every((a) => TERMINAL.has(a.task_status ?? 'failed'))) continue;
    await judgeBenchmark(db, id, exec);
    done.push(id);
  }
  return done;
}

/** Judge one benchmark now (also the retry path for judge_failed). Null if unknown or already judging. */
export async function judgeBenchmark(
  db: Database.Database,
  id: string,
  exec?: BenchJudgeExec,
  opts: { judges?: string[]; modelManager?: Pick<ModelManager, 'state' | 'ensureLoaded'>; sandboxDeps?: SandboxDeps } = {},
): Promise<Benchmark | null> {
  if (judging.has(id)) return null;
  const detail = getBenchmark(db, id);
  if (!detail) return null;
  judging.add(id);
  try {
    const bench = detail.benchmark;
    db.prepare("UPDATE benchmarks SET status = 'judging', error = NULL WHERE id = ?").run(id);
    // an arm whose task was deleted has no work to compare; judging it as a loser would poison
    // the model's record, so it drops out of the comparison entirely
    const live = detail.arms.filter((a) => a.task_status != null);
    if (live.length < 2) {
      const why = `參賽組不足（${live.length}/${detail.arms.length}，其餘任務已被刪除）`;
      db.prepare("UPDATE benchmarks SET status = 'cancelled', error = ? WHERE id = ?").run(why, id);
      logEvent(db, { kind: 'note', detail: `benchmark ${id} cancelled: ${why}` });
      return getBenchmark(db, id)!.benchmark;
    }
    // Measure every arm's final code again, one arm at a time, now that none of them is running:
    // what each arm measured for itself may have shared the GPU with another arm's build or a local
    // model generating. An arm already judged (worktree reclaimed) keeps its earlier measurement.
    if (getBool(db, 'bench_final_measure', true)) {
      const putFinal = db.prepare('UPDATE benchmark_arms SET final_json = ? WHERE benchmark_id = ? AND model = ?');
      for (const arm of live) {
        const final = await measureArm(db, arm.task_id, opts.sandboxDeps);
        if (final) putFinal.run(JSON.stringify(final), id, arm.model);
      }
    }
    const previous = previousEvidence(bench);
    const arms = getBenchmark(db, id)!.arms.filter((a) => a.task_status != null);
    const evidence = arms.map((arm) => collectArmEvidence(db, bench, arm, previous.get(arm.model)));
    const judges = opts.judges?.length ? opts.judges : judgeList(bench);
    // every judge scores on its own; one failing does not sink the others
    const per = new Map<string, BenchJudgeResult>();
    const putJ = db.prepare(
      `INSERT INTO benchmark_judgements (benchmark_id, judge_model, result_json, summary, winner, error) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(benchmark_id, judge_model) DO UPDATE SET result_json = excluded.result_json, summary = excluded.summary, winner = excluded.winner, error = excluded.error, created_at = datetime('now')`,
    );
    for (const judge of judges) {
      const r = await runBenchJudge(db, bench, evidence, exec, judge);
      per.set(judge, r);
      putJ.run(id, judge, r.ok ? JSON.stringify(r) : null, r.ok ? r.summary : null, r.ok ? r.winner : null, r.ok ? null : r.error);
    }
    const failures = [...per.entries()].filter(([, r]) => !r.ok).map(([j, r]) => `${j}: ${(r as { error: string }).error}`);
    if (failures.length === judges.length) {
      const error = failures.join(' | ');
      db.prepare("UPDATE benchmarks SET status = 'judge_failed', error = ? WHERE id = ?").run(error, id);
      logEvent(db, { kind: 'note', detail: `benchmark ${id}: judge failed — ${error}` });
      await notify(db, { title: 'Loop: benchmark 評比失敗', message: `${bench.title}: ${error}`, tags: ['warning'] });
      return getBenchmark(db, id)!.benchmark;
    }

    const result = aggregateJudgements(per, evidence);
    const upd = db.prepare(
      'UPDATE benchmark_arms SET judge_score = ?, judge_rank = ?, scores_json = ?, notes = ? WHERE benchmark_id = ? AND model = ?',
    );
    for (const a of result.arms) {
      const votes = Object.entries(a.per_judge);
      // a single judge's note reads as a plain sentence; several are labelled
      const notes = votes.length === 1 ? (votes[0]![1].notes ?? '') : votes.map(([j, v]) => `【${j}】${v.notes}`).join('\n');
      upd.run(a.mean.total, a.rank, JSON.stringify({ ...a.per_judge, mean: a.mean }), notes, id, a.model);
    }
    db.prepare(
      "UPDATE benchmarks SET status = 'judged', winner = ?, summary = ?, result_json = ?, consensus = ?, error = ?, judged_at = datetime('now') WHERE id = ?",
    ).run(result.winner, result.summary, JSON.stringify({ ...result, evidence }), result.consensus, failures.length ? `部分評審失敗：${failures.join(' | ')}` : null, id);

    for (const arm of detail.arms) {
      const t = getTask(db, arm.task_id);
      if (!t) continue;
      cleanupWorktree(db, t);
      if (t.status === 'review' || t.status === 'attention') {
        setStatus(db, t.id, 'closed', { detail: `benchmark ${id} judged` });
      }
    }

    const podium = [...result.arms]
      .sort((a, b) => a.rank - b.rank)
      .map((a) => `${a.rank}. ${a.model} ${a.mean.total}`)
      .join(' · ');
    logEvent(db, { kind: 'note', detail: `benchmark ${id} judged by ${judges.join('+')} (${result.consensus}): ${podium}` });
    await notify(db, {
      title: 'Loop: benchmark 完成',
      message: `${bench.title} (${bench.domain})\n${podium}\n${result.summary}`,
      tags: ['trophy'],
    });
    // the arms may have switched vLLM around; put the operator's model back when nothing local runs
    const restore = bench.restore_model;
    if (restore && activeLocalRunCount(db) === 0) {
      const mm = opts.modelManager ?? getModelManager(db);
      const loaded = mm.state().loaded;
      if (loaded !== restore) {
        const r = mm.ensureLoaded(restore);
        logEvent(db, { kind: 'note', detail: `benchmark ${id}: switching back to ${restore} (${r})` });
      }
    }
    return getBenchmark(db, id)!.benchmark;
  } finally {
    judging.delete(id);
  }
}

function ts(s: string): number {
  return Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

const EXCLUDE = [':(exclude)HANDOFF.md', ':(exclude)LOOP_RESUME_CONTEXT.md', ':(exclude)VERIFY.md'];

/** Bounded diff of the arm's work (`head` in `dir`) vs `base`, without the engine's hand-off artifacts. */
function armDiff(dir: string, base: string, head: string, cap: number): { diff: string; stat: string } {
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 30_000 });
  try {
    const out = git(['diff', `${base}...${head}`, '--', '.', ...EXCLUDE]);
    let stat = '';
    try {
      stat = git(['diff', '--stat', `${base}...${head}`, '--', '.', ...EXCLUDE]).trim();
    } catch {
      /* best effort */
    }
    return { diff: out.length > cap ? `${out.slice(0, cap)}\n...(truncated at ${cap} chars)` : out, stat };
  } catch {
    return { diff: '(diff unavailable)', stat: '' };
  }
}

/** The evidence an earlier judging stored, by model — a re-judge after the arms were closed and their worktrees reclaimed reuses it. */
function previousEvidence(bench: Benchmark): Map<string, ArmEvidence> {
  try {
    const list = (JSON.parse(bench.result_json ?? '{}') as { evidence?: ArmEvidence[] }).evidence ?? [];
    return new Map(list.map((e) => [e.model, e]));
  } catch {
    return new Map();
  }
}

function parseJson<T>(s: string | null | undefined): T | null {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function collectArmEvidence(db: Database.Database, bench: Benchmark, arm: BenchmarkArmView, prev?: ArmEvidence): ArmEvidence {
  const task = getTask(db, arm.task_id);
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let durationS = 0;
  const runs = task ? listRunsForTask(db, task.id) : [];
  for (const r of runs) {
    if (r.tokens_in != null) tokensIn = (tokensIn ?? 0) + r.tokens_in;
    if (r.tokens_out != null) tokensOut = (tokensOut ?? 0) + r.tokens_out;
    if (r.finished_at) durationS += Math.max(0, (ts(r.finished_at) - ts(r.started_at)) / 1000);
  }

  const run = task ? latestRun(db, task.id) : undefined;
  const wt = run?.worktree_path && fs.existsSync(run.worktree_path) ? run.worktree_path : null;
  // judged before: the arm was closed on purpose and its worktree reclaimed, so its status no longer
  // says how it did — the evidence recorded then does
  const judgedBefore = !!prev && !wt;

  const status = task?.status ?? 'failed';
  let own: ArmEvidence['verify_outcome'] =
    status === 'review' || status === 'closed' ? (task?.merge_status === 'pending' ? 'manual' : 'pass') : 'fail';
  let failure: string | null = null;
  if (judgedBefore) {
    own = prev!.own_outcome ?? prev!.verify_outcome;
    failure = prev!.failure;
  } else if (own === 'fail') {
    const ev = db
      .prepare(
        `SELECT detail FROM task_events WHERE task_id = ? AND to_status IN ('attention','failed') AND detail IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(arm.task_id) as { detail: string } | undefined;
    failure = ev?.detail ? ev.detail.slice(-1500) : `arm ended in ${status}`;
  }

  // the diff is measured from where the arm's verification recorded it started (the arm branched off
  // origin/<base>; the local base may have moved), falling back to origin/<base>, then <base>
  let diff = '(no worktree — the arm never produced a change)';
  let stat = '';
  const cap = getNum(db, 'bench_diff_cap_chars', 8000);
  const recordedBase = [...runs].reverse().find((r) => r.base_sha)?.base_sha ?? null;
  if (wt && bench.base_branch) {
    ({ diff, stat } = armDiff(wt, recordedBase ?? baseRefFor(wt, bench.base_branch), 'HEAD', cap));
  } else if (judgedBefore) {
    diff = prev!.diff;
    stat = prev!.diff_stat;
  } else if (task?.repo_path && bench.base_branch && fs.existsSync(task.repo_path)) {
    // worktree gone but the branch is kept for inspection
    const r = armDiff(task.repo_path, recordedBase ?? baseRefFor(task.repo_path, bench.base_branch), `loop/${task.id}`, cap);
    if (r.diff !== '(diff unavailable)') ({ diff, stat } = r);
  } else if (wt) {
    diff = '(no base branch recorded for this benchmark — cannot diff)';
  }

  const iterations = task ? armIterations(db, task.id) : null;
  const final = parseJson<FinalMeasurement>(arm.final_json) ?? prev?.final ?? null;
  // the final re-measurement, when there is one, is what the ranking goes by
  const verify: ArmEvidence['verify_outcome'] = final ? (final.outcome === 'pass' ? 'pass' : 'fail') : own;
  const duration = Math.round(durationS);
  db.prepare(
    'UPDATE benchmark_arms SET verify_outcome = ?, tokens_in = ?, tokens_out = ?, duration_s = ?, diff_stat = ?, attempts_json = ? WHERE benchmark_id = ? AND model = ?',
  ).run(verify, tokensIn, tokensOut, duration, stat || null, iterations ? JSON.stringify(iterations) : null, bench.id, arm.model);
  return {
    model: arm.model,
    verify_outcome: verify,
    own_outcome: own,
    failure,
    diff_stat: stat,
    diff,
    tokens_out: tokensOut,
    duration_s: duration,
    iterations,
    final,
  };
}
