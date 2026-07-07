import { describe, it, expect } from 'vitest';
import {
  buildGraphState,
  mergeGraphState,
  stepForce,
  matchesFilter,
  screenToWorld,
  worldToScreen,
  hitTestVertex,
  vertexRadius,
  docVertexId,
} from '../../web/graph-layout.js';

function sampleGraph() {
  return {
    nodes: [
      { id: 'k_a', title: 'Node A', kind: 'tech', scope: 'global', source: 'manual', tags: '["infra"]' },
      { id: 'k_b', title: 'Node B', kind: 'fact', scope: 'global', source: 'manual', tags: '[]' },
    ],
    edges: [{ id: 1, src: 'k_a', dst: 'k_b', relation: 'uses', note: null, invalid_at: null, created_at: '' }],
    documents: [
      {
        id: 7,
        title: 'LoopEngineering',
        path: 'LoopEngineering.md',
        uri: '/vault/LoopEngineering.md',
        doc_kind: 'md',
        source_id: 'src_1',
        links: [{ target_title: 'Node A', target_kind: 'node', target_id: 'k_a' }],
      },
    ],
  };
}

describe('graph-layout: buildGraphState', () => {
  it('creates a vertex per node and per document, namespacing document ids as doc_<id>', () => {
    const state = buildGraphState(sampleGraph());
    expect(state.vertices.has('k_a')).toBe(true);
    expect(state.vertices.has('k_b')).toBe(true);
    expect(state.vertices.has('doc_7')).toBe(true);
    expect(state.vertices.get('k_a')!.type).toBe('node');
    expect(state.vertices.get('doc_7')!.type).toBe('document');
  });

  it('includes the curated edge and a synthesized document->node edge from the document link', () => {
    const state = buildGraphState(sampleGraph());
    expect(state.edges).toContainEqual({ src: 'k_a', dst: 'k_b', relation: 'uses' });
    expect(state.edges).toContainEqual({ src: 'doc_7', dst: 'k_a', relation: 'links-to' });
  });

  it('drops an edge whose endpoint is not present as a vertex (e.g. filtered-out node)', () => {
    const g = sampleGraph();
    g.edges.push({ id: 2, src: 'k_a', dst: 'k_missing', relation: 'related', note: null, invalid_at: null, created_at: '' });
    const state = buildGraphState(g);
    expect(state.edges.some((e) => e.dst === 'k_missing')).toBe(false);
  });

  it('is deterministic: building the same response twice yields identical initial positions', () => {
    const s1 = buildGraphState(sampleGraph());
    const s2 = buildGraphState(sampleGraph());
    expect(s1.vertices.get('k_a')!.x).toBe(s2.vertices.get('k_a')!.x);
    expect(s1.vertices.get('k_a')!.y).toBe(s2.vertices.get('k_a')!.y);
  });

  it('docVertexId namespaces a raw document id', () => {
    expect(docVertexId(7)).toBe('doc_7');
  });
});

describe('graph-layout: mergeGraphState (expand-on-click)', () => {
  it('adds a brand-new vertex/edge from the second response without disturbing existing vertex positions', () => {
    const state = buildGraphState(sampleGraph());
    const a = state.vertices.get('k_a')!;
    a.x = 123.456;
    a.y = -9.5;
    a.vx = 1;
    a.vy = 2;

    const expansion = {
      nodes: [
        { id: 'k_a', title: 'Node A', kind: 'tech', scope: 'global', source: 'manual', tags: '["infra"]' },
        { id: 'k_c', title: 'Node C', kind: 'fact', scope: 'global', source: 'manual', tags: '[]' },
      ],
      edges: [{ id: 3, src: 'k_a', dst: 'k_c', relation: 'related', note: null, invalid_at: null, created_at: '' }],
      documents: [],
    };
    mergeGraphState(state, expansion, 'k_a');

    // existing vertex untouched
    expect(state.vertices.get('k_a')!.x).toBe(123.456);
    expect(state.vertices.get('k_a')!.y).toBe(-9.5);
    // new vertex added, seeded near the anchor (not at some unrelated default origin)
    expect(state.vertices.has('k_c')).toBe(true);
    const c = state.vertices.get('k_c')!;
    expect(Math.abs(c.x - a.x)).toBeLessThan(60);
    expect(Math.abs(c.y - a.y)).toBeLessThan(60);
    // new edge added
    expect(state.edges).toContainEqual({ src: 'k_a', dst: 'k_c', relation: 'related' });
  });

  it('re-merging the same response is idempotent (no duplicate edges)', () => {
    const state = buildGraphState(sampleGraph());
    const before = state.edges.length;
    mergeGraphState(state, sampleGraph(), 'k_a');
    expect(state.edges.length).toBe(before);
    expect(state.vertices.size).toBe(3);
  });
});

describe('graph-layout: stepForce (physics)', () => {
  it('two vertices with no edge repel apart from a shared starting point', () => {
    const state = {
      vertices: new Map([
        ['a', { id: 'a', x: 0, y: 0, vx: 0, vy: 0, fixed: false, type: 'node' }],
        ['b', { id: 'b', x: 0.01, y: 0, vx: 0, vy: 0, fixed: false, type: 'node' }],
      ]),
      edges: [],
    };
    stepForce(state);
    const a = state.vertices.get('a')!;
    const b = state.vertices.get('b')!;
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(0.01);
  });

  it('two vertices joined by an edge, placed far apart, are pulled closer together', () => {
    const state = {
      vertices: new Map([
        ['a', { id: 'a', x: -500, y: 0, vx: 0, vy: 0, fixed: false, type: 'node' }],
        ['b', { id: 'b', x: 500, y: 0, vx: 0, vy: 0, fixed: false, type: 'node' }],
      ]),
      edges: [{ src: 'a', dst: 'b', relation: 'related' }],
    };
    const distBefore = 1000;
    for (let i = 0; i < 50; i++) stepForce(state);
    const a = state.vertices.get('a')!;
    const b = state.vertices.get('b')!;
    const distAfter = Math.abs(b.x - a.x);
    expect(distAfter).toBeLessThan(distBefore);
  });

  it('a fixed (mid-drag) vertex does not move even when forces act on it', () => {
    const state = {
      vertices: new Map([
        ['a', { id: 'a', x: 0, y: 0, vx: 0, vy: 0, fixed: true, type: 'node' }],
        ['b', { id: 'b', x: 5, y: 0, vx: 0, vy: 0, fixed: false, type: 'node' }],
      ]),
      edges: [{ src: 'a', dst: 'b', relation: 'related' }],
    };
    stepForce(state);
    expect(state.vertices.get('a')!.x).toBe(0);
    expect(state.vertices.get('a')!.y).toBe(0);
  });
});

describe('graph-layout: matchesFilter', () => {
  const nodeVertex = { type: 'node', kind: 'tech', raw: { scope: 'repo:/home/x', source: 'manual', tags: '["gpu","infra"]' } };
  const docVertex = { type: 'document', raw: { source_id: 'src_1' } };

  it('empty filters pass everything', () => {
    expect(matchesFilter(nodeVertex, {})).toBe(true);
    expect(matchesFilter(docVertex, {})).toBe(true);
  });

  it('kind filter only affects node vertices', () => {
    expect(matchesFilter(nodeVertex, { kind: new Set(['fact']) })).toBe(false);
    expect(matchesFilter(nodeVertex, { kind: new Set(['tech']) })).toBe(true);
    expect(matchesFilter(docVertex, { kind: new Set(['tech']) })).toBe(true); // docs have no kind
  });

  it('tag filter matches a substring within the JSON tags array', () => {
    expect(matchesFilter(nodeVertex, { tag: 'gpu' })).toBe(true);
    expect(matchesFilter(nodeVertex, { tag: 'nonexistent' })).toBe(false);
  });

  it('scope filter is a case-insensitive substring match', () => {
    expect(matchesFilter(nodeVertex, { scope: '/HOME/x' })).toBe(true);
    expect(matchesFilter(nodeVertex, { scope: 'env:company' })).toBe(false);
  });

  it('source filter applies to both node.source and document.source_id', () => {
    expect(matchesFilter(nodeVertex, { source: new Set(['manual']) })).toBe(true);
    expect(matchesFilter(nodeVertex, { source: new Set(['mcp']) })).toBe(false);
    expect(matchesFilter(docVertex, { source: new Set(['src_1']) })).toBe(true);
    expect(matchesFilter(docVertex, { source: new Set(['src_2']) })).toBe(false);
  });

  it('showDocuments=false hides only document-type vertices', () => {
    expect(matchesFilter(docVertex, { showDocuments: false })).toBe(false);
    expect(matchesFilter(nodeVertex, { showDocuments: false })).toBe(true);
  });
});

describe('graph-layout: coordinate transforms + hit-testing', () => {
  it('screenToWorld / worldToScreen round-trip', () => {
    const view = { offsetX: 20, offsetY: -10, scale: 1.5 };
    const world = screenToWorld(view, 300, 200, 600, 400);
    const back = worldToScreen(view, world.x, world.y, 600, 400);
    expect(back.x).toBeCloseTo(300, 6);
    expect(back.y).toBeCloseTo(200, 6);
  });

  it('hitTestVertex finds the nearest vertex within radius, and null outside it', () => {
    const vertices = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 100 },
    ];
    expect(hitTestVertex(vertices, 1, 1, 10)?.id).toBe('a');
    expect(hitTestVertex(vertices, 1000, 1000, 10)).toBeNull();
  });

  it('vertexRadius gives documents a smaller radius than curated nodes', () => {
    expect(vertexRadius({ type: 'document' })).toBeLessThan(vertexRadius({ type: 'node' }));
  });
});
