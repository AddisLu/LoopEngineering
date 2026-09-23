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

/**
 * usage-core (SHARED_TTL there) answers from its caches *instead of* a request only while the
 * newest reading is younger than this. It also falls back to that same reading, unflagged, when
 * a request it did make fails (network, expired token, HTTP error) — so an older reading coming
 * back from it means a failed read, not a fresh one.
 */
const TOKENBAR_SHARED_TTL_MS = 240_000;

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

/** Park every consumer without disturbing the last good reading either tool draws from. */
function publishCooldown(base: Partial<CacheEnvelope> | null, ms: number): void {
  writeEnvelope({ ...(base ?? { ts: 0 }), blockedUntil: Date.now() + clampCooldown(ms) });
}

/**
 * Read current Claude usage (session 5h + weekly), mirroring TokenBar's usage-core
 * contract exactly. Precedence:
 *   1. LOOP_MOCK_USAGE env (JSON)      — tests / mock adapter, zero network.
 *   2. shared cache file if fresh      — TokenBar's 240s window; lets a manual edit
 *                                         (breaker drill) take effect. `force` skips it.
 *   3. 429 cooldown in the file        — cached reading, NO request. `force` included:
 *                                         a request during the penalty restarts it.
 *   4. live read of oauth/usage        — direct, or via TokenBar's usage-core when
 *                                         TOKENBAR_MCP_DIR is set; stored with the time
 *                                         it was really taken.
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
    return { ...cache.reading, source: 'cache' };
  }

  // A cooldown published by TokenBar (or by our own last failure) means: make no request — and
  // `force` does not override it. The run boundaries force a read before and after every Claude
  // task; letting those through a cooldown is what kept the account's usage endpoint locked.
  const wait = waitFor(cache?.blockedUntil);
  if (wait > 0) {
    const msg = `cooldown ${Math.ceil(wait / 1000)}s (shared 429 backoff)`;
    return cache?.reading ? { ...cache.reading, source: 'cache', error: msg } : degraded(msg);
  }

  try {
    const live = fetchLive();
    storeReading(live);
    return live.reading;
  } catch (err) {
    const cooldownMs = err instanceof UsageFetchError && err.cooldownMs ? err.cooldownMs : COOLDOWN_MIN_MS;
    // Re-read: TokenBar's usage-core may have just written this file itself. Draw from whichever
    // reading is newer — ours, or the one TokenBar served alongside the failure — at its real age.
    const onDisk = readCache() ?? cache;
    const served = err instanceof UsageFetchError ? err.served : undefined;
    const base = served && (!onDisk?.reading || served.ts > onDisk.ts) ? { ...onDisk, ...served } : onDisk;
    publishCooldown(base, cooldownMs);
    if (base?.reading) {
      return { ...base.reading, source: 'cache', error: `stale: ${String((err as Error).message)}` };
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
function fetchViaTokenBar(core: string): Served {
  const script = `import { fetchUsage } from ${JSON.stringify(pathToFileURL(core).href)};
    const u = await fetchUsage();
    process.stdout.write(JSON.stringify(u));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  const u = JSON.parse(out) as LooseReading & {
    ok?: boolean;
    error?: string;
    retryAfterSeconds?: number;
    fromSharedCache?: boolean;
    rateLimited?: boolean;
  };
  if (u.ok === false) {
    throw new UsageFetchError(`tokenbar: ${u.error ?? 'unknown'}`, u.retryAfterSeconds ? u.retryAfterSeconds * 1000 : undefined);
  }
  // Date the reading by when it was taken, never by when we asked: stamping a cached reading
  // "now" made week-old numbers look fresh to every tool sharing the file and wiped the cooldown.
  // A peer's clock can run ahead of ours, so never date it into the future either.
  const taken = Date.parse(u.fetchedAt ?? '');
  const served: Served = {
    reading: normalize(u, u.fromSharedCache ? 'cache' : 'api'),
    ts: Number.isFinite(taken) ? Math.min(taken, Date.now()) : Date.now(),
  };
  // usage-core answers a cooldown (its own 429, or one a peer published) with ok:true and its last
  // good reading. That is a failed read: take the cooldown it reports.
  if (u.rateLimited) {
    throw new UsageFetchError('tokenbar: rate-limited', u.retryAfterSeconds ? u.retryAfterSeconds * 1000 : COOLDOWN_DEFAULT_MS, served);
  }
  // Past its TTL, a cached answer is usage-core's fallback after a request it made failed.
  if (u.fromSharedCache && Date.now() - served.ts >= TOKENBAR_SHARED_TTL_MS) {
    throw new UsageFetchError('tokenbar: live read failed', undefined, served);
  }
  return served;
}

/** Live read of oauth/usage, with the time the reading was taken. Throws on any failure. */
function fetchLive(): Served {
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
