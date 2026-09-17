import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { registerChatRoutes } from '../server/chatRoutes.js';
import { GenerationRegistry } from '../chat/generation.js';
import { appendMessage, createConversation, getMessage } from '../chat/store.js';

const SERVED = 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4';
const USER = 'local';

/** A vLLM that streams `words` one SSE frame at a time, `gapMs` apart, and notices aborts. */
function slowVllm(words: string[], gapMs: number, seen: { aborted: boolean; started: number }) {
  return async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: SERVED }] }));
    seen.started += 1;
    const signal = init?.signal;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        for (let i = 0; i < words.length; i++) {
          await new Promise((r) => setTimeout(r, gapMs));
          if (signal?.aborted) {
            seen.aborted = true;
            ctl.error(new Error('aborted'));
            return;
          }
          ctl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i] } }] })}\n\n`));
        }
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: words.length } })}\n\ndata: [DONE]\n\n`));
        ctl.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
}

describe('generation registry', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());

  it('accumulates frames, fans out to listeners, and writes the row on finish', () => {
    const conv = createConversation(db, { user_key: USER });
    const row = appendMessage(db, conv.id, USER, { role: 'assistant', content: '' });
    let t = 1000;
    const timers: Array<() => void> = [];
    const reg = new GenerationRegistry(db, { now: () => t, keepMs: 5, setTimer: (fn) => timers.push(fn) });
    const ac = new AbortController();
    reg.start({ messageId: row.id, conversationId: conv.id, userKey: USER }, ac);
    expect(() => reg.start({ messageId: row.id, conversationId: conv.id, userKey: USER }, ac)).toThrow(/產生中/);
    const heard: string[] = [];
    reg.attach(row.id, (l) => heard.push(l));
    reg.push(row.id, 'data: {"loop_knowledge":{"sources":[{"n":1}],"keywords":["k"]}}\n\n');
    t = 1300;
    reg.push(row.id, 'data: {"choices":[{"delta":{"reasoning":"think "}}]}\n\n');
    reg.push(row.id, 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    reg.push(row.id, 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    reg.push(row.id, 'data: {"loop_tool":{"round":1,"calls":[{"name":"web_search"}]}}\n\n');
    reg.push(row.id, 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
    expect(reg.isRunning(row.id)).toBe(true);
    // a late listener gets the replay
    const late: string[] = [];
    reg.attach(row.id, (l) => late.push(l));
    expect(late).toHaveLength(6);
    t = 2000;
    reg.finish(row.id, null);
    expect(heard.at(-1)).toContain('[DONE]');
    expect(late.at(-1)).toContain('[DONE]');
    const saved = getMessage(db, row.id, USER)!.message;
    expect(saved).toMatchObject({ content: 'Hello', reasoning: 'think ', finish_reason: 'stop', tokens_in: 5, tokens_out: 2, ttft_ms: 300, duration_ms: 1000, keywords: ['k'] });
    expect(saved.sources).toEqual([{ n: 1 }]);
    expect(saved.tools).toHaveLength(1);
    expect(reg.isRunning(row.id)).toBe(false);
    // still replayable until the keep timer fires
    expect(reg.get(row.id)).toBeTruthy();
    timers[0]!();
    expect(reg.get(row.id)).toBeUndefined();
  });

  it('abort flips the finish reason and an error is carried to listeners', () => {
    const conv = createConversation(db, { user_key: USER });
    const row = appendMessage(db, conv.id, USER, { role: 'assistant', content: '' });
    const reg = new GenerationRegistry(db, { setTimer: () => 0 });
    const ac = new AbortController();
    reg.start({ messageId: row.id, conversationId: conv.id, userKey: USER }, ac);
    reg.push(row.id, 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    expect(reg.abort(row.id)).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    reg.finish(row.id, 'abort');
    expect(getMessage(db, row.id, USER)!.message).toMatchObject({ content: 'partial', finish_reason: 'abort' });
    expect(reg.abort(row.id)).toBe(false);
    const row2 = appendMessage(db, conv.id, USER, { role: 'assistant', content: '' });
    reg.start({ messageId: row2.id, conversationId: conv.id, userKey: USER }, new AbortController());
    const heard: string[] = [];
    reg.attach(row2.id, (l) => heard.push(l));
    reg.finish(row2.id, null, 'vLLM 串流中斷');
    expect(heard.join('')).toContain('"loop_gen":{"error":"vLLM 串流中斷"}');
    expect(getMessage(db, row2.id, USER)!.message.finish_reason).toBe('error');
  });
});

describe('POST /api/chat with message_id', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let base = '';
  const seen = { aborted: false, started: 0 };
  let reg: GenerationRegistry;

  async function boot(words: string[], gapMs: number) {
    db = openTestDb();
    setSetting(db, 'local_models_enabled', 'true');
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    seen.aborted = false;
    seen.started = 0;
    reg = new GenerationRegistry(db, { setTimer: () => 0 });
    app = Fastify();
    registerChatRoutes(app, db, { fetch: slowVllm(words, gapMs, seen), generations: reg, readMeminfo: () => null, gpu: async () => null });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  afterEach(async () => {
    await app.close();
    db.close();
  });
  const row = () => {
    const conv = createConversation(db, { user_key: USER });
    appendMessage(db, conv.id, USER, { role: 'user', content: 'q' });
    return { conv, a: appendMessage(db, conv.id, USER, { role: 'assistant', content: '' }) };
  };
  const ask = (messageId: string, signal?: AbortSignal) =>
    fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }], message_id: messageId }), signal });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('keeps generating after the page leaves, stores the whole answer, and replays it on re-attach', async () => {
    await boot(['one ', 'two ', 'three ', 'four'], 40);
    const { conv, a } = row();
    const ac = new AbortController();
    const res = await ask(a.id, ac.signal);
    const reader = res.body!.getReader();
    await reader.read(); // first frame arrived — now the "page" navigates away
    ac.abort();
    await wait(60);
    expect(reg.isRunning(a.id)).toBe(true); // still going without a socket
    // a returning page re-attaches: replay + live tail
    const stream = await fetch(`${base}/api/chat/messages/${a.id}/stream`);
    const text = await stream.text();
    expect(text).toContain('"loop_resume"');
    expect(text).toContain('"content":"one "');
    expect(text).toContain('"content":"four"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    await wait(20);
    expect(seen.aborted).toBe(false);
    const saved = getMessage(db, a.id, USER)!.message;
    expect(saved).toMatchObject({ content: 'one two three four', finish_reason: 'stop', tokens_out: 4 });
    // the conversation view says it is no longer generating
    const view = await app.inject({ method: 'GET', url: `/api/chat/conversations/${conv.id}` });
    expect(view.json().messages.at(-1)).toMatchObject({ id: a.id, generating: false, content: 'one two three four' });
    // a finished (still-cached) generation replays instantly for a late page
    expect((await fetch(`${base}/api/chat/messages/${a.id}/stream`).then((r) => r.text())).trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('停止 is an explicit abort; without message_id a closed socket still stops vLLM', async () => {
    await boot(['a ', 'b ', 'c ', 'd ', 'e ', 'f '], 40);
    const { conv, a } = row();
    const ac = new AbortController();
    const res = await ask(a.id, ac.signal);
    await res.body!.getReader().read();
    const view = await app.inject({ method: 'GET', url: `/api/chat/conversations/${conv.id}` });
    expect(view.json().messages.at(-1).generating).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/chat/messages/${a.id}/abort` })).statusCode).toBe(200);
    ac.abort();
    await wait(120);
    expect(seen.aborted).toBe(true);
    expect(getMessage(db, a.id, USER)!.message.finish_reason).toBe('abort');
    expect((await app.inject({ method: 'POST', url: `/api/chat/messages/${a.id}/abort` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/chat/messages/m_nope/stream` })).statusCode).toBe(404);

    // legacy caller (no message_id): closing the socket aborts upstream as before
    seen.aborted = false;
    const ac2 = new AbortController();
    const res2 = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }), signal: ac2.signal });
    await res2.body!.getReader().read();
    ac2.abort();
    await wait(120);
    expect(seen.aborted).toBe(true);
    // a foreign / unknown message_id is refused
    expect((await app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'user', content: 'q' }], message_id: 'm_nope' } })).statusCode).toBe(404);
  });
});
