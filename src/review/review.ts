import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getNum, getSetting, logEvent } from '../db/index.js';
import { paths } from '../config.js';
import { getTask, latestRun, setStatus } from '../tasks.js';
import { tailLog } from '../server/board.js';
import { giteaRepoFor, publishGiteaRelease } from '../git/gitea.js';
import { mergeReviewedTask, MergeInProgressError, type MergeResult } from '../orchestrator/mergeFlow.js';
import { runVerifyGate, collectTaskArtifacts } from '../orchestrator/run.js';
import { runVerification, type VerifyStepResult } from '../orchestrator/verify.js';
import { evaluateAcceptance, extractMetrics, parseAcceptance, type MetricsReport } from '../orchestrator/acceptance.js';
import { prBody, readMetrics, readVerify, type VerifiedStep } from '../orchestrator/runSummary.js';
import { formatSandboxResult, runSandbox, sandboxSettings, type SandboxDeps, type SandboxStepRunner } from '../exec/sandbox.js';
import type { SandboxRun } from '../chat/sandboxTools.js';
import { resolveExecTarget, LOCAL_HOST } from '../exec/hosts.js';
import { datasetPath, getPlan, planSteps } from '../plans/store.js';
import { changedFiles, codeRefFor, readSource, type ChangedFile } from './code.js';
import { latestArtifacts, packageZip, type ArtifactManifest } from './artifacts.js';
import { parseSteps, type Task, type TaskRun } from '../types.js';
import { recordFix } from '../repo/ledger.js';
import { getIssueLink, reportIssue } from '../integrations/giteaIssues.js';
import { readSelfReview, type SelfReview } from './selfReview.js';
import { readTaskImages } from '../intake/context.js';
import { listCheckRunFiles } from './checkFiles.js';
import {
  buildAttempts,
  buildChecks,
  buildDatasetViews,
  latestPerCheck,
  nextEscalation,
  pickBeforeRow,
  pickShownRun,
  readAnalysis,
  readFrozenChecks,
  ticketHeadline,
  type AnalysisView,
  type Attempt,
  type CheckRunRow,
  type DatasetView,
  type ResultCheck,
} from './result.js';

/**
 * 驗收頁 (web/task.html): everything a person needs to decide whether a task's result is good —
 * what the engine measured, what changed, a way to run it themselves, the manual checklist — and
 * the delivery actions that follow (核可, 退回修改, 發佈). No engine state is changed here except
 * through those explicit actions.
 */

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

// ---- 人工驗收清單 --------------------------------------------------------------------------------

export interface CheckItem {
  text: string;
  checked: boolean;
  by: string | null;
  at: string | null;
}

/** "人工驗收：" lines the PRD intake put in the rubric (they come from the plan / the PRD). */
function rubricChecks(rubric: string | null): string[] {
  if (!rubric) return [];
  const out: string[] = [];
  let inManual = false;
  for (const line of rubric.split('\n')) {
    if (/^人工驗收[：:]\s*$/.test(line.trim())) {
      inManual = true;
      continue;
    }
    if (inManual) {
      const m = line.match(/^\s*[-*]\s+(.+)$/);
      if (m) out.push(m[1]!.trim());
      else if (line.trim()) inManual = false;
    }
  }
  return out;
}

/** Unticked "- [ ] …" lines of the agent's VERIFY.md. */
function verifyMdChecks(md: string | null): string[] {
  if (!md) return [];
  return md
    .split('\n')
    .map((l) => l.match(/^\s*[-*]\s+\[ \]\s+(.+)$/)?.[1]?.trim())
    .filter((s): s is string => !!s);
}

function verifyMdFor(db: Database.Database, task: Task): string | null {
  const ref = codeRefFor(db, task);
  return ref ? (readSource(ref, 'VERIFY.md')?.text ?? null) : null;
}

const SETTLED = new Set(['review', 'closed', 'attention', 'failed']);

/** The checklist, built once the run is over (its VERIFY.md exists by then) and kept with the ticks. */
export function checklistFor(db: Database.Database, task: Task): CheckItem[] {
  if (task.checklist_json) {
    try {
      const v = JSON.parse(task.checklist_json);
      if (Array.isArray(v)) return v as CheckItem[];
    } catch {
      /* rebuild */
    }
  }
  const seen = new Set<string>();
  const items: CheckItem[] = [];
  for (const text of [...rubricChecks(task.verify_rubric), ...verifyMdChecks(verifyMdFor(db, task))]) {
    const key = text.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text, checked: false, by: null, at: null });
  }
  if (SETTLED.has(task.status)) db.prepare('UPDATE tasks SET checklist_json = ? WHERE id = ?').run(JSON.stringify(items), task.id);
  return items;
}

export function tickCheck(db: Database.Database, task: Task, index: number, checked: boolean, by: string): CheckItem[] {
  const items = checklistFor(db, task);
  const item = items[index];
  if (!item) throw new ReviewError('沒有這一項', 404);
  item.checked = checked;
  item.by = checked ? by : null;
  item.at = checked ? new Date().toISOString() : null;
  db.prepare('UPDATE tasks SET checklist_json = ? WHERE id = ?').run(JSON.stringify(items), task.id);
  logEvent(db, { task_id: task.id, kind: 'note', detail: `人工驗收${checked ? '勾選' : '取消'}（${by}）：${item.text}` });
  return items;
}

// ---- the page's bundle -----------------------------------------------------------------------------

export type Verdict = 'passed' | 'manual' | 'failed' | 'in_progress';

export interface ReviewBundle {
  task: Pick<Task, 'id' | 'title' | 'goal' | 'status' | 'repo_path' | 'base_branch' | 'model' | 'merge_status' | 'pr_url' | 'acceptance_metrics' | 'verify_plan_id' | 'approved_by' | 'approved_at' | 'release_url' | 'created_at' | 'owner'>;
  verdict: Verdict;
  /** one line a person reads first */
  headline: string;
  reason: string | null;
  run: { id: string; attempt: number; model: string | null; started_at: string; finished_at: string | null; minutes: number | null } | null;
  runs: number;
  steps: VerifiedStep[];
  metrics: MetricsReport | null;
  /** the machines verification ran on */
  hosts: string[];
  changed_files: ChangedFile[] | null;
  code: { available: boolean; live: boolean };
  checklist: CheckItem[];
  artifacts: { run_id: string; files: ArtifactManifest['files']; skipped: string[]; head_sha: string | null } | null;
  plan: { id: string; name: string; host: string | null; has_datasets: boolean; dataset_default: string | null } | null;
  can: { trial: boolean; trial_reason: string | null; approve: boolean; approve_reason: string | null; release: boolean; release_reason: string | null; request_changes: boolean };
  /** gitea_url is set: PRs and releases go through a local Gitea (the page words 交付 by it) */
  gitea: boolean;
  log_tail: string[];
  // ---- 問題單 only (empty / null for any other task) ----
  checks: ResultCheck[];
  dataset: DatasetView[];
  review: SelfReview | null;
  attempts: Attempt[];
  issue: { number: number; url: string; closed: boolean } | null;
  ticket: { repo: string | null; repo_id: string | null; analysis: AnalysisView | null; images: Array<{ index: number; name: string; text: string }>; prd: string | null } | null;
  escalation: { next: string | null } | null;
}

const PRD_CAP = 60_000;

function readPrd(task: Task): string | null {
  if (!task.plan_ref) return null;
  try {
    const text = fs.readFileSync(task.plan_ref, 'utf8');
    return text.length > PRD_CAP ? `${text.slice(0, PRD_CAP)}\n…（其餘省略）` : text;
  } catch {
    return null;
  }
}

/** The 問題單 parts of the bundle: what the checks engine recorded, read against the frozen checks. */
function ticketParts(
  db: Database.Database,
  task: Task,
  runs: TaskRun[],
  inProgress: boolean,
): Pick<ReviewBundle, 'checks' | 'dataset' | 'review' | 'attempts' | 'issue' | 'ticket' | 'escalation'> {
  const link = getIssueLink(db, task.id);
  const issue = link ? { number: link.number, url: link.issue_url, closed: !!link.closed_at } : null;
  if (!task.repo_id && !task.checks_json) {
    return { checks: [], dataset: [], review: readSelfReview(task), attempts: [], issue, ticket: null, escalation: null };
  }
  const frozen = readFrozenChecks(task.checks_json);
  const rows = db.prepare('SELECT * FROM check_runs WHERE task_id = ? ORDER BY started_at, rowid').all(task.id) as CheckRunRow[];
  const shownId = pickShownRun(runs, rows, inProgress);
  const shown = latestPerCheck(rows, shownId);
  const shownRun = runs.find((r) => r.id === shownId) ?? null;
  // 修前: the frozen checks' own baseline / 試跑 rows (they carry no task_id)
  const ids = frozen.map((c) => c.id);
  const pre = ids.length
    ? (db
        .prepare(`SELECT * FROM check_runs WHERE check_id IN (${ids.map(() => '?').join(',')}) AND kind IN ('baseline', 'trial') ORDER BY started_at, rowid`)
        .all(...ids) as CheckRunRow[])
    : [];
  const before = new Map<string, CheckRunRow>();
  for (const c of frozen) {
    const row = pickBeforeRow(c, pre, shownRun?.started_at ?? null);
    if (row) before.set(c.id, row);
  }
  const repo = task.repo_id ? (db.prepare('SELECT name FROM repos WHERE id = ?').get(task.repo_id) as { name: string } | undefined) : undefined;
  return {
    checks: buildChecks(frozen, shown, before, readVerify(shownRun)),
    dataset: buildDatasetViews(frozen, shown, before, (id) => listCheckRunFiles(paths.checkRunsDir, id)),
    review: readSelfReview(task),
    attempts: buildAttempts(runs, frozen, rows),
    issue,
    ticket: {
      repo: repo?.name ?? null,
      repo_id: task.repo_id ?? null,
      analysis: readAnalysis(task.analysis_json),
      images: readTaskImages(task).map((im, index) => ({ index, name: im.name ?? `截圖 ${index + 1}`, text: im.text ?? '' })),
      prd: readPrd(task),
    },
    escalation: { next: nextEscalation(getSetting(db, 'fix_escalation'), task.model, task.ladder_step) },
  };
}

const ts = (s: string | null) => (s ? new Date(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`) : null);

function hostsOf(steps: string[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    const m = s.match(/^sandbox(?:@([a-z0-9][a-z0-9_-]*))?\s*:/i);
    if (m) out.add(m[1] ?? LOCAL_HOST);
  }
  return [...out];
}

export function trialAllowed(db: Database.Database, userKey: string): string | null {
  if (!sandboxSettings(db).enabled) return '執行沙盒沒有開（loop config set exec_enabled true）';
  const allowed = (getSetting(db, 'exec_allowed_users') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(userKey.toLowerCase())) return `你（${userKey}）不在 exec_allowed_users 裡，沒有執行程式的權限`;
  return null;
}

export function reviewBundle(
  db: Database.Database,
  task: Task,
  viewer: { user_key: string },
  opts: { releaseToken?: string } = {},
): ReviewBundle {
  const runs = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC').all(task.id) as TaskRun[];
  const run = runs[0] ?? null;
  const verified = runs.find((r) => r.verify_json) ?? null;
  const steps = readVerify(verified);
  const metrics = readMetrics(verified);
  const failedStep = steps.find((s) => !s.ok);
  const lastDetail = (db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'status' ORDER BY id DESC LIMIT 1").get(task.id) as { detail: string | null } | undefined)?.detail ?? null;

  let verdict: Verdict;
  let headline: string;
  if (['queued', 'running', 'verifying', 'blocked', 'draft', 'ready'].includes(task.status)) {
    verdict = 'in_progress';
    headline =
      task.status === 'queued' ? '排隊中，還沒開始'
      : task.status === 'running' ? '正在改程式'
      : task.status === 'verifying' ? '正在驗證'
      : task.status === 'blocked' ? '中斷了，會自動續跑'
      : '還沒送出';
  } else if (task.status === 'attention' || task.status === 'failed') {
    verdict = 'failed';
    headline = failedStep ? `沒有通過：${failedStep.step}` : metrics && !metrics.pass ? '沒有通過：驗收指標未達標' : '沒有完成，需要人處理';
  } else {
    const measured = steps.length > 0 && steps.every((s) => s.ok) && (!metrics || metrics.pass);
    verdict = measured ? 'passed' : 'manual';
    const n = metrics?.checks.length ?? 0;
    headline = measured
      ? `${n ? `${n} 項指標全部達標，` : ''}${steps.length} 個驗證步驟都成功`
      : '沒有可以自動判定的驗證，要靠人工驗收';
  }

  const ref = task.coding_tool === 'generic' ? null : codeRefFor(db, task);
  const checklist = checklistFor(db, task);
  const art = latestArtifacts(db, task.id);
  const plan = task.verify_plan_id ? getPlan(db, task.verify_plan_id) : null;
  const trialReason =
    !ref ? '找不到這個任務的程式碼（分支已刪除？）'
    : ['running', 'verifying', 'queued'].includes(task.status) ? '任務執行中，結束後才能試跑'
    : trialAllowed(db, viewer.user_key);
  const unchecked = checklist.filter((c) => !c.checked).length;
  const approveReason =
    task.approved_at ? `已由 ${task.approved_by} 核可`
    : task.status !== 'review' ? '要等任務進到「待驗收」（看板上的「待結案」）才能核可'
    : unchecked ? `人工驗收還有 ${unchecked} 項沒勾`
    : null;
  const releaseReason =
    !task.approved_at ? '核可後才能發佈'
    : !(getSetting(db, 'gitea_url') ?? '').trim() ? '還沒設定 gitea_url'
    : !(opts.releaseToken ?? process.env.GITEA_TOKEN) ? '引擎的環境變數沒有 GITEA_TOKEN'
    : !art?.manifest.files.length ? '沒有收集到產出物（驗證方案要設定「產出物」）'
    : null;
  const started = ts(run?.started_at ?? null);
  const finished = ts(run?.finished_at ?? null);
  const ticket = ticketParts(db, task, runs, verdict === 'in_progress');
  if (ticket.ticket) headline = ticketHeadline(task.status, ticket.checks) ?? headline;

  return {
    task: {
      id: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
      repo_path: task.repo_path,
      base_branch: task.base_branch,
      model: task.model,
      merge_status: task.merge_status,
      pr_url: task.pr_url,
      acceptance_metrics: task.acceptance_metrics ?? null,
      verify_plan_id: task.verify_plan_id ?? null,
      approved_by: task.approved_by ?? null,
      approved_at: task.approved_at ?? null,
      release_url: task.release_url ?? null,
      created_at: task.created_at,
      owner: task.owner ?? null,
    },
    verdict,
    headline,
    reason: verdict === 'failed' || verdict === 'in_progress' ? lastDetail : null,
    run: run
      ? {
          id: run.id,
          attempt: run.attempt,
          model: run.model ?? task.model,
          started_at: run.started_at,
          finished_at: run.finished_at,
          minutes: started && finished ? Math.max(0, Math.round((finished.getTime() - started.getTime()) / 60_000)) : null,
        }
      : null,
    runs: runs.length,
    steps,
    metrics,
    hosts: hostsOf(steps.map((s) => s.step)),
    changed_files: ref ? changedFiles(ref, 300) : null,
    code: { available: !!ref, live: !!ref?.worktree },
    checklist,
    artifacts: art ? { run_id: art.run_id, files: art.manifest.files, skipped: art.manifest.skipped, head_sha: art.manifest.head_sha } : null,
    plan: plan ? { id: plan.id, name: plan.name, host: plan.host, has_datasets: !!plan.dataset_root, dataset_default: plan.dataset_default } : null,
    can: {
      trial: trialReason === null,
      trial_reason: trialReason,
      approve: approveReason === null,
      approve_reason: approveReason,
      release: releaseReason === null,
      release_reason: releaseReason,
      request_changes: ['review', 'attention', 'failed'].includes(task.status),
    },
    gitea: !!(getSetting(db, 'gitea_url') ?? '').trim(),
    log_tail: run && verdict === 'in_progress' ? tailLog(run.log_path, 20) : [],
    ...ticket,
  };
}

// ---- 核可 / 退回修改 -------------------------------------------------------------------------------

export async function approveTask(
  db: Database.Database,
  task: Task,
  by: string,
  deps: { sandboxDeps?: SandboxDeps; closeIssue?: boolean } = {},
): Promise<{ merged: boolean; detail: string }> {
  if (task.approved_at) throw new ReviewError(`已由 ${task.approved_by} 核可`);
  if (task.status !== 'review') throw new ReviewError('要等任務進到「待驗收」（看板上的「待結案」）才能核可');
  const unchecked = checklistFor(db, task).filter((c) => !c.checked);
  if (unchecked.length) throw new ReviewError(`人工驗收還有 ${unchecked.length} 項沒勾：${unchecked.map((c) => c.text).join('；')}`);
  let merged = false;
  let detail = task.merge_status === 'merged' ? `已在 ${task.base_branch}` : '沒有要合併的（由 Gitea PR 合併）';
  if ((task.merge_status === 'pending' || task.merge_status === 'conflict') && task.repo_path && task.base_branch) {
    // the same merge as the board's 合併: latest base in, re-verified, then fast-forwarded
    let r: MergeResult;
    try {
      r = await mergeReviewedTask(db, task, { by: `核可：${by}`, sandboxDeps: deps.sandboxDeps });
    } catch (err) {
      if (err instanceof MergeInProgressError) throw new ReviewError(err.message);
      throw err;
    }
    if (r.outcome !== 'merged') throw new ReviewError(`合併沒有成功：${r.detail}`);
    merged = true;
    detail = r.detail;
  }
  db.prepare("UPDATE tasks SET approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(by, task.id);
  logEvent(db, { task_id: task.id, kind: 'note', detail: `核可（${by}）：${detail}` });
  recordFix(db, getTask(db, task.id) ?? task, 'merged');
  reportIssue(db, task.id, 'done', { closeIssue: deps.closeIssue });
  return { merged, detail };
}

/**
 * 退回修改: the person's feedback joins the goal and the task goes back in the queue. The next
 * run reuses the loop/<id> branch (addWorktree reuses an existing branch), so the agent fixes its
 * own work instead of starting over; the checklist and approval start fresh.
 */
export function requestChanges(db: Database.Database, task: Task, feedback: string, by: string): Task {
  if (!['review', 'attention', 'failed'].includes(task.status)) throw new ReviewError('只有執行結束的任務可以退回修改');
  const fb = feedback.trim();
  if (!fb) throw new ReviewError('請寫下要改什麼', 400);
  if (fb.length > 4000) throw new ReviewError('意見太長（最多 4000 字）', 400);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const goal = `${task.goal.trim()}\n\n## 人工驗收退回（${by}，${stamp} UTC）\n${fb}`;
  db.prepare(
    `UPDATE tasks SET goal = ?, merge_status = NULL, approved_by = NULL, approved_at = NULL, checklist_json = NULL, resume_count = 0 WHERE id = ?`,
  ).run(goal, task.id);
  recordFix(db, task, 'returned');
  reportIssue(db, task.id, 'returned', { feedback: fb });
  removeTrialWorkspace(task);
  setStatus(db, task.id, 'queued', { detail: `退回修改（${by}）：${fb.slice(0, 200)}` });
  return getTask(db, task.id)!;
}

/**
 * 交給同事: who follows the task up from here (tasks.owner). Only the name is recorded — the run,
 * the branch and the review state stay as they are; an empty name takes the task back (no owner).
 */
export function handOver(db: Database.Database, task: Task, owner: string, by: string): Task {
  const name = owner.trim();
  if (name.length > 40) throw new ReviewError('名字太長（最多 40 字）', 400);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ReviewError('名字裡有看不見的字元', 400);
  if (name === (task.owner ?? '')) return task;
  db.prepare('UPDATE tasks SET owner = ? WHERE id = ?').run(name || null, task.id);
  logEvent(db, { task_id: task.id, kind: 'note', detail: name ? `交給 ${name}（${by}）` : `不再指定負責人（${by}）` });
  return getTask(db, task.id)!;
}

// ---- 試跑 ------------------------------------------------------------------------------------------

export const trialRoot = (): string => path.join(paths.dataDir, 'review');

/** A detached checkout of the task's verified commit, separate from the task's own worktree. */
export function trialWorkspace(db: Database.Database, task: Task): string {
  const ref = codeRefFor(db, task);
  if (!ref || !task.repo_path) throw new ReviewError('找不到這個任務的程式碼（分支已刪除？）');
  const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const sha = git(ref.gitDir, ['rev-parse', `${ref.head}^{commit}`]).trim();
  const dir = path.join(trialRoot(), task.id);
  if (fs.existsSync(dir)) {
    try {
      if (git(dir, ['rev-parse', 'HEAD']).trim() === sha) return dir;
      git(dir, ['checkout', '-q', '--detach', '--force', sha]); // untracked build outputs stay: faster rebuilds
      return dir;
    } catch {
      removeTrialWorkspace(task);
    }
  }
  fs.mkdirSync(trialRoot(), { recursive: true });
  git(task.repo_path, ['worktree', 'add', '-q', '--detach', dir, sha]);
  return dir;
}

export function removeTrialWorkspace(task: Task): void {
  const dir = path.join(trialRoot(), task.id);
  if (!fs.existsSync(dir)) return;
  try {
    if (task.repo_path) execFileSync('git', ['-C', task.repo_path, 'worktree', 'remove', '--force', dir], { timeout: 60_000, stdio: 'ignore' });
  } catch {
    /* fall through to rm */
  }
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    if (task.repo_path) execFileSync('git', ['-C', task.repo_path, 'worktree', 'prune'], { timeout: 30_000, stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

/**
 * `loop verify <task>`: run a finished task's command verification again, now, on its code — its
 * worktree, or the 試跑 checkout of the commit it was verified at — and record it on the latest
 * run, so 結果 shows it and a pass collects the 產出物. Status and merge state stay as they are.
 * For work verified before the engine kept these records, or worth checking again after the
 * environment changed (e.g. Nsight Compute counters were enabled on the host).
 */
export async function reverifyTask(
  db: Database.Database,
  task: Task,
  deps: { sandboxDeps?: SandboxDeps } = {},
): Promise<{ ok: boolean; ran: boolean; detail: string; workspace: string }> {
  if (['running', 'verifying', 'queued'].includes(task.status)) throw new ReviewError('任務執行中，結束後才能重新驗證');
  const run = latestRun(db, task.id);
  if (!run) throw new ReviewError('這個任務還沒有執行紀錄');
  const dir = run.worktree_path && fs.existsSync(run.worktree_path) ? run.worktree_path : trialWorkspace(db, task);
  const gate = await runVerifyGate(db, task, dir, run.id, task.base_branch, deps.sandboxDeps);
  if (!gate.failure && gate.ran) await collectTaskArtifacts(db, task, run.id, dir);
  const detail = gate.failure ? `沒有通過：${gate.failure.failedStep ?? '驗證'}` : gate.ran ? '驗證步驟都通過' : '沒有可以自動執行的驗證步驟';
  logEvent(db, { task_id: task.id, run_id: run.id, kind: 'note', detail: `重新驗證（loop verify）：${detail}` });
  return { ok: !gate.failure, ran: gate.ran, detail, workspace: dir };
}

export interface Trial {
  id: string;
  task_id: string;
  mode: 'verify' | 'command';
  command: string | null;
  dataset: string | null;
  by: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'done' | 'error';
  results: VerifyStepResult[];
  metrics: MetricsReport | null;
  error: string | null;
}

const trials = new Map<string, Trial>();
const busy = new Set<string>();

export function listTrials(taskId: string): Trial[] {
  return [...trials.values()].filter((t) => t.task_id === taskId).sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getTrial(id: string): Trial | null {
  return trials.get(id) ?? null;
}

export interface TrialDeps {
  /** stands in for `docker run` (tests) */
  sandboxRun?: SandboxRun;
}

/**
 * Start a trial and return at once; the page polls it. `verify` re-runs the task's verification
 * steps (with another 圖資 folder when the task came from a 驗證方案 that has them); `command` runs
 * one command in the task's 沙盒. Only in the sandbox — the same isolation as verification.
 */
export function startTrial(
  db: Database.Database,
  task: Task,
  req: { mode: 'verify' | 'command'; command?: string | null; dataset?: string | null },
  by: { user_key: string; label: string },
  deps: TrialDeps = {},
): Trial {
  const denied = trialAllowed(db, by.user_key);
  if (denied) throw new ReviewError(denied, 403);
  if (['running', 'verifying', 'queued'].includes(task.status)) throw new ReviewError('任務執行中，結束後才能試跑');
  if (busy.has(task.id)) throw new ReviewError('這個任務已經有一個試跑在進行');
  const command = (req.command ?? '').trim();
  if (req.mode === 'command' && !command) throw new ReviewError('請輸入要執行的指令', 400);
  if (command.length > 2000) throw new ReviewError('指令太長', 400);
  let steps: string[];
  const plan = task.verify_plan_id ? getPlan(db, task.verify_plan_id) : null;
  if (req.mode === 'verify') {
    if (req.dataset) {
      if (!plan) throw new ReviewError('這個任務不是從驗證方案建立的，不能換圖資');
      try {
        steps = planSteps(plan, datasetPath(plan, req.dataset));
      } catch (err) {
        throw new ReviewError((err as Error).message, 400);
      }
    } else steps = parseSteps(task);
    if (!steps.length) throw new ReviewError('這個任務沒有驗證步驟');
  } else {
    // the machine its verification used (or the plan's), with the task's own workspace there
    const host = plan?.host ?? hostsOf(parseSteps(task))[0] ?? LOCAL_HOST;
    steps = [`${host === LOCAL_HOST ? 'sandbox' : `sandbox@${host}`}: ${command}`];
  }
  // only sandbox steps: a trial never runs a plain command on the engine's own shell
  if (!steps.every((st) => /^sandbox(?:@[a-z0-9][a-z0-9_-]*)?\s*:/i.test(st))) {
    throw new ReviewError('這個任務的驗證有不在沙盒裡的步驟，不能在網頁上試跑（請工程師把驗證方案改成在驗證機台執行）');
  }
  let dir: string;
  try {
    dir = trialWorkspace(db, task);
  } catch (err) {
    if (err instanceof ReviewError) throw err;
    throw new ReviewError(`準備試跑環境失敗：${String((err as Error).message).slice(0, 200)}`, 500);
  }
  const trial: Trial = {
    id: `tr_${nanoid(8)}`,
    task_id: task.id,
    mode: req.mode,
    command: req.mode === 'command' ? command : null,
    dataset: req.dataset ?? null,
    by: by.label,
    started_at: new Date().toISOString(),
    finished_at: null,
    status: 'running',
    results: [],
    metrics: null,
    error: null,
  };
  trials.set(trial.id, trial);
  for (const old of listTrials(task.id).slice(10)) trials.delete(old.id); // keep the last few per task
  busy.add(task.id);

  const s = sandboxSettings(db);
  const run = deps.sandboxRun ?? runSandbox;
  const runner: SandboxStepRunner = async (cmd, cwd, timeoutMs, host) => {
    const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
    let remote: { host: import('../exec/hosts.js').ExecHost; key: string } | null = null;
    try {
      const t = resolveExecTarget(db, host ?? null);
      if (t.kind === 'remote') remote = { host: t.host, key: `task-${task.id}` };
    } catch (err) {
      return { ok: false, exitCode: null, timedOut: false, output: (err as Error).message };
    }
    const r = await run({ ...s, maxTimeoutSec: Math.max(s.maxTimeoutSec, sec) }, { workdir: cwd, command: cmd, timeoutSec: sec, scope: 'trial', remote });
    return { ok: r.exitCode === 0 && !r.infra, exitCode: r.exitCode, timedOut: r.timedOut, output: formatSandboxResult(r) };
  };
  const timeoutMs = (task.verify_timeout_min ?? getNum(db, 'verify_step_timeout_min', 10)) * 60_000;
  void (async () => {
    try {
      const vres = await runVerification({ ...task, verification_steps: JSON.stringify(steps) }, dir, timeoutMs, { shellSetting: getSetting(db, 'shell') }, runner);
      trial.results = vres.results.map((r) => ({ ...r, output: r.output.length > 20_000 ? `…${r.output.slice(-20_000)}` : r.output }));
      let specs: ReturnType<typeof parseAcceptance> = [];
      try {
        specs = parseAcceptance(task.acceptance_metrics);
      } catch {
        specs = [];
      }
      const values = extractMetrics(vres.results.map((r) => r.output));
      trial.metrics = specs.length || Object.keys(values).length ? evaluateAcceptance(specs, values) : null;
      trial.status = 'done';
    } catch (err) {
      trial.status = 'error';
      trial.error = (err as Error).message;
    } finally {
      trial.finished_at = new Date().toISOString();
      busy.delete(task.id);
      const last = trial.results.at(-1);
      logEvent(db, {
        task_id: task.id,
        kind: 'note',
        detail: `試跑（${by.label}）：${trial.mode === 'command' ? trial.command : `重跑驗證${trial.dataset ? `，圖資 ${trial.dataset}` : ''}`} → ${trial.error ? `錯誤：${trial.error.slice(0, 120)}` : last ? (last.ok ? '成功' : `失敗（exit ${last.exitCode ?? '?'}）`) : '沒有結果'}`,
      });
    }
  })();
  return trial;
}

// ---- 交付 ------------------------------------------------------------------------------------------

/** The report inside the zip and on the release: the PR body plus the files with their sha256. */
export function deliveryReport(db: Database.Database, task: Task, manifest: ArtifactManifest): string {
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(manifest.run_id) as TaskRun | undefined;
  const lines = [prBody(task, run, null), '', '## 產出物', '', '| 檔案 | 大小 | sha256 | 來自 |', '|---|---|---|---|'];
  for (const f of manifest.files) lines.push(`| \`${f.path}\` | ${f.size} | \`${f.sha256.slice(0, 16)}…\` | ${f.from} |`);
  if (manifest.head_sha) lines.push('', `commit：\`${manifest.head_sha}\``);
  if (task.approved_by) lines.push(`核可：${task.approved_by}（${task.approved_at} UTC）`);
  return lines.join('\n');
}

export function deliveryZip(db: Database.Database, task: Task): { name: string; data: Buffer } {
  const art = latestArtifacts(db, task.id);
  if (!art || !art.manifest.files.length) throw new ReviewError('沒有收集到產出物（驗證方案要設定「產出物」）', 404);
  const repo = task.repo_path ? path.basename(task.repo_path) : 'task';
  const tag = (task.approved_at ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '');
  return { name: `${repo}-${task.id}-${tag}.zip`, data: packageZip(task.id, art.run_id, art.manifest, deliveryReport(db, task, art.manifest)) };
}

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function releaseTask(
  db: Database.Database,
  task: Task,
  input: { tag?: string | null; name?: string | null },
  by: string,
  deps: { fetchImpl?: typeof fetch; token?: string } = {},
): Promise<{ url: string; asset_url: string | null }> {
  if (!task.approved_at) throw new ReviewError('核可後才能發佈');
  const giteaUrl = (getSetting(db, 'gitea_url') ?? '').trim();
  const token = deps.token ?? process.env.GITEA_TOKEN ?? '';
  if (!giteaUrl) throw new ReviewError('還沒設定 gitea_url（loop config set gitea_url http://…）');
  if (!token) throw new ReviewError('引擎的環境變數沒有 GITEA_TOKEN（~/.config/loop-engineering/env）');
  if (!task.repo_path) throw new ReviewError('這個任務沒有 repo');
  let origin = '';
  try {
    origin = execFileSync('git', ['-C', task.repo_path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    throw new ReviewError('這個 repo 沒有 origin');
  }
  const repo = giteaRepoFor(giteaUrl, origin);
  if (!repo) throw new ReviewError(`repo 的 origin（${origin}）不在 ${giteaUrl} 這台 Gitea 上`);
  const tag = (input.tag ?? '').trim() || `loop-${(task.approved_at ?? '').slice(0, 10).replace(/-/g, '')}-${task.id.replace(/^t_/, '')}`;
  if (!TAG_RE.test(tag)) throw new ReviewError('版本標籤只能用英數字與 . _ -（例如 v1.4.0）', 400);
  const zip = deliveryZip(db, task);
  const art = latestArtifacts(db, task.id)!;
  const r = await publishGiteaRelease(
    giteaUrl,
    token,
    repo,
    { tag, target: art.manifest.head_sha ?? task.base_branch ?? 'main', name: (input.name ?? '').trim() || `${task.title}（${tag}）`, body: deliveryReport(db, task, art.manifest) },
    { name: `${repo.repo}-${tag}.zip`, data: zip.data },
    deps.fetchImpl,
  );
  if (!r.url) throw new ReviewError(r.error ?? 'Gitea 沒有回傳 release 網址', 502);
  if (r.error) throw new ReviewError(`release 建好了但附件上傳失敗：${r.error}`, 502);
  db.prepare('UPDATE tasks SET release_url = ? WHERE id = ?').run(r.url, task.id);
  logEvent(db, { task_id: task.id, kind: 'note', detail: `發佈到 Gitea（${by}）：${r.url}` });
  return { url: r.url, asset_url: r.asset_url ?? null };
}

