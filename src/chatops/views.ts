import type Database from 'better-sqlite3';
import type { ToolSource } from '../chat/tools.js';
import { getTask } from '../tasks.js';
import type { Task } from '../types.js';
import { readUsage } from '../token/usage.js';
import type { UsageReading } from '../types.js';
import { taskHistory } from '../orchestrator/history.js';
import { humanNote } from '../benchmark/attempts.js';
import { benchmarkMatrix, benchmarkRecommendations, getBenchmark, listBenchmarks, type BenchmarkArmView } from '../benchmark/store.js';
import { listBuiltin } from '../benchmark/source.js';
import { getScreen, listScreens, type ScreenGroup } from '../benchmark/screen.js';
import { getPlan, listPlans } from '../plans/store.js';
import { listJobRepos } from '../plans/job.js';
import { listLocalModels } from '../local/models.js';
import { annotateLocalModel, type LocalGuardDeps } from '../local/guard.js';
import { checklistFor } from '../review/review.js';
import { STATUS_WORD, actionView, findAction, listActions } from './actions.js';
import { BENCH_WORD, TASK_WORD, link, minutes, modelName, pct, table, toMs, when } from './format.js';
import { templateLines } from './templates.js';
import type { OpsAction } from './types.js';

/**
 * The read-only side of 對話操作: what is going on, one task or benchmark, the standings, and the
 * templates. Each view is `{ markdown, data, links }` — the markdown is what the chat model reads
 * and pastes, data is for the API, links go on the card.
 */

export interface View {
  markdown: string;
  data: unknown;
  links: ToolSource[];
}

export interface ViewDeps extends LocalGuardDeps {
  usage?: () => UsageReading;
  localState?: () => { loaded: string | null; status: string } | null;
  now?: () => Date;
}

const CLOUD_MODELS = ['sonnet', 'opus', 'haiku', 'fable-5'];

/** Why a task needs a person, in the user's words. */
function why(t: Task, lastDetail: string | null): string {
  if (t.status === 'review') {
    if (t.merge_status === 'conflict') return '合併衝突（已建解衝突任務）';
    if (t.merge_status === 'merged') return '已合併，待結案';
    if (t.merge_status === 'pending') return manual(t) && !t.approved_at ? '驗證過了，待人工核可' : '驗證過了，待合併';
    return '驗證過了，待結案';
  }
  const d = (lastDetail ?? '').split('\n')[0] ?? '';
  const m = /^verify failed(?: \(resumable [^)]*\))? at: (.*)$/i.exec(d);
  if (m) return `驗證沒過：${m[1]}`;
  return d ? humanNote(d).slice(0, 60) : TASK_WORD[t.status] ?? t.status;
}

const manual = (t: Pick<Task, 'verify_mode'>) =>
  String(t.verify_mode || '')
    .split(',')
    .map((s) => s.trim())
    .includes('manual');

/** What the person can say next about this task — the sentences 對話操作 understands. */
export function nextSayings(t: Task): string[] {
  const id = t.id;
  if (t.benchmark_id && !['closed', 'failed'].includes(t.status)) return [`看評比 ${t.benchmark_id}`];
  switch (t.status) {
    case 'draft':
      return [`排入 ${id}`, `刪除 ${id}`];
    case 'running':
    case 'verifying':
      return [`中止 ${id}`];
    case 'blocked':
      return [`轉待確認 ${id}`];
    case 'attention':
      return [`續跑 ${id}`, `重來 ${id}`, `放棄 ${id}`];
    case 'review':
      if (t.merge_status === 'merged') return [`結案 ${id}`];
      if (t.merge_status === 'pending' && manual(t) && !t.approved_at) return [`核可 ${id}`, `退回修改 ${id}`];
      if (t.merge_status === 'pending' || t.merge_status === 'conflict') return [`合併 ${id}`, `退回修改 ${id}`];
      return [`結案 ${id}`];
    case 'failed':
      return [`重來 ${id}`, `結案 ${id}`];
    default:
      return [];
  }
}

function lastStatusDetail(db: Database.Database, taskId: string): string | null {
  const r = db
    .prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'status' AND detail IS NOT NULL AND detail != '' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { detail: string } | undefined;
  return r?.detail ?? null;
}

const tasksWhere = (db: Database.Database, where: string, args: unknown[] = [], limit = 20): Task[] =>
  db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(...args, limit) as Task[];

const localMidnightUtc = (now: Date): string => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

function usageLine(deps: ViewDeps): string {
  try {
    const u = (deps.usage ?? readUsage)();
    const s = `5 小時 ${Math.round(u.session.percent)}%・本週 ${Math.round(u.weekly.percent)}%`;
    return u.error ? `${s}（讀數：${String(u.error).slice(0, 40)}）` : s;
  } catch {
    return '讀不到';
  }
}

function localLine(db: Database.Database, deps: ViewDeps): string | null {
  const st = deps.localState?.() ?? null;
  if (!st) return null;
  const word = { ready: '就緒', starting: '載入中', idle: '沒有載入', error: '錯誤' }[st.status] ?? st.status;
  return st.loaded ? `${st.loaded}（${word}）` : word;
}

function actionLine(a: OpsAction): string {
  const res = a.status === 'done' || a.status === 'failed' ? `：${(a.result?.detail ?? a.error ?? '').split('\n')[0]!.slice(0, 60)}` : '';
  return `- ${a.code} ${a.summary.split('\n')[0]!.slice(0, 50)} — ${STATUS_WORD[a.status]}${res}`;
}

/** 現在的狀況: what needs the person, what runs, what waits, the benchmark, usage and the local model. */
export function overviewView(db: Database.Database, o: { userKey?: string | null; conversationId?: string | null } = {}, deps: ViewDeps = {}): View {
  const now = deps.now?.() ?? new Date();
  const counts = Object.fromEntries((db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
  const closedToday = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'closed' AND updated_at >= ?").get(localMidnightUtc(now)) as { n: number }).n;
  const need = tasksWhere(db, "status = 'attention' OR (status = 'review' AND merge_status = 'conflict')");
  const review = tasksWhere(db, "status = 'review' AND (merge_status IS NULL OR merge_status != 'conflict') AND benchmark_id IS NULL");
  const running = tasksWhere(db, "status IN ('running','verifying')");
  const waiting = tasksWhere(db, "status IN ('queued','ready','blocked')");
  const links: ToolSource[] = [link.board()];
  const out: string[] = [];
  const hhmm = when(now.toISOString()).slice(6);
  out.push(`## 現在的狀況（${hhmm}）`);
  out.push(
    `需要你處理 ${need.length}｜執行中 ${running.length}｜排隊／等續跑 ${waiting.length}｜待核可 ${review.length}｜今天結案 ${closedToday}`,
  );
  out.push(`用量：${usageLine(deps)}`);
  const lm = localLine(db, deps);
  if (lm) out.push(`本地模型：${lm}`);
  if (need.length) {
    out.push('', '### 需要你處理');
    out.push(table(['任務', '狀況', '你可以說'], need.map((t) => [`${t.id} ${t.title}`, why(t, lastStatusDetail(db, t.id)), nextSayings(t).join('／')])));
  }
  if (review.length) {
    out.push('', '### 待核可／待結案');
    out.push(table(['任務', '狀況', '你可以說'], review.map((t) => [`${t.id} ${t.title}`, why(t, null), nextSayings(t).join('／')])));
  }
  if (running.length) {
    out.push('', '### 執行中');
    out.push(
      table(
        ['任務', '模型', '已經跑了'],
        running.map((t) => {
          const run = db.prepare('SELECT started_at FROM task_runs WHERE task_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1').get(t.id) as { started_at: string } | undefined;
          const started = toMs(run?.started_at);
          return [`${t.id} ${t.title}`, modelName(t.model), started ? minutes(now.getTime() - started) : '—'];
        }),
      ),
    );
  }
  if (waiting.length) {
    out.push('', '### 排隊／等續跑');
    out.push(table(['任務', '狀態'], waiting.map((t) => [`${t.id} ${t.title}`, TASK_WORD[t.status] ?? t.status])));
  }
  const benches = listBenchmarks(db, 30).filter((b) => b.status === 'running' || b.status === 'judging' || (toMs(b.judged_at) ?? 0) > now.getTime() - 24 * 3600_000);
  if (benches.length) {
    out.push('', '### 評比');
    for (const b of benches.slice(0, 3)) {
      links.push(link.bench(b.id));
      out.push(
        b.status === 'judged'
          ? `- ${b.id}「${b.title}」已評分：勝出 ${b.winner_label ?? modelName(b.winner) ?? '（沒有組別過關）'}`
          : `- ${b.id}「${b.title}」${BENCH_WORD[b.status] ?? b.status}：${b.arms_done}/${b.arm_count} 組完成`,
      );
    }
  }
  const screens = listScreens(db, 5).filter((g) => g.status === 'running' || g.status === 'queued' || (toMs(g.created_at) ?? 0) > now.getTime() - 24 * 3600_000);
  if (screens.length) {
    out.push('', '### 模型快篩');
    for (const g of screens.slice(0, 3)) {
      links.push(link.screen(g.group));
      out.push(`- ${screenLine(g)}`);
    }
  }
  if (o.userKey) {
    const recent = listActions(db, { userKey: o.userKey, conversationId: o.conversationId ?? null, limit: 3 });
    if (recent.length) out.push('', '### 最近的對話操作', ...recent.map(actionLine));
  }
  if (!need.length && !review.length && !running.length && !waiting.length) out.push('', '目前沒有進行中或要你處理的任務。');
  return { markdown: out.join('\n'), data: { counts, closed_today: closedToday, need: need.map((t) => t.id), review: review.map((t) => t.id), running: running.map((t) => t.id), waiting: waiting.map((t) => t.id) }, links };
}

const STATUS_FILTER: Record<string, string[]> = {
  attention: ['attention'],
  running: ['running', 'verifying'],
  queued: ['queued', 'ready', 'blocked'],
  review: ['review'],
  failed: ['failed'],
  draft: ['draft'],
  closed: ['closed'],
};

/** 找任務／評比 by words in the title (or goal), by id, and by state. */
export function findView(db: Database.Database, o: { q?: string; status?: string; kind?: 'task' | 'benchmark' | 'any'; limit?: number } = {}): View {
  const q = String(o.q ?? '').trim();
  const limit = Math.min(15, Math.max(1, o.limit ?? 8));
  const kind = o.kind ?? 'any';
  const rows: Array<{ type: string; id: string; title: string; status: string; updated_at: string }> = [];
  if (kind !== 'benchmark') {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q) {
      where.push('(id = ? OR title LIKE ? OR goal LIKE ?)');
      args.push(q, `%${q}%`, `%${q}%`);
    }
    const st = o.status && o.status !== 'any' ? STATUS_FILTER[o.status] : null;
    if (st) where.push(`status IN (${st.map(() => '?').join(',')})`), args.push(...st);
    for (const t of tasksWhere(db, where.length ? where.join(' AND ') : '1=1', args, limit)) {
      rows.push({ type: '任務', id: t.id, title: t.title, status: TASK_WORD[t.status] ?? t.status, updated_at: t.updated_at });
    }
  }
  if (kind !== 'task' && (!o.status || o.status === 'any' || o.status === 'running')) {
    for (const b of listBenchmarks(db, 50)) {
      if (q && b.id !== q && !b.title.toLowerCase().includes(q.toLowerCase())) continue;
      if (o.status === 'running' && b.status !== 'running' && b.status !== 'judging') continue;
      rows.push({ type: '評比', id: b.id, title: b.title, status: BENCH_WORD[b.status] ?? b.status, updated_at: b.judged_at ?? b.created_at });
      if (rows.length >= limit * 2) break;
    }
  }
  rows.sort((a, b) => (toMs(b.updated_at) ?? 0) - (toMs(a.updated_at) ?? 0));
  const shown = rows.slice(0, limit);
  const markdown = shown.length
    ? `## 找到 ${shown.length} 筆${q ? `「${q}」` : ''}\n${table(['類型', 'id', '名稱', '狀態', '更新'], shown.map((r) => [r.type, r.id, r.title, r.status, when(r.updated_at)]))}`
    : `沒有找到${q ? `「${q}」` : ''}${o.status && o.status !== 'any' ? `（狀態：${o.status}）` : ''}。`;
  return { markdown, data: { items: shown }, links: shown.map((r) => (r.type === '評比' ? link.bench(r.id) : link.task(r.id))) };
}

function taskShow(db: Database.Database, t: Task): View {
  const h = taskHistory(db, t.id);
  const out: string[] = [`## ${t.id} ${t.title}`];
  out.push(`狀態：${TASK_WORD[t.status] ?? t.status}${t.status === 'attention' || t.status === 'review' ? `（${why(t, h?.last_detail ?? null)}）` : ''}｜模型：${modelName(t.model)}${t.repo_path ? `｜repo：${t.repo_path.split('/').pop()} · ${t.base_branch ?? 'main'}` : ''}`);
  const iters = h?.iterations;
  if (iters && iters.attempts.length) {
    out.push(`嘗試：${iters.label}`);
    const last = iters.attempts.slice(-3).map((a) => [`第 ${a.attempt} 次`, a.finished_at ? (a.outcome === 'pass' ? '通過' : a.outcome === 'metrics' ? '指標未達' : a.outcome === 'functional' ? '功能沒過' : a.outcome === 'protected' ? '改了保護路徑' : '沒跑到驗證') : '進行中', when(a.started_at)]);
    out.push(table(['嘗試', '結果', '開始'], last));
  }
  if (t.status === 'review' && manual(t) && !t.approved_at) {
    const unchecked = checklistFor(db, t).filter((c) => !c.checked);
    if (unchecked.length) out.push(`人工驗收還差 ${unchecked.length} 項（要在驗收頁勾，對話不會代勾）：${unchecked.slice(0, 3).map((c) => c.text.slice(0, 40)).join('；')}`);
  }
  if (t.approved_at) out.push(`已由 ${t.approved_by} 核可`);
  const say = nextSayings(t);
  if (say.length) out.push(`你可以說：${say.map((s) => `「${s}」`).join('、')}`);
  return { markdown: out.join('\n'), data: { task: { id: t.id, status: t.status, merge_status: t.merge_status }, stages: h?.stages ?? null }, links: [link.task(t.id), link.review(t.id)] };
}

/** One line for a 快篩 batch: who, how far, how many passed. */
function screenLine(g: ScreenGroup): string {
  const who = g.models.map(modelName).join('、');
  if (g.status === 'queued') return `${g.group} 快篩 ${who}：排隊中（等目前的評比跑完）`;
  if (g.status === 'running') return `${g.group} 快篩 ${who}：進行中，${g.done}/${g.total} 題跑完、${g.passed} 題通過`;
  if (g.status === 'cancelled') return `${g.group} 快篩 ${who}：已取消`;
  return `${g.group} 快篩 ${who}：${g.passed}/${g.total} 題通過`;
}

/** A 快篩 batch: model × question, pass or not, how long. */
function screenShow(group: string, g: ScreenGroup | null): View | null {
  if (!g) return null;
  const mark = { pass: '✓ 通過', fail: '✗ 沒過', running: '… 進行中', queued: '· 排隊中', cancelled: '— 已取消' } as const;
  const rows = g.cells.map((c) => [modelName(c.model), c.question, mark[c.outcome], c.duration_s != null ? minutes(c.duration_s * 1000) : '—', c.attempts_label ?? '—', c.failure ?? '']);
  const out = [`## ${screenLine(g)}`, `每題上限 ${g.budget_min} 分鐘；沒有評審、不花訂閱額度。`, table(['模型', '題目', '結果', '時間', '嘗試', '沒過的原因'], rows)];
  if (g.status === 'running' || g.status === 'queued') out.push(`你可以說：「取消快篩 ${g.group}」`);
  return { markdown: out.join('\n'), data: { screen: { group: g.group, status: g.status, passed: g.passed, total: g.total } }, links: [link.screen(group)] };
}

function benchShow(db: Database.Database, id: string): View | null {
  const d = getBenchmark(db, id);
  if (!d) return null;
  const b = d.benchmark;
  if (b.mode === 'screen' && b.screen_group) return screenShow(b.screen_group, getScreen(db, b.screen_group));
  const out: string[] = [`## ${b.id} ${b.title}`, `狀態：${BENCH_WORD[b.status] ?? b.status}｜領域：${b.domain}｜門檻：${b.acceptance_metrics || '驗證指令全部成功'}`];
  const base = parseJson<{ metrics?: Record<string, number> }>(b.baseline_json);
  const headName = /(\w+)\s*<=?/.exec(b.acceptance_metrics ?? '')?.[1] ?? null;
  const rows = [...d.arms].sort((x, y) => (x.judge_rank ?? 99) - (y.judge_rank ?? 99)).map((a: BenchmarkArmView) => {
    const fin = parseJson<{ outcome?: string; metrics?: Record<string, number> }>(a.final_json);
    const it = parseJson<{ label?: string }>(a.attempts_json);
    const val = headName && fin?.metrics ? fin.metrics[headName] : undefined;
    return [
      a.judge_rank ? `#${a.judge_rank}` : '—',
      modelName(a.model),
      TASK_WORD[a.task_status ?? ''] ?? a.task_status ?? '已刪除',
      fin?.outcome ? (fin.outcome === 'pass' ? '通過' : fin.outcome === 'metrics' ? '指標未達' : '沒過') : '—',
      val != null && headName ? `${headName} ${val}` : '—',
      a.judge_score ?? '—',
      it?.label ?? '—',
    ];
  });
  out.push(table(['名次', '模型', '任務', '最終量測', '主要指標', '評分', '迭代'], rows));
  if (base?.metrics && headName && base.metrics[headName] != null) out.push(`基準（參賽前的程式）：${headName} ${base.metrics[headName]}`);
  if (b.status === 'judged') out.push(`勝出：${b.winner ? modelName(b.winner) : '沒有組別過關'}${b.summary ? `\n評審摘要：${b.summary.slice(0, 300)}` : ''}`);
  return { markdown: out.join('\n'), data: { benchmark: { id: b.id, status: b.status, winner: b.winner } }, links: [link.bench(b.id)] };
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function actionShow(a: OpsAction): View {
  const v = actionView(a);
  const out = [`## 動作 ${a.code}（${STATUS_WORD[a.status]}）`, a.summary];
  if (a.result) out.push('', `結果：${a.result.detail}`);
  else if (a.error) out.push('', `錯誤：${a.error}`);
  if (a.status === 'pending') out.push('', `要執行就回覆「確認${a.risk === 'high' ? ` ${a.code}` : ''}」，不要就回覆「取消」。`);
  return { markdown: out.join('\n'), data: { action: v }, links: a.result?.links ?? [] };
}

/** A 驗證方案: what it runs, where, and the bar it sets. */
function planShow(db: Database.Database, id: string): View | null {
  const p = getPlan(db, id);
  if (!p) return null;
  const out = [`## ${p.id} ${p.name}`, `repo：${p.repo_path ? p.repo_path.split('/').pop() : '任何 repo'}｜機台：${p.host || '這台'}｜領域：${p.domain}`];
  if (p.description) out.push(p.description.slice(0, 200));
  out.push(`步驟：${p.steps.slice(0, 3).map((x) => `\`${x}\``).join('；')}${p.steps.length > 3 ? `（共 ${p.steps.length} 步）` : ''}`);
  out.push(`門檻：${p.metrics || '驗證指令全部成功'}`);
  const counts = [p.protected_paths.length ? `保護路徑 ${p.protected_paths.length} 條` : '', p.artifacts.length ? `產出物 ${p.artifacts.length} 項` : '', p.dataset_root ? `圖資在 ${p.dataset_root}` : '', p.manual_checks.length ? `人工清單 ${p.manual_checks.length} 項` : ''].filter(Boolean);
  if (counts.length) out.push(counts.join('｜'));
  out.push(`你可以說：「用驗證方案 ${p.name} 開一件新工作」、「用 ${p.name} 開一場評比」`);
  return { markdown: out.join('\n'), data: { plan: { id: p.id, name: p.name } }, links: [link.plan(p.id)] };
}

/** One task (t_…), benchmark (b_…), 驗證方案 (vp_…) or 對話操作 action (oa_… or its code). */
export function showView(db: Database.Database, id: string, o: { userKey?: string | null; conversationId?: string | null } = {}): View | null {
  const key = String(id ?? '').trim();
  if (key.startsWith('vp_')) return planShow(db, key);
  if (key.startsWith('sg_')) return screenShow(key, getScreen(db, key));
  if (key.startsWith('t_')) {
    const t = getTask(db, key);
    return t ? taskShow(db, t) : null;
  }
  if (key.startsWith('b_')) return benchShow(db, key);
  if (o.userKey) {
    const a = findAction(db, key, o.userKey, o.conversationId ?? null);
    if (a) return actionShow(a);
  }
  return null;
}

/** 哪個模型適合哪類工作: the recommendations, and the domain's rows. */
export function standingsView(db: Database.Database, o: { domain?: string | null } = {}): View {
  const recs = benchmarkRecommendations(db).filter((r) => !o.domain || r.domain === o.domain);
  const out: string[] = ['## 模型戰績'];
  if (!recs.length) return { markdown: '還沒有評完的評比，沒有戰績可看。', data: { recommendations: [] }, links: [{ title: '戰績', url: '/benchmarks.html#standings' }] };
  for (const r of recs) out.push(`- ${r.domain}：${r.verdict}`);
  const rows = benchmarkMatrix(db, { domain: o.domain ?? undefined })
    .sort((a, b) => b.verify_pass_rate - a.verify_pass_rate || (b.avg_score ?? 0) - (a.avg_score ?? 0))
    .map((r) => [r.domain, modelName(r.model), r.local ? '本地' : '雲端', r.screen_n ? `${r.n}（快篩 ${r.screen_n}）` : r.n, pct(r.verify_pass_rate), pct(r.first_try_rate), r.avg_score ?? '—']);
  out.push('', table(['領域', '模型', '', '場次', '通過率', '第 1 次就過', '平均評分'], rows));
  return { markdown: out.join('\n'), data: { recommendations: recs }, links: [{ title: '戰績', url: '/benchmarks.html#standings' }] };
}

export type TemplateTopic = 'work' | 'benchmark' | 'models' | 'repos' | 'plans';

/** What the person can build from: work templates, benchmarks to rerun, models, repos, 驗證方案. */
export function templatesView(db: Database.Database, o: { topic: TemplateTopic; repo?: string | null }, deps: ViewDeps = {}): View {
  const out: string[] = [];
  const links: ToolSource[] = [];
  let data: unknown = null;
  switch (o.topic) {
    case 'work':
      out.push('## 工作範本（ops_prepare_work 的 kind）', ...templateLines(), '', '驗證要有來源：驗證方案（plan）、沿用某張任務（plan: t_…）、使用者親口給的指令，或 repo 偵測到的指令。');
      break;
    case 'plans': {
      const plans = listPlans(db, o.repo ?? null);
      data = plans.map((p) => ({ id: p.id, name: p.name }));
      out.push(
        plans.length
          ? `## 驗證方案\n${table(['id', '名稱', 'repo', '門檻', '保護'], plans.map((p) => [p.id, p.name, p.repo_path ? p.repo_path.split('/').pop() : '通用', p.metrics || '指令成功即通過', p.protected_paths.length ? `${p.protected_paths.length} 條` : '—']))}`
          : '還沒有驗證方案（可在 /plans.html 新增）。',
      );
      links.push({ title: '驗證方案', url: '/plans.html' });
      break;
    }
    case 'repos': {
      const repos = listJobRepos(db);
      data = repos.map((r) => ({ name: r.name, path: r.path }));
      out.push(repos.length ? `## 可以改的 repo\n${table(['名稱', '路徑', '目前分支'], repos.map((r) => [r.name, r.path, r.branch ?? '—']))}` : '白名單裡還沒有 repo（可以用 git 抓一個進來）。');
      break;
    }
    case 'models': {
      const locals = listLocalModels(db).map((m) => annotateLocalModel(db, m, deps));
      const st = deps.localState?.() ?? null;
      data = { local: locals.map((m) => ({ id: `local:${m.id}`, runnable: m.runnable })), cloud: CLOUD_MODELS };
      out.push(
        '## 模型',
        `雲端：${CLOUD_MODELS.join('、')}（會花訂閱額度）`,
        '',
        table(
          ['本地模型', '能不能跑', '說明'],
          locals.map((m) => [`local:${m.id}`, m.runnable ? (st?.loaded === m.id ? '可以（目前載入）' : '可以') : '不行', m.runnable ? m.display_name : m.blocked_by]),
        ),
      );
      break;
    }
    case 'benchmark': {
      const recent = listBenchmarks(db, 30).slice(0, 8);
      const builtin = listBuiltin();
      data = { benchmarks: recent.map((b) => b.id), builtin: builtin.map((q) => q.key) };
      out.push(
        '## 評比來源（ops_prepare_benchmark 的 from）',
        '- benchmark：重賽某一場（原樣複製題目、驗證、門檻、保護路徑），ref 用 b_… 或名稱，可增減模型',
        '- task：拿一張任務當題目；plan：驗證方案＋題目；builtin：內建練習題',
        '',
        '## 模型快篩（ops_prepare_screen）',
        '- 用內建小題一題一題測本地模型：每題限時、不用評審、不花訂閱額度，通過率記進戰績。先快篩，過了再開正式評比。',
      );
      if (recent.length) out.push('', table(['id', '名稱', '狀態', '模型'], recent.map((b) => [b.id, b.title, BENCH_WORD[b.status] ?? b.status, (b.models ?? []).map(modelName).join('、')])));
      if (builtin.length) out.push('', `內建題：${builtin.map((q) => `${q.key}（${q.title}）`).join('、')}`);
      break;
    }
  }
  return { markdown: out.join('\n'), data, links };
}
