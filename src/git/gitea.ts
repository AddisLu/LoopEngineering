/**
 * Local Gitea: open the task's pull request through Gitea's REST API when the repo's `origin` is
 * the configured Gitea server (setting gitea_url, token GITEA_TOKEN in the env file). The body
 * carries what the engine verified overnight, so a reviewer reads the results on the PR itself.
 * Every call is time-boxed and never throws — a failed PR leaves the task in review with a local
 * diff, exactly like a missing `gh` does.
 */

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
}

/** https://git.corp:3000/team/app(.git), ssh://git@git.corp:2222/team/app.git, git@git.corp:team/app.git */
export function parseRemoteUrl(url: string): RemoteRepo | null {
  const u = url.trim();
  let host: string;
  let pathPart: string;
  const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(?!\/\/)(.+)$/.exec(u);
  if (/^[a-z]+:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      pathPart = parsed.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1]!;
    pathPart = scp[2]!;
  } else {
    return null;
  }
  const parts = pathPart.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2 || !parts.at(-2) || !parts.at(-1)) return null;
  return { host: host.toLowerCase(), owner: parts.at(-2)!, repo: parts.at(-1)! };
}

/** The Gitea repo behind `remoteUrl`, when that remote lives on the configured Gitea server. */
export function giteaRepoFor(giteaUrl: string, remoteUrl: string): RemoteRepo | null {
  let giteaHost: string;
  try {
    giteaHost = new URL(giteaUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const r = parseRemoteUrl(remoteUrl);
  return r && r.host === giteaHost ? r : null;
}

export interface GiteaPrInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

type Fetch = typeof fetch;

/**
 * POST /api/v1/repos/{owner}/{repo}/pulls. A PR that already exists for this head/base (a resumed
 * task) is found and returned instead. Returns the PR's html_url, or null with the reason.
 */
export async function createGiteaPr(
  giteaUrl: string,
  token: string,
  repo: RemoteRepo,
  input: GiteaPrInput,
  fetchImpl: Fetch = fetch,
  timeoutMs = 20_000,
): Promise<{ url: string | null; error?: string }> {
  const api = `${giteaUrl.replace(/\/+$/, '')}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`;
  const headers = { authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json' };
  try {
    const res = await fetchImpl(api, {
      method: 'POST',
      headers,
      body: JSON.stringify({ head: input.head, base: input.base, title: input.title.slice(0, 250), body: input.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { html_url?: string };
      return j.html_url ? { url: j.html_url } : { url: null, error: 'Gitea 沒有回傳 PR 網址' };
    }
    if (res.status === 409 || res.status === 422) {
      // already open for this branch (e.g. the task was resumed): reuse it
      const list = await fetchImpl(`${api}?state=open&limit=50`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (list.ok) {
        const prs = (await list.json().catch(() => [])) as Array<{ html_url?: string; head?: { ref?: string }; base?: { ref?: string } }>;
        const hit = prs.find((p) => p.head?.ref === input.head && p.base?.ref === input.base);
        if (hit?.html_url) return { url: hit.html_url };
      }
    }
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return { url: null, error: `Gitea HTTP ${res.status}${res.status === 401 || res.status === 403 ? '（GITEA_TOKEN 缺少或權限不足）' : ''}: ${detail}` };
  } catch (err) {
    return { url: null, error: `Gitea 連不上：${(err as Error).message.slice(0, 160)}` };
  }
}
