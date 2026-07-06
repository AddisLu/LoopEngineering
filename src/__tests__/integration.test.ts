import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createTask, getTask, getTaskBySourceRef, listTasks, setStatus } from '../tasks.js';
import { createGithubProvider } from '../integrations/github.js';
import { createAdoProvider } from '../integrations/ado.js';
import { resolveProvider } from '../integrations/config.js';
import { importWorkItems } from '../integrations/import.js';
import { pumpPushback } from '../integrations/pushback.js';
import { buildSourceRef, parseSourceRef, sourceRefProvider } from '../integrations/sourceRef.js';
import type { WorkItem, WorkProvider, PushResultInput } from '../integrations/types.js';

let db: Database.Database;
let app: FastifyInstance | undefined;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  tmpRoots = [];
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_API_URL;
  delete process.env.ADO_PAT;
  delete process.env.ADO_ORG;
  delete process.env.ADO_PROJECT;
  vi.unstubAllGlobals();
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function makeRepo(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `loop-integ-${tag}-`));
  tmpRoots.push(root);
  const repo = path.join(root, 'repo');
  git(root, ['init', '-b', 'main', 'repo']);
  git(repo, ['config', 'user.email', 'loop@test.local']);
  git(repo, ['config', 'user.name', 'Loop Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'v1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--no-verify', '-m', 'seed']);
  return repo;
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---- 1. github/ado listWorkItems: injected fetch -> parsed WorkItem[]; error -> [] ----

describe('github provider', () => {
  it('listWorkItems parses the search/issues response into WorkItem[]', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return jsonResponse({
        items: [
          {
            number: 123,
            title: 'Fix the thing',
            body: 'details here',
            html_url: 'https://github.com/owner/name/issues/123',
            repository_url: 'https://api.github.com/repos/owner/name',
          },
        ],
      });
    }) as typeof fetch;
    const provider = createGithubProvider({ token: 't', fetchImpl });
    const items = await provider.listWorkItems('assignee:@me label:loop');
    expect(items).toEqual([
      { id: '123', title: 'Fix the thing', body: 'details here', url: 'https://github.com/owner/name/issues/123', repo: 'owner/name' },
    ]);
    expect(calls[0]).toContain('/search/issues?q=');
  });

  it('never throws: a fetch error or non-ok response resolves to []', async () => {
    const throwing = createGithubProvider({ token: 't', fetchImpl: (async () => { throw new Error('network down'); }) as typeof fetch });
    expect(await throwing.listWorkItems('q')).toEqual([]);

    const non200 = createGithubProvider({ token: 't', fetchImpl: (async () => jsonResponse({}, false, 500)) as typeof fetch });
    expect(await non200.listWorkItems('q')).toEqual([]);
  });

  it('pushResult POSTs the comment with PR link + status to the right issue', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
      return jsonResponse({ id: 1 });
    }) as typeof fetch;
    const provider = createGithubProvider({ token: 't', fetchImpl });
    const item: WorkItem = { id: '123', title: 'x', body: '', url: '', repo: 'owner/name' };
    await provider.pushResult(item, { pr_url: 'https://github.com/owner/name/pull/9', status: 'review', merge_status: 'merged' });
    expect(captured!.url).toBe('https://api.github.com/repos/owner/name/issues/123/comments');
    expect((captured!.body as { body: string }).body).toContain('https://github.com/owner/name/pull/9');
    expect((captured!.body as { body: string }).body).toContain('review');
  });

  it('pushResult never throws on a failing request', async () => {
    const provider = createGithubProvider({ token: 't', fetchImpl: (async () => { throw new Error('boom'); }) as typeof fetch });
    await expect(
      provider.pushResult({ id: '1', title: '', body: '', url: '', repo: 'a/b' }, { pr_url: null, status: 'closed', merge_status: null }),
    ).resolves.toBeUndefined();
  });
});

describe('ado provider', () => {
  it('listWorkItems runs the WIQL query then batches field lookups into WorkItem[]', async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/wiql')) return jsonResponse({ workItems: [{ id: 42 }] });
      if (u.includes('/workitems?ids=')) {
        return jsonResponse({
          value: [
            { id: 42, fields: { 'System.Title': 'Do the thing', 'System.Description': 'desc' }, _links: { html: { href: 'https://dev.azure.com/org/project/_workitems/edit/42' } } },
          ],
        });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof fetch;
    const provider = createAdoProvider({ pat: 'p', org: 'org', project: 'project', fetchImpl });
    const items = await provider.listWorkItems('SELECT [System.Id] FROM WorkItems');
    expect(items).toEqual([
      { id: '42', title: 'Do the thing', body: 'desc', url: 'https://dev.azure.com/org/project/_workitems/edit/42' },
    ]);
  });

  it('never throws: a fetch error resolves to []', async () => {
    const provider = createAdoProvider({ pat: 'p', org: 'o', project: 'pr', fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch });
    expect(await provider.listWorkItems('q')).toEqual([]);
  });

  it('pushResult POSTs a comment with PR link + status to the work item', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
      return jsonResponse({ id: 1 });
    }) as typeof fetch;
    const provider = createAdoProvider({ pat: 'p', org: 'org', project: 'proj', fetchImpl });
    await provider.pushResult({ id: '42', title: '', body: '', url: '' }, { pr_url: 'https://x/pr/1', status: 'review', merge_status: 'pending' });
    expect(captured!.url).toContain('/_apis/wit/workItems/42/comments');
    expect((captured!.body as { text: string }).text).toContain('https://x/pr/1');
  });
});

// ---- sourceRef round-trip ----

describe('sourceRef encode/decode', () => {
  it('round-trips a github item (repo-qualified)', () => {
    const item: WorkItem = { id: '7', title: 't', body: '', url: '', repo: 'owner/name' };
    const ref = buildSourceRef('github', item);
    expect(ref).toBe('github:owner/name#7');
    expect(sourceRefProvider(ref)).toBe('github');
    expect(parseSourceRef(ref, { title: 't' })).toEqual({ id: '7', title: 't', body: '', url: '', repo: 'owner/name' });
  });

  it('round-trips an ado item (no repo)', () => {
    const item: WorkItem = { id: '99', title: 't', body: '', url: '' };
    const ref = buildSourceRef('ado', item);
    expect(ref).toBe('ado:99');
    expect(parseSourceRef(ref, { title: 't' })).toEqual({ id: '99', title: 't', body: '', url: '', repo: undefined });
  });

  it('parseSourceRef returns null for a malformed ref', () => {
    expect(parseSourceRef('', { title: 't' })).toBeNull();
    expect(parseSourceRef('no-colon', { title: 't' })).toBeNull();
  });
});

// ---- 2. import: WorkItems -> tasks with source_ref, idempotent, respects default repo/queue ----

describe('importWorkItems', () => {
  function fakeProvider(items: WorkItem[]): WorkProvider {
    return {
      name: 'github',
      listWorkItems: async () => items,
      pushResult: async () => {},
    };
  }

  it('creates one task per WorkItem, tagged with source_ref', async () => {
    const items: WorkItem[] = [
      { id: '1', title: 'Issue one', body: 'body one', url: 'https://x/1', repo: 'owner/name' },
      { id: '2', title: 'Issue two', body: 'body two', url: 'https://x/2', repo: 'owner/name' },
    ];
    const result = await importWorkItems(db, fakeProvider(items), 'q');
    expect(result.created).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(result.created.map((t) => t.source_ref).sort()).toEqual(['github:owner/name#1', 'github:owner/name#2']);
    expect(result.created[0].title).toBe('Issue one');
    expect(result.created[0].goal).toBe('body one');
  });

  it('is idempotent: re-running the same query never creates duplicate tasks', async () => {
    const items: WorkItem[] = [{ id: '1', title: 'Issue one', body: 'b', url: 'https://x/1', repo: 'owner/name' }];
    const first = await importWorkItems(db, fakeProvider(items), 'q');
    expect(first.created).toHaveLength(1);

    const second = await importWorkItems(db, fakeProvider(items), 'q');
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual(['github:owner/name#1']);
    expect(listTasks(db)).toHaveLength(1);
    expect(getTaskBySourceRef(db, 'github:owner/name#1')).toBeTruthy();
  });

  it('applies the default repo_path/base_branch/verification_steps to every created task', async () => {
    const repo = makeRepo('import-defaults');
    const items: WorkItem[] = [{ id: '1', title: 't', body: 'b', url: 'https://x/1', repo: 'owner/name' }];
    const result = await importWorkItems(db, fakeProvider(items), 'q', {
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['true'],
    });
    const t = result.created[0];
    expect(t.repo_path).toBe(repo);
    expect(t.base_branch).toBe('main');
    expect(JSON.parse(t.verification_steps)).toEqual(['true']);
  });

  it('auto-queues created tasks up to max_autoqueue (gate permitting), leaves the rest draft', async () => {
    const repo = makeRepo('import-queue');
    setSetting(db, 'max_autoqueue', '1');
    const items: WorkItem[] = [
      { id: '1', title: 'a', body: 'b', url: 'https://x/1', repo: 'owner/name' },
      { id: '2', title: 'b', body: 'b', url: 'https://x/2', repo: 'owner/name' },
    ];
    const result = await importWorkItems(db, fakeProvider(items), 'q', { repo_path: repo, base_branch: 'main', verification_steps: ['true'] });
    const statuses = result.created.map((t) => getTask(db, t.id)!.status).sort();
    expect(statuses).toEqual(['draft', 'queued']);
  });

  it('a task missing repo/base fails the gate and stays draft (never auto-queued)', async () => {
    const items: WorkItem[] = [{ id: '1', title: 't', body: 'b', url: 'https://x/1' }];
    const result = await importWorkItems(db, fakeProvider(items), 'q'); // no repo_path/base_branch
    expect(getTask(db, result.created[0].id)!.status).toBe('draft');
  });
});

// ---- 3 + 4. pushback pump: fires for a source_ref task reaching review/closed, gated by
// integration_pushback, skips when no provider is configured ----

describe('pumpPushback', () => {
  function spyProvider(): { provider: WorkProvider; calls: { item: WorkItem; result: PushResultInput }[] } {
    const calls: { item: WorkItem; result: PushResultInput }[] = [];
    return {
      calls,
      provider: {
        name: 'github',
        listWorkItems: async () => [],
        pushResult: async (item, result) => {
          calls.push({ item, result });
        },
      },
    };
  }

  it('fires pushResult for a source_ref task reaching review, with the PR link + status', async () => {
    setSetting(db, 'integration_pushback', 'true');
    const task = (await importWorkItems(db, { name: 'github', listWorkItems: async () => [{ id: '1', title: 'Fix it', body: 'b', url: 'https://x/1', repo: 'o/n' }], pushResult: async () => {} }, 'q')).created[0];
    db.prepare('UPDATE tasks SET pr_url = ?, merge_status = ? WHERE id = ?').run('https://github.com/o/n/pull/5', 'merged', task.id);
    const lastId = (db.prepare('SELECT COALESCE(MAX(id),0) n FROM task_events').get() as { n: number }).n;
    setStatus(db, task.id, 'review', { detail: 'verification passed' });

    const { provider, calls } = spyProvider();
    const cursor = await pumpPushback(db, lastId, { provider });
    expect(calls).toHaveLength(1);
    expect(calls[0].item.id).toBe('1');
    expect(calls[0].result).toEqual({ pr_url: 'https://github.com/o/n/pull/5', status: 'review', merge_status: 'merged' });
    expect(cursor).toBeGreaterThan(lastId);
  });

  it('flag off (integration_pushback=false, the default): never calls the provider', async () => {
    const task = (await importWorkItems(db, { name: 'github', listWorkItems: async () => [{ id: '1', title: 't', body: 'b', url: 'https://x/1', repo: 'o/n' }], pushResult: async () => {} }, 'q')).created[0];
    const lastId = (db.prepare('SELECT COALESCE(MAX(id),0) n FROM task_events').get() as { n: number }).n;
    setStatus(db, task.id, 'review', {});

    const { provider, calls } = spyProvider();
    await pumpPushback(db, lastId, { provider });
    expect(calls).toHaveLength(0);
  });

  it('skips when no provider is configured (provider=none)', async () => {
    setSetting(db, 'integration_pushback', 'true');
    const task = (await importWorkItems(db, { name: 'github', listWorkItems: async () => [{ id: '1', title: 't', body: 'b', url: 'https://x/1', repo: 'o/n' }], pushResult: async () => {} }, 'q')).created[0];
    const lastId = (db.prepare('SELECT COALESCE(MAX(id),0) n FROM task_events').get() as { n: number }).n;
    setStatus(db, task.id, 'review', {});

    // opts.provider explicitly null simulates resolveProvider(db) returning null (unconfigured)
    await expect(pumpPushback(db, lastId, { provider: null })).resolves.toBeGreaterThan(lastId);
  });

  it('ignores a task with no source_ref (a normal task reaching review)', async () => {
    setSetting(db, 'integration_pushback', 'true');
    const task = createTask(db, { title: 'plain', goal: 'g', verification_steps: ['true'] });
    const lastId = (db.prepare('SELECT COALESCE(MAX(id),0) n FROM task_events').get() as { n: number }).n;
    setStatus(db, task.id, 'review', {});

    const { provider, calls } = spyProvider();
    await pumpPushback(db, lastId, { provider });
    expect(calls).toHaveLength(0);
  });
});

// ---- 5. gate: provider=none -> zero external calls, and the REST route is credential-gated ----

describe('resolveProvider: credential + flag gating (zero calls when off)', () => {
  it("defaults to 'none' -> resolveProvider returns null (no external calls possible)", () => {
    expect(resolveProvider(db)).toBeNull();
  });

  it("integration_provider='github' without GITHUB_TOKEN -> still null (credential-gated)", () => {
    setSetting(db, 'integration_provider', 'github');
    expect(resolveProvider(db)).toBeNull();
  });

  it("integration_provider='github' with GITHUB_TOKEN -> resolves a github provider", () => {
    setSetting(db, 'integration_provider', 'github');
    process.env.GITHUB_TOKEN = 'tok';
    const provider = resolveProvider(db);
    expect(provider?.name).toBe('github');
  });

  it("integration_provider='ado' needs ALL of ADO_PAT/ADO_ORG/ADO_PROJECT, else null", () => {
    setSetting(db, 'integration_provider', 'ado');
    process.env.ADO_PAT = 'p';
    process.env.ADO_ORG = 'o';
    expect(resolveProvider(db)).toBeNull(); // ADO_PROJECT missing
    process.env.ADO_PROJECT = 'proj';
    expect(resolveProvider(db)?.name).toBe('ado');
  });
});

describe('POST /api/integrations/import: credential-gated REST route', () => {
  it('400s without a query', async () => {
    app = buildApp({ db, apiToken: null });
    const r = await app.inject({ method: 'POST', url: '/api/integrations/import', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it("409s when integration_provider is 'none' (the default) — no external call is attempted", async () => {
    app = buildApp({ db, apiToken: null });
    const r = await app.inject({ method: 'POST', url: '/api/integrations/import', payload: { query: 'assignee:@me' } });
    expect(r.statusCode).toBe(409);
  });

  it('409s when the configured provider has no credentials in env', async () => {
    setSetting(db, 'integration_provider', 'github');
    app = buildApp({ db, apiToken: null });
    const r = await app.inject({ method: 'POST', url: '/api/integrations/import', payload: { query: 'assignee:@me' } });
    expect(r.statusCode).toBe(409);
  });

  it('400s when the body provider does not match the configured one', async () => {
    setSetting(db, 'integration_provider', 'github');
    process.env.GITHUB_TOKEN = 'tok';
    app = buildApp({ db, apiToken: null });
    const r = await app.inject({ method: 'POST', url: '/api/integrations/import', payload: { provider: 'ado', query: 'q' } });
    expect(r.statusCode).toBe(400);
  });

  it('imports via the full route once configured, with the network call injected through global fetch', async () => {
    setSetting(db, 'integration_provider', 'github');
    process.env.GITHUB_TOKEN = 'tok';
    vi.stubGlobal('fetch', (async () =>
      jsonResponse({
        items: [{ number: 5, title: 'Imported issue', body: 'desc', html_url: 'https://x/5', repository_url: 'https://api.github.com/repos/owner/name' }],
      })) as typeof fetch);
    app = buildApp({ db, apiToken: null });
    const r = await app.inject({ method: 'POST', url: '/api/integrations/import', payload: { provider: 'github', query: 'q' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.created).toHaveLength(1);
    expect(getTaskBySourceRef(db, 'github:owner/name#5')).toBeTruthy();
  });
});
