import { formatPushComment, type WorkItem, type WorkProvider } from './types.js';

export interface AdoProviderOptions {
  pat: string;
  org: string;
  project: string;
  /** https://dev.azure.com by default; override for an on-prem ADO Server instance. */
  apiUrl?: string;
  /** Injectable for tests — zero network when a fake is supplied. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_URL = 'https://dev.azure.com';
const TIMEOUT_MS = 15_000;

/** Thin Azure DevOps REST client (WIQL query + work-item comments). Every call is
 * try/caught + timeout-guarded — it logs/returns, never throws into the scheduler. */
export function createAdoProvider(opts: AdoProviderOptions): WorkProvider {
  const base = `${(opts.apiUrl || DEFAULT_API_URL).replace(/\/$/, '')}/${opts.org}/${opts.project}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = 'Basic ' + Buffer.from(`:${opts.pat}`).toString('base64');

  async function request(path: string, init: RequestInit = {}): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: auth,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`ado ${path} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'ado',

    async listWorkItems(query: string): Promise<WorkItem[]> {
      try {
        const wiql = await request('/_apis/wit/wiql?api-version=7.0', {
          method: 'POST',
          body: JSON.stringify({ query }),
        });
        const ids: number[] = Array.isArray(wiql?.workItems)
          ? wiql.workItems.map((w: any) => w.id).filter((n: unknown) => typeof n === 'number')
          : [];
        if (!ids.length) return [];
        const details = await request(`/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.0`);
        const values = Array.isArray(details?.value) ? details.value : [];
        return values.map((w: any): WorkItem => ({
          id: String(w.id ?? ''),
          title: String(w.fields?.['System.Title'] ?? ''),
          body: String(w.fields?.['System.Description'] ?? ''),
          url: String(w._links?.html?.href ?? w.url ?? ''),
        })).filter((it: WorkItem) => it.id);
      } catch {
        return [];
      }
    },

    async pushResult(item, result): Promise<void> {
      if (!item.id) return;
      try {
        await request(`/_apis/wit/workItems/${item.id}/comments?api-version=7.0-preview.3`, {
          method: 'POST',
          body: JSON.stringify({ text: formatPushComment(result) }),
        });
      } catch {
        /* best-effort — never throws */
      }
    },
  };
}
