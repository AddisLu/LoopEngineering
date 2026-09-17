import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, getSetting, setSetting } from '../db/index.js';
import { ModelManager, type ModelManagerDeps } from '../local/modelManager.js';

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
function harness(opts: { served?: (string | null)[]; cached?: boolean; launcherExit?: number | null } = {}) {
  const calls: string[] = [];
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

describe('ModelManager switch', () => {
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
