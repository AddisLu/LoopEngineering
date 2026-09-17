import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { htmlToText, decodeEntities } from '../chat/html.js';
import { BlockedUrlError, assertPublicHost, fetchBounded, isForbiddenAddress, type Lookup } from '../chat/netGuard.js';
import { builtinTools, fetchUrlTool, webSearchTool, UNTRUSTED_PREFIX, toOpenAiTools } from '../chat/tools.js';
import { mergeToolCallDelta, parseSseLines, runToolLoop } from '../chat/toolLoop.js';
import type { ToolDef } from '../chat/tools.js';

describe('htmlToText', () => {
  it('keeps the prose, drops chrome and code, decodes entities', () => {
    const html = `<html><head><title>vLLM &amp; friends</title><style>p{}</style><script>alert(1)</script></head>
      <body><nav><a>Home</a></nav><h1>Release</h1><p>v0.11 &lt;fast&gt;&nbsp;now</p><ul><li>one</li><li>two</li></ul>
      <table><tr><td>a</td><td>b</td></tr></table><footer>©2026</footer></body></html>`;
    const out = htmlToText(html);
    expect(out.title).toBe('vLLM & friends');
    expect(out.text).not.toContain('alert');
    expect(out.text).not.toContain('Home');
    expect(out.text).not.toContain('©2026');
    expect(out.text).toContain('# Release');
    expect(out.text).toContain('v0.11 <fast> now');
    expect(out.text).toContain('- one\n- two');
    expect(out.text).toContain('| a | b');
    expect(out.text).not.toMatch(/\n{3,}/);
  });
  it('decodes numeric and named entities but leaves unknown ones', () => {
    expect(decodeEntities('&#x4e2d;&#25991; &hellip; &bogus;')).toBe('中文 … &bogus;');
  });
});

describe('netGuard', () => {
  it('blocks private, loopback, link-local, CGNAT and v6 local ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', 'ff02::1']) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:1.1.1.1']) expect(isForbiddenAddress(ip), ip).toBe(false);
  });

  it('resolves names and rejects any private answer; the search host is exempt', async () => {
    const lookup: Lookup = async (h) => (h === 'evil.example' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicHost('good.example', new Set(), lookup)).resolves.toBeUndefined();
    await expect(assertPublicHost('evil.example', new Set(), lookup)).rejects.toThrow(BlockedUrlError);
    await expect(assertPublicHost('localhost', new Set(), lookup)).rejects.toThrow(/內部主機/);
    await expect(assertPublicHost('spark.internal', new Set(), lookup)).rejects.toThrow(BlockedUrlError);
    await expect(assertPublicHost('192.168.7.7', new Set(), lookup)).rejects.toThrow(/內網/);
    await expect(assertPublicHost('127.0.0.1', new Set(['127.0.0.1']), lookup)).resolves.toBeUndefined();
    // the exemption is host:port — the search box, not everything on loopback
    const fake = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const base = { fetch: fake, lookup, timeoutMs: 1000, maxBytes: 100, allowHosts: new Set(['127.0.0.1:8080']) };
    await expect(fetchBounded('http://127.0.0.1:8080/search', base)).resolves.toMatchObject({ status: 200 });
    await expect(fetchBounded('http://127.0.0.1:4711/api/board', base)).rejects.toThrow(BlockedUrlError);
    await expect(fetchBounded('http://127.0.0.1:8000/v1/models', base)).rejects.toThrow(BlockedUrlError);
  });

  it('fetchBounded caps bytes, re-checks every redirect hop and stops at the redirect limit', async () => {
    const lookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.startsWith('http://a.example/to-private')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4711/api/board' } });
      if (url.startsWith('http://a.example/loop')) return new Response(null, { status: 302, headers: { location: 'http://a.example/loop' } });
      if (url.startsWith('http://a.example/big')) return new Response('x'.repeat(5000), { status: 200, headers: { 'content-type': 'text/plain' } });
      return new Response('<html><title>t</title><body>ok</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const base = { fetch: fake, lookup, timeoutMs: 2000, maxBytes: 1000 };
    await expect(fetchBounded('http://a.example/to-private', base)).rejects.toThrow(/內網/);
    await expect(fetchBounded('http://a.example/loop', base)).rejects.toThrow(/轉址超過/);
    await expect(fetchBounded('ftp://a.example/x', base)).rejects.toThrow(/http/);
    await expect(fetchBounded('http://user:pw@a.example/x', base)).rejects.toThrow(/帳號密碼/);
    await expect(fetchBounded('not a url', base)).rejects.toThrow(/合法網址/);
    const big = await fetchBounded('http://a.example/big', base);
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBe(1000);
    const ok = await fetchBounded('http://a.example/page', base);
    expect(ok).toMatchObject({ status: 200, truncated: false });
    expect(ok.contentType).toContain('html');
    // one transient "fetch failed" is retried; a second one (or a non-network error) is not
    let n = 0;
    const flaky = (async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    expect((await fetchBounded('http://a.example/x', { ...base, fetch: flaky })).status).toBe(200);
    expect(n).toBe(2);
    const dead = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fetchBounded('http://a.example/x', { ...base, fetch: dead })).rejects.toThrow('fetch failed');
  });
});

describe('built-in tools', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());
  const ctx = (fetchImpl: typeof fetch, lookup?: Lookup) => ({ db, fetch: fetchImpl, lookup, signal: new AbortController().signal });
  const okLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('web_search asks SearXNG for JSON and returns up to 5 hits with sources', async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      const results = Array.from({ length: 8 }, (_, i) => ({ title: `Hit ${i}`, url: `https://ex.com/${i}`, content: `snippet ${i}` }));
      return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const tool = webSearchTool(db)!;
    const r = await tool.run({ query: 'vllm release' }, ctx(fake));
    expect(urls[0]).toContain('http://127.0.0.1:8080/search?q=vllm%20release&format=json');
    expect(r.ok).toBe(true);
    expect(r.sources).toHaveLength(5);
    expect(r.text).toContain('1. Hit 0');
    expect(r.summary).toBe('「vllm release」5 筆');
    expect((await tool.run({}, ctx(fake))).ok).toBe(false);
    // no search backend configured → no web_search tool at all
    setSetting(db, 'chat_search_url', '');
    expect(webSearchTool(db)).toBeNull();
    expect(builtinTools(db).map((t) => t.name)).toEqual(['fetch_url']);
  });

  it('fetch_url converts HTML to text, caps the length, and reports blocked URLs as tool errors', async () => {
    setSetting(db, 'chat_tool_result_chars', '50');
    const fake = (async () => new Response(`<html><title>Doc</title><body><p>${'word '.repeat(100)}</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const tool = fetchUrlTool(db);
    const r = await tool.run({ url: 'https://docs.example/page' }, ctx(fake, okLookup));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('標題：Doc');
    expect(r.text).toContain('已截斷');
    expect(r.sources).toEqual([{ title: 'Doc', url: 'https://docs.example/page' }]);
    const blocked = await tool.run({ url: 'http://127.0.0.1:4711/api/board' }, ctx(fake, okLookup));
    expect(blocked.ok).toBe(false);
    expect(blocked.summary).toContain('已擋下');
  });

  it('exports OpenAI function schemas', () => {
    const t = toOpenAiTools(builtinTools(db));
    expect(t.map((x) => x.function.name)).toEqual(['web_search', 'fetch_url']);
    expect(t[0]!.type).toBe('function');
  });
});

describe('tool loop', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());

  const sse = (frames: unknown[]) => `${frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
  const echo: ToolDef = {
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    run: async (args) => ({ ok: true, text: `echo:${args.q}`, summary: `echo ${args.q}`, sources: [{ title: 't', url: 'https://x.example' }] }),
  };

  it('parses SSE across chunk boundaries and merges fragmented tool calls', () => {
    const a = parseSseLines('data: {"a":1}\n\nda', '');
    expect(a.events).toEqual(['{"a":1}']);
    const b = parseSseLines('ta: {"b":2}\n\n', a.carry);
    expect(b.events).toEqual(['{"b":2}']);
    const acc = new Map();
    mergeToolCallDelta(acc, [{ index: 0, id: 'c1', function: { name: 'ec' } }]);
    mergeToolCallDelta(acc, [{ index: 0, function: { name: 'ho', arguments: '{"q":' } }]);
    mergeToolCallDelta(acc, [{ index: 0, function: { arguments: '"x"}' } }]);
    expect(acc.get(0)).toEqual({ id: 'c1', name: 'echo', args: '{"q":"x"}' });
  });

  it('runs a tool round, feeds results back as untrusted data, then streams the final answer', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const out: string[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          sse([
            { choices: [{ delta: { reasoning: 'think' } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'echo', arguments: '{"q":' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            { usage: { prompt_tokens: 10, completion_tokens: 5 } },
          ]),
        );
      }
      return new Response(sse([{ choices: [{ delta: { content: 'answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { prompt_tokens: 30, completion_tokens: 7 } }]));
    }) as unknown as typeof fetch;
    const r = await runToolLoop({
      fetch: fake,
      baseUrl: 'http://v/v1',
      body: { model: 'm', stream: true },
      messages: [{ role: 'user', content: 'q' }],
      tools: [echo],
      ctx: { db, fetch: fake, signal: new AbortController().signal },
      maxRounds: 5,
      wallMs: 60_000,
      write: (l) => out.push(l),
      signal: new AbortController().signal,
    });
    expect(r.status).toBe(200);
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.calls[0]).toMatchObject({ id: 'c1', name: 'echo', args: { q: 'hi' }, ok: true, summary: 'echo hi' });
    expect(r.usage).toEqual({ prompt_tokens: 40, completion_tokens: 12 });
    // first request carried the tool schemas; the second carried the tool result as data
    expect(bodies[0]!.tools).toBeTruthy();
    const msgs = bodies[1]!.messages as Array<{ role: string; content?: string; tool_call_id?: string }>;
    expect(msgs.at(-2)?.role).toBe('assistant');
    expect(msgs.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(msgs.at(-1)!.content!.startsWith(UNTRUSTED_PREFIX)).toBe(true);
    expect(msgs.at(-1)!.content).toContain('echo:hi');
    // what the page saw: reasoning forwarded, tool_calls fragments not, one status + one round frame, content, merged usage, DONE
    const joined = out.join('');
    expect(joined).toContain('"reasoning":"think"');
    expect(joined).not.toContain('tool_calls');
    expect(joined).toContain('"loop_tool":{"status":"running","round":1,"names":["echo"]}');
    expect(joined).toContain('"loop_tool":{"round":1');
    expect(joined).toContain('"content":"answer"');
    expect(joined).toContain('"usage":{"prompt_tokens":40,"completion_tokens":12}');
    expect(joined.trim().endsWith('data: [DONE]')).toBe(true);
    // the tool round's finish_reason never reached the page
    expect(joined).not.toContain('"finish_reason":"tool_calls"');
  });

  it('stops after the round cap, on a repeated call, and turns bad arguments into tool errors', async () => {
    let n = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      n += 1;
      if (body.tools) {
        const args = n === 1 ? 'not json' : '{"q":"same"}';
        return new Response(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: 'echo', arguments: args } }] }, finish_reason: 'tool_calls' }] }]));
      }
      return new Response(sse([{ choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }] }]));
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const r = await runToolLoop({
      fetch: fake,
      baseUrl: 'http://v/v1',
      body: {},
      messages: [{ role: 'user', content: 'q' }],
      tools: [echo],
      ctx: { db, fetch: fake, signal: new AbortController().signal },
      maxRounds: 4,
      wallMs: 60_000,
      write: (l) => out.push(l),
      signal: new AbortController().signal,
    });
    // round 1: bad JSON → error result; round 2: ok; round 3: identical call → final round without tools
    expect(r.rounds[0]!.calls[0]).toMatchObject({ ok: false });
    expect(r.rounds[0]!.calls[0]!.summary).toContain('JSON');
    expect(r.rounds).toHaveLength(3);
    expect(bodies.at(-1)!.tools).toBeUndefined();
    const last = (bodies.at(-1)!.messages as Array<{ role: string; content: string }>).at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toContain('重複');
    expect(out.join('')).toContain('"content":"final"');
  });

  it('unknown tools are reported to the model, and an upstream error surfaces', async () => {
    const fake = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools) return new Response(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'nope', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }]));
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const r = await runToolLoop({
      fetch: fake,
      baseUrl: 'http://v/v1',
      body: {},
      messages: [],
      tools: [echo],
      ctx: { db, fetch: fake, signal: new AbortController().signal },
      maxRounds: 1,
      wallMs: 60_000,
      write: (l) => out.push(l),
      signal: new AbortController().signal,
    });
    expect(r.rounds[0]!.calls[0]).toMatchObject({ name: 'nope', ok: false, id: 'call_1_0' });
    expect(r.error).toContain('HTTP 500');
  });
});
