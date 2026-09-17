import fs from 'node:fs';
import path from 'node:path';

/**
 * What a vLLM recipe needs to run.
 *
 * The switcher on the chat page has to answer one question honestly: can *this* deployment run
 * that model? The recipes in spark-vllm-docker already say so — `cluster_only: true` means
 * run-recipe.py refuses `--solo` (it errors out), which is exactly "needs more than one Spark".
 *
 * Parsed with regexes rather than a YAML dependency: only three top-level scalars are read, and
 * anything unreadable degrades to "single node, unknown size" instead of throwing.
 */

export interface RecipeInfo {
  /** cannot run on one machine — run-recipe.py rejects --solo */
  cluster_only: boolean;
  /** the opposite: run-recipe.py rejects a cluster launch */
  solo_only: boolean;
  /** free-text fields the catalog shows; null when the yaml does not have them */
  name: string | null;
  description: string | null;
  /** HF repo id the recipe serves (what `hf download` pulls) — null means the catalog cannot act on it */
  model: string | null;
  /** how many DGX Sparks this recipe needs (1 unless it is cluster-only) */
  nodes: number;
  tensor_parallel: number | null;
  max_model_len: number | null;
  /** docker image the recipe runs in; run-recipe.sh offers to build it when missing */
  container: string | null;
}

const cache = new Map<string, RecipeInfo | null>();

const bool = (text: string, key: string): boolean | null => {
  const m = new RegExp(`^${key}:\\s*(true|false)\\s*$`, 'mi').exec(text);
  return m ? m[1]!.toLowerCase() === 'true' : null;
};
const num = (text: string, key: string): number | null => {
  const m = new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, 'm').exec(text);
  return m ? Number(m[1]) : null;
};
const str = (text: string, key: string): string | null => {
  const m = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(text);
  return m ? m[1]! : null;
};
// name / description carry spaces and parentheses; strip one layer of quotes
const text = (src: string, key: string): string | null => {
  const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(src);
  if (!m) return null;
  const v = m[1]!.replace(/^(["'])(.*)\1$/, '$2').trim();
  return v || null;
};

/** null when the recipe file is not there (a different machine, or a renamed recipe). */
export function recipeInfo(recipe: string, repo: string): RecipeInfo | null {
  if (!recipe || !repo) return null;
  const key = `${repo}|${recipe}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  let info: RecipeInfo | null = null;
  try {
    const text_ = fs.readFileSync(path.join(repo, 'recipes', `${recipe}.yaml`), 'utf8');
    const clusterOnly = bool(text_, 'cluster_only') ?? false;
    info = {
      cluster_only: clusterOnly,
      solo_only: bool(text_, 'solo_only') ?? false,
      name: text(text_, 'name'),
      description: text(text_, 'description'),
      model: str(text_, 'model'),
      nodes: clusterOnly ? 2 : 1,
      tensor_parallel: num(text_, 'tensor_parallel'),
      max_model_len: num(text_, 'max_model_len'),
      container: str(text_, 'container'),
    };
  } catch {
    info = null; // not on this machine — the caller falls back to "assume a single node"
  }
  cache.set(key, info);
  return info;
}

/**
 * Recipe names available on this machine: top-level `recipes/*.yaml` only. The `Nx-spark-cluster/`
 * subfolders hold multi-node variants that a single Spark can never run, so they are not listed.
 */
export function listRecipes(repo: string): string[] {
  if (!repo) return [];
  try {
    return fs
      .readdirSync(path.join(repo, 'recipes'), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.yaml'))
      .map((d) => d.name.slice(0, -'.yaml'.length))
      .sort();
  } catch {
    return [];
  }
}

/** Test seam: recipes are read once per process. */
export function clearRecipeCache(): void {
  cache.clear();
}
