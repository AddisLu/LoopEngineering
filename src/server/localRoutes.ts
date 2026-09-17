import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { getLocalModel, listLocalModels, type LocalModel } from '../local/models.js';
import { recipeInfo } from '../local/recipes.js';
import { imageExists, type DockerProbe } from '../local/images.js';
import { weightInfo } from '../local/weights.js';
import { getModelManager, type ModelManager } from '../local/modelManager.js';
import { activeLocalRunCount } from '../tasks.js';

export interface LocalRouteOptions {
  /** Test-only: a stub manager so route tests never touch docker/vLLM. */
  modelManager?: Pick<ModelManager, 'state' | 'ensureLoaded' | 'stop'>;
  /** Test-only: HF cache dir to measure downloaded weights against. */
  hubDir?: string;
  /** Test-only: stands in for `docker images -q`. */
  dockerProbe?: DockerProbe;
}

/** What the switcher on the chat page needs to decide whether a model is offerable today. */
export interface AnnotatedLocalModel extends LocalModel {
  /** weights are in the HF cache — switching will not pull tens of GB first */
  downloaded: boolean;
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

/**
 * 本地模型 API. The model list is always readable (the board fills its model <select> before
 * anyone opts in); load/stop are 404 while local_models_enabled is off, and refuse (409) to
 * restart vLLM under an in-flight local run — the same rule the tick applies to switches.
 */
export function registerLocalRoutes(app: FastifyInstance, db: Database.Database, opts: LocalRouteOptions = {}): void {
  const mm = () => opts.modelManager ?? getModelManager(db);
  const enabled = () => getBool(db, 'local_models_enabled', false);
  const disabled = { error: 'local models disabled (set local_models_enabled=true)' };

  app.get('/api/local/models', async () => {
    const sparks = Math.max(1, getNum(db, 'local_spark_nodes', 1));
    const repo = getSetting(db, 'local_vllm_repo') || '';
    const models: AnnotatedLocalModel[] = listLocalModels(db).map((m) => {
      const weights = weightInfo(m.served_model_id, opts.hubDir);
      const info = recipeInfo(m.recipe, repo);
      const nodes = info?.nodes ?? 1;
      const imageReady = imageExists(info?.container, opts.dockerProbe);
      // order matters: report the physical limit before the flag, since a model is usually
      // disabled *because* it needs more machines than this deployment has
      const blocked =
        nodes > sparks
          ? `需要 ${nodes} 台 Spark（目前 ${sparks} 台）`
          : !weights.downloaded
            ? '尚未下載權重'
            : !imageReady
              ? `容器映像 ${info?.container} 還沒建置`
              : !m.enabled
                ? '未啟用'
                : null;
      return { ...m, ...weights, nodes, image_ready: imageReady, runnable: blocked === null, blocked_by: blocked };
    });
    return { enabled: enabled(), sparks, models, state: mm().state(), inflight: activeLocalRunCount(db) };
  });

  app.post('/api/local/models/:id/load', async (req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const { id } = req.params as { id: string };
    const model = getLocalModel(db, id);
    if (!model) return reply.code(404).send({ error: `unknown local model: ${id}` });
    if (!model.enabled) return reply.code(409).send({ error: `local model ${id} is disabled` });
    const nodes = recipeInfo(model.recipe, getSetting(db, 'local_vllm_repo') || '')?.nodes ?? 1;
    const sparks = Math.max(1, getNum(db, 'local_spark_nodes', 1));
    if (nodes > sparks) {
      // run-recipe.py would reject --solo anyway; failing here keeps vLLM up instead of
      // tearing the running model down for a switch that cannot succeed
      return reply.code(409).send({ error: `${model.display_name} 需要 ${nodes} 台 Spark（目前 ${sparks} 台）` });
    }
    if (!weightInfo(model.served_model_id, opts.hubDir).downloaded) {
      return reply.code(409).send({ error: `${model.display_name} 的權重還沒下載` });
    }
    // The incident this guards: run-recipe.sh stops the running model, then asks "Build now?",
    // gets EOF, and the machine ends up serving nothing.
    const container = recipeInfo(model.recipe, getSetting(db, 'local_vllm_repo') || '')?.container;
    if (!imageExists(container, opts.dockerProbe)) {
      return reply.code(409).send({
        error: `容器映像 ${container} 還沒建置——請先在主機執行 run-recipe.sh ${model.recipe} --solo --build-only，否則切換會讓目前的模型停掉又起不來`,
      });
    }
    const inflight = activeLocalRunCount(db);
    if (inflight > 0 && mm().state().loaded !== id) {
      return reply.code(409).send({ error: `${inflight} local run(s) in flight — switch after they finish` });
    }
    return { ok: true, result: mm().ensureLoaded(id), state: mm().state() };
  });

  app.post('/api/local/stop', async (_req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const inflight = activeLocalRunCount(db);
    if (inflight > 0) return reply.code(409).send({ error: `${inflight} local run(s) in flight — stop after they finish` });
    await mm().stop();
    return { ok: true, state: mm().state() };
  });
}
