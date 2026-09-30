#!/usr/bin/env node
// 對話操作 for tools like Claude Code in VS Code: the operations the chat page's local model has —
// look up tasks, benchmarks and repos; prepare new work, a benchmark, an action on a task or a
// model, a git clone/pull/push/merge; then confirm or cancel it — as MCP tools.
//
// This process holds no logic. The tool list comes from GET /api/ops/tools and every call goes to
// POST /api/ops/tools/:name, where the engine applies the same templates, checks and confirmation
// rules as the chat page: nothing runs until a prepared action is confirmed with its code, and the
// engine only allows preparing at all when ops_external_enabled is on (read-only otherwise).
//
// Not for coding agents: the engine never hands this server to a task run (src/orchestrator/run.ts).
// Add it to your own MCP client config, e.g. Claude Code:
//   claude mcp add loop-ops -- node /path/to/LoopEngineering/mcp/loop-ops-mcp.mjs
//
//   LOOP_API_URL / LOOP_API_TOKEN   the engine API (same resolution as loop-mcp.mjs)
//   LOOP_OPS_USER                   the name recorded on every action (default 外部工具)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readEnvFile, BASE } from './lib.mjs';

const ENVF = readEnvFile();
const TOKEN = process.env.LOOP_API_TOKEN || ENVF.LOOP_API_TOKEN || '';
const USER = (process.env.LOOP_OPS_USER || '外部工具').trim().slice(0, 40);

/** One engine call; the engine's own error message comes back as-is. */
async function engine(method, pathname, body) {
  let res;
  try {
    res = await fetch(BASE + pathname, {
      method,
      headers: {
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        // headers are latin1: the name travels percent-encoded (opsRoutes decodes it)
        'x-loop-ops-user': encodeURIComponent(USER),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // preparing new work asks the local model to review the PRD; a clone may take minutes
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch (e) {
    throw new Error(`cannot reach Loop API at ${BASE} (${e.message}). Is the service running?`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

const server = new Server({ name: 'loop-ops', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { status, json } = await engine('GET', '/api/ops/tools');
  if (status !== 200) throw new Error(`Loop 對話操作無法使用（HTTP ${status}）：${json.error ?? JSON.stringify(json).slice(0, 200)}`);
  return { tools: json.tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const { status, json } = await engine('POST', `/api/ops/tools/${encodeURIComponent(name)}`, args ?? {});
    if (status !== 200) return { content: [{ type: 'text', text: `HTTP ${status}：${json.error ?? JSON.stringify(json).slice(0, 300)}` }], isError: true };
    const act = json.action ? `\n\n（動作 ${json.action.code}：${json.action.status}${json.action.risk === 'high' ? '，高風險' : ''}）` : '';
    return { content: [{ type: 'text', text: `${json.text ?? ''}${act}` }], isError: json.ok === false };
  } catch (e) {
    return { content: [{ type: 'text', text: `呼叫失敗：${String(e.message || e).slice(0, 300)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
