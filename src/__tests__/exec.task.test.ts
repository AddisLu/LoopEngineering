import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createRun, createTask, finishRun, getTask } from '../tasks.js';
import { buildTaskMcpConfig, execServerForTask, execToolTimeoutMs, writeTaskMcp, TASK_MCP_TOOLS } from '../orchestrator/taskMcp.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import { runVerification, sandboxStepCommand } from '../orchestrator/verify.js';
import { runVerifyPipeline } from '../orchestrator/run.js';
import { claudeCodeAdapter } from '../orchestrator/adapters/claudeCode.js';
import { sandboxSettings, type DockerRunner, type SandboxResult } from '../exec/sandbox.js';
import type { SandboxRun } from '../chat/sandboxTools.js';
import type { DispatchContext } from '../orchestrator/adapters/types.js';
import { ENGINE_REPO_ROOT } from '../config.js';

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
const dir = (tag = 'wt') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-exec-${tag}-`));
  tmp.push(d);
  return d;
};
const result = (o: Partial<SandboxResult> = {}): SandboxResult => ({
  exitCode: 0, timedOut: false, aborted: false, durationMs: 2100, timeoutSec: 120, output: '', truncated: false, hint: null, infra: false, error: null, ...o,
});
const activeRun = () => {
  const t = createTask(db, { title: 't', goal: 'g', verification_steps: ['true'] });
  const wt = dir();
  const run = createRun(db, { task_id: t.id, worktree_path: wt });
  return { task: getTask(db, t.id)!, wt, run };
};

describe('POST /api/exec/run: only the worktree of a run in progress', () => {
  let app: FastifyInstance;
  const seen: Array<{ workdir: string; command: string; scope?: string; timeoutSec?: unknown }> = [];
  beforeEach(async () => {
    seen.length = 0;
    const run: SandboxRun = async (_s, req) => {
      seen.push(req);
      return result({ exitCode: 1, output: 'arith.cu(12): error: identifier "x" is undefined' });
    };
    app = buildApp({ db, apiToken: null, sandboxRun: run, mcpPool: null });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });
  const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/exec/run', payload });

  it('is closed until exec_enabled', async () => {
    const { run } = activeRun();
    const res = await post({ run_id: run.id, command: 'true' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('exec_enabled');
    expect(seen).toHaveLength(0);
  });

  it('rejects missing fields, unknown and finished runs', async () => {
    setSetting(db, 'exec_enabled', 'true');
    const { run } = activeRun();
    expect((await post({ command: 'true' })).statusCode).toBe(400);
    expect((await post({ run_id: run.id, command: '  ' })).statusCode).toBe(400);
    expect((await post({ run_id: 'r_nope', command: 'true' })).statusCode).toBe(404);
    const done = activeRun();
    finishRun(db, done.run.id, { exit_code: 0 });
    expect((await post({ run_id: done.run.id, command: 'true' })).statusCode).toBe(409);
    const gone = createRun(db, { task_id: run.task_id, worktree_path: '/definitely/not/here' });
    expect((await post({ run_id: gone.id, command: 'true' })).statusCode).toBe(409);
    expect(seen).toHaveLength(0);
  });

  it('runs in that run\'s worktree, returns the formatted result and logs what ran', async () => {
    setSetting(db, 'exec_enabled', 'true');
    const { run, wt, task } = activeRun();
    const res = await post({ run_id: run.id, command: 'nvcc arith.cu', timeout_sec: 60 });
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ workdir: wt, command: 'nvcc arith.cu', timeoutSec: 60, scope: `task:${task.id}` });
    const body = res.json();
    expect(body).toMatchObject({ exitCode: 1, infra: false });
    expect(body.text).toContain('exit 1');
    expect(body.text).toContain('identifier "x" is undefined');
    const ev = db.prepare(`SELECT detail FROM task_events WHERE run_id = ? AND kind = 'note'`).all(run.id) as { detail: string }[];
    expect(ev.map((e) => e.detail).join('\n')).toContain('沙盒：nvcc arith.cu → exit 1');
  });

  it('reports its settings', async () => {
    const s = (await app.inject({ method: 'GET', url: '/api/exec/status' })).json();
    expect(s).toMatchObject({ enabled: false, gpus: 'all', timeout_sec: 120, max_timeout_sec: 900 });
  });
});

const sdkResolvable = [path.join(ENGINE_REPO_ROOT, 'mcp', 'node_modules', '@modelcontextprotocol'), path.join(ENGINE_REPO_ROOT, 'node_modules', '@modelcontextprotocol')].some((p) => fs.existsSync(p));
describe.skipIf(!sdkResolvable)('mcp/loop-exec-mcp.mjs over stdio → engine API', () => {
  it('forwards run to the engine with its run id and returns the result', async () => {
    setSetting(db, 'exec_enabled', 'true');
    const seen: Array<{ workdir: string; command: string }> = [];
    const app = buildApp({ db, apiToken: null, mcpPool: null, sandboxRun: async (_s, req) => (seen.push(req), result({ output: 'PASS max_err=0' })) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const { run, wt } = activeRun();
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-exec-mcp.mjs')],
      env: { ...process.env, LOOP_API_URL: `http://127.0.0.1:${port}`, LOOP_API_TOKEN: '', LOOP_EXEC_RUN_ID: run.id } as Record<string, string>,
      stderr: 'ignore',
    });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(['run']);
      const r = (await client.callTool({ name: 'run', arguments: { command: './arith' } })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(r.isError).toBeFalsy();
      expect(r.content[0]!.text).toContain('PASS max_err=0');
      expect(seen[0]).toMatchObject({ workdir: wt, command: './arith' });
      // the run ends: the server can no longer reach its worktree
      finishRun(db, run.id, { exit_code: 0 });
      const after = (await client.callTool({ name: 'run', arguments: { command: './arith' } })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(after.isError).toBe(true);
      expect(after.content[0]!.text).toContain('409');
    } finally {
      await client.close();
      await app.close();
    }
  }, 30_000);
});

describe('a task run gets the sandbox only when exec_enabled', () => {
  it('no server, no tool, no LOOP_TASK.md section when off', () => {
    expect(execServerForTask(db, 'r_1')).toBeNull();
    const w = dir();
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', verification_steps: ['true'] }).id)!;
    const plain = fs.readFileSync(writeTaskFile(w, task, {}), 'utf8');
    expect(plain).not.toContain('GPU 沙盒');
    expect(plain).toBe(fs.readFileSync(writeTaskFile(w, task, { exec: null }), 'utf8'));
  });

  it('on: a per-run loop-exec server, its tool on the allow-list, and the section that says when to use it', () => {
    setSetting(db, 'exec_enabled', 'true');
    setSetting(db, 'exec_max_timeout_sec', '600');
    const cfg = execServerForTask(db, 'r_42')!;
    expect(cfg.name).toBe('loop-exec');
    expect(cfg.command).toEqual(['node', path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-exec-mcp.mjs')]);
    expect(cfg.environment).toMatchObject({ LOOP_EXEC_RUN_ID: 'r_42', LOOP_EXEC_MAX_TIMEOUT_SEC: '600' });
    expect(cfg.timeout).toBe(execToolTimeoutMs(sandboxSettings(db)));
    const mcp = writeTaskMcp(db, 'r_42', [cfg], dir('mcp'))!;
    expect(mcp.servers).toEqual(['loop-exec']);
    expect(mcp.tools).toEqual(['mcp__loop-exec__run']);
    expect(TASK_MCP_TOOLS).toContain('mcp__loop-exec__run');
    expect(Object.keys(buildTaskMcpConfig([cfg])!.mcpServers)).toEqual(['loop-exec']);

    const w = dir();
    const task = getTask(db, createTask(db, { title: 't', goal: 'g', verification_steps: ['sandbox: ./build/test'] }).id)!;
    const md = fs.readFileSync(writeTaskFile(w, task, { mcpServers: mcp.servers, exec: { image: 'img:1', timeoutSec: 120, maxTimeoutSec: 600 } }), 'utf8');
    expect(md).toContain('## GPU 沙盒（執行中可用）');
    expect(md).toContain('mcp__loop-exec__run');
    expect(md).toContain('img:1');
    expect(md).toContain('exit code');
    // the knowledge-base section belongs to loop/loop-fs, not to the sandbox server
    expect(md).not.toContain('## 查知識庫');
  });

  it('claude gets the longer MCP tool timeout through its environment', async () => {
    const bin = dir('bin');
    const out = path.join(bin, 'env.txt');
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash\necho "$MCP_TOOL_TIMEOUT" > "${out}"\necho '{"type":"result","subtype":"success","session_id":"s"}'\n`, { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const ctx = { task: { id: 't' }, run: { id: 'r' }, cwd: dir(), taskFilePath: '/x', logPath: path.join(bin, 'log'), model: null, timeoutMs: 10_000, env: { MCP_TOOL_TIMEOUT: '720000' } } as never as DispatchContext;
      await claudeCodeAdapter.dispatch(ctx).wait;
      expect(fs.readFileSync(out, 'utf8').trim()).toBe('720000');
    } finally {
      process.env.PATH = saved;
    }
  }, 20_000);
});

describe('`sandbox:` verification steps', () => {
  it('recognises the prefix', () => {
    expect(sandboxStepCommand('sandbox: nvcc x.cu && ./a.out')).toBe('nvcc x.cu && ./a.out');
    expect(sandboxStepCommand('  Sandbox:make test')).toBe('make test');
    expect(sandboxStepCommand('npm test')).toBeNull();
  });

  it('runs prefixed steps in the sandbox and the rest on the host, in order', async () => {
    const wt = dir();
    const seen: string[] = [];
    const task = { verification_steps: JSON.stringify(['echo host', 'sandbox: ./build/test']) } as never;
    const r = await runVerification(task, wt, 10_000, undefined, async (cmd, cwd) => {
      seen.push(`${cmd}@${cwd}`);
      return { ok: true, exitCode: 0, timedOut: false, output: 'PASS' };
    });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([`./build/test@${wt}`]);
    expect(r.results.map((x) => x.step)).toEqual(['echo host', 'sandbox: ./build/test']);
    expect(r.results[0]!.output).toContain('host');
  });

  it('fails clearly when the sandbox is off, instead of running it on the host', async () => {
    const task = { verification_steps: JSON.stringify(['sandbox: touch ran-on-host']) } as never;
    const wt = dir();
    const r = await runVerification(task, wt, 10_000, undefined, null);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('sandbox: touch ran-on-host');
    expect(r.results[0]!.output).toContain('exec_enabled');
    expect(fs.existsSync(path.join(wt, 'ran-on-host'))).toBe(false);
  });

  it('the verify pipeline wires the sandbox in when exec_enabled', async () => {
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: ['sandbox: ./test'] });
    const wt = dir();
    const run = createRun(db, { task_id: t.id, worktree_path: wt });
    const task = getTask(db, t.id)!;
    const seen: string[][] = [];
    const runner: DockerRunner = async (args) => (seen.push(args), { code: 0, output: 'PASS', truncated: false, timedOut: false, aborted: false });
    // off: the step fails without touching docker
    expect(await runVerifyPipeline(db, task, wt, run.id, 'main', undefined, { runner })).toBe('fail');
    expect(seen).toHaveLength(0);
    // on: it runs in the container with the worktree mounted
    setSetting(db, 'exec_enabled', 'true');
    const t2 = getTask(db, createTask(db, { title: 't2', goal: 'g', coding_tool: 'mock', verification_steps: ['sandbox: ./test'] }).id)!;
    const run2 = createRun(db, { task_id: t2.id, worktree_path: wt });
    expect(await runVerifyPipeline(db, t2, wt, run2.id, 'main', undefined, { runner, uid: 1, gid: 1 })).toBe('pass');
    expect(seen[0]!.join(' ')).toContain(`source=${wt},target=/work`);
    expect(seen[0]!.at(-1)).toBe('./test');
  });
});
