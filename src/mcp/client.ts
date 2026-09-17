import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerCfg } from './config.js';

/**
 * A lazy pool of MCP clients for the chat page. Servers start on first use, tool lists are
 * cached for a minute (failures too, so a broken server does not stall every question), and a
 * crashed server is respawned a bounded number of times. `transportFactory` is the test seam:
 * the suite wires an in-memory server instead of spawning anything.
 */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerTools {
  server: string;
  tools: McpToolInfo[];
  error: string | null;
}

export interface McpPoolOptions {
  cfgs: () => McpServerCfg[];
  env: (name: string) => Record<string, string>;
  timeoutMs: () => number;
  now?: () => number;
  log?: (msg: string) => void;
  transportFactory?: (cfg: McpServerCfg, env: Record<string, string>) => Transport;
  /** cache lifetime for tool lists and for a failed start */
  cacheMs?: number;
}

interface Entry {
  key: string;
  client: Client | null;
  connecting: Promise<Client> | null;
  tools: McpToolInfo[] | null;
  error: string | null;
  listedAt: number;
  restarts: number[];
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

function defaultTransport(cfg: McpServerCfg, env: Record<string, string>): Transport {
  const [command, ...args] = cfg.command;
  // PATH and HOME come from the engine; everything secret comes from `env`, never from the setting
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'NODE_OPTIONS']) if (process.env[k]) base[k] = process.env[k]!;
  return new StdioClientTransport({ command: command!, args, cwd: cfg.cwd, env: { ...base, ...(cfg.environment ?? {}), ...env }, stderr: 'ignore' });
}

export class McpPool {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly cacheMs: number;

  constructor(private readonly o: McpPoolOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.cacheMs = o.cacheMs ?? 60_000;
  }

  private entryFor(cfg: McpServerCfg): Entry {
    const key = JSON.stringify(cfg);
    let e = this.entries.get(cfg.name);
    if (!e || e.key !== key) {
      if (e) void e.client?.close().catch(() => {});
      e = { key, client: null, connecting: null, tools: null, error: null, listedAt: 0, restarts: [] };
      this.entries.set(cfg.name, e);
    }
    return e;
  }

  private async connect(cfg: McpServerCfg, e: Entry): Promise<Client> {
    if (e.client) return e.client;
    if (e.connecting) return e.connecting;
    const recent = e.restarts.filter((t) => this.now() - t < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS) throw new Error(`MCP server ${cfg.name} 十分鐘內已重啟 ${MAX_RESTARTS} 次，暫停使用`);
    e.restarts = [...recent, this.now()];
    e.connecting = (async () => {
      const transport = (this.o.transportFactory ?? defaultTransport)(cfg, this.o.env(cfg.name));
      const client = new Client({ name: 'loop-engineering-chat', version: '1.0.0' });
      transport.onclose = () => {
        if (e.client === client) {
          e.client = null;
          e.tools = null;
          this.log(`mcp ${cfg.name}: transport closed`);
        }
      };
      await client.connect(transport);
      e.client = client;
      e.connecting = null;
      this.log(`mcp ${cfg.name}: connected`);
      return client;
    })();
    try {
      return await e.connecting;
    } catch (err) {
      e.connecting = null;
      throw err;
    }
  }

  /** Tool lists for every enabled server; a server that cannot start reports `error` instead of throwing. */
  async listTools(): Promise<McpServerTools[]> {
    const out: McpServerTools[] = [];
    for (const cfg of this.o.cfgs()) {
      if (!cfg.enabled) continue;
      const e = this.entryFor(cfg);
      const fresh = this.now() - e.listedAt < this.cacheMs;
      if (fresh && (e.tools || e.error)) {
        out.push({ server: cfg.name, tools: e.tools ?? [], error: e.error });
        continue;
      }
      try {
        const client = await this.connect(cfg, e);
        const res = await withTimeout(client.listTools(), this.o.timeoutMs(), `mcp ${cfg.name} listTools`);
        e.tools = res.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' } }));
        e.error = null;
      } catch (err) {
        e.tools = null;
        e.error = describeStartError(cfg, err);
        this.log(`mcp ${cfg.name}: ${e.error}`);
      }
      e.listedAt = this.now();
      out.push({ server: cfg.name, tools: e.tools ?? [], error: e.error });
    }
    return out;
  }

  async callTool(server: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const cfg = this.o.cfgs().find((c) => c.name === server && c.enabled);
    if (!cfg) throw new Error(`MCP server ${server} 不存在或已停用`);
    const e = this.entryFor(cfg);
    const client = await this.connect(cfg, e);
    const res = (await withTimeout(client.callTool({ name, arguments: args }, undefined, { signal }), this.o.timeoutMs(), `mcp ${server}.${name}`)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
      .join('\n')
      .trim();
    return { text, isError: Boolean(res.isError) };
  }

  async close(): Promise<void> {
    for (const e of this.entries.values()) {
      try {
        await e.client?.close();
      } catch {
        /* closing */
      }
      e.client = null;
    }
    this.entries.clear();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} 逾時（${ms} ms）`)), ms);
    }),
  ]);
}

function describeStartError(cfg: McpServerCfg, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found|Cannot find module|ERR_MODULE_NOT_FOUND|Connection closed/i.test(msg)) {
    return `MCP server ${cfg.name} 起不來（${cfg.command[0]} …）：${msg.slice(0, 120)} — 若是 repo 內建的 server，先執行 npm --prefix mcp ci`;
  }
  return `MCP server ${cfg.name}：${msg.slice(0, 200)}`;
}
