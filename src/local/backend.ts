import type Database from 'better-sqlite3';
import { getBool, getSetting } from '../db/index.js';
import { chatLocal } from '../local/chat.js';
import { listLocalModels } from './models.js';

/**
 * 公司模式 (`cloud_llm_allowed=false`): company code never reaches a cloud model. Every LLM step
 * that used to shell out to `claude -p` asks here which backend to use; with the switch off, a
 * `claude` backend resolves to `local` (the served vLLM model through chatLocal) and the steps
 * that only make sense on a cloud model (請雲端複核, cloud report models) refuse with a clear
 * message. With the switch on (the default) every step behaves exactly as before.
 */

export type LlmBackend = 'claude' | 'local' | 'off';

export function cloudAllowed(db: Database.Database): boolean {
  return getBool(db, 'cloud_llm_allowed', true);
}

/** null when cloud calls are fine; otherwise the refusal text for the caller to surface. */
export function assertCloudAllowed(db: Database.Database): string | null {
  return cloudAllowed(db) ? null : '公司模式：只用本地模型（cloud_llm_allowed=false），這個功能需要雲端模型';
}

export function backendFor(db: Database.Database, key: 'llm_judge_backend' | 'planner_backend' | 'knowledge_distill_backend'): LlmBackend {
  const raw = (getSetting(db, key) || 'claude').trim() as LlmBackend;
  const v: LlmBackend = raw === 'local' || raw === 'off' ? raw : 'claude';
  return v === 'claude' && !cloudAllowed(db) ? 'local' : v;
}

/** A cloud alias (sonnet/opus/haiku/fable…) or empty; false for local:<id>. */
export function isCloudModel(model: string | null | undefined): boolean {
  const m = (model ?? '').trim();
  return !m.startsWith('local:');
}

/**
 * The local model a cloud alias maps to when cloud is off: the served one first, else the first
 * enabled registered model, else null (nothing local can run at all).
 */
export function localFallbackModel(db: Database.Database): string | null {
  const loaded = getSetting(db, 'local_model_loaded');
  if (loaded && getSetting(db, 'local_model_status') === 'ready') return `local:${loaded}`;
  const first = listLocalModels(db).find((m) => m.enabled);
  return first ? `local:${first.id}` : null;
}

/** One-shot prompt against the served local model; the text or null (never throws). */
export async function localPrompt(
  db: Database.Database,
  prompt: string,
  opts: { system?: string; maxTokens?: number; thinking?: boolean } = {},
  chat: typeof chatLocal = chatLocal,
): Promise<string | null> {
  const r = await chat(db, { system: opts.system ?? '你是嚴謹的軟體工程助理。只輸出被要求的格式。', user: prompt, maxTokens: opts.maxTokens ?? 2048, thinking: opts.thinking ?? false });
  return r.ok ? r.content : null;
}
