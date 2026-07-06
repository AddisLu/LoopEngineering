import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { pickAdapter } from '../orchestrator/run.js';
import { mockAdapter } from '../orchestrator/adapters/mock.js';
import { claudeCodeAdapter } from '../orchestrator/adapters/claudeCode.js';
import { getBackend, registerBackend, registeredBackends } from '../orchestrator/adapters/registry.js';
import type { Adapter, DispatchHandle } from '../orchestrator/adapters/types.js';

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
});

const BASE = {
  title: 't',
  goal: 'g',
  plan_ref: 'https://example.com/p.md',
  plan_kind: 'url' as const,
  repo_path: '/tmp/repo',
  base_branch: 'main',
};

// A spy backend registered only for this suite, proving `agent_backend` swaps the
// dispatched adapter without a real external CLI (no Copilot needed).
const echoAdapter: Adapter = {
  name: 'echo-test',
  dispatch: (): DispatchHandle => ({ pid: -1, wait: Promise.resolve({ exitCode: 0, sessionId: null, usageJson: null, resultSubtype: 'success', signal: null }) }),
};
registerBackend('echo-test', echoAdapter);

describe('backend registry', () => {
  it('getBackend returns the registered adapter by name', () => {
    expect(getBackend('claude-code')).toBe(claudeCodeAdapter);
    expect(getBackend('mock')).toBe(mockAdapter);
    expect(getBackend('echo-test')).toBe(echoAdapter);
  });

  it('unknown backend id falls back to claude-code (never throws)', () => {
    expect(getBackend('copilot-cli')).toBe(claudeCodeAdapter);
    expect(getBackend('nonsense')).toBe(claudeCodeAdapter);
  });

  it('registeredBackends lists claude-code and mock by default', () => {
    const ids = registeredBackends();
    expect(ids).toContain('claude-code');
    expect(ids).toContain('mock');
  });
});

describe('pickAdapter: agent_backend selection', () => {
  it('default (unset agent_backend) -> claude-code adapter for coding_tool=claude-code', () => {
    const t = getTask(db, createTask(db, { ...BASE, coding_tool: 'claude-code' }).id)!;
    expect(pickAdapter(t, db)).toBe(claudeCodeAdapter);
  });

  it('default (unset agent_backend) -> claude-code adapter for coding_tool=generic too', () => {
    const t = getTask(db, createTask(db, { ...BASE, coding_tool: 'generic' }).id)!;
    expect(pickAdapter(t, db)).toBe(claudeCodeAdapter);
  });

  it('setting agent_backend swaps the real backend for both claude-code and generic', () => {
    setSetting(db, 'agent_backend', 'echo-test');
    const claudeCodeTask = getTask(db, createTask(db, { ...BASE, coding_tool: 'claude-code' }).id)!;
    const genericTask = getTask(db, createTask(db, { ...BASE, coding_tool: 'generic' }).id)!;
    expect(pickAdapter(claudeCodeTask, db)).toBe(echoAdapter);
    expect(pickAdapter(genericTask, db)).toBe(echoAdapter);
  });

  it('coding_tool=mock always dispatches mockAdapter regardless of agent_backend', () => {
    setSetting(db, 'agent_backend', 'echo-test');
    const t = getTask(db, createTask(db, { ...BASE, coding_tool: 'mock' }).id)!;
    expect(pickAdapter(t, db)).toBe(mockAdapter);
  });

  it('unrecognized agent_backend value falls back to claude-code, not a throw', () => {
    setSetting(db, 'agent_backend', 'copilot-cli'); // reserved, no adapter registered yet
    const t = getTask(db, createTask(db, { ...BASE, coding_tool: 'claude-code' }).id)!;
    expect(pickAdapter(t, db)).toBe(claudeCodeAdapter);
  });

  it('unknown coding_tool still throws (plan/deploy are handled before pickAdapter, never reach it)', () => {
    const t = getTask(db, createTask(db, { ...BASE, coding_tool: 'bogus' }).id)!;
    expect(() => pickAdapter(t, db)).toThrow(/unknown coding_tool/);
  });
});
