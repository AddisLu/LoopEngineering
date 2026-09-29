import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { allowedRoots, probeRepo, resolveAllowed } from '../prd/repo.js';
import { checkPrd, submitPrd, type PrdCheck, type PrdOptions, type SubmitResult } from '../prd/intake.js';
import { parseAcceptance } from '../orchestrator/acceptance.js';
import { datasetPath, getPlan, planSteps, PlanError, type VerifyPlan } from './store.js';

/**
 * 新工作: the operator's version of a PRD. A person who does not write code picks the software,
 * says what is wrong and what it should do instead, and picks a 驗證方案 and a 圖資 folder; this
 * module writes the PRD from that (the plan supplies every technical section) and sends it through
 * the same PRD gate as any other. An operator's job always ends in a human 核可: its verify mode
 * includes manual, so nothing is merged before someone has looked at it on the 驗收頁.
 */

export interface JobInput {
  repo_path: string;
  base_branch: string;
  title: string;
  symptom: string;
  expected: string;
  files?: string[];
  plan_id: string;
  dataset?: string | null;
  model?: string | null;
  complexity?: 'S' | 'M' | 'L' | null;
  notes?: string | null;
}

export class JobError extends Error {}

export interface JobRepo {
  path: string;
  name: string;
  branch: string | null;
  branches: string[];
}

/** The software an operator may pick: the git repos under the knowledge sources / PRD allowlist. */
export function listJobRepos(db: Database.Database): JobRepo[] {
  const out: JobRepo[] = [];
  for (const root of allowedRoots(db)) {
    try {
      const probe = probeRepo(db, root);
      if (!probe.is_git) continue;
      let remote: string[] = [];
      try {
        remote = execFileSync('git', ['-C', root, 'for-each-ref', '--count=100', '--format=%(refname:short)', 'refs/remotes/origin'], { encoding: 'utf8', timeout: 15_000 })
          .split('\n')
          .map((s) => s.trim().replace(/^origin\//, ''))
          .filter((s) => s && s !== 'HEAD' && s !== 'origin');
      } catch {
        remote = [];
      }
      out.push({ path: root, name: path.basename(root), branch: probe.branch, branches: [...new Set([...probe.branches, ...remote])].sort() });
    } catch {
      /* unreadable root: not offered */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clean = (s: unknown, max: number) => String(s ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

function validate(db: Database.Database, input: JobInput): { repo: string; plan: VerifyPlan; dataset: string | null; steps: string[] } {
  const roots = allowedRoots(db);
  const repo = resolveAllowed(String(input.repo_path ?? ''), roots);
  if (!repo) throw new JobError('請從清單選要改的軟體（這個路徑不在允許的 repo 裡）');
  if (!BRANCH_RE.test(String(input.base_branch ?? ''))) throw new JobError('請選分支');
  if (clean(input.title, 200).length < 2) throw new JobError('請用一句話寫這次要做什麼（標題）');
  if ((clean(input.symptom, 4000) + clean(input.expected, 4000)).replace(/\s+/g, '').length < 15) {
    throw new JobError('請多寫一點：現在哪裡不對、改好後應該怎樣（合計至少 15 個字）');
  }
  if (!clean(input.expected, 4000)) throw new JobError('請寫「改好後應該怎樣」');
  const plan = getPlan(db, String(input.plan_id ?? ''));
  if (!plan) throw new JobError('請選一個驗證方案');
  if (plan.repo_path && path.resolve(plan.repo_path) !== repo && plan.repo_path !== input.repo_path) {
    throw new JobError(`驗證方案「${plan.name}」是給 ${path.basename(plan.repo_path)} 用的，不是這個軟體`);
  }
  let dataset: string | null = null;
  let steps: string[];
  try {
    dataset = datasetPath(plan, input.dataset ?? null);
    steps = planSteps(plan, dataset);
  } catch (err) {
    if (err instanceof PlanError) throw new JobError(err.message);
    throw err;
  }
  return { repo, plan, dataset, steps };
}

/** The PRD a 新工作 becomes. Pure: the same answers always give the same text. */
export function composeJobPrd(input: JobInput, plan: VerifyPlan, repo: string, dataset: string | null, steps: string[]): string {
  const title = oneLine(clean(input.title, 200));
  const symptom = clean(input.symptom, 4000);
  const expected = clean(input.expected, 4000);
  const files = (input.files ?? []).map((f) => oneLine(String(f))).filter((f) => f && !f.startsWith('/') && !f.includes('..')).slice(0, 30);
  const notes = clean(input.notes, 2000);
  const specs = plan.metrics ? parseAcceptance(plan.metrics) : [];
  const where = dataset ? `圖資 ${dataset}` : '這個版本的程式';
  const passLine = specs.length ? specs.map((s) => `${s.name} ${s.op} ${s.target}`).join('、') : '所有驗證步驟成功（exit 0）';
  const manual = plan.manual_checks.length ? plan.manual_checks : ['看過驗證結果與程式修改，確認符合「期望」'];
  const out: string[] = [
    `# ${title}`,
    '',
    '## 目標 (Goal)',
    ...(symptom ? [`現況：${symptom}`, ''] : []),
    `期望：${expected}`,
    '',
    '## 範圍 (Scope)',
    ...(files.length
      ? files.map((f) => `- ${f}`)
      : [`- 修改 ${path.basename(repo)} 中與上述目標直接相關的程式；位置由實作者讀程式碼後判斷，只做達成目標所需的最小修改`]),
    '',
    '## 非範圍 (Non-goals)',
    `- 不修改驗證方案「${plan.name}」用來量測的評估程式、標準答案與設定`,
    '- 不做與目標無關的重構、改名或格式調整',
    '',
    '## 驗收標準 (Acceptance)',
    `- [ ] Given ${where} When 執行驗證方案「${plan.name}」 Then ${passLine}`,
    `- [ ] Given 修改後的程式 When 在「現況」描述的情境下執行 Then ${oneLine(expected)}`,
    '',
    '## 驗證指令 (Verify)',
    '```bash',
    ...steps,
    '```',
    '',
    '## 驗證方式 (Verify mode)',
    'command, manual',
    '',
    '## Repo',
    `- path: ${repo}`,
    `- branch: ${input.base_branch}`,
    '',
    '## 領域 (Domain)',
    plan.domain,
    '',
    '## 複雜度 (Complexity)',
    input.complexity ?? 'M',
    '',
  ];
  if (specs.length) out.push('## 驗收指標 (Metrics)', ...specs.map((s) => `- ${s.name} ${s.op} ${s.target}`), '');
  if (plan.protected_paths.length) out.push('## 保護路徑 (Protected)', ...plan.protected_paths.map((g) => `- ${g}`), '');
  if (plan.artifacts.length) out.push('## 產出物 (Artifacts)', ...plan.artifacts.map((g) => `- ${g}`), '');
  out.push('## 人工驗收 (Manual checks)', ...manual.map((m) => `- ${m}`), '');
  if (plan.setup_cmd) out.push('## 前置指令 (Setup)', '```bash', plan.setup_cmd, '```', '');
  if (notes) out.push('## 限制 (Constraints)', ...notes.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `- ${l.replace(/^[-*]\s*/, '')}`), '');
  out.push(`<!-- 由「新工作」依驗證方案 ${plan.id} 產生 -->`);
  return out.join('\n');
}

export async function checkJob(db: Database.Database, input: JobInput, opts: PrdOptions = {}): Promise<{ markdown: string; check: PrdCheck }> {
  const v = validate(db, input);
  const markdown = composeJobPrd(input, v.plan, v.repo, v.dataset, v.steps);
  return { markdown, check: await checkPrd(db, markdown, opts) };
}

export async function submitJob(db: Database.Database, input: JobInput, opts: PrdOptions = {}): Promise<{ markdown: string; result: SubmitResult }> {
  const v = validate(db, input);
  const markdown = composeJobPrd(input, v.plan, v.repo, v.dataset, v.steps);
  const result = await submitPrd(db, markdown, { ...opts, model: input.model ?? null, queue: true, verify_plan_id: v.plan.id });
  return { markdown, result };
}
