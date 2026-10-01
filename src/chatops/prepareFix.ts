import type Database from 'better-sqlite3';
import { listRepos, type Repo } from '../repo/store.js';
import { createTicket, ticketView, TicketError } from '../intake/ticket.js';
import { analyseTicket, awaitAnalysis, type AnalyseDeps } from '../intake/analyse.js';
import { createPending } from './actions.js';
import { link } from './format.js';
import type { PrepareOutcome } from './prepare.js';
import type { ChatCtx } from './types.js';

/**
 * ops_prepare_fix: the chat's way to open a 問題單. The engine opens the ticket (a draft), runs the
 * same 分析 the ticket page runs, and prepares 「開始修」 as a pending action whose summary is the
 * compact 分析卡 — the person's 「確認」 starts it (startTicket: the gate, and a manager's 核可 in
 * manager mode). Nothing is queued before that reply. The description here is the model's words,
 * so a repro command in it is never dry-run (analyse.ts trusts only the ticket page's own text).
 */

export interface FixPrepDeps {
  analyse?: AnalyseDeps;
  /** how long to wait for the analysis before answering with what it has (default 150 s) */
  waitMs?: number;
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const no = (fact: string, question: string): PrepareOutcome => ({ ok: false, missing: [{ fact, question }] });

/** An imported repo by id, name, or (a suffix of) its remote URL. */
export function findRepo(db: Database.Database, ref: string): Repo | null {
  const want = ref.trim().replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
  if (!want) return null;
  const repos = listRepos(db).filter((r) => r.enabled);
  return (
    repos.find((r) => r.id.toLowerCase() === want || r.name.toLowerCase() === want) ??
    repos.find((r) => {
      const url = r.remote_url.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
      return url === want || url.endsWith(`/${want}`) || want.endsWith(url.replace(/^[a-z]+:\/\//, ''));
    }) ??
    null
  );
}

async function settle(id: string, ms: number): Promise<boolean> {
  let done = false;
  await Promise.race([awaitAnalysis(id).then(() => (done = true)), new Promise((r) => setTimeout(r, ms))]);
  return done;
}

export async function prepareFix(db: Database.Database, chat: ChatCtx, args: Record<string, unknown>, deps: FixPrepDeps = {}): Promise<PrepareOutcome> {
  const description = str(args.description);
  if (description.length < 10) return no('description', '發生什麼事、在哪裡、期望應該怎樣？（至少 10 個字）');
  const repoRef = str(args.repo, 300);
  const repo = repoRef ? findRepo(db, repoRef) : listRepos(db).filter((r) => r.enabled).length === 1 ? listRepos(db).find((r) => r.enabled)! : null;
  if (!repo) {
    const names = listRepos(db)
      .filter((r) => r.enabled)
      .map((r) => r.name)
      .slice(0, 8);
    return no(
      'repo',
      repoRef
        ? `「${repoRef}」還沒匯入 Loop：請到 Repo 頁貼網址匯入（/repos.html），之後再開單`
        : names.length
          ? `是哪個 repo？已匯入的有：${names.join('、')}`
          : '還沒有匯入任何 repo：請到 Repo 頁貼 Gitea 網址匯入（/repos.html）',
    );
  }
  const who = { user_key: chat.userKey, label: chat.label };
  let task;
  try {
    task = createTicket(db, { title: str(args.title, 120) || undefined, description, repo_id: repo.id, branch: str(args.branch, 200) || undefined, from: 'chat' }, who);
  } catch (err) {
    if (err instanceof TicketError) return no('description', err.message);
    throw err;
  }
  void analyseTicket(db, task.id, deps.analyse ?? {});
  const finished = await settle(task.id, deps.waitMs ?? 150_000);
  const v = ticketView(db, task, who);
  const a = v.analysis;
  const lines = [`開始修 ${v.id}「${v.title}」 · ${repo.name} @ ${v.branch}`];
  if (!finished || !a || v.analysis_status !== 'ready') {
    lines.push(`- 分析${v.analysis_status === 'failed' ? `沒有完成：${a?.error ?? ''}` : '還在跑'}；在問題單頁看完整的分析卡再開始`);
  } else {
    for (const c of a.causes.slice(0, 3)) lines.push(`- 可能位置：${c.file}${c.symbol ? ` · ${c.symbol}` : ''} — ${c.why}`);
    if (a.repro) lines.push(`- 重現：${a.repro.mode === 'command' ? a.repro.command : `先寫一個會失敗的測試（${a.repro.test_file ?? '測試檔由 Loop 決定'}）`}`);
    const on = a.checks.filter((c) => c.on);
    if (on.length) lines.push(`- 驗收：${on.map((c) => `${c.name}${c.required ? '（必過）' : ''}`).join('、')}`);
    lines.push(`- 模型：${a.conditions.model.label} · 預估 ${a.conditions.estimate.complexity}，約 ${a.conditions.estimate.minutes} 分`);
    for (const q of a.questions.slice(0, 3)) lines.push(`- Loop 還不確定：${q}`);
  }
  if (v.approval_mode === 'manager' && !v.is_manager) lines.push('- 主管核可模式：確認後會送出核可，主管核可後 Loop 才開始');
  const pending = createPending(db, chat, {
    kind: 'task',
    op: 'queue',
    target: task.id,
    params: { id: task.id, note: null },
    expect: { status: 'draft', merge_status: null, approved_at: null },
    summary: lines.join('\n'),
    risk: 'normal',
    speed: 'fast',
    links: [{ title: `${task.id} 分析卡`, url: `/fix.html?id=${encodeURIComponent(task.id)}` }, link.review(task.id)],
  });
  return { ok: true, action: pending, warnings: [] };
}
