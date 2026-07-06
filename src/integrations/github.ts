import { formatPushComment, type WorkItem, type WorkProvider } from './types.js';

export interface GithubProviderOptions {
  token: string;
  /** github.com by default; point at a GHES instance's API root otherwise. */
  apiUrl?: string;
  /** Injectable for tests — zero network when a fake is supplied. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_URL = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

/** Thin GitHub REST client. Every call is try/caught + timeout-guarded — it logs/returns,
 * never throws into the scheduler (see WorkProvider's contract). */
export function createGithubProvider(opts: GithubProviderOptions): WorkProvider {
  const apiUrl = (opts.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  async function request(path: string, init: RequestInit = {}): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(`${apiUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `token ${opts.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'loop-engineering',
          ...(init.headers ?? {}),
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`github ${path} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'github',

    async listWorkItems(query: string): Promise<WorkItem[]> {
      try {
        const data = await request(`/search/issues?q=${encodeURIComponent(query)}`);
        const items = Array.isArray(data?.items) ? data.items : [];
        return items.map((it: any): WorkItem => {
          const m = /\/repos\/([^/]+\/[^/]+)\/?$/.exec(String(it.repository_url ?? ''));
          return {
            id: String(it.number ?? ''),
            title: String(it.title ?? ''),
            body: String(it.body ?? ''),
            url: String(it.html_url ?? ''),
            repo: m ? m[1] : undefined,
          };
        }).filter((it: WorkItem) => it.id);
      } catch {
        return [];
      }
    },

    async pushResult(item, result): Promise<void> {
      if (!item.repo || !item.id) return;
      try {
        await request(`/repos/${item.repo}/issues/${item.id}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: formatPushComment(result) }),
        });
      } catch {
        /* best-effort — never throws */
      }
    },
  };
}
