import fs from 'node:fs';
import path from 'node:path';
import { currentRevision, hubDir, repoDir } from './weights.js';

/**
 * How a served model's chat template turns reasoning on and off. Loop's 思考模式 is one boolean;
 * templates disagree on the switch, and sending the wrong one is not harmless:
 *
 * - `enable_thinking` (Qwen3.x, Nemotron): the switch Loop always sent.
 * - `effort` (GLM-5.x, gpt-oss): no off switch at all — GLM's template always opens <think>.
 *   enable_thinking=false only told vLLM's reasoning parser not to split, so the model's whole
 *   English chain of thought landed in the answer (and in 200-token query expansions and 60-token
 *   titles, cut off mid-thought). Their fast mode is reasoning_effort=low.
 * - `thinking` (DeepSeek V3.x/V4): vLLM's DeepSeek tokenizers read `thinking`, and the V4 recipe
 *   defaults it to true server-side, so enable_thinking=false alone never turned thinking off.
 *
 * Read from the revision vLLM loads, on every call: a re-download can change the template.
 * Anything unrecognised keeps the old `enable_thinking` behaviour.
 */
export type ThinkingStyle = 'enable_thinking' | 'effort' | 'thinking';

function readFile(dir: string, name: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return null;
  }
}

/** The chat template of a snapshot: chat_template.jinja, else the chat_template field of chat_template.json / tokenizer_config.json. */
function templateText(snapshot: string): string | null {
  const jinja = readFile(snapshot, 'chat_template.jinja');
  if (jinja) return jinja;
  for (const name of ['chat_template.json', 'tokenizer_config.json']) {
    const raw = readFile(snapshot, name);
    if (!raw) continue;
    try {
      const t = (JSON.parse(raw) as { chat_template?: unknown }).chat_template;
      if (typeof t === 'string') return t;
      // named templates: [{ name: 'default', template: '…' }, { name: 'tool_use', … }]
      if (Array.isArray(t)) return t.map((x) => (typeof (x as { template?: unknown })?.template === 'string' ? (x as { template: string }).template : '')).join('\n');
    } catch {
      /* not JSON — no template here */
    }
  }
  return null;
}

function modelType(snapshot: string): string {
  try {
    const t = (JSON.parse(readFile(snapshot, 'config.json') ?? '') as { model_type?: unknown }).model_type;
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}

/** Does the served revision accept image_url parts? (a vision tower in config.json) */
export function modelHasVision(servedId: string, dir = hubDir()): boolean {
  const repo = repoDir(servedId, dir);
  const rev = currentRevision(repo);
  if (!rev) return false;
  try {
    const c = JSON.parse(readFile(path.join(repo, 'snapshots', rev), 'config.json') ?? '') as Record<string, unknown>;
    return Boolean(c.vision_config || c.is_multimodal || c.image_token_id !== undefined);
  } catch {
    return false;
  }
}

export function thinkingStyle(servedId: string, dir = hubDir()): ThinkingStyle {
  const repo = repoDir(servedId, dir);
  const rev = currentRevision(repo);
  if (!rev) return 'enable_thinking';
  const snapshot = path.join(repo, 'snapshots', rev);
  const template = templateText(snapshot);
  if (template !== null) {
    if (template.includes('enable_thinking')) return 'enable_thinking';
    if (template.includes('reasoning_effort')) return 'effort';
    // DeepSeek V3.1: a Jinja branch on a `thinking` variable (gpt-oss only has message.thinking, and reasoning_effort)
    if (/\{%-?\s*(?:if|elif)\s+(?:not\s+)?thinking\b/.test(template)) return 'thinking';
    return 'enable_thinking';
  }
  // no Jinja template at all: DeepSeek V3.2/V4 ship Python encoders that vLLM runs as tokenizer modes
  return /^deepseek_v(?:3[2-9]|[4-9])/.test(modelType(snapshot)) ? 'thinking' : 'enable_thinking';
}

/** The chat_template_kwargs that mean 思考模式 on/off for a style. */
export function thinkingKwargs(style: ThinkingStyle, on: boolean): Record<string, unknown> {
  if (style === 'effort') return on ? {} : { reasoning_effort: 'low' };
  if (style === 'thinking') return { thinking: on, enable_thinking: on };
  return { enable_thinking: on };
}

/** thinkingKwargs for whatever template the model served as `servedId` ships. */
export function templateKwargs(servedId: string, on: boolean, dir = hubDir()): Record<string, unknown> {
  return thinkingKwargs(thinkingStyle(servedId, dir), on);
}
