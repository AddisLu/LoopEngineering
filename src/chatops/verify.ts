import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getTask } from '../tasks.js';
import { getPlan, listPlans, type VerifyPlan } from '../plans/store.js';
import type { Task } from '../types.js';
import type { VerifySource } from './templates.js';
import { unsaid } from './provenance.js';

/**
 * Where a new piece of work's verification comes from — never from the chat model's imagination.
 * In order of preference:
 *   plan     — a 驗證方案 (steps, metrics, protected paths, artifacts, manual checks, setup)
 *   task     — the verification of an existing task (plan: 't_…')
 *   user     — commands the person typed in this conversation (verbatim)
 *   detected — what the repo's own toolchain offers (package.json scripts, go, cargo, pytest,
 *              make), shown in the summary as 「偵測到的驗證指令（請確認）」
 */

export interface Verification {
  source: VerifySource | 'none';
  commands: string[];
  plan: VerifyPlan | null;
  task: Task | null;
  setup: string | null;
  /** a sentence for the summary about where the verification came from */
  note: string;
}

const readJson = (p: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Verification the repo's toolchain offers (ported from mcp/loop-mcp.mjs detectVerify). */
export function detectVerify(repo: string | null | undefined): string[] {
  if (!repo) return [];
  const pj = readJson(path.join(repo, 'package.json'));
  const scripts = pj && typeof pj.scripts === 'object' && pj.scripts ? (pj.scripts as Record<string, unknown>) : null;
  if (scripts) {
    const out: string[] = [];
    if (scripts.lint) out.push('npm run lint');
    if (scripts.typecheck) out.push('npm run typecheck');
    else if (scripts['type-check']) out.push('npm run type-check');
    else if (scripts.build) out.push('npm run build');
    if (scripts.test) out.push('npm test');
    return out;
  }
  if (fs.existsSync(path.join(repo, 'go.mod'))) return ['go build ./...', 'go test ./...'];
  if (fs.existsSync(path.join(repo, 'Cargo.toml'))) return ['cargo build', 'cargo test'];
  if (fs.existsSync(path.join(repo, 'pyproject.toml')) || fs.existsSync(path.join(repo, 'requirements.txt')) || fs.existsSync(path.join(repo, 'tests'))) {
    return ['python3 -m pytest'];
  }
  if (fs.existsSync(path.join(repo, 'Makefile'))) return ['make test'];
  return [];
}

/** The dependency install a repo needs before anything runs (ported from loop-mcp detectSetup). */
export function detectSetup(repo: string | null | undefined): string | null {
  if (!repo) return null;
  if (fs.existsSync(path.join(repo, 'package-lock.json'))) return 'npm ci';
  if (fs.existsSync(path.join(repo, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (fs.existsSync(path.join(repo, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (fs.existsSync(path.join(repo, 'package.json'))) return 'npm install';
  if (fs.existsSync(path.join(repo, 'requirements.txt'))) return 'pip install -r requirements.txt';
  return null;
}

/** A 驗證方案 by id or (unambiguous) name, preferring the repo's own plans. */
export function findPlan(db: Database.Database, ref: string, repo: string | null): { plan: VerifyPlan | null; candidates: string[] } {
  const key = ref.trim();
  if (!key) return { plan: null, candidates: [] };
  const byId = getPlan(db, key);
  if (byId) return { plan: byId, candidates: [] };
  const plans = listPlans(db, repo);
  const low = key.toLowerCase();
  const exact = plans.filter((p) => p.name.toLowerCase() === low);
  if (exact.length === 1) return { plan: exact[0]!, candidates: [] };
  const partial = plans.filter((p) => p.name.toLowerCase().includes(low) || low.includes(p.name.toLowerCase()));
  if (partial.length === 1) return { plan: partial[0]!, candidates: [] };
  return { plan: null, candidates: (partial.length ? partial : plans).slice(0, 8).map((p) => `${p.id}（${p.name}）`) };
}

export type VerifyOutcome = { ok: true; v: Verification } | { ok: false; question: string };

/**
 * Pick the verification for new work from what the template allows. `said` are the person's own
 * messages (provenance.ts); `repo` the resolved repo path.
 */
export function chooseVerification(
  db: Database.Database,
  o: { allowed: VerifySource[]; plan?: string; verify?: string[]; repo: string | null; said: string[] },
): VerifyOutcome {
  const planRef = String(o.plan ?? '').trim();
  if (planRef.startsWith('t_')) {
    if (!o.allowed.includes('task')) return { ok: false, question: '這類工作要用驗證方案或你給的指令來驗證，不能沿用任務' };
    const t = getTask(db, planRef);
    if (!t) return { ok: false, question: `找不到任務 ${planRef}；要沿用哪一張任務的驗證？` };
    let steps: string[] = [];
    try {
      steps = JSON.parse(t.verification_steps || '[]') as string[];
    } catch {
      steps = [];
    }
    if (!steps.length) return { ok: false, question: `${planRef} 沒有驗證指令可以沿用；要怎麼驗證？` };
    return { ok: true, v: { source: 'task', commands: steps, plan: null, task: t, setup: t.setup_cmd ?? null, note: `驗證沿用 ${t.id}「${t.title}」` } };
  }
  if (planRef) {
    if (!o.allowed.includes('plan')) return { ok: false, question: '這類工作不需要驗證方案' };
    const { plan, candidates } = findPlan(db, planRef, o.repo);
    if (!plan) return { ok: false, question: `找不到驗證方案「${planRef}」${candidates.length ? `；是這幾個之一嗎：${candidates.join('、')}` : '；可在 /plans.html 新增'}` };
    return { ok: true, v: { source: 'plan', commands: [], plan, task: null, setup: plan.setup_cmd, note: `驗證用驗證方案「${plan.name}」（${plan.id}）` } };
  }
  const given = (o.verify ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (given.length) {
    if (!o.allowed.includes('user')) return { ok: false, question: '這類工作要用驗證方案來驗證' };
    const missing = unsaid(o.said, given);
    if (missing.length) {
      return { ok: false, question: `驗證指令要是你親口給的，我不能自己寫：「${missing.join('」「')}」你沒有說過——要用哪個指令驗證？（或指定驗證方案）` };
    }
    return { ok: true, v: { source: 'user', commands: given, plan: null, task: null, setup: detectSetup(o.repo), note: '驗證指令是你給的' } };
  }
  if (o.allowed.includes('detected')) {
    const detected = detectVerify(o.repo);
    if (detected.length) {
      return { ok: true, v: { source: 'detected', commands: detected, plan: null, task: null, setup: detectSetup(o.repo), note: `偵測到的驗證指令（請確認）：${detected.join('；')}` } };
    }
  }
  return { ok: true, v: { source: 'none', commands: [], plan: null, task: null, setup: null, note: '' } };
}
