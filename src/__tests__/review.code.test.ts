import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openTestDb } from '../db/index.js';
import { createTask, setStatus, createRun, updateRun } from '../tasks.js';
import { formatEvent, taskResult } from '../server/board.js';
import { changedFiles, codeRefFor, fileDiff, readSource, safeRepoPath, verifiedShas } from '../review/code.js';
import { buildApp } from '../server/app.js';
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
const dir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-review-${tag}-`));
  tmp.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

describe('log lines from a local-model (opencode) run', () => {
  it('shows the tool and its target, the text, and errors — not the event names', () => {
    expect(formatEvent({ type: 'step_start', part: { type: 'step-start' } })).toEqual([]);
    expect(formatEvent({ type: 'step_finish', part: { tokens: { input: 1 } } })).toEqual([]);
    expect(formatEvent({ type: 'tool_use', part: { tool: 'bash', state: { status: 'completed', input: { command: 'nvcc -O3 -o arith  arith.cu' } } } })).toEqual(['→ bash: nvcc -O3 -o arith arith.cu']);
    expect(formatEvent({ type: 'tool_use', part: { tool: 'write', state: { status: 'completed', input: { filePath: '/work/arith_ncu/arith_kernel.cu' } } } })).toEqual(['→ write /work/arith_ncu/arith_kernel.cu']);
    expect(formatEvent({ type: 'tool_use', part: { tool: 'edit', state: { status: 'error', input: { filePath: 'a.cu' } } } })).toEqual(['→ edit a.cu ✖']);
    expect(formatEvent({ type: 'text', part: { type: 'text', text: '\n\nALL PASS' } })).toEqual(['ALL PASS']);
    expect(formatEvent({ type: 'error', error: { name: 'APIError', data: { message: 'connection refused' } } })).toEqual(['✖ connection refused']);
    // the Claude stream and the mock adapter read as before
    expect(formatEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } })).toEqual(['→ Bash: npm test']);
    expect(formatEvent({ type: 'text', text: 'mock says hi' })).toEqual(['mock says hi']);
  });
});

/** a repo on main + a task worktree on loop/<id> with a modified, an added and a deleted file */
function fixture() {
  const repo = dir('repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'kernel.cu'), '__global__ void add() {}\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'bye\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const task = createTask(db, { title: 'CUDA 加減乘除', goal: 'g', coding_tool: 'claude-code', verification_steps: ['sandbox: bash run.sh'], repo_path: repo, base_branch: 'main', acceptance_metrics: 'kernels_pass == 4' });
  const wt = path.join(dir('wts'), 'loop_' + task.id);
  git(repo, 'worktree', 'add', '-q', '-b', `loop/${task.id}`, wt, 'main');
  fs.writeFileSync(path.join(wt, 'kernel.cu'), '__global__ void add() {}\n__global__ void sub() {}\n');
  fs.writeFileSync(path.join(wt, 'run.sh'), 'echo LOOP_METRICS {"kernels_pass": 4}\n');
  fs.writeFileSync(path.join(wt, 'VERIFY.md'), '- [ ] 上機台跑一次\n');
  fs.rmSync(path.join(wt, 'old.txt'));
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', `loop(${task.id}): auto-commit`);
  const run = createRun(db, { task_id: task.id, worktree_path: wt, branch: `loop/${task.id}` });
  updateRun(db, run.id, {
    verify_json: JSON.stringify([{ step: 'sandbox: bash run.sh', ok: true, exitCode: 0, timedOut: false, tail: 'LOOP_METRICS {"kernels_pass": 4}' }]),
    metrics_json: JSON.stringify({ values: { kernels_pass: 4 }, checks: [{ name: 'kernels_pass', op: '==', target: 4, actual: 4, pass: true }], pass: true }),
    ...verifiedShas(wt, 'main'),
  });
  setStatus(db, task.id, 'review');
  return { repo, wt, task, run };
}

describe('reading a task\'s code', () => {
  it('while the worktree exists: changed files, source, the base side and a diff', () => {
    const { wt, task } = fixture();
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'not committed yet\n');
    const ref = codeRefFor(db, task)!;
    expect(ref.worktree).toBe(wt);
    const files = changedFiles(ref);
    expect(files.map((f) => `${f.status} ${f.path}`)).toEqual(['M kernel.cu', 'D old.txt', 'A run.sh', 'A VERIFY.md']);
    // what is still untracked after a run is what verification built, not a code change
    expect(files.some((f) => f.path === 'scratch.txt')).toBe(false);
    expect(readSource(ref, 'kernel.cu')!.text).toContain('sub()');
    expect(readSource(ref, 'kernel.cu', 'base')!.text).not.toContain('sub()');
    expect(fileDiff(ref, 'kernel.cu')).toContain('+__global__ void sub() {}');
  });

  it('after the branch was fast-forwarded into base and the worktree reclaimed (the usual morning case)', () => {
    const { repo, wt, task } = fixture();
    git(repo, 'merge', '-q', '--ff-only', `loop/${task.id}`);
    git(repo, 'worktree', 'remove', '--force', wt);
    const ref = codeRefFor(db, task)!;
    expect(ref.worktree).toBeNull();
    expect(changedFiles(ref).map((f) => `${f.status} ${f.path}`)).toEqual(['M kernel.cu', 'D old.txt', 'A run.sh', 'A VERIFY.md']);
    expect(readSource(ref, 'kernel.cu')!.from).toMatch(/^[0-9a-f]{40}$/);
    expect(fileDiff(ref)).toContain('+__global__ void sub() {}');
  });

  it('refuses paths outside the repo and flags binary files', () => {
    const { wt, task } = fixture();
    fs.writeFileSync(path.join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const ref = codeRefFor(db, task)!;
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', '.git/config', '-x', 'a\\b', '']) expect(safeRepoPath(bad)).toBeNull();
    expect(readSource(ref, '../../etc/passwd')).toBeNull();
    const bin = readSource(ref, 'blob.bin')!;
    expect(bin.binary).toBe(true);
    expect(bin.text).toBeNull();
  });
});

describe('the task result (board detail, loop_task_result)', () => {
  it('carries the engine\'s verification record, metrics, changed files and the review page link', () => {
    const { repo, wt, task } = fixture();
    git(repo, 'merge', '-q', '--ff-only', `loop/${task.id}`);
    git(repo, 'worktree', 'remove', '--force', wt);
    const prev = process.env.LOOP_PUBLIC_URL;
    process.env.LOOP_PUBLIC_URL = 'https://spark.tail/';
    try {
      const r = taskResult(db, task.id)!;
      expect(r.verify[0]).toMatchObject({ step: 'sandbox: bash run.sh', ok: true, exitCode: 0 });
      expect(r.metrics?.pass).toBe(true);
      expect(r.thresholds).toBe('kernels_pass == 4');
      expect(r.changed_files!.map((f) => f.path)).toContain('kernel.cu');
      expect(r.verify_md).toContain('上機台跑一次'); // read from git: the worktree is gone
      expect(r.review_url).toBe(`https://spark.tail/task.html?id=${task.id}`);
    } finally {
      if (prev === undefined) delete process.env.LOOP_PUBLIC_URL;
      else process.env.LOOP_PUBLIC_URL = prev;
    }
  });
});

const sdkResolvable = [path.join(ENGINE_REPO_ROOT, 'mcp', 'node_modules', '@modelcontextprotocol'), path.join(ENGINE_REPO_ROOT, 'node_modules', '@modelcontextprotocol')].some((p) => fs.existsSync(p));
describe.skipIf(!sdkResolvable)('mcp/loop-mcp.mjs in the chat', () => {
  it('loop_task_result shows the steps, metrics and files; loop_wait_task answers before the chat times out', async () => {
    const { task } = fixture();
    const running = createTask(db, { title: 'still going', goal: 'g', coding_tool: 'mock', verification_steps: ['true'] });
    setStatus(db, running.id, 'running');
    const app = buildApp({ db, apiToken: null, mcpPool: null });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(ENGINE_REPO_ROOT, 'mcp', 'loop-mcp.mjs')],
      env: { ...process.env, LOOP_API_URL: `http://127.0.0.1:${port}`, LOOP_API_TOKEN: '', LOOP_MCP_TIMEOUT_MS: '6000' } as Record<string, string>,
      stderr: 'ignore',
    });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(transport);
    try {
      const text = async (name: string, args: Record<string, unknown>) =>
        ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
      const result = await text('loop_task_result', { id: task.id });
      expect(result).toContain('PASS  sandbox: bash run.sh  (exit 0)');
      expect(result).toContain('ok  kernels_pass = 4  (need == 4)');
      expect(result).toContain('M kernel.cu');
      expect(result).toContain(`/task.html?id=${task.id}`);

      const t0 = Date.now();
      const waited = await text('loop_wait_task', { id: running.id });
      expect(Date.now() - t0).toBeLessThan(6000);
      expect(waited).toContain('still running');

      expect(await text('loop_list_exec_hosts', {})).toContain('exec_enabled=false');
      expect(await text('loop_list_environments', {})).not.toContain('Could not');
    } finally {
      await client.close();
      await app.close();
    }
  }, 30_000);
});
