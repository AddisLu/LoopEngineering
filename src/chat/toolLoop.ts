import { UNTRUSTED_PREFIX, toOpenAiTools, type ToolCtx, type ToolDef, type ToolRound, type ToolCall } from './tools.js';

/**
 * The tool-calling loop for POST /api/chat. Streams vLLM's answer to the browser exactly as the
 * plain path does, except that tool-call fragments are collected instead of forwarded; when a
 * round ends with finish_reason 'tool_calls' the tools run, one `loop_tool` frame tells the page
 * what happened, the results go back into the conversation, and the next round starts.
 *
 * Stops on its own when the model over-uses tools: a round cap, a wall-clock budget and a
 * repeat of an identical call all end with one final tool-free round. Everything the tools
 * return is prefixed as untrusted data.
 */

export interface UpstreamMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ToolLoopOptions {
  fetch: typeof fetch;
  baseUrl: string;
  /** upstream body minus messages/tools — model, max_tokens, stream flags, thinking kwargs */
  body: Record<string, unknown>;
  messages: UpstreamMessage[];
  tools: ToolDef[];
  ctx: ToolCtx;
  maxRounds: number;
  wallMs: number;
  write: (line: string) => void;
  signal: AbortSignal;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface ToolLoopResult {
  rounds: ToolRound[];
  finish: string | null;
  usage: { prompt_tokens: number; completion_tokens: number };
  status: number;
  error?: string;
}

/** Splits a raw SSE byte stream into complete `data:` payloads; returns the unfinished remainder. */
export function parseSseLines(chunk: string, carry: string): { events: string[]; carry: string } {
  const buf = carry + chunk;
  const events: string[] = [];
  let cut;
  let rest = buf;
  while ((cut = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) events.push(line.slice(5).trim());
    }
  }
  return { events, carry: rest };
}

interface PartialCall {
  id: string;
  name: string;
  args: string;
}

/** Merge one streamed `delta.tool_calls` array into the per-index accumulator. */
export function mergeToolCallDelta(acc: Map<number, PartialCall>, delta: unknown): void {
  if (!Array.isArray(delta)) return;
  for (const raw of delta) {
    const tc = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
    const idx = typeof tc.index === 'number' ? tc.index : acc.size;
    const cur = acc.get(idx) ?? { id: '', name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    acc.set(idx, cur);
  }
}

const NUDGE = '請根據目前已取得的工具結果直接作答，不要再呼叫工具；資料不足就說明還缺什麼。';

export async function runToolLoop(o: ToolLoopOptions): Promise<ToolLoopResult> {
  const now = o.now ?? Date.now;
  const started = now();
  const log = o.log ?? (() => {});
  const rounds: ToolRound[] = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const seen = new Set<string>();
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const messages = [...o.messages];
  let finalRound = false;
  let finish: string | null = null;

  for (let round = 1; ; round++) {
    const withTools = !finalRound && o.tools.length > 0;
    const body = {
      ...o.body,
      messages,
      ...(withTools ? { tools: toOpenAiTools(o.tools), tool_choice: 'auto' } : {}),
    };
    const res = await o.fetch(`${o.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: o.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return { rounds, finish, usage, status: res.status, error: `vLLM HTTP ${res.status}: ${detail.slice(0, 300)}` };
    }

    const acc = new Map<number, PartialCall>();
    let roundFinish: string | null = null;
    let sawContent = false;
    let carry = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const parsed = parseSseLines(dec.decode(chunk, { stream: true }), carry);
      carry = parsed.carry;
      for (const data of parsed.events) {
        if (data === '[DONE]') continue;
        let j: { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> };
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.usage) {
          usage.prompt_tokens += j.usage.prompt_tokens ?? 0;
          usage.completion_tokens += j.usage.completion_tokens ?? 0;
        }
        const ch = j.choices?.[0];
        if (!ch) continue;
        const d = ch.delta ?? {};
        if (d.tool_calls) {
          mergeToolCallDelta(acc, d.tool_calls);
          // strip the fragment but keep any reasoning/content that rode along in the same delta
          const rest = { ...d };
          delete rest.tool_calls;
          if (!rest.content && !rest.reasoning && !rest.reasoning_content) continue;
          ch.delta = rest;
        }
        if (d.content) sawContent = true;
        if (ch.finish_reason === 'tool_calls') {
          roundFinish = 'tool_calls';
          continue; // the page must not see a finish before the final round
        }
        if (ch.finish_reason) roundFinish = ch.finish_reason;
        if (ch.finish_reason && acc.size) continue; // some parsers end a tool round with 'stop'
        o.write(`data: ${JSON.stringify(j)}\n\n`);
      }
    }

    if (!acc.size || finalRound) {
      finish = roundFinish;
      if (!sawContent && rounds.length && !finalRound && round <= o.maxRounds + 1) {
        // answered with nothing after using tools — one nudge, then give up
        messages.push({ role: 'user', content: NUDGE });
        finalRound = true;
        continue;
      }
      break;
    }

    // ---- execute this round's tool calls ---------------------------------------------------
    const calls = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, c], i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
    o.write(`data: ${JSON.stringify({ loop_tool: { status: 'running', round, names: calls.map((c) => c.name) } })}\n\n`);
    type Executed = ToolCall & { _text: string };
    const results: Executed[] = await Promise.all(
      calls.map(async (c) => {
        const t0 = now();
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const parsed = c.args.trim() ? JSON.parse(c.args) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          else parseError = '參數必須是 JSON 物件';
        } catch {
          parseError = `參數不是合法 JSON：${c.args.slice(0, 120)}`;
        }
        const def = byName.get(c.name);
        let r: { ok: boolean; text: string; summary: string; sources?: ToolCall['sources']; detail?: string; action?: ToolCall['action'] };
        if (parseError) r = { ok: false, text: parseError, summary: parseError };
        else if (!def) r = { ok: false, text: `沒有這個工具：${c.name}`, summary: `未知工具 ${c.name}` };
        else {
          try {
            r = await def.run(args, o.ctx);
          } catch (err) {
            r = { ok: false, text: `工具執行失敗：${(err as Error).message.slice(0, 200)}`, summary: '執行失敗' };
          }
        }
        // what gets recorded/shown for the call: a tool may slim it down (a whole source file
        // written to the sandbox is not something the page or chat_messages.tools_json should carry)
        let recorded = args;
        if (def?.recordArgs && !parseError) {
          try {
            recorded = def.recordArgs(args);
          } catch {
            recorded = {};
          }
        }
        log(`tool ${c.name} ${JSON.stringify(recorded).slice(0, 200)} → ${r.ok ? 'ok' : 'error'} ${now() - t0} ms`);
        const done: Executed = {
          id: c.id,
          name: c.name,
          args: recorded,
          ms: now() - t0,
          ok: r.ok,
          summary: r.summary,
          ...(r.sources ? { sources: r.sources } : {}),
          ...(r.detail ? { detail: r.detail } : {}),
          ...(r.action ? { action: r.action } : {}),
          _text: r.text,
        };
        return done;
      }),
    );
    const roundRec: ToolRound = { round, calls: results.map(({ _text: _t, ...rest }) => rest) };
    rounds.push(roundRec);
    o.write(`data: ${JSON.stringify({ loop_tool: roundRec })}\n\n`);

    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: `${byName.get(r.name)?.resultPrefix ?? UNTRUSTED_PREFIX}${r._text}` });
    }

    // ---- decide whether the model may call tools again ------------------------------------
    let stop: string | null = null;
    for (const c of calls) {
      // re-running the same build after changing a file is progress, not a loop
      if (byName.get(c.name)?.repeatable) continue;
      const sig = `${c.name}:${c.args}`;
      if (seen.has(sig)) stop = '重複相同的工具呼叫';
      seen.add(sig);
    }
    if (round >= o.maxRounds) stop = stop ?? `已達 ${o.maxRounds} 輪上限`;
    if (now() - started > o.wallMs) stop = stop ?? '工具時間預算用完';
    if (stop) {
      log(`tool loop: final round (${stop})`);
      messages.push({ role: 'user', content: `（${stop}）${NUDGE}` });
      finalRound = true;
    }
  }

  o.write(`data: ${JSON.stringify({ usage })}\n\n`);
  o.write('data: [DONE]\n\n');
  return { rounds, finish, usage, status: 200 };
}
