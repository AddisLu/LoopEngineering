import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { USAGE_CACHE_FILE } from '../config.js';
import { readUsage } from '../token/usage.js';

/**
 * The usage reader shares one cross-tool cache file with TokenBar (mcp/usage-core.mjs), including
 * its account-wide `blockedUntil` 429 cooldown. Before this, a failed fetch left the cache alone,
 * so every board tick retried immediately — an offline Spark generated hundreds of 429s an hour.
 * These tests never touch the network: either a cooldown is in force, or TOKENBAR_MCP_DIR points
 * at a fake usage-core.
 */

const reading = {
  ok: true,
  subscription: 'max',
  fetchedAt: '2026-09-17T00:00:00.000Z',
  session: { percent: 12, resetsAt: null, resetsInMinutes: null, severity: 'normal' },
  weekly: { percent: 34, resetsAt: null, resetsInMinutes: null, severity: 'normal' },
  source: 'api',
};

let tmp: string;
const writeCacheFile = (envelope: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(envelope));
};
const cacheFile = () => JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8')) as Record<string, unknown>;

function fakeCore(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbar-'));
  fs.writeFileSync(path.join(dir, 'usage-core.mjs'), body);
  return dir;
}

beforeEach(() => {
  tmp = '';
  delete process.env.TOKENBAR_MCP_DIR;
  delete process.env.LOOP_MOCK_USAGE;
  fs.rmSync(USAGE_CACHE_FILE, { force: true });
});
afterEach(() => {
  delete process.env.TOKENBAR_MCP_DIR;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(USAGE_CACHE_FILE, { force: true });
});

describe('readUsage cooldown (shared with TokenBar)', () => {
  it('serves the stale reading and makes no request while a cooldown is in force', () => {
    const blockedUntil = Date.now() + 120_000;
    writeCacheFile({ reading, ts: Date.now() - 10 * 60_000, blockedUntil });

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.session.percent).toBe(12);
    expect(got.error).toMatch(/cooldown \d+s/);
    // the cooldown must survive untouched — rewriting it would let the storm restart
    expect(cacheFile().blockedUntil).toBe(blockedUntil);
  });

  it('degrades but still refuses to fetch when the cooldown has no reading behind it', () => {
    writeCacheFile({ ts: 0, blockedUntil: Date.now() + 60_000 });
    const got = readUsage();
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/cooldown/);
  });

  it('ignores a cooldown that has already expired', () => {
    tmp = fakeCore(`export async function fetchUsage() { return ${JSON.stringify({ ...reading, source: undefined })}; }`);
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: 0, blockedUntil: Date.now() - 1000 });

    expect(readUsage().source).toBe('api');
  });

  it('publishes a cooldown when the read fails, so the next tick cannot retry immediately', () => {
    tmp = fakeCore(`export async function fetchUsage() { throw new Error('network down'); }`);
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: 0 });

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.error).toMatch(/stale:/);
    const after = cacheFile();
    expect(Number(after.blockedUntil)).toBeGreaterThan(Date.now());
    expect(after.reading).toBeTruthy(); // the last good reading is preserved for both tools
  });

  it('turns TokenBar’s own rate-limit answer into a cooldown of the length it asks for', () => {
    tmp = fakeCore(`export async function fetchUsage() { return { ok: false, error: 'rate-limited', retryAfterSeconds: 900 }; }`);
    process.env.TOKENBAR_MCP_DIR = tmp;

    const got = readUsage();

    expect(got.ok).toBe(false);
    const until = Number(cacheFile().blockedUntil);
    expect(until).toBeGreaterThan(Date.now() + 800_000);
    expect(until).toBeLessThan(Date.now() + 1_000_000);
  });
});

describe('readUsage delegation to TokenBar', () => {
  it('uses TokenBar usage-core when TOKENBAR_MCP_DIR is set, instead of its own fetch', () => {
    tmp = fakeCore(
      `export async function fetchUsage() {
         return { ok: true, subscription: 'max', fetchedAt: '2026-09-17T01:00:00.000Z',
                  session: { percent: 71, resets_at: null }, weekly: { percent: 8, resets_at: null } };
       }`,
    );
    process.env.TOKENBAR_MCP_DIR = tmp;

    const got = readUsage();

    expect(got.source).toBe('api');
    expect(got.session.percent).toBe(71);
    expect(got.weekly.percent).toBe(8);
    expect(cacheFile().reading).toMatchObject({ session: { percent: 71 } });
  });

  it('marks a reading that TokenBar served from its shared cache as cached, not fresh', () => {
    tmp = fakeCore(
      `export async function fetchUsage() {
         return { ok: true, fromSharedCache: true, subscription: 'max', fetchedAt: '2026-09-17T01:00:00.000Z',
                  session: { percent: 5 }, weekly: { percent: 6 } };
       }`,
    );
    process.env.TOKENBAR_MCP_DIR = tmp;

    expect(readUsage().source).toBe('cache');
  });
});
