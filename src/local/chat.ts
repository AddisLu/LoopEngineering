import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { getLocalModel } from './models.js';

/**
 * One-shot chat completion against whatever local model vLLM is serving right now — for
 * zero-token text jobs (PRD review today). Never loads or switches a model. Returns a
 * structured result so callers can tell "no model" apart from "the model failed". Never throws.
 */

export interface LocalChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /**
   * Default false. Qwen3-style reasoning can spend the entire token budget before writing any
   * answer — measured on the Spark: 4096 reasoning tokens, finish_reason=length, no content,
   * 89 s; with thinking off the same review returned valid JSON in 12 s.
   */
  thinking?: boolean;
}

export type LocalChatResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'disabled' | 'not_ready' | 'http' | 'truncated' | 'empty' | 'network'; detail: string };

export type LocalChatFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export async function chatLocal(
  db: Database.Database,
  req: LocalChatRequest,
  fetchImpl: LocalChatFetch = (url, init) => fetch(url, init),
): Promise<LocalChatResult> {
  if (!getBool(db, 'local_models_enabled', false)) {
    return { ok: false, reason: 'disabled', detail: 'local_models_enabled=false' };
  }
  const status = getSetting(db, 'local_model_status') || 'idle';
  const loaded = getSetting(db, 'local_model_loaded');
  const model = status === 'ready' && loaded ? getLocalModel(db, loaded) : undefined;
  if (!model) return { ok: false, reason: 'not_ready', detail: `no local model ready (status: ${status})` };

  const base = (getSetting(db, 'local_vllm_base_url') || 'http://127.0.0.1:8000/v1').replace(/\/+$/, '');
  const maxTokens = req.maxTokens ?? 4096;
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.served_model_id,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: req.thinking ?? false },
      }),
      signal: AbortSignal.timeout(getNum(db, 'local_chat_timeout_ms', 180_000)),
    });
    if (!res.ok) return { ok: false, reason: 'http', detail: `vLLM HTTP ${res.status ?? '?'}` };
    const body = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
    const choice = body?.choices?.[0];
    // reasoning models without a reasoning parser inline <think>…</think> — drop it
    const content =
      typeof choice?.message?.content === 'string'
        ? choice.message.content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim()
        : '';
    if (choice?.finish_reason === 'length') {
      return { ok: false, reason: 'truncated', detail: `reply cut off at max_tokens=${maxTokens}${content ? '' : ' before any answer'}` };
    }
    if (!content) return { ok: false, reason: 'empty', detail: 'the model returned an empty reply' };
    return { ok: true, content };
  } catch (err) {
    return { ok: false, reason: 'network', detail: `vLLM request failed: ${String(err).slice(0, 200)}` };
  }
}
