#!/usr/bin/env node
// GPU 執行沙盒 MCP server for Loop task runs.
//
// One tool, `run`: execute a bash command in the engine's Docker sandbox (GPU, no network) with
// this run's worktree mounted at /work. The engine does all the sandboxing (src/exec/sandbox.ts);
// this process only forwards the call to POST /api/exec/run together with the run id it was
// started for. The engine resolves the worktree from its own records, so the agent cannot point
// the sandbox anywhere else. Started per task run by the engine (src/orchestrator/taskMcp.ts).
//
//   LOOP_API_URL / LOOP_API_TOKEN   the engine API (same resolution as loop-mcp.mjs)
//   LOOP_EXEC_RUN_ID                the task run this server belongs to (required)
//   LOOP_EXEC_TIMEOUT_SEC           default per-run timeout, shown in the tool description
//   LOOP_EXEC_MAX_TIMEOUT_SEC       the most a call may ask for
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';
import https from 'node:https';
import { readEnvFile, BASE } from './lib.mjs';

const ENVF = readEnvFile();
const TOKEN = process.env.LOOP_API_TOKEN || ENVF.LOOP_API_TOKEN || '';
const RUN_ID = (process.env.LOOP_EXEC_RUN_ID || '').trim();
const DEFAULT_SEC = Number(process.env.LOOP_EXEC_TIMEOUT_SEC) || 120;
const MAX_SEC = Number(process.env.LOOP_EXEC_MAX_TIMEOUT_SEC) || 900;

/**
 * POST without a client-side timeout: the engine enforces the run's own timeout (and kills the
 * container), and a build can legitimately take longer than fetch's 5-minute header timeout.
 */
function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + pathname);
    const payload = JSON.stringify(body);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { error: text.slice(0, 300) };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', (e) => reject(new Error(`cannot reach Loop API at ${BASE} (${e.message})`)));
    req.end(payload);
  });
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

const server = new McpServer({ name: 'loop-exec', version: '1.0.0' });

server.registerTool(
  'run',
  {
    title: 'Run a command in the GPU sandbox',
    description:
      `在 GPU 沙盒（Docker 容器，有 GPU、沒有網路）裡用 bash 執行一行指令；這個任務的 worktree 掛在 /work，是指令的工作目錄。` +
      `用來編譯、執行、跑測試或量測（例如 "nvcc -O3 -o build/x x.cu && ./build/x"、"ncu --section SpeedOfLight ./build/x"）。` +
      `回傳 exit code 與輸出。預設 ${DEFAULT_SEC} 秒逾時，可用 timeout_sec 加長（上限 ${MAX_SEC} 秒）。` +
      `非 0 的 exit code 是程式的結果，不是工具壞了。`,
    inputSchema: {
      command: z.string().min(1).describe('在 /work 裡執行的 bash 指令'),
      timeout_sec: z.number().int().min(1).max(MAX_SEC).optional().describe(`逾時秒數（預設 ${DEFAULT_SEC}）`),
    },
  },
  async ({ command, timeout_sec }) => {
    if (!RUN_ID) return fail('loop-exec：沒有 LOOP_EXEC_RUN_ID（這個 server 只給 Loop 派出的任務使用）');
    try {
      const { status, json } = await postJson('/api/exec/run', { run_id: RUN_ID, command, timeout_sec });
      if (status !== 200) return fail(`沙盒無法執行（HTTP ${status}）：${json.error ?? JSON.stringify(json).slice(0, 300)}`);
      const out = typeof json.text === 'string' ? json.text : JSON.stringify(json).slice(0, 4000);
      return json.infra ? fail(out) : text(out);
    } catch (e) {
      return fail(`沙盒呼叫失敗：${String(e.message || e).slice(0, 300)}`);
    }
  },
);

await server.connect(new StdioServerTransport());
