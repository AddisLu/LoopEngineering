import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { upsertNode, invalidateNode, setStatusNode, addEdge } from '../knowledge/store.js';
import { parseWikilinks, resyncNodeWikilinks } from '../knowledge/wikilink.js';

describe('wikilink: parseWikilinks', () => {
  it('extracts plain [[title]] links, dedup’d', () => {
    expect(parseWikilinks('see [[Loop Engineering]] and again [[Loop Engineering]]')).toEqual(['Loop Engineering']);
  });

  it('strips a #heading anchor and a |alias display text', () => {
    expect(parseWikilinks('[[Loop Engineering#Architecture]]')).toEqual(['Loop Engineering']);
    expect(parseWikilinks('[[Loop Engineering|LE]]')).toEqual(['Loop Engineering']);
    expect(parseWikilinks('[[Loop Engineering#Architecture|LE arch]]')).toEqual(['Loop Engineering']);
  });

  it('returns [] for text with no wikilinks, and ignores an empty [[]]', () => {
    expect(parseWikilinks('plain text, no links here')).toEqual([]);
    expect(parseWikilinks('[[]]')).toEqual([]);
  });

  it('finds multiple distinct links in one body', () => {
    expect(parseWikilinks('[[A]] connects to [[B]] and [[C]]').sort()).toEqual(['A', 'B', 'C']);
  });
});

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

function linksToEdges(srcId: string) {
  return db
    .prepare(`SELECT * FROM knowledge_edges WHERE src = ? AND relation = 'links-to'`)
    .all(srcId) as { id: number; src: string; dst: string; relation: string }[];
}

describe('wikilink: resyncNodeWikilinks via upsertNode', () => {
  it('creates a links-to edge when a node body wikilinks an existing node title', () => {
    const target = upsertNode(db, { title: 'Loop Engineering', scope: 'global' });
    const source = upsertNode(db, { title: 'Note A', body: 'see [[Loop Engineering]] for details', scope: 'global' });

    const edges = linksToEdges(source.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.dst).toBe(target.id);
  });

  it('is case-insensitive when resolving the wikilink title', () => {
    const target = upsertNode(db, { title: 'Loop Engineering', scope: 'global' });
    const source = upsertNode(db, { title: 'Note B', body: 'see [[loop engineering]]', scope: 'global' });
    expect(linksToEdges(source.id).map((e) => e.dst)).toEqual([target.id]);
  });

  it('a forward reference resolves once the target node is created afterward', () => {
    const source = upsertNode(db, { title: 'Note C', body: 'will link to [[Future Node]]', scope: 'global' });
    expect(linksToEdges(source.id)).toHaveLength(0); // target doesn't exist yet

    const target = upsertNode(db, { title: 'Future Node', scope: 'global' });
    expect(linksToEdges(source.id).map((e) => e.dst)).toEqual([target.id]);
  });

  it('editing a node body to drop a wikilink removes the stale links-to edge', () => {
    const target = upsertNode(db, { title: 'Target', scope: 'global' });
    const source = upsertNode(db, { title: 'Note D', body: '[[Target]]', scope: 'global' });
    expect(linksToEdges(source.id)).toHaveLength(1);

    upsertNode(db, { title: 'Note D', body: 'no more links here', scope: 'global' });
    expect(linksToEdges(source.id)).toHaveLength(0);
    // the target node itself is untouched
    expect(db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(target.id)).toBeDefined();
  });

  it('does not disturb a manually-added edge of a different relation between the same pair', () => {
    const target = upsertNode(db, { title: 'Target2', scope: 'global' });
    const source = upsertNode(db, { title: 'Note E', body: '[[Target2]]', scope: 'global' });
    addEdge(db, { src: source.id, dst: target.id, relation: 'uses' });

    upsertNode(db, { title: 'Note E', body: 'no link anymore', scope: 'global' });
    expect(linksToEdges(source.id)).toHaveLength(0);
    const usesEdges = db.prepare(`SELECT * FROM knowledge_edges WHERE src = ? AND relation = 'uses'`).all(source.id);
    expect(usesEdges).toHaveLength(1); // manual edge survives the wikilink resync
  });

  it('a node cannot wikilink itself into a self-edge', () => {
    const node = upsertNode(db, { title: 'Self Ref', body: 'talks about [[Self Ref]]', scope: 'global' });
    expect(linksToEdges(node.id)).toHaveLength(0);
  });

  it('invalidating the target node drops the links-to edge pointing at it', () => {
    const target = upsertNode(db, { title: 'Will Invalidate', scope: 'global' });
    const source = upsertNode(db, { title: 'Note F', body: '[[Will Invalidate]]', scope: 'global' });
    expect(linksToEdges(source.id)).toHaveLength(1);

    invalidateNode(db, target.id);
    expect(linksToEdges(source.id)).toHaveLength(0);
  });

  it('rejecting the target node drops the links-to edge pointing at it', () => {
    const target = upsertNode(db, { title: 'Will Reject', scope: 'global', status: 'draft' });
    const source = upsertNode(db, { title: 'Note G', body: '[[Will Reject]]', scope: 'global' });
    expect(linksToEdges(source.id)).toHaveLength(1);

    setStatusNode(db, target.id, 'rejected');
    expect(linksToEdges(source.id)).toHaveLength(0);
  });

  it('resyncNodeWikilinks is directly callable and idempotent', () => {
    const target = upsertNode(db, { title: 'Idem Target', scope: 'global' });
    const source = upsertNode(db, { title: 'Idem Source', body: '[[Idem Target]]', scope: 'global' });
    resyncNodeWikilinks(db);
    resyncNodeWikilinks(db);
    expect(linksToEdges(source.id).map((e) => e.dst)).toEqual([target.id]);
  });
});
