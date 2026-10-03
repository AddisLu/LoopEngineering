import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { USAGE_CACHE_FILE } from '../config.js';
import { readUsage, claudeLoginExpired, _deps, _resetHub } from '../token/usage.js';

/**
 * A TokenBar hub (the Raspberry Pi) keeps its own Claude login and reads usage for the account.
 * Before this, the engine checked this host's login first — expired, so it never asked the hub and
 * kept a stale reading with "login expired" while the hub had the live numbers. The hub is injected:
 * no network.
 */

const saved = { ..._deps };
const savedEnv = process.env.TOKENBAR_SHARED_CACHE;
let hubCalls = 0;
const hub = (ageMs: number) => () => (
  hubCalls++,
  {
    v: 1,
    ts: Date.now() - ageMs,
    sub: 'max',
    S: { percent: 10, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString(), severity: 'normal' },
    W: { percent: 44, resets_at: new Date(Date.now() + 30 * 3_600_000).toISOString(), severity: 'normal' },
  }
);
const writeCacheFile = (envelope: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(envelope));
};

beforeEach(() => {
  hubCalls = 0;
  _resetHub();
  fs.rmSync(USAGE_CACHE_FILE, { force: true });
  process.env.TOKENBAR_SHARED_CACHE = 'http://hub.test:8787/usage.json';
  // this host's login expired long ago
  _deps.readCreds = () => ({ accessToken: 'stale', expiresAt: Date.now() - 86_400_000 });
  _deps.readLongLived = () => null;
});
afterEach(() => {
  Object.assign(_deps, saved);
  if (savedEnv === undefined) delete process.env.TOKENBAR_SHARED_CACHE;
  else process.env.TOKENBAR_SHARED_CACHE = savedEnv;
  fs.rmSync(USAGE_CACHE_FILE, { force: true });
});

describe('usage from a TokenBar hub', () => {
  it('a fresh hub reading is used despite an expired login here and a cooldown in force', () => {
    writeCacheFile({ reading: { ok: true, subscription: 'max', fetchedAt: 'x', session: { percent: 0 }, weekly: { percent: 39 }, source: 'cache' }, ts: Date.now() - 3_600_000, blockedUntil: Date.now() + 300_000 });
    _deps.readHub = hub(120_000);
    const u = readUsage({ force: true });
    expect([u.session.percent, u.weekly.percent, u.error]).toEqual([10, 44, undefined]);
    expect(u.session.resetsInMinutes).toBe(180);
    // stored at its real age, the cooldown left standing for the tools that do send requests
    const file = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
    expect(Date.now() - file.ts).toBeGreaterThanOrEqual(120_000);
    expect(file.blockedUntil).toBeGreaterThan(Date.now());
    // the login is still expired: cloud tasks stay held
    expect(claudeLoginExpired()).toBe(true);
  });

  it('asks the hub at most once a minute', () => {
    _deps.readHub = hub(0);
    readUsage({ force: true });
    readUsage({ force: true });
    expect(hubCalls).toBe(1);
  });

  it('a hub gone quiet (older than 10 min) is not used: the expired login is reported', () => {
    _deps.readHub = hub(11 * 60_000);
    const u = readUsage({ force: true });
    expect(u.error).toMatch(/login expired/);
  });

  it('a valid login here is not expired', () => {
    _deps.readCreds = () => ({ accessToken: 'ok', expiresAt: Date.now() + 3_600_000 });
    expect(claudeLoginExpired()).toBe(false);
  });
});
