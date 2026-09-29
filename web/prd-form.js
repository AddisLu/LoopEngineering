/**
 * Building a 工作流程 form from templates — shared by the 工作流程 page (web/flow.js) and the
 * chat's 對話操作 (src/chatops/compose.ts), so a PRD typed into the chat and one built on the
 * canvas come out of the same code. Pure: no DOM, no fetch. The form shape is web/prd-compose.js's
 * emptyForm(); composePrd(form) turns it into the Markdown the PRD gate reads.
 */
import { emptyForm } from './prd-compose.js';
import { KINDS } from './prd-kinds.js';

export const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || p;

/** Deep-merge a stored form over an empty one: old drafts miss fields added since. */
export function mergeForm(stored) {
  const base = emptyForm();
  const f = { ...base, ...(stored || {}) };
  for (const k of ['repo', 'change', 'verify', 'scope']) f[k] = { ...base[k], ...((stored || {})[k] || {}) };
  f.verify.metrics = f.verify.metrics || [];
  f.verify.artifacts = f.verify.artifacts || [];
  f.scope.protected = f.scope.protected || [];
  f.flow = { type: 'task', models: [], judges: ['opus'], ...((stored || {}).flow || {}) };
  return f;
}

/** The steps a 驗證方案 gives a task: aimed at its machine, {dataset} filled in (src/plans/store.ts planSteps). */
export function planSteps(plan, dataset) {
  const prefix = !plan.host ? '' : plan.host === 'local' ? 'sandbox: ' : `sandbox@${plan.host}: `;
  return (plan.steps || []).map((s) => {
    const cmd = dataset ? s.split('{dataset}').join(dataset) : s;
    return /^sandbox(@[a-z0-9][a-z0-9_-]*)?\s*:/i.test(cmd) ? cmd : `${prefix}${cmd}`;
  });
}

/** A 驗證方案 brings the whole yardstick: steps, metrics, protected paths, artifacts, manual checks, setup, domain. */
export function applyPlan(f, plan) {
  const ds = plan.dataset_root && plan.dataset_default ? `${plan.dataset_root}/${plan.dataset_default}` : null;
  f.plan_id = plan.id;
  f.verify.commands = planSteps(plan, ds);
  f.verify.metrics = String(plan.metrics || '')
    .split(/\s*;\s*/)
    .filter(Boolean);
  f.verify.artifacts = [...(plan.artifacts || [])];
  f.scope.protected = [...(plan.protected_paths || [])];
  if (plan.manual_checks?.length) f.verify.manual = plan.manual_checks.map((m) => ({ given: '', when: '', then: m }));
  if (plan.setup_cmd) f.scope.setup = [plan.setup_cmd];
  if (plan.domain) f.scope.domain = plan.domain;
  if (plan.repo_path && !f.repo.path) f.repo.path = plan.repo_path;
  if (!f.scope.non_goals.length) f.scope.non_goals = [`不修改驗證方案「${plan.name}」用來量測的評估程式、標準答案與設定`, '不做與目標無關的重構、改名或格式調整'];
}

/** A change type fills only what is still empty: never overwrites what someone already wrote. */
export function applyKind(f, key) {
  const k = KINDS[key];
  if (!k) return;
  f.kind = key;
  if (!f.scope.non_goals.length) f.scope.non_goals = [...k.nonGoals];
  if (!f.scope.constraints.length) f.scope.constraints = [...k.constraints];
  if (!f.acceptance.length) f.acceptance = [...k.acceptance];
  if (!f.plan_id) {
    f.scope.domain = k.domain;
    f.scope.complexity = k.complexity;
  }
}
