import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { upsertNode, addEdge } from '../knowledge/store.js';
import type { RelateExec } from '../knowledge/relate.js';
import type { EmbedExec } from '../knowledge/embed.js';

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

describe('knowledge REST: GET /api/knowledge/:id/evidence (SSoT Phase 4)', () => {
  it('returns [] for a node with no evidence links, and 404 for an unknown node', async () => {
    app = buildApp({ db, apiToken: null });
    const node = upsertNode(db, { title: 'No evidence yet', scope: 'global', status: 'draft' });

    const res = await app.inject({ method: 'GET', url: `/api/knowledge/${node.id}/evidence` });
    expect(res.statusCode).toBe(200);
    expect(res.json().evidence).toEqual([]);

    const missing = await app.inject({ method: 'GET', url: '/api/knowledge/k_doesnotexist/evidence' });
    expect(missing.statusCode).toBe(404);
  });

  it('returns citation-bearing chunks once linked via linkNodeToChunks', async () => {
    app = buildApp({ db, apiToken: null });
    const node = upsertNode(db, { title: 'Has evidence', scope: 'global', status: 'draft' });
    db.prepare(`INSERT INTO sources (id, kind, uri) VALUES ('src_1', 'git', '/repo')`).run();
    const docId = Number(
      db.prepare(`INSERT INTO documents (source_id, path, doc_kind) VALUES ('src_1', 'a.ts', 'ts')`).run()
        .lastInsertRowid,
    );
    const chunkId = Number(
      db.prepare(`INSERT INTO chunks (document_id, ord, text) VALUES (?, 0, 'supporting chunk text')`).run(docId)
        .lastInsertRowid,
    );
    db.prepare(`INSERT INTO node_chunk_links (node_id, chunk_id) VALUES (?, ?)`).run(node.id, chunkId);

    const res = await app.inject({ method: 'GET', url: `/api/knowledge/${node.id}/evidence` });
    expect(res.statusCode).toBe(200);
    const { evidence } = res.json();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ chunk_id: chunkId, path: 'a.ts', relation: 'evidences' });
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

// ---- 7. auto-relate: POST /api/knowledge/relate + draft edge approve/reject ----

describe('knowledge REST: auto-relate (POST /api/knowledge/relate + draft edges)', () => {
  const DIM = 1024; // matches embed_dim default -- vec_nodes rejects any other length
  function vec(idx: number): number[] {
    const v = new Array(DIM).fill(0);
    v[idx] = 1;
    return v;
  }

  it('creates draft edges via injected relateLlmExec/relateEmbedExec, lists them, and approves one', async () => {
    const a = upsertNode(db, { title: 'Relate A', body: 'body a', scope: 'global' });
    const b = upsertNode(db, { title: 'Relate B', body: 'body b', scope: 'global' });

    const relateEmbedExec: EmbedExec = async (_bin, _args, texts) => texts.map(() => vec(0));
    const relateLlmExec: RelateExec = async () => JSON.stringify({ edges: [{ src: a.id, dst: b.id, relation: 'uses' }] });

    app = buildApp({ db, apiToken: null, relateLlmExec, relateEmbedExec });

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/relate', payload: {} });
    expect(res.statusCode).toBe(200);
    const { edges } = res.json();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: a.id, dst: b.id, relation: 'uses', status: 'draft' });

    const drafts = await app.inject({ method: 'GET', url: '/api/knowledge/edges/drafts' });
    expect(drafts.statusCode).toBe(200);
    expect(drafts.json().edges).toHaveLength(1);

    const approve = await app.inject({ method: 'POST', url: `/api/knowledge/edges/${edges[0].id}/approve` });
    expect(approve.statusCode).toBe(200);

    const afterApprove = await app.inject({ method: 'GET', url: '/api/knowledge/edges/drafts' });
    expect(afterApprove.json().edges).toHaveLength(0); // approved -- no longer a pending draft

    const missing = await app.inject({ method: 'POST', url: '/api/knowledge/edges/999999/approve' });
    expect(missing.statusCode).toBe(404);
  });

  it('a draft edge (created directly, bypassing relate) never appears in GET /api/knowledge/graph; reject keeps the row but drops it from the drafts list', async () => {
    app = buildApp({ db, apiToken: null });
    const a = upsertNode(db, { title: 'Reject A', scope: 'global' });
    const b = upsertNode(db, { title: 'Reject B', scope: 'global' });
    const draft = addEdge(db, { src: a.id, dst: b.id, relation: 'related', status: 'draft' })!;

    const g = await app.inject({ method: 'GET', url: '/api/knowledge/graph' });
    expect(g.json().edges.some((e: any) => e.id === draft.id)).toBe(false);

    const reject = await app.inject({ method: 'POST', url: `/api/knowledge/edges/${draft.id}/reject` });
    expect(reject.statusCode).toBe(200);

    const drafts = await app.inject({ method: 'GET', url: '/api/knowledge/edges/drafts' });
    expect(drafts.json().edges).toHaveLength(0);

    const missing = await app.inject({ method: 'POST', url: '/api/knowledge/edges/999999/reject' });
    expect(missing.statusCode).toBe(404);
  });
});
