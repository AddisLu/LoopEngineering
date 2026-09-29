import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db/index.js';
import { readMetrics, readVerify, readVerifyMd, type VerifiedStep } from '../orchestrator/runSummary.js';
import type { MetricsReport } from '../orchestrator/acceptance.js';
import { hhmm } from '../scheduler/policy.js';
import type { TaskStatus } from '../config.js';
import type { Task, TaskRun } from '../types.js';

/**
 * 晨報: what the engine did while nobody was watching — for the person who comes in at 8 and
 * wants to know, per task, "did it pass its acceptance metrics, and what do I have to do".
 * Built from what the runs recorded (task_runs.verify_json / metrics_json, the last status
 * change), so it reads the same whether the task ran on a cloud or a local model. Read-only.
 */

export type MorningOutcome = 'attention' | 'failed' | 'pass' | 'manual' | 'blocked' | 'running' | 'queued';

export const OUTCOME_LABEL: Record<MorningOutcome, string> = {
  attention: '要你處理',
  failed: '失敗',
  pass: '驗收通過',
  manual: '待人工驗收',
  blocked: '中斷，會自動續跑',
  running: '執行中',
  queued: '還沒輪到',
};

const OUTCOME_ICON: Record<MorningOutcome, string> = {
  attention: '⚠',
  failed: '✖',
  pass: '✅',
  manual: '📝',
  blocked: '⏸',
  running: '▶',
  queued: '…',
};

/** what needs a person first */
const ORDER: MorningOutcome[] = ['attention', 'failed', 'pass', 'manual', 'blocked', 'running', 'queued'];

export interface MorningRun {
  id: string;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  minutes: number | null;
  error: string | null;
  interrupted_by: string | null;
}

export interface MorningTask {
  id: string;
  title: string;
  status: TaskStatus;
  outcome: MorningOutcome;
  model: string | null;
  repo: string | null;
  base: string | null;
  merge_status: string | null;
  pr_url: string | null;
  /** runs started inside the report window */
  runs: number;
  run: MorningRun | null;
  /** the last verification (may be an earlier attempt than `run`) */
  steps: VerifiedStep[];
  failed_step: VerifiedStep | null;
  metrics: MetricsReport | null;
  thresholds: string | null;
  verify_md: string | null;
  /** why it is where it is: the detail of the change into its current status */
  reason: string | null;
}

export interface MorningReport {
  since: string;
  generated_at: string;
  hours: number;
  local_task_window: string;
  /** "1 要你處理、2 驗收通過" (or "沒有任務") */
  summary: string;
  headline: string;
  counts: Record<MorningOutcome, number>;
  tasks: MorningTask[];
}

/** SQLite's datetime('now') format (UTC), so string comparison orders correctly */
const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const parseSql = (s: string | null) => (s ? new Date(`${s.replace(' ', 'T')}Z`) : null);

function outcomeOf(task: Task, steps: VerifiedStep[], metrics: MetricsReport | null): MorningOutcome {
  switch (task.status) {
    case 'attention':
      return 'attention';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'running':
    case 'verifying':
      return 'running';
    case 'queued':
    case 'ready':
    case 'draft':
      return 'queued';
    default: {
      // review / closed: passed = the engine measured it; otherwise a person still has to
      const measured = steps.length > 0 && steps.every((s) => s.ok) && (!metrics || metrics.pass);
      return measured ? 'pass' : 'manual';
    }
  }
}

export function buildMorningReport(db: Database.Database, opts: { hours?: number; now?: Date } = {}): MorningReport {
  const now = opts.now ?? new Date();
  const hours = Math.min(24 * 14, Math.max(1, opts.hours ?? 24));
  const since = new Date(now.getTime() - hours * 3_600_000);
  const s = sqlTime(since);

  // ran in the window, is still going or waiting, or landed on a person's desk in the window.
  // Benchmark arms have their own page; a task someone merely closed by hand is not news.
  const ids = db
    .prepare(
      `SELECT id FROM tasks t WHERE benchmark_id IS NULL AND (
         EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = t.id AND (r.started_at >= @s OR r.finished_at >= @s))
         OR status IN ('running', 'verifying', 'queued', 'blocked')
         OR (status IN ('attention', 'failed') AND updated_at >= @s))`,
    )
    .all({ s }) as { id: string }[];

  const lastRun = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1');
  const lastVerified = db.prepare(
    'SELECT * FROM task_runs WHERE task_id = ? AND verify_json IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1',
  );
  const lastWorktree = db.prepare(
    'SELECT worktree_path FROM task_runs WHERE task_id = ? AND worktree_path IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1',
  );
  const runsInWindow = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE task_id = ? AND started_at >= ?');
  const statusDetail = db.prepare(
    "SELECT detail FROM task_events WHERE task_id = ? AND kind = 'status' AND to_status = ? ORDER BY id DESC LIMIT 1",
  );
  const getTask = db.prepare('SELECT * FROM tasks WHERE id = ?');

  const tasks: MorningTask[] = [];
  for (const { id } of ids) {
    const task = getTask.get(id) as Task | undefined;
    if (!task) continue;
    const run = lastRun.get(id) as TaskRun | undefined;
    const verified = lastVerified.get(id) as TaskRun | undefined;
    const steps = readVerify(verified);
    const metrics = readMetrics(verified);
    const outcome = outcomeOf(task, steps, metrics);
    const started = parseSql(run?.started_at ?? null);
    const finished = parseSql(run?.finished_at ?? null);
    const wt = (lastWorktree.get(id) as { worktree_path: string } | undefined)?.worktree_path ?? null;
    const reason =
      outcome === 'attention' || outcome === 'failed' || outcome === 'blocked' || outcome === 'manual'
        ? ((statusDetail.get(id, task.status) as { detail: string | null } | undefined)?.detail ?? null)
        : null;
    tasks.push({
      id: task.id,
      title: task.title,
      status: task.status,
      outcome,
      model: run?.model ?? task.model ?? null,
      repo: task.repo_path ? path.basename(task.repo_path) : null,
      base: task.base_branch,
      merge_status: task.merge_status,
      pr_url: task.pr_url,
      runs: (runsInWindow.get(id, s) as { n: number }).n,
      run: run
        ? {
            id: run.id,
            attempt: run.attempt,
            started_at: run.started_at,
            finished_at: run.finished_at,
            minutes: started && finished ? Math.max(0, Math.round((finished.getTime() - started.getTime()) / 60_000)) : null,
            error: run.error,
            interrupted_by: run.interrupted_by,
          }
        : null,
      steps,
      failed_step: steps.find((x) => !x.ok) ?? null,
      metrics,
      thresholds: task.acceptance_metrics ?? null,
      verify_md: outcome === 'queued' ? null : readVerifyMd(wt, 2000),
      reason,
    });
  }

  const finishedAt = (t: MorningTask) => t.run?.finished_at ?? t.run?.started_at ?? '';
  tasks.sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) || finishedAt(b).localeCompare(finishedAt(a)));

  const counts = Object.fromEntries(ORDER.map((o) => [o, 0])) as Record<MorningOutcome, number>;
  for (const t of tasks) counts[t.outcome] += 1;
  const summary = tasks.length ? ORDER.filter((o) => counts[o] > 0).map((o) => `${counts[o]} ${OUTCOME_LABEL[o]}`).join('、') : '沒有任務';
  const headline = tasks.length ? `過去 ${hours} 小時 ${tasks.length} 個任務：${summary}` : `過去 ${hours} 小時沒有任務執行`;

  return {
    since: since.toISOString(),
    generated_at: now.toISOString(),
    hours,
    local_task_window: getSetting(db, 'local_task_window') ?? '',
    summary,
    headline,
    counts,
    tasks,
  };
}

const MERGE_LABEL: Record<string, string> = {
  merged: '已併入',
  pending: '待合併',
  conflict: '合併衝突（已建解衝突任務）',
};

/** "detection_rate 0.991（>= 0.98）✅；miss 0（== 0）✅" */
export function metricsLine(m: MetricsReport | null): string | null {
  if (!m?.checks.length) return null;
  return m.checks.map((c) => `${c.name} ${c.actual ?? '沒回報'}（${c.op} ${c.target}）${c.pass ? '✅' : '❌'}`).join('；');
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Plain text for the terminal (`loop morning`). */
export function formatMorningText(r: MorningReport): string {
  const out: string[] = [r.headline];
  if (r.local_task_window) out.push(`本地模型任務時段：${r.local_task_window}`);
  for (const t of r.tasks) {
    out.push('', `${OUTCOME_ICON[t.outcome]} ${OUTCOME_LABEL[t.outcome]}  ${t.id}  ${t.title}`);
    const meta = [
      t.model ?? '預設模型',
      t.repo ? `${t.repo}${t.base ? `@${t.base}` : ''}` : null,
      t.runs ? `本時段 ${t.runs} 次執行` : null,
      t.run?.minutes != null ? `最後一次 ${t.run.minutes} 分鐘` : null,
    ].filter(Boolean);
    out.push(`   ${meta.join(' · ')}`);
    if (t.reason) out.push(`   原因：${oneLine(t.reason, 300)}`);
    if (t.steps.length) {
      const ok = t.steps.filter((x) => x.ok).length;
      out.push(`   驗證：${ok}/${t.steps.length} 步通過${t.failed_step ? `；失敗在 ${t.failed_step.step}${t.failed_step.timedOut ? '（逾時）' : t.failed_step.exitCode != null ? `（exit ${t.failed_step.exitCode}）` : ''}` : ''}`);
      if (t.failed_step?.tail) for (const line of t.failed_step.tail.split('\n').slice(-6)) out.push(`     | ${line}`);
    }
    const ml = metricsLine(t.metrics);
    if (ml) out.push(`   指標：${ml}`);
    else if (t.thresholds && t.outcome !== 'queued') out.push(`   指標：沒有量到（門檻 ${t.thresholds}）`);
    if (t.merge_status) out.push(`   合併：${MERGE_LABEL[t.merge_status] ?? t.merge_status}${t.merge_status === 'merged' && t.base ? ` ${t.base}` : ''}`);
    if (t.pr_url) out.push(`   PR：${t.pr_url}`);
    if (t.verify_md) out.push(`   人工驗收：VERIFY.md 有 ${t.verify_md.split('\n').filter((l) => /^\s*[-*] \[ \]/.test(l)).length} 項待勾`);
  }
  return out.join('\n');
}

/** The ntfy push: a title with the counts, one line per task (needs-a-person first). */
export function morningPush(r: MorningReport, link: string): { title: string; message: string; priority: 'default' | 'high'; tags: string[]; click: string } {
  const lines = r.tasks.slice(0, 8).map((t) => {
    const why =
      t.outcome === 'pass' ? metricsLine(t.metrics) ?? `${t.steps.length} 步驗證通過`
      : t.failed_step ? `失敗在 ${t.failed_step.step}`
      : t.reason ?? '';
    return `${OUTCOME_ICON[t.outcome]} ${oneLine(t.title, 40)}${why ? ` — ${oneLine(why, 80)}` : ''}`;
  });
  if (r.tasks.length > 8) lines.push(`…還有 ${r.tasks.length - 8} 個`);
  const urgent = r.counts.attention + r.counts.failed > 0;
  return {
    title: `Loop 晨報：${r.summary}`,
    message: lines.length ? lines.join('\n') : r.headline,
    priority: urgent ? 'high' : 'default',
    tags: [urgent ? 'warning' : 'sunrise'],
    click: link,
  };
}

/**
 * Is today's push due? Once per local day, from `morning_report_time` until 3h after it — an
 * engine that was down at 8:00 catches up at 9:30, but not in the evening when nobody needs it.
 */
export function morningDue(db: Database.Database, now: Date): string | null {
  const at = getSetting(db, 'morning_report_time') ?? '';
  if (!/^\d{2}:\d{2}$/.test(at)) return null;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (getSetting(db, 'morning_report_last') === today) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  const t = hhmm(at);
  return cur >= t && cur < t + 180 ? today : null;
}

/** Called from the server loop each tick: builds and pushes the report once a day. */
export async function pumpMorningReport(
  db: Database.Database,
  now: Date,
  send: (push: ReturnType<typeof morningPush>) => Promise<void>,
): Promise<boolean> {
  const today = morningDue(db, now);
  if (!today) return false;
  // mark first: a slow or failing push must not repeat every minute
  setSetting(db, 'morning_report_last', today);
  const base = (process.env.LOOP_PUBLIC_URL || `http://127.0.0.1:${process.env.LOOP_PORT ?? '4711'}`).replace(/\/$/, '');
  await send(morningPush(buildMorningReport(db, { now }), `${base}/morning.html`));
  return true;
}
