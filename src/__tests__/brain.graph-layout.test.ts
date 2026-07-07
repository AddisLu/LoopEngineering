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
  computeDegrees,
  categoryCentroids,
  stepForceClustered,
  reheat,
  decayAlpha,
  shouldStep,
  shouldShowLabel,
  categoryTree,
  categoryFocusVertices,
  LOD,
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

  it('GRAPH G1: carries category onto the vertex when present (view=brain), null otherwise (default view)', () => {
    const g = sampleGraph();
    (g.nodes[0] as any).category = { top: '策展', sub: 'tech' };
    (g.documents[0] as any).category = { top: '筆記', sub: 'notes' };
    const state = buildGraphState(g);
    expect(state.vertices.get('k_a')!.category).toEqual({ top: '策展', sub: 'tech' });
    expect(state.vertices.get('doc_7')!.category).toEqual({ top: '筆記', sub: 'notes' });
    expect(state.vertices.get('k_b')!.category).toBeNull(); // default view: no category on the response
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

  it('GRAPH G4: category filter matches top (and optionally sub), regardless of vertex type', () => {
    const catNode = { type: 'node', kind: 'tech', category: { top: '程式碼', sub: 'repoA' }, raw: {} };
    const catDoc = { type: 'document', category: { top: '筆記', sub: 'notes' }, raw: {} };
    expect(matchesFilter(catNode, { category: { top: '程式碼' } })).toBe(true);
    expect(matchesFilter(catNode, { category: { top: '筆記' } })).toBe(false);
    expect(matchesFilter(catNode, { category: { top: '程式碼', sub: 'repoA' } })).toBe(true);
    expect(matchesFilter(catNode, { category: { top: '程式碼', sub: 'repoB' } })).toBe(false);
    expect(matchesFilter(catDoc, { category: { top: '筆記' } })).toBe(true);
    expect(matchesFilter(nodeVertex, { category: { top: '程式碼' } })).toBe(false); // no category on this vertex
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

  it('GRAPH G3: vertexRadius grows with degree (sqrt map) but stays capped', () => {
    const bare = vertexRadius({ type: 'node' });
    const hub = vertexRadius({ type: 'node', degree: 40 });
    expect(hub).toBeGreaterThan(bare);
    expect(hub).toBeLessThanOrEqual(26);
  });
});

describe('graph-layout: computeDegrees (GRAPH G3)', () => {
  it('counts in+out edges per vertex, zero for unconnected vertices', () => {
    const state = buildGraphState(sampleGraph());
    const degrees = computeDegrees(state);
    // k_a: edge to k_b + inbound links-to from doc_7 = 2
    expect(degrees.get('k_a')).toBe(2);
    expect(degrees.get('k_b')).toBe(1);
    expect(degrees.get('doc_7')).toBe(1);
  });

  it('also stamps the count onto each vertex.degree', () => {
    const state = buildGraphState(sampleGraph());
    computeDegrees(state);
    expect(state.vertices.get('k_a')!.degree).toBe(2);
  });

  it('a vertex with no edges gets degree 0, not undefined', () => {
    const g = sampleGraph();
    g.nodes.push({ id: 'k_isolated', title: 'Lonely', kind: 'fact', scope: 'global', source: 'manual', tags: '[]' });
    const state = buildGraphState(g);
    const degrees = computeDegrees(state);
    expect(degrees.get('k_isolated')).toBe(0);
  });
});

describe('graph-layout: categoryCentroids + stepForceClustered (GRAPH G3)', () => {
  function clusteredState() {
    return {
      vertices: new Map([
        ['a1', { id: 'a1', x: -500, y: 0, vx: 0, vy: 0, fixed: false, type: 'node', category: { top: 'X', sub: '1' } }],
        ['a2', { id: 'a2', x: 500, y: 0, vx: 0, vy: 0, fixed: false, type: 'node', category: { top: 'X', sub: '2' } }],
        ['b1', { id: 'b1', x: 0, y: -500, vx: 0, vy: 0, fixed: false, type: 'node', category: { top: 'Y', sub: '1' } }],
      ]),
      edges: [],
    };
  }

  it('categoryCentroids averages positions of same-top-category vertices, ignoring uncategorized ones', () => {
    const state = clusteredState();
    state.vertices.set('none', { id: 'none', x: 999, y: 999, vx: 0, vy: 0, fixed: false, type: 'node', category: null });
    const centroids = categoryCentroids(state);
    expect(centroids.get('X')).toEqual({ x: 0, y: 0 });
    expect(centroids.get('Y')).toEqual({ x: 0, y: -500 });
    expect(centroids.has(undefined as any)).toBe(false);
  });

  it('pulls same-category vertices closer together over repeated steps', () => {
    const state = clusteredState();
    const distBefore = Math.hypot(
      state.vertices.get('a1')!.x - state.vertices.get('a2')!.x,
      state.vertices.get('a1')!.y - state.vertices.get('a2')!.y,
    );
    for (let i = 0; i < 30; i++) stepForceClustered(state);
    const distAfter = Math.hypot(
      state.vertices.get('a1')!.x - state.vertices.get('a2')!.x,
      state.vertices.get('a1')!.y - state.vertices.get('a2')!.y,
    );
    expect(distAfter).toBeLessThan(distBefore);
  });

  it('a fixed vertex is not moved by the cluster pull', () => {
    const state = clusteredState();
    state.vertices.get('a1')!.fixed = true;
    stepForceClustered(state);
    expect(state.vertices.get('a1')!.x).toBe(-500);
    expect(state.vertices.get('a1')!.y).toBe(0);
  });
});

describe('graph-layout: categoryTree + categoryFocusVertices (GRAPH G4)', () => {
  function treeState() {
    return {
      vertices: new Map([
        ['a1', { id: 'a1', type: 'node', category: { top: 'X', sub: '1' } }],
        ['a2', { id: 'a2', type: 'node', category: { top: 'X', sub: '2' } }],
        ['a3', { id: 'a3', type: 'node', category: { top: 'X', sub: '1' } }],
        ['b1', { id: 'b1', type: 'node', category: { top: 'Y', sub: '1' } }],
        ['n1', { id: 'n1', type: 'node', category: null }],
      ]),
      edges: [
        { src: 'a1', dst: 'b1', relation: 'related' }, // cross-category edge -- b1 should fade in when focused on X
        { src: 'a1', dst: 'a2', relation: 'related' },
      ],
    };
  }

  it('categoryTree counts vertices per top category and per sub-category, ignoring uncategorized vertices', () => {
    const tree = categoryTree(treeState());
    expect(tree.get('X')!.count).toBe(3);
    expect(tree.get('X')!.subs.get('1')).toBe(2);
    expect(tree.get('X')!.subs.get('2')).toBe(1);
    expect(tree.get('Y')!.count).toBe(1);
    expect(tree.has(undefined as any)).toBe(false);
  });

  it('categoryFocusVertices with no category returns null (the "全部" reset)', () => {
    expect(categoryFocusVertices(treeState(), null)).toBeNull();
    expect(categoryFocusVertices(treeState(), { top: null })).toBeNull();
  });

  it('categoryFocusVertices: focused is the exact top match; visible additionally includes direct neighbors outside it', () => {
    const focus = categoryFocusVertices(treeState(), { top: 'X' })!;
    expect(focus.focused).toEqual(new Set(['a1', 'a2', 'a3']));
    // b1 is not category X, but is a direct neighbor of a1 -- included in visible (faded in), not focused
    expect(focus.visible.has('b1')).toBe(true);
    expect(focus.focused.has('b1')).toBe(false);
    expect(focus.visible.has('n1')).toBe(false); // unrelated, uncategorized vertex stays hidden
  });

  it('categoryFocusVertices narrows to a sub-category when given', () => {
    const focus = categoryFocusVertices(treeState(), { top: 'X', sub: '1' })!;
    expect(focus.focused).toEqual(new Set(['a1', 'a3']));
    expect(focus.focused.has('a2')).toBe(false);
  });
});

describe('graph-layout: alpha cooldown (GRAPH G3)', () => {
  it('decayAlpha treats a fresh (uninitialized) sim as full energy and decays it', () => {
    const state = { vertices: new Map(), edges: [] };
    const a1 = decayAlpha(state);
    expect(a1).toBeCloseTo(0.985, 5);
    const a2 = decayAlpha(state);
    expect(a2).toBeLessThan(a1);
  });

  it('shouldStep is true while alpha is above alphaMin and false once it decays past it', () => {
    const state = { vertices: new Map(), edges: [], alpha: 1 };
    expect(shouldStep(state)).toBe(true);
    for (let i = 0; i < 500; i++) decayAlpha(state);
    expect(shouldStep(state)).toBe(false);
  });

  it('reheat resets alpha back to full energy', () => {
    const state = { vertices: new Map(), edges: [], alpha: 0.001 };
    reheat(state);
    expect(state.alpha).toBe(1);
    expect(shouldStep(state)).toBe(true);
  });
});

describe('graph-layout: shouldShowLabel LoD gate (GRAPH G3)', () => {
  it('always shows the hovered or focused vertex\'s label regardless of zoom/degree', () => {
    const v = { id: 'a', degree: 0 };
    expect(shouldShowLabel(v, { scale: 0.1, hoveredId: 'a' })).toBe(true);
    expect(shouldShowLabel(v, { scale: 0.1, focusId: 'a' })).toBe(true);
  });

  it('always shows a structural hub (degree >= LOD.hubDegree) even zoomed far out', () => {
    const hub = { id: 'h', degree: LOD.hubDegree };
    expect(shouldShowLabel(hub, { scale: 0.1 })).toBe(true);
  });

  it('hides a low-degree, non-hovered vertex until zoomed in past LOD.labelScale', () => {
    const v = { id: 'a', degree: 1 };
    expect(shouldShowLabel(v, { scale: 1 })).toBe(false);
    expect(shouldShowLabel(v, { scale: LOD.labelScale })).toBe(true);
  });
});
