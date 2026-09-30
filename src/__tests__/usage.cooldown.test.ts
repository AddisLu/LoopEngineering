import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { USAGE_CACHE_FILE, paths } from '../config.js';
import { readUsage, _deps, COOLDOWN_GRACE_MS } from '../token/usage.js';

/**
 * The usage reader shares one cross-tool cache file with TokenBar (mcp/usage-core.mjs), including
 * its account-wide `blockedUntil` 429 cooldown. Before this, a failed fetch left the cache alone,
 * so every board tick retried immediately — an offline Spark generated hundreds of 429s an hour.
 * After that, two holes stayed open: the forced reads at every run boundary went straight through
 * a cooldown, and a reading TokenBar served from cache was written back stamped "now" — wiping the
 * cooldown and passing week-old numbers off as fresh to every tool sharing the file.
 * These tests never touch the network: either a cooldown is in force, or TOKENBAR_MCP_DIR points
 * at a fake usage-core. Credentials are injected too — a test must never read this host's login.
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
let savedEnvToken: string | undefined;
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
/** A usage-core that must not be reached: reaching it leaves a marker the test can check. */
function forbiddenCore(): string {
  const dir = fakeCore(`import fs from 'node:fs'; export async function fetchUsage() { fs.writeFileSync(${JSON.stringify(path.join(os.tmpdir(), 'tokenbar-forbidden-marker'))}, '1'); throw new Error('must not fetch'); }`);
  fs.rmSync(path.join(os.tmpdir(), 'tokenbar-forbidden-marker'), { force: true });
  return dir;
}
const coreWasReached = () => fs.existsSync(path.join(os.tmpdir(), 'tokenbar-forbidden-marker'));

/**
 * A fake usage-core that answers `answer` (a JS expression, evaluated per call so it can use
 * Date.now()) and counts its calls — each one stands for a potential request to oauth/usage.
 */
function countingCore(answer: string): { dir: string; calls: () => number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbar-'));
  const log = path.join(dir, 'calls');
  fs.writeFileSync(
    path.join(dir, 'usage-core.mjs'),
    `import fs from 'node:fs';
     export async function fetchUsage() { fs.appendFileSync(${JSON.stringify(log)}, 'x'); return ${answer}; }`,
  );
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0);
  return { dir, calls };
}

/** What usage-core answers from its caches: a reading taken `ageMs` ago, plus `extra` flags. */
const cachedAnswer = (ageMs: number, extra = '') =>
  `{ ok: true, fromSharedCache: true, subscription: 'max', ${extra}
     fetchedAt: new Date(Date.now() - ${ageMs}).toISOString(),
     session: { percent: 5 }, weekly: { percent: 6 } }`;

const validSession = () => ({ accessToken: 'session-token', expiresAt: Date.now() + 3_600_000 });

beforeEach(() => {
  tmp = '';
  delete process.env.TOKENBAR_MCP_DIR;
  delete process.env.LOOP_MOCK_USAGE;
  savedEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  _deps.readCreds = validSession;
  _deps.readLongLived = () => null;
  fs.rmSync(USAGE_CACHE_FILE, { force: true });
});
afterEach(() => {
  delete process.env.TOKENBAR_MCP_DIR;
  if (savedEnvToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnvToken;
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

  it('ignores a cooldown that has already expired (grace included)', () => {
    tmp = fakeCore(`export async function fetchUsage() { return ${JSON.stringify({ ...reading, source: undefined })}; }`);
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: 0, blockedUntil: Date.now() - COOLDOWN_GRACE_MS - 1000 });

    expect(readUsage().source).toBe('api');
  });

  it('keeps waiting for a grace period after the deadline, so the retry cannot land inside the penalty', () => {
    tmp = forbiddenCore();
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: 0, blockedUntil: Date.now() - 1000 });

    const got = readUsage();

    expect(coreWasReached()).toBe(false);
    expect(got.source).toBe('cache');
    expect(got.error).toMatch(/cooldown/);
  });

  it('honours the cooldown even for a forced read (run boundaries must not restart the hour)', () => {
    tmp = forbiddenCore();
    process.env.TOKENBAR_MCP_DIR = tmp;
    const blockedUntil = Date.now() + 120_000;
    writeCacheFile({ reading, ts: Date.now() - 10 * 60_000, blockedUntil });

    const got = readUsage({ force: true });

    expect(coreWasReached()).toBe(false);
    expect(got.source).toBe('cache');
    expect(got.session.percent).toBe(12);
    expect(cacheFile().blockedUntil).toBe(blockedUntil);
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

  it('never shortens a longer deadline a peer already published', () => {
    // a 429 hour published by TokenBar, then our own read fails for a different reason
    tmp = fakeCore(`export async function fetchUsage() { throw new Error('network down'); }`);
    process.env.TOKENBAR_MCP_DIR = tmp;
    const peerDeadline = Date.now() - COOLDOWN_GRACE_MS - 1000; // expired, so we do try …
    writeCacheFile({ reading, ts: 0, blockedUntil: peerDeadline });

    readUsage();

    // … and the new deadline is ours (≥ 60s out), never pulled back to the peer's old one
    expect(Number(cacheFile().blockedUntil)).toBeGreaterThan(Date.now() + 50_000);
  });

  it('holds a forced read to the cooldown too — the run boundaries must not restart the penalty', () => {
    const core = countingCore(cachedAnswer(0));
    tmp = core.dir;
    process.env.TOKENBAR_MCP_DIR = tmp;
    const blockedUntil = Date.now() + 120_000;
    writeCacheFile({ reading, ts: Date.now() - 10 * 60_000, blockedUntil });

    const got = readUsage({ force: true });

    expect(core.calls()).toBe(0);
    expect(got.source).toBe('cache');
    expect(got.session.percent).toBe(12);
    expect(got.error).toMatch(/cooldown \d+s/);
    expect(cacheFile().blockedUntil).toBe(blockedUntil);
  });

  it('still lets a forced read past the freshness window when no cooldown is in force', () => {
    const core = countingCore(
      `{ ok: true, subscription: 'max', fetchedAt: new Date().toISOString(), session: { percent: 55 }, weekly: { percent: 9 } }`,
    );
    tmp = core.dir;
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: Date.now() - 5_000 }); // fresh: an unforced read would stop here

    const got = readUsage({ force: true });

    expect(core.calls()).toBe(1);
    expect(got.source).toBe('api');
    expect(got.session.percent).toBe(55);
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

  it('treats a frozen reading TokenBar hands back under a 429 as a cooldown, not as a success', () => {
    // usage-core answers a 429 with the last good reading, flagged — never with ok:false
    tmp = fakeCore(
      `export async function fetchUsage() {
         return { ok: true, fromSharedCache: true, rateLimited: true, retryAfterSeconds: 900, cacheAgeSeconds: 7200,
                  subscription: 'max', fetchedAt: ${JSON.stringify(new Date(Date.now() - 7_200_000).toISOString())},
                  session: { percent: 5 }, weekly: { percent: 6 } };
       }`,
    );
    process.env.TOKENBAR_MCP_DIR = tmp;

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.session.percent).toBe(5);
    expect(got.error).toMatch(/cooldown/);
    const after = cacheFile();
    expect(Number(after.blockedUntil)).toBeGreaterThan(Date.now() + 800_000);
    // and the frozen reading keeps its real age instead of being re-dated as fresh
    expect(Number(after.ts)).toBeLessThan(Date.now() - 7_000_000);
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

  it('records a shared-cache reading at its real time and parks when it is stale', () => {
    const takenAt = Date.now() - 3_600_000;
    tmp = fakeCore(
      `export async function fetchUsage() {
         return { ok: true, fromSharedCache: true, cacheAgeSeconds: 3600, subscription: 'max',
                  fetchedAt: ${JSON.stringify(new Date(takenAt).toISOString())},
                  session: { percent: 5 }, weekly: { percent: 6 } };
       }`,
    );
    process.env.TOKENBAR_MCP_DIR = tmp;

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.error).toMatch(/stale/);
    const after = cacheFile();
    expect(Math.abs(Number(after.ts) - takenAt)).toBeLessThan(1000); // not re-dated to now
    expect(Number(after.blockedUntil)).toBeGreaterThan(Date.now() + 50_000); // ≥ 60s before asking again
  });

  it('serves a young shared-cache reading as fresh without publishing a cooldown', () => {
    const takenAt = Date.now() - 30_000;
    tmp = fakeCore(
      `export async function fetchUsage() {
         return { ok: true, fromSharedCache: true, cacheAgeSeconds: 30, subscription: 'max',
                  fetchedAt: ${JSON.stringify(new Date(takenAt).toISOString())},
                  session: { percent: 5 }, weekly: { percent: 6 } };
       }`,
    );
    process.env.TOKENBAR_MCP_DIR = tmp;

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.error).toBeUndefined();
    expect(cacheFile().blockedUntil).toBeUndefined();
    // the next read within the refresh window comes from our own cache, no subprocess
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(readUsage().session.percent).toBe(5);
  });

  it('dates a reading TokenBar served from cache by when it was taken, not when we asked', () => {
    const core = countingCore(cachedAnswer(60_000));
    tmp = core.dir;
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: Date.now() - 10 * 60_000 });

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.error).toBeUndefined(); // under TokenBar's TTL: a normal cache hit, not a failure
    const after = cacheFile();
    expect(after.reading).toMatchObject({ session: { percent: 5 } });
    expect(Date.now() - Number(after.ts)).toBeGreaterThanOrEqual(59_000);
    expect(after.blockedUntil).toBeUndefined();
  });

  it('takes the cooldown TokenBar reports while answering from cache, without re-dating its reading', () => {
    const core = countingCore(cachedAnswer(3_600_000, 'rateLimited: true, retryAfterSeconds: 1800,'));
    tmp = core.dir;
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: Date.now() - 2 * 3_600_000 });

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.error).toMatch(/rate-limited/);
    expect(got.session.percent).toBe(5); // TokenBar's reading is the newer of the two
    const after = cacheFile();
    expect(Number(after.blockedUntil)).toBeGreaterThan(Date.now() + 1_700_000);
    expect(Number(after.blockedUntil)).toBeLessThan(Date.now() + 1_900_000);
    expect(Date.now() - Number(after.ts)).toBeGreaterThanOrEqual(3_590_000);

    readUsage({ force: true });
    expect(core.calls()).toBe(1); // parked — not even a forced read gets through
  });

  it('backs off when TokenBar falls back to an old reading because its request failed', () => {
    const core = countingCore(cachedAnswer(3_600_000));
    tmp = core.dir;
    process.env.TOKENBAR_MCP_DIR = tmp;

    const got = readUsage();

    expect(got.source).toBe('cache');
    expect(got.error).toMatch(/stale: tokenbar: live read failed/);
    const after = cacheFile();
    expect(Number(after.blockedUntil)).toBeGreaterThan(Date.now());
    expect(Date.now() - Number(after.ts)).toBeGreaterThanOrEqual(3_590_000);

    readUsage();
    expect(core.calls()).toBe(1); // no retry on the very next tick
  });

  it('never replaces a newer reading on disk with an older one', () => {
    const core = countingCore(cachedAnswer(120_000));
    tmp = core.dir;
    process.env.TOKENBAR_MCP_DIR = tmp;
    const ts = Date.now() - 30_000;
    writeCacheFile({ reading, ts });

    readUsage({ force: true });

    expect(cacheFile()).toMatchObject({ ts, reading: { session: { percent: 12 } } });
  });
});

describe('readUsage credentials', () => {
  it('makes no request at all with an expired session token and nothing to fall back on', () => {
    _deps.readCreds = () => ({ accessToken: 'old', expiresAt: Date.now() - 1000 });
    tmp = forbiddenCore();
    process.env.TOKENBAR_MCP_DIR = tmp;
    writeCacheFile({ reading, ts: 0 });

    const got = readUsage();

    expect(coreWasReached()).toBe(false);
    expect(got.source).toBe('cache');
    expect(got.error).toMatch(/login expired/);
    // parked for the default pause, not the 60s network one: the login will not fix itself
    const until = Number(cacheFile().blockedUntil);
    expect(until).toBeGreaterThan(Date.now() + 250_000);
    expect(until).toBeLessThan(Date.now() + 350_000);
  });

  it('falls back to the long-lived setup-token when the session token has expired', () => {
    _deps.readCreds = () => ({ accessToken: 'old', expiresAt: Date.now() - 1000 });
    _deps.readLongLived = () => 'long-lived-token';
    tmp = fakeCore(`export async function fetchUsage() { return ${JSON.stringify({ ...reading, source: undefined })}; }`);
    process.env.TOKENBAR_MCP_DIR = tmp;

    expect(readUsage().source).toBe('api');
  });

  it('degrades with a clear message when this host has never logged in', () => {
    _deps.readCreds = () => null;
    tmp = forbiddenCore();
    process.env.TOKENBAR_MCP_DIR = tmp;

    const got = readUsage();

    expect(coreWasReached()).toBe(false);
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/not logged in/);
  });
});

describe('the test suite itself', () => {
  it('has no Claude login and no TokenBar to reach the usage endpoint with', () => {
    const data = process.env.LOOP_DATA_DIR!;
    expect(data).toBeTruthy();
    expect(paths.credentials.startsWith(data)).toBe(true);
    expect(paths.tokenCache.startsWith(data)).toBe(true);
    expect(paths.tokenbarMcpDir).toBeNull();
    expect(savedEnvToken ?? '').toBe('');
  });

  it('writes built-in benchmark repos under its own data dir, never ~/Addis/spikes', async () => {
    const { DEFAULT_SETTINGS } = await import('../config.js');
    expect(DEFAULT_SETTINGS.spike_root.startsWith(process.env.LOOP_DATA_DIR!)).toBe(true);
  });
});
