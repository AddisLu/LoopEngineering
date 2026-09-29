// Flow layout for the 總覽 / 工作流程 canvases — pure (no DOM), so vitest can import it.
//
// A group is laid out left to right in layers: a node's layer is the longest path to it from a
// node with no incoming edge ('back' and 'attach' edges do not count — a gate's "send it back"
// edge and a cluster's sub-nodes are drawn, never ranked). Inside a layer, nodes follow the mean
// position of what feeds them (barycenter), which keeps a fan-out and its fan-in aligned. Groups
// stack top to bottom. Every result is in px, relative to the canvas origin.

const RANKED = (e) => e.kind !== 'back' && e.kind !== 'attach';

/** Layer index per node id: longest path from a source over the ranked edges (cycles broken). */
export function rankNodes(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const preds = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!RANKED(e) || !known.has(e.from) || !known.has(e.to) || e.from === e.to) continue;
    preds.get(e.to).push(e.from);
  }
  const rank = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (rank.has(id)) return rank.get(id);
    if (visiting.has(id)) return 0; // a cycle: treat the edge that closes it as not there
    visiting.add(id);
    let r = 0;
    for (const p of preds.get(id)) r = Math.max(r, visit(p) + 1);
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const n of nodes) {
    // an explicit rank wins (the stage canvas pins its stages to columns)
    if (Number.isFinite(n.rank)) rank.set(n.id, n.rank);
  }
  for (const id of ids) visit(id);
  return rank;
}

/**
 * Nodes laid out in layers, left to right.
 * nodes: [{ id, w, h, rank?, lane? }] — `lane` pins a vertical slot inside the layer.
 * Returns { pos: Map(id → { x, y, w, h }), width, height }.
 */
export function layered(nodes, edges, opts = {}) {
  const gapX = opts.gapX ?? 64;
  const gapY = opts.gapY ?? 20;
  if (!nodes.length) return { pos: new Map(), width: 0, height: 0 };
  const rank = rankNodes(nodes, edges);
  const byRank = new Map();
  nodes.forEach((n, i) => {
    const r = rank.get(n.id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push({ ...n, _i: i });
  });
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const preds = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (RANKED(e) && preds.has(e.to) && preds.has(e.from)) preds.get(e.to).push(e.from);

  // order each layer by its feeders' mean slot; the first layer keeps input order
  const slot = new Map();
  for (const r of ranks) {
    const layer = byRank.get(r);
    const key = (n) => {
      if (Number.isFinite(n.lane)) return n.lane;
      const ps = preds.get(n.id).filter((p) => slot.has(p));
      return ps.length ? ps.reduce((s, p) => s + slot.get(p), 0) / ps.length : n._i;
    };
    layer.sort((a, b) => key(a) - key(b) || a._i - b._i);
    layer.forEach((n, i) => slot.set(n.id, i));
  }

  // columns: each as wide as its widest node; rows: each layer centred on the tallest layer
  const colW = ranks.map((r) => Math.max(...byRank.get(r).map((n) => n.w)));
  const colH = ranks.map((r) => byRank.get(r).reduce((s, n) => s + n.h, 0) + gapY * (byRank.get(r).length - 1));
  const height = Math.max(...colH);
  const pos = new Map();
  let x = 0;
  ranks.forEach((r, ci) => {
    const layer = byRank.get(r);
    let y = (height - colH[ci]) / 2;
    for (const n of layer) {
      pos.set(n.id, { x: Math.round(x + (colW[ci] - n.w) / 2), y: Math.round(y), w: n.w, h: n.h });
      y += n.h + gapY;
    }
    x += colW[ci] + gapX;
  });
  return { pos, width: Math.round(x - gapX), height: Math.round(height) };
}

/** Loose nodes in rows of `cols` (the 單一任務 group). */
export function grid(nodes, opts = {}) {
  const cols = Math.max(1, opts.cols ?? 4);
  const gapX = opts.gapX ?? 24;
  const gapY = opts.gapY ?? 20;
  const pos = new Map();
  if (!nodes.length) return { pos, width: 0, height: 0 };
  const w = Math.max(...nodes.map((n) => n.w));
  const hgt = Math.max(...nodes.map((n) => n.h));
  nodes.forEach((n, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    pos.set(n.id, { x: c * (w + gapX), y: r * (hgt + gapY), w: n.w, h: n.h });
  });
  const used = Math.min(cols, nodes.length);
  const rows = Math.ceil(nodes.length / cols);
  return { pos, width: used * w + (used - 1) * gapX, height: rows * hgt + (rows - 1) * gapY };
}

/**
 * Groups stacked top to bottom. groups: [{ id, layout: { pos, width, height }, minW? }].
 * Each group gets a band with room for its header; node positions come back absolute.
 * Returns { groups: [{ id, x, y, w, h }], pos: Map(id → { x, y, w, h }), width, height }.
 */
export function stackGroups(groups, opts = {}) {
  const pad = opts.pad ?? 24;
  const head = opts.head ?? 44;
  const gap = opts.gap ?? 16;
  const origin = opts.origin ?? 16;
  const pos = new Map();
  const out = [];
  let y = origin;
  const width = Math.max(0, ...groups.map((g) => Math.max(g.minW ?? 0, g.layout.width + pad * 2)));
  for (const g of groups) {
    const w = Math.max(g.minW ?? 0, g.layout.width + pad * 2);
    const hgt = head + g.layout.height + pad;
    out.push({ id: g.id, x: origin, y, w, h: hgt });
    for (const [id, p] of g.layout.pos) pos.set(id, { ...p, x: p.x + origin + pad, y: p.y + y + head });
    y += hgt + gap;
  }
  return { groups: out, pos, width: width + origin * 2, height: y - gap + origin };
}

/** Bounding box of placed items ({ x, y, w, h }). */
export function bounds(items) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of items) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * The zoom and offset that fit a box into a viewport with a margin, never zooming in past `max`.
 * Returns { k, x, y } for `translate(x, y) scale(k)`.
 */
export function fitTransform(box, viewW, viewH, opts = {}) {
  const margin = opts.margin ?? 32;
  const max = opts.max ?? 1;
  const min = opts.min ?? 0.25;
  if (!box.w || !box.h || !viewW || !viewH) return { k: 1, x: margin, y: margin };
  const k = Math.max(min, Math.min(max, (viewW - margin * 2) / box.w, (viewH - margin * 2) / box.h));
  return { k, x: Math.round((viewW - box.w * k) / 2 - box.x * k), y: Math.round((viewH - box.h * k) / 2 - box.y * k) };
}

/**
 * An edge's SVG path between two placed nodes. Forward edges leave the right side and enter the
 * left side on a smooth curve; a 'back' edge (the gate sending work back) runs above both nodes;
 * an 'attach' edge (a cluster's sub-node) drops from the bottom of the source.
 * `lift` is how far above the higher node a back edge runs.
 */
export function edgePath(a, b, kind, lift = 56) {
  if (kind === 'back') {
    const x1 = a.x + a.w / 2;
    const y1 = a.y;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const top = Math.min(y1, y2) - lift;
    const r = 12;
    const dir = x2 < x1 ? -1 : 1;
    return `M ${x1} ${y1} L ${x1} ${top + r} Q ${x1} ${top} ${x1 + dir * r} ${top} L ${x2 - dir * r} ${top} Q ${x2} ${top} ${x2} ${top + r} L ${x2} ${y2 - 2}`;
  }
  if (kind === 'attach') {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
  }
  if (kind === 'below') {
    // a side exit (無法判定) that runs under the row into the target's bottom
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y + b.h;
    const low = Math.max(y1, y2) + lift;
    const r = 12;
    const dir = x2 < x1 ? -1 : 1;
    return `M ${x1} ${y1} L ${x1} ${low - r} Q ${x1} ${low} ${x1 + dir * r} ${low} L ${x2 - dir * r} ${low} Q ${x2} ${low} ${x2} ${low - r} L ${x2} ${y2 + 2}`;
  }
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(28, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2 - 2} ${y2}`;
}

/** Where an edge's label sits: above the middle of a forward edge, on top of a back edge. */
export function edgeLabelAt(a, b, kind, lift = 56) {
  if (kind === 'back') return { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: Math.min(a.y, b.y) - lift - 22 };
  if (kind === 'below') return { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: Math.max(a.y + a.h, b.y + b.h) + lift + 6 };
  return { x: (a.x + a.w + b.x) / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 24 };
}
