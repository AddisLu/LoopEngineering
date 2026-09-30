import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { listRecipes, recipeInfo } from './recipes.js';
import { imageExists, type DockerProbe } from './images.js';
import { hubDir, weightInfo } from './weights.js';
import { listLocalModels, syncRecipeName, type LocalModel } from './models.js';
import type { ModelManagerState } from './modelManager.js';
import type { JobView } from './jobs.js';

/**
 * Every recipe on this machine, annotated with what it would take to use it *here*: how many
 * Sparks, whether the weights are pulled, whether the container image is built. The panel used
 * to list only the five registered models — all blocked — and read as "one Spark has nothing
 * else"; in fact ~20 recipes run on one machine, they just need a pull or a 3-minute image build.
 */

export type Recommend = 'chat' | 'code' | 'fast' | null;
/** 用途標籤: what a recipe is FOR. Every entry has one — see roleFor(). */
export const ROLES = ['chat', 'code', 'fast', 'vision', 'think', 'big'] as const;
export type Role = (typeof ROLES)[number];
export type CatalogAction = 'switch' | 'download' | 'build' | 'none';

export interface CatalogEntry {
  recipe: string;
  name: string;
  description: string | null;
  model: string | null;
  container: string | null;
  cluster_only: boolean;
  solo_only: boolean;
  nodes: number;
  /** local_models.id when the recipe is registered (seeds, or a previous action) */
  registered_id: string | null;
  enabled: boolean;
  loaded: boolean;
  downloaded: boolean;
  partial: boolean;
  disk_bytes: number | null;
  image_ready: boolean;
  runnable: boolean;
  blocked_by: string | null;
  /** one of the three the panel vouches for; decides the 推薦 cards, nothing else */
  recommend: Recommend;
  /** 用途標籤, shown on every row and on the cards */
  role: Role;
  /** the one thing the operator can do next */
  action: CatalogAction;
  size_bytes: number | null;
  gated: boolean;
}

export interface CatalogImage {
  container: string;
  ready: boolean;
  /** vllm-node / -b12x are a docker pull + tag; -mxfp4 is a real build (20–40 min) */
  kind: 'pull' | 'build';
  minutes: number;
  /** what comes over the wire — the honest number on a Wi-Fi-only machine */
  gb: number;
  /** the single-Spark recipe a build job is started against — one with weights on disk if any */
  recipe: string;
  recipe_downloaded: boolean;
  /** single-Spark recipes waiting on this image */
  waiting: number;
}

export interface Catalog {
  enabled: boolean;
  sparks: number;
  disk_free_bytes: number | null;
  state: ModelManagerState;
  job: JobView | null;
  images: CatalogImage[];
  entries: CatalogEntry[];
}

export const RECOMMENDED: Record<string, Exclude<Recommend, null>> = {
  'qwen3.8-flash-next-nvfp4-solo': 'chat',
  'qwen3-coder-next-int4-autoround': 'code',
  'qwen3.6-35b-a3b-nvfp4': 'fast',
};

/**
 * The few recipes the rules below get wrong. Each one says why — a hand entry with no reason is
 * how a table like this rots.
 */
export const ROLE_OVERRIDE: Record<string, Role> = {
  // 106 GB would score as 大模型, but this IS the everyday chat model on this box
  'qwen3.8-flash-next-nvfp4-solo': 'chat',
  'qwen3.8-flash-next-nvfp4-cluster': 'chat',
};

const GB = 1_000_000_000; // HF reports decimal GB, and so does the panel's ≈ size

/** Total parameters from a model id — `Qwen3.5-397B-A17B` → 397, `Flash-Next` → null. */
export function paramsB(model: string | null): number | null {
  const m = /(?:^|[-_/.])(\d+(?:\.\d+)?)b(?:[-_.]|$)/i.exec(model ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * 用途標籤. Derived from facts the recipe already carries — the model id, the node count, and the
 * weight size HF reports — so a recipe added upstream is labelled without anyone editing this file.
 * Nothing here is a claim about quality; it answers "what is this for", which the 全部模型 list
 * could not answer at all before (31 of 34 rows had no label).
 *
 * Size comes first because it is what the model actually costs on this machine; the parameter
 * count is the offline fallback (the HF lookup returns null with no WAN).
 */
export function roleFor(e: { recipe: string; model: string | null; name: string; nodes: number; size_bytes: number | null }): Role {
  const override = ROLE_OVERRIDE[e.recipe];
  if (override) return override;
  const id = `${e.model ?? ''} ${e.name}`;
  if (/coder/i.test(id)) return 'code';
  if (/vision|[-_]vl(?:[-_]|$)/i.test(id)) return 'vision';
  if (/(?:^|[-_ /])thinking(?:[-_ /]|$)/i.test(`${e.recipe} ${id}`)) return 'think';
  const params = paramsB(e.model);
  if (e.nodes >= 2) return 'big';
  if (e.size_bytes != null && e.size_bytes >= 100 * GB) return 'big';
  if (params != null && params >= 100) return 'big';
  if (e.size_bytes != null) return e.size_bytes <= 30 * GB ? 'fast' : 'chat';
  return params != null && params <= 40 ? 'fast' : 'chat';
}

// minutes assume a wired link; the panel also shows the size because on this Spark's Wi-Fi
// (~5 MB/s measured) a 24 GB pull is over an hour
export const IMAGE_KIND: Record<string, { kind: 'pull' | 'build'; minutes: number; gb: number }> = {
  'vllm-node': { kind: 'pull', minutes: 3, gb: 24 },
  'vllm-node-b12x': { kind: 'pull', minutes: 3, gb: 24 },
  'vllm-node-mxfp4': { kind: 'build', minutes: 30, gb: 30 },
};

export type SizeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CatalogDeps {
  hubDir?: string;
  dockerProbe?: DockerProbe;
  fetch?: SizeFetch | null;
  now?: () => number;
  diskFree?: (dir: string) => number | null;
}

const HIT_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 60 * 60_000;
const HF_TIMEOUT_MS = 5000;

interface SizeRow {
  size_bytes: number | null;
  gated: number;
  checked_at: string;
}

/**
 * Weight size + gated flag from the HF API, cached in local_catalog_cache. Recipes do not say how
 * big a model is, and "下載（≈24 GB）" is the difference between a button people press and one they
 * fear. A miss (offline, 404) is cached too, so a machine without WAN does not stall every open.
 */
export async function modelSize(
  db: Database.Database,
  model: string,
  fetchFn: SizeFetch | null | undefined,
  now: () => number = Date.now,
): Promise<{ size_bytes: number | null; gated: boolean }> {
  const row = db.prepare('SELECT size_bytes, gated, checked_at FROM local_catalog_cache WHERE model = ?').get(model) as SizeRow | undefined;
  if (row) {
    const age = now() - Date.parse(row.checked_at);
    const ttl = row.size_bytes == null ? MISS_TTL_MS : HIT_TTL_MS;
    if (age >= 0 && age < ttl) return { size_bytes: row.size_bytes, gated: row.gated === 1 };
  }
  let size: number | null = null;
  let gated = false;
  if (fetchFn) {
    try {
      const res = await fetchFn(`https://huggingface.co/api/models/${model}?blobs=true`, { signal: AbortSignal.timeout(HF_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { gated?: unknown; siblings?: Array<{ size?: number; lfs?: { size?: number } }> };
        const total = (body.siblings ?? []).reduce((sum, s) => sum + (s.lfs?.size ?? s.size ?? 0), 0);
        size = total > 0 ? total : null;
        gated = Boolean(body.gated); // false | 'auto' | 'manual'
      } else if (res.status === 401 || res.status === 403) {
        gated = true;
      }
    } catch {
      /* offline — cached as a miss below */
    }
  }
  db.prepare(
    `INSERT INTO local_catalog_cache (model, size_bytes, gated, checked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET size_bytes = excluded.size_bytes, gated = excluded.gated, checked_at = excluded.checked_at`,
  ).run(model, size, gated ? 1 : 0, new Date(now()).toISOString());
  return { size_bytes: size, gated };
}

function diskFreeDefault(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export async function buildCatalog(
  db: Database.Database,
  repo: string,
  sparks: number,
  state: ModelManagerState,
  job: JobView | null,
  deps: CatalogDeps = {},
): Promise<Omit<Catalog, 'enabled'>> {
  const hub = deps.hubDir ?? hubDir();
  const now = deps.now ?? Date.now;
  // one row per recipe: the loaded one if any, else an enabled one, else the first registered
  const registered = new Map<string, LocalModel>();
  for (const m of listLocalModels(db)) {
    const cur = registered.get(m.recipe);
    const better = !cur || m.id === state.loaded || (Boolean(m.enabled) && !cur.enabled && cur.id !== state.loaded);
    if (better) registered.set(m.recipe, m);
  }
  const recipes = listRecipes(repo);

  // one HF lookup per distinct model; a partial failure never hides the rest of the list
  const models = new Set<string>();
  const infos = new Map(recipes.map((r) => [r, recipeInfo(r, repo)]));
  for (const info of infos.values()) if (info?.model) models.add(info.model);
  const sizes = new Map<string, { size_bytes: number | null; gated: boolean }>();
  await Promise.all(
    [...models].map(async (m) => {
      try {
        sizes.set(m, await modelSize(db, m, deps.fetch, now));
      } catch {
        sizes.set(m, { size_bytes: null, gated: false });
      }
    }),
  );

  const entries: CatalogEntry[] = recipes.map((recipe) => {
    const info = infos.get(recipe) ?? null;
    const row = registered.get(recipe);
    if (row && info?.name) syncRecipeName(db, row, info.name);
    const model = info?.model ?? null;
    const weights = model ? weightInfo(model, hub) : { downloaded: false, partial: false, disk_bytes: null };
    const nodes = info?.nodes ?? 1;
    const container = info?.container ?? null;
    const imageReady = imageExists(container, deps.dockerProbe);
    const size = model ? (sizes.get(model) ?? { size_bytes: null, gated: false }) : { size_bytes: null, gated: false };
    const loaded = Boolean(row) && state.loaded === row!.id;

    let action: CatalogAction;
    let blocked: string | null;
    if (nodes > sparks) {
      action = 'none';
      blocked = `需要 ${nodes} 台 Spark（目前 ${sparks} 台）`;
    } else if (!model) {
      action = 'none';
      blocked = info ? '配方缺少 model 欄位' : '配方檔讀不到';
    } else if (size.gated && !weights.downloaded) {
      action = 'none';
      blocked = 'HF gated 模型：這台沒有設定 HF token，無法下載';
    } else if (!weights.downloaded) {
      action = 'download';
      blocked = weights.partial ? '權重下載到一半（可續傳）' : '尚未下載權重';
    } else if (!imageReady) {
      action = 'build';
      blocked = `容器映像 ${container} 還沒建置`;
    } else {
      action = 'switch';
      blocked = null;
    }

    return {
      recipe,
      name: info?.name ?? recipe,
      description: info?.description ?? null,
      model,
      container,
      cluster_only: info?.cluster_only ?? false,
      solo_only: info?.solo_only ?? false,
      nodes,
      registered_id: row?.id ?? null,
      enabled: row ? Boolean(row.enabled) : true,
      loaded,
      downloaded: weights.downloaded,
      partial: weights.partial,
      disk_bytes: weights.disk_bytes,
      image_ready: imageReady,
      runnable: action === 'switch',
      blocked_by: blocked,
      recommend: RECOMMENDED[recipe] ?? null,
      role: roleFor({ recipe, model, name: info?.name ?? recipe, nodes, size_bytes: size.size_bytes }),
      action,
      size_bytes: size.size_bytes,
      gated: size.gated,
    };
  });

  // images: one notice per missing image, not one per row
  const images = new Map<string, CatalogImage>();
  for (const e of entries) {
    if (!e.container || e.nodes > sparks) continue;
    const spec = IMAGE_KIND[e.container] ?? { kind: 'build' as const, minutes: 30, gb: 30 };
    const cur = images.get(e.container);
    if (cur) {
      if (!e.image_ready) cur.waiting += 1;
      // build against a recipe whose weights are already here: that one becomes switchable right away
      if (e.downloaded && !cur.recipe_downloaded) Object.assign(cur, { recipe: e.recipe, recipe_downloaded: true });
      continue;
    }
    images.set(e.container, { container: e.container, ready: e.image_ready, ...spec, recipe: e.recipe, recipe_downloaded: e.downloaded, waiting: e.image_ready ? 0 : 1 });
  }

  return {
    sparks,
    disk_free_bytes: (deps.diskFree ?? diskFreeDefault)(hub),
    state,
    job,
    images: [...images.values()],
    entries,
  };
}
