import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildCatalog, modelSize, paramsB, roleFor } from '../local/catalog.js';
import { clearRecipeCache, listRecipes, recipeInfo } from '../local/recipes.js';
import { clearImageCache } from '../local/images.js';
import { weightInfo } from '../local/weights.js';
import { getLocalModel, registerRecipe } from '../local/models.js';
import type { ModelManagerState } from '../local/modelManager.js';

let db: Database.Database;
let tmp: string[] = [];
const state: ModelManagerState = { loaded: 'qwen38-flash', wanted: null, status: 'ready', since: null, error: null };

/** A spark-vllm-docker checkout in miniature: a few recipes, plus things the catalog must skip. */
function fakeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cat-'));
  tmp.push(repo);
  const r = path.join(repo, 'recipes');
  fs.mkdirSync(path.join(r, '3x-spark-cluster'), { recursive: true });
  fs.writeFileSync(path.join(r, 'README.md'), '# not a recipe\n');
  fs.writeFileSync(path.join(r, '3x-spark-cluster', 'huge.yaml'), 'name: Huge\nmodel: org/huge\ncluster_only: true\n');
  fs.writeFileSync(
    path.join(r, 'qwen3.8-flash-next-nvfp4-solo.yaml'),
    'name: "Qwen3.8-Flash-Next-NVFP4 (Solo)"\ndescription: vLLM serving it on one DGX Spark\nmodel: local-inference-lab/Qwen3.8-Flash-Next-NVFP4\ncontainer: vllm-node-b12x\nsolo_only: true\n',
  );
  fs.writeFileSync(path.join(r, 'qwen3.6-35b-a3b-nvfp4.yaml'), 'name: Qwen3.6-35B-A3B-NVFP4-Marlin\nmodel: nvidia/Qwen3.6-35B-A3B-NVFP4\ncontainer: vllm-node\n');
  fs.writeFileSync(path.join(r, 'qwen3.6-35b-a3b-fp8.yaml'), 'name: Qwen36-35B-A3B\nmodel: Qwen/Qwen3.6-35B-A3B-FP8\ncontainer: vllm-node\n');
  fs.writeFileSync(path.join(r, 'qwen3.6-35b-a3b-fp8-dflash.yaml'), 'name: Qwen36-35B-A3B\nmodel: Qwen/Qwen3.6-35B-A3B-FP8\ncontainer: vllm-node\n');
  fs.writeFileSync(path.join(r, 'glm-5.3-flash.yaml'), 'name: GLM-5.3-Flash\nmodel: local-inference-lab/GLM-5.3-Flash-NVFP4-Spark\ncontainer: vllm-node-b12x\ncluster_only: true\n');
  fs.writeFileSync(path.join(r, 'gemma4-26b-a4b.yaml'), 'name: Gemma4-26B-A4B\nmodel: google/gemma-4-26B-A4B-it\ncontainer: vllm-node\n');
  fs.writeFileSync(path.join(r, 'broken.yaml'), 'name: Broken\ncontainer: vllm-node\n');
  return repo;
}

function fakeHub(): string {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cat-hub-'));
  tmp.push(hub);
  return hub;
}

function cached(hub: string, model: string, opts: { partial?: boolean; bytes?: number } = {}): void {
  const repo = path.join(hub, `models--${model.replace(/\//g, '--')}`);
  fs.mkdirSync(path.join(repo, 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'snapshots', 'main'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'blobs', 'a'), Buffer.alloc(opts.bytes ?? 2048));
  fs.writeFileSync(path.join(repo, 'snapshots', 'main', 'model.safetensors'), '');
  // partial = the shard index names a file that is not in the snapshot yet
  if (opts.partial) {
    fs.writeFileSync(path.join(repo, 'blobs', 'b.incomplete'), Buffer.alloc(512));
    fs.writeFileSync(
      path.join(repo, 'snapshots', 'main', 'model.safetensors.index.json'),
      JSON.stringify({ weight_map: { a: 'model.safetensors', b: 'model-2.safetensors' } }),
    );
  }
}

const sizes: Record<string, { size: number; gated?: unknown }> = {
  'local-inference-lab/Qwen3.8-Flash-Next-NVFP4': { size: 106e9 },
  'nvidia/Qwen3.6-35B-A3B-NVFP4': { size: 23.5e9 },
  'Qwen/Qwen3.6-35B-A3B-FP8': { size: 36e9 },
  'local-inference-lab/GLM-5.3-Flash-NVFP4-Spark': { size: 175e9 },
  'google/gemma-4-26B-A4B-it': { size: 52e9, gated: 'manual' },
};
let fetched: string[] = [];
const fakeFetch = async (url: string) => {
  fetched.push(url);
  const id = decodeURIComponent(url.replace('https://huggingface.co/api/models/', '').replace('?blobs=true', ''));
  const hit = sizes[id];
  if (!hit) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ gated: hit.gated ?? false, siblings: [{ lfs: { size: hit.size } }, { size: 100 }] }) };
};

beforeEach(() => {
  db = openTestDb();
  fetched = [];
  clearRecipeCache();
  clearImageCache();
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

describe('recipes', () => {
  it('lists top-level recipes only, and reads the free-text fields', () => {
    const repo = fakeRepo();
    expect(listRecipes(repo)).toEqual([
      'broken',
      'gemma4-26b-a4b',
      'glm-5.3-flash',
      'qwen3.6-35b-a3b-fp8',
      'qwen3.6-35b-a3b-fp8-dflash',
      'qwen3.6-35b-a3b-nvfp4',
      'qwen3.8-flash-next-nvfp4-solo',
    ]);
    expect(listRecipes(path.join(repo, 'nope'))).toEqual([]);
    expect(recipeInfo('qwen3.8-flash-next-nvfp4-solo', repo)).toMatchObject({
      name: 'Qwen3.8-Flash-Next-NVFP4 (Solo)', // quotes stripped, parentheses kept
      description: 'vLLM serving it on one DGX Spark',
      model: 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4',
      solo_only: true,
      cluster_only: false,
      nodes: 1,
    });
    expect(recipeInfo('broken', repo)).toMatchObject({ model: null, name: 'Broken', tool_parser: null });
    // the chat tool loop is offered only when the served recipe can parse tool calls
    fs.writeFileSync(path.join(repo, 'recipes', 'tooly.yaml'), 'model: o/m\ncommand: |\n  vllm serve o/m \\\n    --tool-call-parser qwen3_xml \\\n    --enable-auto-tool-choice\n');
    expect(recipeInfo('tooly', repo)!.tool_parser).toBe('qwen3_xml');
  });
});

describe('weights', () => {
  it('a half-pulled model is partial, not downloaded', () => {
    const hub = fakeHub();
    cached(hub, 'org/full');
    cached(hub, 'org/half', { partial: true });
    expect(weightInfo('org/full', hub)).toMatchObject({ downloaded: true, partial: false });
    expect(weightInfo('org/half', hub)).toMatchObject({ downloaded: false, partial: true });
    expect(weightInfo('org/none', hub)).toEqual({ downloaded: false, partial: false, disk_bytes: null });
  });
});

describe('modelSize', () => {
  it('sums the HF siblings, remembers gated, and caches hits for a day and misses for an hour', async () => {
    let t = Date.parse('2026-09-17T00:00:00Z');
    const now = () => t;
    expect(await modelSize(db, 'nvidia/Qwen3.6-35B-A3B-NVFP4', fakeFetch, now)).toEqual({ size_bytes: 23.5e9 + 100, gated: false });
    expect(await modelSize(db, 'google/gemma-4-26B-A4B-it', fakeFetch, now)).toEqual({ size_bytes: 52e9 + 100, gated: true });
    expect(await modelSize(db, 'org/unknown', fakeFetch, now)).toEqual({ size_bytes: null, gated: false });
    expect(fetched).toHaveLength(3);

    t += 2 * 60 * 60_000; // 2 h: the hit is still cached, the miss is retried
    await modelSize(db, 'nvidia/Qwen3.6-35B-A3B-NVFP4', fakeFetch, now);
    await modelSize(db, 'org/unknown', fakeFetch, now);
    expect(fetched).toHaveLength(4);

    t += 25 * 60 * 60_000; // past a day: refetch the hit
    await modelSize(db, 'nvidia/Qwen3.6-35B-A3B-NVFP4', fakeFetch, now);
    expect(fetched).toHaveLength(5);
  });

  it('offline (no fetch, or fetch throws) yields null without throwing', async () => {
    expect(await modelSize(db, 'x/y', null)).toEqual({ size_bytes: null, gated: false });
    expect(await modelSize(db, 'x/z', async () => { throw new Error('ENOTFOUND'); })).toEqual({ size_bytes: null, gated: false });
  });
});

describe('buildCatalog', () => {
  it('says what each recipe needs on this machine, one action per row', async () => {
    const repo = fakeRepo();
    const hub = fakeHub();
    db.prepare(`INSERT INTO local_models (id, display_name, recipe, served_model_id, enabled, created_at) VALUES ('qwen38-flash-b', 'alias', 'qwen3.8-flash-next-nvfp4-solo', 'x', 0, '2000-01-01')`).run();
    cached(hub, 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4');
    cached(hub, 'Qwen/Qwen3.6-35B-A3B-FP8');
    cached(hub, 'local-inference-lab/GLM-5.3-Flash-NVFP4-Spark', { partial: true });
    const cat = await buildCatalog(db, repo, 1, state, null, {
      hubDir: hub,
      dockerProbe: (img) => img === 'vllm-node-b12x',
      fetch: fakeFetch,
      diskFree: () => 3e12,
    });
    const by = Object.fromEntries(cat.entries.map((e) => [e.recipe, e]));

    // loaded + registered seed: the id is the seed's, not the recipe name — and a disabled alias
    // of the same recipe (the demo DB has one) must not hide the loaded row
    expect(by['qwen3.8-flash-next-nvfp4-solo']).toMatchObject({ registered_id: 'qwen38-flash', loaded: true, action: 'switch', recommend: 'chat', size_bytes: 106e9 + 100 });
    // the badge on the card and the badge on the list row are one field: 106 GB alone would read
    // as 大模型, so the override keeps it 對話 in both places
    expect(by['qwen3.8-flash-next-nvfp4-solo'].role).toBe('chat');
    // downloaded but the shared image is missing -> build
    expect(by['qwen3.6-35b-a3b-fp8']).toMatchObject({ action: 'build', downloaded: true, image_ready: false, registered_id: null });
    expect(by['qwen3.6-35b-a3b-fp8'].blocked_by).toContain('vllm-node');
    // same model, second recipe: keyed by file name, both rows present
    expect(by['qwen3.6-35b-a3b-fp8-dflash']).toMatchObject({ action: 'build', name: 'Qwen36-35B-A3B' });
    // not on disk -> download, with the size the button shows
    expect(by['qwen3.6-35b-a3b-nvfp4']).toMatchObject({ action: 'download', recommend: 'fast', size_bytes: 23.5e9 + 100 });
    expect(by['qwen3.6-35b-a3b-nvfp4'].role).toBe('fast');
    // every row is labelled — that is the whole point; 31 of 34 used to have nothing
    expect(cat.entries.every((e) => e.role)).toBe(true);
    expect(by['glm-5.3-flash'].role).toBe('big');
    expect(by['broken'].role).toBe('chat');
    // interrupted pull on a cluster-only recipe: the node limit wins, the partial flag still shows
    expect(by['glm-5.3-flash']).toMatchObject({ action: 'none', nodes: 2, partial: true, downloaded: false });
    expect(by['glm-5.3-flash'].blocked_by).toContain('2 台 Spark');
    // gated on a machine without a token: do not offer a download that will 401
    expect(by['gemma4-26b-a4b']).toMatchObject({ action: 'none', gated: true });
    expect(by['gemma4-26b-a4b'].blocked_by).toContain('token');
    // no model field: kept, never thrown
    expect(by['broken']).toMatchObject({ action: 'none', model: null });
    expect(by['broken'].blocked_by).toContain('model');

    expect(cat.disk_free_bytes).toBe(3e12);
    // one notice per image, with how many single-Spark recipes wait on it
    const images = Object.fromEntries(cat.images.map((i) => [i.container, i]));
    expect(images['vllm-node']).toMatchObject({ ready: false, kind: 'pull', minutes: 3, waiting: 5, recipe: 'qwen3.6-35b-a3b-fp8', recipe_downloaded: true }); // 3× qwen3.6 + gemma + broken; built against the downloaded one
    expect(images['vllm-node-b12x']).toMatchObject({ ready: true, waiting: 0 });
    // the HF API was asked once per distinct model, never per recipe
    expect(new Set(fetched).size).toBe(fetched.length);
  });

  it('with two Sparks the cluster recipe becomes downloadable', async () => {
    const repo = fakeRepo();
    const hub = fakeHub();
    const cat = await buildCatalog(db, repo, 2, state, null, { hubDir: hub, dockerProbe: () => true, fetch: null, diskFree: () => null });
    const glm = cat.entries.find((e) => e.recipe === 'glm-5.3-flash')!;
    expect(glm).toMatchObject({ action: 'download', size_bytes: null });
  });

  it('a missing repo yields an empty catalog rather than an error', async () => {
    const cat = await buildCatalog(db, '/nonexistent/spark', 1, state, null, { hubDir: fakeHub(), fetch: null });
    expect(cat.entries).toEqual([]);
    expect(cat.images).toEqual([]);
  });
});

describe('registerRecipe', () => {
  it('reuses the seed row for a seeded recipe, otherwise inserts under the recipe name — idempotently', () => {
    const seed = registerRecipe(db, { recipe: 'qwen3.8-flash-next-nvfp4-solo', name: 'x', model: 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4' });
    expect(seed.id).toBe('qwen38-flash');
    const fresh = registerRecipe(db, { recipe: 'qwen3.6-35b-a3b-fp8-dflash', name: 'Qwen36-35B-A3B', model: 'Qwen/Qwen3.6-35B-A3B-FP8' });
    expect(fresh).toMatchObject({ id: 'qwen3.6-35b-a3b-fp8-dflash', display_name: 'Qwen36-35B-A3B', enabled: 1 });
    expect(registerRecipe(db, { recipe: 'qwen3.6-35b-a3b-fp8-dflash', name: 'Qwen36-35B-A3B', model: 'x' }).id).toBe(fresh.id);
    expect(getLocalModel(db, fresh.id)!.display_name).toBe('Qwen36-35B-A3B');
    // a disabled seed (glm) is re-enabled when the operator acts on it
    db.prepare(`UPDATE local_models SET enabled = 0 WHERE id = 'glm53-flash'`).run();
    expect(registerRecipe(db, { recipe: 'glm-5.3-flash', name: null, model: 'm' }).enabled).toBe(1);
    expect(getLocalModel(db, 'glm53-flash')!.enabled).toBe(1);
  });
});

describe('a model registered from the panel is named after its recipe', () => {
  it('follows a renamed recipe, while a hand-written seed name stays', async () => {
    const fresh = registerRecipe(db, { recipe: 'qwen3.6-35b-a3b-fp8', name: 'Qwen36 (KV 4G)', model: 'Qwen/Qwen3.6-35B-A3B-FP8' });
    expect(registerRecipe(db, { recipe: 'qwen3.6-35b-a3b-fp8', name: 'Qwen36 (精簡版・限純問答)', model: 'x' }).display_name).toBe('Qwen36 (精簡版・限純問答)');
    expect(getLocalModel(db, fresh.id)!.display_name).toBe('Qwen36 (精簡版・限純問答)');
    registerRecipe(db, { recipe: 'glm-5.3-flash', name: 'GLM-5.3-Flash', model: 'm' });
    expect(getLocalModel(db, 'glm53-flash')!.display_name).toBe('GLM-5.3 Flash (NVFP4, 雙機)');

    // renamed on disk only: listing the catalog is enough, no load needed for the pickers to agree
    const repo = fakeRepo();
    const state = { loaded: null, wanted: null, status: 'idle' as const, since: null, error: null };
    await buildCatalog(db, repo, 2, state, null, { hubDir: fakeHub(), dockerProbe: () => true, fetch: null, diskFree: () => null });
    expect(getLocalModel(db, fresh.id)!.display_name).toBe('Qwen36-35B-A3B'); // the fake repo's recipe name
    expect(getLocalModel(db, 'glm53-flash')!.display_name).toBe('GLM-5.3 Flash (NVFP4, 雙機)');
  });
});

describe('roleFor', () => {
  const r = (model: string | null, over: Partial<{ recipe: string; name: string; nodes: number; size_bytes: number | null }> = {}) =>
    roleFor({ recipe: over.recipe ?? 'r', name: over.name ?? '', model, nodes: over.nodes ?? 1, size_bytes: over.size_bytes ?? null });

  it('reads the parameter count out of a model id, and only when it really is one', () => {
    expect(paramsB('Qwen/Qwen3.5-397B-A17B-int4-AutoRound')).toBe(397);
    expect(paramsB('nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4')).toBe(120);
    expect(paramsB('openai/gpt-oss-120b')).toBe(120);
    expect(paramsB('google/gemma-4-26B-A4B-it')).toBe(26);
    // "4bit" is a quantisation, not 4 billion parameters
    expect(paramsB('cyankiwi/GLM-4.7-Flash-AWQ-4bit')).toBeNull();
    expect(paramsB('local-inference-lab/Qwen3.8-Flash-Next-NVFP4')).toBeNull();
    expect(paramsB(null)).toBeNull();
  });

  it('labels what a recipe is for, from facts the recipe already carries', () => {
    // what it is beats how big it is
    expect(r('Intel/Qwen3-Coder-Next-int4-AutoRound')).toBe('code');
    expect(r('deepseek-ai/DeepSeek-V4-Flash-Vision-Exp', { nodes: 2 })).toBe('vision');
    expect(r('nvidia/diffusiongemma-26B-A4B-it-NVFP4', { recipe: 'diffusion-gemma-nvfp4-thinking' })).toBe('think');
    // ...but the org name "thinkingmachines" is not a thinking variant
    expect(r('thinkingmachines/Inkling-Small-NVFP4', { size_bytes: 20e9 })).toBe('fast');
    // then size on this machine, then parameters, then node count
    expect(r('nvidia/Qwen3.6-35B-A3B-NVFP4', { size_bytes: 23.5e9 })).toBe('fast');
    expect(r('local-inference-lab/GLM-5.3-Flash-NVFP4-Spark', { size_bytes: 175e9, nodes: 2 })).toBe('big');
    // 120B in only 65 GB: the parameter count still makes it a big model
    expect(r('nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4', { size_bytes: 65e9 })).toBe('big');
    expect(r('stepfun-ai/Step-3.7-Flash-FP8', { nodes: 2 })).toBe('big');
    // offline (HF size unknown) the parameter count carries it
    expect(r('nvidia/Qwen3.8-27B-NVFP4')).toBe('fast');
    // mid-sized and unremarkable — the honest answer is "general chat"
    expect(r('google/gemma-4-26B-A4B-it', { size_bytes: 52e9 })).toBe('chat');
    expect(r(null)).toBe('chat');
  });

  it('the override table wins over the rules', () => {
    // 106 GB scores as 大模型 by the rules; it is the box's everyday chat model
    expect(r('local-inference-lab/Qwen3.8-Flash-Next-NVFP4', { recipe: 'qwen3.8-flash-next-nvfp4-solo', size_bytes: 106e9 })).toBe('chat');
    // and the table stays small: "Inkling-Small" is 159 GB across two Sparks, so the rules are
    // right to call it 大模型 and it needs no entry
    expect(r('thinkingmachines/Inkling-Small-NVFP4', { recipe: 'inkling-small-nvfp4', nodes: 2, size_bytes: 159e9 })).toBe('big');
  });
});
