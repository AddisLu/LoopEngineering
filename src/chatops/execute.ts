import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { logEvent } from '../db/index.js';
import { getTask } from '../tasks.js';
import type { Task } from '../types.js';
import { getDraft } from '../prd/drafts.js';
import { linkSubmittedDraft, submitPrd, type PrdCheck } from '../prd/intake.js';
import type { PrdReviewExec } from '../prd/review.js';
import { createSpike, type SpikeDeps } from '../spike/create.js';
import { cancelBenchmark, createBenchmark, getBenchmark, type NewBenchmarkInput } from '../benchmark/store.js';
import { resolveSource, writeQuestionPlan, type ResolveDeps } from '../benchmark/source.js';
import { judgeBenchmark, rejudgeBlocker, remeasureBaseline } from '../benchmark/complete.js';
import type { BenchJudgeExec } from '../benchmark/judge.js';
import type { GitExec } from '../benchmark/attempts.js';
import type { SandboxDeps } from '../exec/sandbox.js';
import { approveTask, requestChanges, ReviewError } from '../review/review.js';
import { mergeBlocker, mergeReviewedTask, MergeInProgressError } from '../orchestrator/mergeFlow.js';
import { TaskActionError, abandonTask, abortTask, closeTask, deleteTaskSafe, holdTask, killTaskRuns, queueTask, restartTask, resumeTask } from '../taskActions.js';
import { getLocalModel } from '../local/models.js';
import { localLoadGuard, type LocalGuardDeps } from '../local/guard.js';
import type { ModelManager } from '../local/modelManager.js';
import type { DistillExec } from '../knowledge/distill.js';
import { checkButtonConfirm, checkTypedConfirm, claim, finishAction, getActionById } from './actions.js';
import { link } from './format.js';
import type { ActionResult, ChatCtx, OpsAction } from './types.js';

/**
 * Running a confirmed 對話操作 action. Every run is a job the OpsRunner keeps: the caller waits
 * a moment (most actions finish at once) and otherwise tells the person it has started; the
 * result lands on the action row either way, where ops_show / the overview find it. A job never
 * throws: failures become a failed action with the reason in the person's words.
 */

export interface ExecDeps extends LocalGuardDeps {
  reviewExec?: PrdReviewExec;
  judgeExec?: BenchJudgeExec;
  sandboxDeps?: SandboxDeps;
  baselineGit?: GitExec;
  distillExec?: DistillExec;
  spikeDeps?: SpikeDeps;
  sourceDeps?: ResolveDeps;
  modelManager?: Pick<ModelManager, 'state' | 'ensureLoaded'>;
  /** answers still being written, other than the one given */
  otherAnswers?: (exceptId?: string) => number;
  /** is this answer still being written? (the card's button can be pressed mid-answer) */
  isRunning?: (messageId: string) => boolean;
  /** git actions (src/chatops/git.ts) register here so this module has no git of its own */
  git?: (db: Database.Database, a: OpsAction) => Promise<ActionResult>;
  /** how long confirm waits for a job before answering 「已開始」 */
  waitMs?: number;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const errText = (err: unknown): string => {
  if (err instanceof TaskActionError || err instanceof ReviewError || err instanceof MergeInProgressError) return err.message;
  return (err as Error)?.message ?? String(err);
};

/** The state an action was prepared against, still true? (a task that moved on needs a new preparation) */
function drifted(a: OpsAction, t: Task | undefined): string | null {
  const exp = (a.expect ?? {}) as { status?: string; merge_status?: string | null; approved_at?: string | null };
  if (!t) return '任務已經不存在';
  if (exp.status && exp.status !== t.status) return `任務狀態已經變了（${exp.status} → ${t.status}）`;
  if (exp.merge_status !== undefined && (exp.merge_status ?? null) !== (t.merge_status ?? null)) return `合併狀態已經變了（${exp.merge_status ?? '無'} → ${t.merge_status ?? '無'}）`;
  if (exp.approved_at !== undefined && (exp.approved_at ?? null) !== (t.approved_at ?? null)) return '任務已經被核可過了';
  return null;
}

async function runWork(db: Database.Database, a: OpsAction, deps: ExecDeps): Promise<ActionResult> {
  const p = a.params as {
    draft_id?: string;
    model?: string | null;
    verify_plan_id?: string | null;
    coding_tool?: 'claude-code' | 'plan';
    name?: string;
    goal?: string;
    urls?: string[];
    check?: PrdCheck;
  };
  const who = a.user_label ?? a.user_key;
  if (a.op === 'spike') {
    const { task, repo_path } = createSpike(
      db,
      { name: p.name ?? 'spike', goal: p.goal ?? '', urls: p.urls ?? [], owner: who, sourceRef: `chat:${a.prepared_msg_id}`, model: p.model ?? null, createdBy: 'chat' },
      deps.spikeDeps,
    );
    let queued = '';
    try {
      queueTask(db, task.id);
      queued = '並排入';
    } catch (err) {
      queued = `（沒有排入：${errText(err)}）`;
    }
    return { ok: true, detail: `已建立評估任務 ${task.id}${queued}；實驗 repo：${repo_path}`, links: [link.task(task.id)], data: { task_id: task.id } };
  }
  const draft = p.draft_id ? getDraft(db, a.user_key, p.draft_id) : null;
  if (!draft) return { ok: false, detail: '找不到這份工作流程草稿（可能被刪掉了）' };
  if (draft.status === 'submitted') return { ok: false, detail: `這份草稿已經送出過了${draft.task_id ? `（${draft.task_id}）` : ''}` };
  const markdown = draft.markdown;
  const unchanged = a.md_sha != null && sha(markdown) === a.md_sha;
  // reviewed when it was prepared (that verdict is kept with the action); edited on /flow.html
  // since → the full check again, local model review included
  const precheck = unchanged && p.check?.ok ? p.check : undefined;
  const r = await submitPrd(db, markdown, {
    exec: deps.reviewExec,
    precheck,
    model: p.model ?? null,
    queue: true,
    verify_plan_id: p.verify_plan_id ?? null,
    coding_tool: p.coding_tool === 'plan' ? 'plan' : undefined,
    created_by: 'chat',
    owner: who,
    source_ref: `chat:${a.prepared_msg_id}`,
  });
  if (!r.ok) return { ok: false, detail: `草稿過不了 PRD 閘門：${r.check.missing.join('；')}` };
  linkSubmittedDraft(db, a.user_key, draft.id, r);
  if (r.kind !== 'task') return { ok: true, detail: `已建立評比 ${r.benchmark.id}`, links: [link.bench(r.benchmark.id)] };
  const t = r.task;
  const state = t.status === 'queued' ? '並排入' : `（狀態：${t.status}${r.gate.ok ? '' : `；缺 ${r.gate.missing.join('、')}`}）`;
  return {
    ok: true,
    detail: `已建立 ${t.id}「${t.title}」${state}${unchanged ? '' : '（草稿在確認前被修改過，已重新檢查）'}`,
    links: [link.task(t.id)],
    data: { task_id: t.id },
  };
}

async function runBenchmark(db: Database.Database, a: OpsAction, deps: ExecDeps): Promise<ActionResult> {
  const p = a.params as { from: string; ref: string; config: Record<string, unknown>; models: string[]; judges: string[]; title: string };
  let input: NewBenchmarkInput;
  let cleanup: (() => void) | undefined;
  if (p.from === 'benchmark') {
    const c = p.config as unknown as NewBenchmarkInput & { plan_ref: string | null };
    const planRef = c.plan_ref ?? writeQuestionPlan({ title: c.title, goal: c.goal, verification_steps: c.verification_steps ?? [], repo_path: c.repo_path ?? null });
    input = { ...c, plan_ref: planRef, models: p.models, judge_models: p.judges, source_kind: 'manual', source_ref: p.ref || null };
  } else if (p.from === 'plan') {
    const c = p.config as { title: string; goal: string; repo_path: string; base_branch: string; verify_plan_id: string; dataset: string | null };
    const q = resolveSource(db, 'manual', null, { title: c.title, goal: c.goal, repo_path: c.repo_path, base_branch: c.base_branch }, deps.sourceDeps);
    input = { ...q, verify_plan_id: c.verify_plan_id, dataset: c.dataset, verification_steps: [], models: p.models, judge_models: p.judges, source_kind: 'manual', source_ref: c.verify_plan_id };
  } else {
    const q = resolveSource(db, p.from as 'task' | 'builtin', p.ref, p.title ? { title: p.title } : {}, deps.sourceDeps);
    cleanup = q.cleanup;
    input = { ...q, models: p.models, judge_models: p.judges };
  }
  try {
    const { benchmark, arms } = createBenchmark(db, input);
    return {
      ok: true,
      detail: `已開評比 ${benchmark.id}「${benchmark.title}」：${arms.length} 組已排入（${arms.map((x) => x.model.replace(/^local:/, '')).join('、')}）`,
      links: [link.bench(benchmark.id)],
      data: { benchmark_id: benchmark.id },
    };
  } catch (err) {
    cleanup?.();
    throw err;
  }
}

async function runTaskAction(db: Database.Database, a: OpsAction, deps: ExecDeps): Promise<ActionResult> {
  const p = a.params as { id: string; note?: string | null };
  const t = getTask(db, p.id);
  const moved = drifted(a, t);
  if (moved) return { ok: false, detail: `${moved}，這個動作沒有執行；需要的話請重新準備` };
  const who = a.user_label ?? a.user_key;
  const done = (detail: string): ActionResult => ({ ok: true, detail, links: [link.task(p.id), link.review(p.id)] });
  switch (a.op) {
    case 'queue':
      queueTask(db, p.id);
      return done(`${p.id} 已排入`);
    case 'abort':
      abortTask(db, p.id);
      return done(`${p.id} 已中止（標成失敗）`);
    case 'resume':
      resumeTask(db, p.id);
      return done(`${p.id} 已交回自動續跑，額度允許時就會接著做`);
    case 'restart':
      restartTask(db, p.id);
      return done(`${p.id} 已重新排入，會從最新的 base 重新開始`);
    case 'abandon':
      abandonTask(db, p.id);
      return done(`${p.id} 已放棄`);
    case 'hold':
      holdTask(db, p.id);
      return done(`${p.id} 已停止自動續跑，改成需要你處理`);
    case 'close':
      closeTask(db, p.id, { distillExec: deps.distillExec });
      return done(`${p.id} 已結案`);
    case 'delete':
      deleteTaskSafe(db, p.id);
      return { ok: true, detail: `${p.id} 已刪除` };
    case 'request_changes':
      requestChanges(db, t!, p.note ?? '', who);
      return done(`${p.id} 已退回修改並重新排入`);
    case 'approve': {
      const r = await approveTask(db, t!, who, { sandboxDeps: deps.sandboxDeps });
      return done(`${p.id} 已由 ${who} 核可${r.merged ? `並合併：${r.detail}` : `：${r.detail}`}`);
    }
    case 'merge': {
      const blocked = mergeBlocker(t!);
      if (blocked) return { ok: false, detail: `${p.id} 不能合併：${blocked.error}` };
      const r = await mergeReviewedTask(db, t!, { by: `對話操作：${who}`, sandboxDeps: deps.sandboxDeps });
      return r.outcome === 'merged'
        ? done(`${p.id} 已合併：${r.detail}`)
        : { ok: false, detail: `${p.id} 沒有合併成功（${r.outcome}）：${r.detail}`, links: [link.review(p.id)] };
    }
    default:
      return { ok: false, detail: `不認得的任務動作 ${a.op}` };
  }
}

async function runBenchOp(db: Database.Database, a: OpsAction, deps: ExecDeps): Promise<ActionResult> {
  const id = (a.params as { id: string }).id;
  const d = getBenchmark(db, id);
  if (!d) return { ok: false, detail: `評比 ${id} 已經不存在` };
  const links = [link.bench(id)];
  if (a.op === 'cancel_benchmark') {
    const b = cancelBenchmark(db, id, `使用者從對話取消（${a.user_label ?? a.user_key}）`, { onArmTask: (t) => killTaskRuns(db, t.id, 'user') });
    return { ok: true, detail: `評比 ${id} 已${b?.status === 'cancelled' ? '取消' : `是「${b?.status}」`}`, links };
  }
  if (a.op === 'rejudge') {
    const why = rejudgeBlocker(d);
    if (why) return { ok: false, detail: why, links };
    const b = await judgeBenchmark(db, id, deps.judgeExec);
    if (!b) return { ok: false, detail: '已經有一次評分在進行中', links };
    return { ok: b.status === 'judged', detail: b.status === 'judged' ? `評比 ${id} 已重新評分：勝出 ${b.winner ?? '（沒有組別過關）'}` : `評分沒有完成：${b.error ?? b.status}`, links };
  }
  const r = await remeasureBaseline(db, id, deps.sandboxDeps, deps.baselineGit);
  return r.ok ? { ok: true, detail: `評比 ${id} 的基準已量好`, links } : { ok: false, detail: r.error, links };
}

async function runModelSwitch(db: Database.Database, a: OpsAction, deps: ExecDeps): Promise<ActionResult> {
  const id = (a.params as { id: string }).id;
  const mm = deps.modelManager;
  if (!mm) return { ok: false, detail: '這台引擎沒有本地模型管理器' };
  const others = deps.otherAnswers?.(a.confirmed_msg_id ?? undefined) ?? 0;
  if (others > 0) return { ok: false, detail: `還有 ${others} 則回答正在產生，切換會把它們切斷；等它們結束再切` };
  const model = getLocalModel(db, id);
  if (!model) return { ok: false, detail: `找不到本地模型 ${id}` };
  const guard = localLoadGuard(db, model, { hubDir: deps.hubDir, dockerProbe: deps.dockerProbe, loaded: mm.state().loaded });
  if (guard) return { ok: false, detail: guard.error };
  const r = mm.ensureLoaded(id);
  return r === 'busy' ? { ok: false, detail: '模型管理器正忙（另一個切換進行中）' } : { ok: true, detail: `開始切換到 ${id}（約 3–6 分鐘；可以問「現在的狀況」看是否就緒）` };
}

async function execute(db: Database.Database, a: OpsAction, deps: ExecDeps): Promise<ActionResult> {
  switch (a.kind) {
    case 'work':
      return runWork(db, a, deps);
    case 'benchmark':
      return runBenchmark(db, a, deps);
    case 'task':
      return runTaskAction(db, a, deps);
    case 'bench_op':
      return runBenchOp(db, a, deps);
    case 'model':
      return runModelSwitch(db, a, deps);
    case 'git':
      return deps.git ? deps.git(db, a) : { ok: false, detail: '這台引擎沒有開 git 操作' };
    default:
      return { ok: false, detail: `不認得的動作種類 ${String(a.kind)}` };
  }
}

/** Keeps the jobs of confirmed actions; one per engine process (getOpsRunner). */
export class OpsRunner {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly deferred = new Map<string, Array<() => Promise<void>>>();

  inFlight(): number {
    return this.jobs.size;
  }

  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]);
  }

  /** Run a claimed action; resolves with the action as it stands after `waitMs` (done, or still running). */
  async start(db: Database.Database, a: OpsAction, deps: ExecDeps): Promise<OpsAction> {
    const job = (async () => {
      let r: ActionResult;
      try {
        r = await execute(db, a, deps);
      } catch (err) {
        r = { ok: false, detail: errText(err) };
      }
      finishAction(db, a.id, r);
      logEvent(db, {
        task_id: a.kind === 'task' ? ((a.params as { id?: string }).id ?? null) : null,
        kind: 'note',
        detail: `對話操作（${a.user_label ?? a.user_key}）：${a.summary.split('\n')[0]} → ${r.ok ? '完成' : '失敗'}：${r.detail.slice(0, 300)}`,
      });
    })().finally(() => this.jobs.delete(a.id));
    this.jobs.set(a.id, job);
    const wait = deps.waitMs ?? 2500;
    await Promise.race([job, new Promise((res) => setTimeout(res, wait).unref?.())]);
    return getActionById(db, a.id)!;
  }

  /** Hold a claimed action until the answer that confirmed it has finished (a model switch would cut it off). */
  defer(db: Database.Database, messageId: string, a: OpsAction, deps: ExecDeps): void {
    const list = this.deferred.get(messageId) ?? [];
    list.push(async () => {
      await this.start(db, a, deps);
    });
    this.deferred.set(messageId, list);
  }

  /** Called when an answer finishes streaming. */
  async runDeferred(messageId: string): Promise<void> {
    const list = this.deferred.get(messageId);
    if (!list) return;
    this.deferred.delete(messageId);
    for (const fn of list) await fn();
  }
}

let runner: OpsRunner | null = null;
export function getOpsRunner(): OpsRunner {
  runner ??= new OpsRunner();
  return runner;
}

/** A human-readable line for what just happened to an action. */
export function outcomeLine(a: OpsAction): string {
  if (a.status === 'done') return `✅ 已完成：${a.result?.detail ?? ''}`;
  if (a.status === 'failed') return `❌ 沒有成功：${a.result?.detail ?? a.error ?? ''}`;
  if (a.status === 'running') return `⏳ 已開始（${a.code}），完成後可以問「${a.code} 好了嗎」或看狀況總覽`;
  return `動作 ${a.code}：${a.status}`;
}

export type ConfirmOutcome = { ok: true; action: OpsAction; message: string } | { ok: false; message: string; action?: OpsAction };

/** ops_confirm: the server decides whether the person's last message confirmed it, then runs it. */
export async function confirmTyped(
  db: Database.Database,
  chat: ChatCtx,
  code: string | undefined,
  isRunning: (messageId: string) => boolean,
  deps: ExecDeps,
): Promise<ConfirmOutcome> {
  const check = checkTypedConfirm(db, chat, code, isRunning);
  if (!check.ok) return { ok: false, message: check.reason, action: check.action };
  const a = check.action;
  if (!claim(db, a.id, { msgId: chat.messageId, by: 'chat' })) return { ok: false, message: `動作 ${a.code} 已經在執行或處理過了`, action: getActionById(db, a.id) ?? a };
  const claimed = getActionById(db, a.id)!;
  if (a.speed === 'deferred') {
    getOpsRunner().defer(db, chat.messageId, claimed, deps);
    return { ok: true, action: claimed, message: `好，這則回答結束後就開始：${a.summary.split('\n')[0]}` };
  }
  const after = await getOpsRunner().start(db, claimed, deps);
  return { ok: true, action: after, message: outcomeLine(after) };
}

/** The card's button (POST /api/ops/actions/:id/confirm): the page's own request, no typing rules. */
export async function confirmButton(db: Database.Database, idOrCode: string, userKey: string, deps: ExecDeps): Promise<ConfirmOutcome> {
  const check = checkButtonConfirm(db, idOrCode, userKey);
  if (!check.ok) return { ok: false, message: check.reason, action: check.action };
  const a = check.action;
  if (!claim(db, a.id, { msgId: null, by: 'button' })) return { ok: false, message: `動作 ${a.code} 已經在執行或處理過了`, action: getActionById(db, a.id) ?? a };
  const claimed = getActionById(db, a.id)!;
  // the card shows while its answer is still streaming: a model switch clicked then waits for it
  if (a.speed === 'deferred' && deps.isRunning?.(a.presented_msg_id)) {
    getOpsRunner().defer(db, a.presented_msg_id, claimed, deps);
    return { ok: true, action: claimed, message: `好，這則回答結束後就開始：${a.summary.split('\n')[0]}` };
  }
  const after = await getOpsRunner().start(db, claimed, deps);
  return { ok: true, action: after, message: outcomeLine(after) };
}

/**
 * loop-ops (the MCP forwarder for tools like Claude Code, where a person approves each call): no
 * conversation turns to check, so the action's code must be given, and it must be this caller's.
 */
export async function confirmWithCode(db: Database.Database, code: string | undefined, userKey: string, deps: ExecDeps): Promise<ConfirmOutcome> {
  if (!code || !code.trim()) return { ok: false, message: '要帶動作代碼（code），就是準備時回傳的那三個字' };
  return confirmButton(db, code.trim(), userKey, deps);
}
