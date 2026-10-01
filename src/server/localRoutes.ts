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
import { annotateLocalModel, localLoadGuard } from '../local/guard.js';
import { clusterWorkers, realClusterExec, workerWeights, type ClusterExec } from '../local/cluster.js';

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
  /** two Sparks: how the other nodes are found and asked about their weights (tests inject both) */
  clusterWorkers?: () => string[];
  clusterExec?: ClusterExec;
}

export type { AnnotatedLocalModel } from '../local/guard.js';

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
  const workers = (): string[] => (opts.clusterWorkers ? opts.clusterWorkers() : clusterWorkers(repo()));
  const isClusterEntry = (entry: { nodes: number }): boolean => entry.nodes > 1 && sparks() >= 2;

  /**
   * Why a switch must not start. Shared by the registered-model and catalog load routes so the
   * two can never disagree about what is safe.
   */
  function loadGuard(model: LocalModel): { code: number; error: string } | null {
    return localLoadGuard(db, model, { hubDir: opts.hubDir, dockerProbe: opts.dockerProbe, loaded: mm().state().loaded });
  }

  app.get('/api/local/models', async () => {
    const models = listLocalModels(db).map((m) => annotateLocalModel(db, m, { hubDir: opts.hubDir, dockerProbe: opts.dockerProbe }));
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
    // two Sparks: a node without the weights never joins — the head waits 10 minutes and ends up
    // serving nothing. Ask every worker first (one ssh each) and refuse with what to do instead.
    if (isClusterEntry(entry)) {
      const ws = workers();
      if (ws.length) {
        const checked = await workerWeights(entry.model, ws, opts.clusterExec ?? realClusterExec, opts.hubDir);
        const bad = checked.filter((w) => !w.ok);
        if (bad.length) {
          return reply.code(409).send({
            error: `另一台 Spark 還沒有這個模型的權重（${bad.map((b) => b.reason).join('；')}）——先同步到另一台再切換`,
            code: 'worker_weights',
            workers: bad,
          });
        }
      }
    }
    return { ok: true, id: model.id, result: mm().ensureLoaded(model.id), state: mm().state() };
  });

  // ---- jobs: one download or image build at a time ----------------------------------------------

  app.post('/api/local/jobs', async (req, reply) => {
    if (!enabled()) return reply.code(404).send(disabled);
    const body = (req.body ?? {}) as { kind?: unknown; recipe?: unknown };
    const kind = body.kind as JobKind;
    if (kind !== 'download' && kind !== 'build' && kind !== 'sync') return reply.code(400).send({ error: 'kind must be download, build or sync' });
    const recipe = typeof body.recipe === 'string' ? body.recipe.trim() : '';
    if (!recipe) return reply.code(400).send({ error: 'recipe is required' });
    const cat = await catalog();
    const entry = cat.entries.find((e) => e.recipe === recipe);
    if (!entry) return reply.code(400).send({ error: `unknown recipe: ${recipe}` });
    if (entry.nodes > cat.sparks) return reply.code(409).send({ error: entry.blocked_by });
    const followWorkers = isClusterEntry(entry) ? workers() : [];
    if (kind === 'sync') {
      if (!entry.model) return reply.code(400).send({ error: '配方缺少 model 欄位' });
      if (!entry.downloaded) return reply.code(409).send({ error: `${entry.name} 在這台還沒下載完，先下載` });
      if (!followWorkers.length) return reply.code(409).send({ error: '沒有其他 Spark 要同步（兩台設定：local_spark_nodes=2，且 vLLM repo 的 .env 有 CLUSTER_NODES）' });
    } else if (kind === 'download') {
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
      // a two-Spark model's download continues with the copy to the other node(s) by itself
      const job = jobs().start(kind, recipe, {
        model: entry.model,
        container: entry.container,
        size_bytes: entry.size_bytes,
        repo: repo(),
        ...(kind !== 'build' && followWorkers.length ? { workers: followWorkers } : {}),
      });
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
