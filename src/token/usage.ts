import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths, TOKEN_REFRESH_MS, USAGE_CACHE_FILE } from '../config.js';
import type { UsageReading, UsageLimit } from '../types.js';

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_FILE = USAGE_CACHE_FILE;

// oauth/usage is rate-limited per account, and every consumer shares that budget:
// TokenBar's status bars (on every machine), its claude-usage MCP server, this engine,
// and Claude Code itself. Two limiter tiers: a short burst window and an hour-long
// penalty (Retry-After ~3600). Requests made during the penalty are wasted, and
// traffic that resumes at full speed when it lifts trips it again — this engine used
// to do both (2 requests/min through a 429, no shared cache), which kept the whole
// account locked out. Hence: share TokenBar's caches, treat Retry-After as a hard
// stop, and back off after any other failure too.
const COOLDOWN_MIN_MS = 60_000;
const COOLDOWN_MAX_MS = 3_900_000; // a bogus header can't park us for longer than this
const COOLDOWN_DEFAULT_MS = 300_000; // 429 without a usable Retry-After
// Non-429 failure (expired token, 5xx, offline): don't retry for this long, so the 60s
// tick — which reads usage more than once — can't turn one outage into a request storm.
const FAILURE_BACKOFF_MS = 300_000;
// `force` (run.ts billing boundaries) still reuses a reading this recent.
const FORCE_MIN_AGE_MS = 60_000;

interface CacheEnvelope {
  reading?: UsageReading;
  ts: number;
  /** 429 cooldown (epoch ms); also written by TokenBar's usage-core, so it's shared. */
  blockedUntil?: number;
  /** Private backoff after a non-429 failure (epoch ms). */
  retryAt?: number;
}

/** TokenBar shared-cache entry, format v1 — the same file every TokenBar surface uses. */
interface SharedLimit {
  percent?: number;
  resets_at?: string | null;
  severity?: string;
  name?: string;
}
interface SharedEntry {
  v: 1;
  ts: number;
  sub?: string | null;
  S?: SharedLimit | null;
  W?: SharedLimit | null;
  XL?: SharedLimit[];
  blockedUntil?: number;
}

/**
 * Read current Claude usage (session 5h + weekly), mirroring TokenBar's usage-core
 * contract. Precedence:
 *   1. LOOP_MOCK_USAGE env (JSON)      — tests / mock adapter, zero network.
 *   2. freshest cached reading          — this tool's cache file (a manual edit, e.g. a
 *                                         breaker drill, takes effect) or TokenBar's
 *                                         cross-machine shared cache, if under refreshMs.
 *   3. cooldown / backoff in force      — stale cache (or degraded), no request made.
 *   4. live fetch of oauth/usage       — writes both caches on success; on a 429 publishes
 *                                         `blockedUntil` so every other consumer waits too.
 *
 * This is the single source the scheduler and breaker consult. `force` skips the
 * freshness window (down to FORCE_MIN_AGE_MS) but never a cooldown or backoff.
 */
export function readUsage(opts: { force?: boolean; refreshMs?: number } = {}): UsageReading {
  // usage_provider='none' (e.g. the Copilot host): no percent API exists. Return a benign
  // 0%-used reading so the breaker / start-gate / fit-gate never trip; the request-cap gate
  // in tick.ts is the real limiter. Snapshotted into the env at engine/cli start (no db here).
  if (process.env.LOOP_USAGE_PROVIDER === 'none') return benignReading();

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
  const shared = readShared();
  // A hub (see TokenBar's hub/) is the one consumer meant to pay for fetches; its reading
  // is trusted for HUB_TTL_MS even under `force`, and we only fetch ourselves once it has
  // gone quiet or is unreachable.
  if (shared && isHub(sharedPath()) && ageOf(shared.ts) < HUB_TTL_MS && (shared.S || shared.W)) {
    return freshest(null, shared)!.reading;
  }
  const best = freshest(cache, shared);
  const maxAge = opts.force ? FORCE_MIN_AGE_MS : refreshMs;
  if (best && ageOf(best.ts) < maxAge) return best.reading;

  const staleOr = (why: string): UsageReading =>
    best ? { ...best.reading, error: `stale: ${why}` } : degraded(why);

  const wait = Math.max(waitFor(cache?.blockedUntil), waitFor(shared?.blockedUntil), waitFor(cache?.retryAt));
  if (wait > 0) return staleOr(`backing off, next usage fetch in ${Math.ceil(wait / 1000)}s`);

  // Test suites run with real credentials on a dev machine; without this they spend the
  // account's usage budget (and can trip the hour-long penalty) on every run.
  if (process.env.LOOP_USAGE_NO_FETCH) return staleOr('live usage fetch disabled (LOOP_USAGE_NO_FETCH)');

  const cred = pickToken();
  if (!cred.token) return staleOr('no oauth token (not logged in to Claude Code)');

  const res = fetchLive(cred.token);
  if (res.status === 200 && res.body) {
    const { reading, entry } = parse(res.body, cred.sub);
    writeCache(reading); // drops blockedUntil/retryAt: the budget is evidently back
    writeShared(entry);
    return reading;
  }

  if (res.status === 429) {
    const until = cooldownUntil(res.retryAfter);
    writeEnvelope({ ...(cache ?? { ts: 0 }), blockedUntil: until });
    if (sharedPath()) writeShared({ ...(shared ?? { v: 1, ts: 0 }), v: 1, blockedUntil: until });
    console.error(`[usage] HTTP 429 — no usage fetch until ${new Date(until).toLocaleTimeString()}`);
    return staleOr(`rate-limited, retry in ${Math.ceil((until - Date.now()) / 1000)}s`);
  }

  const why = res.status ? `HTTP ${res.status}` : res.error || 'network error';
  writeEnvelope({ ...(cache ?? { ts: 0 }), retryAt: Date.now() + FAILURE_BACKOFF_MS });
  console.error(`[usage] ${why} — next usage fetch in ${FAILURE_BACKOFF_MS / 60_000}m`);
  return staleOr(why);
}

interface FetchResult {
  status: number; // 0 = no response (network error / timeout)
  retryAfter?: string | null;
  body?: any;
  error?: string;
}

/**
 * One request to oauth/usage. Never throws. Runs in a blocking child process to keep
 * readUsage synchronous (callers rely on that), and reports status + Retry-After so
 * the caller can back off properly.
 */
function fetchLive(token: string): FetchResult {
  const script = `
    let out;
    try {
      const r = await fetch(${JSON.stringify(OAUTH_USAGE_URL)}, {
        headers: {
          Authorization: 'Bearer ' + process.env.__TOK,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
          'User-Agent': 'loop-engineering',
        },
        signal: AbortSignal.timeout(15000),
      });
      out = { status: r.status, retryAfter: r.headers.get('retry-after'), body: r.ok ? await r.json() : null };
    } catch (e) {
      out = { status: 0, error: String((e && e.message) || e) };
    }
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, __TOK: token },
      encoding: 'utf8',
      timeout: 20000,
    });
    return JSON.parse(out) as FetchResult;
  } catch (err) {
    return { status: 0, error: String((err as Error).message) };
  }
}

/** API body → this engine's reading + a TokenBar shared-cache entry. */
function parse(d: any, sub: string | null): { reading: UsageReading; entry: SharedEntry } {
  const limits: any[] = Array.isArray(d.limits) ? d.limits : [];
  const s = limits.find((l) => l.kind === 'session') ?? d.five_hour;
  const w = limits.find((l) => l.kind === 'weekly_all') ?? d.seven_day;
  const subscription = sub ?? d.subscription ?? d.subscriptionType ?? null;
  const now = Date.now();
  const flat = (l: any): SharedLimit | null =>
    l ? { percent: Math.round(Number(l.percent ?? l.utilization ?? 0)), resets_at: l.resets_at ?? null, severity: l.severity ?? 'normal' } : null;
  return {
    reading: normalize(
      { ok: true, subscription, fetchedAt: new Date(now).toISOString(), session: fromLimit(s), weekly: fromLimit(w) },
      'api',
    ),
    entry: {
      v: 1,
      ts: now,
      sub: subscription,
      S: flat(s),
      W: flat(w),
      XL: limits
        .filter((l) => l.kind === 'weekly_scoped')
        .map((l) => ({ ...flat(l), name: l.scope?.model?.display_name || l.scope?.surface || 'scoped' })),
    },
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

/**
 * Credential resolution matching TokenBar's usage-core order: the short-lived session
 * token while it's fresh, else a long-lived `claude setup-token` (token file, then
 * CLAUDE_CODE_OAUTH_TOKEN), else the session token even if it looks expired.
 */
function pickToken(): { token: string | null; sub: string | null } {
  const c = readCreds();
  let longTok: string | null = null;
  try {
    longTok = fs.readFileSync(paths.tokenCache, 'utf8').trim() || null;
  } catch {
    /* no long-lived token saved */
  }
  if (!longTok && process.env.CLAUDE_CODE_OAUTH_TOKEN) longTok = process.env.CLAUDE_CODE_OAUTH_TOKEN.trim() || null;
  const sub = c?.subscriptionType ?? null;
  if (c?.accessToken && c.expiresAt && Date.now() < c.expiresAt - 60_000) return { token: c.accessToken, sub };
  if (longTok) return { token: longTok, sub };
  return { token: c?.accessToken ?? null, sub };
}

function readCreds(): { accessToken?: string; expiresAt?: number; subscriptionType?: string } | null {
  try {
    const c = JSON.parse(fs.readFileSync(paths.credentials, 'utf8'))?.claudeAiOauth;
    if (c) return c;
  } catch {
    /* not present (e.g. Linux host not logged in, or Mac uses keychain) */
  }
  // macOS keychain fallback (Mac client only)
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8',
      }).trim();
      return JSON.parse(raw)?.claudeAiOauth ?? null;
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

/** usage_provider='none': a healthy 0%-used reading so no percent-based gate ever trips. */
function benignReading(): UsageReading {
  return normalize({ ok: true, session: { percent: 0 }, weekly: { percent: 0 } }, 'disabled');
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

// ---- freshness / cooldown helpers ----

/** Another machine's clock may run ahead of ours; treat "written in the future" as fresh. */
const ageOf = (ts: number): number => Math.max(0, Date.now() - ts);

/** Remaining wait in ms, clamped so a peer's skewed clock can't park us for a week. */
const waitFor = (until: unknown): number =>
  typeof until === 'number' && until > Date.now() ? Math.min(until - Date.now(), COOLDOWN_MAX_MS) : 0;

function cooldownUntil(retryAfter: string | null | undefined): number {
  const raw = (retryAfter ?? '').trim();
  let ms = COOLDOWN_DEFAULT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) ms = n * 1000; // delta-seconds form
    else if (!Number.isNaN(Date.parse(raw))) ms = Date.parse(raw) - Date.now(); // HTTP-date form
  }
  return Date.now() + Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
}

/** Newest usable reading from either cache, countdowns recomputed against now. */
function freshest(cache: CacheEnvelope | null, shared: SharedEntry | null): { ts: number; reading: UsageReading } | null {
  const a = cache?.reading && cache.ts > 0 ? { ts: cache.ts, reading: cache.reading } : null;
  const b = shared && shared.ts > 0 && (shared.S || shared.W) ? { ts: shared.ts, reading: readingFromShared(shared) } : null;
  const pick = a && b ? (a.ts >= b.ts ? a : b) : (a ?? b);
  if (!pick) return null;
  const tick = (l: UsageLimit): UsageLimit => ({ ...l, resetsInMinutes: minutesUntil(l.resetsAt) ?? l.resetsInMinutes });
  return { ts: pick.ts, reading: { ...pick.reading, session: tick(pick.reading.session), weekly: tick(pick.reading.weekly), source: 'cache' } };
}

function readingFromShared(sh: SharedEntry): UsageReading {
  const lim = (x?: SharedLimit | null): Partial<UsageLimit> => ({
    percent: Number(x?.percent ?? 0),
    resetsAt: x?.resets_at ?? null,
    severity: x?.severity ?? 'normal',
  });
  return normalize(
    { ok: true, subscription: sh.sub ?? null, fetchedAt: new Date(sh.ts).toISOString(), session: lim(sh.S), weekly: lim(sh.W) },
    'cache',
  );
}

// ---- this tool's cache file (shared with claude-usage-mcp; manual edits are honored) ----

export function readCache(): CacheEnvelope | null {
  try {
    const o = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return o && typeof o === 'object' && typeof o.ts === 'number' ? (o as CacheEnvelope) : null;
  } catch {
    return null;
  }
}

export function writeCache(reading: UsageReading): void {
  writeEnvelope({ reading, ts: Date.now() });
}

function writeEnvelope(o: CacheEnvelope): void {
  atomicWrite(CACHE_FILE, o);
}

function atomicWrite(file: string, o: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(o));
    fs.renameSync(tmp, file); // readers (MCP server, status bar, syncing peers) never see half a file
  } catch {
    /* best effort */
  }
}

// ---- TokenBar's cross-machine shared cache ----

/**
 * Path (or hub URL) of TokenBar's shared cache: $LOOP_USAGE_SHARED_CACHE (empty string
 * disables), else $TOKENBAR_SHARED_CACHE, else ~/.config/claude-usage-bar/shared-cache-path.
 * A custom LOOP_DATA_DIR (tests, portable installs) opts out of the pointer file so
 * hermetic runs never touch the real shared file.
 */
function sharedPath(): string | null {
  const own = process.env.LOOP_USAGE_SHARED_CACHE;
  if (own !== undefined) return own.trim() || null;
  const tb = (process.env.TOKENBAR_SHARED_CACHE ?? '').trim();
  if (tb) return tb;
  if (process.env.LOOP_DATA_DIR) return null;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.config', 'claude-usage-bar', 'shared-cache-path'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * The pointer may hold a hub URL (e.g. http://raspberrypi:8787/usage.json): one machine
 * on the tailnet polls Anthropic and serves its reading over HTTP, the rest only read it.
 * A hub is never written to.
 */
const HUB_TTL_MS = 600_000;
// readUsage is called several times per tick; don't spawn a fetch for each one.
const HUB_MEMO_MS = 30_000;
let hubMemo: { ts: number; entry: SharedEntry | null } | null = null;
const isHub = (p: string | null): boolean => /^https?:\/\//i.test(p ?? '');

function readShared(): SharedEntry | null {
  const p = sharedPath();
  if (!p) return null;
  if (isHub(p)) return readHub(p);
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return o && o.v === 1 && typeof o.ts === 'number' ? (o as SharedEntry) : null;
  } catch {
    return null;
  }
}

/** GET the hub synchronously (readUsage is sync) in a child process, like fetchLive. */
function readHub(url: string): SharedEntry | null {
  if (hubMemo && Date.now() - hubMemo.ts < HUB_MEMO_MS) return hubMemo.entry;
  let entry: SharedEntry | null = null;
  const script = `
    try {
      const r = await fetch(process.env.__HUB, { signal: AbortSignal.timeout(3000) });
      process.stdout.write(r.ok ? await r.text() : '');
    } catch {}
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, __HUB: url },
      encoding: 'utf8',
      timeout: 5000,
    });
    const o = out ? JSON.parse(out) : null;
    if (o && o.v === 1 && typeof o.ts === 'number') entry = o as SharedEntry;
  } catch {
    /* unreachable hub: fall back to our own cache / fetch */
  }
  hubMemo = { ts: Date.now(), entry };
  return entry;
}

function writeShared(o: SharedEntry): void {
  const p = sharedPath();
  if (p && !isHub(p)) atomicWrite(p, o);
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
