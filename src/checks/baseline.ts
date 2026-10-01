import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getNum } from '../db/index.js';
import { snapshotCheck } from './render.js';
import { resolveCheckDeps, runCheck, type CheckDeps, type ResolvedCheckDeps } from './runner.js';
import { beginCheckRun, finishCheckRun, getCheckRun, newCheckRunId, runValues, type CheckRun } from './runs.js';
import { CheckError, getCheck, writeBaseline, type Check } from './store.js';

/**
 * 試跑一次 and 設為基準 (the 檢查 editor): a check runs once on the repo's default branch — where it
 * would run for a ticket, engine host or 機台 — and what it reported becomes the threshold chips
 * (the metric names are discovered, never guessed). 「設為基準」 keeps a passing run's values and
 * commit as the check's baseline; 「不比基準差」 compares against them from then on.
 */

export interface TrialResult {
  run: CheckRun;
  /** metric names the run reported (LOOP_METRICS; a 圖資回歸 always reports its fixed five) */
  discovered: string[];
}

interface RepoRow {
  id: string;
  name: string;
  local_path: string;
  default_branch: string;
}

const busy = new Set<string>();

/** Where a repo's 試跑 checkout lives (next to the tasks' ones under <dataDir>/review). */
export const repoTrialDir = (repoId: string): string => path.join(paths.dataDir, 'review', `repo-${repoId}`);

async function gitOut(d: ResolvedCheckDeps, args: string[], cwd: string, timeoutMs = 30_000): Promise<string | null> {
  try {
    return (await d.git(args, cwd, timeoutMs)).trim() || null;
  } catch {
    return null;
  }
}

/**
 * A detached checkout of the default branch (origin/<branch> after a fetch when there is an origin),
 * kept between 試跑 so builds stay incremental. Loop's own worktree: the repo's checkout is untouched.
 */
async function trialWorkspace(repo: RepoRow, d: ResolvedCheckDeps): Promise<{ dir: string; sha: string }> {
  if (!fs.existsSync(repo.local_path)) throw new Error(`找不到 repo 的本機複本：${repo.local_path}`);
  if (await gitOut(d, ['remote'], repo.local_path)) {
    try {
      await d.git(['fetch', '-q', 'origin', repo.default_branch], repo.local_path, 60_000);
    } catch {
      /* offline or no such branch there: use what the clone has */
    }
  }
  const sha =
    (await gitOut(d, ['rev-parse', '--verify', '--quiet', `origin/${repo.default_branch}^{commit}`], repo.local_path)) ??
    (await gitOut(d, ['rev-parse', '--verify', '--quiet', `${repo.default_branch}^{commit}`], repo.local_path));
  if (!sha) throw new Error(`repo 沒有 ${repo.default_branch} 分支`);
  const dir = repoTrialDir(repo.id);
  if (fs.existsSync(dir)) {
    try {
      if ((await gitOut(d, ['rev-parse', 'HEAD'], dir)) === sha) return { dir, sha };
      await d.git(['checkout', '-q', '--detach', '--force', sha], dir, 120_000); // build outputs stay
      return { dir, sha };
    } catch {
      await removeRepoTrialWorkspace(repo, d);
    }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await d.git(['worktree', 'add', '-q', '--detach', dir, sha], repo.local_path, 120_000);
  return { dir, sha };
}

async function removeRepoTrialWorkspace(repo: RepoRow, d: ResolvedCheckDeps): Promise<void> {
  const dir = repoTrialDir(repo.id);
  try {
    await d.git(['worktree', 'remove', '--force', dir], repo.local_path, 60_000);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      await d.git(['worktree', 'prune'], repo.local_path, 30_000);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Start a 試跑 and return its check_runs id at once (the editor polls GET /api/check-runs/:id);
 * `done` resolves when it finished and never rejects. Refuses a manual check, a GPU-sandbox check
 * (the 驗收頁 試跑 covers those) and a second 試跑 on the same repo while one runs.
 */
export function startTrialCheck(db: Database.Database, checkId: string, deps: CheckDeps = {}): { runId: string; done: Promise<TrialResult> } {
  const check = getCheck(db, checkId);
  if (!check) throw new CheckError('沒有這個檢查', 404);
  if (check.kind === 'manual') throw new CheckError('人工檢查沒有指令可以試跑', 409);
  if (check.machine?.startsWith('sandbox:')) throw new CheckError('GPU 沙盒的檢查請在驗收頁試跑', 409);
  const repo = db.prepare('SELECT id, name, local_path, default_branch FROM repos WHERE id = ?').get(check.repo_id) as RepoRow | undefined;
  if (!repo) throw new CheckError('這個檢查的 repo 已經不在了', 404);
  if (busy.has(repo.id)) throw new CheckError('這個 repo 已經有一個試跑在進行，結束後再試', 409);
  const crId = newCheckRunId();
  if (!beginCheckRun(db, { id: crId, check_id: check.id, kind: 'trial', machine: check.machine })) throw new CheckError('記錄試跑失敗', 500);
  busy.add(repo.id);
  const snap = snapshotCheck(db, check);
  const d = resolveCheckDeps(db, deps);
  const done = (async (): Promise<TrialResult> => {
    try {
      const ws = await trialWorkspace(repo, d);
      await runCheck(
        db,
        snap,
        {
          cwd: ws.dir,
          timeoutMs: getNum(db, 'check_timeout_min', 20) * 60_000,
          kind: 'trial',
          record: true,
          taskId: null,
          runId: null,
          base: repo.default_branch,
          branch: repo.default_branch,
          redGreen: false,
          crId,
        },
        deps,
      );
    } catch (err) {
      finishCheckRun(db, crId, { ok: false, exit_code: null, timed_out: false, ms: null, output: `試跑沒有開始：${String((err as Error)?.message ?? err)}` });
    } finally {
      busy.delete(repo.id);
    }
    const run = getCheckRun(db, crId);
    if (!run) throw new CheckError('試跑的紀錄不見了', 500);
    return { run, discovered: Object.keys(runValues(run)) };
  })();
  done.catch(() => undefined); // a caller that does not wait must not see an unhandled rejection
  return { runId: crId, done };
}

/** 試跑一次, awaited (the CLI). */
export async function trialCheck(db: Database.Database, checkId: string, deps: CheckDeps = {}): Promise<TrialResult> {
  return startTrialCheck(db, checkId, deps).done;
}

/**
 * 設為基準: a finished, passing run of this check that reported metrics becomes its baseline
 * ({sha, values, ms, at, run_id}). A run from a task verification is accepted too; its namespaced
 * names (ck_x.correct_rate) are stored plain.
 */
export function setBaseline(db: Database.Database, checkId: string, runId: string, by: string | null = null): Check {
  const check = getCheck(db, checkId);
  if (!check) throw new CheckError('沒有這個檢查', 404);
  const run = getCheckRun(db, runId);
  if (!run) throw new CheckError('沒有這次執行紀錄', 404);
  if (run.check_id !== checkId) throw new CheckError('這次執行不是這個檢查的', 400);
  if (!run.finished_at) throw new CheckError('還在跑，結束後才能設為基準', 409);
  if (run.ok !== 1) throw new CheckError('這次執行沒有通過，不能當基準', 409);
  const prefix = `${checkId}.`;
  const values: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(runValues(run))) values[k.startsWith(prefix) ? k.slice(prefix.length) : k] = v;
  if (!Object.keys(values).length) throw new CheckError('這次執行沒有回報任何指標（LOOP_METRICS），沒有東西可以當基準', 409);
  return writeBaseline(db, checkId, { sha: run.head_sha, values, ms: run.ms, at: new Date().toISOString(), run_id: run.id }, by)!;
}
