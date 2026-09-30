import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { clusterWorkers, localWeightCount, workerWeights, type ClusterExec } from '../local/cluster.js';
import { LocalJobRunner, type JobHandle } from '../local/jobs.js';
import { buildApp } from '../server/app.js';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A model in the new hf layout: the model's blobs link into a shared store, snapshots link to the blobs. */
function cachedModel(hub: string, served: string, files: string[]): void {
  const repo = path.join(hub, `models--${served.replace(/\//g, '--')}`);
  const store = path.join(hub, 'blobs', 'ab');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(path.join(repo, 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'snapshots', 'rev1'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'refs', 'main'), 'rev1');
  for (const [i, f] of files.entries()) {
    const sha = `ab${String(i).padStart(62, '0')}`;
    fs.writeFileSync(path.join(store, sha), Buffer.alloc(16));
    fs.symlinkSync(`../../blobs/ab/${sha}`, path.join(repo, 'blobs', sha));
    fs.symlinkSync(`../../blobs/${sha}`, path.join(repo, 'snapshots', 'rev1', f));
  }
}

describe('two Sparks: the other nodes and their weights', () => {
  it('reads CLUSTER_NODES from the vLLM repo .env without this host', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ETH_IF="enp1s0f0np0"\nCLUSTER_NODES="192.168.177.11,192.168.177.12"\n');
    expect(clusterWorkers(dir, new Set(['192.168.177.11']))).toEqual(['192.168.177.12']);
    expect(clusterWorkers(path.join(dir, 'missing'))).toEqual([]);
  });

  it('counts weight files through the shared-store links and asks each worker with one ssh', async () => {
    cachedModel(dir, 'org/big', ['model-00001.safetensors', 'model-00002.safetensors', 'config.json']);
    expect(localWeightCount('org/big', dir)).toBe(2);
    const calls: string[][] = [];
    const exec: ClusterExec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const host = args[4]!;
      if (host === 'down') return { code: 255, out: 'ssh: connect timed out' };
      return { code: 0, out: host === 'full' ? '2\n' : '0\n' };
    };
    const res = await workerWeights('org/big', ['full', 'empty', 'down'], exec, dir);
    expect(res.map((r) => [r.worker, r.ok, r.have])).toEqual([
      ['full', true, 2],
      ['empty', false, 0],
      ['down', false, null],
    ]);
    expect(res[2]!.reason).toBe('連不上 down');
    expect(calls[0]!.join(' ')).toContain('find -L .cache/huggingface/hub/models--org--big/snapshots/rev1');
  });
});

describe('the sync job', () => {
  let launched: Array<{ cmd: string; args: string[] }> = [];
  let exits: Array<(code: number | null) => void> = [];
  const runner = (complete = true) =>
    new LocalJobRunner(db, {
      launch: (cmd, args): JobHandle => {
        launched.push({ cmd, args });
        return { pid: 77, onExit: (cb) => exits.push(cb) };
      },
      kill: () => {},
      alive: () => true,
      weightsBytes: () => 1,
      weightsComplete: () => complete,
      readTail: () => '',
    });
  beforeEach(() => {
    launched = [];
    exits = [];
  });

  it('copies a downloaded model with the sync script, and a finished two-Spark download continues with it', () => {
    const r = runner();
    r.start('sync', 'deepseek', { model: 'deepseek-ai/DeepSeek-V4-Flash', container: null, size_bytes: null, repo: '/spark', workers: ['192.168.177.12'] });
    expect(launched[0]!.cmd).toBe('bash');
    expect(launched[0]!.args[0]).toMatch(/scripts\/sync-weights\.sh$/);
    expect(launched[0]!.args.slice(2)).toEqual(['models--deepseek-ai--DeepSeek-V4-Flash', '192.168.177.12']);
    expect(() => r.start('sync', 'x', { model: 'a/b', container: null, size_bytes: null, repo: '/spark' })).toThrow(); // busy
    exits[0]!(0);
    expect(r.current()!.status).toBe('done');

    r.start('download', 'deepseek', { model: 'deepseek-ai/DeepSeek-V4-Flash', container: null, size_bytes: 1, repo: '/spark', workers: ['192.168.177.12'] });
    exits[1]!(0);
    const next = r.current()!;
    expect(next).toMatchObject({ kind: 'sync', status: 'running', workers: ['192.168.177.12'] });
  });

  it('a cancelled download does not roll into the sync, and a sync needs somewhere to go', () => {
    const r = runner();
    r.start('download', 'deepseek', { model: 'deepseek-ai/DeepSeek-V4-Flash', container: null, size_bytes: 1, repo: '/spark', workers: ['192.168.177.12'] });
    r.cancel();
    expect(r.current()!.kind).toBe('download');
    expect(launched).toHaveLength(1);
    expect(() => runner().start('sync', 'x', { model: 'a/b', container: null, size_bytes: null, repo: '/spark', workers: [] })).toThrow('沒有其他 Spark');
  });
});

describe('switching to a two-Spark model', () => {
  let app: FastifyInstance;
  const ensured: string[] = [];
  const started: Array<{ kind: string; workers?: string[] }> = [];

  async function mkApp(workerHas: number) {
    const hub = path.join(dir, 'hub');
    const repo = path.join(dir, 'spark');
    fs.mkdirSync(path.join(repo, 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'recipes', 'big-cluster.yaml'), 'name: Big (Cluster)\nmodel: org/big\ncontainer: vllm-node\ncluster_only: true\ndefaults:\n  tensor_parallel: 2\n');
    cachedModel(hub, 'org/big', ['model-00001.safetensors', 'model-00002.safetensors']);
    setSetting(db, 'local_vllm_repo', repo);
    setSetting(db, 'local_models_enabled', 'true');
    setSetting(db, 'local_spark_nodes', '2');
    app = buildApp({
      db,
      apiToken: null,
      localHubDir: hub,
      dockerProbe: () => true,
      modelManager: { state: () => ({ loaded: null, wanted: null, status: 'idle', since: null, error: null }), ensureLoaded: (id: string) => (ensured.push(id), 'switching'), stop: async () => {} },
      localJobRunner: {
        start: (kind, _recipe, entry) => (started.push({ kind, workers: entry.workers }), { id: 'j1', kind, status: 'running' } as never),
        current: () => null,
        cancel: () => null,
        tail: () => [],
      },
      localCatalog: { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }), diskFree: () => 3e12 },
      localClusterWorkers: () => ['192.168.177.12'],
      localClusterExec: async () => ({ code: 0, out: `${workerHas}\n` }),
    });
    await app.ready();
  }
  beforeEach(() => {
    ensured.length = 0;
    started.length = 0;
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses while the other Spark lacks the weights, and offers the copy', async () => {
    await mkApp(0);
    const res = await app.inject({ method: 'POST', url: '/api/local/catalog/big-cluster/load' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'worker_weights' });
    expect(res.json().error).toContain('另一台 Spark 還沒有這個模型的權重');
    expect(ensured).toEqual([]);
    const sync = await app.inject({ method: 'POST', url: '/api/local/jobs', payload: { kind: 'sync', recipe: 'big-cluster' } });
    expect(sync.statusCode).toBe(202);
    expect(started).toEqual([{ kind: 'sync', workers: ['192.168.177.12'] }]);
  });

  it('switches when every node has them', async () => {
    await mkApp(2);
    const res = await app.inject({ method: 'POST', url: '/api/local/catalog/big-cluster/load' });
    expect(res.statusCode).toBe(200);
    expect(ensured).toHaveLength(1);
  });
});
