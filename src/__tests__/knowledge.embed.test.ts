import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { embed, type EmbedExec } from '../knowledge/embed.js';
import { WarmWorker, type ChildLike, type SpawnFn } from '../voice/daemon.js';
import { DEFAULT_SETTINGS } from '../config.js';
import { validateSetting } from '../settings.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

// ---- 1. embed(): injected exec (no warm worker) ----

describe('embed: injected exec path', () => {
  it('returns the injected exec vectors for the given texts', async () => {
    const exec: EmbedExec = async (_bin, _args, texts) => texts.map((t) => [t.length, 0, 0]);
    const out = await embed(db, ['hello', 'hi'], exec);
    expect(out).toEqual([[5, 0, 0], [2, 0, 0]]);
  });

  it('passes --model (from embed_model setting) through to exec args', async () => {
    setSetting(db, 'embed_model', 'BAAI/bge-m3-custom');
    let seenArgs: string[] = [];
    const exec: EmbedExec = async (_bin, args) => {
      seenArgs = args;
      return [[1]];
    };
    await embed(db, ['x'], exec);
    expect(seenArgs).toContain('--model');
    expect(seenArgs).toContain('BAAI/bge-m3-custom');
  });

  it('passes the configured embed_python as the python binary', async () => {
    setSetting(db, 'embed_python', '/fake/venv/python');
    let seenBin = '';
    const exec: EmbedExec = async (bin) => {
      seenBin = bin;
      return [[1]];
    };
    await embed(db, ['x'], exec);
    expect(seenBin).toBe('/fake/venv/python');
  });
});

// ---- 2. embed(): warm worker path ----

describe('embed: warm worker path', () => {
  it('uses the injected warm worker and never calls exec', async () => {
    let execCalls = 0;
    const exec: EmbedExec = async () => {
      execCalls++;
      return [[0]];
    };
    const warmWorker = { embed: async (texts: string[]) => texts.map(() => [9, 9, 9]) };
    const out = await embed(db, ['a', 'b'], exec, { warmWorker });
    expect(out).toEqual([[9, 9, 9], [9, 9, 9]]);
    expect(execCalls).toBe(0);
  });

  it('falls back to exec when the warm worker throws', async () => {
    const warmWorker = { embed: async () => { throw new Error('daemon down'); } };
    const exec: EmbedExec = async () => [[1, 2, 3]];
    const out = await embed(db, ['a'], exec, { warmWorker });
    expect(out).toEqual([[1, 2, 3]]);
  });
});

// ---- 3. WarmWorker.embed(): generalized daemon protocol (fake child, no real python) ----

interface FakeChild {
  child: ChildLike;
  writes: string[];
  emitData: (s: string) => void;
  emitExit: () => void;
}

function makeFakeChild(): FakeChild {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const stdoutListeners: Record<string, Array<(chunk: Buffer | string) => void>> = {};
  const writes: string[] = [];
  let killed = false;
  const child: ChildLike = {
    stdin: { write: (chunk: string) => { writes.push(chunk); return true; } },
    stdout: { on: (event, cb) => { (stdoutListeners[event] ??= []).push(cb); } },
    stderr: { on: () => {} },
    on: (event, cb) => { (listeners[event] ??= []).push(cb as (...args: unknown[]) => void); },
    kill: () => { killed = true; },
    get killed() { return killed; },
  };
  return {
    child,
    writes,
    emitData: (s) => (stdoutListeners['data'] ?? []).forEach((cb) => cb(s)),
    emitExit: () => (listeners['exit'] ?? []).forEach((cb) => cb()),
  };
}

describe('WarmWorker.embed', () => {
  it('spawns once, writes {texts}, and resolves {embeddings} from the daemon response', async () => {
    const fakes: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const worker = new WarmWorker(spawnFn, '/fake/python', '/fake/embed_daemon.py', () => 10, 5000);

    const p1 = worker.embed(['a', 'b']);
    expect(JSON.parse(fakes[0].writes[0])).toEqual({ texts: ['a', 'b'] });
    fakes[0].emitData(JSON.stringify({ embeddings: [[1, 2], [3, 4]] }) + '\n');
    expect(await p1).toEqual([[1, 2], [3, 4]]);

    // reused across calls, same fake child (no respawn)
    const p2 = worker.embed(['c']);
    fakes[0].emitData(JSON.stringify({ embeddings: [[5, 6]] }) + '\n');
    expect(await p2).toEqual([[5, 6]]);
    expect(fakes).toHaveLength(1);
  });

  it('rejects on a daemon {"error": ...} response, keeping the daemon alive for the next request', async () => {
    const fakes: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const worker = new WarmWorker(spawnFn, '/fake/python', '/fake/embed_daemon.py', () => 10, 5000);

    const p1 = worker.embed(['bad']);
    fakes[0].emitData(JSON.stringify({ error: 'CUDA OOM' }) + '\n');
    await expect(p1).rejects.toThrow(/CUDA OOM/);
    expect(worker.isAlive()).toBe(true);
  });

  it('still transcribes correctly — the shared request() plumbing did not regress .transcribe()', async () => {
    const fakes: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const worker = new WarmWorker(spawnFn, '/fake/python', '/fake/transcribe_daemon.py', () => 10, 5000);
    const p1 = worker.transcribe('/a.webm', '/terms.txt');
    expect(JSON.parse(fakes[0].writes[0])).toEqual({ audio: '/a.webm', terms_file: '/terms.txt' });
    fakes[0].emitData(JSON.stringify({ text: 'hello' }) + '\n');
    expect(await p1).toBe('hello');
  });
});

// ---- 4. rag_enabled defaults + settings validation (zero-impact invariant) ----

describe('SSoT/RAG Phase 0: defaults + settings validation', () => {
  it('rag_enabled defaults to false — nothing calls embed()/vec KNN automatically yet', () => {
    expect(DEFAULT_SETTINGS.rag_enabled).toBe('false');
  });

  it('seeds the full Phase 0 settings group with the documented defaults', () => {
    expect(DEFAULT_SETTINGS.embed_model).toBe('BAAI/bge-m3');
    expect(DEFAULT_SETTINGS.embed_dim).toBe('1024');
    expect(DEFAULT_SETTINGS.rag_top_k).toBe('8');
    expect(DEFAULT_SETTINGS.rag_hybrid_alpha).toBe('0.5');
    expect(DEFAULT_SETTINGS.embed_worker_idle_min).toBe('10');
    expect(typeof DEFAULT_SETTINGS.embed_python).toBe('string');
    expect(DEFAULT_SETTINGS.embed_python.length).toBeGreaterThan(0);
  });

  it('validates rag_enabled as a bool key', () => {
    expect(validateSetting('rag_enabled', 'true')).toBeNull();
    expect(validateSetting('rag_enabled', 'false')).toBeNull();
    expect(validateSetting('rag_enabled', 'yes')).toMatch(/must be true or false/);
  });

  it('validates rag_hybrid_alpha in [0, 1]', () => {
    expect(validateSetting('rag_hybrid_alpha', '0')).toBeNull();
    expect(validateSetting('rag_hybrid_alpha', '1')).toBeNull();
    expect(validateSetting('rag_hybrid_alpha', '0.5')).toBeNull();
    expect(validateSetting('rag_hybrid_alpha', '1.5')).toMatch(/between 0 and 1/);
    expect(validateSetting('rag_hybrid_alpha', '-0.1')).toMatch(/between 0 and 1/);
  });

  it('validates embed_dim/rag_top_k/embed_worker_idle_min as non-negative numbers', () => {
    expect(validateSetting('embed_dim', '1024')).toBeNull();
    expect(validateSetting('embed_dim', '-1')).toMatch(/non-negative/);
    expect(validateSetting('rag_top_k', '8')).toBeNull();
    expect(validateSetting('embed_worker_idle_min', '10')).toBeNull();
  });
});
