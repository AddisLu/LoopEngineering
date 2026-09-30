import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { GIT_ASKPASS_SCRIPT, giteaClient, giteaClientFor, giteaCreds, giteaGitEnv, giteaHostOf, parseGiteaUrl } from '../git/gitea.js';
import { gitEnvFor } from '../git/integrate.js';

/**
 * The Gitea side of the 問題單 flow: a pasted link, the token for git over http, and the REST
 * client. Everything runs against a fake fetch — no server, no network, no token leaves the test.
 */

type Call = { url: string; init?: RequestInit };
const fakeFetch = (responses: Array<() => Response>, calls: Call[] = []) =>
  (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call: ${url}`);
    return next();
  }) as unknown as typeof fetch;
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const headersOf = (c: Call) => (c.init?.headers ?? {}) as Record<string, string>;
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body));

const G = 'http://gitea.corp:3000';
const creds = { url: G, token: 'tok' };

describe('parseGiteaUrl', () => {
  it('reads repo, issue and PR links on the configured server only', () => {
    expect(parseGiteaUrl(G, 'http://gitea.corp:3000/aoi/cf-aoi')).toEqual({ kind: 'repo', owner: 'aoi', repo: 'cf-aoi' });
    expect(parseGiteaUrl(G, 'http://gitea.corp:3000/aoi/cf-aoi.git')).toEqual({ kind: 'repo', owner: 'aoi', repo: 'cf-aoi' });
    expect(parseGiteaUrl(G, 'http://GITEA.corp:3000/aoi/cf-aoi/issues/12#issuecomment-5')).toEqual({ kind: 'issue', owner: 'aoi', repo: 'cf-aoi', number: 12 });
    expect(parseGiteaUrl(G, ' http://gitea.corp:3000/aoi/cf-aoi/pulls/3/ ')).toEqual({ kind: 'pr', owner: 'aoi', repo: 'cf-aoi', number: 3 });
    // the ssh clone form of the same server counts as the repo
    expect(parseGiteaUrl(G, 'ssh://git@gitea.corp:2222/aoi/cf-aoi.git')).toEqual({ kind: 'repo', owner: 'aoi', repo: 'cf-aoi' });
    expect(parseGiteaUrl(G, 'git@gitea.corp:aoi/cf-aoi.git')).toEqual({ kind: 'repo', owner: 'aoi', repo: 'cf-aoi' });
    // a sub-path install
    expect(parseGiteaUrl('http://intra.corp/gitea/', 'http://intra.corp/gitea/aoi/app/issues/7')).toEqual({ kind: 'issue', owner: 'aoi', repo: 'app', number: 7 });
    expect(parseGiteaUrl('http://intra.corp/gitea', 'http://intra.corp/aoi/app')).toBeNull();
    for (const bad of ['https://github.com/aoi/cf-aoi/issues/12', 'http://gitea.corp:3000/aoi', 'http://gitea.corp:3000/aoi/cf-aoi/src/branch/main', 'http://gitea.corp:3000/aoi/cf-aoi/issues/x', 'not a url', '']) {
      expect(parseGiteaUrl(G, bad), bad).toBeNull();
    }
    expect(parseGiteaUrl('not a url', 'http://gitea.corp:3000/aoi/cf-aoi')).toBeNull();
  });
});

describe('credentials and the token for git over http', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('needs both gitea_url and GITEA_TOKEN, and never puts the token anywhere but the environment', () => {
    expect(giteaCreds(db, { GITEA_TOKEN: 'tok' })).toBeNull();
    setSetting(db, 'gitea_url', 'http://gitea.corp:3000/');
    expect(giteaCreds(db, {})).toBeNull();
    expect(giteaCreds(db, { GITEA_TOKEN: ' tok ' })).toEqual({ url: 'http://gitea.corp:3000', token: 'tok' });
    expect(giteaHostOf(db)).toBe('gitea.corp');
    expect(giteaGitEnv(db, {}, {})).toBeNull();
    const env = giteaGitEnv(db, {}, { GITEA_TOKEN: 'tok' })!;
    expect(env).toEqual({ GIT_ASKPASS: GIT_ASKPASS_SCRIPT, GIT_TERMINAL_PROMPT: '0', GITEA_TOKEN: 'tok' });
    // only an http(s) remote on the Gitea host gets the token — never another server, never ssh
    expect(giteaGitEnv(db, { remoteUrl: 'http://gitea.corp:3000/aoi/cf-aoi.git' }, { GITEA_TOKEN: 'tok' })).toEqual(env);
    expect(giteaGitEnv(db, { remoteUrl: 'https://GITEA.corp/aoi/cf-aoi' }, { GITEA_TOKEN: 'tok' })).toEqual(env);
    expect(giteaGitEnv(db, { remoteUrl: 'https://github.com/aoi/cf-aoi.git' }, { GITEA_TOKEN: 'tok' })).toBeNull();
    expect(giteaGitEnv(db, { remoteUrl: 'ssh://git@gitea.corp:2222/aoi/cf-aoi.git' }, { GITEA_TOKEN: 'tok' })).toBeNull();
    expect(giteaGitEnv(db, { remoteUrl: null }, { GITEA_TOKEN: 'tok' })).toBeNull();
  });

  it('the askpass script answers Username with oauth2 and Password with the token from the environment', () => {
    expect(fs.existsSync(GIT_ASKPASS_SCRIPT)).toBe(true);
    expect(fs.statSync(GIT_ASKPASS_SCRIPT).mode & 0o111).not.toBe(0);
    const ask = (prompt: string) => execFileSync(GIT_ASKPASS_SCRIPT, [prompt], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITEA_TOKEN: 's3cret' } });
    expect(ask("Username for 'http://gitea.corp:3000': ")).toBe('oauth2\n');
    expect(ask("Password for 'http://oauth2@gitea.corp:3000': ")).toBe('s3cret\n');
    expect(execFileSync(GIT_ASKPASS_SCRIPT, ['Password'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })).toBe('\n');
  });

  it('gitEnvFor reads the origin only once credentials exist, and only an http origin on the host gets them', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-gitenv-'));
    try {
      const git = (...a: string[]) => execFileSync('git', ['-C', tmp, ...a], { stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      const saved = process.env.GITEA_TOKEN;
      try {
        delete process.env.GITEA_TOKEN;
        setSetting(db, 'gitea_url', G);
        expect(gitEnvFor(db, tmp)).toBeUndefined();
        process.env.GITEA_TOKEN = 'tok';
        expect(gitEnvFor(db, tmp)).toBeUndefined(); // no origin at all
        git('remote', 'add', 'origin', 'https://github.com/aoi/app.git');
        expect(gitEnvFor(db, tmp)).toBeUndefined();
        git('remote', 'set-url', 'origin', 'http://gitea.corp:3000/aoi/app.git');
        expect(gitEnvFor(db, tmp)).toMatchObject({ GIT_ASKPASS: GIT_ASKPASS_SCRIPT, GITEA_TOKEN: 'tok' });
        expect(gitEnvFor(db, null)).toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env.GITEA_TOKEN;
        else process.env.GITEA_TOKEN = saved;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('giteaClientFor is null until the server and token are configured', () => {
    expect(giteaClientFor(db)).toBeNull();
  });
});

describe('the REST client', () => {
  it('reads a repo and its branches with the token', async () => {
    const calls: Call[] = [];
    const api = giteaClient(creds, {
      fetchImpl: fakeFetch([
        json({ full_name: 'aoi/cf-aoi', default_branch: 'develop', clone_url: 'http://gitea.corp:3000/aoi/cf-aoi.git', ssh_url: 'ssh://git@gitea.corp:2222/aoi/cf-aoi.git', html_url: 'http://gitea.corp:3000/aoi/cf-aoi', private: true }),
        json([{ name: 'develop', commit: { id: 'abc' } }, { name: 'main' }]),
      ], calls),
    });
    const repo = await api.getRepo('aoi', 'cf-aoi');
    expect(repo).toEqual({ ok: true, data: { full_name: 'aoi/cf-aoi', default_branch: 'develop', clone_url: 'http://gitea.corp:3000/aoi/cf-aoi.git', ssh_url: 'ssh://git@gitea.corp:2222/aoi/cf-aoi.git', html_url: 'http://gitea.corp:3000/aoi/cf-aoi', private: true } });
    expect(calls[0]!.url).toBe('http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi');
    expect(headersOf(calls[0]!).authorization).toBe('token tok');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    const branches = await api.listBranches('aoi', 'cf-aoi');
    expect(branches).toEqual({ ok: true, data: [{ name: 'develop', sha: 'abc' }, { name: 'main', sha: null }] });
    expect(calls[1]!.url).toBe('http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/branches?limit=100');
  });

  it('reads an issue with its attachments and downloads them with the token, on the Gitea host only', async () => {
    const calls: Call[] = [];
    const api = giteaClient(creds, {
      fetchImpl: fakeFetch([
        json({ number: 12, title: '第二次載入沒生效', body: 'steps…', state: 'open', html_url: 'http://gitea.corp:3000/aoi/cf-aoi/issues/12', labels: [{ id: 3, name: 'loop', color: 'ff0000' }], user: { login: 'wang' }, created_at: '2026-09-30T01:00:00Z', updated_at: '2026-09-30T02:00:00Z' }),
        json([{ id: 9, name: 'shot.png', size: 3, browser_download_url: 'http://gitea.corp:3000/attachments/uuid-9' }]),
        () => new Response(Buffer.from('png'), { status: 200, headers: { 'content-length': '3' } }),
      ], calls),
      maxAssetBytes: 10,
    });
    const r = await api.getIssue('aoi', 'cf-aoi', 12);
    expect(r).toEqual({
      ok: true,
      data: {
        number: 12, title: '第二次載入沒生效', body: 'steps…', state: 'open', html_url: 'http://gitea.corp:3000/aoi/cf-aoi/issues/12',
        labels: [{ id: 3, name: 'loop', color: 'ff0000' }], user: 'wang',
        assets: [{ id: 9, name: 'shot.png', size: 3, browser_download_url: 'http://gitea.corp:3000/attachments/uuid-9' }],
        created_at: '2026-09-30T01:00:00Z', updated_at: '2026-09-30T02:00:00Z',
      },
    });
    expect(calls.map((c) => c.url)).toEqual(['http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/issues/12', 'http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/issues/12/assets']);
    if (!r.ok) throw new Error(r.error);
    const dl = await api.downloadAsset(r.data.assets[0]!);
    expect(dl.ok && dl.data.toString()).toBe('png');
    expect(headersOf(calls[2]!).authorization).toBe('token tok');
    // the token never goes to another host, and a huge attachment is refused
    expect(await api.downloadAsset({ browser_download_url: 'http://evil.corp/attachments/x' })).toMatchObject({ ok: false, error: expect.stringContaining('不在 Gitea') });
    const big = giteaClient(creds, { fetchImpl: fakeFetch([() => new Response(Buffer.alloc(11), { status: 200 })]), maxAssetBytes: 10 });
    expect(await big.downloadAsset({ browser_download_url: 'http://gitea.corp:3000/attachments/y' })).toMatchObject({ ok: false, error: expect.stringContaining('太大') });
    // a bad index never reaches the server
    expect(await api.getIssue('aoi', 'cf-aoi', 0)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(3);
  });

  it('lists issues by label / state / since', async () => {
    const calls: Call[] = [];
    const api = giteaClient(creds, { fetchImpl: fakeFetch([json([{ number: 1, title: 'a' }, { number: 2, title: 'b', labels: null }])], calls) });
    const r = await api.listIssues('aoi', 'cf-aoi', { labels: ['loop', ' bug '], state: 'open', since: '2026-09-30T00:00:00Z', limit: 20 });
    expect(r.ok && r.data.map((i) => i.number)).toEqual([1, 2]);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/v1/repos/aoi/cf-aoi/issues');
    expect(Object.fromEntries(u.searchParams)).toEqual({ type: 'issues', state: 'open', limit: '20', page: '1', labels: 'loop,bug', since: '2026-09-30T00:00:00Z' });
  });

  it('comments, edits the comment in place, sets labels by name and closes the issue', async () => {
    const calls: Call[] = [];
    const api = giteaClient(creds, {
      fetchImpl: fakeFetch([
        json({ id: 77, html_url: 'http://gitea.corp:3000/aoi/cf-aoi/issues/12#issuecomment-77', body: 'Loop 已接單' }, 201),
        json({ id: 77, html_url: 'http://gitea.corp:3000/aoi/cf-aoi/issues/12#issuecomment-77', body: '驗證中' }),
        json([{ id: 3, name: 'loop' }, { id: 4, name: 'Loop:done' }]),
        json([{ id: 4, name: 'Loop:done' }]),
        json({ number: 12, state: 'closed' }, 201),
      ], calls),
    });
    expect(await api.createIssueComment('aoi', 'cf-aoi', 12, 'Loop 已接單')).toEqual({ ok: true, data: { id: 77, html_url: 'http://gitea.corp:3000/aoi/cf-aoi/issues/12#issuecomment-77', body: 'Loop 已接單' } });
    expect(calls[0]!.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({ body: 'Loop 已接單' });
    expect(headersOf(calls[0]!)['content-type']).toBe('application/json');
    expect(await api.editIssueComment('aoi', 'cf-aoi', 77, '驗證中')).toMatchObject({ ok: true, data: { id: 77, body: '驗證中' } });
    expect(calls[1]).toMatchObject({ url: 'http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/issues/comments/77', init: { method: 'PATCH' } });
    expect(await api.setIssueLabels('aoi', 'cf-aoi', 12, ['loop:done', 5])).toEqual({ ok: true, data: [{ id: 4, name: 'Loop:done', color: null }] });
    expect(calls[2]!.url).toBe('http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/labels?limit=100');
    expect(calls[3]).toMatchObject({ url: 'http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/issues/12/labels', init: { method: 'PUT' } });
    expect(bodyOf(calls[3]!)).toEqual({ labels: [5, 4] });
    expect(await api.closeIssue('aoi', 'cf-aoi', 12)).toEqual({ ok: true, data: { number: 12, state: 'closed' } });
    expect(calls[4]).toMatchObject({ init: { method: 'PATCH' } });
    expect(bodyOf(calls[4]!)).toEqual({ state: 'closed' });
    // a label the repo does not have is a clear error, and nothing is sent
    const missing = giteaClient(creds, { fetchImpl: fakeFetch([json([{ id: 3, name: 'loop' }])]) });
    expect(await missing.setIssueLabels('aoi', 'cf-aoi', 12, ['nope'])).toMatchObject({ ok: false, error: expect.stringContaining('nope') });
  });

  it('reads and merges a PR', async () => {
    const calls: Call[] = [];
    const api = giteaClient(creds, {
      fetchImpl: fakeFetch([
        json({ number: 3, title: 'fix', state: 'open', html_url: 'http://gitea.corp:3000/aoi/cf-aoi/pulls/3', head: { ref: 'loop/t1', sha: 'h' }, base: { ref: 'main', sha: 'b' }, merged: false, mergeable: true }),
        () => new Response('', { status: 200 }),
      ], calls),
    });
    expect(await api.getPr('aoi', 'cf-aoi', 3)).toEqual({ ok: true, data: { number: 3, title: 'fix', state: 'open', html_url: 'http://gitea.corp:3000/aoi/cf-aoi/pulls/3', head: { ref: 'loop/t1', sha: 'h' }, base: { ref: 'main', sha: 'b' }, merged: false, mergeable: true } });
    expect(await api.mergePr('aoi', 'cf-aoi', 3, { Do: 'merge', delete_branch_after_merge: true })).toEqual({ ok: true, data: { merged: true } });
    expect(calls[1]).toMatchObject({ url: 'http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/pulls/3/merge', init: { method: 'POST' } });
    expect(bodyOf(calls[1]!)).toEqual({ Do: 'merge', delete_branch_after_merge: true });
  });

  it('explains HTTP errors, a dead server and a timeout instead of throwing', async () => {
    const api = giteaClient(creds, {
      fetchImpl: fakeFetch([
        () => new Response(JSON.stringify({ message: 'token does not have at least one of required scope(s)' }), { status: 403 }),
        () => new Response('Not Found', { status: 404 }),
        () => new Response('{not json', { status: 200 }),
      ]),
    });
    const denied = await api.getRepo('aoi', 'cf-aoi');
    expect(denied).toEqual({ ok: false, error: expect.stringContaining('GITEA_TOKEN') });
    expect(!denied.ok && denied.error).toContain('required scope');
    expect(await api.getIssue('aoi', 'cf-aoi', 1)).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 404.*找不到/) });
    expect(await api.getPr('aoi', 'cf-aoi', 1)).toMatchObject({ ok: false, error: expect.stringContaining('沒有回傳') });
    const down = giteaClient(creds, { fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    expect(await down.listBranches('aoi', 'cf-aoi')).toEqual({ ok: false, error: 'Gitea 連不上：ECONNREFUSED' });
    // a server that never answers: the AbortSignal fires and the call resolves
    const hang = giteaClient(creds, {
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch,
    });
    expect(await hang.getRepo('aoi', 'cf-aoi')).toEqual({ ok: false, error: 'Gitea 逾時（0 秒）' });
    expect(await hang.downloadAsset({ browser_download_url: 'http://gitea.corp:3000/attachments/z' })).toMatchObject({ ok: false, error: expect.stringContaining('逾時') });
  });
});
