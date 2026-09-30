import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { ENGINE_REPO_ROOT } from '../config.js';

/**
 * Local Gitea: open the task's pull request through Gitea's REST API when the repo's `origin` is
 * the configured Gitea server (setting gitea_url, token GITEA_TOKEN in the env file). The body
 * carries what the engine verified overnight, so a reviewer reads the results on the PR itself.
 * Every call is time-boxed and never throws — a failed PR leaves the task in review with a local
 * diff, exactly like a missing `gh` does.
 *
 * The same server backs the 問題單 flow: `giteaCreds` / `giteaGitEnv` (token for git over http),
 * `parseGiteaUrl` (a pasted repo / issue / PR link) and `giteaClient` (repos, issues, comments,
 * labels, PRs — every call `{ok, data} | {ok, error}`, time-boxed, fetch injectable).
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

export interface GiteaReleaseInput {
  tag: string;
  /** a commit sha or a branch the tag is created on when it does not exist yet */
  target: string;
  name: string;
  body: string;
}

/**
 * A release with the delivery zip attached: POST …/releases (reusing the release when the tag
 * already has one), then POST …/releases/{id}/assets. Returns the release page, or the reason.
 */
export async function publishGiteaRelease(
  giteaUrl: string,
  token: string,
  repo: RemoteRepo,
  input: GiteaReleaseInput,
  asset: { name: string; data: Buffer },
  fetchImpl: Fetch = fetch,
  timeoutMs = 120_000,
): Promise<{ url: string | null; asset_url?: string | null; error?: string }> {
  const api = `${giteaUrl.replace(/\/+$/, '')}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/releases`;
  const auth = { authorization: `token ${token}`, accept: 'application/json' };
  const fail = async (res: Response, what: string) => {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return { url: null, error: `Gitea ${what} HTTP ${res.status}${res.status === 401 || res.status === 403 ? '（GITEA_TOKEN 缺少或沒有寫入權限）' : ''}: ${detail}` };
  };
  try {
    type Release = { id?: number; html_url?: string };
    let rel: Release | null = null;
    const res = await fetchImpl(api, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tag_name: input.tag, target_commitish: input.target, name: input.name.slice(0, 250), body: input.body, draft: false, prerelease: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) rel = (await res.json().catch(() => null)) as Release | null;
    else if (res.status === 409) {
      // the tag already has a release (published before): attach to it
      const got = await fetchImpl(`${api}/tags/${encodeURIComponent(input.tag)}`, { headers: auth, signal: AbortSignal.timeout(timeoutMs) });
      if (!got.ok) return await fail(got, '讀取既有 release');
      rel = (await got.json().catch(() => null)) as Release | null;
    } else return await fail(res, '建立 release');
    if (!rel?.id) return { url: null, error: 'Gitea 沒有回傳 release id' };
    const form = new FormData();
    form.append('attachment', new Blob([asset.data], { type: 'application/zip' }), asset.name);
    const up = await fetchImpl(`${api}/${rel.id}/assets?name=${encodeURIComponent(asset.name)}`, {
      method: 'POST',
      headers: auth,
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!up.ok) return { ...(await fail(up, '上傳附件')), url: rel.html_url ?? null };
    const a = (await up.json().catch(() => ({}))) as { browser_download_url?: string };
    return { url: rel.html_url ?? null, asset_url: a.browser_download_url ?? null };
  } catch (err) {
    return { url: null, error: `Gitea 連不上：${(err as Error).message.slice(0, 160)}` };
  }
}

// ---- credentials & the token for git over http ----------------------------------------------

export interface GiteaCreds {
  /** gitea_url without a trailing slash */
  url: string;
  token: string;
}

/**
 * The configured server and its token: setting `gitea_url` + `GITEA_TOKEN` from the process
 * environment (the systemd env file — never the DB). Null unless both are set; every caller
 * degrades the way createPr does (no Gitea call, a note on the task).
 */
export function giteaCreds(db: Database.Database, env: NodeJS.ProcessEnv = process.env): GiteaCreds | null {
  const url = (getSetting(db, 'gitea_url') ?? '').trim().replace(/\/+$/, '');
  const token = (env.GITEA_TOKEN ?? '').trim();
  return url && token ? { url, token } : null;
}

/** hostname of a URL, lowercase; null when it is not one */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The Gitea server's hostname from the gitea_url setting (null = not configured). */
export function giteaHostOf(db: Database.Database): string | null {
  const url = (getSetting(db, 'gitea_url') ?? '').trim();
  return url ? hostOf(url) : null;
}

/** scripts/git-askpass-env.sh: answers git's Username / Password prompts from the environment. */
export const GIT_ASKPASS_SCRIPT = path.join(ENGINE_REPO_ROOT, 'scripts', 'git-askpass-env.sh');

/**
 * Environment additions that let git clone / fetch / push over http(s) to the Gitea server with
 * the token: GIT_ASKPASS answers the prompts, GIT_TERMINAL_PROMPT=0 makes sure git never waits on
 * a terminal, GITEA_TOKEN is what the script prints. The token never appears in argv or in any
 * .git/config. Null (no additions at all) without credentials and — when a remote is given — for
 * any remote that is not an http(s) URL on the Gitea host, so the token never reaches another
 * server.
 */
export function giteaGitEnv(
  db: Database.Database,
  o: { remoteUrl?: string | null } = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | null {
  const creds = giteaCreds(db, env);
  if (!creds) return null;
  if (o.remoteUrl !== undefined) {
    const r = (o.remoteUrl ?? '').trim();
    if (!/^https?:\/\//i.test(r) || !giteaRepoFor(creds.url, r)) return null;
  }
  return { GIT_ASKPASS: GIT_ASKPASS_SCRIPT, GIT_TERMINAL_PROMPT: '0', GITEA_TOKEN: creds.token };
}

// ---- pasted links -----------------------------------------------------------------------------

export interface GiteaRef {
  kind: 'repo' | 'issue' | 'pr';
  owner: string;
  repo: string;
  number?: number;
}

/**
 * What a pasted Gitea link points at, on the configured server only: `…/owner/repo(.git)`,
 * `…/owner/repo/issues/12`, `…/owner/repo/pulls/3` (a sub-path install is handled). A clone URL
 * in ssh / scp form on that host counts as the repo. Null for anything else.
 */
export function parseGiteaUrl(giteaUrl: string, s: string): GiteaRef | null {
  let base: URL;
  try {
    base = new URL(giteaUrl);
  } catch {
    return null;
  }
  const input = s.trim();
  if (!/^https?:\/\//i.test(input)) {
    const r = giteaRepoFor(giteaUrl, input);
    return r ? { kind: 'repo', owner: r.owner, repo: r.repo } : null;
  }
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  let p = u.pathname;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (prefix) {
    if (!p.startsWith(`${prefix}/`)) return null;
    p = p.slice(prefix.length);
  }
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 2) {
    const repo = parts[1]!.replace(/\.git$/, '');
    return repo ? { kind: 'repo', owner: parts[0]!, repo } : null;
  }
  if (parts.length === 4 && (parts[2] === 'issues' || parts[2] === 'pulls') && /^\d+$/.test(parts[3]!)) {
    return { kind: parts[2] === 'issues' ? 'issue' : 'pr', owner: parts[0]!, repo: parts[1]!, number: Number(parts[3]) };
  }
  return null;
}

// ---- REST client ------------------------------------------------------------------------------

export type GiteaResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface GiteaClientOptions {
  fetchImpl?: Fetch;
  /** per call (default 20 s); an attachment download gets six times that */
  timeoutMs?: number;
  /** the largest attachment downloadAsset accepts (default 25 MB) */
  maxAssetBytes?: number;
}

export interface GiteaRepoInfo {
  full_name: string;
  default_branch: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  private: boolean;
}
export interface GiteaBranch {
  name: string;
  sha: string | null;
}
export interface GiteaLabel {
  id: number;
  name: string;
  color: string | null;
}
export interface GiteaAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
}
export interface GiteaIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  labels: GiteaLabel[];
  /** the author's login */
  user: string | null;
  assets: GiteaAsset[];
  created_at: string | null;
  updated_at: string | null;
}
export interface GiteaComment {
  id: number;
  html_url: string;
  body: string;
}
export interface GiteaPr {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean | null;
}
export interface ListIssuesQuery {
  /** label names; all must match */
  labels?: string | string[];
  state?: 'open' | 'closed' | 'all';
  /** ISO time: only issues updated after it */
  since?: string;
  limit?: number;
  page?: number;
}
export interface MergePrInput {
  Do: 'merge' | 'rebase' | 'squash';
  delete_branch_after_merge?: boolean;
  merge_message_field?: string;
}

export interface GiteaClient {
  getRepo(owner: string, repo: string): Promise<GiteaResult<GiteaRepoInfo>>;
  listBranches(owner: string, repo: string): Promise<GiteaResult<GiteaBranch[]>>;
  /** the issue with its attachments (…/issues/{n}/assets) */
  getIssue(owner: string, repo: string, n: number): Promise<GiteaResult<GiteaIssue>>;
  listIssues(owner: string, repo: string, q?: ListIssuesQuery): Promise<GiteaResult<GiteaIssue[]>>;
  /** GET the attachment with the token; refuses a URL that is not on the Gitea host */
  downloadAsset(asset: Pick<GiteaAsset, 'browser_download_url'>): Promise<GiteaResult<Buffer>>;
  createIssueComment(owner: string, repo: string, n: number, body: string): Promise<GiteaResult<GiteaComment>>;
  /** edit-in-place: the one live progress comment on an issue */
  editIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GiteaResult<GiteaComment>>;
  /** replaces the issue's labels; names are resolved against the repo's labels, ids pass through */
  setIssueLabels(owner: string, repo: string, n: number, labels: Array<string | number>): Promise<GiteaResult<GiteaLabel[]>>;
  closeIssue(owner: string, repo: string, n: number): Promise<GiteaResult<{ number: number; state: string }>>;
  getPr(owner: string, repo: string, n: number): Promise<GiteaResult<GiteaPr>>;
  mergePr(owner: string, repo: string, n: number, input: MergePrInput): Promise<GiteaResult<{ merged: true }>>;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const when = (v: unknown): string | null => (v ? str(v) : null);
const asLabel = (v: unknown): GiteaLabel => {
  const r = obj(v);
  return { id: num(r.id), name: str(r.name), color: r.color ? str(r.color) : null };
};
const asAsset = (v: unknown): GiteaAsset => {
  const r = obj(v);
  return { id: num(r.id), name: str(r.name), size: num(r.size), browser_download_url: str(r.browser_download_url) };
};
const asIssue = (v: unknown): GiteaIssue => {
  const r = obj(v);
  return {
    number: num(r.number),
    title: str(r.title),
    body: str(r.body),
    state: str(r.state) || 'open',
    html_url: str(r.html_url),
    labels: list(r.labels).map(asLabel),
    user: str(obj(r.user).login) || null,
    assets: list(r.assets).map(asAsset),
    created_at: when(r.created_at),
    updated_at: when(r.updated_at),
  };
};
const asComment = (v: unknown): GiteaComment => {
  const r = obj(v);
  return { id: num(r.id), html_url: str(r.html_url), body: str(r.body) };
};
const asPr = (v: unknown): GiteaPr => {
  const r = obj(v);
  return {
    number: num(r.number),
    title: str(r.title),
    state: str(r.state) || 'open',
    html_url: str(r.html_url),
    head: { ref: str(obj(r.head).ref), sha: str(obj(r.head).sha) },
    base: { ref: str(obj(r.base).ref), sha: str(obj(r.base).sha) },
    merged: r.merged === true,
    mergeable: typeof r.mergeable === 'boolean' ? r.mergeable : null,
  };
};
const asRepo = (v: unknown): GiteaRepoInfo => {
  const r = obj(v);
  return {
    full_name: str(r.full_name),
    default_branch: str(r.default_branch) || 'main',
    clone_url: str(r.clone_url),
    ssh_url: str(r.ssh_url),
    html_url: str(r.html_url),
    private: r.private === true,
  };
};
const asBranch = (v: unknown): GiteaBranch => {
  const r = obj(v);
  const sha = str(obj(r.commit).id);
  return { name: str(r.name), sha: sha || null };
};

async function httpError(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 400);
  let detail = text;
  try {
    const j = JSON.parse(text) as Raw;
    if (typeof j.message === 'string') detail = j.message;
  } catch {
    /* not JSON */
  }
  const hint = res.status === 401 || res.status === 403 ? '（GITEA_TOKEN 缺少或權限不足）' : res.status === 404 ? '（找不到：網址不對或沒有權限）' : '';
  return `Gitea HTTP ${res.status}${hint}: ${detail.slice(0, 200)}`;
}

function netError(err: unknown, ms: number): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `Gitea 逾時（${Math.round(ms / 1000)} 秒）`;
  return `Gitea 連不上：${String(e?.message ?? err).slice(0, 160)}`;
}

/**
 * A client bound to one server + token. Every method resolves to `{ok:true, data}` or
 * `{ok:false, error}` — never throws, never hangs (AbortSignal.timeout on every request).
 */
export function giteaClient(creds: GiteaCreds, o: GiteaClientOptions = {}): GiteaClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const maxAsset = o.maxAssetBytes ?? 25 * 1024 * 1024;
  const api = `${creds.url.replace(/\/+$/, '')}/api/v1`;
  const auth = { authorization: `token ${creds.token}`, accept: 'application/json' };
  const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const index = (n: number): string | null => (Number.isInteger(n) && n > 0 ? String(n) : null);
  const badIndex = <T>(): GiteaResult<T> => ({ ok: false, error: 'issue / PR 編號要是正整數' });

  async function call<T>(method: string, p: string, body?: unknown): Promise<GiteaResult<T>> {
    try {
      const res = await fetchImpl(`${api}${p}`, {
        method,
        headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, error: await httpError(res) };
      const text = res.status === 204 ? '' : await res.text().catch(() => '');
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      return { ok: true, data: data as T };
    } catch (err) {
      return { ok: false, error: netError(err, timeoutMs) };
    }
  }
  const mapped = <T>(r: GiteaResult<unknown>, f: (raw: unknown) => T, what: string): GiteaResult<T> => {
    if (!r.ok) return r;
    if (!r.data || typeof r.data !== 'object') return { ok: false, error: `Gitea 沒有回傳${what}` };
    return { ok: true, data: f(r.data) };
  };
  const mappedList = <T>(r: GiteaResult<unknown>, f: (raw: unknown) => T): GiteaResult<T[]> =>
    r.ok ? { ok: true, data: list(r.data).map(f) } : r;

  return {
    async getRepo(owner, repo) {
      return mapped(await call('GET', repoPath(owner, repo)), asRepo, ' repo');
    },
    async listBranches(owner, repo) {
      return mappedList(await call('GET', `${repoPath(owner, repo)}/branches?limit=100`), asBranch);
    },
    async getIssue(owner, repo, n) {
      const i = index(n);
      if (!i) return badIndex();
      const r = mapped(await call('GET', `${repoPath(owner, repo)}/issues/${i}`), asIssue, ' issue');
      if (!r.ok) return r;
      const assets = await call('GET', `${repoPath(owner, repo)}/issues/${i}/assets`);
      if (assets.ok && Array.isArray(assets.data)) r.data.assets = assets.data.map(asAsset);
      return r;
    },
    async listIssues(owner, repo, q = {}) {
      const params = new URLSearchParams({ type: 'issues', state: q.state ?? 'open', limit: String(q.limit ?? 50), page: String(q.page ?? 1) });
      const labels = (Array.isArray(q.labels) ? q.labels : q.labels ? [q.labels] : []).map((l) => l.trim()).filter(Boolean);
      if (labels.length) params.set('labels', labels.join(','));
      if (q.since) params.set('since', q.since);
      return mappedList(await call('GET', `${repoPath(owner, repo)}/issues?${params.toString()}`), asIssue);
    },
    async downloadAsset(asset) {
      const url = str(asset.browser_download_url);
      if (!url || hostOf(url) !== hostOf(creds.url)) return { ok: false, error: '附件不在 Gitea 伺服器上，不下載' };
      const ms = timeoutMs * 6;
      try {
        const res = await fetchImpl(url, { headers: { authorization: auth.authorization }, signal: AbortSignal.timeout(ms) });
        if (!res.ok) return { ok: false, error: await httpError(res) };
        const tooBig = (bytes: number) => `附件太大（${Math.ceil(bytes / 1048576)} MB，上限 ${Math.round(maxAsset / 1048576)} MB）`;
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > maxAsset) return { ok: false, error: tooBig(declared) };
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxAsset) return { ok: false, error: tooBig(buf.length) };
        return { ok: true, data: buf };
      } catch (err) {
        return { ok: false, error: netError(err, ms) };
      }
    },
    async createIssueComment(owner, repo, n, body) {
      const i = index(n);
      if (!i) return badIndex();
      return mapped(await call('POST', `${repoPath(owner, repo)}/issues/${i}/comments`, { body }), asComment, '留言');
    },
    async editIssueComment(owner, repo, commentId, body) {
      const i = index(commentId);
      if (!i) return badIndex();
      return mapped(await call('PATCH', `${repoPath(owner, repo)}/issues/comments/${i}`, { body }), asComment, '留言');
    },
    async setIssueLabels(owner, repo, n, labels) {
      const i = index(n);
      if (!i) return badIndex();
      const ids = labels.filter((l): l is number => typeof l === 'number');
      const names = labels.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean);
      if (names.length) {
        const all = await call('GET', `${repoPath(owner, repo)}/labels?limit=100`);
        if (!all.ok) return all;
        const byName = new Map(list(all.data).map(asLabel).map((l) => [l.name.toLowerCase(), l.id]));
        const missing = names.filter((nm) => !byName.has(nm.toLowerCase()));
        if (missing.length) return { ok: false, error: `Gitea 這個 repo 沒有標籤：${missing.join('、')}` };
        ids.push(...names.map((nm) => byName.get(nm.toLowerCase())!));
      }
      return mappedList(await call('PUT', `${repoPath(owner, repo)}/issues/${i}/labels`, { labels: ids }), asLabel);
    },
    async closeIssue(owner, repo, n) {
      const i = index(n);
      if (!i) return badIndex();
      const r = await call('PATCH', `${repoPath(owner, repo)}/issues/${i}`, { state: 'closed' });
      if (!r.ok) return r;
      const raw = obj(r.data);
      return { ok: true, data: { number: num(raw.number) || n, state: str(raw.state) || 'closed' } };
    },
    async getPr(owner, repo, n) {
      const i = index(n);
      if (!i) return badIndex();
      return mapped(await call('GET', `${repoPath(owner, repo)}/pulls/${i}`), asPr, ' PR');
    },
    async mergePr(owner, repo, n, input) {
      const i = index(n);
      if (!i) return badIndex();
      const r = await call('POST', `${repoPath(owner, repo)}/pulls/${i}/merge`, input);
      return r.ok ? { ok: true, data: { merged: true } } : r;
    },
  };
}

/** The client for the configured server, or null when gitea_url / GITEA_TOKEN are not set. */
export function giteaClientFor(db: Database.Database, o: GiteaClientOptions = {}): GiteaClient | null {
  const creds = giteaCreds(db);
  return creds ? giteaClient(creds, o) : null;
}
