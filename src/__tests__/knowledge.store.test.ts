import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import {
  upsertNode,
  getNode,
  listNodes,
  searchNodes,
  invalidateNode,
  deleteNode,
  addEdge,
  getEdge,
  setEdgeStatus,
  listDraftEdges,
  edgesFor,
  graph,
} from '../knowledge/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

describe('knowledge: FTS5 trigram runtime probe', () => {
  it('the bundled SQLite build supports tokenize=trigram (required for Chinese)', () => {
    expect(() => {
      db.exec(`CREATE VIRTUAL TABLE probe_trigram USING fts5(x, tokenize='trigram')`);
      db.exec(`DROP TABLE probe_trigram`);
    }).not.toThrow();
  });
});

describe('knowledge: node CRUD round-trip', () => {
  it('persists all fields including tags JSON', () => {
    const node = upsertNode(db, {
      kind: 'tech',
      title: 'Node version',
      body: 'Use Node 20 LTS',
      tags: ['node', 'infra'],
      scope: 'global',
      source: 'manual',
      status: 'approved',
      weight: 4,
    });
    expect(node.id).toMatch(/^k_/);

    const fetched = getNode(db, node.id)!;
    expect(fetched.title).toBe('Node version');
    expect(fetched.body).toBe('Use Node 20 LTS');
    expect(JSON.parse(fetched.tags)).toEqual(['node', 'infra']);
    expect(fetched.kind).toBe('tech');
    expect(fetched.weight).toBe(4);
    expect(fetched.invalid_at).toBeNull();
  });
});

describe('knowledge: FTS finds CJK substrings', () => {
  it('finds "3.8" and "只能" inside a CJK body, and plain English terms', () => {
    upsertNode(db, {
      title: 'Company environment',
      body: '公司只能用 Windows 11 + Python 3.8.10',
      scope: 'global',
    });

    expect(searchNodes(db, '3.8').length).toBeGreaterThan(0);
    expect(searchNodes(db, '只能').length).toBeGreaterThan(0); // 2-char CJK -> LIKE fallback
    expect(searchNodes(db, 'Windows').length).toBeGreaterThan(0);
    expect(searchNodes(db, 'nonexistent-term').length).toBe(0);
  });
});

describe('knowledge: FTS trigger sync', () => {
  it('UPDATE flips which text matches; DELETE removes the row from the index', () => {
    const node = upsertNode(db, { title: 'Sync test', body: 'alpha marker text', scope: 'global' });
    expect(searchNodes(db, 'alpha').length).toBe(1);
    expect(searchNodes(db, 'beta').length).toBe(0);

    db.prepare('UPDATE knowledge_nodes SET body = ? WHERE id = ?').run('beta marker text', node.id);
    expect(searchNodes(db, 'alpha').length).toBe(0);
    expect(searchNodes(db, 'beta').length).toBe(1);

    db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(node.id);
    expect(searchNodes(db, 'beta').length).toBe(0);
  });
});

describe('knowledge: edge cascade + UNIQUE(src,dst,relation) idempotency', () => {
  it('cascades edges on node hard-delete and dedups repeated addEdge calls', () => {
    const a = upsertNode(db, { title: 'Node A', scope: 'global' });
    const b = upsertNode(db, { title: 'Node B', scope: 'global' });

    const e1 = addEdge(db, { src: a.id, dst: b.id, relation: 'uses' });
    const e2 = addEdge(db, { src: a.id, dst: b.id, relation: 'uses' });
    expect(e1?.id).toBe(e2?.id);
    expect(edgesFor(db, [a.id, b.id])).toHaveLength(1);

    deleteNode(db, a.id);
    expect(edgesFor(db, [a.id, b.id])).toHaveLength(0);
    expect(getNode(db, b.id)).toBeDefined(); // only the edge cascades, not the other node
  });
});

describe('knowledge: edge status (auto-relate review workflow)', () => {
  it('addEdge defaults to status=approved; an explicit draft status round-trips', () => {
    const a = upsertNode(db, { title: 'Status A', scope: 'global' });
    const b = upsertNode(db, { title: 'Status B', scope: 'global' });

    const approved = addEdge(db, { src: a.id, dst: b.id, relation: 'uses' });
    expect(approved?.status).toBe('approved');

    const draft = addEdge(db, { src: a.id, dst: b.id, relation: 'related', status: 'draft' });
    expect(draft?.status).toBe('draft');
  });

  it('listDraftEdges returns only drafts, joined with both endpoint titles', () => {
    const a = upsertNode(db, { title: 'Draft src', scope: 'global' });
    const b = upsertNode(db, { title: 'Draft dst', scope: 'global' });
    addEdge(db, { src: a.id, dst: b.id, relation: 'uses' }); // approved -- excluded
    const draft = addEdge(db, { src: a.id, dst: b.id, relation: 'related', status: 'draft' })!;

    const drafts = listDraftEdges(db);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: draft.id, src_title: 'Draft src', dst_title: 'Draft dst' });
  });

  it('setEdgeStatus approves/rejects a draft without deleting the row', () => {
    const a = upsertNode(db, { title: 'Review A', scope: 'global' });
    const b = upsertNode(db, { title: 'Review B', scope: 'global' });
    const draft = addEdge(db, { src: a.id, dst: b.id, relation: 'related', status: 'draft' })!;

    setEdgeStatus(db, draft.id, 'approved');
    expect(getEdge(db, draft.id)?.status).toBe('approved');

    setEdgeStatus(db, draft.id, 'rejected');
    expect(getEdge(db, draft.id)?.status).toBe('rejected');
  });

  it('edgesFor({status}) filters by status; graph() only ever returns approved edges', () => {
    const a = upsertNode(db, { title: 'Graph status A', scope: 'global' });
    const b = upsertNode(db, { title: 'Graph status B', scope: 'global' });
    addEdge(db, { src: a.id, dst: b.id, relation: 'uses' });
    addEdge(db, { src: a.id, dst: b.id, relation: 'related', status: 'draft' });

    expect(edgesFor(db, [a.id, b.id])).toHaveLength(2); // no status filter -- both
    expect(edgesFor(db, [a.id, b.id], { status: 'approved' })).toHaveLength(1);
    expect(edgesFor(db, [a.id, b.id], { status: 'draft' })).toHaveLength(1);

    const g = graph(db);
    const edgesBetween = g.edges.filter((e) => e.src === a.id && e.dst === b.id);
    expect(edgesBetween).toHaveLength(1);
    expect(edgesBetween[0].relation).toBe('uses');
  });
});

describe('knowledge: upsertNode dedup by (title, scope)', () => {
  it('updates the existing row for the same (title, scope); a different scope creates a new one', () => {
    const first = upsertNode(db, { title: 'Repo rule', body: 'v1', scope: 'global', weight: 2 });
    const second = upsertNode(db, { title: 'Repo rule', body: 'v2', scope: 'global', weight: 5 });
    expect(second.id).toBe(first.id);
    expect(second.body).toBe('v2');
    expect(second.weight).toBe(5);
    expect(listNodes(db, { scope: 'global' }).filter((n) => n.title === 'Repo rule')).toHaveLength(1);

    const other = upsertNode(db, { title: 'Repo rule', body: 'v3', scope: 'repo:/tmp/some-repo' });
    expect(other.id).not.toBe(first.id);
  });
});

describe('knowledge: invalidateNode (bi-temporal supersede)', () => {
  it('is excluded from default list/search but still reachable with includeInvalid', () => {
    const node = upsertNode(db, { title: 'Old fact', body: 'stale info marker', scope: 'global' });
    invalidateNode(db, node.id);

    expect(listNodes(db).find((n) => n.id === node.id)).toBeUndefined();
    expect(listNodes(db, { includeInvalid: true }).find((n) => n.id === node.id)).toBeDefined();

    expect(searchNodes(db, 'marker').length).toBe(0);
    expect(searchNodes(db, 'marker', { includeInvalid: true }).length).toBe(1);

    // row itself is never deleted
    expect(getNode(db, node.id)).toBeDefined();
  });
});

describe('knowledge: tasks.environment + migrate idempotency', () => {
  it('round-trips environment through createTask', () => {
    const task = createTask(db, { title: 'env task', goal: 'do it', environment: 'prod-cluster' });
    expect(getTask(db, task.id)!.environment).toBe('prod-cluster');

    const noEnv = createTask(db, { title: 'no env task', goal: 'do it' });
    expect(getTask(db, noEnv.id)!.environment).toBeNull();
  });

  it('re-applying schema.sql to an already-migrated db is a no-op', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
    expect(() => db.exec(schema)).not.toThrow();

    // FTS + triggers still wired correctly after re-exec
    upsertNode(db, { title: 'post-remigrate', body: 'still works fine', scope: 'global' });
    expect(searchNodes(db, 'still works fine').length).toBe(1);
  });

  it('opening a second hermetic test db (openTestDb twice) is unaffected', () => {
    const db2 = openTestDb();
    try {
      expect(() => createTask(db2, { title: 't2', goal: 'g', environment: 'e2' })).not.toThrow();
    } finally {
      db2.close();
    }
  });
});

// ---- SSoT Phase 3: graph() kind/scope filter, multi-hop BFS, documents ----

function ensureSource(id = 'src_test'): void {
  db.prepare(`INSERT OR IGNORE INTO sources (id, kind, uri) VALUES (?, 'vault', '/tmp/vault')`).run(id);
}
function insertDoc(p: string, sourceId = 'src_test'): number {
  ensureSource(sourceId);
  const info = db
    .prepare(`INSERT INTO documents (source_id, path, title, doc_kind) VALUES (?, ?, ?, 'md')`)
    .run(sourceId, p, p);
  return Number(info.lastInsertRowid);
}
function insertDocLink(
  documentId: number,
  targetTitle: string,
  opts: { targetDocumentId?: number; targetNodeId?: string } = {},
): void {
  db.prepare(
    `INSERT INTO doc_links (document_id, target_title, target_document_id, target_node_id) VALUES (?, ?, ?, ?)`,
  ).run(documentId, targetTitle, opts.targetDocumentId ?? null, opts.targetNodeId ?? null);
}

describe('knowledge: graph() kind/scope filter', () => {
  it('kind filters the returned nodes, and drops an edge whose other endpoint is filtered out', () => {
    const tech = upsertNode(db, { title: 'Tech node', kind: 'tech', scope: 'global' });
    const fact = upsertNode(db, { title: 'Fact node', kind: 'fact', scope: 'global' });
    addEdge(db, { src: tech.id, dst: fact.id, relation: 'uses' });

    const g = graph(db, { kind: 'tech' });
    expect(g.nodes.map((n) => n.id)).toEqual([tech.id]);
    expect(g.edges).toHaveLength(0); // fact endpoint isn't in the filtered node set
  });

  it('scope filters the returned nodes', () => {
    upsertNode(db, { title: 'Global node', scope: 'global' });
    const repoNode = upsertNode(db, { title: 'Repo node', scope: 'repo:/tmp/x' });

    const g = graph(db, { scope: 'repo:/tmp/x' });
    expect(g.nodes.map((n) => n.id)).toEqual([repoNode.id]);
  });
});

describe('knowledge: graph() multi-hop (nodeId + depth)', () => {
  it('depth=1 returns only the immediate neighbor, depth=2 reaches the second hop', () => {
    const a = upsertNode(db, { title: 'A', scope: 'global' });
    const b = upsertNode(db, { title: 'B', scope: 'global' });
    const c = upsertNode(db, { title: 'C', scope: 'global' });
    addEdge(db, { src: a.id, dst: b.id, relation: 'related' });
    addEdge(db, { src: b.id, dst: c.id, relation: 'related' });

    const depth1 = graph(db, { nodeId: a.id, depth: 1 });
    expect(depth1.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());

    const depth2 = graph(db, { nodeId: a.id, depth: 2 });
    expect(depth2.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('treats edges as undirected for traversal (can expand against the edge direction)', () => {
    const a = upsertNode(db, { title: 'A2', scope: 'global' });
    const b = upsertNode(db, { title: 'B2', scope: 'global' });
    addEdge(db, { src: b.id, dst: a.id, relation: 'related' }); // edge points b -> a
    const g = graph(db, { nodeId: a.id, depth: 1 });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('an unknown nodeId degrades to an empty result (no throw)', () => {
    const g = graph(db, { nodeId: 'k_doesnotexist', depth: 2 });
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.documents).toEqual([]);
  });

  it('a node with no relations returns itself alone with zero edges', () => {
    const lonely = upsertNode(db, { title: 'Lonely', scope: 'global' });
    const g = graph(db, { nodeId: lonely.id, depth: 2 });
    expect(g.nodes.map((n) => n.id)).toEqual([lonely.id]);
    expect(g.edges).toEqual([]);
  });
});

describe('knowledge: graph() documents (SSoT Phase 3 wikilink-derived)', () => {
  it('only includes markdown documents that participate in a resolved link (unlinked documents are omitted)', () => {
    insertDoc('Unlinked.md'); // no doc_links row at all -- not graph-worthy
    const g = graph(db);
    expect(g.documents).toEqual([]);
  });

  it('includes a document->node link, with the target node title carried as target_title', () => {
    const node = upsertNode(db, { title: 'Target Node', scope: 'global' });
    const docId = insertDoc('Notes.md');
    insertDocLink(docId, 'Target Node', { targetNodeId: node.id });

    const g = graph(db);
    expect(g.documents).toHaveLength(1);
    expect(g.documents[0]!.path).toBe('Notes.md');
    expect(g.documents[0]!.links).toEqual([{ target_title: 'Target Node', target_kind: 'node', target_id: node.id }]);
  });

  it('includes a document->document link and surfaces the target document even if it has no outbound links itself', () => {
    const srcDoc = insertDoc('Source.md');
    const targetDoc = insertDoc('Target.md');
    insertDocLink(srcDoc, 'Target', { targetDocumentId: targetDoc });

    const g = graph(db);
    const ids = g.documents.map((d) => d.id).sort((x, y) => x - y);
    expect(ids).toEqual([srcDoc, targetDoc].sort((x, y) => x - y));
    const target = g.documents.find((d) => d.id === targetDoc)!;
    expect(target.links).toEqual([]);
  });

  it('omits an unresolved link (both targets null) from the output', () => {
    const docId = insertDoc('Notes2.md');
    insertDocLink(docId, 'Nowhere');
    const g = graph(db);
    expect(g.documents).toEqual([]);
  });

  it('multi-hop BFS reaches a document through a node, and prunes documents outside the requested depth', () => {
    const node = upsertNode(db, { title: 'Bridge Node', scope: 'global' });
    const docId = insertDoc('Linked.md');
    insertDocLink(docId, 'Bridge Node', { targetNodeId: node.id });

    const near = graph(db, { nodeId: node.id, depth: 1 });
    expect(near.documents.map((d) => d.id)).toEqual([docId]);

    const other = upsertNode(db, { title: 'Far Node', scope: 'global' });
    const far = graph(db, { nodeId: other.id, depth: 1 });
    expect(far.documents).toEqual([]);
  });
});
