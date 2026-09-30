import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { thinkingKwargs, thinkingStyle, templateKwargs } from '../local/thinking.js';
import { chatLocal } from '../local/chat.js';
import { registerRecipe } from '../local/models.js';
import { hubDir } from '../local/weights.js';

// what the real templates on the Spark say, cut down to the part that decides the switch
const QWEN = "{%- if enable_thinking is defined and enable_thinking is false %}{{- '<think>\\n\\n</think>\\n\\n' }}{%- endif %}{%- if reasoning_effort %}x{% endif %}";
const GLM = "{%- set effective_reasoning_effort = reasoning_effort if reasoning_effort is defined and reasoning_effort in ['low', 'high'] else 'max' -%}<|assistant|>{{- '<think>' -}}";
const GPT_OSS = '{%- if reasoning_effort is defined %}Reasoning: {{ reasoning_effort }}{%- endif %}{%- if message.thinking %}{{ message.thinking }}{%- endif %}';
const DEEPSEEK_V31 = '{%- if not thinking is defined %}{%- set thinking = false %}{%- endif %}{%- if thinking %}<think>{%- else %}</think>{%- endif %}';
const CODER = '{%- for message in messages %}{{ message.content }}{%- endfor %}';

let dir: string;

/** A cached model as hf leaves it: refs/main naming the snapshot vLLM loads. */
function cached(servedId: string, files: Record<string, string>, root = dir): void {
  const repo = path.join(root, `models--${servedId.replace(/\//g, '--')}`);
  const snap = path.join(repo, 'snapshots', 'rev1');
  fs.mkdirSync(snap, { recursive: true });
  fs.mkdirSync(path.join(repo, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'refs', 'main'), 'rev1');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(snap, name), text);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-hub-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('which switch a chat template has for 思考模式', () => {
  it('reads the switch from the template the served revision ships', () => {
    cached('qwen/Qwen3.8', { 'chat_template.jinja': QWEN });
    cached('glm/GLM-5.3', { 'chat_template.jinja': GLM });
    cached('openai/gpt-oss', { 'tokenizer_config.json': JSON.stringify({ chat_template: GPT_OSS }) });
    cached('deepseek/V3.1', { 'tokenizer_config.json': JSON.stringify({ chat_template: [{ name: 'default', template: DEEPSEEK_V31 }] }) });
    cached('qwen/Coder', { 'chat_template.jinja': CODER });
    expect(thinkingStyle('qwen/Qwen3.8', dir)).toBe('enable_thinking'); // enable_thinking wins even beside reasoning_effort
    expect(thinkingStyle('glm/GLM-5.3', dir)).toBe('effort');
    expect(thinkingStyle('openai/gpt-oss', dir)).toBe('effort'); // message.thinking is a field, not the switch
    expect(thinkingStyle('deepseek/V3.1', dir)).toBe('thinking');
    expect(thinkingStyle('qwen/Coder', dir)).toBe('enable_thinking'); // no switch at all: as before
  });

  it('a model with no Jinja template is DeepSeek V3.2/V4 only when its config says so', () => {
    cached('deepseek/V4-Flash', { 'config.json': JSON.stringify({ model_type: 'deepseek_v4' }) });
    cached('deepseek/V3.2', { 'config.json': JSON.stringify({ model_type: 'deepseek_v32' }) });
    cached('deepseek/V3', { 'config.json': JSON.stringify({ model_type: 'deepseek_v3' }) });
    expect(thinkingStyle('deepseek/V4-Flash', dir)).toBe('thinking');
    expect(thinkingStyle('deepseek/V3.2', dir)).toBe('thinking');
    expect(thinkingStyle('deepseek/V3', dir)).toBe('enable_thinking');
    expect(thinkingStyle('nobody/not-downloaded', dir)).toBe('enable_thinking');
  });

  it('turns each style into the kwargs that mean on and off', () => {
    expect([thinkingKwargs('enable_thinking', true), thinkingKwargs('enable_thinking', false)]).toEqual([{ enable_thinking: true }, { enable_thinking: false }]);
    // GLM has no off switch: enable_thinking=false only made vLLM leak the thinking into the answer
    expect([thinkingKwargs('effort', true), thinkingKwargs('effort', false)]).toEqual([{}, { reasoning_effort: 'low' }]);
    // the DeepSeek V4 recipe defaults thinking=true server-side: enable_thinking alone never turned it off
    expect([thinkingKwargs('thinking', true), thinkingKwargs('thinking', false)]).toEqual([
      { thinking: true, enable_thinking: true },
      { thinking: false, enable_thinking: false },
    ]);
    cached('glm/GLM-5.3', { 'chat_template.jinja': GLM });
    expect(templateKwargs('glm/GLM-5.3', false, dir)).toEqual({ reasoning_effort: 'low' });
  });
});

describe('chatLocal asks each model for its own fast mode', () => {
  let db: Database.Database;
  const served = `glm-test/GLM-${process.pid}-${Date.now()}`;
  beforeEach(() => {
    db = openTestDb();
    setSetting(db, 'local_models_enabled', 'true');
  });
  afterEach(() => {
    db.close();
    fs.rmSync(path.join(hubDir(), `models--${served.replace(/\//g, '--')}`), { recursive: true, force: true });
  });

  it('titles, intents and PRD reviews on GLM ask for low effort, not an off switch it lacks', async () => {
    cached(served, { 'chat_template.jinja': GLM }, hubDir()); // the test env's isolated HF cache
    const model = registerRecipe(db, { recipe: 'glm-test', name: 'GLM test', model: served });
    setSetting(db, 'local_model_loaded', model.id);
    setSetting(db, 'local_model_status', 'ready');
    const bodies: Record<string, unknown>[] = [];
    const res = await chatLocal(db, { system: 's', user: 'u', maxTokens: 60 }, async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '對話標題' } }] }) };
    });
    expect(res).toEqual({ ok: true, content: '對話標題' });
    expect(bodies[0]).toMatchObject({ model: served, chat_template_kwargs: { reasoning_effort: 'low' } });
    expect(bodies[0]!.chat_template_kwargs).not.toHaveProperty('enable_thinking');
  });
});
