import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import {
  CHAT_SYSTEM_PROMPT,
  KNOWLEDGE_PROMPT,
  buildKnowledgeContext,
  countParams,
  fuseChunkLists,
  parseKeywords,
  parseMeminfo,
  parsePromMetrics,
  registerChatRoutes,
} from '../server/chatRoutes.js';
import type { RetrievedChunk } from '../knowledge/retrieve.js';
import { clearRecipeCache } from '../local/recipes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const SERVED = 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4';

const METRICS = [
  '# HELP vllm:num_requests_running Number of requests in model execution batches.',
  '# TYPE vllm:num_requests_running gauge',
  `vllm:num_requests_running{engine="0",model_name="${SERVED}"} 1.0`,
  `vllm:num_requests_waiting{engine="0",model_name="${SERVED}"} 0.0`,
  `vllm:kv_cache_usage_perc{engine="0",model_name="${SERVED}"} 0.25`,
  `vllm:generation_tokens_total{engine="0",model_name="${SERVED}"} 286901.0`,
  `vllm:prompt_tokens_total{engine="0",model_name="${SERVED}"} 5.291858e+06`,
  `vllm:cache_config_info{block_size="3024",cache_dtype="fp8",engine="0",gpu_memory_utilization="0.8",kv_cache_max_concurrency="3.71",kv_cache_size_tokens="973594"} 1.0`,
  `vllm:spec_decode_num_drafts_total{engine="0"} 100.0`,
  `vllm:spec_decode_num_draft_tokens_total{engine="0"} 400.0`,
  `vllm:spec_decode_num_accepted_tokens_total{engine="0"} 170.0`,
].join('\n');

const MEMINFO = 'MemTotal:       125511740 kB\nMemFree:         1018864 kB\nMemAvailable:    7578848 kB\n';

describe('chat route helpers', () => {
  it('parses Prometheus text with labels, scientific notation and comments', () => {
    const m = parsePromMetrics(METRICS);
    expect(m.get('vllm:num_requests_running')?.[0].value).toBe(1);
    expect(m.get('vllm:prompt_tokens_total')?.[0].value).toBe(5291858);
    expect(m.get('vllm:cache_config_info')?.[0].labels.kv_cache_size_tokens).toBe('973594');
    expect(m.has('# HELP vllm:num_requests_running')).toBe(false);
  });

  it('parses /proc/meminfo into bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ total_bytes: 125511740 * 1024, available_bytes: 7578848 * 1024 });
    expect(parseMeminfo(null)).toBeNull();
  });
});

describe('countParams', () => {
  it('counts parameters from safetensors headers: NVFP4 bytes double, scales excluded, active uses top-k', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-params-'));
    const header = {
      __metadata__: { format: 'pt' },
      'model.language_model.layers.0.mlp.experts.0.up_proj.weight': { dtype: 'U8', shape: [4, 2], data_offsets: [0, 8] },
      'model.language_model.layers.0.mlp.experts.0.up_proj.weight_scale': { dtype: 'F8_E4M3', shape: [4, 1], data_offsets: [8, 12] },
      'model.language_model.layers.0.mlp.experts.0.up_proj.input_scale': { dtype: 'F32', shape: [], data_offsets: [12, 16] },
      'model.language_model.layers.0.ple.ple_embedding.weight': { dtype: 'BF16', shape: [10, 4], data_offsets: [16, 96] },
      'model.language_model.layers.0.self_attn.q_proj.weight': { dtype: 'BF16', shape: [4, 4], data_offsets: [96, 128] },
      'mtp.layers.0.self_attn.q_proj.weight': { dtype: 'BF16', shape: [2, 2], data_offsets: [128, 136] },
      'model.visual.blocks.0.attn.proj.weight': { dtype: 'BF16', shape: [3, 3], data_offsets: [136, 154] },
    };
    const json = Buffer.from(JSON.stringify(header));
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(json.length));
    fs.writeFileSync(path.join(dir, 'model-00001-of-00001.safetensors'), Buffer.concat([len, json]));
    fs.writeFileSync(
      path.join(dir, 'model.safetensors.index.json'),
      JSON.stringify({ weight_map: Object.fromEntries(Object.keys(header).filter((k) => k !== '__metadata__').map((k) => [k, 'model-00001-of-00001.safetensors'])) }),
    );
    const counts = countParams(dir, { text_config: { num_experts: 4, num_experts_per_tok: 1 } });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(counts).toEqual({
      routed_experts: 16,
      per_layer_embedding: 40,
      other_language: 16,
      speculative: 4,
      vision: 9,
      language_total: 72,
      active_per_token: 20,
    });
  });
});

describe('buildKnowledgeContext', () => {
  it('numbers excerpts, labels their source and stops at the context budget', () => {
    const mk = (i: number, len: number): RetrievedChunk => ({
      chunk_id: i, document_id: i, source_id: 's', source_kind: 'git', path: `f${i}.md`, uri: null,
      section: i === 1 ? 'RDMA' : null, start_line: i, end_line: i + 1, text: 'x'.repeat(len), score: 1,
    });
    const { context, sources } = buildKnowledgeContext([mk(1, 10), mk(2, 1700), ...Array.from({ length: 20 }, (_, k) => mk(k + 3, 1700))], () => 'cf-aoi');
    expect(sources[0]).toMatchObject({ n: 1, source: 'cf-aoi', path: 'f1.md', section: 'RDMA' });
    expect(context.startsWith('[1] cf-aoi/f1.md（第 1–2 行） §RDMA')).toBe(true);
    expect(sources.length).toBeLessThan(22);
    expect(sources.reduce((sum, x) => sum + x.snippet.length, 0)).toBeLessThanOrEqual(16_000);
  });
});

describe('query expansion helpers', () => {
  it('parses a JSON keyword array, keeps identifiers intact and dedupes', () => {
    expect(parseKeywords('好的：["EnsureRecipeExists", "K3", "5.59ms", "K3", "配方不存在"]')).toEqual(['EnsureRecipeExists', 'K3', '5.59ms', '配方不存在']);
  });

  it('falls back to list lines when the model skips JSON', () => {
    expect(parseKeywords('1. RecipeService\n- 自動生成配方\n* x')).toEqual(['RecipeService', '自動生成配方']);
  });

  it('fuses ranked lists so chunks found by several queries rise to the top', () => {
    const c = (id: number): RetrievedChunk => ({
      chunk_id: id, document_id: id, source_id: 's', source_kind: 'git', path: `f${id}`, uri: null,
      section: null, start_line: 1, end_line: 2, text: 't', score: 0,
    });
    const fused = fuseChunkLists([[c(1), c(2), c(3)], [c(3), c(4)], [c(3)]], 3);
    expect(fused.map((x) => x.chunk_id)).toEqual([3, 1, 2]);
  });
});

describe('/api/chat through buildApp', () => {
  it('is 404 while local models are disabled', async () => {
    const db = openTestDb();
    const app = buildApp({ db, apiToken: null });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/chat/stats' })).statusCode).toBe(404);
    const post = await app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(post.statusCode).toBe(404);
    await app.close();
    db.close();
  });
});

describe('/api/chat with a fake vLLM', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let hubDir: string;
  const calls: { url: string; body: unknown }[] = [];
  const searches: string[] = [];
  const chunk = (id: number, p: string, text: string): RetrievedChunk => ({
    chunk_id: id,
    document_id: id,
    source_id: 'src_cfaoi',
    source_kind: 'git',
    path: p,
    uri: null,
    section: null,
    start_line: 1,
    end_line: 20,
    text,
    score: 1 / id,
  });

  beforeEach(async () => {
    db = openTestDb();
    setSetting(db, 'local_models_enabled', 'true');
    calls.length = 0;
    searches.length = 0;
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-hub-'));
    const repo = path.join(hubDir, `models--${SERVED.replace('/', '--')}`);
    fs.mkdirSync(path.join(repo, 'blobs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'snapshots', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'blobs', 'w1'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(repo, 'blobs', 'w2'), Buffer.alloc(24));
    fs.writeFileSync(
      path.join(repo, 'snapshots', 'abc', 'config.json'),
      JSON.stringify({ text_config: { num_hidden_layers: 48, hidden_size: 2560, num_experts: 512, num_experts_per_tok: 10 } }),
    );
    app = Fastify();
    registerChatRoutes(app, db, {
      hubDir,
      search: async (_db, q) => {
        searches.push(q);
        return [chunk(1, 'docs/rdma.md', 'RDMA 收圖改用 SEND/RECV，避免 slot 覆寫。'), chunk(2, 'ip/src/rdma_source.cpp', 'void RecvProcessor::handle() {}')];
      },
      readMeminfo: () => MEMINFO,
      gpu: async () => ({ name: 'NVIDIA GB10', util_pct: 3, temp_c: 49, power_w: 10.7 }),
      fetch: async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: SERVED, max_model_len: 262144 }] }));
        if (url.endsWith('/metrics')) return new Response(METRICS);
        if ((calls.at(-1)?.body as { stream?: boolean } | undefined)?.stream === false) {
          return new Response(JSON.stringify({ choices: [{ message: { content: '["SEND/RECV", "rdma_source"]' } }] }));
        }
        return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(hubDir, { recursive: true, force: true });
  });

  it('counts parameters from the loaded revision, not an aborted download that sorts first', async () => {
    // the real cache had two snapshots: '7c4f…' (10 files: config + index, no shards) and the
    // complete 'ada4…'. Reading whichever came first lost 參數組成 while 架構 still worked.
    const repo = path.join(hubDir, `models--${SERVED.replace('/', '--')}`);
    const cfg = JSON.stringify({ text_config: { num_hidden_layers: 48, num_experts: 4, num_experts_per_tok: 1 } });
    const header = { 'model.layers.0.self_attn.q_proj.weight': { dtype: 'BF16', shape: [4, 4], data_offsets: [0, 32] } };
    const json = Buffer.from(JSON.stringify(header));
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(json.length));
    for (const [rev, complete] of [['0abandoned', false], ['zcomplete', true]] as const) {
      const dir = path.join(repo, 'snapshots', rev);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), cfg);
      fs.writeFileSync(path.join(dir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { 'model.layers.0.self_attn.q_proj.weight': 'model-00001.safetensors' } }));
      if (complete) fs.writeFileSync(path.join(dir, 'model-00001.safetensors'), Buffer.concat([len, json]));
    }
    fs.mkdirSync(path.join(repo, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'refs', 'main'), 'zcomplete');
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const s = (await app.inject({ method: 'GET', url: '/api/chat/stats' })).json();
    expect(s.model.params).toMatchObject({ language_total: 16, other_language: 16 });
    expect(s.model.arch).toMatchObject({ layers: 48 });
  });

  it('reports model size, memory, KV cache, spec decode and GPU', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const res = await app.inject({ method: 'GET', url: '/api/chat/stats' });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.vllm_up).toBe(true);
    expect(s.served_id).toBe(SERVED);
    expect(s.model).toMatchObject({ disk_bytes: 1024, max_model_len: 262144, quant: 'NVFP4' });
    expect(s.model.arch).toMatchObject({ layers: 48, experts: 512, experts_per_token: 10 });
    expect(s.memory).toMatchObject({ total_bytes: 125511740 * 1024, vllm_fraction: 0.8 });
    expect(s.memory.used_bytes).toBe((125511740 - 7578848) * 1024);
    expect(s.kv_cache).toMatchObject({ size_tokens: 973594, dtype: 'fp8', usage_pct: 25, max_concurrency_full_context: 3.71 });
    expect(s.requests).toEqual({ running: 1, waiting: 0 });
    expect(s.spec_decode.acceptance_rate).toBeCloseTo(0.425);
    expect(s.gpu.name).toBe('NVIDIA GB10');
  });

  describe('上網／工具 gates', () => {
    const ask = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'user', content: 'hi' }], ...payload } });
    const upstream = () => calls.find((c) => c.url.endsWith('/chat/completions'))?.body as Record<string, unknown>;
    beforeEach(() => {
      setSetting(db, 'local_model_status', 'ready');
      setSetting(db, 'local_model_loaded', 'qwen38-flash');
    });

    it('chip off: no tools in the upstream body and the prompt still says there are none', async () => {
      const res = await ask({});
      expect(res.statusCode).toBe(200);
      expect(upstream().tools).toBeUndefined();
      const sys = (upstream().messages as Array<{ role: string; content: string }>)[0]!;
      expect(sys.content).toContain('你沒有任何工具');
      expect(res.body).not.toContain('loop_tool');
    });

    it('chip on but the setting off: plain answer plus an unsupported note', async () => {
      const res = await ask({ tools: true });
      expect(res.statusCode).toBe(200);
      expect(upstream().tools).toBeUndefined();
      expect(res.body).toContain('"unsupported":"上網／工具已停用');
    });

    it('chip on, setting on, but the recipe has no tool parser: unsupported', async () => {
      setSetting(db, 'chat_tools_enabled', 'true');
      setSetting(db, 'local_vllm_repo', '/nonexistent');
      const res = await ask({ tools: true });
      expect(res.body).toContain('tool-call-parser');
      expect(upstream().tools).toBeUndefined();
    });

    it('all three satisfied: the loop sends tool schemas and a tool-aware prompt', async () => {
      setSetting(db, 'chat_tools_enabled', 'true');
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-repo-'));
      fs.mkdirSync(path.join(repo, 'recipes'));
      fs.writeFileSync(path.join(repo, 'recipes', 'qwen3.8-flash-next-nvfp4-solo.yaml'), 'model: x\ncommand: |\n  vllm serve x --tool-call-parser qwen3_xml --enable-auto-tool-choice\n');
      setSetting(db, 'local_vllm_repo', repo);
      clearRecipeCache();
      const res = await ask({ tools: true });
      expect(res.statusCode).toBe(200);
      const body = upstream();
      expect((body.tools as unknown[]).length).toBe(2);
      expect(body.tool_choice).toBe('auto');
      const sys = (body.messages as Array<{ role: string; content: string }>)[0]!;
      expect(sys.content).toContain('web_search');
      expect(sys.content).not.toContain('你沒有任何工具');
      expect(res.body).toContain('"content":"hi"');
      expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
      // 繼續產生 never carries tools
      calls.length = 0;
      await ask({ tools: true, continue: true, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'partial' }] });
      expect(upstream().tools).toBeUndefined();
      fs.rmSync(repo, { recursive: true, force: true });
    });
  });

  it('refuses to chat when no local model is ready', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.statusCode).toBe(409);
  });

  it('rejects malformed messages', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'tool', content: 1 }] } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a pasted screenshot as an image part, even past the 1 MB default body limit', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const big = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
    const content = [
      { type: 'text', text: '這是什麼畫面？' },
      { type: 'image_url', image_url: { url: big } },
    ];
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'user', content }] } });
    expect(res.statusCode).toBe(200);
    const sent = calls.find((c) => c.url.endsWith('/chat/completions'))?.body as { messages: { role: string; content: unknown }[] };
    expect(sent.messages.find((m) => m.role === 'user')?.content).toEqual(content);
  });

  it('rejects remote image URLs and image parts on non-user turns', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const remote = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://example.com/a.png' } }] }] },
    });
    expect(remote.statusCode).toBe(400);
    const assistantImage = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        messages: [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
      },
    });
    expect(assistantImage.statusCode).toBe(400);
  });

  it('continues a truncated answer in place with thinking forced off', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const messages = [
      { role: 'user', content: '畫一張圖' },
      { role: 'assistant', content: '```svg\n<svg viewBox="0 0 10 10"><text font-size="1' },
    ];
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { messages, thinking: true, continue: true } });
    expect(res.statusCode).toBe(200);
    const sent = calls.find((c) => c.url.endsWith('/chat/completions'))?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      continue_final_message: true,
      add_generation_prompt: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect((sent.messages as { role: string }[]).at(-1)).toEqual(messages[1]);
  });

  it('refuses to continue when the last turn is not an assistant answer', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }], continue: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('grounds the answer in CF-AOI knowledge and sends the citations first', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    setSetting(db, 'rag_enabled', 'true');
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { messages: [{ role: 'user', content: 'RDMA 為什麼改 SEND/RECV？' }], knowledge: true },
    });
    expect(res.statusCode).toBe(200);
    expect(searches).toEqual(['RDMA 為什麼改 SEND/RECV？', 'SEND/RECV', 'rdma_source', 'SEND/RECV rdma_source']);
    const firstEvent = JSON.parse(res.body.split('\n\n')[0]!.slice('data: '.length));
    expect(firstEvent.loop_knowledge.sources.map((x: { n: number; path: string }) => [x.n, x.path])).toEqual([
      [1, 'docs/rdma.md'],
      [2, 'ip/src/rdma_source.cpp'],
    ]);
    expect(firstEvent.loop_knowledge.keywords).toEqual(['SEND/RECV', 'rdma_source']);
    const expansion = calls.find((c) => (c.body as { stream?: boolean } | undefined)?.stream === false)?.body as { messages: { content: string }[] };
    expect(expansion.messages[1]?.content).toBe('RDMA 為什麼改 SEND/RECV？');
    const sent = calls.find((c) => c.url.endsWith('/chat/completions') && (c.body as { stream?: boolean }).stream === true)
      ?.body as { messages: { role: string; content: string }[] };
    const system = sent.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(system.content).toContain(KNOWLEDGE_PROMPT);
    expect(system.content).toContain('[1] src_cfaoi/docs/rdma.md（第 1–20 行）');
  });

  it('reports a disabled corpus instead of searching when rag is off', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }], knowledge: true },
    });
    expect(searches).toEqual([]);
    expect(res.body).toContain('"error":"rag_enabled=false"');
  });

  it('streams vLLM output through with thinking off by default', async () => {
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"content":"hi"');
    expect(calls.find((c) => c.url.endsWith('/chat/completions'))?.body).not.toHaveProperty('continue_final_message');
    const sent = calls.find((c) => c.url.endsWith('/chat/completions'))?.body as Record<string, unknown>;
    expect((sent.messages as { role: string; content: string }[])[0]).toEqual({ role: 'system', content: CHAT_SYSTEM_PROMPT });
    expect(sent).toMatchObject({
      model: SERVED,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 12000,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

describe('chat page static assets', () => {
  it('is the entry page, and the old /chat.html bookmark forwards to it with its query intact', () => {
    const index = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    expect(index).toContain('/styles.css');
    expect(index).toContain('/chat.js');
    const stub = fs.readFileSync(path.join(WEB_DIR, 'chat.html'), 'utf8');
    expect(stub).toContain('location.replace');
    expect(stub).toContain('location.search');
    expect(stub).not.toContain('/chat.js');
  });

  // the innerHTML and sandbox guards moved to chat.static.test.ts: they now scan every script in
  // the shell, not just chat.js
});
