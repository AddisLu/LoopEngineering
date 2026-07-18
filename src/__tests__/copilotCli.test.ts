import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, getSetting } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { setCachedUsage } from '../token/usage.js';
import { paths } from '../config.js';
import {
  mapModel,
  buildCopilotArgs,
  promptFor,
  looksUnauthenticated,
  dispatchCopilot,
} from '../orchestrator/adapters/copilotCli.js';
import type { Adapter, DispatchContext, DispatchHandle } from '../orchestrator/adapters/types.js';

// ---- pure helpers (no process ever spawned) ----

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    task: {} as never,
    run: { id: 'r_test' } as never,
    cwd: tmpDir,
    taskFilePath: path.join(tmpDir, 'LOOP_TASK.md'),
    logPath: path.join(tmpDir, 'run.log'),
    model: null,
    timeoutMs: 60_000,
    resume: false,
    handoff: null,
    ...over,
  };
}

describe('mapModel', () => {
  it('maps loop aliases to Copilot model ids', () => {
    expect(mapModel('sonnet')).toBe('claude-sonnet-4.5');
    expect(mapModel('opus')).toBe('claude-opus-4.1');
    expect(mapModel('haiku')).toBe('claude-haiku-4.5');
  });
  it('null/default -> null (omit --model)', () => {
    expect(mapModel(null)).toBeNull();
    expect(mapModel('default')).toBeNull();
  });
  it('passes through an already-Copilot-native id', () => {
    expect(mapModel('gpt-5')).toBe('gpt-5');
  });
});

describe('buildCopilotArgs', () => {
  it('fresh run: flag-only, no prompt (prompt goes via stdin), no --model when unset', () => {
    expect(buildCopilotArgs(makeCtx({ model: null }))).toEqual(['-s', '--no-ask-user', '--allow-all-tools']);
  });
  it('appends the mapped --model', () => {
    expect(buildCopilotArgs(makeCtx({ model: 'sonnet' }))).toEqual([
      '-s', '--no-ask-user', '--allow-all-tools', '--model', 'claude-sonnet-4.5',
    ]);
  });
  it('default model -> no --model flag', () => {
    expect(buildCopilotArgs(makeCtx({ model: 'default' }))).not.toContain('--model');
  });
});

describe('promptFor', () => {
  it('fresh run points at LOOP_TASK.md', () => {
    expect(promptFor(makeCtx({ resume: false }))).toContain('LOOP_TASK.md');
  });
  it('resume run references HANDOFF.md and splices the handoff excerpt', () => {
    const p = promptFor(makeCtx({ resume: true, handoff: 'HANDOFF_STATE_XYZ' }));
    expect(p).toContain('HANDOFF.md');
    expect(p).toContain('HANDOFF_STATE_XYZ');
  });
});

describe('looksUnauthenticated', () => {
  it('flags auth-failure stderr', () => {
    expect(looksUnauthenticated('Error: not authenticated')).toBe(true);
    expect(looksUnauthenticated('please sign in — run copilot login')).toBe(true);
    expect(looksUnauthenticated('HTTP 401 Unauthorized')).toBe(true);
  });
  it('does not flag ordinary output', () => {
    expect(looksUnauthenticated('build succeeded; 3 files changed')).toBe(false);
  });
});

// ---- dispatch: DispatchResult synthesis via an injected spawn (no real copilot) ----

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true, end: () => {}, on: () => {} };
  pid = 4242;
}

function fakeSpawn() {
  const captured: { cmd?: string; args?: string[] } = {};
  let child!: FakeChild;
  const spawnFn = ((cmd: string, args: string[]) => {
    captured.cmd = cmd;
    captured.args = args;
    child = new FakeChild();
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as never;
  return { spawnFn, captured, get child() { return child; } };
}

describe('dispatchCopilot: result synthesis', () => {
  it('exit 0 -> success, synthetic non-null sessionId, null usageJson', async () => {
    const f = fakeSpawn();
    const h = dispatchCopilot(makeCtx(), { spawnFn: f.spawnFn, platform: 'linux' });
    expect(h.pid).toBe(4242);
    f.child.emit('close', 0, null);
    const r = await h.wait;
    expect(r).toMatchObject({ exitCode: 0, resultSubtype: 'success', sessionId: 'copilot-r_test', usageJson: null });
    expect(r.error).toBeUndefined();
  });

  it('non-zero exit (no auth text) -> error', async () => {
    const f = fakeSpawn();
    const h = dispatchCopilot(makeCtx(), { spawnFn: f.spawnFn, platform: 'linux' });
    f.child.emit('close', 2, null);
    const r = await h.wait;
    expect(r.resultSubtype).toBe('error');
    expect(r.error).toBeUndefined();
  });

  it('auth-failure stderr -> resultSubtype auth-required + error', async () => {
    const f = fakeSpawn();
    const h = dispatchCopilot(makeCtx(), { spawnFn: f.spawnFn, platform: 'linux' });
    f.child.stderr.emit('data', Buffer.from('fatal: not authenticated; please run copilot login'));
    f.child.emit('close', 1, null);
    const r = await h.wait;
    expect(r.resultSubtype).toBe('auth-required');
    expect(r.error).toMatch(/not authenticated/i);
  });

  it('emits the synthetic session_id event immediately (so resume survives an early kill)', () => {
    const f = fakeSpawn();
    const events: unknown[] = [];
    dispatchCopilot(makeCtx({ onEvent: (e) => events.push(e) }), { spawnFn: f.spawnFn, platform: 'linux' });
    expect(events).toContainEqual({ session_id: 'copilot-r_test' });
    f.child.emit('close', 0, null);
  });
});

describe('dispatchCopilot: platform launch', () => {
  it('win32 wraps copilot through cmd.exe with a flag-only command string', () => {
    const f = fakeSpawn();
    dispatchCopilot(makeCtx({ model: 'sonnet' }), { spawnFn: f.spawnFn, platform: 'win32' });
    expect(f.captured.cmd).toBe(process.env.ComSpec ?? 'cmd.exe');
    expect(f.captured.args!.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(f.captured.args![3]).toBe('copilot -s --no-ask-user --allow-all-tools --model claude-sonnet-4.5');
    f.child.emit('close', 0, null);
  });

  it('POSIX launches copilot directly with the flag argv', () => {
    const f = fakeSpawn();
    dispatchCopilot(makeCtx({ model: null }), { spawnFn: f.spawnFn, platform: 'linux' });
    expect(f.captured.cmd).toBe('copilot');
    expect(f.captured.args).toEqual(['-s', '--no-ask-user', '--allow-all-tools']);
    f.child.emit('close', 0, null);
  });
});

// ---- integration: auth failure routes the task to attention + pauses the scheduler ----

describe('runTask: copilot auth failure routing', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
    setCachedUsage(10, 10);
  });
  afterEach(() => db.close());

  const GENERIC_BASE = {
    title: 'generic task',
    goal: 'do a thing',
    plan_ref: 'https://example.com/plan.md',
    plan_kind: 'url' as const,
    coding_tool: 'generic',
  };

  it('auth-required -> task attention + scheduler auto-paused (pause_on_auth_fail default)', async () => {
    const authAdapter: Adapter = {
      name: 'copilot-cli',
      dispatch: (): DispatchHandle => ({
        pid: -1,
        wait: Promise.resolve({
          exitCode: 1,
          sessionId: 'copilot-x',
          usageJson: null,
          resultSubtype: 'auth-required',
          signal: null,
          error: 'copilot: not authenticated',
        }),
      }),
    };
    const t = createTask(db, { ...GENERIC_BASE, verification_steps: ['true'] });
    setStatus(db, t.id, 'queued');
    try {
      await runTask(db, getTask(db, t.id)!, { adapter: authAdapter });
      const done = getTask(db, t.id)!;
      expect(done.status).toBe('attention');
      expect(getSetting(db, 'scheduler_paused')).toBe('true');
    } finally {
      fs.rmSync(path.join(paths.outputsDir, t.id), { recursive: true, force: true });
    }
  });
});
