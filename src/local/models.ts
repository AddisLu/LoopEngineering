import type Database from 'better-sqlite3';

/**
 * 本地模型 registry. A task (or default_model / route_*) references a row as
 * `model = 'local:<id>'`; the ModelManager (modelManager.ts) loads `recipe` into vLLM and the
 * opencode adapter (orchestrator/adapters/opencode.ts) drives `served_model_id` over vLLM's
 * OpenAI-compatible API. Only one model fits the GPU at a time.
 */
export interface LocalModel {
  id: string;
  display_name: string;
  recipe: string; // spark-vllm-docker solo recipe name (run-recipe.sh <recipe> --solo)
  served_model_id: string; // id vLLM serves it under (== the HF repo id for these recipes)
  enabled: number;
  notes: string | null;
  created_at: string;
}

export const LOCAL_PREFIX = 'local:';

/**
 * First-run seed (INSERT OR IGNORE — edits via API/CLI survive restarts). Recipes validated on
 * one DGX Spark; the two not yet downloaded start disabled so a switch never tries to pull
 * ~20 GB of weights at dispatch time.
 */
export const DEFAULT_LOCAL_MODELS: Array<Omit<LocalModel, 'created_at'>> = [
  {
    id: 'qwen38-flash',
    display_name: 'Qwen3.8 Flash Next (NVFP4)',
    recipe: 'qwen3.8-flash-next-nvfp4-solo',
    served_model_id: 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4',
    enabled: 1,
    notes: '106 GB; ~28 t/s decode single request on one Spark; tool parser qwen3_xml',
  },
  {
    id: 'qwen3-coder-next',
    display_name: 'Qwen3 Coder Next (int4 AutoRound)',
    recipe: 'qwen3-coder-next-int4-autoround',
    served_model_id: 'Intel/Qwen3-Coder-Next-int4-AutoRound',
    enabled: 1,
    notes: '43.6 GB; coding-specialised; tool parser qwen3_coder',
  },
  {
    id: 'qwen36-35b',
    display_name: 'Qwen3.6 35B A3B (NVFP4)',
    recipe: 'qwen3.6-35b-a3b-nvfp4',
    served_model_id: 'nvidia/Qwen3.6-35B-A3B-NVFP4',
    enabled: 0,
    notes: '23.5 GB; not downloaded by default',
  },
  {
    id: 'qwen38-27b',
    display_name: 'Qwen3.8 27B (NVFP4)',
    recipe: 'qwen3.8-27b-nvfp4-dflash2',
    served_model_id: 'nvidia/Qwen3.8-27B-NVFP4',
    enabled: 0,
    notes: '21.9 GB dense; not downloaded by default',
  },
  {
    id: 'glm53-flash',
    display_name: 'GLM-5.3 Flash (NVFP4, 雙機)',
    recipe: 'glm-5.3-flash',
    served_model_id: 'local-inference-lab/GLM-5.3-Flash-NVFP4-Spark',
    // cluster_only recipe: run-recipe.py refuses --solo, so it stays disabled until a second
    // Spark is wired up (then: loop config set local_spark_nodes 2 + enable this model).
    enabled: 0,
    notes: '175 GB; cluster_only — 需要 2 台 DGX Spark，單機無法載入',
  },
];

export function seedLocalModels(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO local_models (id, display_name, recipe, served_model_id, enabled, notes)
     VALUES (@id, @display_name, @recipe, @served_model_id, @enabled, @notes)`,
  );
  const tx = db.transaction(() => {
    for (const m of DEFAULT_LOCAL_MODELS) insert.run(m);
  });
  tx();
}

export function listLocalModels(db: Database.Database, opts: { enabledOnly?: boolean } = {}): LocalModel[] {
  const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
  return db.prepare(`SELECT * FROM local_models ${where} ORDER BY id`).all() as LocalModel[];
}

export function getLocalModel(db: Database.Database, id: string): LocalModel | undefined {
  return db.prepare('SELECT * FROM local_models WHERE id = ?').get(id) as LocalModel | undefined;
}

/** True for a non-empty 'local:<id>' model reference. */
export function isLocalModel(model: string | null | undefined): model is string {
  return typeof model === 'string' && model.startsWith(LOCAL_PREFIX) && model.length > LOCAL_PREFIX.length;
}

/** 'local:qwen38-flash' -> 'qwen38-flash'. Caller checks isLocalModel first. */
export function localId(model: string): string {
  return model.slice(LOCAL_PREFIX.length);
}
