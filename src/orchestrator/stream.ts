/**
 * Incremental NDJSON collector for the agent CLIs' JSON streams. Feed it stdout chunks;
 * it captures the session id, the final result event, usage and token counts, and
 * forwards each parsed event to an optional live callback. Two dialects:
 *  - Claude Code `--output-format stream-json` (and the mock adapter): `session_id`, a final
 *    `{type:'result', subtype, usage:{input_tokens, output_tokens}}`.
 *  - opencode `run --format json` (本地模型): one `{type, timestamp, sessionID, part|error}`
 *    line per event; `step_finish.part.tokens` per model step (summed here), `text` parts,
 *    and `error` on a session error (opencode also exits 1). There is no final result event,
 *    so a clean opencode run leaves resultSubtype null (exit 0 still passes dispatchFailed).
 */
export interface StreamResult {
  sessionId: string | null;
  usageJson: string | null;
  resultSubtype: string | null; // success | error_max_turns | interrupted | ...
  lastText: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createNdjsonCollector(onEvent?: (evt: any) => void) {
  let buf = '';
  const res: StreamResult = {
    sessionId: null,
    usageJson: null,
    resultSubtype: null,
    lastText: null,
    tokensIn: null,
    tokensOut: null,
  };
  // opencode per-step usage, accumulated into usageJson
  let oc: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number; cost: number; steps: number } | null = null;

  function handle(evt: any): void {
    if (!evt || typeof evt !== 'object') return;
    if (evt.session_id) res.sessionId = evt.session_id;
    if (evt.type === 'result') {
      res.resultSubtype = evt.subtype ?? 'success';
      if (evt.usage) {
        res.usageJson = JSON.stringify(evt.usage);
        if (typeof evt.usage.input_tokens === 'number') res.tokensIn = evt.usage.input_tokens;
        if (typeof evt.usage.output_tokens === 'number') res.tokensOut = evt.usage.output_tokens;
      }
    }
    if (typeof evt.text === 'string') res.lastText = evt.text;

    // opencode dialect
    if (typeof evt.sessionID === 'string' && evt.sessionID) res.sessionId = evt.sessionID;
    if (evt.type === 'step_finish' && evt.part?.tokens) {
      const t = evt.part.tokens;
      oc ??= { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, cost: 0, steps: 0 };
      oc.input += num(t.input);
      oc.output += num(t.output);
      oc.reasoning += num(t.reasoning);
      oc.cache_read += num(t.cache?.read);
      oc.cache_write += num(t.cache?.write);
      oc.cost += num(evt.part.cost);
      oc.steps += 1;
      res.tokensIn = oc.input + oc.cache_read + oc.cache_write;
      res.tokensOut = oc.output + oc.reasoning;
      res.usageJson = JSON.stringify(oc);
    }
    if (evt.type === 'text' && typeof evt.part?.text === 'string') res.lastText = evt.part.text;
    if (evt.type === 'error') res.resultSubtype = 'error';
    onEvent?.(evt);
  }

  return {
    push(chunk: string): void {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          /* tolerate non-JSON log lines */
        }
      }
    },
    flush(): void {
      const line = buf.trim();
      buf = '';
      if (!line) return;
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore */
      }
    },
    result(): StreamResult {
      return res;
    },
  };
}
