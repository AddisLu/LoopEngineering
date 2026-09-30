import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createTask, getTask } from '../tasks.js';
import { mcpServersForTask } from '../orchestrator/run.js';
import { getOpsRunner } from '../chatops/execute.js';
import { OPS_READ_TOOLS, OPS_TOOL_NAMES } from '../chatops/tools.js';
import { ENGINE_REPO_ROOT } from '../config.js';

// mcp/loop-ops-mcp.mjs holds no logic: the engine's tool list, the engine's rules, its own identity.
let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(async () => {
  await getOpsRunner().idle();
  db.close();
});

type CallResult = { content: Array<{ text: string }>; isError?: boolean };
const sdkResolvable = [path.join(ENGINE_REPO_ROOT, 'mcp', 'node_modules', '@modelcontextprotocol'), path.join(ENGINE_REPO_ROOT, 'node_modules', '@modelcontextprotocol')].some((p) => fs.existsSync(p));

describe.skipIf(!sdkResolvable)('mcp/loop-ops-mcp.mjs over stdio → engine API', () => {
  it('lists what the engine offers, forwards calls as its own identity, and needs the code to run anything', async () => {
    setSetting(db, 'ops_chat_enabled', 'true');
    const usage = () => ({ session: { percent: 12, resetsAt: null }, weekly: { percent: 30, resetsAt: null }, source: 'cache' as const, error: null });
    const app = buildApp({ db, apiToken: 'T0KEN', mcpPool: null, opsDeps: { exec: { waitMs: 3000 }, view: { usage: usage as never }, prep: { usage: usage as never } } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-ops-mcp.mjs')],
      env: { ...process.env, LOOP_API_URL: `http://127.0.0.1:${port}`, LOOP_API_TOKEN: 'T0KEN', LOOP_OPS_USER: '測試工具' } as Record<string, string>,
      stderr: 'ignore',
    });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...OPS_READ_TOOLS]);
      const t = createTask(db, { title: '修登入', goal: 'a goal long enough', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true'], complexity: 'S' });
      const found = (await client.callTool({ name: 'ops_find', arguments: { q: '修登入' } })) as CallResult;
      expect(found.isError).toBeFalsy();
      expect(found.content[0]!.text).toContain(t.id);
      const refused = (await client.callTool({ name: 'ops_prepare_action', arguments: { action: 'queue', target: t.id } })) as CallResult;
      expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('ops_external_enabled') }] });

      setSetting(db, 'ops_external_enabled', 'true');
      // the forwarder runs on this machine: its connection is `local`, which must be listed too
      expect((await client.listTools()).tools.map((x) => x.name)).toEqual([...OPS_READ_TOOLS]);
      setSetting(db, 'ops_allowed_users', 'local');
      expect((await client.listTools()).tools.map((x) => x.name)).toEqual([...OPS_TOOL_NAMES]);
      const p = (await client.callTool({ name: 'ops_prepare_action', arguments: { action: 'queue', target: t.id } })) as CallResult;
      const code = /動作 ([A-Z0-9]{3})：pending/.exec(p.content[0]!.text)?.[1];
      expect(code).toBeTruthy();
      expect(getTask(db, t.id)!.status).toBe('draft');
      const r = (await client.callTool({ name: 'ops_confirm', arguments: { code } })) as CallResult;
      expect(r.isError).toBeFalsy();
      expect(r.content[0]!.text).toContain('已完成');
      expect(getTask(db, t.id)!.status).toBe('queued');
      expect(db.prepare('SELECT user_key, user_label FROM ops_actions').get()).toEqual({ user_key: 'ext:測試工具', user_label: '測試工具（外部工具）' });
    } finally {
      await client.close();
      await app.close();
    }
  }, 30_000);
});

describe('a task run never gets loop-ops', () => {
  it('by name or by script, whatever mcp_servers_json says', () => {
    const script = path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-ops-mcp.mjs');
    setSetting(
      db,
      'mcp_servers_json',
      JSON.stringify({
        'loop-ops': { type: 'local', command: ['node', script], enabled: true },
        ops: { type: 'local', command: ['node', script], enabled: true },
        'loop-fs': { type: 'local', command: ['node', path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-fs-mcp.mjs')], enabled: true },
      }),
    );
    expect(mcpServersForTask(db).map((s) => s.name)).toEqual(['loop-fs']);
  });
});
