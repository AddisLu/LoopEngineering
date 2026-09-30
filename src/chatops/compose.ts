import path from 'node:path';
import type Database from 'better-sqlite3';
import { composePrd, type WebPrdForm } from '../../web/prd-compose.js';
import { applyKind, applyPlan, mergeForm } from '../../web/prd-form.js';
import { listJobRepos, type JobRepo } from '../plans/job.js';
import { isModelValue, MODEL_VALUES } from '../settings.js';
import { listLocalModels } from '../local/models.js';
import { annotateLocalModel, type LocalGuardDeps } from '../local/guard.js';
import { modelName } from './format.js';
import { WORK_TEMPLATES, type WorkFacts } from './templates.js';
import type { Verification } from './verify.js';

/**
 * Facts + a work template (+ a 驗證方案) → the 工作流程 form → the PRD, composed by the page's own
 * composer (web/prd-compose.js) so the /flow.html editor reopens the draft exactly as prepared.
 */

const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

export type Resolved<T> = { ok: true; value: T } | { ok: false; question: string; candidates?: string[] };

/** The repo the person means: a path in the allow-list, a folder name, or part of one. */
export function resolveRepo(db: Database.Database, name: string | undefined, fallback: string | null): Resolved<JobRepo> {
  const repos = listJobRepos(db);
  const want = oneLine(name);
  if (!want) {
    if (fallback) {
      const byPath = repos.find((r) => r.path === fallback);
      if (byPath) return { ok: true, value: byPath };
    }
    if (repos.length === 1) return { ok: true, value: repos[0]! };
    return { ok: false, question: `要改哪個 repo？可選：${repos.map((r) => r.name).join('、') || '（白名單裡沒有 repo）'}`, candidates: repos.map((r) => r.name) };
  }
  const low = want.toLowerCase().replace(/\/+$/, '');
  const exact = repos.filter((r) => r.path === want || r.name.toLowerCase() === low || path.basename(low) === r.name.toLowerCase());
  if (exact.length === 1) return { ok: true, value: exact[0]! };
  const partial = repos.filter((r) => r.name.toLowerCase().includes(low) || low.includes(r.name.toLowerCase()));
  if (partial.length === 1) return { ok: true, value: partial[0]! };
  if (partial.length > 1) return { ok: false, question: `「${want}」可能是：${partial.map((r) => r.name).join('、')}——是哪一個？`, candidates: partial.map((r) => r.name) };
  return {
    ok: false,
    question: `「${want}」不在可以改的 repo 清單裡（${repos.map((r) => r.name).join('、') || '清單是空的'}）。要先用 git 把它抓進來嗎？`,
    candidates: repos.map((r) => r.name),
  };
}

/** A model the person named: a cloud alias, local:<id>, or part of a local model's id or name. */
export function resolveModel(db: Database.Database, name: string | undefined, deps: LocalGuardDeps = {}): Resolved<string | null> {
  const want = oneLine(name);
  if (!want) return { ok: true, value: null };
  const low = want.toLowerCase();
  if (MODEL_VALUES.has(low) && low !== '' && low !== 'default') return { ok: true, value: low };
  const locals = listLocalModels(db).map((m) => annotateLocalModel(db, m, deps));
  const hit = (m: (typeof locals)[number]) => `local:${m.id}` === low || m.id.toLowerCase() === low.replace(/^local:/, '') || m.display_name.toLowerCase() === low;
  let found = locals.filter(hit);
  if (!found.length) found = locals.filter((m) => m.id.toLowerCase().includes(low.replace(/^local:/, '')) || m.display_name.toLowerCase().includes(low));
  if (found.length > 1) {
    const runnable = found.filter((m) => m.runnable);
    if (runnable.length === 1) found = runnable;
  }
  if (found.length === 1) {
    const m = found[0]!;
    if (!m.runnable) return { ok: false, question: `本地模型 ${m.id} 現在不能用（${m.blocked_by}）；要換哪個模型？` };
    return { ok: true, value: `local:${m.id}` };
  }
  if (found.length > 1) return { ok: false, question: `「${want}」可能是：${found.map((m) => `local:${m.id}`).join('、')}——是哪一個？`, candidates: found.map((m) => `local:${m.id}`) };
  if (isModelValue(want)) return { ok: true, value: want };
  return { ok: false, question: `不認得模型「${want}」。可用：sonnet、opus、haiku，或 ${locals.filter((m) => m.runnable).map((m) => `local:${m.id}`).join('、') || '（沒有可用的本地模型）'}` };
}

export interface WorkPlanInput {
  facts: WorkFacts;
  repo: JobRepo;
  branch: string;
  verification: Verification;
  model: string | null;
}

/** The 工作流程 form a work item becomes. Pure. */
export function buildWorkForm(o: WorkPlanInput): WebPrdForm & { flow: { type: string; models: string[]; judges: string[] } } {
  const f = o.facts;
  const t = WORK_TEMPLATES[f.kind];
  const form = mergeForm(null);
  form.repo = { path: o.repo.path, branch: o.branch, module: null };
  if (o.verification.plan) applyPlan(form, { ...o.verification.plan, repo_path: o.verification.plan.repo_path ?? undefined, host: o.verification.plan.host ?? undefined });
  if (f.kind === 'algo' || f.kind === 'bugfix' || f.kind === 'feature' || f.kind === 'perf') applyKind(form, f.kind);
  const files = (f.files ?? []).map((p) => oneLine(p)).filter((p) => p && !p.startsWith('/') && !p.includes('..')).slice(0, 20);
  form.change = {
    title: oneLine(f.title).slice(0, 80),
    symptom: oneLine(f.symptom ?? f.repro ?? (f.kind === 'perf' ? `現況：${oneLine(f.baseline)}` : '')),
    expected: oneLine(f.kind === 'perf' && f.target && !oneLine(f.expected).includes(oneLine(f.target)) ? `${oneLine(f.expected)}（目標：${oneLine(f.target)}）` : f.expected),
    files: files.map((p) => ({ path: p, why: '' })),
    extra:
      f.kind === 'epic'
        ? (f.parts ?? []).map((p) => oneLine(p)).filter(Boolean)
        : files.length
          ? []
          : [`修改 ${o.repo.name} 中與目標直接相關的程式；位置由實作者讀程式碼後判斷，只做達成目標所需的最小修改`],
  };
  // the template's acceptance, written from the facts, replaces the change-type examples
  form.acceptance = t.acceptance(f).map(oneLine).filter(Boolean);
  if (!form.scope.non_goals.length) form.scope.non_goals = [...t.nonGoals];
  form.scope.constraints = [...new Set([...form.scope.constraints, ...t.constraints, ...(f.notes ?? []).map(oneLine).filter(Boolean)])];
  const v = o.verification;
  if (v.source === 'task' || v.source === 'user' || v.source === 'detected') {
    form.verify.commands = [...v.commands];
    if (v.setup) form.scope.setup = [v.setup];
  }
  if (!form.verify.manual.length) form.verify.manual = t.manual(f).map((m) => ({ given: '', when: '', then: m }));
  if (f.size) form.scope.complexity = f.size;
  else if (!v.plan) form.scope.complexity = t.complexity;
  if (!v.plan && (f.kind === 'spike' || f.kind === 'epic')) form.scope.domain = t.domain;
  form.flow = { type: t.flow === 'epic' ? 'epic' : 'task', models: o.model ? [o.model] : [], judges: ['opus'] };
  return form;
}

export const composeWork = (form: WebPrdForm): string => composePrd(form);

/** The summary the person confirms — engine-written, pasted verbatim by the chat model. */
export function workSummary(o: WorkPlanInput & { form: WebPrdForm; draftUrl: string; spends: boolean }): string {
  const t = WORK_TEMPLATES[o.facts.kind];
  const v = o.verification;
  const commands = o.form.verify.commands.filter(Boolean);
  const setup = o.form.scope.setup.filter(Boolean);
  const metrics = o.form.verify.metrics.filter(Boolean);
  const notes = (o.facts.notes ?? []).map(oneLine).filter(Boolean);
  const parts = o.facts.kind === 'epic' ? (o.facts.parts ?? []).map(oneLine).filter(Boolean) : [];
  // everything that will run on this machine is shown as it will run: the person confirms what they see
  const lines = [
    `開一張「${t.label}」${t.flow === 'epic' ? '（AI 會拆成依序執行的子任務）' : '任務'}：${o.form.change.title}`,
    `- repo：${o.repo.name} · ${o.branch}`,
    `- 模型：${o.model ? modelName(o.model) : '預設模型'}${o.spends ? '（雲端，會花訂閱額度）' : o.model?.startsWith('local:') ? '（本地，不花額度）' : ''}`,
    `- 驗證：${v.note || '（人工核可）'}${metrics.length ? `；門檻 ${metrics.join('、')}` : ''}`,
    ...commands.map((c) => `  - \`${c}\``),
    ...(setup.length ? [`- 前置指令：${setup.map((c) => `\`${c}\``).join('；')}`] : []),
    ...(parts.length ? [`- 拆成：${parts.join('；')}`] : []),
    ...(notes.length ? [`- 補充與限制：${notes.join('；')}`] : []),
    `- 驗收：${o.form.acceptance[0] ?? '—'}${o.form.acceptance.length > 1 ? `（共 ${o.form.acceptance.length} 條）` : ''}`,
  ];
  const manual = o.form.verify.manual.filter((m) => (typeof m === 'string' ? m : m.then));
  if (manual.length) lines.push(`- 人工核可：${manual.length} 項，驗證過後停在「待核可」`);
  lines.push(`- 規模：${o.form.scope.complexity}；確認後就排入`);
  lines.push(`- 草稿：${o.draftUrl}（確認前可以打開修改）`);
  return lines.join('\n');
}
