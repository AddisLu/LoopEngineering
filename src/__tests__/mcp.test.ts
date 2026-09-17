import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openTestDb, setSetting } from '../db/index.js';
import { McpConfigError, parseMcpServers, runtimeEnvFor, type McpServerCfg } from '../mcp/config.js';
import { McpPool } from '../mcp/client.js';
import { mcpTools, mcpToolName } from '../chat/tools.js';
import { validateSetting } from '../settings.js';
import { DEFAULT_SETTINGS } from '../config.js';
import { buildOpencodeConfig } from '../orchestrator/adapters/opencode.js';
import { getLocalModel } from '../local/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

describe('mcp config', () => {
  it('parses the opencode shape, rejects bad names / remote servers, and validates through settings', () => {
    const cfgs = parseMcpServers('{"loop-fs":{"type":"local","command":["node","x.mjs"],"enabled":true},"gh":{"type":"local","command":["node","g.mjs"],"enabled":false,"cwd":"/tmp","environment":{"A":1}}}');
    expect(cfgs).toEqual([
      { name: 'loop-fs', type: 'local', command: ['node', 'x.mjs'], enabled: true },
      { name: 'gh', type: 'local', command: ['node', 'g.mjs'], enabled: false, cwd: '/tmp', environment: { A: '1' } },
    ]);
    expect(parseMcpServers('')).toEqual([]);
    expect(() => parseMcpServers('nope')).toThrow(McpConfigError);
    expect(() => parseMcpServers('{"Bad Name":{"type":"local","command":["x"]}}')).toThrow(/server name/);
    expect(() => parseMcpServers('{"r":{"type":"remote","url":"http://x"}}')).toThrow(/local/);
    expect(() => parseMcpServers('{"r":{"type":"local","command":[]}}')).toThrow(/command/);
    expect(validateSetting('mcp_servers_json', '{"r":{"type":"remote","url":"x"}}')).toMatch(/local/);
    expect(validateSetting('mcp_servers_json', DEFAULT_SETTINGS.mcp_servers_json!)).toBeNull();
    // the seeded default points at the three servers shipped in mcp/
    expect(parseMcpServers(DEFAULT_SETTINGS.mcp_servers_json!).map((c) => c.name)).toEqual(['loop-fs', 'loop', 'gh']);
  });

  it('injects runtime env per server: fs roots from the allowlist, the API token only for loop', () => {
    const db = openTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-root-'));
    setSetting(db, 'prd_repo_allowlist', root);
    expect(runtimeEnvFor('loop-fs', db, { apiUrl: 'http://127.0.0.1:4711', apiToken: 'tok' })).toEqual({ LOOP_FS_ROOTS: fs.realpathSync(root) });
    expect(runtimeEnvFor('loop', db, { apiUrl: 'http://127.0.0.1:4711', apiToken: 'tok', dataDir: '/d' })).toEqual({ LOOP_API_URL: 'http://127.0.0.1:4711', LOOP_API_TOKEN: 'tok', LOOP_DATA_DIR: '/d' });
    expect(runtimeEnvFor('gh', db, { apiUrl: 'x', apiToken: 'tok' })).toEqual({}); // never LOOP_GH_ALLOW_WRITE
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/** An in-process MCP server with one echo tool, wired through InMemoryTransport — no spawn. */
function echoServer(opts: { fail?: boolean } = {}) {
  const server = new Server({ name: 'echo', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const q = String((req.params.arguments as { q?: string })?.q ?? '');
    if (opts.fail) return { content: [{ type: 'text', text: `boom ${q}` }], isError: true };
    return { content: [{ type: 'text', text: `echo:${q}` }] };
  });
  return server;
}

describe('McpPool', () => {
  const cfg: McpServerCfg = { name: 'loop-fs', type: 'local', command: ['node', 'fake'], enabled: true };
  let starts = 0;
  let t = 0;
  const pool = (extra: Partial<ConstructorParameters<typeof McpPool>[0]> = {}, serverOpts: { fail?: boolean } = {}) =>
    new McpPool({
      cfgs: () => [cfg],
      env: () => ({}),
      timeoutMs: () => 2000,
      now: () => t,
      transportFactory: () => {
        starts += 1;
        const [c, s] = InMemoryTransport.createLinkedPair();
        void echoServer(serverOpts).connect(s);
        return c;
      },
      ...extra,
    });
  beforeEach(() => {
    starts = 0;
    t = 1_000_000;
  });

  it('lists tools once per cache window, calls them, and maps names for vLLM', async () => {
    const p = pool();
    const list = await p.listTools();
    expect(list).toEqual([{ server: 'loop-fs', tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }], error: null }]);
    await p.listTools();
    expect(starts).toBe(1);
    t += 61_000;
    await p.listTools();
    expect(starts).toBe(1); // still connected: only the list is refreshed, not the process
    expect(await p.callTool('loop-fs', 'echo', { q: 'hi' })).toEqual({ text: 'echo:hi', isError: false });
    await expect(p.callTool('nope', 'echo', {})).rejects.toThrow(/不存在/);

    const { tools, skipped } = await mcpTools(p, 16_000);
    expect(skipped).toEqual([]);
    expect(tools.map((x) => x.name)).toEqual(['mcp__loop_fs__echo']);
    expect(mcpToolName('loop-fs', 'read-file')).toBe('mcp__loop_fs__read_file');
    const r = await tools[0]!.run({ q: 'yo' }, { db: null as never, fetch, signal: new AbortController().signal });
    expect(r).toMatchObject({ ok: true, text: 'echo:yo' });
    await p.close();
  });

  it('reports a server that cannot start instead of throwing, and skips servers past the schema budget', async () => {
    const broken = new McpPool({
      cfgs: () => [cfg],
      env: () => ({}),
      timeoutMs: () => 500,
      now: () => t,
      transportFactory: () => {
        throw new Error('spawn node ENOENT');
      },
    });
    const list = await broken.listTools();
    expect(list[0]!.error).toContain('起不來');
    expect(list[0]!.error).toContain('npm --prefix mcp ci');
    const { tools, skipped } = await mcpTools(broken, 16_000);
    expect(tools).toEqual([]);
    expect(skipped[0]!.reason).toContain('起不來');

    const p = pool();
    const tight = await mcpTools(p, 10);
    expect(tight.tools).toEqual([]);
    expect(tight.skipped[0]!.reason).toContain('預算');
    // an isError result becomes a failed tool call, not an exception
    const failing = pool({}, { fail: true });
    const { tools: ft } = await mcpTools(failing, 16_000);
    expect(await ft[0]!.run({ q: 'x' }, { db: null as never, fetch, signal: new AbortController().signal })).toMatchObject({ ok: false, text: 'boom x' });
    await p.close();
    await failing.close();
  });
});

describe('opencode config carries the MCP servers', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());
  it('adds an mcp block (enabled servers only) and keeps the permission block', () => {
    const cfgs: McpServerCfg[] = [
      { name: 'loop-fs', type: 'local', command: ['node', '/r/mcp/loop-fs-mcp.mjs'], enabled: true, environment: { LOOP_FS_ROOTS: '/a' } },
      { name: 'gh', type: 'local', command: ['node', 'g'], enabled: false },
    ];
    const cfg = JSON.parse(buildOpencodeConfig(getLocalModel(db, 'qwen38-flash')!, 'http://spark:8000/v1', cfgs));
    expect(cfg.mcp).toEqual({ 'loop-fs': { type: 'local', command: ['node', '/r/mcp/loop-fs-mcp.mjs'], environment: { LOOP_FS_ROOTS: '/a' }, enabled: true } });
    expect(cfg.permission.webfetch).toBe('deny');
    expect(JSON.parse(buildOpencodeConfig(getLocalModel(db, 'qwen38-flash')!)).mcp).toBeUndefined();
  });
});

const fsServerInstalled = fs.existsSync(path.join(REPO, 'mcp', 'node_modules', '@modelcontextprotocol'));
describe.skipIf(!fsServerInstalled)('loop-fs-mcp.mjs over stdio', () => {
  it('lists, reads and searches inside the roots and refuses to escape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fs-'));
    fs.mkdirSync(path.join(root, 'ip', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ip', 'src', 'rules.cpp'), 'int threshold = 42;\nvoid detect() {}\n');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fs-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.symlinkSync(outside, path.join(root, 'link'));
    const transport = new StdioClientTransport({ command: 'node', args: [path.join(REPO, 'mcp', 'loop-fs-mcp.mjs')], env: { ...process.env, LOOP_FS_ROOTS: root } as Record<string, string>, stderr: 'ignore' });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(transport);
    try {
      const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      const top = await call('list_dir', { path: '.', depth: 2 });
      expect(top.content[0]!.text).toContain('ip/src/'); // depth counts directory levels below the start
      const ls = await call('list_dir', { path: 'ip', depth: 2 });
      expect(ls.content[0]!.text).toContain('src/rules.cpp');
      const rd = await call('read_file', { path: 'ip/src/rules.cpp' });
      expect(rd.content[0]!.text).toContain('1| int threshold = 42;');
      expect((await call('read_file', { path: 'bin.dat' })).isError).toBe(true);
      expect((await call('read_file', { path: '../../etc/passwd' })).isError).toBe(true);
      expect((await call('read_file', { path: 'link/secret.txt' })).isError).toBe(true); // symlink out of the root
      expect((await call('read_file', { path: '/etc/passwd' })).isError).toBe(true);
      const hits = await call('search_text', { query: 'threshold', glob: '*.cpp' });
      expect(hits.content[0]!.text).toContain('ip/src/rules.cpp:1:');
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 20_000);
});
