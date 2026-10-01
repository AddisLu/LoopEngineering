import { analyseArchitecture, type Architecture } from './architecture.js';
import { buildCtx, defaultGit, type RepoCtx } from './context.js';
import { analyseHotspots } from './hotspots.js';
import { buildCodeIndex } from './index.js';
import { analyseRequirements } from './requirements.js';
import { analyseStyle } from './style.js';
import type { AnalyseOptions, Hotspot, IndexEntry, ModuleInfo, Requirement, RepoAnalysis, StyleProfile, VerifyProfile } from './types.js';
import { analyseVerify } from './verify.js';

/**
 * Repo 檔案, stage A: a deterministic, model-free profile of a git checkout — requirements,
 * style, architecture, verification, hotspots — plus the code index. Read-only (`git ls-files`,
 * `git log`, `git grep`, file reads); seconds for a few hundred files. Never throws: whatever
 * fails lands in `facets.warnings` and that facet comes back empty.
 */

export type * from './types.js';
export { analyseArchitecture } from './architecture.js';
export { analyseRequirements } from './requirements.js';
export { analyseStyle } from './style.js';
export { analyseVerify } from './verify.js';
export { analyseHotspots } from './hotspots.js';
export { buildCodeIndex } from './index.js';

const EMPTY_VERIFY: VerifyProfile = {
  frameworks: [],
  test_dirs: [],
  commands: [],
  headless: [],
  gui_only: [],
  eval_scripts: [],
  answer_files: [],
  protected_suggestions: [],
};

function safe<T>(warnings: string[], label: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    warnings.push(`${label}失敗：${(e as Error)?.message ?? String(e)}`);
    return fallback;
  }
}

export function analyseRepo(dir: string, opts: AnalyseOptions = {}): RepoAnalysis {
  const now = opts.now ?? Date.now;
  const started = now();
  const git = opts.git ?? defaultGit;
  const warnings: string[] = [];
  const ctx: RepoCtx = safe(warnings, '讀取 repo ', null as unknown as RepoCtx, () => buildCtx(dir, git, warnings));
  if (!ctx) {
    return {
      facets: { sha: null, requirements: [], style: [], modules: [], verify: { ...EMPTY_VERIFY }, hotspots: [], built_ms: now() - started, warnings },
      index: [],
    };
  }
  const sha = safe<string | null>(warnings, '讀取 HEAD ', null, () => git(['rev-parse', 'HEAD'], dir).trim() || null);
  const emptyArch: Architecture = { modules: [], ownerOf: () => null, unitOf: () => null, sources: new Map(), cmakeProjects: new Map(), cmake: new Map() };
  const arch = safe<Architecture>(warnings, '架構分析', emptyArch, () => analyseArchitecture(ctx));
  const modules: ModuleInfo[] = arch.modules;
  const requirements = safe<Requirement[]>(warnings, '需求分析', [], () => analyseRequirements(ctx, arch));
  const style = safe<StyleProfile[]>(warnings, '風格分析', [], () => analyseStyle(ctx, opts.maxStyleFiles ?? 300));
  const verify = safe<VerifyProfile>(warnings, '驗證分析', { ...EMPTY_VERIFY }, () => analyseVerify(ctx, arch));
  const hotspots = safe<Hotspot[]>(warnings, '熱點分析', [], () => analyseHotspots(ctx));
  const index = safe<IndexEntry[]>(warnings, '程式索引', [], () => buildCodeIndex(ctx));
  return {
    facets: { sha, requirements, style, modules, verify, hotspots, built_ms: Math.max(0, now() - started), warnings },
    index,
  };
}
