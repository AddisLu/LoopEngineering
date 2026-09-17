import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, latestRun } from '../tasks.js';
import { pickAdapter, runTask } from '../orchestrator/run.js';
import { mockAdapter } from '../orchestrator/adapters/mock.js';
import { opencodeAdapter, buildOpencodeArgs, buildOpencodeConfig } from '../orchestrator/adapters/opencode.js';
import { createNdjsonCollector } from '../orchestrator/stream.js';
import { getLocalModel } from '../local/models.js';
import { validateSetting } from '../settings.js';
import { timeoutMinFor } from '../scheduler/timeout.js';
import { setCachedUsage } from '../token/usage.js';
import type { DispatchContext } from '../orchestrator/adapters/types.js';
import type { Task, TaskRun } from '../types.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
});
afterEach(() => {
  db.close();
  delete process.env.LOOP_OPENCODE_BIN;
  delete process.env.REPLAY_MODE;
});

const BASE = {
  title: 't',
  goal: 'g',
  plan_ref: 'https://example.com/p.md',
  plan_kind: 'url' as const,
  repo_path: '/tmp/repo',
  base_branch: 'main',
};

function ctxFor(over: Partial<DispatchContext> = {}): DispatchContext & { local: NonNullable<DispatchContext['local']> } {
  return {
    task: { id: 't_abc' } as Task,
    run: { id: 'r_abc' } as TaskRun,
    cwd: '/work/tree',
    taskFilePath: '/work/tree/LOOP_TASK.md',
    logPath: '/dev/null',
    model: 'local:qwen38-flash',
    timeoutMs: 1000,
    local: getLocalModel(db, 'qwen38-flash')!,
    ...over,
  } as DispatchContext & { local: NonNullable<DispatchContext['local']> };
}

describe('opencode adapter: args + inline config', () => {
  it('fresh run: headless JSON, auto-approve, provider/model id, worktree dir, prompt last', () => {
    const args = buildOpencodeArgs(ctxFor());
    expect(args.slice(0, 10)).toEqual([
      'run', '--model', 'loop-local/local-inference-lab/Qwen3.8-Flash-Next-NVFP4',
      '--format', 'json', '--auto', '--dir', '/work/tree', '--title', 'loop t_abc',
    ]);
    expect(args).not.toContain('--session');
    expect(args.at(-1)).toMatch(/LOOP_TASK\.md/);
  });

  it('resume run passes the opencode session id and the resume prompt', () => {
    const args = buildOpencodeArgs(ctxFor({ resume: true, resumeSessionId: 'ses_123', handoff: 'did half' }));
    expect(args).toEqual(expect.arrayContaining(['--session', 'ses_123']));
    expect(args.at(-1)).toMatch(/did half/);
  });

  it('config points the provider at vLLM and denies push / network fetch / sudo', () => {
    const cfg = JSON.parse(buildOpencodeConfig(getLocalModel(db, 'qwen38-flash')!, 'http://spark:8000/v1'));
    expect(cfg.provider['loop-local'].npm).toBe('@ai-sdk/openai-compatible');
    expect(cfg.provider['loop-local'].options.baseURL).toBe('http://spark:8000/v1');
    expect(Object.keys(cfg.provider['loop-local'].models)).toEqual(['local-inference-lab/Qwen3.8-Flash-Next-NVFP4']);
    expect(cfg.permission.webfetch).toBe('deny');
    expect(cfg.permission.bash['git push*']).toBe('deny');
    expect(cfg.permission.bash['sudo *']).toBe('deny');
  });

  it('without a registered local model the dispatch fails cleanly (pid 0, no spawn)', async () => {
    const h = opencodeAdapter.dispatch(ctxFor({ local: null }));
    expect(h.pid).toBe(0);
    expect((await h.wait).error).toMatch(/needs a registered local model/);
  });
});

describe('stream collector: opencode dialect', () => {
  it('captures sessionID, sums step_finish tokens, keeps last text; error event -> subtype error', () => {
    const c = createNdjsonCollector();
    const ev = (o: object) => c.push(JSON.stringify({ timestamp: 1, sessionID: 'ses_9', ...o }) + '\n');
    ev({ type: 'step_start', part: { type: 'step-start' } });
    ev({ type: 'tool_use', part: { type: 'tool', tool: 'write', state: { status: 'completed' } } });
    ev({ type: 'step_finish', part: { type: 'step-finish', cost: 0, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } } } });
    ev({ type: 'text', part: { type: 'text', text: 'DONE' } });
    ev({ type: 'step_finish', part: { type: 'step-finish', cost: 0, tokens: { input: 50, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } } });
    c.flush();
    const r = c.result();
    expect(r).toMatchObject({ sessionId: 'ses_9', tokensIn: 160, tokensOut: 28, lastText: 'DONE', resultSubtype: null });
    expect(JSON.parse(r.usageJson!)).toMatchObject({ steps: 2, input: 150, output: 23 });

    ev({ type: 'error', error: { name: 'APIError' } });
    expect(c.result().resultSubtype).toBe('error');
  });

  it('claude result.usage still parses (and now yields token counts)', () => {
    const c = createNdjsonCollector();
    c.push(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 7, output_tokens: 3 } }) + '\n');
    expect(c.result()).toMatchObject({ sessionId: 's1', tokensIn: 7, tokensOut: 3, resultSubtype: 'success' });
  });
});

describe('routing + settings', () => {
  it('a local model picks opencode for claude-code and generic, ignoring agent_backend; mock stays mock', () => {
    setSetting(db, 'agent_backend', 'claude-code');
    for (const coding_tool of ['claude-code', 'generic']) {
      const t = getTask(db, createTask(db, { ...BASE, coding_tool, model: 'local:qwen38-flash' }).id)!;
      expect(pickAdapter(t, db)).toBe(opencodeAdapter);
    }
    const mock = getTask(db, createTask(db, { ...BASE, coding_tool: 'mock', model: 'local:qwen38-flash' }).id)!;
    expect(pickAdapter(mock, db)).toBe(mockAdapter);
  });

  it('default_model routes to local too', () => {
    setSetting(db, 'default_model', 'local:qwen3-coder-next');
    const t = getTask(db, createTask(db, { ...BASE, coding_tool: 'claude-code' }).id)!;
    expect(pickAdapter(t, db)).toBe(opencodeAdapter);
  });

  it('validateSetting accepts local:<id> only where an implementation model is expected', () => {
    expect(validateSetting('default_model', 'local:qwen38-flash')).toBeNull();
    expect(validateSetting('route_S', 'local:qwen3-coder-next')).toBeNull();
    expect(validateSetting('default_model', 'local:')).toMatch(/must be one of/);
    expect(validateSetting('report_model', 'local:qwen38-flash')).toMatch(/must be one of/);
    expect(validateSetting('local_models_enabled', 'yes')).toMatch(/true or false/);
    expect(validateSetting('local_max_concurrency', '-1')).toMatch(/non-negative/);
  });

  it('local runs get local_timeout_multiplier on the complexity default, explicit timeouts untouched', () => {
    setSetting(db, 'local_timeout_multiplier', '3');
    expect(timeoutMinFor(db, { timeout_min: null, complexity: 'M' }, 'local:qwen38-flash')).toBe(135);
    expect(timeoutMinFor(db, { timeout_min: null, complexity: 'M' }, 'sonnet')).toBe(45);
    expect(timeoutMinFor(db, { timeout_min: 20, complexity: 'M' }, 'local:qwen38-flash')).toBe(20);
  });
});

// A stand-in `opencode` binary: writes hello.txt into --dir, records the inline config it got,
// and prints opencode `run --format json` events. REPLAY_MODE=fail emits a session error + exit 1.
const REPLAY = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1];
fs.writeFileSync(path.join(dir, 'replay-args.json'), JSON.stringify(args));
fs.writeFileSync(path.join(dir, 'replay-config.json'), process.env.OPENCODE_CONFIG_CONTENT || '');
const w = (o) => process.stdout.write(JSON.stringify({ timestamp: Date.now(), sessionID: 'ses_replay', ...o }) + '\\n');
w({ type: 'step_start', part: { type: 'step-start' } });
if (process.env.REPLAY_MODE === 'fail') {
  w({ type: 'error', error: { name: 'APIError', data: { message: 'connection refused' } } });
  process.exit(1);
}
fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi\\n');
w({ type: 'tool_use', part: { type: 'tool', tool: 'write', state: { status: 'completed' } } });
w({ type: 'step_finish', part: { type: 'step-finish', cost: 0, tokens: { input: 1200, output: 80, reasoning: 20, cache: { read: 0, write: 0 } } } });
w({ type: 'text', part: { type: 'text', text: 'DONE', time: { end: 1 } } });
w({ type: 'step_finish', part: { type: 'step-finish', cost: 0, tokens: { input: 300, output: 5, reasoning: 0, cache: { read: 100, write: 0 } } } });
`;

describe('runTask end-to-end through the opencode adapter (replay binary, zero GPU)', () => {
  let bin: string;
  beforeAll(() => {
    bin = path.join(os.tmpdir(), `loop-opencode-replay-${process.pid}.cjs`);
    fs.writeFileSync(bin, REPLAY, { mode: 0o755 });
  });

  function localGenericTask(): Task {
    const t = createTask(db, {
      ...BASE,
      coding_tool: 'generic',
      model: 'local:qwen38-flash',
      verification_steps: ['test -f hello.txt'],
      complexity: 'S',
    });
    return getTask(db, t.id)!;
  }

  it('runs, records tokens/backend/session, skips the claude-only hook, verifies, reaches review', async () => {
    process.env.LOOP_OPENCODE_BIN = bin;
    const task = localGenericTask();
    await runTask(db, task);

    expect(getTask(db, task.id)!.status).toBe('review');
    const run = latestRun(db, task.id)!;
    expect(run).toMatchObject({
      backend: 'opencode',
      model: 'local:qwen38-flash',
      session_id: 'ses_replay',
      tokens_in: 1600,
      tokens_out: 105,
      exit_code: 0,
    });
    const dir = run.worktree_path!;
    expect(fs.existsSync(path.join(dir, '.claude', 'settings.local.json'))).toBe(false);
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'replay-args.json'), 'utf8'));
    expect(args).toEqual(expect.arrayContaining(['--model', 'loop-local/local-inference-lab/Qwen3.8-Flash-Next-NVFP4']));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'replay-config.json'), 'utf8')).permission.webfetch).toBe('deny');
    const dispatch = db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'dispatch'").get(task.id) as {
      detail: string;
    };
    expect(dispatch.detail).toBe('tool=generic est=0% model=local:qwen38-flash');
  });

  it('a session error (exit 1) parks the task in attention with the worktree kept', async () => {
    process.env.LOOP_OPENCODE_BIN = bin;
    process.env.REPLAY_MODE = 'fail';
    const task = localGenericTask();
    await runTask(db, task);
    const after = getTask(db, task.id)!;
    expect(after.status).toBe('attention');
    expect(latestRun(db, task.id)).toMatchObject({ exit_code: 1, backend: 'opencode' });
  });
});

describe('real opencode 1.18 stream (captured on the DGX Spark against Qwen3.8 Flash Next)', () => {
  const lines = fs
    .readFileSync(new URL('./fixtures/opencode-run.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);

  it('parses session id and sums every step\'s tokens', () => {
    const c = createNdjsonCollector();
    for (const l of lines) c.push(l + '\n');
    c.flush();
    expect(c.result()).toMatchObject({
      sessionId: 'ses_f5bac733dffeRs5bfE0ULz5aYx',
      tokensIn: 41301, // 5 steps; each step re-sends the growing context
      tokensOut: 1367, // output + reasoning
      lastText: '\n\nDONE',
      resultSubtype: null, // opencode has no final result event; exit 0 decides
    });
  });

  it('the inline permission rule really denied git push under --auto', () => {
    const pushes = lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'tool_use' && String(e.part?.state?.input?.command ?? '').includes('git push'));
    expect(pushes.length).toBeGreaterThan(0);
    for (const e of pushes) {
      expect(e.part.state.status).toBe('error');
      expect(String(e.part.state.error)).toMatch(/prevents you from using this specific tool call/);
    }
  });
});
