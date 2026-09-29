import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import {
  chatWorkspaceDir,
  listWorkspace,
  readWorkspaceFile,
  removeChatWorkspace,
  resolveInWorkspace,
  writeWorkspaceFile,
  WorkspaceError,
} from '../exec/workspace.js';
import { execAllowedFor, sandboxTools, SANDBOX_RESULT_PREFIX, type SandboxRun } from '../chat/sandboxTools.js';
import { runToolLoop } from '../chat/toolLoop.js';
import { registerChatRoutes, systemPromptWithTools } from '../server/chatRoutes.js';
import { appendMessage, createConversation, deleteConversation, updateMessage } from '../chat/store.js';
import { clearRecipeCache } from '../local/recipes.js';
import { paths } from '../config.js';
import type { SandboxResult } from '../exec/sandbox.js';

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
const dir = (tag = 'ws') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-exec-${tag}-`));
  tmp.push(d);
  return d;
};
const result = (o: Partial<SandboxResult> = {}): SandboxResult => ({
  exitCode: 0, timedOut: false, aborted: false, durationMs: 1200, timeoutSec: 120, output: '', truncated: false, hint: null, infra: false, error: null, ...o,
});

describe('workspace files: everything stays inside /work', () => {
  it('accepts relative and /work/… paths, refuses everything that leaves', () => {
    const root = dir();
    expect(resolveInWorkspace(root, 'a/b.cu')).toBe(path.join(fs.realpathSync(root), 'a', 'b.cu'));
    expect(resolveInWorkspace(root, '/work/a.cu')).toBe(path.join(fs.realpathSync(root), 'a.cu'));
    expect(() => resolveInWorkspace(root, '../x')).toThrow(WorkspaceError);
    expect(() => resolveInWorkspace(root, 'a/../../x')).toThrow(/跑出/);
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(/相對路徑/);
    expect(() => resolveInWorkspace(root, '')).toThrow(/不可為空/);
    // a container can plant symlinks in /work — they must not become a way out
    const outside = dir('out');
    fs.writeFileSync(path.join(outside, 'secret'), 'nope');
    fs.symlinkSync(outside, path.join(root, 'link'));
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'file-link'));
    expect(() => resolveInWorkspace(root, 'link/secret')).toThrow(/符號連結/);
    expect(() => writeWorkspaceFile(root, 'link/new.txt', 'x')).toThrow(/符號連結/);
    expect(() => readWorkspaceFile(root, 'file-link')).toThrow(/符號連結/);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it('writes, reads a window of lines, lists with sizes', () => {
    const root = dir();
    const w = writeWorkspaceFile(root, 'src/arith.cu', 'line1\nline2\nline3\n');
    expect(w).toEqual({ path: path.join('src', 'arith.cu'), bytes: 18 });
    const r = readWorkspaceFile(root, 'src/arith.cu', { startLine: 2, maxLines: 1 });
    expect(r.text).toContain('    2| line2');
    expect(r.text).not.toContain('line1');
    expect(r.truncated).toBe(true);
    expect(listWorkspace(root)).toContain('src/arith.cu (18 B)');
    expect(listWorkspace(root)).toContain('src/');
    fs.writeFileSync(path.join(root, 'bin'), Buffer.from([1, 0, 2]));
    expect(() => readWorkspaceFile(root, 'bin')).toThrow(/二進位/);
    expect(() => writeWorkspaceFile(root, 'big', 'x'.repeat(1024 * 1024 + 1))).toThrow(/太大/);
    expect(() => readWorkspaceFile(root, 'nope')).toThrow(/找不到/);
    expect(listWorkspace(dir())).toBe('（空的）');
  });

  it('one scratch dir per conversation, removed with it', () => {
    expect(chatWorkspaceDir('c_abc123')).toBe(path.join(paths.dataDir, 'exec', 'chat', 'c_abc123'));
    expect(() => chatWorkspaceDir('../../etc')).toThrow(WorkspaceError);
    const d = chatWorkspaceDir(`c_test${Date.now()}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'a.out'), 'x');
    expect(removeChatWorkspace(path.basename(d))).toBe(true);
    expect(fs.existsSync(d)).toBe(false);
    expect(removeChatWorkspace('c_never')).toBe(false);
  });
});

describe('chat sandbox tools', () => {
  it('only listed identities may run code', () => {
    expect(execAllowedFor(db, 'local')).toBe(false); // empty list = nobody
    setSetting(db, 'exec_allowed_users', 'ts:Alice@corp, local');
    expect(execAllowedFor(db, 'local')).toBe(true);
    expect(execAllowedFor(db, 'ts:alice@corp')).toBe(true);
    expect(execAllowedFor(db, 'name:bob')).toBe(false);
  });

  it('write → run → read against the conversation workspace', async () => {
    const ws = path.join(dir(), 'conv'); // not created yet: the tools create it on first use
    const calls: Array<{ workdir: string; command: string; timeoutSec: unknown; scope?: string }> = [];
    const run: SandboxRun = async (_s, req) => {
      calls.push(req);
      fs.writeFileSync(path.join(req.workdir, 'out.csv'), 'n,ms\n1024,0.01\n');
      return result({ exitCode: 1, output: 'mismatch at 17\n', durationMs: 3400 });
    };
    const tools = sandboxTools(db, ws, { run });
    expect(tools.map((t) => t.name)).toEqual(['sandbox_write_file', 'sandbox_read_file', 'sandbox_list', 'sandbox_run']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const ctx = { db, fetch, signal: new AbortController().signal };

    const w = await byName.sandbox_write_file!.run({ path: 'arith.cu', content: '__global__ void k(){}' }, ctx);
    expect(w).toMatchObject({ ok: true, summary: 'arith.cu · 21 B' });
    // the recorded call carries the size, not the file
    expect(byName.sandbox_write_file!.recordArgs!({ path: 'arith.cu', content: 'x'.repeat(5000) })).toEqual({ path: 'arith.cu', bytes: 5000 });

    const r = await byName.sandbox_run!.run({ command: 'nvcc arith.cu && ./a.out', timeout_sec: 30 }, ctx);
    expect(calls[0]).toMatchObject({ command: 'nvcc arith.cu && ./a.out', timeoutSec: 30, scope: 'chat' });
    expect(calls[0]!.workdir).toBe(fs.realpathSync(ws));
    expect(r.ok).toBe(true); // a failing program is an answer, not a broken tool
    expect(r.summary).toBe('exit 1 · 3.4 s');
    expect(r.text).toContain('mismatch at 17');
    expect(r.detail).toContain('$ nvcc arith.cu && ./a.out');

    const back = await byName.sandbox_read_file!.run({ path: 'out.csv' }, ctx);
    expect(back.text).toContain('1024,0.01');
    expect((await byName.sandbox_list!.run({}, ctx)).text).toContain('arith.cu');
    expect((await byName.sandbox_read_file!.run({ path: '../../etc/passwd' }, ctx)).ok).toBe(false);

    const broken: SandboxRun = async () => result({ exitCode: 125, infra: true, error: 'docker 無法啟動容器（exit 125）', hint: '先 docker pull' });
    const bad = await sandboxTools(db, ws, { run: broken })[3]!.run({ command: 'true' }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.summary).toContain('沙盒錯誤');
  });

  it('the tool loop lets a build be re-run, labels results as sandbox output, and keeps records small', async () => {
    const ws = dir();
    let runs = 0;
    const tools = sandboxTools(db, ws, { run: async () => (runs++, result({ output: runs === 1 ? 'error' : 'PASS' })) });
    const sse = (frames: unknown[]) => `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
    const call = (id: string, name: string, args: unknown) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]);
    const script = [
      call('c1', 'sandbox_write_file', { path: 'a.cu', content: 'v1'.repeat(3000) }),
      call('c2', 'sandbox_run', { command: 'make' }),
      call('c3', 'sandbox_write_file', { path: 'a.cu', content: 'v2' }),
      call('c4', 'sandbox_run', { command: 'make' }), // identical call: a rebuild, not a loop
      sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ];
    const bodies: Array<Record<string, unknown>> = [];
    const fake = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(script[bodies.length - 1]);
    }) as unknown as typeof fetch;
    const r = await runToolLoop({
      fetch: fake,
      baseUrl: 'http://v/v1',
      body: {},
      messages: [{ role: 'user', content: 'q' }],
      tools,
      ctx: { db, fetch: fake, signal: new AbortController().signal },
      maxRounds: 10,
      wallMs: 60_000,
      write: () => {},
      signal: new AbortController().signal,
    });
    expect(runs).toBe(2);
    expect(r.rounds).toHaveLength(4);
    expect(r.rounds[0]!.calls[0]!.args).toEqual({ path: 'a.cu', bytes: 6000 });
    expect(r.rounds[3]!.calls[0]).toMatchObject({ name: 'sandbox_run', ok: true });
    expect(r.rounds[3]!.calls[0]!.detail).toContain('PASS');
    const toolMsg = (bodies[4]!.messages as Array<{ role: string; content: string }>).at(-1)!;
    expect(toolMsg.content.startsWith(SANDBOX_RESULT_PREFIX)).toBe(true);
    expect(JSON.stringify(r.rounds).length).toBeLessThan(4000);
  });

  it('a long sandbox session never costs the answer: oldest output excerpts are dropped to fit the row', () => {
    const conv = createConversation(db, { user_key: 'local', title: 't' });
    const msg = appendMessage(db, conv.id, 'local', { role: 'assistant', content: '' });
    const rounds = Array.from({ length: 60 }, (_, i) => ({
      round: i + 1,
      calls: [{ id: `c${i}`, name: 'sandbox_run', args: { command: 'make' }, ms: 1, ok: true, summary: 'exit 0 · 1.0 s', detail: `run ${i}\n${'x'.repeat(1400)}` }],
    }));
    expect(JSON.stringify(rounds).length).toBeGreaterThan(64 * 1024);
    updateMessage(db, msg.id, 'local', { role: 'assistant', content: 'the answer', tools: rounds });
    const row = db.prepare('SELECT content, tools_json FROM chat_messages WHERE id = ?').get(msg.id) as { content: string; tools_json: string };
    expect(row.content).toBe('the answer');
    const saved = JSON.parse(row.tools_json) as typeof rounds;
    expect(saved).toHaveLength(60); // every call kept…
    expect(saved[0]!.calls[0]!.detail).toBeUndefined(); // …the oldest excerpts went first…
    expect(saved.at(-1)!.calls[0]!.detail).toContain('run 59'); // …the latest output survives
  });

  it('refuses a workdir that --mount would misparse', async () => {
    const { runSandbox, sandboxSettings } = await import('../exec/sandbox.js');
    const r = await runSandbox({ ...sandboxSettings(db), enabled: true }, { workdir: '/tmp/a"b', command: 'true' }, { runner: async () => { throw new Error('must not run'); } });
    expect(r.error).toMatch(/不合法/);
  });

  it('the system prompt tells the model to run things itself only when the sandbox is offered', () => {
    const tools = sandboxTools(db, dir(), { run: async () => result() });
    expect(systemPromptWithTools(tools)).toContain('GPU 執行沙盒');
    expect(systemPromptWithTools(tools)).toContain('exit code');
    expect(systemPromptWithTools([tools[0]!].filter((t) => t.name !== 'sandbox_run'))).not.toContain('GPU 執行沙盒');
  });
});

describe('the chat page shows what actually ran', () => {
  it('the tool card labels sandbox calls and shows the raw output via textContent', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'chat.js'), 'utf8');
    expect(js).toContain("sandbox_run: '沙盒執行'");
    expect(js).toContain("el('pre', null, c.detail)"); // verbatim output, never innerHTML
  });
});

describe('POST /api/chat offers the sandbox only when all gates pass', () => {
  let app: FastifyInstance;
  let repo: string;
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  beforeEach(async () => {
    calls.length = 0;
    setSetting(db, 'local_models_enabled', 'true');
    setSetting(db, 'local_model_status', 'ready');
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    setSetting(db, 'chat_tools_enabled', 'true');
    repo = dir('recipes');
    fs.mkdirSync(path.join(repo, 'recipes'));
    fs.writeFileSync(path.join(repo, 'recipes', 'qwen3.8-flash-next-nvfp4-solo.yaml'), 'model: x\ncommand: |\n  vllm serve x --tool-call-parser qwen3_xml --enable-auto-tool-choice\n');
    setSetting(db, 'local_vllm_repo', repo);
    clearRecipeCache();
    app = Fastify();
    registerChatRoutes(app, db, {
      tools: () => [],
      sandboxRun: async () => result(),
      fetch: async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const askIn = async (conversation: boolean) => {
    let messageId: string | undefined;
    let convId: string | undefined;
    if (conversation) {
      const conv = createConversation(db, { user_key: 'local', title: 't' });
      convId = conv.id;
      appendMessage(db, conv.id, 'local', { role: 'user', content: 'hi' });
      messageId = appendMessage(db, conv.id, 'local', { role: 'assistant', content: '' }).id;
    }
    calls.length = 0;
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { messages: [{ role: 'user', content: 'hi' }], tools: true, ...(messageId ? { message_id: messageId } : {}) } });
    const body = calls.find((c) => c.url.endsWith('/chat/completions'))?.body ?? {};
    const names = ((body.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name);
    return { res, names, convId, system: (body.messages as Array<{ content: string }> | undefined)?.[0]?.content ?? '' };
  };

  it('exec off, or the asker not listed, or no saved conversation: no sandbox tools', async () => {
    expect((await askIn(true)).names).not.toContain('sandbox_run'); // exec_enabled=false
    setSetting(db, 'exec_enabled', 'true');
    expect((await askIn(true)).names).not.toContain('sandbox_run'); // exec_allowed_users empty
    setSetting(db, 'exec_allowed_users', 'local');
    expect((await askIn(false)).names).not.toContain('sandbox_run'); // no conversation = no workspace
  });

  it('all gates pass: four sandbox tools and the sandbox paragraph; deleting the conversation removes its files', async () => {
    setSetting(db, 'exec_enabled', 'true');
    setSetting(db, 'exec_allowed_users', 'local');
    const { res, names, convId, system } = await askIn(true);
    expect(res.statusCode).toBe(200);
    expect(names).toEqual(['sandbox_write_file', 'sandbox_read_file', 'sandbox_list', 'sandbox_run']);
    expect(system).toContain('GPU 執行沙盒');
    const ws = chatWorkspaceDir(convId!);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'a.out'), 'x');
    const del = await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${convId}` });
    expect(del.statusCode).toBe(200);
    expect(fs.existsSync(ws)).toBe(false);
    expect(deleteConversation(db, convId!, 'local')).toBe(false); // already gone
  });
});
