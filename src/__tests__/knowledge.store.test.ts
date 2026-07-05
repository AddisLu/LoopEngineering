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
  edgesFor,
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
