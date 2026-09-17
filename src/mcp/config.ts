import path from 'node:path';
import type Database from 'better-sqlite3';
import { ENGINE_REPO_ROOT } from '../config.js';
import { allowedRoots } from '../prd/repo.js';

/**
 * MCP servers, in opencode's own config shape so one setting (mcp_servers_json) feeds both the
 * chat page's tool loop (src/mcp/client.ts) and the opencode adapter that runs tasks
 * (src/orchestrator/adapters/opencode.ts). v1 is stdio-only: every server is a local process
 * whose runtime secrets (Loop API token, filesystem roots) are injected at spawn time and never
 * stored in the setting.
 */

export interface McpServerCfg {
  name: string;
  type: 'local';
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  enabled: boolean;
  timeout?: number;
}

const NAME_RE = /^[a-z0-9_-]+$/;

export class McpConfigError extends Error {}

/** Parse + validate the setting; '' means no servers. Throws McpConfigError with a settable message. */
export function parseMcpServers(json: string): McpServerCfg[] {
  const raw = (json ?? '').trim();
  if (!raw) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new McpConfigError('mcp_servers_json must be a JSON object');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new McpConfigError('mcp_servers_json must be a JSON object of servers');
  const out: McpServerCfg[] = [];
  for (const [name, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) throw new McpConfigError(`server name "${name}" must match ${NAME_RE}`);
    const s = (v ?? {}) as Record<string, unknown>;
    if (s.type !== 'local') throw new McpConfigError(`server "${name}": only type "local" is supported`);
    if (!Array.isArray(s.command) || !s.command.length || !s.command.every((c) => typeof c === 'string' && c.length)) {
      throw new McpConfigError(`server "${name}": command must be a non-empty string array`);
    }
    if (s.environment !== undefined && (typeof s.environment !== 'object' || s.environment === null || Array.isArray(s.environment))) {
      throw new McpConfigError(`server "${name}": environment must be an object`);
    }
    out.push({
      name,
      type: 'local',
      command: s.command as string[],
      ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}),
      ...(s.environment ? { environment: Object.fromEntries(Object.entries(s.environment as Record<string, unknown>).map(([k, val]) => [k, String(val)])) } : {}),
      enabled: s.enabled !== false,
      ...(typeof s.timeout === 'number' ? { timeout: s.timeout } : {}),
    });
  }
  return out;
}

/** The three servers this repo ships (mcp/), keyed by the names the docs use. */
export function defaultServersJson(repoRoot: string = ENGINE_REPO_ROOT): string {
  const mcp = (file: string) => ['node', path.join(repoRoot, 'mcp', file)];
  return JSON.stringify(
    {
      'loop-fs': { type: 'local', command: mcp('loop-fs-mcp.mjs'), enabled: true },
      loop: { type: 'local', command: mcp('loop-mcp.mjs'), enabled: true },
      gh: { type: 'local', command: mcp('loop-gh-mcp.mjs'), enabled: true },
    },
    null,
    0,
  );
}

export interface RuntimeEnvOptions {
  apiUrl: string;
  /** the bearer, or '' when the API is open — only ever passed through the environment */
  apiToken: string;
  dataDir?: string;
}

/**
 * Environment a server gets at spawn time, on top of whatever the setting declares. Read-only
 * by construction: the fs server sees the same roots the PRD wizard may read, the gh server is
 * not given LOOP_GH_ALLOW_WRITE.
 */
export function runtimeEnvFor(name: string, db: Database.Database, o: RuntimeEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  if (name === 'loop-fs' || name.endsWith('-fs')) env.LOOP_FS_ROOTS = allowedRoots(db).join(',');
  if (name === 'loop') {
    env.LOOP_API_URL = o.apiUrl;
    if (o.apiToken) env.LOOP_API_TOKEN = o.apiToken;
    if (o.dataDir) env.LOOP_DATA_DIR = o.dataDir;
  }
  return env;
}
