import type Database from 'better-sqlite3';
import { updateMessage } from './store.js';

/**
 * In-flight answers, kept server-side so the page can leave and come back.
 *
 * Before this existed the browser was the only place an answer lived until it PATCHed the row
 * every 15 s, and closing the socket aborted vLLM — clicking 任務看板 mid-answer truncated it.
 * Now a generation that the page registered (message_id in POST /api/chat) keeps every SSE
 * line here, accumulates the answer, finishes even if nobody is listening, writes the final
 * row itself, and lets a returning page replay + re-attach through GET …/stream.
 */

export interface GenUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface Generation {
  messageId: string;
  conversationId: string;
  userKey: string;
  frames: string[];
  bytes: number;
  done: boolean;
  finish: string | null;
  error: string | null;
  startedAt: number;
  firstTokenAt: number | null;
  endedAt: number | null;
  detached: boolean;
  ac: AbortController;
  listeners: Set<(line: string) => void>;
  acc: {
    content: string;
    reasoning: string;
    sources: unknown[];
    keywords: string[];
    tools: unknown[];
    usage: GenUsage | null;
  };
}

export interface GenerationDeps {
  now?: () => number;
  /** how long a finished generation stays replayable for a late GET …/stream */
  keepMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export class GenerationBusyError extends Error {}

const MAX_BYTES = 4 * 1024 * 1024;

export class GenerationRegistry {
  private readonly gens = new Map<string, Generation>();
  private readonly now: () => number;
  private readonly keepMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(
    private readonly db: Database.Database,
    deps: GenerationDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.keepMs = deps.keepMs ?? 60_000;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  }

  get(messageId: string): Generation | undefined {
    return this.gens.get(messageId);
  }

  isRunning(messageId: string): boolean {
    const g = this.gens.get(messageId);
    return Boolean(g && !g.done);
  }

  start(meta: { messageId: string; conversationId: string; userKey: string }, ac: AbortController): Generation {
    const cur = this.gens.get(meta.messageId);
    if (cur && !cur.done) throw new GenerationBusyError('這則回答還在產生中');
    const g: Generation = {
      ...meta,
      frames: [],
      bytes: 0,
      done: false,
      finish: null,
      error: null,
      startedAt: this.now(),
      firstTokenAt: null,
      endedAt: null,
      detached: false,
      ac,
      listeners: new Set(),
      acc: { content: '', reasoning: '', sources: [], keywords: [], tools: [], usage: null },
    };
    this.gens.set(meta.messageId, g);
    return g;
  }

  /** One SSE line (`data: …\n\n`) as written to the browser: stored, accumulated, fanned out. */
  push(messageId: string, line: string): void {
    const g = this.gens.get(messageId);
    if (!g || g.done) return;
    if (/^data: \[DONE\]\s*$/.test(line.trim())) return; // finish() writes the terminator itself
    if (g.bytes + line.length <= MAX_BYTES) {
      g.frames.push(line);
      g.bytes += line.length;
    }
    this.accumulate(g, line);
    for (const l of g.listeners) {
      try {
        l(line);
      } catch {
        g.listeners.delete(l);
      }
    }
  }

  private accumulate(g: Generation, line: string): void {
    for (const raw of line.split('\n')) {
      if (!raw.startsWith('data:')) continue;
      const data = raw.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const k = j.loop_knowledge as { sources?: unknown[]; keywords?: string[] } | undefined;
      if (k) {
        g.acc.sources = Array.isArray(k.sources) ? k.sources : [];
        g.acc.keywords = Array.isArray(k.keywords) ? k.keywords : [];
        continue;
      }
      const t = j.loop_tool as { round?: number } | undefined;
      if (t) {
        if (t.round) g.acc.tools.push(t);
        continue;
      }
      const u = j.usage as GenUsage | undefined;
      if (u && typeof u.completion_tokens === 'number') g.acc.usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens };
      const ch = (j.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> | undefined)?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      const rs = (d.reasoning ?? d.reasoning_content) as string | undefined;
      const ct = d.content as string | undefined;
      if ((rs || ct) && g.firstTokenAt == null) g.firstTokenAt = this.now();
      if (rs) g.acc.reasoning += rs;
      if (ct) g.acc.content += ct;
      if (ch.finish_reason) g.finish = ch.finish_reason;
    }
  }

  /** Replay everything so far, then live lines until done. Returns the detach function. */
  attach(messageId: string, listener: (line: string) => void): (() => void) | null {
    const g = this.gens.get(messageId);
    if (!g) return null;
    for (const f of g.frames) listener(f);
    if (g.done) return () => {};
    g.listeners.add(listener);
    return () => g.listeners.delete(listener);
  }

  /** Mark the end and write the answer to its row — the server is the final owner of the text. */
  finish(messageId: string, finish: string | null, error: string | null = null): Generation | undefined {
    const g = this.gens.get(messageId);
    if (!g || g.done) return g;
    g.done = true;
    g.endedAt = this.now();
    g.finish = finish ?? g.finish ?? (error ? 'error' : 'stop');
    g.error = error;
    try {
      updateMessage(this.db, g.messageId, g.userKey, {
        role: 'assistant',
        content: g.acc.content,
        reasoning: g.acc.reasoning || null,
        sources: g.acc.sources,
        keywords: g.acc.keywords,
        tools: g.acc.tools,
        finish_reason: g.finish,
        ttft_ms: g.firstTokenAt != null ? Math.round(g.firstTokenAt - g.startedAt) : null,
        duration_ms: Math.round(g.endedAt - g.startedAt),
        tokens_in: g.acc.usage?.prompt_tokens ?? null,
        tokens_out: g.acc.usage?.completion_tokens ?? null,
      });
    } catch {
      /* the row may have been deleted (重答 / 刪除對話) — nothing to persist to */
    }
    const tail = error ? `data: ${JSON.stringify({ loop_gen: { error } })}\n\n` : '';
    const end = `${tail}data: [DONE]\n\n`;
    for (const l of g.listeners) {
      try {
        l(end);
      } catch {
        /* gone */
      }
    }
    g.listeners.clear();
    this.setTimer(() => {
      if (this.gens.get(messageId) === g) this.gens.delete(messageId);
    }, this.keepMs);
    return g;
  }

  /** 停止: abort upstream; finish() follows from the route's stream loop ending. */
  abort(messageId: string): boolean {
    const g = this.gens.get(messageId);
    if (!g || g.done) return false;
    g.finish = 'abort';
    g.ac.abort();
    return true;
  }

  /** Test seam / shutdown. */
  clear(): void {
    for (const g of this.gens.values()) g.ac.abort();
    this.gens.clear();
  }
}

let singleton: GenerationRegistry | null = null;
export function getGenerationRegistry(db: Database.Database, deps?: GenerationDeps): GenerationRegistry {
  if (!singleton || (singleton as unknown as { db: Database.Database }).db !== db) singleton = new GenerationRegistry(db, deps);
  return singleton;
}
