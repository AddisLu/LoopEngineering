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

/** null when the recipe file is not there (a different machine, or a renamed recipe). */
export function recipeInfo(recipe: string, repo: string): RecipeInfo | null {
  if (!recipe || !repo) return null;
  const key = `${repo}|${recipe}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  let info: RecipeInfo | null = null;
  try {
    const text = fs.readFileSync(path.join(repo, 'recipes', `${recipe}.yaml`), 'utf8');
    const clusterOnly = bool(text, 'cluster_only') ?? false;
    info = {
      cluster_only: clusterOnly,
      nodes: clusterOnly ? 2 : 1,
      tensor_parallel: num(text, 'tensor_parallel'),
      max_model_len: num(text, 'max_model_len'),
      container: str(text, 'container'),
    };
  } catch {
    info = null; // not on this machine — the caller falls back to "assume a single node"
  }
  cache.set(key, info);
  return info;
}

/** Test seam: recipes are read once per process. */
export function clearRecipeCache(): void {
  cache.clear();
}
