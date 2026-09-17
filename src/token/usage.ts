import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { paths, TOKEN_REFRESH_MS, USAGE_CACHE_FILE } from '../config.js';
import type { UsageReading, UsageLimit } from '../types.js';

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_FILE = USAGE_CACHE_FILE;

interface CacheEnvelope {
  reading: UsageReading;
  ts: number;
  /** Account-wide 429 cooldown (epoch ms) — written by TokenBar's usage-core and by us. */
  blockedUntil?: number;
}

/**
 * 429 cooldown shared with TokenBar (mcp/usage-core.mjs).
 *
 * The limiter is per ACCOUNT, and its hour-long penalty restarts on every request made while it
 * is in force — so a failed read must park every consumer, not just the one that got the 429.
 * TokenBar publishes `blockedUntil` alongside {reading, ts} in the same cross-tool cache file
 * (~/.local/share/claude-usage/usage-cache.json, or $LOOP_USAGE_CACHE here / $CLAUDE_USAGE_CACHE
 * there); honouring it keeps the two tools from taking turns re-triggering the limiter.
 * It also stops this process from retrying on every board tick when the network is simply down:
 * before this, a failed fetch left the cache untouched, so the next call — a second later — tried
 * again, which is how an offline Spark produced hundreds of 429s an hour.
 */
const COOLDOWN_MIN_MS = 60_000;
const COOLDOWN_MAX_MS = 3_900_000;
const COOLDOWN_DEFAULT_MS = 300_000;
const clampCooldown = (ms: number) => Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
/** Remaining cooldown, clamped so a peer's skewed clock can't park us for a week. */
const waitFor = (until?: number) => (typeof until === 'number' && until > Date.now() ? Math.min(until - Date.now(), COOLDOWN_MAX_MS) : 0);

/** A failed live read, carrying the server's Retry-After when it gave one. */
class UsageFetchError extends Error {
  constructor(
    message: string,
    readonly cooldownMs?: number,
  ) {
    super(message);
  }
}

/** Park every consumer without disturbing the last good reading either tool draws from. */
function publishCooldown(cache: CacheEnvelope | null, ms: number): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const base: Record<string, unknown> = cache ? { ...cache } : { ts: 0 };
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...base, blockedUntil: Date.now() + clampCooldown(ms) }));
  } catch {
    /* best effort */
  }
}

/**
 * Read current Claude usage (session 5h + weekly), mirroring TokenBar's usage-core
 * contract exactly. Precedence:
 *   1. LOOP_MOCK_USAGE env (JSON)      — tests / mock adapter, zero network.
 *   2. shared cache file if fresh      — respects the 180s TokenBar cadence AND lets
 *                                         a manual edit (breaker drill) take effect.
 *   3. live fetch of oauth/usage       — writes cache on success.
 *   4. stale cache / degraded reading  — on network failure.
 *
 * This is the single source the scheduler and breaker consult, so a manual write to
 * the cache file is honored on the next read (see writeCache / the M1 breaker test).
 */
export function readUsage(opts: { force?: boolean; refreshMs?: number } = {}): UsageReading {
  const refreshMs = opts.refreshMs ?? TOKEN_REFRESH_MS;

  const mock = process.env.LOOP_MOCK_USAGE;
  if (mock) {
    try {
      return normalize(JSON.parse(mock), 'cache');
    } catch {
      /* fall through */
    }
  }

  const cache = readCache();
  const fresh = cache && Date.now() - cache.ts < refreshMs;
  if (cache && fresh && !opts.force) {
    return { ...cache.reading, source: 'cache' };
  }

  // A cooldown published by TokenBar (or by our own last failure) means: make no request.
  const wait = waitFor(cache?.blockedUntil);
  if (wait > 0 && !opts.force) {
    const msg = `cooldown ${Math.ceil(wait / 1000)}s (shared 429 backoff)`;
    return cache?.reading ? { ...cache.reading, source: 'cache', error: msg } : degraded(msg);
  }

  try {
    const reading = fetchLive();
    writeCache(reading);
    return reading;
  } catch (err) {
    const cooldownMs = err instanceof UsageFetchError && err.cooldownMs ? err.cooldownMs : COOLDOWN_MIN_MS;
    publishCooldown(cache, cooldownMs);
    if (cache?.reading) {
      return { ...cache.reading, source: 'cache', error: `stale: ${String((err as Error).message)}` };
    }
    return degraded(String((err as Error).message));
  }
}

/** TokenBar's usage-core, when this machine has it (TOKENBAR_MCP_DIR). */
function tokenbarCore(): string | null {
  const raw = (process.env.TOKENBAR_MCP_DIR ?? paths.tokenbarMcpDir ?? '').trim();
  if (!raw) return null;
  const dir = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const file = path.join(dir, 'usage-core.mjs');
  return fs.existsSync(file) ? file : null;
}

/**
 * Delegate to TokenBar instead of re-implementing it: one token-resolution order, one shared
 * cache, one 429 cooldown across every tool on the account. Falls back to the port below when
 * TOKENBAR_MCP_DIR isn't configured.
 */
function fetchViaTokenBar(core: string): UsageReading {
  const script = `import { fetchUsage } from ${JSON.stringify(pathToFileURL(core).href)};
    const u = await fetchUsage();
    process.stdout.write(JSON.stringify(u));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  const u = JSON.parse(out) as LooseReading & { ok?: boolean; error?: string; retryAfterSeconds?: number; fromSharedCache?: boolean };
  if (u.ok === false) {
    throw new UsageFetchError(`tokenbar: ${u.error ?? 'unknown'}`, u.retryAfterSeconds ? u.retryAfterSeconds * 1000 : undefined);
  }
  return normalize(u, u.fromSharedCache ? 'cache' : 'api');
}

/** Live fetch + parse of oauth/usage. Throws on any failure. */
function fetchLive(): UsageReading {
  const core = tokenbarCore();
  if (core) return fetchViaTokenBar(core);

  const token = pickToken();
  if (!token) throw new Error('no oauth token (not logged in to Claude Code)');

  // Node >=18 has global fetch; use a sync-ish wrapper via deasync-free approach is not
  // possible, so callers of fetchLive run it inside readUsage which is sync by contract.
  // We use a blocking child process to keep readUsage synchronous and simple.
  const script = `
    const token = process.env.__TOK;
    const r = await fetch(${JSON.stringify(OAUTH_USAGE_URL)}, {
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
        'User-Agent': 'loop-engineering',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      process.stdout.write(JSON.stringify({ __status: r.status, retryAfter: r.headers.get('retry-after') }));
      process.exit(0);
    }
    const d = await r.json();
    process.stdout.write(JSON.stringify(d));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, __TOK: token },
    encoding: 'utf8',
    timeout: 20000,
  });
  const d = JSON.parse(out);
  if (typeof d.__status === 'number') {
    const retry = Number(d.retryAfter);
    throw new UsageFetchError(`HTTP ${d.__status}`, d.__status === 429 ? (Number.isFinite(retry) ? retry * 1000 : COOLDOWN_DEFAULT_MS) : undefined);
  }
  const limits: any[] = Array.isArray(d.limits) ? d.limits : [];
  const s = limits.find((l) => l.kind === 'session');
  const w = limits.find((l) => l.kind === 'weekly_all');
  return normalize(
    {
      ok: true,
      subscription: d.subscription ?? d.subscriptionType ?? null,
      fetchedAt: new Date().toISOString(),
      session: fromLimit(s),
      weekly: fromLimit(w),
    },
    'api',
  );
}

function fromLimit(l: any): UsageLimit {
  const percent = Number(l?.percent ?? l?.utilization ?? 0);
  const resetsAt = l?.resets_at ?? null;
  return {
    percent,
    resetsAt,
    resetsInMinutes: minutesUntil(resetsAt),
    severity: l?.severity ?? 'normal',
  };
}

/** Credential resolution matching TokenBar's usage-core order. */
function pickToken(): string | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const raw = fs.readFileSync(paths.credentials, 'utf8');
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (tok) return tok;
  } catch {
    /* not present (e.g. Linux host not logged in, or Mac uses keychain) */
  }
  // macOS keychain fallback (Mac client only)
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8' },
      ).trim();
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken ?? raw;
      if (tok) return tok;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function minutesUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.round(ms / 60000);
}

interface LooseReading {
  ok?: boolean;
  subscription?: string | null;
  fetchedAt?: string;
  session?: Partial<UsageLimit>;
  weekly?: Partial<UsageLimit>;
  error?: string;
}

function normalize(r: LooseReading, source: UsageReading['source']): UsageReading {
  const lim = (l?: Partial<UsageLimit>): UsageLimit => ({
    percent: Number(l?.percent ?? 0),
    resetsAt: l?.resetsAt ?? null,
    resetsInMinutes: l?.resetsInMinutes ?? minutesUntil(l?.resetsAt ?? null),
    severity: l?.severity ?? 'normal',
  });
  return {
    ok: r.ok ?? true,
    subscription: r.subscription ?? null,
    fetchedAt: r.fetchedAt ?? new Date().toISOString(),
    session: lim(r.session),
    weekly: lim(r.weekly),
    source,
    ...(r.error ? { error: r.error } : {}),
  };
}

function degraded(msg: string): UsageReading {
  return {
    ok: false,
    subscription: null,
    fetchedAt: new Date().toISOString(),
    session: { percent: 0, resetsAt: null, resetsInMinutes: null, severity: 'unknown' },
    weekly: { percent: 0, resetsAt: null, resetsInMinutes: null, severity: 'unknown' },
    source: 'ledger',
    error: msg,
  };
}

// ---- cache file (shared write path; manual edits are honored) ----

export function readCache(): CacheEnvelope | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CacheEnvelope;
  } catch {
    return null;
  }
}

export function writeCache(reading: UsageReading): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ reading, ts: Date.now() }));
  } catch {
    /* best effort */
  }
}

/** Test / CLI helper: force a reading into the shared cache (e.g. breaker drill). */
export function setCachedUsage(session_pct: number, weekly_pct = 0): void {
  writeCache(
    normalize(
      { ok: true, session: { percent: session_pct }, weekly: { percent: weekly_pct } },
      'cache',
    ),
  );
}

export const _cacheFile = CACHE_FILE;
