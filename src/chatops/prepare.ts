import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { checkPrd } from '../prd/intake.js';
import { lintPrd, type LintDeps } from '../prd/lint.js';
import type { PrdReviewExec } from '../prd/review.js';
import { createDraft } from '../prd/drafts.js';
import { markMessage } from '../chat/store.js';
import { resolvePrdModel } from '../prd/intake.js';
import type { LocalGuardDeps } from '../local/guard.js';
import { createPending } from './actions.js';
import { buildWorkForm, composeWork, resolveModel, resolveRepo, workSummary } from './compose.js';
import { link } from './format.js';
import { userTexts, unsaid } from './provenance.js';
import { WORK_KINDS, WORK_TEMPLATES, missingFacts, type Missing, type WorkFacts } from './templates.js';
import { chooseVerification } from './verify.js';
import type { ChatCtx, OpsAction } from './types.js';

/**
 * Preparers turn what the chat model collected into a PENDING action (actions.ts). They validate
 * and compose; they never create a task, a benchmark, a repo or a plan file — that happens only
 * when the person confirms (execute.ts).
 */

export interface PrepareDeps extends LocalGuardDeps {
  reviewExec?: PrdReviewExec;
  lintDeps?: LintDeps;
}

export type PrepareOutcome = { ok: true; action: OpsAction; markdown?: string; warnings: string[] } | { ok: false; missing: Missing[]; note?: string };

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max = 20): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => str(x, 500)).filter(Boolean).slice(0, max);

/** ops_prepare_work's arguments → WorkFacts (lenient about shapes, strict about content). */
export function factsFrom(args: Record<string, unknown>): WorkFacts | null {
  const kind = str(args.kind) as WorkFacts['kind'];
  if (!WORK_KINDS.includes(kind)) return null;
  const size = str(args.size).toUpperCase();
  return {
    kind,
    title: str(args.title, 120),
    expected: str(args.expected),
    symptom: str(args.symptom) || undefined,
    repro: str(args.repro) || undefined,
    repo: str(args.repo, 500) || undefined,
    branch: str(args.branch, 100) || undefined,
    files: list(args.files),
    plan: str(args.plan, 200) || undefined,
    dataset: str(args.dataset, 200) || undefined,
    verify: list(args.verify, 10),
    baseline: str(args.baseline, 200) || undefined,
    target: str(args.target, 200) || undefined,
    urls: list(args.urls, 8),
    parts: list(args.parts, 8),
    model: str(args.model, 100) || undefined,
    size: size === 'S' || size === 'M' || size === 'L' ? size : undefined,
    notes: list(args.notes, 10),
  };
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Prepare new work — a task, an epic or an evaluation spike — from a template. */
export async function prepareWork(db: Database.Database, chat: ChatCtx, facts: WorkFacts, deps: PrepareDeps = {}): Promise<PrepareOutcome> {
  const t = WORK_TEMPLATES[facts.kind];
  const missing = missingFacts(facts);
  const said = userTexts(db, chat.conversationId);

  if (t.flow === 'spike') {
    const urls = facts.urls ?? [];
    const notSaid = unsaid(said, urls);
    if (notSaid.length) missing.push({ fact: 'urls', question: `要評估的網址要是你貼過的：${notSaid.join('、')} 沒有出現在對話裡，請把網址貼上來` });
    if (missing.length) return { ok: false, missing };
    const model = resolveModel(db, facts.model, deps);
    if (!model.ok) return { ok: false, missing: [{ fact: 'model', question: model.question }] };
    const name = facts.title;
    const summary = [
      `開一個外部專案評估：${name}`,
      `- 要回答：${facts.expected}`,
      `- 來源：${urls.join('、')}`,
      `- 會在 spike 目錄另開一個實驗 repo，裝起來試，結論寫進 REPORT.md（驗證：REPORT.md 存在，並經人工核可）`,
      `- 模型：${model.value ?? '預設模型'}；確認後就排入`,
    ].join('\n');
    const action = createPending(db, chat, {
      kind: 'work',
      op: 'spike',
      target: null,
      params: { name, goal: facts.expected, urls, model: model.value },
      expect: null,
      summary,
      risk: 'normal',
      speed: 'slow',
    });
    return { ok: true, action, warnings: [] };
  }

  // the repo: named by the person, or the one the 驗證方案 is for, or the only one there is
  let planRepo: string | null = null;
  const verification = chooseVerification(db, { allowed: t.verifySources, plan: facts.plan, verify: facts.verify, repo: null, said });
  if (verification.ok && verification.v.plan?.repo_path) planRepo = verification.v.plan.repo_path;
  if (verification.ok && verification.v.task?.repo_path) planRepo = verification.v.task.repo_path;
  const repo = resolveRepo(db, facts.repo, planRepo);
  if (!repo.ok) missing.push({ fact: 'repo', question: repo.question });
  // re-choose with the repo known: detection and plan preference need it
  const v = repo.ok ? chooseVerification(db, { allowed: t.verifySources, plan: facts.plan, verify: facts.verify, repo: repo.value.path, said }) : verification;
  if (!v.ok) missing.push({ fact: 'verify', question: v.question });
  // no repo yet: repo detection may still answer this once the person names it
  else if (repo.ok && t.needs !== 'none' && v.v.source === 'none') {
    if (t.needs === 'command' || !WORK_TEMPLATES[facts.kind].manual(facts).length) {
      missing.push({ fact: 'verify', question: '要怎麼驗證？給一個會失敗／會通過的指令（例如 npm test），或指定一個驗證方案' });
    }
  }
  if (facts.kind === 'algo' && v.ok && v.v.source !== 'plan' && !facts.dataset && v.v.source !== 'task') {
    missing.push({ fact: 'plan', question: '演算法修正要用圖集證明沒有退步：用哪個驗證方案（或給圖集與期望結果的路徑）？' });
  }
  const model = resolveModel(db, facts.model, deps);
  if (!model.ok) missing.push({ fact: 'model', question: model.question });
  if (missing.length || !repo.ok || !v.ok || !model.ok) return { ok: false, missing };

  const branch = facts.branch || repo.value.branch || 'main';
  const chosen = model.value ?? resolvePrdModel(db, null);
  const form = buildWorkForm({ facts, repo: repo.value, branch, verification: v.v, model: chosen });
  const markdown = composeWork(form);
  const lint = lintPrd(markdown, deps.lintDeps);
  if (!lint.ok) return { ok: false, missing: lint.missing.map((m) => ({ fact: 'prd', question: m })), note: 'PRD 還過不了閘門' };
  const check = await checkPrd(db, markdown, { exec: deps.reviewExec, lintDeps: deps.lintDeps });
  if (!check.ok) {
    const qs = [...check.missing.map((m) => ({ fact: 'review', question: m })), ...(check.llm.questions ?? []).map((q) => ({ fact: 'review', question: q }))];
    return { ok: false, missing: qs, note: '本地模型複核認為還有沒寫清楚的地方' };
  }
  const warnings = [...check.warnings, ...(check.llm.questions ?? []).map((q) => `複核提問：${q}`)];
  const draft = createDraft(db, chat.userKey, { title: form.change.title, form, markdown, step: 5 });
  try {
    markMessage(db, chat.messageId, chat.userKey, { draft_id: draft.id }); // the answer's 轉成任務 shows this draft instead of making another
  } catch {
    /* the answer row belongs to the conversation checked above; a miss only loses the button link */
  }
  const url = link.draft(draft.id).url;
  const spends = !String(chosen ?? '').startsWith('local:');
  const summary = workSummary({ facts, repo: repo.value, branch, verification: v.v, model: chosen, form, draftUrl: url, spends });
  const action = createPending(db, chat, {
    kind: 'work',
    op: t.flow === 'epic' ? 'epic' : 'submit',
    target: draft.id,
    params: {
      draft_id: draft.id,
      model: chosen,
      verify_plan_id: v.v.plan?.id ?? null,
      coding_tool: t.flow === 'epic' ? 'plan' : 'claude-code',
      // the gate's verdict on exactly this markdown: confirming an unchanged draft reuses it
      check,
    },
    expect: { md_sha: sha(markdown) },
    summary,
    risk: 'normal',
    speed: 'slow',
    draftId: draft.id,
    mdSha: sha(markdown),
    links: [link.draft(draft.id)],
  });
  return { ok: true, action, markdown, warnings };
}
