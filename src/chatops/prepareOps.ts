import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { getTask } from '../tasks.js';
import type { Task } from '../types.js';
import { BENCH_JUDGE_MODELS } from '../settings.js';
import { activeBenchmark, getBenchmark, judgeList, listBenchmarks, type Benchmark } from '../benchmark/store.js';
import { baselineBlocker, rejudgeBlocker } from '../benchmark/complete.js';
import { listBuiltin } from '../benchmark/source.js';
import { mergeBlocker } from '../orchestrator/mergeFlow.js';
import { checklistFor } from '../review/review.js';
import { getLocalModel } from '../local/models.js';
import { localLoadGuard, type LocalGuardDeps } from '../local/guard.js';
import { readUsage } from '../token/usage.js';
import { getPlan } from '../plans/store.js';
import { createPending } from './actions.js';
import { resolveModel } from './compose.js';
import { BENCH_WORD, TASK_WORD, link, modelName } from './format.js';
import type { PrepareOutcome } from './prepare.js';
import { findPlan } from './verify.js';
import type { ChatCtx, Prepared, Risk, Speed } from './types.js';

/**
 * Preparers for benchmarks and for actions on existing things (a task, a benchmark, the local
 * model). Like prepareWork they only validate and describe; the run happens on confirmation.
 */

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max = 12): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[,，、\s]+/) : []).map((x) => str(x, 120)).filter(Boolean).slice(0, max);
const no = (fact: string, question: string): PrepareOutcome => ({ ok: false, missing: [{ fact, question }] });

export interface OpsPrepDeps extends LocalGuardDeps {
  localState?: () => { loaded: string | null; status: string } | null;
  usage?: () => { session: { percent: number } };
}

// ---- benchmarks --------------------------------------------------------------------------------

/** The benchmark the person means: an id, 'latest', or words from its title. */
function findBenchmark(db: Database.Database, ref: string): { b: Benchmark | null; candidates: string[] } {
  const key = ref.trim();
  if (key.startsWith('b_')) return { b: getBenchmark(db, key)?.benchmark ?? null, candidates: [] };
  // a 快篩 row is not something to rerun: only real benchmarks
  const all = listBenchmarks(db, 80).filter((b) => b.mode !== 'screen');
  if (!key || key === 'latest' || key === '上一場' || key === '最近') return { b: all[0] ?? null, candidates: [] };
  const low = key.toLowerCase();
  const hits = all.filter((b) => b.title.toLowerCase().includes(low));
  if (hits.length) return { b: hits[0]!, candidates: [] }; // newest first: 「CCL」 means the latest CCL
  return { b: null, candidates: all.slice(0, 6).map((b) => `${b.id}（${b.title}）`) };
}

export async function prepareBenchmark(db: Database.Database, chat: ChatCtx, args: Record<string, unknown>, deps: OpsPrepDeps = {}): Promise<PrepareOutcome> {
  if (!getBool(db, 'benchmark_enabled', false)) return no('benchmark', '評比功能沒有開（benchmark_enabled=false），要先在設定打開');
  const busy = activeBenchmark(db);
  if (busy) return no('busy', `目前有一場評比在跑：${busy.id}「${busy.title}」（${BENCH_WORD[busy.status] ?? busy.status}）。一次只能跑一場，等它結束或先取消再開新的。`);
  const from = str(args.from) as 'benchmark' | 'task' | 'plan' | 'builtin';
  const ref = str(args.ref, 200);
  let source = '';
  let config: Record<string, unknown> = {};
  let baseModels: string[] = [];
  let judges: string[] = [];
  let title = str(args.title, 120);
  if (from === 'benchmark') {
    const { b, candidates } = findBenchmark(db, ref || 'latest');
    if (!b) return no('ref', `找不到要重賽的評比「${ref}」${candidates.length ? `；最近的有：${candidates.join('、')}` : ''}`);
    const detail = getBenchmark(db, b.id)!;
    baseModels = detail.arms.map((a) => a.model);
    judges = judgeList(b);
    let steps: string[] = [];
    try {
      steps = JSON.parse(b.verification_steps || '[]') as string[];
    } catch {
      steps = [];
    }
    config = {
      title: title || (/（第 \d+ 場|重賽/.test(b.title) ? b.title : `${b.title}（重賽）`),
      goal: b.goal,
      plan_ref: b.plan_ref && fs.existsSync(b.plan_ref) ? b.plan_ref : null,
      repo_path: b.repo_path,
      base_branch: b.base_branch,
      verification_steps: steps,
      setup_cmd: b.setup_cmd,
      verify_rubric: b.verify_rubric,
      domain: b.domain,
      complexity: b.complexity,
      acceptance_metrics: b.acceptance_metrics ?? '',
      protected_paths: b.protected_paths ?? '',
      artifacts: b.artifacts ?? '',
      verify_plan_id: b.verify_plan_id && getPlan(db, b.verify_plan_id) ? b.verify_plan_id : null,
      verify_timeout_min: b.verify_timeout_min,
      timeout_min: b.timeout_min,
    };
    source = `重賽 ${b.id}「${b.title}」（題目、驗證、門檻、保護路徑原樣複製）`;
    title = String(config.title);
  } else if (from === 'task') {
    const t = getTask(db, ref);
    if (!t) return no('ref', `找不到任務「${ref}」；要拿哪一張任務當題目？`);
    source = `任務 ${t.id}「${t.title}」`;
    title = title || t.title.replace(/^\[bench\]\s*/, '');
  } else if (from === 'plan') {
    const { plan, candidates } = findPlan(db, ref, null);
    if (!plan) return no('ref', `找不到驗證方案「${ref}」${candidates.length ? `；有：${candidates.join('、')}` : ''}`);
    const goal = str(args.goal, 4000);
    if (!title || goal.replace(/\s/g, '').length < 10) return no('goal', '用驗證方案出題要有題目名稱和一兩句題目說明（要做出什麼、怎樣算完成）');
    if (!plan.repo_path) return no('repo', `驗證方案「${plan.name}」沒有綁 repo，請改用任務或重賽當來源`);
    config = { title, goal, repo_path: plan.repo_path, base_branch: 'main', verify_plan_id: plan.id, dataset: str(args.dataset, 100) || null };
    source = `驗證方案「${plan.name}」`;
  } else if (from === 'builtin') {
    const q = listBuiltin().find((x) => x.key === ref || x.title === ref);
    if (!q) return no('ref', `沒有這個內建題「${ref}」；有：${listBuiltin().map((x) => x.key).join('、')}`);
    source = `內建題 ${q.key}（${q.title}）`;
    title = title || q.title;
  } else {
    return no('from', '評比要從哪裡出題？benchmark（重賽某一場）／task／plan／builtin');
  }

  // who competes: the old lineup (for a rerun) or the named models, then additions and removals
  const named = list(args.models);
  const add = list(args.add_models);
  const remove = list(args.remove_models);
  const resolved: string[] = [];
  for (const m of [...(named.length ? named : baseModels), ...add]) {
    const r = resolveModel(db, m, deps);
    if (!r.ok) return no('models', r.question);
    if (r.value && !resolved.includes(r.value)) resolved.push(r.value);
  }
  for (const m of remove) {
    const r = resolveModel(db, m, deps);
    const drop = r.ok && r.value ? r.value : null;
    if (drop) resolved.splice(resolved.indexOf(drop), resolved.includes(drop) ? 1 : 0);
  }
  if (resolved.length < 2) return no('models', `評比至少要 2 個不同的模型（現在：${resolved.map(modelName).join('、') || '沒有'}）；要比哪些？`);
  const judgeWant = list(args.judges);
  const judgesFinal = judgeWant.length ? judgeWant : judges.length ? judges : ['opus'];
  const badJudge = judgesFinal.filter((j) => !BENCH_JUDGE_MODELS.has(j));
  if (badJudge.length) return no('judges', `評審只能是 ${[...BENCH_JUDGE_MODELS].join('、')}（不能是 ${badJudge.join('、')}）`);
  const hard = getNum(db, 'hard_limit_pct', 95);
  const session = (deps.usage ?? readUsage)().session.percent;
  if (session >= hard) return no('usage', `5 小時額度已經用了 ${Math.round(session)}%（上限 ${hard}%），等額度回補再開評比`);

  const locals = resolved.filter((m) => m.startsWith('local:'));
  const clouds = resolved.filter((m) => !m.startsWith('local:'));
  const perArm = getNum(db, `timeout_${String(config.complexity ?? 'M')}`, 120);
  const steps = Array.isArray(config.verification_steps) ? (config.verification_steps as string[]).length : null;
  const summary = [
    `開一場評比：${title}`,
    `- 來源：${source}`,
    `- 參賽：${resolved.map((m) => `${modelName(m)}（${m.startsWith('local:') ? '本地' : '雲端'}）`).join('、')}`,
    `- 評審：${judgesFinal.join('、')}`,
    config.acceptance_metrics || steps != null
      ? `- 驗證：${steps != null ? `${steps} 步` : '沿用來源'}${config.acceptance_metrics ? `；門檻 ${String(config.acceptance_metrics)}` : ''}${config.protected_paths ? `；保護路徑 ${String(config.protected_paths).split(',').length} 條` : ''}`
      : '- 驗證：沿用來源的驗證',
    locals.length
      ? `- 預估：本地模型一次只能跑一個（切換 ${Math.max(0, locals.length - 1)} 次，每次約 6 分）；每組每次最多 ${perArm} 分（本地加倍）`
      : `- 預估：雲端各組同時跑，每組每次最多 ${perArm} 分`,
    `- 會花訂閱額度的雲端呼叫：參賽 ${clouds.length} 組＋評審 ${judgesFinal.length} 位`,
    '- 確認後所有組別立刻排入',
  ].join('\n');
  const action = createPending(db, chat, {
    kind: 'benchmark',
    op: from,
    target: ref || null,
    params: { from, ref, config, models: resolved, judges: judgesFinal, title },
    expect: { busy: null },
    summary,
    risk: 'normal',
    speed: 'slow',
  });
  return { ok: true, action, warnings: [] };
}

// ---- 模型快篩 -------------------------------------------------------------------------------------

/** 快篩: local models on small built-in questions, one after another; no judge, no quota. */
export async function prepareScreen(db: Database.Database, chat: ChatCtx, args: Record<string, unknown>, deps: OpsPrepDeps = {}): Promise<PrepareOutcome> {
  if (!getBool(db, 'benchmark_enabled', false)) return no('benchmark', '評比功能沒有開（benchmark_enabled=false），要先在設定打開');
  const models: string[] = [];
  for (const m of list(args.models)) {
    const r = resolveModel(db, m, deps);
    if (!r.ok) return no('models', r.question);
    if (!r.value || !r.value.startsWith('local:')) return no('models', `快篩只測本地模型；「${m}」不是本地模型`);
    if (!models.includes(r.value)) models.push(r.value);
  }
  if (!models.length) return no('models', '要快篩哪個本地模型？');
  const builtin = listBuiltin();
  const want = list(args.questions);
  const defaults = (getSetting(db, 'bench_screen_questions') || 'slugify,log-analyzer,csv-parser').split(',').map((s) => s.trim()).filter(Boolean);
  const questions = want.length ? want : defaults;
  const unknown = questions.filter((q) => !builtin.some((b) => b.key === q));
  if (unknown.length) return no('questions', `沒有這些內建題：${unknown.join('、')}；有：${builtin.map((b) => b.key).join('、')}`);
  const budget = getNum(db, 'bench_screen_budget_min', 15);
  const busy = activeBenchmark(db);
  const level = (k: string) => ({ S: '簡單', M: '中等', L: '難' })[builtin.find((b) => b.key === k)?.complexity ?? 'M'] ?? '中等';
  const summary = [
    `模型快篩：${models.map(modelName).join('、')}`,
    `- 題目：${questions.map((q) => `${q}（${level(q)}）`).join('、')}`,
    `- 每題上限 ${budget} 分鐘，一題接一題；不用雲端評審、不花訂閱額度，結果記進戰績`,
    `- 預估：最多約 ${models.length * (4 + questions.length * budget)} 分鐘（切換模型約 4 分 × ${models.length} 個）`,
    '- 快篩期間本地模型會被換掉，這裡的回答會變慢或暫停；做完會切回現在的模型',
    ...(busy ? [`- 目前有評比 ${busy.id}「${busy.title}」在跑：快篩會排在它後面`] : []),
  ].join('\n');
  const action = createPending(db, chat, {
    kind: 'benchmark',
    op: 'screen',
    target: models.join(','),
    params: { models, questions, budget_min: budget },
    expect: null,
    summary,
    risk: 'normal',
    // it switches the local model: never while the answer that confirmed it is still being written
    speed: 'deferred',
  });
  return { ok: true, action, warnings: [] };
}

// ---- actions on tasks, benchmarks and the local model -------------------------------------------

export type OpsActionName =
  | 'queue'
  | 'abort'
  | 'resume'
  | 'restart'
  | 'abandon'
  | 'hold'
  | 'approve'
  | 'merge'
  | 'request_changes'
  | 'close'
  | 'delete'
  | 'cancel_benchmark'
  | 'rejudge'
  | 'baseline'
  | 'switch_model';

export const ACTION_NAMES: OpsActionName[] = [
  'queue', 'abort', 'resume', 'restart', 'abandon', 'hold', 'approve', 'merge', 'request_changes', 'close', 'delete', 'cancel_benchmark', 'rejudge', 'baseline', 'switch_model',
];

interface TaskSpec {
  verb: string;
  risk: Risk;
  speed: Speed;
  statuses: string[];
  /** extra refusal beyond the status, in the user's words */
  extra?: (db: Database.Database, t: Task) => string | null;
  /** what else the person should know before saying yes */
  note?: (t: Task) => string | null;
}

const spends = (t: Task) => (String(t.model ?? '').startsWith('local:') ? '本地模型，不花額度' : '會用雲端模型，花訂閱額度');
const armGuard = (t: Task) => (t.benchmark_id ? `${t.id} 是評比 ${t.benchmark_id} 的參賽組：要停就「取消評比 ${t.benchmark_id}」，核可／合併／刪除不適用` : null);

const TASK_SPECS: Partial<Record<OpsActionName, TaskSpec>> = {
  queue: { verb: '排入', risk: 'normal', speed: 'fast', statuses: ['draft'], note: spends },
  abort: { verb: '中止', risk: 'high', speed: 'fast', statuses: ['running', 'verifying', 'queued', 'ready', 'blocked'], extra: (_db, t) => armGuard(t), note: () => '正在跑的會被停掉，任務標成失敗（不能續跑，只能重來）' },
  resume: { verb: '續跑', risk: 'normal', speed: 'fast', statuses: ['attention'], note: (t) => `從上次停下的地方接著做；${spends(t)}` },
  restart: { verb: '重來', risk: 'high', speed: 'fast', statuses: ['attention', 'failed'], note: (t) => `刪掉現有的 worktree 和分支，從最新的 base 重新開始；${spends(t)}` },
  abandon: { verb: '放棄', risk: 'high', speed: 'fast', statuses: ['attention'], note: () => '任務標成失敗' },
  hold: { verb: '轉待確認', risk: 'normal', speed: 'fast', statuses: ['blocked'], note: () => '停止自動續跑，改成需要你處理' },
  approve: {
    verb: '核可',
    risk: 'high',
    speed: 'slow',
    statuses: ['review'],
    extra: (db, t) => {
      const arm = armGuard(t);
      if (arm) return arm;
      if (t.approved_at) return `${t.id} 已由 ${t.approved_by} 核可`;
      const unchecked = checklistFor(db, t).filter((c) => !c.checked);
      if (unchecked.length) return `人工驗收還有 ${unchecked.length} 項沒勾（對話不會代勾）：${unchecked.slice(0, 3).map((c) => c.text.slice(0, 40)).join('；')}——請到驗收頁 /task.html?id=${t.id} 看過後勾選`;
      return null;
    },
    note: (t) => (t.merge_status === 'pending' || t.merge_status === 'conflict' ? `核可會先把最新的 ${t.base_branch ?? 'base'} 併進來並重新驗證，通過才快轉合併` : '記下核可'),
  },
  merge: {
    verb: '合併',
    risk: 'high',
    speed: 'slow',
    statuses: ['review'],
    extra: (_db, t) => armGuard(t) ?? mergeBlocker(t)?.error.replace('task not in review', '任務不在待核可').replace('task not awaiting merge', '任務沒有在等合併').replace('task has no repo/base', '任務沒有 repo／base') ?? null,
    note: (t) => `把最新的 ${t.base_branch ?? 'base'} 併進任務分支、重新驗證，通過才快轉合併（不動你的 checkout 以外的東西）`,
  },
  request_changes: { verb: '退回修改', risk: 'normal', speed: 'fast', statuses: ['review', 'attention', 'failed'], extra: (_db, t) => armGuard(t), note: (t) => `把意見接在目標後面，重新排入同一個分支；${spends(t)}` },
  close: { verb: '結案', risk: 'normal', speed: 'fast', statuses: ['review', 'attention', 'failed'], note: () => '結案後會釋放串在它後面的任務，並用 haiku 整理知識（少量額度）' },
  delete: { verb: '刪除', risk: 'high', speed: 'fast', statuses: ['draft', 'failed', 'closed', 'attention', 'review'], extra: (_db, t) => armGuard(t), note: () => '連同 worktree、紀錄與計畫檔一起刪掉，無法復原' },
};

export async function prepareAction(
  db: Database.Database,
  chat: ChatCtx,
  args: Record<string, unknown>,
  deps: OpsPrepDeps & { otherAnswersRunning?: () => number } = {},
): Promise<PrepareOutcome> {
  const action = str(args.action) as OpsActionName;
  const target = str(args.target, 200);
  if (!ACTION_NAMES.includes(action)) return no('action', `不認得的動作「${action}」`);
  if (!target) return no('target', '要對哪一個做？給任務 t_…、評比 b_… 或模型名稱');
  const spec = TASK_SPECS[action];
  if (spec) {
    const t = getTask(db, target);
    if (!t) return no('target', `找不到任務「${target}」；可以先用 ops_find 找`);
    if (!spec.statuses.includes(t.status)) {
      return no('state', `${t.id} 現在是「${TASK_WORD[t.status] ?? t.status}」，不能${spec.verb}（要在：${spec.statuses.map((s) => TASK_WORD[s] ?? s).join('／')}）`);
    }
    const why = spec.extra?.(db, t);
    if (why) return no('state', why);
    // the note is appended to the task's goal: the card shows all of it, so it is capped at what a card can show
    const note = str(args.note, 4000);
    if (action === 'request_changes' && note.length < 4) return no('note', '要退回修改什麼？寫下要改的地方');
    if (note.length > 1000) return no('note', '修改意見太長（上限 1000 字）；請精簡成要改的重點');
    const summary = [`${spec.verb} ${t.id}「${t.title}」`, `- 現在：${TASK_WORD[t.status] ?? t.status}${t.merge_status ? `（${t.merge_status}）` : ''}`, ...(spec.note?.(t) ? [`- ${spec.note(t)}`] : []), ...(note ? [`- 意見：${note}`] : [])].join('\n');
    const pending = createPending(db, chat, {
      kind: 'task',
      op: action,
      target: t.id,
      params: { id: t.id, note: note || null },
      expect: { status: t.status, merge_status: t.merge_status ?? null, approved_at: t.approved_at ?? null },
      summary,
      risk: spec.risk,
      speed: spec.speed,
      links: [link.task(t.id), link.review(t.id)],
    });
    return { ok: true, action: pending, warnings: [] };
  }

  if (action === 'cancel_benchmark' || action === 'rejudge' || action === 'baseline') {
    // a 快篩 batch (sg_…) is cancelled through any of its rows: cancelling one cancels the batch
    let rowId = target;
    if (target.startsWith('sg_')) {
      if (action !== 'cancel_benchmark') return no('action', '快篩只能取消，沒有評分或基準');
      const live = db
        .prepare("SELECT id FROM benchmarks WHERE screen_group = ? ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, screen_seq LIMIT 1")
        .get(target) as { id: string } | undefined;
      if (!live) return no('target', `找不到快篩「${target}」`);
      rowId = live.id;
    }
    const detail = getBenchmark(db, rowId);
    if (!detail) return no('target', `找不到評比「${target}」`);
    const b = detail.benchmark;
    let why: string | null = null;
    let verb = '';
    let risk: Risk = 'normal';
    let note = '';
    if (action === 'cancel_benchmark' && b.mode === 'screen') {
      const group = b.screen_group ?? b.id;
      const live = (db.prepare("SELECT COUNT(*) AS n FROM benchmarks WHERE screen_group = ? AND status IN ('queued','running','judging')").get(group) as { n: number }).n;
      if (!live) return no('state', `快篩 ${group} 已經跑完或取消了`);
      const pending = createPending(db, chat, {
        kind: 'bench_op',
        op: action,
        target: group,
        params: { id: b.id, group },
        expect: null,
        summary: [`取消快篩 ${group}`, `- 還在跑的那一題會被停掉，排隊中的 ${live} 題不會開始`].join('\n'),
        risk: 'normal',
        speed: 'fast',
      });
      return { ok: true, action: pending, warnings: [] };
    }
    if (action === 'cancel_benchmark') {
      verb = '取消評比';
      risk = 'high';
      why = b.status === 'running' || b.status === 'judging' ? null : `${b.id} 現在是「${BENCH_WORD[b.status] ?? b.status}」，不用取消`;
      note = '還在跑的組別會被停掉並標成失敗，這場評比不會評分';
    } else if (action === 'rejudge') {
      verb = '重新評分';
      why = rejudgeBlocker(detail);
      note = `評審 ${judgeList(b).join('、')} 會再看一次每組的程式與量測（花雲端額度）`;
    } else {
      verb = '量基準';
      why = baselineBlocker(b);
      note = '用同一套驗證量一次參賽前的原始程式（要獨占 GPU 幾分鐘）';
    }
    if (why) return no('state', why);
    const pending = createPending(db, chat, {
      kind: 'bench_op',
      op: action,
      target: b.id,
      params: { id: b.id },
      expect: { status: b.status },
      summary: [`${verb} ${b.id}「${b.title}」`, `- ${note}`].join('\n'),
      risk,
      speed: action === 'cancel_benchmark' ? 'fast' : 'slow',
      links: [link.bench(b.id)],
    });
    return { ok: true, action: pending, warnings: [] };
  }

  // switch_model
  if (!getBool(db, 'local_models_enabled', false)) return no('state', '本地模型沒有開（local_models_enabled=false）');
  const r = resolveModel(db, target, deps);
  if (!r.ok) return no('target', r.question);
  if (!r.value || !r.value.startsWith('local:')) return no('target', `「${target}」不是本地模型，雲端模型不用切換`);
  const id = r.value.slice('local:'.length);
  const model = getLocalModel(db, id)!;
  const st = deps.localState?.() ?? null;
  if (st?.loaded === id && st.status === 'ready') return no('state', `${id} 已經是目前載入的模型`);
  const busy = activeBenchmark(db);
  if (busy && busy.status === 'running') return no('state', `評比 ${busy.id} 正在用本地 GPU（它會自己輪流切換模型），現在不能手動切`);
  const guard = localLoadGuard(db, model, { hubDir: deps.hubDir, dockerProbe: deps.dockerProbe, loaded: st?.loaded ?? null });
  if (guard) return no('state', guard.error);
  const pending = createPending(db, chat, {
    kind: 'model',
    op: 'switch_model',
    target: id,
    params: { id },
    expect: { loaded: st?.loaded ?? null },
    summary: [`把本地模型${st?.loaded ? `從 ${st.loaded} ` : ''}切到 ${id}（${model.display_name}）`, '- 約 3–6 分鐘；切換期間對話頁與本地任務都用不了本地模型', '- 會在這則回答結束後才開始切（不會切斷正在寫的回答）'].join('\n'),
    risk: 'normal',
    speed: 'deferred',
  });
  return { ok: true, action: pending, warnings: [] };
}
