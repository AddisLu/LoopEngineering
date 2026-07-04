/**
 * Incremental NDJSON collector for the `--output-format stream-json` protocol
 * (and the mock adapter, which emits the same shape). Feed it stdout chunks;
 * it captures the session id, the final result event, and usage, and forwards
 * each parsed event to an optional live callback (SSE later).
 */
export interface StreamResult {
  sessionId: string | null;
  usageJson: string | null;
  resultSubtype: string | null; // success | error_max_turns | interrupted | ...
  lastText: string | null;
}

export function createNdjsonCollector(onEvent?: (evt: any) => void) {
  let buf = '';
  const res: StreamResult = {
    sessionId: null,
    usageJson: null,
    resultSubtype: null,
    lastText: null,
  };

  function handle(evt: any): void {
    if (!evt || typeof evt !== 'object') return;
    if (evt.session_id) res.sessionId = evt.session_id;
    if (evt.type === 'result') {
      res.resultSubtype = evt.subtype ?? 'success';
      if (evt.usage) res.usageJson = JSON.stringify(evt.usage);
    }
    if (typeof evt.text === 'string') res.lastText = evt.text;
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
