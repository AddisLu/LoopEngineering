import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { upsertNode } from '../knowledge/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, '..', '..', 'seed', 'knowledge-seed.json');

let db: Database.Database;
let app: FastifyInstance;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
});
afterEach(async () => {
  await app?.close();
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  tmpRoots = [];
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-know-api-${tag}-`));
  tmpRoots.push(d);
  return d;
}

// ---- 1. CRUD + validation + auth ----

describe('knowledge REST: CRUD + validation', () => {
  it('creates, lists, and hard-deletes a node; rejects malformed input with 400', async () => {
    app = buildApp({ db, apiToken: null });

    const created = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Node version', body: 'Use Node 20', kind: 'tech', scope: 'global', weight: 4 },
    });
    expect(created.statusCode).toBe(200);
    const { node } = created.json();
    expect(node.id).toMatch(/^k_/);
    expect(node.kind).toBe('tech');

    const listed = await app.inject({ method: 'GET', url: '/api/knowledge' });
    expect(listed.json().nodes.some((n: any) => n.id === node.id)).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/knowledge/${node.id}` });
    expect(del.statusCode).toBe(200);
    const del404 = await app.inject({ method: 'DELETE', url: `/api/knowledge/${node.id}` });
    expect(del404.statusCode).toBe(404);
  });

  it('400s on missing title, bad kind, bad status, bad scope, and out-of-range weight', async () => {
    app = buildApp({ db, apiToken: null });

    const noTitle = await app.inject({ method: 'POST', url: '/api/knowledge', payload: { body: 'x' } });
    expect(noTitle.statusCode).toBe(400);

    const badKind = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 't', kind: 'not-a-kind' },
    });
    expect(badKind.statusCode).toBe(400);

    const badStatus = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 't', status: 'not-a-status' },
    });
    expect(badStatus.statusCode).toBe(400);

    const badScope = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 't', scope: 'nonsense' },
    });
    expect(badScope.statusCode).toBe(400);

    const badWeight = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 't', weight: 6 },
    });
    expect(badWeight.statusCode).toBe(400);
  });

  it('enforces bearer auth on /api/knowledge when a token is set', async () => {
    app = buildApp({ db, apiToken: 'secret' });
    const noauth = await app.inject({ method: 'GET', url: '/api/knowledge' });
    expect(noauth.statusCode).toBe(401);

    const withAuth = await app.inject({
      method: 'GET',
      url: '/api/knowledge',
      headers: { authorization: 'Bearer secret' },
    });
    expect(withAuth.statusCode).toBe(200);
  });
});

// ---- 1b. environment on task creation + kind=environment filter ----

describe('knowledge REST: environment on tasks + kind filter', () => {
  it('POST /api/tasks persists environment; GET /api/tasks/:id returns it', async () => {
    app = buildApp({ db, apiToken: null });

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'env task', goal: 'do it', environment: 'company' },
    });
    expect(created.statusCode).toBe(200);
    const { task } = created.json();
    expect(task.environment).toBe('company');

    const fetched = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(fetched.json().task.environment).toBe('company');

    const noEnv = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'no env task', goal: 'do it' },
    });
    expect(noEnv.json().task.environment).toBeNull();
  });

  it('GET /api/knowledge?kind=environment returns only environment-kind nodes', async () => {
    app = buildApp({ db, apiToken: null });
    upsertNode(db, { kind: 'environment', title: 'Company env', scope: 'env:company' });
    upsertNode(db, { kind: 'environment', title: 'Home env', scope: 'env:home' });
    upsertNode(db, { kind: 'constraint', title: 'Some constraint', scope: 'env:company' });
    upsertNode(db, { kind: 'fact', title: 'Random fact', scope: 'global' });

    const res = await app.inject({ method: 'GET', url: '/api/knowledge?kind=environment' });
    expect(res.statusCode).toBe(200);
    const { nodes } = res.json();
    expect(nodes.length).toBe(2);
    expect(nodes.every((n: any) => n.kind === 'environment')).toBe(true);
    expect(nodes.map((n: any) => n.title).sort()).toEqual(['Company env', 'Home env']);
  });
});

// ---- 2. FTS search over imported seed ----

describe('knowledge REST: FTS search after seed import', () => {
  it('finds the 3.8-compatibility constraint node via ?q=3.8', async () => {
    app = buildApp({ db, apiToken: null });
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    const imported = await app.inject({ method: 'POST', url: '/api/knowledge/import', payload: seed });
    expect(imported.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/knowledge?q=3.8' });
    expect(res.statusCode).toBe(200);
    const { nodes } = res.json();
    expect(nodes.some((n: any) => n.title === 'Python 3.8 相容性約束')).toBe(true);
  });
});

// ---- 3. approve/reject/invalidate ----

describe('knowledge REST: draft workflow + invalidate', () => {
  it('approves and rejects draft nodes, and excludes invalidated nodes from default GET', async () => {
    app = buildApp({ db, apiToken: null });

    const toApprove = upsertNode(db, { title: 'Draft A', scope: 'global', status: 'draft' });
    const toReject = upsertNode(db, { title: 'Draft B', scope: 'global', status: 'draft' });
    const toInvalidate = upsertNode(db, { title: 'Old fact', scope: 'global' });

    const approve = await app.inject({ method: 'POST', url: `/api/knowledge/${toApprove.id}/approve` });
    expect(approve.statusCode).toBe(200);
    const reject = await app.inject({ method: 'POST', url: `/api/knowledge/${toReject.id}/reject` });
    expect(reject.statusCode).toBe(200);

    const listed = (await app.inject({ method: 'GET', url: '/api/knowledge' })).json().nodes;
    expect(listed.find((n: any) => n.id === toApprove.id)?.status).toBe('approved');
    expect(listed.find((n: any) => n.id === toReject.id)?.status).toBe('rejected');

    const invalidate = await app.inject({
      method: 'POST',
      url: `/api/knowledge/${toInvalidate.id}/invalidate`,
    });
    expect(invalidate.statusCode).toBe(200);
    const afterInvalidate = (await app.inject({ method: 'GET', url: '/api/knowledge' })).json().nodes;
    expect(afterInvalidate.find((n: any) => n.id === toInvalidate.id)).toBeUndefined();

    const missing = await app.inject({ method: 'POST', url: '/api/knowledge/k_doesnotexist/approve' });
    expect(missing.statusCode).toBe(404);
  });
});

// ---- 4. graph shape ----

describe('knowledge REST: graph payload', () => {
  it('returns { nodes, edges } including an edge created via the edges endpoint', async () => {
    app = buildApp({ db, apiToken: null });
    const a = upsertNode(db, { title: 'Graph A', scope: 'global' });
    const b = upsertNode(db, { title: 'Graph B', scope: 'global' });

    const addEdge = await app.inject({
      method: 'POST',
      url: '/api/knowledge/edges',
      payload: { src: a.id, dst: b.id, relation: 'uses' },
    });
    expect(addEdge.statusCode).toBe(200);
    const edgeId = addEdge.json().edge.id;

    const g = await app.inject({ method: 'GET', url: '/api/knowledge/graph' });
    expect(g.statusCode).toBe(200);
    const body = g.json();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.nodes.some((n: any) => n.id === a.id)).toBe(true);
    expect(body.edges.some((e: any) => e.src === a.id && e.dst === b.id && e.relation === 'uses')).toBe(true);

    const delEdge = await app.inject({ method: 'DELETE', url: `/api/knowledge/edges/${edgeId}` });
    expect(delEdge.statusCode).toBe(200);
    const del404 = await app.inject({ method: 'DELETE', url: `/api/knowledge/edges/${edgeId}` });
    expect(del404.statusCode).toBe(404);
  });

  it('SSoT Phase 3: ?nodeId=&depth= restricts the graph to a multi-hop neighborhood, and the payload always includes documents', async () => {
    app = buildApp({ db, apiToken: null });
    const a = upsertNode(db, { title: 'Hop A', scope: 'global' });
    const b = upsertNode(db, { title: 'Hop B', scope: 'global' });
    const c = upsertNode(db, { title: 'Hop C', scope: 'global' });
    await app.inject({ method: 'POST', url: '/api/knowledge/edges', payload: { src: a.id, dst: b.id, relation: 'related' } });
    await app.inject({ method: 'POST', url: '/api/knowledge/edges', payload: { src: b.id, dst: c.id, relation: 'related' } });

    const whole = await app.inject({ method: 'GET', url: '/api/knowledge/graph' });
    expect(whole.statusCode).toBe(200);
    expect(Array.isArray(whole.json().documents)).toBe(true);
    expect(whole.json().nodes.map((n: any) => n.id).sort()).toEqual([a.id, b.id, c.id].sort());

    const oneHop = await app.inject({ method: 'GET', url: `/api/knowledge/graph?nodeId=${a.id}&depth=1` });
    expect(oneHop.statusCode).toBe(200);
    expect(oneHop.json().nodes.map((n: any) => n.id).sort()).toEqual([a.id, b.id].sort());
  });
});

// ---- 5. import idempotency ----

describe('knowledge REST: import idempotency', () => {
  it('running the same import twice updates in place instead of duplicating', async () => {
    app = buildApp({ db, apiToken: null });
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

    const first = await app.inject({ method: 'POST', url: '/api/knowledge/import', payload: seed });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.created).toBe(seed.items.length);
    expect(firstBody.updated).toBe(0);
    expect(firstBody.edges).toBe(seed.edges.length);

    const second = await app.inject({ method: 'POST', url: '/api/knowledge/import', payload: seed });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.created).toBe(0);
    expect(secondBody.updated).toBe(seed.items.length);
    // edges are unique(src,dst,relation) -- re-adding the same edges dedups to 0 new
    expect(secondBody.edges).toBe(0);

    const listed = (await app.inject({ method: 'GET', url: '/api/knowledge' })).json().nodes;
    const seedTitles = new Set(seed.items.map((n: any) => n.title));
    expect(listed.filter((n: any) => seedTitles.has(n.title))).toHaveLength(seed.items.length);
  });
});

// ---- 6. export-claude-md ----

describe('knowledge REST: export-claude-md', () => {
  it('creates CLAUDE.md, replaces the block (not duplicates) on re-export, preserves user content, and refuses a bad path', async () => {
    app = buildApp({ db, apiToken: null });
    upsertNode(db, { kind: 'environment', title: 'Env node', body: 'env body', scope: 'global', weight: 5 });

    const repo = mkTmpDir('export-repo');
    const claudeMdPath = path.join(repo, 'CLAUDE.md');
    const userContent = '# My Project\n\nSome hand-written notes.\n';
    fs.writeFileSync(claudeMdPath, userContent);

    const first = await app.inject({
      method: 'POST',
      url: '/api/knowledge/export-claude-md',
      payload: { repo_path: repo },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().nodeCount).toBe(1);

    const afterFirst = fs.readFileSync(claudeMdPath, 'utf8');
    expect(afterFirst).toContain(userContent.trim());
    expect(afterFirst).toContain('Env node');
    expect((afterFirst.match(/loop-knowledge:start/g) ?? []).length).toBe(1);

    // add a draft node (should NOT show up in export -- only approved/active + right kinds)
    upsertNode(db, { kind: 'fact', title: 'Random fact', body: 'irrelevant kind', scope: 'global' });

    const second = await app.inject({
      method: 'POST',
      url: '/api/knowledge/export-claude-md',
      payload: { repo_path: repo },
    });
    expect(second.statusCode).toBe(200);

    const afterSecond = fs.readFileSync(claudeMdPath, 'utf8');
    expect((afterSecond.match(/loop-knowledge:start/g) ?? []).length).toBe(1); // replaced, not duplicated
    expect(afterSecond).toContain(userContent.trim()); // byte-preserved outside markers
    expect(afterSecond).not.toContain('Random fact'); // wrong kind stays out of the export

    const bad = await app.inject({
      method: 'POST',
      url: '/api/knowledge/export-claude-md',
      payload: { repo_path: path.join(repo, 'does-not-exist') },
    });
    expect(bad.statusCode).toBe(400);
  });
});
