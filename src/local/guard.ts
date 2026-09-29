import type Database from 'better-sqlite3';
import { getNum, getSetting } from '../db/index.js';
import type { LocalModel } from './models.js';
import { recipeInfo } from './recipes.js';
import { imageExists, type DockerProbe } from './images.js';
import { weightInfo } from './weights.js';
import { activeLocalRunCount } from '../tasks.js';

/**
 * Whether a local model can be offered, and why a switch to it must not start. Shared by the
 * 本地模型 routes (the switcher, the catalog) and 對話操作 so they never disagree about what is
 * safe to load on this machine.
 */

/** What the switcher on the chat page needs to decide whether a model is offerable today. */
export interface AnnotatedLocalModel extends LocalModel {
  /** weights are in the HF cache — switching will not pull tens of GB first */
  downloaded: boolean;
  /** some blobs on disk but the pull did not finish (resumable) */
  partial: boolean;
  disk_bytes: number | null;
  /** DGX Sparks this recipe needs (2 for a cluster_only recipe) */
  nodes: number;
  /** the recipe's container image is built — switching will not stop to ask */
  image_ready: boolean;
  /** enabled + downloaded + enough machines + image built */
  runnable: boolean;
  /** why not, in the user's words — null when runnable */
  blocked_by: string | null;
}

/** Test seams: the HF cache to measure weights against, and a stand-in for `docker images -q`. */
export interface LocalGuardDeps {
  hubDir?: string;
  dockerProbe?: DockerProbe;
}

export const localVllmRepo = (db: Database.Database): string => getSetting(db, 'local_vllm_repo') || '';
export const localSparkNodes = (db: Database.Database): number => Math.max(1, getNum(db, 'local_spark_nodes', 1));

export function annotateLocalModel(db: Database.Database, m: LocalModel, d: LocalGuardDeps = {}): AnnotatedLocalModel {
  const weights = weightInfo(m.served_model_id, d.hubDir);
  const info = recipeInfo(m.recipe, localVllmRepo(db));
  const nodes = info?.nodes ?? 1;
  const sparks = localSparkNodes(db);
  const imageReady = imageExists(info?.container, d.dockerProbe);
  // order matters: report the physical limit before the flag, since a model is usually
  // disabled *because* it needs more machines than this deployment has
  const blocked =
    nodes > sparks
      ? `需要 ${nodes} 台 Spark（目前 ${sparks} 台）`
      : !weights.downloaded
        ? weights.partial
          ? '權重下載到一半（可續傳）'
          : '尚未下載權重'
        : !imageReady
          ? `容器映像 ${info?.container} 還沒建置`
          : !m.enabled
            ? '未啟用'
            : null;
  return { ...m, ...weights, nodes, image_ready: imageReady, runnable: blocked === null, blocked_by: blocked };
}

/**
 * Why a switch to `model` must not start (null = go). `loaded` is the model serving right now: an
 * in-flight local run only blocks switching away from it.
 */
export function localLoadGuard(
  db: Database.Database,
  model: LocalModel,
  d: LocalGuardDeps & { loaded: string | null },
): { code: number; error: string } | null {
  if (!model.enabled) return { code: 409, error: `local model ${model.id} is disabled` };
  const info = recipeInfo(model.recipe, localVllmRepo(db));
  const nodes = info?.nodes ?? 1;
  const sparks = localSparkNodes(db);
  if (nodes > sparks) {
    // run-recipe.py would reject --solo anyway; failing here keeps vLLM up instead of
    // tearing the running model down for a switch that cannot succeed
    return { code: 409, error: `${model.display_name} 需要 ${nodes} 台 Spark（目前 ${sparks} 台）` };
  }
  const weights = weightInfo(model.served_model_id, d.hubDir);
  if (!weights.downloaded) {
    return { code: 409, error: `${model.display_name} 的權重${weights.partial ? '還沒下載完（可續傳）' : '還沒下載'}` };
  }
  // The incident this guards: run-recipe.sh stops the running model, then asks "Build now?",
  // gets EOF, and the machine ends up serving nothing.
  if (!imageExists(info?.container, d.dockerProbe)) {
    return {
      code: 409,
      error: `容器映像 ${info?.container} 還沒建置——請先在模型面板按「建置映像」（或在主機執行 run-recipe.sh ${model.recipe} --solo --build-only），否則切換會讓目前的模型停掉又起不來`,
    };
  }
  const inflight = activeLocalRunCount(db);
  if (inflight > 0 && d.loaded !== model.id) {
    return { code: 409, error: `${inflight} local run(s) in flight — switch after they finish` };
  }
  return null;
}
