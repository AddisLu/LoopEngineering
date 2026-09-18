import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ENGINE_REPO_ROOT, paths, type Complexity } from '../config.js';
import { getTask } from '../tasks.js';
import { parseSteps } from '../types.js';
import { initRepo, spikeRoot, SpikeError } from '../spike/create.js';
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
  plansDir?: string;
}

/** Every task needs a plan the reviewer can read; a typed-in question has none, so write one. */
export function writeQuestionPlan(fields: { title: string; goal: string; verification_steps: string[]; repo_path?: string | null }, dir = paths.plansDir): string {
  const slug = fields.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bench';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bench-${slug}-${Date.now()}.md`);
  const steps = fields.verification_steps.length ? fields.verification_steps.map((s) => `- \`${s}\``).join('\n') : '- （沒有指定驗證指令）';
  fs.writeFileSync(
    file,
    [
      `# ${fields.title}`,
      '',
      '## 目標',
      fields.goal,
      '',
      '## 原始碼',
      fields.repo_path ? `- repo：\`${fields.repo_path}\`` : '- （未指定 repo）',
      '',
      '## 怎麼驗證',
      steps,
      '',
      '## 規則',
      '- 這是一次模型評比：每個參賽模型各做一次同樣的題目，結果不會合併回 base branch。',
      '- 只改這個 repo 裡的程式，不要動機台或任何線上設定。',
      '',
    ].join('\n'),
  );
  return file;
}

/** A task's domain, guessed from what it declares it needs; 'other' when nothing matches. */
export function taskDomain(t: { requires?: string | null; repo_path?: string | null; goal?: string | null; title?: string | null }): string {
  const req = (t.requires ?? '').toLowerCase();
  if (/cuda|gpu/.test(req)) return 'cuda';
  const hay = `${t.title ?? ''} ${t.goal ?? ''} ${t.repo_path ?? ''}`.toLowerCase();
  for (const [re, domain] of [
    [/\bcuda\b|kernel|nvcc/, 'cuda'],
    [/opencv|影像|瑕疵|roi|halcon|\bcv\b/, 'cv'],
    [/\bc\+\+|cmake|\.cpp\b/, 'cpp'],
    [/c#|csharp|dotnet|\.net\b/, 'csharp'],
    [/typescript|node|fastify|\.ts\b/, 'typescript'],
    [/python|numpy|pytest|\.py\b/, 'python'],
  ] as Array<[RegExp, string]>) {
    if (re.test(hay)) return domain;
  }
  return 'other';
}

/** Task-shaped fields for a source; throws BenchmarkInputError when the source cannot be used. */
export function resolveSource(db: Database.Database, kind: SourceKind, ref: string | null, overrides: Partial<QuestionFields> = {}, deps: ResolveDeps = {}): QuestionFields & { source_kind: SourceKind; source_ref: string | null; cleanup?: () => void } {
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
      domain: overrides.domain ?? taskDomain(t),
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
    let repo: string;
    let origin: string;
    try {
      ({ repo, origin } = initRepo(root, slug, q.files, `bench: ${q.title}`, deps.git));
    } catch (err) {
      throw new BenchmarkInputError(err instanceof SpikeError ? err.message : `建立題目 repo 失敗：${String(err)}`);
    }
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
      // the question's repo exists before the benchmark row does; drop it if creation fails
      cleanup: () => {
        try {
          fs.rmSync(repo, { recursive: true, force: true });
          fs.rmSync(origin, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      },
    };
  }
  if (kind === 'manual') {
    if (!overrides.title || !overrides.goal) throw new BenchmarkInputError('題目要有標題和目標');
    const steps = overrides.verification_steps ?? [];
    // the typed-in form has no plan field, so the question itself becomes the plan; drop the
    // file again if the benchmark turns out to be invalid
    const plan = overrides.plan_ref ?? writeQuestionPlan({ title: overrides.title, goal: overrides.goal, verification_steps: steps, repo_path: overrides.repo_path }, deps.plansDir);
    return {
      title: overrides.title,
      goal: overrides.goal,
      plan_ref: plan,
      repo_path: overrides.repo_path ?? null,
      base_branch: overrides.base_branch?.trim() || 'main',
      verification_steps: overrides.verification_steps ?? [],
      setup_cmd: overrides.setup_cmd ?? null,
      verify_rubric: overrides.verify_rubric ?? null,
      domain: overrides.domain ?? 'other',
      complexity: overrides.complexity ?? 'M',
      source_kind: 'manual',
      source_ref: null,
      cleanup: overrides.plan_ref
        ? undefined
        : () => {
            try {
              fs.rmSync(plan, { force: true });
            } catch {
              /* best effort */
            }
          },
    };
  }
  throw new BenchmarkInputError(`source.kind must be task, draft, builtin or manual (got ${String(kind)})`);
}
