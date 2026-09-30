import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, getSetting, setSetting } from '../db/index.js';
import { ModelManager, type ModelManagerDeps, launchArgs, launchCommand } from '../local/modelManager.js';
import { clearRecipeCache } from '../local/recipes.js';

const QWEN = 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
});

/**
 * Zero-docker/zero-GPU harness. `served` is the sequence of ids /v1/models answers with (null =
 * not up); the last entry repeats. Every side effect is recorded in `calls` for ordering checks.
 */
function harness(opts: { served?: (string | null)[]; cached?: boolean; launcherExit?: number | null; containerLingers?: number } = {}) {
  const calls: string[] = [];
  let lingering = opts.containerLingers ?? 0;
  const served = [...(opts.served ?? [null])];
  let t = 1_000_000;
  const deps: ModelManagerDeps = {
    exec: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return 0;
    },
    launch: (_repo, recipe) => {
      calls.push(`launch ${recipe}`);
      return {
        pid: 4242,
        onExit: (cb) => {
          if (opts.launcherExit !== undefined) cb(opts.launcherExit);
        },
      };
    },
    fetch: async () => {
      const id = served.length > 1 ? served.shift()! : (served[0] ?? null);
      return id ? { ok: true, json: async () => ({ data: [{ id }] }) } : { ok: false, json: async () => ({}) };
    },
    // `--rm` makes the daemon remove the container asynchronously; the switch waits for the name
    containerExists: async () => {
      calls.push('containerExists');
      return lingering-- > 0;
    },
    shutdownWorkers: () => calls.push('shutdownWorkers'),
    isCached: () => opts.cached ?? true,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    pollMs: 10_000,
  };
  return { deps, calls, advance: (ms: number) => (t += ms) };
}

const events = () =>
  (db.prepare("SELECT detail FROM task_events WHERE kind = 'note' ORDER BY id").all() as { detail: string }[]).map(
    (e) => e.detail,
  );

describe('launchArgs', () => {
  it('runs the launcher in its own systemd scope so a deploy cannot kill the model', () => {
    // systemctl restart kills the service cgroup; run-recipe.sh traps it and stops the container
    const scoped = launchCommand('/r/spark', 'rec', 'vllm-rec-123', { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/bin' });
    expect(scoped.cmd).toBe('systemd-run');
    expect(scoped.args.slice(0, 4)).toEqual(['--user', '--scope', '--quiet', '--collect']);
    expect(scoped.args).toContain('--unit=loop-vllm-rec-123');
    expect(scoped.args.slice(-7)).toEqual(['bash', ...launchArgs('/r/spark', 'rec')]);
    // no user manager (a bare shell, a container): run it directly
    expect(launchCommand('/r/spark', 'rec', 'log', {})).toEqual({ cmd: 'bash', args: launchArgs('/r/spark', 'rec') });
  });

  it('runs the recipe solo with the hub switched off', () => {
    // a new upstream revision must never turn a switch into a 100 GB download
    expect(launchArgs('/r/spark', 'qwen3.8-flash-next-nvfp4-solo')).toEqual([
      '/r/spark/run-recipe.sh',
      'qwen3.8-flash-next-nvfp4-solo',
      '--solo',
      '--earlyoom',
      '-e',
      'HF_HUB_OFFLINE=1',
    ]);
  });
});

describe('two Sparks', () => {
  const GLM = 'zai-org/GLM-5.3-Flash';
  function clusterSetup(sparks: number) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-vllm-'));
    fs.mkdirSync(path.join(repo, 'recipes'));
    fs.writeFileSync(path.join(repo, 'recipes', 'glm-5.3-flash.yaml'), 'model: zai-org/GLM-5.3-Flash\ncluster_only: true\ncommand: vllm serve x\n');
    setSetting(db, 'local_vllm_repo', repo);
    setSetting(db, 'local_spark_nodes', String(sparks));
    db.prepare("INSERT INTO local_models (id, display_name, recipe, served_model_id, enabled) VALUES ('glm53', 'GLM', 'glm-5.3-flash', ?, 1)").run(GLM);
    return repo;
  }

  it('a recipe that needs two Sparks starts across the cluster, and switching away stops both nodes', async () => {
    clearRecipeCache();
    const repo = clusterSetup(2);
    expect(launchArgs('/r/spark', 'glm-5.3-flash', true)).toEqual(['/r/spark/run-recipe.sh', 'glm-5.3-flash', '--earlyoom', '-e', 'HF_HUB_OFFLINE=1']);
    const h = harness({ served: [null, GLM] });
    const launched: Array<{ recipe: string; cluster: boolean }> = [];
    const mm = new ModelManager(db, { ...h.deps, launch: (_r, recipe, _l, o) => (launched.push({ recipe, cluster: o?.cluster ?? false }), { pid: 1, onExit: () => {} }) });
    mm.ensureLoaded('glm53');
    await mm.waitForSwitch();
    expect(mm.state().status).toBe('ready');
    expect(launched).toEqual([{ recipe: 'glm-5.3-flash', cluster: true }]);
    // before anything starts, whatever ran on either node is stopped
    expect(h.calls.slice(0, 3)).toEqual(['shutdownWorkers', `bash ${repo}/launch-cluster.sh --name vllm_node stop`, 'docker stop vllm_node']);
    // a one-Spark recipe on the same cluster still runs solo, and the worker's container still goes
    const h2 = harness({ served: [null, QWEN] });
    const launched2: boolean[] = [];
    const mm2 = new ModelManager(db, { ...h2.deps, launch: (_r, _recipe, _l, o) => (launched2.push(o?.cluster ?? false), { pid: 1, onExit: () => {} }) });
    mm2.ensureLoaded('qwen38-flash');
    await mm2.waitForSwitch();
    expect(launched2).toEqual([false]);
    expect(h2.calls).toContain(`bash ${repo}/launch-cluster.sh --name vllm_node stop`);
    await mm2.stop();
    expect(h2.calls.filter((c) => c.includes('launch-cluster.sh')).length).toBe(2);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('one Spark: exactly as before — no cluster launch, no remote stop', async () => {
    clearRecipeCache();
    const repo = clusterSetup(1);
    const h = harness({ served: [null, QWEN] });
    const mm = new ModelManager(db, h.deps);
    mm.ensureLoaded('qwen38-flash');
    await mm.waitForSwitch();
    expect(h.calls.some((c) => c.includes('launch-cluster.sh'))).toBe(false);
    await mm.stop();
    expect(h.calls.some((c) => c.includes('launch-cluster.sh'))).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe('ModelManager switch', () => {
  it('waits for the old container to disappear before launching, and fails instead of colliding', async () => {
    // docker run --name vllm_node dies with "name already in use" if we launch too early: the
    // demo machine ended up serving nothing at all that way
    const ok = harness({ served: [null, null, QWEN], containerLingers: 2 });
    const mm = new ModelManager(db, ok.deps);
    mm.ensureLoaded('qwen38-flash');
    await mm.waitForSwitch();
    expect(mm.state().status).toBe('ready');
    expect(ok.calls.filter((c) => c === 'containerExists')).toHaveLength(3); // twice taken, then free
    expect(ok.calls.indexOf('launch qwen3.8-flash-next-nvfp4-solo')).toBeGreaterThan(ok.calls.lastIndexOf('containerExists'));

    // a container that never goes away fails the switch instead of launching into a name clash
    const stuck = harness({ served: [null], containerLingers: 10_000 });
    const mm2 = new ModelManager(db, stuck.deps);
    mm2.ensureLoaded('qwen3-coder-next');
    await mm2.waitForSwitch();
    expect(mm2.state()).toMatchObject({ status: 'error' });
    expect(mm2.state().error).toContain('docker rm');
    expect(stuck.calls.some((c) => c.startsWith('launch'))).toBe(false);
  });

  it('frees workers, restarts the container, launches the recipe and becomes ready', async () => {
    const h = harness({ served: [null, null, null, QWEN] });
    const mm = new ModelManager(db, h.deps);

    expect(mm.ensureLoaded('qwen38-flash')).toBe('switching');
    expect(mm.state().status).toBe('starting'); // visible to the very next tick
    await mm.waitForSwitch();

    expect(mm.state()).toMatchObject({ status: 'ready', loaded: 'qwen38-flash', error: null });
    expect(getSetting(db, 'local_model_loaded')).toBe('qwen38-flash');
    expect(getSetting(db, 'local_model_status')).toBe('ready');
    expect(h.calls).toEqual([
      'shutdownWorkers',
      'docker stop vllm_node',
      'docker rm -f vllm_node',
      'containerExists',
      'launch qwen3.8-flash-next-nvfp4-solo',
    ]);
    expect(events().some((d) => /qwen38-flash ready after \d+s/.test(d))).toBe(true);
    expect(mm.ensureLoaded('qwen38-flash')).toBe('ready');
  });

  it('serializes: a second request during a switch never launches twice', async () => {
    const h = harness({ served: [null, null, QWEN] });
    const mm = new ModelManager(db, h.deps);
    expect(mm.ensureLoaded('qwen38-flash')).toBe('switching');
    expect(mm.ensureLoaded('qwen38-flash')).toBe('switching');
    expect(mm.ensureLoaded('qwen3-coder-next')).toBe('busy');
    await mm.waitForSwitch();
    expect(h.calls.filter((c) => c.startsWith('launch'))).toHaveLength(1);
  });

  it('adopts a vLLM that already serves the model without restarting it', async () => {
    const h = harness({ served: [QWEN] });
    const mm = new ModelManager(db, h.deps);
    mm.ensureLoaded('qwen38-flash');
    await mm.waitForSwitch();
    expect(mm.state().status).toBe('ready');
    expect(h.calls).toEqual([]);
  });

  it('refuses to launch weights that are not fully downloaded, then cools down', async () => {
    const h = harness({ cached: false });
    const mm = new ModelManager(db, h.deps);
    mm.ensureLoaded('qwen38-flash');
    await mm.waitForSwitch();
    expect(mm.state().status).toBe('error');
    expect(mm.state().error).toMatch(/weights not downloaded/);
    expect(h.calls.some((c) => c.startsWith('launch'))).toBe(false);

    expect(mm.unavailable('qwen38-flash')).toBe(true);
    expect(mm.unavailable('qwen3-coder-next')).toBe(false);
    expect(mm.ensureLoaded('qwen38-flash')).toBe('busy');
    h.advance(11 * 60_000); // past local_switch_retry_min (10)
    expect(mm.unavailable('qwen38-flash')).toBe(false);
  });

  it('times out when vLLM never serves the model', async () => {
    setSetting(db, 'local_switch_timeout_sec', '60');
    const h = harness({ served: [null] });
    const mm = new ModelManager(db, h.deps);
    mm.ensureLoaded('qwen38-flash');
    await mm.waitForSwitch();
    expect(mm.state().status).toBe('error');
    expect(mm.state().error).toMatch(/timed out after \d+s loading qwen38-flash/);
  });

  it('fails fast when the launcher exits before the model is ready', async () => {
    const h = harness({ served: [null], launcherExit: 1 });
    const mm = new ModelManager(db, h.deps);
    mm.ensureLoaded('qwen38-flash');
    await mm.waitForSwitch();
    expect(mm.state().error).toMatch(/launcher exited \(code 1\)/);
  });

  it('rejects an unknown or disabled model', async () => {
    const h = harness();
    const mm = new ModelManager(db, h.deps);
    mm.ensureLoaded('qwen36-35b'); // seeded disabled
    await mm.waitForSwitch();
    expect(mm.state().error).toMatch(/unknown or disabled local model 'qwen36-35b'/);
    expect(h.calls).toEqual([]);
  });

  it('stop() stops the container and goes idle', async () => {
    const h = harness({ served: [QWEN] });
    const mm = new ModelManager(db, h.deps);
    mm.ensureLoaded('qwen38-flash');
    await mm.waitForSwitch();
    await mm.stop();
    expect(mm.state()).toMatchObject({ status: 'idle', loaded: null });
    expect(h.calls).toContain('docker stop vllm_node');
  });
});

describe('ModelManager reconcile / restart', () => {
  it('adopts the running model, and marks idle once vLLM is gone', async () => {
    const up = new ModelManager(db, harness({ served: [QWEN] }).deps);
    await up.reconcile();
    expect(up.state()).toMatchObject({ status: 'ready', loaded: 'qwen38-flash' });

    // a new process reads the persisted 'ready', then finds nothing serving
    const down = new ModelManager(db, harness({ served: [null] }).deps);
    expect(down.state().status).toBe('ready');
    await down.reconcile();
    expect(down.state()).toMatchObject({ status: 'idle', loaded: null });
    expect(getSetting(db, 'local_model_status')).toBe('idle');
  });

  it('a persisted mid-switch state is not trusted after a restart', () => {
    setSetting(db, 'local_model_status', 'starting');
    setSetting(db, 'local_model_loaded', '');
    const mm = new ModelManager(db, harness().deps);
    expect(mm.state().status).toBe('idle');
  });
});
