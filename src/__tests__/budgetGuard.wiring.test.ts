import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { USAGE_CACHE_FILE } from '../config.js';
import { openTestDb } from '../db/index.js';
import { createEngine } from '../engine.js';
import { setCachedUsage } from '../token/usage.js';

/**
 * The budget-guard hook (PreToolUse, inside every claude run) finds the usage cache through
 * LOOP_USAGE_CACHE, which the engine sets. It used to fall back to `${dataDir}/usage-cache.json` —
 * a different file from the one readUsage writes unless LOOP_DATA_DIR was set — or keep a raw
 * `~/...` from the env file, which neither systemd nor node expands. Either way the hook read
 * nothing and failed open: the in-flight 95% brake never fired.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'budget-guard.mjs');
const saved = { cache: process.env.LOOP_USAGE_CACHE, limit: process.env.LOOP_HARD_LIMIT_PCT };

afterEach(() => {
  for (const [key, value] of [
    ['LOOP_USAGE_CACHE', saved.cache],
    ['LOOP_HARD_LIMIT_PCT', saved.limit],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(USAGE_CACHE_FILE, { force: true });
});

/** Exit code of the hook as claude would run it: 2 = block, 0 = allow. */
function runHook(): number {
  try {
    execFileSync(process.execPath, [HOOK], { env: { ...process.env, LOOP_HARD_LIMIT_PCT: '95' }, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

describe('budget-guard hook wiring', () => {
  it('points the hook at the file readUsage writes, so it trips at the hard limit', () => {
    process.env.LOOP_USAGE_CACHE = '~/.local/share/claude-usage/usage-cache.json'; // as .env.example has it
    createEngine(openTestDb());
    expect(process.env.LOOP_USAGE_CACHE).toBe(USAGE_CACHE_FILE);

    setCachedUsage(97);
    expect(runHook()).toBe(2);
    setCachedUsage(40);
    expect(runHook()).toBe(0);
  });
});
