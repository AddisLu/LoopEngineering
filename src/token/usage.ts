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
/**
 * How long past a published deadline this process keeps waiting before it asks again. The board
 * reads usage every second, so without a margin the retry lands within a second of the deadline —
 * inside the penalty whenever the server rounded Retry-After down or the clocks differ by a
 * second — and restarts the hour for every tool on the account.
 */
export const COOLDOWN_GRACE_MS = 30_000;
const clampCooldown = (ms: number) => Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
/** Remaining wait (deadline + grace), clamped so a peer's skewed clock can't park us for a week. */
const waitFor = (until?: number) => {
  if (typeof until !== 'number') return 0;
  const left = until + COOLDOWN_GRACE_MS - Date.now();
  return left > 0 ? Math.min(left, COOLDOWN_MAX_MS) : 0;
};

const AUTH_EXPIRED = 'Claude Code login expired on this host — run `claude` here once (or `claude setup-token`) to refresh it';

/** A failed live read, carrying the server's Retry-After when it gave one. */
class UsageFetchError extends Error {
  constructor(
    message: string,
    readonly cooldownMs?: number,
  ) {
    super(message);
  }
}

/** What a live read produced: a reading of our own, or a copy TokenBar served from a shared cache. */
interface LiveResult {
  reading: UsageReading;
  /** true = fetched from the API just now; false = a cached copy TokenBar handed back */
  live: boolean;
  /** when the reading was actually taken (epoch ms) */
  takenAt: number;
  /** a pause TokenBar asked for (its 429 Retry-After), when it did */
  cooldownMs?: number;
  note?: string;
}

/** Write the whole envelope atomically, so a reader never sees a half-written file (and fetches). */
function writeEnvelope(env: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = `${CACHE_FILE}.tmp${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(env));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Park every consumer without disturbing the last good reading either tool draws from. The file
 * is re-read first — a peer may have written a newer reading or a longer deadline while we were
 * fetching — and a deadline is only ever pushed out, never pulled in: our 60s network pause must
 * not cut short the hour a 429 asked for. (Bounded, so a bogus value never parks anyone for good.)
 */
function publishCooldown(ms: number): void {
  try {
    const cur = readCache();
    const base: Record<string, unknown> = cur ? { ...cur } : { ts: 0 };
    const now = Date.now();
    const wanted = Math.max(typeof cur?.blockedUntil === 'number' ? cur.blockedUntil : 0, now + clampCooldown(ms));
    writeEnvelope({ ...base, blockedUntil: Math.min(wanted, now + COOLDOWN_MAX_MS) });
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
 *
 * `force` skips the freshness window only. A cooldown still holds: a request inside the penalty
 * cannot get a reading anyway, and it restarts the hour for every tool on the account.
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
  if (wait > 0) {
    const msg = `cooldown ${Math.ceil(wait / 1000)}s (shared backoff)`;
    return cache?.reading ? { ...cache.reading, source: 'cache', error: msg } : degraded(msg);
  }

  try {
    const got = fetchLive();
    if (got.live) {
      writeCache(got.reading); // blockedUntil dropped: the budget is evidently back
      // say so in the journal when this ends an outage, not on every routine refresh
      if (!cache || cache.blockedUntil || Date.now() - cache.ts > refreshMs * 2) {
        console.log(`[usage] live reading: session ${got.reading.session.percent}% weekly ${got.reading.weekly.percent}%${cache?.blockedUntil ? ' (cooldown over)' : ''}`);
      }
      return got.reading;
    }
    // TokenBar answered from a shared cache. Keep the reading's true age — re-dating it would let
    // a week-old number pass for fresh, for us and for every bar reading this file — and keep the
    // cooldown envelope. A copy older than our refresh window means TokenBar could not fetch
    // either, so park for a minute (or as long as its 429 asks) instead of asking again next second.
    const ageMs = Date.now() - got.takenAt;
    const stale = ageMs >= refreshMs;
    const cur = readCache();
    writeEnvelope({ ...(cur ?? {}), reading: got.reading, ts: got.takenAt });
    const note = got.note ?? (stale ? `stale: TokenBar could not fetch a live reading (cached ${Math.round(ageMs / 1000)}s ago)` : undefined);
    if (got.cooldownMs || stale) {
      const ms = got.cooldownMs ?? COOLDOWN_MIN_MS;
      publishCooldown(ms);
      console.warn(`[usage] TokenBar answered from cache (${Math.round(ageMs / 1000)}s old): ${note} — pausing ${Math.ceil(ms / 1000)}s`);
    }
    return { ...got.reading, source: 'cache', ...(note ? { error: note } : {}) };
  } catch (err) {
    const cooldownMs = err instanceof UsageFetchError && err.cooldownMs ? err.cooldownMs : COOLDOWN_MIN_MS;
    publishCooldown(cooldownMs);
    console.warn(`[usage] live read failed: ${String((err as Error).message).slice(0, 200)} — pausing ${Math.ceil(clampCooldown(cooldownMs) / 1000)}s (shared cooldown)`);
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

interface TokenBarAnswer extends LooseReading {
  hint?: string;
  retryAfterSeconds?: number;
  /** the reading is a copy from a shared cache (a peer's, or this file's), not a fetch of its own */
  fromSharedCache?: boolean;
  cacheAgeSeconds?: number;
  /** a 429 cooldown is in force; the reading is the last good one, frozen */
  rateLimited?: boolean;
}

/**
 * Delegate to TokenBar instead of re-implementing it: one token-resolution order, one shared
 * cache, one 429 cooldown across every tool on the account. Falls back to the port below when
 * TOKENBAR_MCP_DIR isn't configured.
 *
 * usage-core never throws for a failed fetch when it has a cached copy to answer with: it returns
 * that copy with `fromSharedCache` (and `rateLimited` under a 429). Such an answer is not a live
 * reading and must not be recorded as one.
 */
function fetchViaTokenBar(core: string): LiveResult {
  const script = `import { fetchUsage } from ${JSON.stringify(pathToFileURL(core).href)};
    const u = await fetchUsage();
    process.stdout.write(JSON.stringify(u));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  const u = JSON.parse(out) as TokenBarAnswer;
  const retryMs = u.retryAfterSeconds ? u.retryAfterSeconds * 1000 : undefined;
  if (u.ok === false) {
    const authProblem = u.error === 'auth-expired' || u.error === 'not-logged-in';
    throw new UsageFetchError(`tokenbar: ${u.error ?? 'unknown'}${u.hint ? ` — ${u.hint}` : ''}`, retryMs ?? (authProblem ? COOLDOWN_DEFAULT_MS : undefined));
  }
  if (!u.fromSharedCache) return { reading: normalize(u, 'api'), live: true, takenAt: Date.now() };

  const fetched = Date.parse(u.fetchedAt ?? '');
  const takenAt = Number.isFinite(fetched) ? fetched : typeof u.cacheAgeSeconds === 'number' ? Date.now() - u.cacheAgeSeconds * 1000 : 0;
  const reading = normalize(u, 'cache');
  if (u.rateLimited) {
    const ms = retryMs ?? COOLDOWN_DEFAULT_MS;
    return { reading, live: false, takenAt, cooldownMs: ms, note: `cooldown ${Math.ceil(ms / 1000)}s (shared backoff)` };
  }
  return { reading, live: false, takenAt };
}

/** Live fetch + parse of oauth/usage. Throws on any failure. */
function fetchLive(): LiveResult {
  // Credentials first, whichever path fetches: a token known to be expired must not be sent —
  // every 401 it earns is a request against the same limiter, and one a minute is how a five-day
  // outage was kept alive. The board says what to do instead.
  const token = pickToken();
  if (!token) throw new UsageFetchError('no oauth token (not logged in to Claude Code)', COOLDOWN_DEFAULT_MS);
  if (token.kind === 'session-stale') throw new UsageFetchError(AUTH_EXPIRED, COOLDOWN_DEFAULT_MS);

  const core = tokenbarCore();
  if (core) return fetchViaTokenBar(core);

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
    env: { ...process.env, __TOK: token.tok },
    encoding: 'utf8',
    timeout: 20000,
  });
  const d = JSON.parse(out);
  if (typeof d.__status === 'number') {
    const status: number = d.__status;
    if (status === 401 || status === 403) throw new UsageFetchError(`HTTP ${status}: ${AUTH_EXPIRED}`, COOLDOWN_DEFAULT_MS);
    const retry = Number(d.retryAfter);
    throw new UsageFetchError(`HTTP ${status}`, status === 429 ? (Number.isFinite(retry) ? retry * 1000 : COOLDOWN_DEFAULT_MS) : undefined);
  }
  const limits: any[] = Array.isArray(d.limits) ? d.limits : [];
  const s = limits.find((l) => l.kind === 'session');
  const w = limits.find((l) => l.kind === 'weekly_all');
  const reading = normalize(
    {
      ok: true,
      subscription: d.subscription ?? d.subscriptionType ?? null,
      fetchedAt: new Date().toISOString(),
      session: fromLimit(s),
      weekly: fromLimit(w),
    },
    'api',
  );
  return { reading, live: true, takenAt: Date.now() };
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

// ---- credentials (TokenBar's resolution order) ----

interface OauthCreds {
  accessToken?: string;
  expiresAt?: number;
}

function defaultReadCreds(): OauthCreds | null {
  try {
    const c = JSON.parse(fs.readFileSync(paths.credentials, 'utf8'))?.claudeAiOauth;
    if (c && typeof c === 'object') return c as OauthCreds;
  } catch {
    /* not present (e.g. Linux host not logged in, or Mac uses keychain) */
  }
  // macOS keychain fallback (Mac client only)
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' }).trim();
      const c = JSON.parse(raw)?.claudeAiOauth;
      if (c && typeof c === 'object') return c as OauthCreds;
      if (raw) return { accessToken: raw };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** The long-lived token from `claude setup-token`, where TokenBar keeps it (TOKENBAR_TOKEN_CACHE). */
function defaultReadLongLived(): string | null {
  try {
    const t = fs.readFileSync(paths.tokenCache, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Injection points for tests, which must never read this host's real credentials. */
export const _deps = { readCreds: defaultReadCreds, readLongLived: defaultReadLongLived };

interface Token {
  tok: string;
  /** 'session-stale' = the only token we have is a session token that has already expired */
  kind: 'env' | 'session' | 'longlived' | 'session-stale';
}

/**
 * Credential resolution matching TokenBar's usage-core: an explicit env token, else the session
 * token while it is still valid, else the long-lived setup-token, else the expired session token
 * — flagged, so the caller can decline to send it.
 */
function pickToken(): Token | null {
  const env = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  if (env) return { tok: env, kind: 'env' };
  const c = _deps.readCreds() ?? {};
  const valid = !!c.accessToken && (typeof c.expiresAt !== 'number' || Date.now() < c.expiresAt - 60_000);
  if (c.accessToken && valid) return { tok: c.accessToken, kind: 'session' };
  const longTok = _deps.readLongLived();
  if (longTok) return { tok: longTok, kind: 'longlived' };
  if (c.accessToken) return { tok: c.accessToken, kind: 'session-stale' };
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

/** Record a live reading. blockedUntil is dropped on purpose: a success means the budget is back. */
export function writeCache(reading: UsageReading): void {
  try {
    writeEnvelope({ reading, ts: Date.now() });
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
