import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildTaskMcpConfig, cleanupTaskMcp, writeTaskMcp, TASK_MCP_TOOLS } from '../orchestrator/taskMcp.js';
import { buildClaudeArgs } from '../orchestrator/adapters/claudeCode.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import { createTask, getTask } from '../tasks.js';
import type { McpServerCfg } from '../mcp/config.js';
import type { DispatchContext } from '../orchestrator/adapters/types.js';

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
const dir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-tmcp-${tag}-`));
  tmp.push(d);
  return d;
};
const servers: McpServerCfg[] = [
  { name: 'loop', type: 'local', command: ['node', '/repo/mcp/loop-mcp.mjs'], enabled: true, environment: { LOOP_API_URL: 'http://127.0.0.1:4711' } },
  { name: 'loop-fs', type: 'local', command: ['node', '/repo/mcp/loop-fs-mcp.mjs'], enabled: true, environment: { LOOP_FS_ROOTS: '/repo' } },
  { name: 'gh', type: 'local', command: ['node', '/repo/mcp/loop-gh-mcp.mjs'], enabled: true },
  { name: 'loop-off', type: 'local', command: ['node', '/x.mjs'], enabled: false },
] as never;

describe('task MCP: a running task can ask the knowledge base', () => {
  it('ships only the read-only servers, never gh or a disabled one', () => {
    const cfg = buildTaskMcpConfig(servers)!;
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['loop', 'loop-fs']);
    expect(cfg.mcpServers.loop).toMatchObject({ command: 'node', args: ['/repo/mcp/loop-mcp.mjs'] });
    expect((cfg.mcpServers.loop as { env: Record<string, string> }).env.LOOP_API_URL).toBe('http://127.0.0.1:4711');
    expect(buildTaskMcpConfig([])).toBeNull();
  });

  it('writes the config outside the worktree, and not at all when the feature is off', () => {
    const d = dir('cfg');
    const mcp = writeTaskMcp(db, 'r_1', servers, d)!;
    expect(mcp.configPath.startsWith(d)).toBe(true); // never inside the checkout: git add -A must not see it
    expect(JSON.parse(fs.readFileSync(mcp.configPath, 'utf8')).mcpServers.loop).toBeTruthy();
    expect(mcp.tools).toContain('mcp__loop__loop_recall');
    expect(mcp.tools).toContain('mcp__loop__loop_search');
    expect(mcp.tools.every((t) => (TASK_MCP_TOOLS as readonly string[]).includes(t))).toBe(true);

    cleanupTaskMcp(mcp);
    expect(fs.existsSync(mcp.configPath)).toBe(false);

    setSetting(db, 'task_mcp_enabled', 'false');
    expect(writeTaskMcp(db, 'r_2', servers, d)).toBeNull();
  });

  it('passes the config to claude with the tools on the allow-list, not as loose args', () => {
    const ctx = { task: {}, run: {}, cwd: '/w', taskFilePath: '/w/LOOP_TASK.md', logPath: '/l', model: 'sonnet', timeoutMs: 1, mcpConfigPath: '/data/mcp/r_1.json', mcpTools: ['mcp__loop__loop_recall'] } as never as DispatchContext;
    const args = buildClaudeArgs(ctx);
    const allowedAt = args.indexOf('--allowed-tools');
    const mcpAt = args.indexOf('--mcp-config');
    expect(allowedAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(allowedAt); // the tool name must sit inside --allowed-tools' values
    expect(args.slice(allowedAt + 1, mcpAt)).toContain('mcp__loop__loop_recall');
    expect(args[mcpAt + 1]).toBe('/data/mcp/r_1.json');
    expect(args).toContain('--strict-mcp-config'); // the user's own servers stay out of a task run

    const without = buildClaudeArgs({ ...ctx, mcpConfigPath: null } as never as DispatchContext);
    expect(without).not.toContain('--mcp-config');
    expect(without.join(' ')).not.toContain('mcp__loop__');
  });

  it('tells the agent when to ask, and says nothing when it cannot', () => {
    const w = dir('wt');
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', verification_steps: ['true'] }).id)!;
    const withTools = fs.readFileSync(writeTaskFile(w, task, { mcpServers: ['loop', 'loop-fs'] }), 'utf8');
    expect(withTools).toContain('## 查知識庫');
    expect(withTools).toContain('loop_recall');
    expect(withTools).toContain('loop_search');
    // zero-impact when the tools are not there: byte-identical to before the feature
    const plain = fs.readFileSync(writeTaskFile(w, task, {}), 'utf8');
    expect(plain).not.toContain('查知識庫');
    expect(plain).toBe(fs.readFileSync(writeTaskFile(w, task, { mcpServers: [] }), 'utf8'));
  });
});
