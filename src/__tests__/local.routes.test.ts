import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createTask, createRun, setStatus } from '../tasks.js';
import type { ModelManagerState } from '../local/modelManager.js';
import { clearRecipeCache } from '../local/recipes.js';
import { clearImageCache } from '../local/images.js';

let db: Database.Database;
let app: FastifyInstance;
const ensured: string[] = [];
let stopped = 0;
let st: ModelManagerState;
let tmp: string[] = [];

/**
 * The switcher reads two things off disk — the HF cache and the recipe yaml. Both are faked here
 * so the answers do not depend on which machine runs the suite.
 */
function fakeSpark(): { repo: string; hub: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-spark-'));
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-hub-'));
  tmp.push(repo, hub);
  fs.mkdirSync(path.join(repo, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'recipes', 'glm-5.3-flash.yaml'), 'model: x\ncluster_only: true\ndefaults:\n  tensor_parallel: 2\n');
  fs.writeFileSync(path.join(repo, 'recipes', 'qwen3.8-flash-next-nvfp4-solo.yaml'), 'model: x\ncluster_only: false\ndefaults:\n  tensor_parallel: 1\n');
  return { repo, hub };
}

/** Put fake weight blobs in the cache for one served model id. */
function downloaded(hub: string, servedId: string, bytes = 1024): void {
  const blobs = path.join(hub, `models--${servedId.replace(/\//g, '--')}`, 'blobs');
  fs.mkdirSync(blobs, { recursive: true });
  fs.writeFileSync(path.join(blobs, 'w1'), Buffer.alloc(bytes));
}

beforeEach(async () => {
  db = openTestDb();
  ensured.length = 0;
  stopped = 0;
  // both are process-wide caches (a recipe file and `docker images` barely change while the
  // server runs) — tests that swap the fake machine underneath must start from a clean slate
  clearRecipeCache();
  clearImageCache();
  st = { loaded: 'qwen38-flash', wanted: 'qwen38-flash', status: 'ready', since: null, error: null };
  // a cache where every seeded model is present, and every image is built — individual tests
  // below override this to exercise the "cannot run it" paths
  const baseHub = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-hub-base-'));
  tmp.push(baseHub);
  for (const served of [
    'local-inference-lab/Qwen3.8-Flash-Next-NVFP4',
    'Intel/Qwen3-Coder-Next-int4-AutoRound',
    'nvidia/Qwen3.6-35B-A3B-NVFP4',
    'nvidia/Qwen3.8-27B-NVFP4',
    'local-inference-lab/GLM-5.3-Flash-NVFP4-Spark',
  ]) {
    downloaded(baseHub, served);
  }
  app = buildApp({
    db,
    apiToken: null,
    localHubDir: baseHub,
    dockerProbe: () => true,
    modelManager: {
      state: () => ({ ...st }),
      ensureLoaded: (id: string) => {
        ensured.push(id);
        return 'switching';
      },
      stop: async () => {
        stopped += 1;
      },
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

function localRunInFlight(model: string) {
  const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'claude-code', model });
  setStatus(db, t.id, 'running');
  createRun(db, { task_id: t.id, model });
}

describe('/api/local', () => {
  it('lists the seeded models and manager state even while disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/local/models' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      'glm53-flash',
      'qwen3-coder-next',
      'qwen36-35b',
      'qwen38-27b',
      'qwen38-flash',
    ]);
    expect(body.state.status).toBe('ready');
    expect(body.sparks).toBe(1);
  });

  it('says for each model whether this deployment can actually run it', async () => {
    const { repo, hub } = fakeSpark();
    setSetting(db, 'local_vllm_repo', repo);
    await app.close();
    app = buildApp({ db, apiToken: null, localHubDir: hub, dockerProbe: () => true, modelManager: { state: () => ({ ...st }), ensureLoaded: () => 'switching', stop: async () => {} } });
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/api/local/models' })).json();
    const byId = Object.fromEntries(body.models.map((m: { id: string }) => [m.id, m]));

    // cluster_only recipe: run-recipe.py rejects --solo, so one Spark is never enough
    expect(byId['glm53-flash']).toMatchObject({ nodes: 2, runnable: false });
    expect(byId['glm53-flash'].blocked_by).toContain('2 台 Spark');
    // weights are not in this test's (empty) HF cache, so nothing is offerable yet
    expect(byId['qwen38-flash']).toMatchObject({ nodes: 1, downloaded: false, runnable: false });
    expect(byId['qwen38-flash'].blocked_by).toContain('下載');
  });

  it('refuses to switch to a model whose container image is not built yet', async () => {
    // the demo-day incident: run-recipe.sh stopped vLLM, asked "Build now?", got EOF, and the
    // machine served nothing until the old model was reloaded by hand
    const { repo, hub } = fakeSpark();
    downloaded(hub, 'Intel/Qwen3-Coder-Next-int4-AutoRound');
    fs.writeFileSync(path.join(repo, 'recipes', 'qwen3-coder-next-int4-autoround.yaml'), 'model: x\ncontainer: vllm-node\n');
    setSetting(db, 'local_vllm_repo', repo);
    setSetting(db, 'local_models_enabled', 'true');
    await app.close();
    app = buildApp({
      db,
      apiToken: null,
      localHubDir: hub,
      dockerProbe: (image: string) => image !== 'vllm-node', // every image but this one is built
      modelManager: {
        state: () => ({ ...st }),
        ensureLoaded: (id: string) => {
          ensured.push(id);
          return 'switching';
        },
        stop: async () => {},
      },
    });
    await app.ready();

    const list = (await app.inject({ method: 'GET', url: '/api/local/models' })).json();
    const coder = list.models.find((m: { id: string }) => m.id === 'qwen3-coder-next');
    expect(coder).toMatchObject({ downloaded: true, image_ready: false, runnable: false });
    expect(coder.blocked_by).toContain('vllm-node');

    const res = await app.inject({ method: 'POST', url: '/api/local/models/qwen3-coder-next/load' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('--build-only');
    expect(ensured).toEqual([]); // the running model is never stopped for a switch that cannot work
  });

  it('refuses to restart vLLM for a model this deployment cannot run', async () => {
    const { repo, hub } = fakeSpark();
    downloaded(hub, 'local-inference-lab/GLM-5.3-Flash-NVFP4-Spark');
    setSetting(db, 'local_vllm_repo', repo);
    setSetting(db, 'local_models_enabled', 'true');
    db.prepare(`UPDATE local_models SET enabled = 1 WHERE id = 'glm53-flash'`).run();
    await app.close();
    app = buildApp({
      db,
      apiToken: null,
      localHubDir: hub,
      dockerProbe: () => true,
      modelManager: {
        state: () => ({ ...st }),
        ensureLoaded: (id: string) => {
          ensured.push(id);
          return 'switching';
        },
        stop: async () => {},
      },
    });
    await app.ready();

    // downloaded and enabled, but cluster_only on a one-Spark deployment
    const res = await app.inject({ method: 'POST', url: '/api/local/models/glm53-flash/load' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('2 台 Spark');
    expect(ensured).toEqual([]); // the running model is left alone

    // with the second machine declared, the same request goes through
    setSetting(db, 'local_spark_nodes', '2');
    expect((await app.inject({ method: 'POST', url: '/api/local/models/glm53-flash/load' })).statusCode).toBe(200);
    expect(ensured).toEqual(['glm53-flash']);
  });

  it('load/stop are 404 while local models are disabled', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/local/models/qwen38-flash/load' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/local/stop' })).statusCode).toBe(404);
    expect(ensured).toEqual([]);
  });

  describe('enabled', () => {
    beforeEach(() => setSetting(db, 'local_models_enabled', 'true'));

    it('load starts a switch; unknown 404; disabled model 409', async () => {
      const ok = await app.inject({ method: 'POST', url: '/api/local/models/qwen3-coder-next/load' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().result).toBe('switching');
      expect(ensured).toEqual(['qwen3-coder-next']);
      expect((await app.inject({ method: 'POST', url: '/api/local/models/nope/load' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/local/models/qwen36-35b/load' })).statusCode).toBe(409);
    });

    it('refuses to switch or stop under an in-flight local run', async () => {
      localRunInFlight('local:qwen38-flash');
      const sw = await app.inject({ method: 'POST', url: '/api/local/models/qwen3-coder-next/load' });
      expect(sw.statusCode).toBe(409);
      expect(sw.json().error).toMatch(/in flight/);
      // re-requesting the model that is already loaded is harmless
      expect((await app.inject({ method: 'POST', url: '/api/local/models/qwen38-flash/load' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/local/stop' })).statusCode).toBe(409);
      expect(stopped).toBe(0);
    });

    it('stop frees the GPU when nothing local is running', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/local/stop' });
      expect(res.statusCode).toBe(200);
      expect(stopped).toBe(1);
    });
  });

  it('board snapshot carries the local chip state', async () => {
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    setSetting(db, 'local_model_status', 'ready');
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(board.local).toEqual({ enabled: false, loaded: 'qwen38-flash', status: 'ready', inflight: 0 });
  });
});
