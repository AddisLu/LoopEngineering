// The flow canvas: a pannable, zoomable layer of groups, nodes (real <button>s) and edges (one
// SVG). Pages hand it a scene of placed items every time their data changes; nodes are keyed by
// id and only rebuilt when their signature changes, so a live board updating every second keeps
// its focus, hover and zoom. textContent-only: pages build node content with DOM calls.

import { h, icon } from '../frame.js';
import { bounds, edgeLabelAt, edgePath, fitTransform } from './layout.js';

const NS = 'http://www.w3.org/2000/svg';
const ZMIN = 0.25;
const ZMAX = 2;

const BADGE_ICON = { ok: 'check', run: 'spin', verify: 'spin', warn: 'bang', fail: 'x', review: 'eye', queued: 'clock', retry: 'retry', pause: 'pause' };

/**
 * createCanvas(host, { onNodeClick(id, ev), onNodeHover(id|null, el), controls: true })
 * → { render(scene), fit(), zoomBy(f), focus(id), select(id), layer, transform }
 */
export function createCanvas(host, opts = {}) {
  host.classList.add('canvas');
  host.tabIndex = -1;
  const layer = h('div.canvas-layer');
  const groupsEl = h('div');
  const edges = document.createElementNS(NS, 'svg');
  edges.setAttribute('class', 'fedges');
  edges.setAttribute('aria-hidden', 'true');
  const nodesEl = h('div');
  const labelsEl = h('div');
  layer.append(groupsEl, edges, nodesEl, labelsEl);
  host.appendChild(layer);
  const emptyEl = h('div.canvas-empty', { hidden: true });
  host.appendChild(emptyEl);

  let t = { x: 24, y: 24, k: 1 };
  let fitted = false;
  let shape = ''; // the node ids last rendered
  let userMoved = false;
  let scene = { groups: [], nodes: [], edges: [] };
  const nodeMap = new Map(); // id → { el, sig, badge, prog }
  const groupMap = new Map(); // id → { band, head, sig }
  let selected = null;
  let zoomLabel = null;

  const apply = () => {
    layer.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(t.k * 100)}%`;
  };
  apply();

  // ---- controls -------------------------------------------------------------------------
  if (opts.controls !== false) {
    const btn = (ic, label, fn) => h('button', { type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ic, { sw: 2 }));
    zoomLabel = h('span.zoom', null, '100%');
    const ctl = h(
      'div.canvas-ctl',
      { role: 'toolbar', 'aria-label': '畫布控制' },
      btn('fit', '置中顯示全部', () => fit(true)),
      btn('zin', '放大', () => zoomBy(1.2)),
      btn('zout', '縮小', () => zoomBy(1 / 1.2)),
      btn('tidy', '自動整理', () => {
        opts.onTidy?.();
        fit(true);
      }),
      zoomLabel,
    );
    host.appendChild(ctl);
  }

  // ---- pan / zoom -------------------------------------------------------------------------
  const pointers = new Map();
  let pan = null;
  let pinch = null;
  host.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.fnode, .canvas-ctl, .hovbar, a, button, input, select, textarea')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    host.setPointerCapture?.(e.pointerId);
    if (pointers.size === 1) {
      pan = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, moved: false };
      host.classList.add('panning');
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: t.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx: t.x, ty: t.y };
      pan = null;
    }
  });
  host.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const k = clamp(pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / (pinch.d || 1)));
      zoomAt(pinch.cx, pinch.cy, k, pinch);
      userMoved = true;
    } else if (pan) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
      t = { ...t, x: pan.tx + dx, y: pan.ty + dy };
      userMoved = true;
      apply();
    }
  });
  const end = (e) => {
    const wasClick = pan && !pan.moved;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      pan = null;
      host.classList.remove('panning');
      if (wasClick) opts.onBackground?.();
    }
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      userMoved = true;
      if (e.ctrlKey || e.metaKey) {
        const r = host.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, clamp(t.k * Math.exp(-e.deltaY * 0.0022)));
      } else {
        t = { ...t, x: t.x - e.deltaX, y: t.y - e.deltaY };
        apply();
      }
    },
    { passive: false },
  );

  function clamp(k) {
    return Math.max(ZMIN, Math.min(ZMAX, k));
  }
  /** zoom to k keeping the screen point (sx, sy) fixed; `from` = a pinch's starting transform */
  function zoomAt(sx, sy, k, from) {
    const base = from ? { x: from.tx, y: from.ty, k: from.k } : t;
    if (from) {
      const r = host.getBoundingClientRect();
      sx -= r.left;
      sy -= r.top;
    }
    const wx = (sx - base.x) / base.k;
    const wy = (sy - base.y) / base.k;
    t = { k, x: sx - wx * k, y: sy - wy * k };
    apply();
  }
  function zoomBy(f) {
    userMoved = true;
    zoomAt(host.clientWidth / 2, host.clientHeight / 2, clamp(t.k * f));
  }
  function fit(force) {
    const items = [...scene.groups, ...scene.nodes];
    if (!items.length) return;
    if (!force && userMoved) return;
    const box = bounds(items);
    t = fitTransform(box, host.clientWidth, host.clientHeight, { margin: 28, max: opts.maxFit ?? 1 });
    if (force) userMoved = false;
    apply();
  }
  function focus(id) {
    const n = scene.nodes.find((x) => x.id === id);
    if (!n) return;
    const k = Math.max(t.k, 0.8);
    t = { k, x: Math.round(host.clientWidth / 2 - (n.x + n.w / 2) * k), y: Math.round(host.clientHeight / 2 - (n.y + n.h / 2) * k) };
    userMoved = true;
    apply();
    select(id);
    nodeMap.get(id)?.el.focus({ preventScroll: true });
  }
  function select(id) {
    selected = id;
    for (const [nid, n] of nodeMap) n.el.classList.toggle('sel', nid === id);
  }

  // ---- scene ----------------------------------------------------------------------------------
  function render(next) {
    scene = { groups: next.groups || [], nodes: next.nodes || [], edges: next.edges || [], lift: next.lift };
    emptyEl.hidden = !!(scene.nodes.length || scene.groups.length);
    emptyEl.textContent = next.empty || '沒有項目';

    // groups: a band and its header
    const seenG = new Set();
    for (const g of scene.groups) {
      seenG.add(g.id);
      let entry = groupMap.get(g.id);
      if (!entry) {
        entry = { band: h('div.fgroup'), head: h('div.fgroup-head'), sig: '' };
        groupMap.set(g.id, entry);
        groupsEl.appendChild(entry.band);
        labelsEl.appendChild(entry.head);
      }
      Object.assign(entry.band.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
      Object.assign(entry.head.style, { left: `${g.x + 16}px`, top: `${g.y + 10}px` });
      if (entry.sig !== g.sig) {
        entry.head.replaceChildren(...(g.head ? [].concat(g.head()) : []));
        entry.sig = g.sig;
      }
    }
    for (const [id, entry] of groupMap) {
      if (!seenG.has(id)) {
        entry.band.remove();
        entry.head.remove();
        groupMap.delete(id);
      }
    }

    // nodes
    const seen = new Set();
    for (const n of scene.nodes) {
      seen.add(n.id);
      let entry = nodeMap.get(n.id);
      if (!entry) {
        const el = h('button.fnode', { type: 'button' });
        el.dataset.id = n.id;
        el.addEventListener('click', (ev) => {
          select(n.id);
          opts.onNodeClick?.(el.dataset.id, ev);
        });
        el.addEventListener('pointerenter', () => opts.onNodeHover?.(el.dataset.id, el));
        el.addEventListener('pointerleave', (ev) => {
          if (!ev.relatedTarget?.closest?.('.hovbar')) opts.onNodeHover?.(null, el);
        });
        entry = { el, sig: '', badge: null, prog: null };
        nodeMap.set(n.id, entry);
        nodesEl.appendChild(el);
      }
      const { el } = entry;
      el.className = `fnode${n.cls ? ` ${n.cls}` : ''}${n.id === selected ? ' sel' : ''}${n.dim ? ' dim' : ''}`;
      el.dataset.state = n.state || '';
      Object.assign(el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` });
      if (n.label) el.setAttribute('aria-label', n.label);
      if (n.title) el.title = n.title;
      if (entry.sig !== n.sig) {
        el.replaceChildren(...[].concat(n.build()));
        entry.sig = n.sig;
      }
      // badge (top-right corner) and progress (along the bottom edge), outside the button so
      // they never steal its text
      const b = n.badge;
      if (b) {
        if (!entry.badge) {
          entry.badge = h('div.fbadge');
          labelsEl.appendChild(entry.badge);
        }
        entry.badge.dataset.kind = b.kind;
        if (entry.badge.dataset.ic !== (b.icon || BADGE_ICON[b.kind])) {
          entry.badge.dataset.ic = b.icon || BADGE_ICON[b.kind];
          entry.badge.replaceChildren(icon(entry.badge.dataset.ic, { sw: 3 }));
        }
        Object.assign(entry.badge.style, { left: `${n.x + n.w - 14}px`, top: `${n.y - 9}px` });
      } else if (entry.badge) {
        entry.badge.remove();
        entry.badge = null;
      }
      const p = n.prog;
      if (p) {
        if (!entry.prog) {
          entry.prog = h('div.fprog');
          labelsEl.appendChild(entry.prog);
        }
        entry.prog.dataset.state = p.state || '';
        const inner = n.w - 24;
        Object.assign(entry.prog.style, { left: `${n.x + 12}px`, top: `${n.y + n.h - 6}px`, width: `${Math.max(4, Math.min(1, p.pct / 100) * inner)}px` });
      } else if (entry.prog) {
        entry.prog.remove();
        entry.prog = null;
      }
    }
    for (const [id, entry] of nodeMap) {
      if (!seen.has(id)) {
        entry.el.remove();
        entry.badge?.remove();
        entry.prog?.remove();
        nodeMap.delete(id);
      }
    }

    // edges + their labels (rebuilt: cheap, and they follow every move)
    edges.replaceChildren();
    labelsEl.querySelectorAll('.flabel').forEach((l) => l.remove());
    const byId = new Map(scene.nodes.map((n) => [n.id, n]));
    const box = bounds([...scene.groups, ...scene.nodes]);
    edges.setAttribute('width', String(Math.max(1, box.x + box.w + 200)));
    edges.setAttribute('height', String(Math.max(1, box.y + box.h + 200)));
    for (const e of scene.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', e.d || edgePath(a, b, e.kind, e.lift ?? scene.lift));
      if (e.cls) path.setAttribute('class', e.cls);
      if (e.kind !== 'attach') {
        path.setAttribute('marker-end', `url(#${arrowId(e.cls)})`);
      }
      edges.appendChild(path);
      if (e.label) {
        const at = edgeLabelAt(a, b, e.kind, e.lift ?? scene.lift);
        const l = h(`div.flabel${e.labelCls ? `.${e.labelCls}` : ''}`, null, e.label);
        Object.assign(l.style, { left: `${at.x}px`, top: `${at.y}px` });
        labelsEl.appendChild(l);
      }
    }
    edges.appendChild(markers());

    const nextShape = scene.nodes.map((n) => n.id).join('|');
    if (!fitted && scene.nodes.length && host.clientWidth) {
      fitted = true;
      fit(true);
    } else if (nextShape !== shape) fit(false); // a node came or went: show the new whole, unless the view was moved by hand
    shape = nextShape;
  }

  // arrowheads, one per edge colour class (a marker cannot follow the path's stroke everywhere)
  const ARROW = { '': '#9c9383', ok: 'var(--ok)', wait: 'var(--border-2)', back: 'var(--warn)', unsure: 'var(--st-verifying)', fail: 'var(--danger)' };
  function arrowId(cls) {
    const k = String(cls || '').split(' ')[0];
    return `arr-${ARROW[k] !== undefined ? k || 'def' : 'def'}`;
  }
  function markers() {
    const defs = document.createElementNS(NS, 'defs');
    for (const [k, color] of Object.entries(ARROW)) {
      const m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', `arr-${k || 'def'}`);
      m.setAttribute('orient', 'auto');
      m.setAttribute('markerWidth', '8');
      m.setAttribute('markerHeight', '8');
      m.setAttribute('refX', '6');
      m.setAttribute('refY', '4');
      m.setAttribute('markerUnits', 'userSpaceOnUse');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M0 0 L8 4 L0 8 Z');
      p.setAttribute('style', `fill: ${color}; stroke: none`);
      m.appendChild(p);
      defs.appendChild(m);
    }
    return defs;
  }

  // refit when the host first gets a size (a hidden tab) or the window changes a lot
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      if (!fitted && scene.nodes.length && host.clientWidth) {
        fitted = true;
        fit(true);
      } else fit(false);
    }).observe(host);
  }

  return {
    render,
    fit,
    zoomBy,
    focus,
    select,
    layer,
    toScreen: (x, y) => ({ x: x * t.k + t.x, y: y * t.k + t.y }),
    get transform() {
      return { ...t };
    },
  };
}
