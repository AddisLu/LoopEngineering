import type Database from 'better-sqlite3';
import { getPlan, datasetPath, type VerifyPlan } from '../plans/store.js';
import { createCheck, listChecks, repoExists, CheckError, type Check, type CheckInput } from './store.js';
import { LOCAL_HOST } from '../exec/hosts.js';

/**
 * 驗證方案 → 檢查 (link 0.6): turn one old verification plan into checks of a repo, once, by hand
 * (`loop check from-plan <planId> <repoId>`). Every step becomes one custom check that runs where
 * the plan ran it — the GPU sandbox (`sandbox:<host>`) or the engine host — with {dataset} filled
 * in from the plan's default 圖資; the plan's metric thresholds go on its last step (where
 * LOOP_METRICS is printed), its manual checklist becomes 人工 checks, and its protected paths and
 * artifacts ride on every check. The plan itself is left as it is: old tasks keep using it.
 */

const SANDBOX_STEP = /^\s*sandbox(?:@([a-z0-9][a-z0-9_-]*))?\s*:\s*/i;

export interface FromPlanResult {
  created: Check[];
  /** steps that could not become a check, with why */
  skipped: string[];
}

/** The checks one plan becomes (pure: no writes). */
export function planCheckInputs(plan: VerifyPlan): { inputs: CheckInput[]; skipped: string[] } {
  const inputs: CheckInput[] = [];
  const skipped: string[] = [];
  const dataset = (() => {
    try {
      return datasetPath(plan, null);
    } catch {
      return null;
    }
  })();
  const planMachine = !plan.host ? null : `sandbox:${plan.host === LOCAL_HOST ? 'local' : plan.host}`;
  const steps = plan.steps.map((s) => s.trim()).filter(Boolean);
  steps.forEach((raw, i) => {
    if (/^\s*check\s*:/i.test(raw)) return void skipped.push(`${raw}（已經是檢查）`);
    const m = SANDBOX_STEP.exec(raw);
    const machine = m ? `sandbox:${m[1] && m[1].toLowerCase() !== LOCAL_HOST ? m[1].toLowerCase() : 'local'}` : planMachine;
    let command = m ? raw.slice(m[0].length) : raw;
    if (command.includes('{dataset}')) {
      if (!dataset) return void skipped.push(`${raw}（方案沒有預設圖資，{dataset} 填不進去）`);
      command = command.split('{dataset}').join(dataset);
    }
    const last = i === steps.length - 1;
    const metrics = last && plan.metrics?.trim() ? plan.metrics.trim() : null;
    inputs.push({
      name: `${plan.name}${steps.length > 1 ? ` · ${i + 1}` : ''}`.slice(0, 60),
      kind: 'custom',
      machine,
      command,
      pass_rule: metrics ? 'metrics' : 'exit0',
      metrics,
      required: true,
      protected_paths: plan.protected_paths,
      artifacts: last ? plan.artifacts : [],
    });
  });
  for (const text of plan.manual_checks.map((t) => t.trim()).filter(Boolean)) {
    inputs.push({ name: `${plan.name} · 人工`.slice(0, 60), kind: 'manual', manual_text: text.slice(0, 500), required: false });
  }
  return { inputs, skipped };
}

export function checksFromPlan(db: Database.Database, planId: string, repoId: string, by: string | null = null): FromPlanResult {
  const plan = getPlan(db, planId);
  if (!plan) throw new CheckError(`沒有這個驗證方案：${planId}`, 404);
  if (!repoExists(db, repoId)) throw new CheckError(`沒有這個 repo：${repoId}`, 404);
  const { inputs, skipped } = planCheckInputs(plan);
  const have = new Set(listChecks(db, repoId).map((c) => `${c.machine ?? ''}\n${c.command ?? c.manual_text ?? ''}`));
  const created: Check[] = [];
  const run = db.transaction(() => {
    for (const input of inputs) {
      // running it twice adds nothing new
      if (have.has(`${input.machine ?? ''}\n${input.command ?? input.manual_text ?? ''}`)) {
        skipped.push(`${input.name}（這個 repo 已經有同樣的檢查）`);
        continue;
      }
      created.push(createCheck(db, repoId, input, by));
    }
  });
  run();
  return { created, skipped };
}
