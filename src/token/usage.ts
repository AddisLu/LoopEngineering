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

/**
 * usage-core (SHARED_TTL there) answers from its caches *instead of* a request only while the
 * newest reading is younger than this. It also falls back to that same reading, unflagged, when
 * a request it did make fails (network, expired token, HTTP error) — so an older reading coming
 * back from it means a failed read, not a fresh one.
 */
const TOKENBAR_SHARED_TTL_MS = 240_000;

const AUTH_EXPIRED = 'Claude Code login expired on this host — run `claude` here once to refresh it';

/** A reading plus the time it was really taken from oauth/usage (not when we last looked at it). */
interface Served {
  reading: UsageReading;
  ts: number;
}

/**
 * A failed live read, carrying the server's Retry-After when it gave one, and the reading TokenBar
 * served alongside the failure — which can be newer than ours (a peer machine's).
 */
class UsageFetchError extends Error {
  constructor(
    message: string,
    readonly cooldownMs?: number,
    readonly served?: Served,
  ) {
    super(message);
  }
}

/**
 * Park every consumer without disturbing the last good reading either tool draws from. `base` is
 * the file as it stands after the failed read — a peer may have written a newer reading or a longer
 * deadline meanwhile — with TokenBar's reading laid over it when that one is newer. A deadline is
 * only ever pushed out, never pulled in: our 60s network pause must not cut short the hour a 429
 * asked for. (Bounded, so a bogus value never parks anyone for good.) Returns the deadline.
 */
function publishCooldown(base: Partial<CacheEnvelope> | null, ms: number): number {
  const now = Date.now();
  const standing = typeof base?.blockedUntil === 'number' ? base.blockedUntil : 0;
  const blockedUntil = Math.min(Math.max(standing, now + clampCooldown(ms)), now + COOLDOWN_MAX_MS);
  writeEnvelope({ ...(base ?? { ts: 0 }), blockedUntil });
  return blockedUntil;
}

/**
 * Read current Claude usage (session 5h + weekly), mirroring TokenBar's usage-core
 * contract exactly. Precedence:
 *   1. LOOP_MOCK_USAGE env (JSON)      — tests / mock adapter, zero network.
 *   2. shared cache file if fresh      — TokenBar's 240s window; lets a manual edit
 *                                         (breaker drill) take effect. `force` skips it.
 *   3. 429 cooldown in the file        — cached reading, NO request, until the deadline
 *                                         plus a grace. `force` included: a request during
 *                                         the penalty restarts it.
 *   4. live read of oauth/usage        — direct, or via TokenBar's usage-core when
 *                                         TOKENBAR_MCP_DIR is set; stored with the time
 *                                         it was really taken. Never with a session token
 *                                         known to be expired.
 *   5. stale cache / degraded reading  — on failure, with a cooldown published.
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
  const fresh = cache?.reading && Date.now() - cache.ts < refreshMs;
  if (cache && fresh && !opts.force) {
    return rollOver({ ...cache.reading, source: 'cache' });
  }

  // A TokenBar hub (another machine that keeps its own login and reads for the account) answers
  // without a request to the usage endpoint — so neither a cooldown nor this host's expired login
  // stands in its way. Before this, an expired login here hid the hub's live numbers for good.
  const hub = hubReading();
  if (hub) {
    storeReading(hub);
    lastFailure = null;
    return rollOver(hub.reading);
  }

  // A cooldown published by TokenBar (or by our own last failure) means: make no request — and
  // `force` does not override it. The run boundaries force a read before and after every Claude
  // task; letting those through a cooldown is what kept the account's usage endpoint locked.
  const wait = waitFor(cache?.blockedUntil);
  if (wait > 0) {
    // say WHY there is a cooldown (an expired login reads very differently from a 429)
    const msg = `cooldown ${Math.ceil(wait / 1000)}s (shared backoff)${lastFailure ? `: ${lastFailure.message.slice(0, 160)}` : ''}`;
    return cache?.reading ? rollOver({ ...cache.reading, source: 'cache', error: msg }) : degraded(msg);
  }

  try {
    const live = fetchLive();
    storeReading(live);
    lastFailure = null;
    // say so in the journal when this ends an outage, not on every routine refresh
    if (live.reading.source === 'api' && (!cache || Date.now() - cache.ts > refreshMs * 2)) {
      console.log(`[usage] live reading: session ${live.reading.session.percent}% weekly ${live.reading.weekly.percent}% (first in ${cache ? Math.round((Date.now() - cache.ts) / 60000) : 0} min)`);
    }
    return live.reading;
  } catch (err) {
    const message = String((err as Error).message);
    lastFailure = { message, at: Date.now() };
    const cooldownMs = err instanceof UsageFetchError && err.cooldownMs ? err.cooldownMs : COOLDOWN_MIN_MS;
    // Re-read: TokenBar's usage-core may have just written this file itself. Draw from whichever
    // reading is newer — ours, or the one TokenBar served alongside the failure — at its real age.
    const onDisk = readCache() ?? cache;
    const served = err instanceof UsageFetchError ? err.served : undefined;
    const base = served && (!onDisk?.reading || served.ts > onDisk.ts) ? { ...onDisk, ...served } : onDisk;
    const until = publishCooldown(base, cooldownMs);
    console.warn(`[usage] live read failed: ${message.slice(0, 200)} — pausing ${Math.ceil((until - Date.now()) / 1000)}s (shared cooldown)`);
    if (base?.reading) {
      return rollOver({ ...base.reading, source: 'cache', error: `stale: ${message}` });
    }
    return degraded(message);
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
function fetchViaTokenBar(core: string): Served {
  const script = `import { fetchUsage } from ${JSON.stringify(pathToFileURL(core).href)};
    const u = await fetchUsage();
    process.stdout.write(JSON.stringify(u));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  const u = JSON.parse(out) as TokenBarAnswer;
  const retryMs = u.retryAfterSeconds ? u.retryAfterSeconds * 1000 : undefined;
  if (u.ok === false) {
    // a login problem will not fix itself within a minute: park for the default pause
    const authProblem = u.error === 'auth-expired' || u.error === 'not-logged-in';
    throw new UsageFetchError(`tokenbar: ${u.error ?? 'unknown'}${u.hint ? ` — ${u.hint}` : ''}`, retryMs ?? (authProblem ? COOLDOWN_DEFAULT_MS : undefined));
  }
  // Date the reading by when it was taken, never by when we asked: stamping a cached reading
  // "now" made week-old numbers look fresh to every tool sharing the file and wiped the cooldown.
  // A peer's clock can run ahead of ours, so never date it into the future either.
  const now = Date.now();
  const taken = Date.parse(u.fetchedAt ?? '');
  let ts: number;
  if (Number.isFinite(taken)) ts = Math.min(taken, now);
  else if (typeof u.cacheAgeSeconds === 'number') ts = now - u.cacheAgeSeconds * 1000;
  else ts = u.fromSharedCache ? 0 : now; // a cached copy of unknown age is never passed off as fresh
  const served: Served = { reading: normalize(u, u.fromSharedCache ? 'cache' : 'api'), ts };
  // usage-core answers a cooldown (its own 429, or one a peer published) with ok:true and its last
  // good reading. That is a failed read: take the cooldown it reports.
  if (u.rateLimited) {
    const ms = retryMs ?? COOLDOWN_DEFAULT_MS;
    throw new UsageFetchError(`tokenbar: rate-limited (cooldown ${Math.ceil(ms / 1000)}s)`, ms, served);
  }
  // Past its TTL, a cached answer is usage-core's fallback after a request it made failed.
  if (u.fromSharedCache && now - served.ts >= TOKENBAR_SHARED_TTL_MS) {
    throw new UsageFetchError('tokenbar: live read failed', undefined, served);
  }
  return served;
}

/** Live read of oauth/usage, with the time the reading was taken. Throws on any failure. */
function fetchLive(): Served {
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
  const ts = Date.now();
  return {
    reading: normalize(
      {
        ok: true,
        subscription: d.subscription ?? d.subscriptionType ?? null,
        fetchedAt: new Date(ts).toISOString(),
        session: fromLimit(s),
        weekly: fromLimit(w),
      },
      'api',
    ),
    ts,
  };
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
export const _deps = { readCreds: defaultReadCreds, readLongLived: defaultReadLongLived, readHub: defaultReadHub };

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

/**
 * A cached reading answers for its own time: a window whose reset time has passed since is over —
 * its percent no longer applies (0, severity unknown) — and the minutes to a reset still ahead are
 * counted from now, not from when the reading was taken. Without this an old reading (the login
 * expired two days ago) kept a long-gone 88% on the board and held every dispatch.
 */
export function rollOver(r: UsageReading, now = Date.now()): UsageReading {
  const lim = (l: UsageLimit): UsageLimit => {
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN;
    if (Number.isFinite(at) && at <= now) return { percent: 0, resetsAt: null, resetsInMinutes: null, severity: 'unknown' };
    return { ...l, resetsInMinutes: Number.isFinite(at) ? Math.max(0, Math.round((at - now) / 60_000)) : l.resetsInMinutes };
  };
  return { ...r, session: lim(r.session), weekly: lim(r.weekly) };
}

/** The last failed live read in this process (cleared by a good one): why the reading is stale. */
let lastFailure: { message: string; at: number } | null = null;

/**
 * This host's Claude Code login has expired: cloud runs would fail. Asked of the login itself, not
 * of the last usage read — with a hub the numbers stay live while the login here is long gone.
 */
export function claudeLoginExpired(): boolean {
  return pickToken()?.kind === 'session-stale';
}

// ---- TokenBar hub ----

/** usage-core's HUB_TTL: a hub reading younger than this is used as is. */
const HUB_TTL_MS = 600_000;
/** Ask the hub at most this often — the board reads usage every second. */
const HUB_POLL_MS = 60_000;
let hubMemo: { at: number; served: Served | null } | null = null;

/** Test helper: forget the last hub answer. */
export function _resetHub(): void {
  hubMemo = null;
}

/** The hub URL, when TokenBar's shared-cache location is one ($TOKENBAR_SHARED_CACHE, else the file). */
function hubUrl(): string | null {
  let p = (process.env.TOKENBAR_SHARED_CACHE ?? '').trim();
  if (!p) {
    try {
      p = fs.readFileSync(paths.tokenbarSharedPathFile, 'utf8').trim();
    } catch {
      return null;
    }
  }
  return /^https?:\/\//i.test(p) ? p : null;
}

/** GET the hub's usage.json (3s); null when it is unreachable or not JSON. */
function defaultReadHub(url: string): unknown {
  const script = `const r = await fetch(process.env.__HUB, { signal: AbortSignal.timeout(3000) });
    process.stdout.write(r.ok ? await r.text() : 'null');`;
  try {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 6000, env: { ...process.env, __HUB: url } }));
  } catch {
    return null;
  }
}

interface SharedLimit {
  percent?: number;
  resets_at?: string | null;
  severity?: string;
}

/** TokenBar's shared format v1 ({v, ts, sub, S, W}) as a reading taken at `ts`. */
function fromHub(o: unknown, now: number): Served | null {
  const h = o as { v?: number; ts?: number; sub?: string | null; S?: SharedLimit; W?: SharedLimit } | null;
  if (!h || h.v !== 1 || typeof h.ts !== 'number' || !(h.S || h.W)) return null;
  const ts = Math.min(h.ts, now);
  const lim = (l?: SharedLimit): Partial<UsageLimit> => ({ percent: Number(l?.percent ?? 0), resetsAt: l?.resets_at ?? null, severity: l?.severity ?? 'normal' });
  return { reading: normalize({ ok: true, subscription: h.sub ?? null, fetchedAt: new Date(ts).toISOString(), session: lim(h.S), weekly: lim(h.W) }, 'cache'), ts };
}

/** The hub's reading while it is fresh; null without a hub, or when it is down or has gone quiet. */
function hubReading(): Served | null {
  const url = hubUrl();
  if (!url) return null;
  const now = Date.now();
  if (!hubMemo || now - hubMemo.at >= HUB_POLL_MS) hubMemo = { at: now, served: fromHub(_deps.readHub(url), now) };
  const s = hubMemo.served;
  return s && now - s.ts < HUB_TTL_MS ? s : null;
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
  writeEnvelope({ reading, ts: Date.now() });
}

/**
 * Record a reading at the time it was really taken. TokenBar writes this file too (usage-core and
 * its status bars), and every tool sharing it judges freshness by `ts` — so an older reading never
 * replaces a newer one, and a cached reading is never re-dated. A live reading clears any cooldown
 * (the budget is evidently back); a cached one leaves it standing.
 */
function storeReading({ reading, ts }: Served): void {
  const cur = readCache();
  if (cur?.reading && cur.ts >= ts) return;
  const blockedUntil = reading.source === 'cache' ? cur?.blockedUntil : undefined;
  writeEnvelope(blockedUntil ? { reading, ts, blockedUntil } : { reading, ts });
}

/** Swap the file in whole, so the budget-guard hook and TokenBar never read a half-written one. */
function writeEnvelope(envelope: Record<string, unknown>): void {
  const tmp = `${CACHE_FILE}.tmp${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(envelope));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
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
