import fs from 'node:fs';
import path from 'node:path';
import type { Task, TaskRun } from '../types.js';
import type { MetricsReport } from './acceptance.js';
import { readSelfReview, renderSelfReview } from '../review/selfReview.js';

/**
 * What a run's last verification found (task_runs.verify_json / metrics_json, written by
 * runVerifyPipeline), in the two shapes people read it: the PR body on Gitea and the morning
 * report. Reading is defensive — old rows have neither column filled.
 */

export interface VerifiedStep {
  step: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
  /** wall-clock time of the step (absent on runs recorded before it was kept) */
  ms?: number;
}

export function readVerify(run: Pick<TaskRun, 'verify_json'> | null | undefined): VerifiedStep[] {
  if (!run?.verify_json) return [];
  try {
    const v = JSON.parse(run.verify_json);
    return Array.isArray(v) ? (v as VerifiedStep[]) : [];
  } catch {
    return [];
  }
}

export function readMetrics(run: Pick<TaskRun, 'metrics_json'> | null | undefined): MetricsReport | null {
  if (!run?.metrics_json) return null;
  try {
    const m = JSON.parse(run.metrics_json) as MetricsReport;
    return m && Array.isArray(m.checks) ? m : null;
  } catch {
    return null;
  }
}

/** VERIFY.md (the agent's manual checklist), when the worktree still has it. */
export function readVerifyMd(worktree: string | null | undefined, maxChars = 3000): string | null {
  if (!worktree) return null;
  try {
    const text = fs.readFileSync(path.join(worktree, 'VERIFY.md'), 'utf8').trim();
    return text ? (text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text) : null;
  } catch {
    return null;
  }
}

const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\``;

/** Markdown for the PR description: goal, what ran, metrics vs thresholds, the manual checklist. */
export function prBody(task: Task, run: TaskRun | null | undefined, worktree: string | null): string {
  const out: string[] = [];
  const goal = task.goal.trim();
  out.push('## 目標', goal.length > 1200 ? `${goal.slice(0, 1200)}…` : goal, '');
  const steps = readVerify(run);
  if (steps.length) {
    out.push('## 自動驗證（Loop Engineering）');
    for (const s of steps) {
      out.push(`- ${s.ok ? '✅' : '❌'} \`${s.step.replace(/`/g, "'")}\`${s.timedOut ? '（逾時）' : s.exitCode != null ? `（exit ${s.exitCode}）` : ''}`);
    }
    const failed = steps.find((s) => !s.ok);
    if (failed?.tail) out.push('', `<details><summary>${failed.step.replace(/[<>]/g, '')} 的輸出</summary>`, '', fence(failed.tail), '', '</details>');
    out.push('');
  }
  const m = readMetrics(run);
  if (m?.checks.length) {
    out.push('## 驗收指標（引擎比對，門檻來自 PRD）', '', '| 指標 | 實際 | 要求 | 結果 |', '|---|---|---|---|');
    for (const c of m.checks) out.push(`| ${c.name} | ${c.actual ?? '—'} | ${c.op} ${c.target} | ${c.pass ? '✅' : '❌'} |`);
    const extra = Object.entries(m.values).filter(([k]) => !m.checks.some((c) => c.name === k));
    if (extra.length) out.push('', `其他回報：${extra.map(([k, v]) => `${k}=${v}`).join('、')}`);
    out.push('');
  }
  const manual = readVerifyMd(worktree);
  if (manual) out.push('## 人工驗收（VERIFY.md）', '', manual, '');
  const self = readSelfReview(task);
  if (self) out.push(renderSelfReview(self).replace(/^### /, '## '), '');
  const publicUrl = (process.env.LOOP_PUBLIC_URL || '').replace(/\/$/, '');
  if (publicUrl) out.push(`**驗收頁**（程式碼、試跑、人工驗收、交付）：${publicUrl}/task.html?id=${encodeURIComponent(task.id)}`, '');
  out.push('---', `Loop 任務 \`${task.id}\` · 模型 ${task.model ?? '（預設）'}${run ? ` · run \`${run.id}\`（第 ${run.attempt} 次）` : ''}`);
  return out.join('\n');
}
