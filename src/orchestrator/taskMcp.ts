import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool } from '../db/index.js';
import { ENGINE_REPO_ROOT, paths } from '../config.js';
import type { McpServerCfg } from '../mcp/config.js';
import { sandboxSettings, type SandboxSettings } from '../exec/sandbox.js';

/**
 * 任務執行中查知識庫: the MCP config a dispatched Claude Code run is given.
 *
 * Until this existed, knowledge reached a task exactly once — packed into LOOP_TASK.md at
 * dispatch — so an agent that discovered mid-run that it needed a constraint ("is there a rule
 * about restarting the controller?") had no way to ask. The chat page and the opencode adapter
 * could already call loop_recall/loop_search; this gives the same two tools to the adapter that
 * actually runs the work.
 *
 * Deliberately narrow:
 * - only the read paths (`loop` for recall/search, `loop-fs` for read-only files). The gh
 *   server and anything write-capable stays out; a task changes the world through its own
 *   commits, not through Loop's API.
 * - the file is written OUTSIDE the worktree (data dir, one per run), so `git add -A` can never
 *   sweep it into the task's branch.
 */

/** Servers a task may use, in the order they appear in the generated config. `loop-exec` (the GPU
 * 沙盒) is never in mcp_servers_json: the engine adds it per run when exec_enabled (execServerForTask). */
export const TASK_MCP_SERVERS = ['loop', 'loop-fs', 'loop-exec'] as const;

/** Tools from those servers, as Claude Code's --allowed-tools spells them. */
export const TASK_MCP_TOOLS = [
  'mcp__loop__loop_recall',
  'mcp__loop__loop_search',
  'mcp__loop-fs__list_dir',
  'mcp__loop-fs__read_file',
  'mcp__loop-fs__search_text',
  'mcp__loop-exec__run',
] as const;

export const EXEC_SERVER = 'loop-exec';

/**
 * GPU 執行沙盒 for one task run: mcp/loop-exec-mcp.mjs, told which run it belongs to. It holds no
 * sandbox logic — it forwards to POST /api/exec/run, where the engine resolves the run's worktree
 * itself. null when exec_enabled is off, which leaves every generated config exactly as before.
 */
export function execServerForTask(db: Database.Database, runId: string): McpServerCfg | null {
  const s = sandboxSettings(db);
  if (!s.enabled) return null;
  const token = process.env.LOOP_API_TOKEN ?? '';
  return {
    name: EXEC_SERVER,
    type: 'local',
    command: ['node', path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-exec-mcp.mjs')],
    environment: {
      LOOP_API_URL: `http://127.0.0.1:${process.env.LOOP_PORT || 4711}`,
      ...(token ? { LOOP_API_TOKEN: token } : {}),
      LOOP_EXEC_RUN_ID: runId,
      LOOP_EXEC_TIMEOUT_SEC: String(s.timeoutSec),
      LOOP_EXEC_MAX_TIMEOUT_SEC: String(s.maxTimeoutSec),
    },
    enabled: true,
    // a build may take the full sandbox timeout; opencode reads this per server
    timeout: execToolTimeoutMs(s),
  };
}

/** How long a client should wait for one sandbox tool call: the longest run plus slack. */
export function execToolTimeoutMs(s: Pick<SandboxSettings, 'maxTimeoutSec'>): number {
  return (s.maxTimeoutSec + 120) * 1000;
}

export interface TaskMcp {
  /** absolute path of the generated config, for --mcp-config */
  configPath: string;
  /** tool names to allow so the run never stops on a permission prompt */
  tools: string[];
  /** server names actually included */
  servers: string[];
}

export function taskMcpEnabled(db: Database.Database): boolean {
  return getBool(db, 'task_mcp_enabled', true);
}

/** The `{ mcpServers: {...} }` document Claude Code's --mcp-config expects. */
export function buildTaskMcpConfig(servers: McpServerCfg[]): { mcpServers: Record<string, unknown> } | null {
  const wanted = servers.filter((s) => s.enabled && (TASK_MCP_SERVERS as readonly string[]).includes(s.name));
  if (!wanted.length) return null;
  const mcpServers: Record<string, unknown> = {};
  for (const s of wanted) {
    const [command, ...args] = s.command;
    if (!command) continue;
    mcpServers[s.name] = {
      command,
      args,
      env: { ...(s.environment ?? {}) },
      ...(s.cwd ? { cwd: s.cwd } : {}),
    };
  }
  return Object.keys(mcpServers).length ? { mcpServers } : null;
}

/**
 * Write the per-run config. Returns null when the feature is off, nothing is configured, or the
 * write fails — a task must still run when its optional tools cannot be set up.
 */
export function writeTaskMcp(db: Database.Database, runId: string, servers: McpServerCfg[], dir = path.join(paths.dataDir, 'mcp')): TaskMcp | null {
  if (!taskMcpEnabled(db)) return null;
  const cfg = buildTaskMcpConfig(servers);
  if (!cfg) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, `${runId}.json`);
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const servers = Object.keys(cfg.mcpServers);
    return {
      configPath,
      servers,
      tools: TASK_MCP_TOOLS.filter((t) => servers.some((s) => t.startsWith(`mcp__${s}__`))),
    };
  } catch {
    return null;
  }
}

/** Best-effort cleanup once the run is over — these are throwaway files. */
export function cleanupTaskMcp(mcp: TaskMcp | null): void {
  if (!mcp) return;
  try {
    fs.rmSync(mcp.configPath, { force: true });
  } catch {
    /* it is a temp file in our own data dir; a failure changes nothing */
  }
}
