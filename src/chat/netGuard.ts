import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Outbound-fetch guard for the chat tools. The model chooses the URL, so this is the line
 * between "look something up on the web" and "read the board's own API, the vLLM admin port,
 * a plant subnet or a tailnet peer". Every hop of a redirect is checked again.
 *
 * Node's fetch cannot pin a resolved address, so the check is resolve → verify → fetch by name.
 * A DNS-rebinding race between those steps is accepted for a tailnet-only ops box.
 */

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: Lookup = async (host) => dns.lookup(host, { all: true });

function v4ToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT — Tailscale addresses live here
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4Forbidden(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n == null) return true;
  return V4_BLOCKS.some(([base, bits]) => {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  });
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses (v4 and v6). */
export function isForbiddenAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Forbidden(ip);
  if (kind !== 6) return true;
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (mapped) return v4Forbidden(mapped[1]!);
  const first = parseInt(low.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export class BlockedUrlError extends Error {}

/** Throws BlockedUrlError unless every address the host resolves to is public (or the host is allowed). */
export async function assertPublicHost(host: string, allow: Set<string>, lookup: Lookup = defaultLookup): Promise<void> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (allow.has(h)) return;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new BlockedUrlError(`不允許存取內部主機：${host}`);
  }
  if (net.isIP(h)) {
    if (isForbiddenAddress(h)) throw new BlockedUrlError(`不允許存取內網位址：${host}`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(h);
  } catch {
    throw new BlockedUrlError(`主機名稱解析失敗：${host}`);
  }
  if (!addrs.length) throw new BlockedUrlError(`主機名稱解析失敗：${host}`);
  for (const a of addrs) {
    if (isForbiddenAddress(a.address)) throw new BlockedUrlError(`${host} 解析到內網位址，已擋下`);
  }
}

export interface BoundedFetchOptions {
  fetch: typeof fetch;
  lookup?: Lookup;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** `host:port` pairs exempt from the private-address rule (the SearXNG box) — port included, so
   *  allowing 127.0.0.1:8080 does not open the board on :4711 or vLLM on :8000 */
  allowHosts?: Set<string>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface BoundedResponse {
  url: string;
  status: number;
  contentType: string;
  /** decoded body, cut at maxBytes */
  text: string;
  truncated: boolean;
}

/** GET with a byte cap, a deadline, manual redirects and the host check on every hop. */
export async function fetchBounded(rawUrl: string, o: BoundedFetchOptions): Promise<BoundedResponse> {
  const allow = o.allowHosts ?? new Set<string>();
  const maxRedirects = o.maxRedirects ?? 3;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`不是合法網址：${rawUrl.slice(0, 120)}`);
  }
  const deadline = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError(`只允許 http(s)：${url.protocol}`);
    if (url.username || url.password) throw new BlockedUrlError('網址不可含帳號密碼');
    const key = `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
    if (!allow.has(key)) await assertPublicHost(url.hostname, new Set(), o.lookup);
    const res = await o.fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'LoopEngineering-chat/1.0 (+local ops assistant)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5', ...(o.headers ?? {}) },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new BlockedUrlError(`HTTP ${res.status} 沒有 Location`);
      if (hop >= maxRedirects) throw new BlockedUrlError(`轉址超過 ${maxRedirects} 次`);
      await res.body?.cancel().catch(() => {});
      url = new URL(loc, url);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    let truncated = false;
    let text = '';
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > o.maxBytes) {
          chunks.push(value.subarray(0, value.byteLength - (total - o.maxBytes)));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
    return { url: url.toString(), status: res.status, contentType, text, truncated };
  }
}
