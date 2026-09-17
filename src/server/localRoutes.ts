import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { getLocalModel, listLocalModels, registerRecipe, type LocalModel } from '../local/models.js';
import { recipeInfo } from '../local/recipes.js';
import { imageExists, type DockerProbe } from '../local/images.js';
import { weightInfo } from '../local/weights.js';
import { getModelManager, type ModelManager } from '../local/modelManager.js';
import { buildCatalog, type CatalogDeps, type CatalogEntry } from '../local/catalog.js';
import { getJobRunner, JobBusyError, type JobKind, type LocalJobRunner } from '../local/jobs.js';
import { activeLocalRunCount } from '../tasks.js';

export interface LocalRouteOptions {
  /** Test-only: a stub manager so route tests never touch docker/vLLM. */
  modelManager?: Pick<ModelManager, 'state' | 'ensureLoaded' | 'stop'>;
  /** Test-only: HF cache dir to measure downloaded weights against. */
  hubDir?: string;
  /** Test-only: stands in for `docker images -q`. */
  dockerProbe?: DockerProbe;
  /** Test-only: a stub runner so no `uvx`/`docker` is ever spawned. */
  jobRunner?: Pick<LocalJobRunner, 'start' | 'current' | 'cancel' | 'tail'>;
  /** Test-only: HF size lookup (null = offline), free-disk probe and clock. */
  catalog?: Pick<CatalogDeps, 'fetch' | 'diskFree' | 'now'>;
}

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

const MIN_FREE_BYTES = 50 * 1024 ** 3;

/**
 * 本地模型 API. The model list is always readable (the board fills its model <select> before
 * anyone opts in); everything else is 404 while local_models_enabled is off, and a switch refuses
 * (409) to restart vLLM under an in-flight local run — the same rule the tick applies.
 *
 * The catalog + jobs routes are what the 模型 panel is built on: every recipe on disk, what it
 * would take to use it here, and one background download/build at a time.
 */
export function registerLocalRoutes(app: FastifyInstance, db: Database.Database, opts: LocalRouteOptions = {}): void {
  const mm = () => opts.modelManager ?? getModelManager(db);
  const jobs = () => opts.jobRunner ?? getJobRunner(db);
  const enabled = () => getBool(db, 'local_models_enabled', false);
  const disabled = { error: 'local models disabled (set local_models_enabled=true)' };
  const repo = () => getSetting(db, 'local_vllm_repo') || '';
  const sparks = () => Math.max(1, getNum(db, 'local_spark_nodes', 1));
  const catalogDeps = (): CatalogDeps => ({
    hubDir: opts.hubDir,
    dockerProbe: opts.dockerProbe,
    fetch: opts.catalog ? opts.catalog.fetch : (globalThis.fetch as CatalogDeps['fetch']),
    diskFree: opts.catalog?.diskFree,
    now: opts.catalog?.now,
  });
  const catalog = () => buildCatalog(db, repo(), sparks(), mm().state(), jobs().current(), catalogDeps());

  /**
   * Why a switch must not start. Shared by the registered-model and catalog load routes so the
   * two can never disagree about what is safe.
   */
  function loadGuard(model: LocalModel): { code: number; error: string } | null {
    if (!model.enabled) return { code: 409, error: `local model ${model.id} is disabled` };
    const info = recipeInfo(model.recipe, repo());
    const nodes = info?.nodes ?? 1;
    if (nodes > sparks()) {
      // run-recipe.py would reject --solo anyway; failing here keeps vLLM up instead of
      // tearing the running model down for a switch that cannot succeed
      return { code: 409, error: `${model.display_name} 需要 ${nodes} 台 Spark（目前 ${sparks()} 台）` };
    }
    const weights = weightInfo(model.served_model_id, opts.hubDir);
    if (!weights.downloaded) {
      return { code: 409, error: `${model.display_name} 的權重${weights.partial ? '還沒下載完（可續傳）' : '還沒下載'}` };
    }
    // The incident this guards: run-recipe.sh stops the running model, then asks "Build now?",
    // gets EOF, and the machine ends up serving nothing.
    if (!imageExists(info?.container, opts.dockerProbe)) {
      return {
        code: 409,
        error: `容器映像 ${info?.container} 還沒建置——請先在模型面板按「建置映像」（或在主機執行 run-recipe.sh ${model.recipe} --solo --build-only），否則切換會讓目前的模型停掉又起不來`,
      };
    }
    const inflight = activeLocalRunCount(db);
    if (inflight > 0 && mm().state().loaded !== model.id) {
      return { code: 409, error: `${inflight} local run(s) in flight — switch after they finish` };
    }
    return null;
  }

  app.get('/api/local/models', async () => {
    const models: AnnotatedLocalModel[] = listLocalModels(db).map((m) => {
      const weights = weightInfo(m.served_model_id, opts.hubDir);
      const info = recipeInfo(m.recipe, repo());
      const nodes = info?.nodes ?? 1;
      const imageReady = imageExists(info?.container, opts.dockerProbe);
      // order matters: report the physical limit before the flag, since a model is usually
      // disabled *because* it needs more machines than this deployment has
      const blocked =
        nodes > sparks()
          ? `需要 ${nodes} 台 Spark（目前 ${sparks()} 台）`
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
    });
    return { enabled: enabled(), sparks: sparks(), models, state: mm().state(), inflight: activeLocalRunCount(db) };
  });

  app.post('/api/local/models/:id/load', async (req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const { id } = req.params as { id: string };
    const model = getLocalModel(db, id);
    if (!model) return reply.code(404).send({ error: `unknown local model: ${id}` });
    const guard = loadGuard(model);
    if (guard) return reply.code(guard.code).send({ error: guard.error });
    return { ok: true, result: mm().ensureLoaded(id), state: mm().state() };
  });

  app.post('/api/local/stop', async (_req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const inflight = activeLocalRunCount(db);
    if (inflight > 0) return reply.code(409).send({ error: `${inflight} local run(s) in flight — stop after they finish` });
    await mm().stop();
    return { ok: true, state: mm().state() };
  });

  // ---- catalog: every recipe on this machine --------------------------------------------------

  app.get('/api/local/catalog', async (_req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    return { enabled: true, ...(await catalog()) };
  });

  const findEntry = async (recipe: string): Promise<CatalogEntry | undefined> => (await catalog()).entries.find((e) => e.recipe === recipe);

  /** Switch to a recipe straight from the catalog; registers it in local_models on first use. */
  app.post('/api/local/catalog/:recipe/load', async (req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const { recipe } = req.params as { recipe: string };
    const entry = await findEntry(recipe);
    if (!entry) return reply.code(404).send({ error: `unknown recipe: ${recipe}` });
    if (entry.action === 'none') return reply.code(409).send({ error: entry.blocked_by ?? '這台跑不動' });
    if (!entry.model) return reply.code(409).send({ error: '配方缺少 model 欄位' });
    const model = registerRecipe(db, { recipe: entry.recipe, name: entry.name, model: entry.model });
    const guard = loadGuard(model);
    if (guard) return reply.code(guard.code).send({ error: guard.error });
    return { ok: true, id: model.id, result: mm().ensureLoaded(model.id), state: mm().state() };
  });

  // ---- jobs: one download or image build at a time ----------------------------------------------

  app.post('/api/local/jobs', async (req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const body = (req.body ?? {}) as { kind?: unknown; recipe?: unknown };
    const kind = body.kind as JobKind;
    if (kind !== 'download' && kind !== 'build') return reply.code(400).send({ error: 'kind must be download or build' });
    const recipe = typeof body.recipe === 'string' ? body.recipe.trim() : '';
    if (!recipe) return reply.code(400).send({ error: 'recipe is required' });
    const cat = await catalog();
    const entry = cat.entries.find((e) => e.recipe === recipe);
    if (!entry) return reply.code(400).send({ error: `unknown recipe: ${recipe}` });
    if (entry.nodes > cat.sparks) return reply.code(409).send({ error: entry.blocked_by });
    if (kind === 'download') {
      if (!entry.model) return reply.code(400).send({ error: '配方缺少 model 欄位' });
      if (entry.gated && !entry.downloaded) return reply.code(409).send({ error: entry.blocked_by });
      if (entry.downloaded) return reply.code(409).send({ error: `${entry.name} 的權重已經下載好了` });
      // only refuse when we know the size — an unknown size must not block a 20 GB pull on a 3 TB disk
      if (entry.size_bytes != null && cat.disk_free_bytes != null) {
        const need = Math.max(entry.size_bytes * 1.2, MIN_FREE_BYTES);
        if (cat.disk_free_bytes < need) {
          return reply.code(507).send({ error: `磁碟剩餘 ${gb(cat.disk_free_bytes)}，下載 ${entry.name} 需要約 ${gb(need)}` });
        }
      }
    } else {
      if (!entry.container) return reply.code(400).send({ error: '配方沒有指定容器映像' });
      if (entry.image_ready) return reply.code(409).send({ error: `映像 ${entry.container} 已經建好了` });
    }
    try {
      const job = jobs().start(kind, recipe, { model: entry.model, container: entry.container, size_bytes: entry.size_bytes, repo: repo() });
      return reply.code(202).send({ ok: true, job });
    } catch (err) {
      if (err instanceof JobBusyError) return reply.code(409).send({ error: err.message });
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get('/api/local/jobs/current', async (_req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    return { job: jobs().current() };
  });

  app.post('/api/local/jobs/current/cancel', async (_req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const job = jobs().cancel();
    if (!job) return reply.code(404).send({ error: '沒有正在跑的工作' });
    return { ok: true, job };
  });

  // The log path comes from the runner's own record, never from the request — nothing to traverse.
  app.get('/api/local/jobs/current/log', async (req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const job = jobs().current();
    if (!job) return reply.code(404).send({ error: '沒有工作' });
    const q = (req.query ?? {}) as { lines?: string };
    const n = Math.max(1, Math.min(200, Number(q.lines) || 40));
    return { job_id: job.id, status: job.status, lines: jobs().tail(n) };
  });
}

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
