import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import { getBool, getNum, getSetting, logEvent, setSetting } from '../db/index.js';
import { getTask, getTaskBySourceRef, latestRun } from '../tasks.js';
import { giteaClientFor, type GiteaClient, type GiteaIssue } from '../git/gitea.js';
import { readVerify } from '../orchestrator/runSummary.js';
import { readSelfReview } from '../review/selfReview.js';

/**
 * Gitea issues ↔ 問題單: a ticket that came from an issue reports back on it (Loop 已接單, the
 * analysis, 開始修, one live check-status comment edited in place, the PR, 退回, 已合併), and a repo
 * with an `issue_label` has its labelled issues turned into tickets by a poller. Nothing here runs
 * unless gitea_url + GITEA_TOKEN are set AND the ticket has an issue link (comments) or a repo has a
 * label (poller) — every other deployment behaves exactly as before. Never throws.
 */

export type IssueUpdateKind = 'accepted' | 'analysis' | 'started' | 'verify' | 'pr' | 'returned' | 'done';

export interface IssueLink {
  task_id: string;
  repo_id: string | null;
  owner: string;
  repo: string;
  number: number;
  issue_url: string;
  posted_json: string;
  closed_at: string | null;
}

export interface IssueDeps {
  client?: GiteaClient | null;
  publicUrl?: string;
}

export function linkIssue(db: Database.Database, taskId: string, ref: { repoId: string | null; owner: string; repo: string; number: number; url: string }): void {
  db.prepare(
    `INSERT OR IGNORE INTO issue_links (task_id, repo_id, owner, repo, number, issue_url) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, ref.repoId, ref.owner, ref.repo, ref.number, ref.url);
}

export function getIssueLink(db: Database.Database, taskId: string): IssueLink | null {
  return (db.prepare('SELECT * FROM issue_links WHERE task_id = ?').get(taskId) as IssueLink | undefined) ?? null;
}

function posted(link: IssueLink): Record<string, number> {
  try {
    const v = JSON.parse(link.posted_json || '{}') as Record<string, number>;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function pageUrl(deps: IssueDeps, pathAndQuery: string): string | null {
  const base = (deps.publicUrl ?? process.env.LOOP_PUBLIC_URL ?? '').replace(/\/$/, '');
  return base ? `${base}${pathAndQuery}` : null;
}

function kindLabel(task: Task): string {
  try {
    const a = task.analysis_json ? (JSON.parse(task.analysis_json) as { kind?: string }) : null;
    const k = a?.kind ?? (task.intake_json ? (JSON.parse(task.intake_json) as { kind_hint?: string }).kind_hint : null);
    return ({ bugfix: '錯誤修復', feature: '功能', perf: '效能', algo: '演算法' } as Record<string, string>)[k ?? ''] ?? '問題';
  } catch {
    return '問題';
  }
}

/** The comment text for one update (Markdown, Traditional Chinese). */
export function issueComment(db: Database.Database, task: Task, kind: IssueUpdateKind, deps: IssueDeps = {}, extra: { feedback?: string } = {}): string {
  const ticketLink = pageUrl(deps, `/fix.html?id=${encodeURIComponent(task.id)}`);
  const resultLink = pageUrl(deps, `/task.html?id=${encodeURIComponent(task.id)}`);
  const sig = '\n\n<sub>— Loop Engineering（本地模型，不經雲端）</sub>';
  switch (kind) {
    case 'accepted':
      return `Loop 已接單，正在分析。${ticketLink ? `\n\n分析卡：${ticketLink}` : ''}${sig}`;
    case 'analysis': {
      let causes: string[] = [];
      let checks: string[] = [];
      try {
        const a = task.analysis_json ? (JSON.parse(task.analysis_json) as { causes?: { file: string; why: string }[]; checks?: { name: string; on?: boolean }[] }) : null;
        causes = (a?.causes ?? []).slice(0, 3).map((c) => `- \`${c.file}\`：${c.why}`);
        checks = (a?.checks ?? []).filter((c) => c.on !== false).map((c) => `- [ ] ${c.name}`);
      } catch {
        /* nothing to list */
      }
      return [
        `**Loop 的分析**（${kindLabel(task)}）`,
        causes.length ? `\n可能原因與位置：\n${causes.join('\n')}` : '',
        checks.length ? `\n驗收清單：\n${checks.join('\n')}` : '',
        ticketLink ? `\n完整的分析卡（可以在那裡調整、按「開始修」）：${ticketLink}` : '',
      ].join('\n') + sig;
    }
    case 'started':
      return `Loop 開始修了（模型：${task.model ?? '預設'}）。修好、檢查都過之後會在這裡貼 PR。${resultLink ? `\n\n進度：${resultLink}` : ''}${sig}`;
    case 'verify': {
      const steps = readVerify(latestRun(db, task.id));
      const rows = steps.map((s) => `| ${s.ok ? '✅' : '❌'} | ${s.step.replace(/\|/g, '\\|')} | ${s.timedOut ? '逾時' : s.exitCode ?? ''} |`);
      const head = steps.length && steps.every((s) => s.ok) ? '檢查都過了' : steps.length ? '檢查有沒過的，Loop 正在修' : '正在跑檢查';
      return [`**檢查狀態：${head}**（這則留言會隨進度更新）`, rows.length ? `\n| | 檢查 | exit |\n|---|---|---|\n${rows.join('\n')}` : '', resultLink ? `\n\n${resultLink}` : ''].join('') + sig;
    }
    case 'pr': {
      const r = readSelfReview(task);
      const summary = r ? `\n\n改了什麼：\n${r.summary.map((s) => `- ${s}`).join('\n')}` : '';
      return `PR：${task.pr_url ?? '（見結果頁）'}${summary}${resultLink ? `\n\n結果頁：${resultLink}` : ''}${sig}`;
    }
    case 'returned':
      return `驗收退回修改，Loop 會在同一個分支接著改：\n\n> ${(extra.feedback ?? '').trim().slice(0, 800).replace(/\n/g, '\n> ')}${sig}`;
    case 'done':
      return `已合併到 \`${task.base_branch ?? 'main'}\`。${task.pr_url ? `\n\nPR：${task.pr_url}` : ''}${sig}`;
  }
}

/**
 * Post (or, for 'verify', edit in place) one update on the ticket's issue. Idempotent per kind except
 * 'returned' (every return is news) and 'verify' (one comment, edited). Returns true when Gitea took it.
 */
export async function postIssueUpdate(
  db: Database.Database,
  taskOrId: Task | string,
  kind: IssueUpdateKind,
  deps: IssueDeps = {},
  extra: { feedback?: string; closeIssue?: boolean } = {},
): Promise<boolean> {
  try {
    const task = typeof taskOrId === 'string' ? getTask(db, taskOrId) : getTask(db, taskOrId.id) ?? taskOrId;
    if (!task) return false;
    const link = getIssueLink(db, task.id);
    if (!link) return false;
    if (!getBool(db, 'gitea_issue_comments', true)) return false;
    if (task.repo_id) {
      const repo = db.prepare('SELECT issue_comments FROM repos WHERE id = ?').get(task.repo_id) as { issue_comments: number } | undefined;
      if (repo && !repo.issue_comments) return false;
    }
    const client = deps.client === undefined ? giteaClientFor(db) : deps.client;
    if (!client) return false;
    const done = posted(link);
    const body = issueComment(db, task, kind, deps, extra);
    let ok = false;
    let commentId: number | null = null;
    if (kind === 'verify' && done.verify) {
      const r = await client.editIssueComment(link.owner, link.repo, done.verify, body);
      ok = r.ok;
      if (!r.ok) {
        // the comment was deleted on Gitea: post a fresh one
        const c = await client.createIssueComment(link.owner, link.repo, link.number, body);
        ok = c.ok;
        if (c.ok) commentId = c.data.id;
      }
    } else if (kind !== 'returned' && done[kind]) {
      return true; // already said
    } else {
      const r = await client.createIssueComment(link.owner, link.repo, link.number, body);
      ok = r.ok;
      if (r.ok) commentId = r.data.id;
      else logEvent(db, { task_id: task.id, kind: 'note', detail: `Gitea issue #${link.number} 留言失敗：${r.error}` });
    }
    if (commentId !== null) {
      const key = kind === 'returned' ? `returned_${Object.keys(done).filter((k) => k.startsWith('returned')).length + 1}` : kind;
      db.prepare('UPDATE issue_links SET posted_json = ? WHERE task_id = ?').run(JSON.stringify({ ...done, [key]: commentId }), task.id);
    }
    if (kind === 'done' && extra.closeIssue && !link.closed_at) {
      const c = await client.closeIssue(link.owner, link.repo, link.number);
      if (c.ok) db.prepare("UPDATE issue_links SET closed_at = datetime('now') WHERE task_id = ?").run(task.id);
    }
    return ok;
  } catch (err) {
    try {
      logEvent(db, { task_id: typeof taskOrId === 'string' ? taskOrId : taskOrId.id, kind: 'note', detail: `Gitea issue 回報失敗：${String(err).slice(0, 200)}` });
    } catch {
      /* the db is gone too */
    }
    return false;
  }
}

/** Fire-and-forget wrapper for lifecycle hooks: never awaited, never throws. */
export function reportIssue(db: Database.Database, task: Task | string, kind: IssueUpdateKind, extra: { feedback?: string; closeIssue?: boolean } = {}): void {
  void postIssueUpdate(db, task, kind, {}, extra).catch(() => false);
}

export interface PollDeps extends IssueDeps {
  /** turns one labelled issue into a ticket (src/intake/ticket.ts ticketFromIssue); returns the task or null */
  createFromIssue: (db: Database.Database, ref: { owner: string; repo: string; number: number; issue: GiteaIssue; repoId: string }) => Promise<Task | null>;
  now?: () => number;
}

let lastPollAt = 0;

/** Test seam: forget the in-memory throttle. */
export function resetIssuePoller(): void {
  lastPollAt = 0;
}

/**
 * Every gitea_poll_interval_min: for each enabled repo with an issue_label, open issues carrying the
 * label that are not tickets yet become tickets (idempotent by source_ref gitea:owner/repo#n), and get
 * a 「Loop 已接單」 comment. Returns how many tickets it opened.
 */
export async function pumpGiteaIssues(db: Database.Database, deps: PollDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const everyMs = Math.max(1, getNum(db, 'gitea_poll_interval_min', 10)) * 60_000;
  if (now - lastPollAt < everyMs) return 0;
  const repos = db
    .prepare("SELECT id, gitea_owner, gitea_repo, issue_label FROM repos WHERE enabled = 1 AND issue_label IS NOT NULL AND issue_label <> '' AND gitea_owner IS NOT NULL AND gitea_repo IS NOT NULL")
    .all() as { id: string; gitea_owner: string; gitea_repo: string; issue_label: string }[];
  if (!repos.length) return 0;
  const client = deps.client === undefined ? giteaClientFor(db) : deps.client;
  if (!client) return 0;
  lastPollAt = now;
  const since = getSetting(db, 'gitea_issue_cursor') || undefined;
  let opened = 0;
  let allOk = true;
  for (const r of repos) {
    const list = await client.listIssues(r.gitea_owner, r.gitea_repo, { labels: r.issue_label, state: 'open', since, limit: 50 });
    if (!list.ok) {
      allOk = false;
      logEvent(db, { kind: 'note', detail: `Gitea 問題單輪詢（${r.gitea_owner}/${r.gitea_repo}）失敗：${list.error}` });
      continue;
    }
    for (const issue of list.data) {
      const ref = `gitea:${r.gitea_owner}/${r.gitea_repo}#${issue.number}`;
      if (getTaskBySourceRef(db, ref)) continue;
      try {
        const task = await deps.createFromIssue(db, { owner: r.gitea_owner, repo: r.gitea_repo, number: issue.number, issue, repoId: r.id });
        if (!task) continue;
        linkIssue(db, task.id, { repoId: r.id, owner: r.gitea_owner, repo: r.gitea_repo, number: issue.number, url: issue.html_url });
        opened += 1;
        await postIssueUpdate(db, task, 'accepted', { ...deps, client });
      } catch (err) {
        logEvent(db, { kind: 'note', detail: `Gitea issue ${ref} 開單失敗：${String(err).slice(0, 200)}` });
      }
    }
  }
  // only move the cursor when every repo answered, so a failed poll is retried from the same point
  if (allOk) setSetting(db, 'gitea_issue_cursor', new Date(now - 60_000).toISOString());
  return opened;
}
