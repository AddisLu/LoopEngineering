import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsage, setCachedUsage, _cacheFile } from '../token/usage.js';

// oauth/usage is rate-limited per account and shared with TokenBar + Claude Code, so
// the reader must reuse caches and sit out cooldowns instead of hitting the network.
// Every case here is answerable without a request; a regression would try a live fetch.
const SHARED = path.join(os.tmpdir(), `loop-usage-shared-${process.pid}.json`);
const ago = (ms: number) => Date.now() - ms;
const HOUR = 3_600_000;

const reading = (pct: number) => ({
  ok: true,
  subscription: 'max',
  fetchedAt: new Date().toISOString(),
  session: { percent: pct, resetsAt: null, resetsInMinutes: null, severity: 'normal' },
  weekly: { percent: 1, resetsAt: null, resetsInMinutes: null, severity: 'normal' },
  source: 'api',
});
const writeJson = (file: string, o: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(o));
};
const clean = () => {
  fs.rmSync(SHARED, { force: true });
  fs.rmSync(_cacheFile, { force: true });
};

beforeEach(() => {
  process.env.LOOP_USAGE_SHARED_CACHE = SHARED;
  clean();
});
afterEach(() => {
  delete process.env.LOOP_USAGE_SHARED_CACHE;
  clean();
});

describe('readUsage — caching and backoff', () => {
  it('serves a fresh reading from its own cache (manual drill honored)', () => {
    setCachedUsage(42);
    const r = readUsage();
    expect(r.session.percent).toBe(42);
    expect(r.source).toBe('cache');
    expect(r.error).toBeUndefined();
  });

  it('reuses a fresher reading from the TokenBar shared cache', () => {
    writeJson(_cacheFile, { reading: reading(10), ts: ago(HOUR) });
    writeJson(SHARED, { v: 1, ts: ago(30_000), sub: 'max', S: { percent: 77, resets_at: null }, W: { percent: 5 } });
    const r = readUsage();
    expect(r.session.percent).toBe(77);
    expect(r.weekly.percent).toBe(5);
    expect(r.source).toBe('cache');
  });

  it('a 429 cooldown in its own cache blocks the fetch and serves the stale reading', () => {
    writeJson(_cacheFile, { reading: reading(33), ts: ago(HOUR), blockedUntil: Date.now() + 600_000 });
    const r = readUsage();
    expect(r.session.percent).toBe(33);
    expect(r.error).toMatch(/backing off/);
  });

  it("a peer's cooldown in the TokenBar shared file blocks the fetch too", () => {
    writeJson(_cacheFile, { reading: reading(33), ts: ago(HOUR) });
    writeJson(SHARED, { v: 1, ts: ago(2 * HOUR), S: { percent: 20 }, W: { percent: 50 }, blockedUntil: Date.now() + 600_000 });
    const r = readUsage();
    expect(r.session.percent).toBe(33); // the newer of the two readings
    expect(r.error).toMatch(/backing off/);
  });

  it('backs off after a non-429 failure instead of retrying every call', () => {
    writeJson(_cacheFile, { reading: reading(8), ts: ago(HOUR), retryAt: Date.now() + 300_000 });
    expect(readUsage().error).toMatch(/backing off/);
    expect(readUsage({ force: true }).error).toMatch(/backing off/);
  });

  it('force still reuses a reading under a minute old', () => {
    setCachedUsage(12);
    const r = readUsage({ force: true });
    expect(r.session.percent).toBe(12);
    expect(r.error).toBeUndefined();
  });

  it('with nothing cached, a cooldown yields a degraded reading and no request', () => {
    writeJson(_cacheFile, { ts: 0, blockedUntil: Date.now() + 600_000 });
    const r = readUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/backing off/);
  });

  it('clamps a skewed peer cooldown to at most 65 minutes', () => {
    writeJson(_cacheFile, { reading: reading(33), ts: ago(HOUR), blockedUntil: Date.now() + 7 * 24 * HOUR });
    const secs = Number(/in (\d+)s/.exec(readUsage().error ?? '')?.[1]);
    expect(secs).toBeLessThanOrEqual(3900);
  });
});
