import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ENGINE_REPO_ROOT, type Complexity } from '../config.js';
import { getTask } from '../tasks.js';
import { parseSteps } from '../types.js';
import { initRepo, spikeRoot } from '../spike/create.js';
import { BENCH_DOMAINS, BenchmarkInputError, type NewBenchmarkInput } from './store.js';

/**
 * Where a benchmark's question comes from. The page offers four sources and every one of them
 * boils down to the same task-shaped fields createBenchmark() needs:
 *   task     — copy an existing task (its repo, plan, verification)
 *   draft    — a PRD-wizard draft: handled by the route through submitPrd (needs its markdown)
 *   builtin  — a neutral question from seed/bench/*.json, run in a fresh repo of its own
 *   manual   — the fields typed on the page
 */

export type SourceKind = 'task' | 'draft' | 'manual' | 'builtin';

export interface BuiltinQuestion {
  key: string;
  title: string;
  goal: string;
  domain: string;
  complexity: Complexity;
  verification_steps: string[];
  setup_cmd?: string;
  verify_rubric?: string;
  files: Record<string, string>;
}

export type QuestionFields = Pick<NewBenchmarkInput, 'title' | 'goal' | 'plan_ref' | 'repo_path' | 'base_branch' | 'verification_steps' | 'setup_cmd' | 'verify_rubric' | 'domain' | 'complexity'>;

export const BENCH_SEED_DIR = path.join(ENGINE_REPO_ROOT, 'seed', 'bench');

export function listBuiltin(dir = BENCH_SEED_DIR): Array<Omit<BuiltinQuestion, 'files'> & { file_count: number }> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: Array<Omit<BuiltinQuestion, 'files'> & { file_count: number }> = [];
  for (const f of names) {
    const q = loadBuiltin(f.slice(0, -5), dir);
    if (q) {
      const { files, ...rest } = q;
      out.push({ ...rest, file_count: Object.keys(files).length });
    }
  }
  return out;
}

export function loadBuiltin(key: string, dir = BENCH_SEED_DIR): BuiltinQuestion | null {
  if (!/^[a-z0-9-]+$/.test(key)) return null;
  try {
    const q = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as BuiltinQuestion;
    if (!q.title || !q.goal || !Array.isArray(q.verification_steps) || !q.files) return null;
    return { ...q, key, domain: (BENCH_DOMAINS as readonly string[]).includes(q.domain) ? q.domain : 'other', complexity: q.complexity ?? 'M' };
  } catch {
    return null;
  }
}

export interface ResolveDeps {
  builtinDir?: string;
  repoRoot?: string;
  git?: (args: string[], cwd: string) => void;
}

/** Task-shaped fields for a source; throws BenchmarkInputError when the source cannot be used. */
export function resolveSource(db: Database.Database, kind: SourceKind, ref: string | null, overrides: Partial<QuestionFields> = {}, deps: ResolveDeps = {}): QuestionFields & { source_kind: SourceKind; source_ref: string | null } {
  if (kind === 'task') {
    const t = ref ? getTask(db, ref) : undefined;
    if (!t) throw new BenchmarkInputError(`找不到任務：${ref ?? ''}`);
    return {
      title: overrides.title ?? t.title,
      goal: overrides.goal ?? t.goal,
      plan_ref: overrides.plan_ref ?? t.plan_ref,
      repo_path: overrides.repo_path ?? t.repo_path,
      base_branch: overrides.base_branch ?? t.base_branch,
      verification_steps: overrides.verification_steps?.length ? overrides.verification_steps : parseSteps(t),
      setup_cmd: overrides.setup_cmd ?? t.setup_cmd,
      verify_rubric: overrides.verify_rubric ?? t.verify_rubric,
      domain: overrides.domain ?? 'other',
      complexity: overrides.complexity ?? (t.complexity as Complexity) ?? 'M',
      source_kind: 'task',
      source_ref: t.id,
    };
  }
  if (kind === 'builtin') {
    const q = ref ? loadBuiltin(ref, deps.builtinDir) : null;
    if (!q) throw new BenchmarkInputError(`沒有這題：${ref ?? ''}`);
    const root = path.join(deps.repoRoot ?? spikeRoot(db), '.bench');
    fs.mkdirSync(root, { recursive: true });
    const slug = `${q.key}-${Date.now().toString(36)}`;
    const { repo } = initRepo(root, slug, q.files, `bench: ${q.title}`, deps.git);
    return {
      title: overrides.title ?? q.title,
      goal: overrides.goal ?? q.goal,
      plan_ref: path.join(repo, 'PLAN.md'),
      repo_path: repo,
      base_branch: 'main',
      verification_steps: q.verification_steps,
      setup_cmd: q.setup_cmd ?? null,
      verify_rubric: q.verify_rubric ?? null,
      domain: q.domain,
      complexity: q.complexity,
      source_kind: 'builtin',
      source_ref: q.key,
    };
  }
  if (kind === 'manual') {
    if (!overrides.title || !overrides.goal) throw new BenchmarkInputError('title and goal are required');
    return {
      title: overrides.title,
      goal: overrides.goal,
      plan_ref: overrides.plan_ref ?? null,
      repo_path: overrides.repo_path ?? null,
      base_branch: overrides.base_branch ?? null,
      verification_steps: overrides.verification_steps ?? [],
      setup_cmd: overrides.setup_cmd ?? null,
      verify_rubric: overrides.verify_rubric ?? null,
      domain: overrides.domain ?? 'other',
      complexity: overrides.complexity ?? 'M',
      source_kind: 'manual',
      source_ref: null,
    };
  }
  throw new BenchmarkInputError(`source.kind must be task, draft, builtin or manual (got ${String(kind)})`);
}
