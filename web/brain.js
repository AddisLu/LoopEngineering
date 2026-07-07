import {
  buildGraphState,
  mergeGraphState,
  stepForceClustered,
  computeDegrees,
  reheat,
  decayAlpha,
  shouldStep,
  shouldShowLabel,
  matchesFilter,
  screenToWorld,
  worldToScreen,
  hitTestVertex,
  vertexRadius,
  categoryTree,
  categoryFocusVertices,
} from '/graph-layout.js';

// ---- auth / token ----------------------------------------------------
const params = new URLSearchParams(location.search);
if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
const TOKEN = localStorage.getItem('loop_token') || '';
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

// ---- tiny DOM helpers --------------------------------------------------
// XSS contract: every dynamic value below is placed via el()/textContent, never as a
// raw HTML string, so no server-sourced value is ever parsed as markup. The force-directed
// graph (further down) draws entirely on <canvas> — text there is ctx.fillText pixels, not
// DOM/HTML at all, so it can't be an injection vector either way.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

async function api(path, method = 'GET') {
  const r = await fetch(path, { method, headers: authHeaders });
  return r.ok ? r.json().catch(() => ({})) : Promise.reject(await r.text().catch(() => r.statusText));
}
async function postJSON(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await r.text().catch(() => r.statusText);
  return r.json().catch(() => ({}));
}
// fire-and-refetch for simple no-body mutations (approve/reject/delete)
async function act(path, method = 'POST') {
  try { await api(path, method); await fetchAndRender(); }
  catch (e) { alert('操作失敗: ' + e); }
}
// same shape as act(), but refetches the draft-edges panel instead of the node list
async function actEdge(path, method = 'POST') {
  try { await api(path, method); await fetchDraftEdges(); }
  catch (e) { alert('操作失敗: ' + e); }
}

// ---- theme -------------------------------------------------------------
const themeBtn = $('theme-btn');
function currentMode() {
  return document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light';
}
function paintThemeBtn() {
  const dark = currentMode() === 'dark';
  themeBtn.textContent = dark ? '☀' : '☾';
  themeBtn.setAttribute('aria-label', dark ? '切換至淺色佈景' : '切換至深色佈景');
}
themeBtn.onclick = () => {
  const next = currentMode() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-mode', next);
  try { localStorage.setItem('loop_mode', next); } catch (e) {}
  paintThemeBtn();
};
paintThemeBtn();

// ---- filter chips --------------------------------------------------------
const KIND_CHIPS = [
  ['all', '全部'], ['environment', 'environment'], ['constraint', 'constraint'],
  ['preference', 'preference'], ['project', 'project'], ['tech', 'tech'], ['fact', 'fact'],
];
const STATUS_CHIPS = [['all', '全部'], ['approved', '核可'], ['draft', '草稿']];

let currentKind = 'all';
let currentStatus = 'all';

function syncChipActive(container, value) {
  for (const c of container.children) c.classList.toggle('active', c.dataset.value === value);
}
function buildChips(container, defs, apply) {
  container.replaceChildren();
  for (const [value, label] of defs) {
    const chip = el('button', 'chip-btn', label);
    chip.type = 'button';
    chip.dataset.value = value;
    chip.onclick = () => { apply(value); syncChipActive(container, value); fetchAndRender(); };
    container.appendChild(chip);
  }
  syncChipActive(container, defs[0][0]);
}
buildChips($('kind-chips'), KIND_CHIPS, (v) => { currentKind = v; });
buildChips($('status-chips'), STATUS_CHIPS, (v) => { currentStatus = v; });

// ---- search (debounced) --------------------------------------------------
const searchInput = $('search-input');
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(fetchAndRender, 300);
});

// ---- node list -------------------------------------------------------
const nodeList = $('node-list');

function buildRow(n) {
  const row = el('div', 'node-row');
  row.dataset.id = n.id;

  const dot = el('span', `kind-dot k-${n.kind}`);
  dot.title = n.kind;
  row.appendChild(dot);

  const main = el('div', 'node-main');
  main.appendChild(el('div', 'node-title', n.title));

  const meta = el('div', 'node-meta');
  meta.appendChild(el('span', 'chip mono', n.scope));
  meta.appendChild(el('span', 'chip mono', `w${n.weight}`));
  meta.appendChild(el('span', 'chip', n.kind));
  if (n.status === 'draft') meta.appendChild(el('span', 'badge draft-badge', '草稿'));
  if (n.status === 'rejected') meta.appendChild(el('span', 'badge rejected-badge', '已退回'));
  main.appendChild(meta);

  if (n.body) main.appendChild(el('div', 'node-body', n.body));
  row.appendChild(main);

  const actions = el('div', 'node-actions');
  const btn = (label, cls, fn) => {
    const b = el('button', `btn sm ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.onclick = fn;
    return b;
  };
  if (n.status === 'draft') {
    actions.appendChild(btn('核可', 'primary', () => act(`/api/knowledge/${n.id}/approve`)));
    actions.appendChild(btn('退回', 'danger-ghost', () => act(`/api/knowledge/${n.id}/reject`)));
    const evBtn = btn('佐證', '', () => toggleEvidence(n.id, main, evBtn));
    actions.appendChild(evBtn);
  }
  actions.appendChild(btn('關聯', '', () => openGraphView(n.id)));
  actions.appendChild(btn('編輯', '', () => openNodeDialog(n)));
  actions.appendChild(btn('刪除', 'danger-ghost', () => delNode(n.id, n.title)));
  row.appendChild(actions);

  return row;
}

/** Toggles an inline citation panel under a draft node's body — supporting corpus
 * chunks the distiller found when it drafted this node (see GET /api/knowledge/:id/evidence). */
async function toggleEvidence(id, main, evBtn) {
  const existing = main.querySelector('.node-evidence');
  if (existing) {
    existing.remove();
    evBtn.textContent = '佐證';
    return;
  }
  evBtn.textContent = '載入中…';
  let evidence;
  try {
    const res = await api(`/api/knowledge/${id}/evidence`, 'GET');
    evidence = res.evidence || [];
  } catch (e) {
    evBtn.textContent = '佐證';
    alert('載入佐證失敗: ' + e);
    return;
  }
  evBtn.textContent = '佐證 ▾';
  const panel = el('div', 'node-evidence');
  if (!evidence.length) {
    panel.appendChild(el('div', 'muted', '（尚無語料佐證）'));
  } else {
    for (const ev of evidence) {
      const row = el('div', 'evidence-row');
      const lineRef = ev.start_line != null ? `:${ev.start_line}-${ev.end_line ?? ev.start_line}` : '';
      row.appendChild(el('span', 'chip mono', `${ev.path}${lineRef}`));
      row.appendChild(el('div', 'evidence-text', String(ev.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)));
      panel.appendChild(row);
    }
  }
  main.appendChild(panel);
}

async function delNode(id, title) {
  if (!confirm(`確定永久刪除「${title}」？`)) return;
  try { await api(`/api/knowledge/${id}`, 'DELETE'); await fetchAndRender(); }
  catch (e) { alert('刪除失敗: ' + e); }
}

function renderNodes(nodes) {
  nodeList.replaceChildren();
  if (!nodes.length) {
    nodeList.appendChild(el('div', 'empty', '沒有符合條件的知識節點'));
    return;
  }
  for (const n of nodes) nodeList.appendChild(buildRow(n));
}

async function fetchAndRender() {
  const q = searchInput.value.trim();
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (!q && currentKind !== 'all') qs.set('kind', currentKind);
  if (!q && currentStatus !== 'all') qs.set('status', currentStatus);
  let nodes;
  try {
    const res = await api('/api/knowledge' + (qs.toString() ? '?' + qs.toString() : ''), 'GET');
    nodes = res.nodes || [];
  } catch (e) {
    nodeList.replaceChildren(el('div', 'banner danger', '載入失敗：' + e));
    return;
  }
  // searchNodes (hit when q is set) doesn't apply kind/status server-side — filter here
  // so the chips stay meaningful even while a search query is active.
  if (q) {
    if (currentKind !== 'all') nodes = nodes.filter((n) => n.kind === currentKind);
    if (currentStatus !== 'all') nodes = nodes.filter((n) => n.status === currentStatus);
  }
  renderNodes(nodes);
}

// ---- auto-relate: draft-edge review panel --------------------------------
// Suggestions from POST /api/knowledge/relate (see src/knowledge/relate.ts) land as
// status='draft' edges — shown here (never in the force graph or task prompts) until a
// human approves/rejects them, mirroring the draft-node review flow above.
const draftEdgesPanel = $('draft-edges-panel');
const draftEdgesList = $('draft-edges-list');

function buildDraftEdgeRow(e) {
  const row = el('div', 'node-row');
  row.dataset.id = e.id;

  const main = el('div', 'node-main');
  const title = el('div', 'node-title edge-suggestion');
  title.appendChild(el('span', '', e.src_title));
  title.appendChild(el('span', 'chip mono', e.relation));
  title.appendChild(el('span', '', e.dst_title));
  main.appendChild(title);

  const meta = el('div', 'node-meta');
  meta.appendChild(el('span', 'badge draft-badge', '草稿關聯'));
  main.appendChild(meta);

  if (e.note) main.appendChild(el('div', 'node-body', e.note));
  row.appendChild(main);

  const actions = el('div', 'node-actions');
  const btn = (label, cls, fn) => {
    const b = el('button', `btn sm ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.onclick = fn;
    return b;
  };
  actions.appendChild(btn('核可', 'primary', () => actEdge(`/api/knowledge/edges/${e.id}/approve`)));
  actions.appendChild(btn('退回', 'danger-ghost', () => actEdge(`/api/knowledge/edges/${e.id}/reject`)));
  row.appendChild(actions);

  return row;
}

async function fetchDraftEdges() {
  let edges;
  try {
    const res = await api('/api/knowledge/edges/drafts', 'GET');
    edges = res.edges || [];
  } catch (e) {
    draftEdgesPanel.hidden = true;
    return;
  }
  draftEdgesList.replaceChildren();
  draftEdgesPanel.hidden = edges.length === 0;
  for (const e of edges) draftEdgesList.appendChild(buildDraftEdgeRow(e));
}

$('relate-btn').onclick = async () => {
  const btn = $('relate-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '推斷中…';
  try {
    const r = await postJSON('/api/knowledge/relate', {});
    const n = (r.edges || []).length;
    alert(n ? `產生 ${n} 條草稿關聯，請於下方審核` : '沒有找到新的關聯建議');
    await fetchDraftEdges();
  } catch (e) {
    alert('推斷關聯失敗: ' + e);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
};

// ---- force-directed knowledge graph (SSoT Phase 3) ----------------------
// Hand-rolled canvas 2D: pan/zoom/drag/click-to-expand + kind/tag/scope/source filters,
// documents rendered as a distinct (square) node type. No CDN/library — see
// web/graph-layout.js for the DOM-free state/physics/filter logic this wires up.
const graphPanel = $('graph-panel');
const graphTitle = $('graph-title');
const graphEmpty = $('graph-empty');
const graphCanvas = $('graph-canvas');
const graphTooltip = $('graph-tooltip');
const gctx = graphCanvas.getContext('2d');
const graphDepthInput = $('graph-depth');
const graphTagFilter = $('graph-tag-filter');
const graphScopeFilter = $('graph-scope-filter');
const graphShowDocuments = $('graph-show-documents');
const graphKindChips = $('graph-kind-chips');
const graphSourceChips = $('graph-source-chips');
const graphCounts = $('graph-counts');
const graphDensityInput = $('graph-density');
const graphFullscreenBtn = $('graph-fullscreen');
const graphCategoryTree = $('graph-category-tree');
const graphDetailPanel = $('graph-detail-panel');
const graphDetailTitle = $('graph-detail-title');
const graphDetailBody = $('graph-detail-body');
const graphDetailClose = $('graph-detail-close');

let graphState = null; // { vertices: Map<id, Vertex>, edges: Edge[] } — see graph-layout.js
let graphView = { offsetX: 0, offsetY: 0, scale: 1 };
let graphRaf = null;
let graphCenterId = null; // null = whole-graph mode
let graphViewMode = 'default'; // 'default' | 'brain' — which GraphView the current panel was opened/expanded with
let hoveredVertexId = null; // canvas mousemove hit-test, see the graphCanvas 'mousemove' listener below
let graphFocusId = null; // most recent click-to-focus target (see focusVertex())
let viewAnim = null; // active pan/zoom tween — see animateViewTo()/tickViewAnim()

const ALL_KINDS = KIND_CHIPS.slice(1).map(([v]) => v);
let selectedGraphKinds = new Set(ALL_KINDS); // opt-out: all kinds shown by default
let selectedGraphSources = new Set(); // opt-in: empty = no source filter applied

// ---- G3 immersive visual tunables --------------------------------------
// Baseline dark-immersive numbers, deliberately centralized so Claude Design can retune
// the look later without touching rendering/interaction logic. Category hue/sat/lightness
// mirror the four view=brain top-level buckets (see src/knowledge/store.ts::categorizeDocument);
// sub-category only varies lightness (subLightnessOffset below), never hue, so a category's
// members always read as one family of color.
const CATEGORY_HSL = {
  策展: { h: 217, s: 88, l: 66 },
  程式碼: { h: 158, s: 60, l: 56 },
  OpenProject: { h: 32, s: 90, l: 60 },
  筆記: { h: 280, s: 65, l: 70 },
};
const CATEGORY_DEFAULT_HSL = { h: 220, s: 8, l: 60 };

const GRAPH_VISUAL = Object.freeze({
  glowBlur: 12,
  glowBlurHi: 22,
  edgeWidth: 1.1,
  edgeAlphaBase: 0.22,
  edgeAlphaHi: 0.9,
  edgeAlphaDim: 0.05,
  nodeAlphaDim: 0.22,
  curveAmount: 0.14, // fraction of edge length the bezier control point offsets by
  curveMax: 46,
  zoomFocusScale: 1.9,
  zoomAnimMs: 420,
});

let graphLabelDensity = 0; // G4: driven by the 展示程度 slider, biases the LoD zoom threshold

// ---- G4: category tree (left) + node detail panel (right) --------------
let selectedCategory = null; // { top, sub: string|null } | null -- null = "全部" (no focus)
let categoryFocus = null; // categoryFocusVertices(graphState, selectedCategory) result, or null
let currentDetailVertexId = null; // guards against a stale async evidence fetch clobbering the panel

function currentGraphFilters() {
  return {
    kind: selectedGraphKinds.size < ALL_KINDS.length ? selectedGraphKinds : null,
    source: selectedGraphSources.size ? selectedGraphSources : null,
    tag: graphTagFilter.value.trim(),
    scope: graphScopeFilter.value.trim(),
    showDocuments: graphShowDocuments.checked,
  };
}
function visibleGraphVertices() {
  if (!graphState) return [];
  const filters = currentGraphFilters();
  let vertices = [...graphState.vertices.values()].filter((v) => matchesFilter(v, filters));
  if (categoryFocus) vertices = vertices.filter((v) => categoryFocus.visible.has(v.id));
  return vertices;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Deterministic string->[-10,10] hash, used to vary a category's lightness by
 * sub-category without touching its hue (see CATEGORY_HSL). */
function subLightnessOffset(sub) {
  if (!sub) return 0;
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  return (h % 21) - 10;
}

/** view=brain/brain-full vertices carry `category` (see src/knowledge/store.ts) and are
 * colored by it; the node-centric 關聯 relation view (default GraphView) never has
 * category and keeps the original per-kind coloring so that flow is unaffected by G3. */
function vertexColor(v) {
  const top = v.category?.top;
  if (top) {
    const base = CATEGORY_HSL[top] ?? CATEGORY_DEFAULT_HSL;
    const l = Math.min(85, Math.max(28, base.l + subLightnessOffset(v.category.sub)));
    return `hsl(${base.h} ${base.s}% ${l}%)`;
  }
  return v.type === 'document' ? cssVar('--k-document', '#888') : cssVar(`--k-${v.kind}`, cssVar('--k-fact', '#888'));
}

/** { id -> true } for `id` itself plus every vertex directly connected to it — used to
 * highlight a hovered/focused node's neighborhood and dim everything else. */
function neighborIds(state, id) {
  const set = new Set([id]);
  if (!state) return set;
  for (const e of state.edges) {
    if (e.src === id) set.add(e.dst);
    else if (e.dst === id) set.add(e.src);
  }
  return set;
}

/** Keeps the canvas's backing-store resolution in sync with its CSS display size
 * (accounting for devicePixelRatio) so drawing stays crisp on HiDPI screens; returns
 * the CSS-pixel size that world<->screen math (and mouse events) should use. */
function resizeGraphCanvas() {
  const rect = graphCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (graphCanvas.width !== w || graphCanvas.height !== h) {
    graphCanvas.width = w;
    graphCanvas.height = h;
  }
  return { cssW: rect.width, cssH: rect.height, dpr };
}

/** Dark immersive background: a solid base plus a soft off-center glow that falls off
 * into a vignette at the edges — the "night sky" the graph floats in, independent of the
 * page's light/dark theme (see the --graph-bg-1/--graph-bg-2/--graph-vignette custom
 * properties in styles.css). */
function drawBackground(cssW, cssH) {
  gctx.fillStyle = cssVar('--graph-bg-1', '#05070d');
  gctx.fillRect(0, 0, cssW, cssH);
  const r = Math.max(cssW, cssH) * 0.8;
  const grad = gctx.createRadialGradient(cssW / 2, cssH * 0.4, 0, cssW / 2, cssH * 0.4, r);
  grad.addColorStop(0, cssVar('--graph-bg-2', '#111a30'));
  grad.addColorStop(1, cssVar('--graph-vignette', 'rgba(2,4,10,0.92)'));
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, cssW, cssH);
}

function drawGraph() {
  const { cssW, cssH, dpr } = resizeGraphCanvas();
  gctx.save();
  gctx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
  gctx.scale(dpr, dpr); // world<->screen math below stays in CSS-pixel units regardless of DPR

  drawBackground(cssW, cssH);

  const vertices = visibleGraphVertices();
  const visibleIds = new Set(vertices.map((v) => v.id));
  const textColor = cssVar('--graph-text', '#e8ecf5');
  const textDim = cssVar('--graph-text-dim', 'rgba(232,236,245,0.55)');
  // hover wins over the (rarer) click-focus ring when both are set, since it's the more
  // immediate signal of what the user's looking at right now.
  const highlightId = hoveredVertexId ?? graphFocusId;
  const highlight = highlightId ? neighborIds(graphState, highlightId) : null;

  gctx.lineWidth = GRAPH_VISUAL.edgeWidth * Math.sqrt(graphView.scale);
  for (const e of graphState ? graphState.edges : []) {
    if (!visibleIds.has(e.src) || !visibleIds.has(e.dst)) continue;
    const a = graphState.vertices.get(e.src);
    const b = graphState.vertices.get(e.dst);
    const pa = worldToScreen(graphView, a.x, a.y, cssW, cssH);
    const pb = worldToScreen(graphView, b.x, b.y, cssW, cssH);
    const inCategoryFocus = categoryFocus && (categoryFocus.focused.has(e.src) || categoryFocus.focused.has(e.dst));
    const related = (highlight && (e.src === highlightId || e.dst === highlightId)) || inCategoryFocus;
    const dimSource = highlight || categoryFocus;
    gctx.globalAlpha = !dimSource ? GRAPH_VISUAL.edgeAlphaBase : related ? GRAPH_VISUAL.edgeAlphaHi : GRAPH_VISUAL.edgeAlphaDim;
    const grad = gctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    grad.addColorStop(0, vertexColor(a));
    grad.addColorStop(1, vertexColor(b));
    gctx.strokeStyle = grad;
    // gentle quadratic curve (Obsidian-style) instead of a straight line -- offset the
    // control point perpendicular to the edge, capped so long edges don't bow wildly.
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(len * GRAPH_VISUAL.curveAmount, GRAPH_VISUAL.curveMax);
    const cx = (pa.x + pb.x) / 2 + (-dy / len) * bow;
    const cy = (pa.y + pb.y) / 2 + (dx / len) * bow;
    gctx.beginPath();
    gctx.moveTo(pa.x, pa.y);
    gctx.quadraticCurveTo(cx, cy, pb.x, pb.y);
    gctx.stroke();
  }
  gctx.globalAlpha = 1;

  gctx.textAlign = 'center';
  gctx.textBaseline = 'top';
  gctx.font = '11px system-ui, sans-serif';
  for (const v of vertices) {
    const p = worldToScreen(graphView, v.x, v.y, cssW, cssH);
    const r = vertexRadius(v) * Math.sqrt(graphView.scale);
    const selected = v.id === graphCenterId || v.id === graphFocusId || v.id === hoveredVertexId;
    const dimmed = (highlight && !highlight.has(v.id)) || (categoryFocus && !categoryFocus.focused.has(v.id));

    gctx.globalAlpha = dimmed ? GRAPH_VISUAL.nodeAlphaDim : 1;
    const color = vertexColor(v);
    gctx.shadowColor = color;
    gctx.shadowBlur = selected ? GRAPH_VISUAL.glowBlurHi : GRAPH_VISUAL.glowBlur;
    gctx.fillStyle = color;
    gctx.beginPath();
    if (v.type === 'document') gctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    else gctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    gctx.fill();
    gctx.shadowBlur = 0;
    if (selected) {
      gctx.lineWidth = 2;
      gctx.strokeStyle = textColor;
      gctx.stroke();
    }

    if (shouldShowLabel(v, { scale: graphView.scale + graphLabelDensity, hoveredId: hoveredVertexId, focusId: graphFocusId })) {
      gctx.fillStyle = dimmed ? textDim : textColor;
      gctx.fillText(String(v.label ?? '').slice(0, 22), p.x, p.y + r + 3);
    }
  }
  gctx.globalAlpha = 1;
  gctx.restore();
}

/** Eases the active pan/zoom tween (see focusVertex/animateViewTo) toward its target;
 * a no-op once no animation is running. Runs every frame regardless of alpha cooldown --
 * it's independent of the force sim. */
function tickViewAnim() {
  if (!viewAnim) return;
  const t = Math.min(1, (performance.now() - viewAnim.start) / viewAnim.duration);
  const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
  graphView = {
    offsetX: viewAnim.from.offsetX + (viewAnim.to.offsetX - viewAnim.from.offsetX) * eased,
    offsetY: viewAnim.from.offsetY + (viewAnim.to.offsetY - viewAnim.from.offsetY) * eased,
    scale: viewAnim.from.scale + (viewAnim.to.scale - viewAnim.from.scale) * eased,
  };
  if (t >= 1) viewAnim = null;
}

function graphLoop() {
  if (graphState) {
    if (shouldStep(graphState)) {
      stepForceClustered(graphState);
      decayAlpha(graphState);
    }
    tickViewAnim();
  }
  drawGraph();
  graphRaf = requestAnimationFrame(graphLoop);
}
function stopGraphLoop() {
  if (graphRaf) cancelAnimationFrame(graphRaf);
  graphRaf = null;
}

function populateGraphFilterChips() {
  graphKindChips.replaceChildren();
  for (const kind of ALL_KINDS) {
    const chip = el('button', 'chip-btn', kind);
    chip.type = 'button';
    chip.dataset.value = kind;
    chip.classList.toggle('active', selectedGraphKinds.has(kind));
    chip.onclick = () => {
      if (selectedGraphKinds.has(kind)) selectedGraphKinds.delete(kind);
      else selectedGraphKinds.add(kind);
      chip.classList.toggle('active', selectedGraphKinds.has(kind));
    };
    graphKindChips.appendChild(chip);
  }

  const sources = new Set();
  for (const v of graphState ? graphState.vertices.values() : []) {
    if (v.type === 'node' && v.raw.source) sources.add(v.raw.source);
    if (v.type === 'document' && v.raw.source_id) sources.add(v.raw.source_id);
  }
  graphSourceChips.replaceChildren();
  for (const s of [...sources].sort()) {
    const chip = el('button', 'chip-btn', s);
    chip.type = 'button';
    chip.dataset.value = s;
    chip.classList.toggle('active', selectedGraphSources.has(s));
    chip.onclick = () => {
      if (selectedGraphSources.has(s)) selectedGraphSources.delete(s);
      else selectedGraphSources.add(s);
      chip.classList.toggle('active', selectedGraphSources.has(s));
    };
    graphSourceChips.appendChild(chip);
  }
}

/** Top「實體 N・關係 M」 counts (GRAPH G4): the full live graph state, not just what
 * passes the current filters -- filtering hides vertices, it doesn't shrink the graph. */
function updateGraphCounts() {
  graphCounts.textContent = graphState ? `實體 ${graphState.vertices.size} · 關係 ${graphState.edges.length}` : '';
}

function categorySwatchColor(top) {
  const c = CATEGORY_HSL[top] ?? CATEGORY_DEFAULT_HSL;
  return `hsl(${c.h} ${c.s}% ${c.l}%)`;
}

/** Recomputes categoryFocus from the current selectedCategory (see categoryFocusVertices
 * in graph-layout.js) -- call after selectedCategory changes or graphState is rebuilt. */
function updateCategoryFocus() {
  categoryFocus = graphState && selectedCategory ? categoryFocusVertices(graphState, selectedCategory) : null;
}

/** GRAPH G4: left category tree/legend -- built from the live graphState's categories
 * (only view=brain vertices carry `category`, so this stays empty/hidden for a
 * node-centered 關聯 view). Clicking a bucket sets selectedCategory (focus-filter, see
 * visibleGraphVertices/drawGraph); "全部" clears it back to showing everything. */
function renderCategoryTree() {
  graphCategoryTree.replaceChildren();
  const tree = graphState ? categoryTree(graphState) : new Map();
  if (!tree.size) {
    graphCategoryTree.hidden = true;
    return;
  }
  graphCategoryTree.hidden = false;

  const select = (next) => {
    selectedCategory = next;
    updateCategoryFocus();
    renderCategoryTree();
  };

  const allBtn = el('button', 'chip-btn category-tree-all', '全部');
  allBtn.type = 'button';
  allBtn.classList.toggle('active', !selectedCategory);
  allBtn.onclick = () => select(null);
  graphCategoryTree.appendChild(allBtn);

  for (const [top, info] of [...tree.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const topBtn = el('button', 'chip-btn category-tree-top');
    topBtn.type = 'button';
    const swatch = el('span', 'category-swatch');
    swatch.style.background = categorySwatchColor(top);
    topBtn.appendChild(swatch);
    topBtn.appendChild(el('span', 'category-tree-label', top));
    topBtn.appendChild(el('span', 'chip mono category-count', String(info.count)));
    topBtn.classList.toggle('active', selectedCategory?.top === top && !selectedCategory.sub);
    topBtn.onclick = () => select({ top, sub: null });
    graphCategoryTree.appendChild(topBtn);

    for (const [sub, count] of [...info.subs.entries()].sort((a, b) => b[1] - a[1])) {
      const subBtn = el('button', 'chip-btn category-tree-sub');
      subBtn.type = 'button';
      subBtn.appendChild(el('span', 'category-tree-label', sub));
      subBtn.appendChild(el('span', 'chip mono category-count', String(count)));
      subBtn.classList.toggle('active', selectedCategory?.top === top && selectedCategory?.sub === sub);
      subBtn.onclick = () => select({ top, sub });
      graphCategoryTree.appendChild(subBtn);
    }
  }
}

async function fetchGraph(nodeId, depth, view) {
  const qs = new URLSearchParams();
  if (nodeId) qs.set('nodeId', nodeId);
  if (depth) qs.set('depth', String(depth));
  if (view) qs.set('view', view);
  return api('/api/knowledge/graph' + (qs.toString() ? '?' + qs.toString() : ''), 'GET');
}

/** Opens the graph panel: `nodeId` centers a depth-hop BFS neighborhood (see the
 * `關聯` button and click-to-expand below) on the plain GraphView; omit it for the whole
 * curated graph, which fetches `view=brain` (GRAPH G3) so vertices carry `category` for
 * the immersive grouped/colored rendering below. */
async function openGraphView(nodeId) {
  graphPanel.hidden = false;
  graphEmpty.hidden = true;
  graphDetailPanel.hidden = true;
  currentDetailVertexId = null;
  graphCenterId = nodeId ?? null;
  graphFocusId = null;
  hoveredVertexId = null;
  viewAnim = null;
  graphView = { offsetX: 0, offsetY: 0, scale: 1 };
  graphViewMode = nodeId ? 'default' : 'brain';
  selectedCategory = null;
  categoryFocus = null;

  let g;
  try {
    g = await fetchGraph(nodeId, nodeId ? Number(graphDepthInput.value || 2) : undefined, nodeId ? undefined : 'brain');
  } catch (e) {
    graphState = null;
    graphTitle.textContent = '';
    graphCounts.textContent = '';
    graphEmpty.hidden = false;
    graphEmpty.textContent = '載入圖譜失敗：' + e;
    return;
  }

  graphState = buildGraphState(g);
  computeDegrees(graphState);
  reheat(graphState);
  populateGraphFilterChips();
  renderCategoryTree();
  updateGraphCounts();

  graphTitle.textContent = nodeId
    ? (graphState.vertices.get(nodeId)?.label ?? '')
    : `整體知識圖譜（${(g.nodes || []).length} 節點・${(g.documents || []).length} 文件）`;

  if (graphState.vertices.size === 0) {
    graphEmpty.hidden = false;
    graphEmpty.textContent = '知識庫目前沒有節點';
  } else if (nodeId && graphState.edges.length === 0) {
    graphEmpty.hidden = false;
    graphEmpty.textContent = '此節點尚無關聯';
  }

  stopGraphLoop();
  graphLoop();
}

/** Click-to-expand: pull a 1-hop neighborhood around the clicked vertex and merge it
 * into the live graph (new vertices seeded near it, existing layout undisturbed). Uses
 * the panel's current GraphView mode so merged-in vertices keep the same category/no-
 * category shape as the rest of the live state. */
async function expandVertex(vertex) {
  let g;
  try {
    g = await fetchGraph(vertex.id, 1, graphViewMode === 'brain' ? 'brain' : undefined);
  } catch (e) {
    alert('展開失敗: ' + e);
    return;
  }
  mergeGraphState(graphState, g, vertex.id);
  computeDegrees(graphState);
  reheat(graphState);
  populateGraphFilterChips();
  renderCategoryTree();
  updateCategoryFocus();
  updateGraphCounts();
  graphEmpty.hidden = true;
}

/** Click-to-focus (GRAPH G3): smoothly pans/zooms the clicked vertex to canvas center
 * before expanding its neighborhood, so the graph reads as "diving into" a node rather
 * than jump-cutting. */
function focusVertex(vertex) {
  graphFocusId = vertex.id;
  reheat(graphState);
  const targetScale = Math.min(Math.max(graphView.scale, 1) * 1.25, GRAPH_VISUAL.zoomFocusScale);
  animateViewTo({ offsetX: -vertex.x * targetScale, offsetY: -vertex.y * targetScale, scale: targetScale });
  expandVertex(vertex);
}

function animateViewTo(target, duration = GRAPH_VISUAL.zoomAnimMs) {
  viewAnim = { from: { ...graphView }, to: target, start: performance.now(), duration };
}

/** GRAPH G4: right detail panel for a clicked node -- title/category/source, a clickable
 * neighbor list (jumps focus to that neighbor), and evidence: curated nodes fetch
 * GET /api/knowledge/:id/evidence (same citations as the list's 佐證 button); documents
 * show their uri/doc_kind directly (no evidence endpoint for them). Ends with the
 * "用此脈絡問 AI" action (see askAiAboutVertex). */
async function showNodeDetail(vertex) {
  currentDetailVertexId = vertex.id;
  graphDetailPanel.hidden = false;
  graphDetailTitle.textContent = vertex.label ?? '';
  graphDetailBody.replaceChildren();

  const meta = el('div', 'graph-detail-meta');
  if (vertex.category?.top) meta.appendChild(el('span', 'chip mono', vertex.category.top));
  if (vertex.category?.sub) meta.appendChild(el('span', 'chip mono', vertex.category.sub));
  const source = vertex.type === 'document' ? vertex.raw.source_id : vertex.raw.source;
  if (source) meta.appendChild(el('span', 'chip', String(source)));
  graphDetailBody.appendChild(meta);

  const neighborsSection = el('div', 'graph-detail-section');
  neighborsSection.appendChild(el('div', 'settings-group', '關聯'));
  const neighborIdList = [...neighborIds(graphState, vertex.id)].filter((id) => id !== vertex.id);
  if (!neighborIdList.length) {
    neighborsSection.appendChild(el('div', 'muted', '（尚無關聯）'));
  } else {
    for (const nid of neighborIdList) {
      const nv = graphState.vertices.get(nid);
      if (!nv) continue;
      const btn = el('button', 'btn sm graph-detail-neighbor', nv.label ?? nid);
      btn.type = 'button';
      btn.onclick = () => {
        focusVertex(nv);
        showNodeDetail(nv);
      };
      neighborsSection.appendChild(btn);
    }
  }
  graphDetailBody.appendChild(neighborsSection);

  const evSection = el('div', 'graph-detail-section');
  evSection.appendChild(el('div', 'settings-group', '證據'));
  if (vertex.type === 'document') {
    const line = `${vertex.raw.doc_kind ?? ''} ${vertex.raw.uri ?? vertex.raw.path ?? ''}`.trim();
    evSection.appendChild(el('div', 'muted', line || '（無來源資訊）'));
  } else {
    evSection.appendChild(el('div', 'muted', '載入中…'));
  }
  graphDetailBody.appendChild(evSection);

  appendAskAiSection(vertex);

  if (vertex.type !== 'document') {
    let evidence = null;
    try {
      const res = await api(`/api/knowledge/${vertex.id}/evidence`, 'GET');
      evidence = res.evidence || [];
    } catch (e) {
      evidence = null;
    }
    if (currentDetailVertexId !== vertex.id) return; // panel moved on while this was in flight
    evSection.replaceChildren(el('div', 'settings-group', '證據'));
    if (evidence === null) {
      evSection.appendChild(el('div', 'muted', '（載入佐證失敗）'));
    } else if (!evidence.length) {
      evSection.appendChild(el('div', 'muted', '（尚無語料佐證）'));
    } else {
      for (const ev of evidence) {
        const row = el('div', 'evidence-row');
        const lineRef = ev.start_line != null ? `:${ev.start_line}-${ev.end_line ?? ev.start_line}` : '';
        row.appendChild(el('span', 'chip mono', `${ev.path}${lineRef}`));
        row.appendChild(el('div', 'evidence-text', String(ev.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)));
        evSection.appendChild(row);
      }
    }
  }
}

/** "用此脈絡問 AI" (GRAPH G4): POSTs the node + its neighbors as context to the existing
 * POST /api/report endpoint (see src/server/reportRoutes.ts) and shows the markdown reply
 * as plain text (no md->html). That endpoint 404s while `report_enabled` is off (its
 * default) -- treated as "feature not available" and disabled after the first failure,
 * rather than surfaced as a hard error. */
function appendAskAiSection(vertex) {
  const section = el('div', 'graph-detail-section graph-ask-ai');
  const btn = el('button', 'btn sm primary', '用此脈絡問 AI');
  btn.type = 'button';
  const out = el('div', 'graph-ask-ai-out muted');
  out.hidden = true;
  btn.onclick = () => askAiAboutVertex(vertex, btn, out);
  section.appendChild(btn);
  section.appendChild(out);
  graphDetailBody.appendChild(section);
}

async function askAiAboutVertex(vertex, btn, out) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '詢問中…';
  out.hidden = false;
  out.className = 'graph-ask-ai-out muted';
  out.textContent = '';

  const neighborLabels = [...neighborIds(graphState, vertex.id)]
    .filter((id) => id !== vertex.id)
    .map((id) => graphState.vertices.get(id)?.label)
    .filter(Boolean)
    .slice(0, 8);
  const topic = vertex.category?.top ?? vertex.kind ?? '';
  const description = `請針對知識圖節點「${vertex.label}」（${topic}）提供脈絡摘要與建議。相關節點：${neighborLabels.join('、') || '（無）'}`;

  try {
    const r = await postJSON('/api/report', { description });
    out.className = 'graph-ask-ai-out';
    out.textContent = r.markdown || '（無回應內容）';
    btn.disabled = false;
    btn.textContent = original;
  } catch (e) {
    out.className = 'graph-ask-ai-out muted';
    out.textContent = '此功能目前未啟用';
    btn.textContent = original;
    // leave the button disabled: the endpoint isn't available, so retrying would just fail again
  }
}

graphDetailClose.onclick = () => { graphDetailPanel.hidden = true; currentDetailVertexId = null; };

$('graph-close').onclick = () => {
  graphPanel.hidden = true;
  graphDetailPanel.hidden = true;
  currentDetailVertexId = null;
  stopGraphLoop();
};
$('graph-btn').onclick = () => openGraphView(null);
$('graph-reset').onclick = () => {
  viewAnim = null;
  graphFocusId = null;
  graphView = { offsetX: 0, offsetY: 0, scale: 1 };
};
$('graph-zoom-in').onclick = () => { graphView.scale = Math.min(graphView.scale * 1.25, 4); };
$('graph-zoom-out').onclick = () => { graphView.scale = Math.max(graphView.scale / 1.25, 0.15); };
graphDepthInput.addEventListener('change', () => {
  if (graphCenterId) openGraphView(graphCenterId);
});

// GRAPH G4: 展示程度 slider (1..10, default 5 = unbiased) -- biases graphLabelDensity, the
// existing LoD hook consumed by shouldShowLabel's `scale` in drawGraph.
graphDensityInput.addEventListener('input', () => {
  graphLabelDensity = (Number(graphDensityInput.value) - 5) * 0.25;
});

// GRAPH G4: fullscreen immersion -- resizeGraphCanvas() already reads the canvas's CSS
// box size every frame (see drawGraph), so no extra resize wiring is needed here; the
// fullscreen CSS (styles.css .graph-panel:fullscreen) just gives that box more room.
graphFullscreenBtn.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else graphPanel.requestFullscreen?.();
};

// ---- canvas interaction: pan (drag empty space) / zoom (wheel) / drag node / click to expand ----
let dragTarget = null; // a vertex object, or the string 'pan'
let dragMoved = false;
let panStart = null;

function eventToCanvasPoint(evt) {
  const rect = graphCanvas.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top, width: rect.width, height: rect.height };
}

graphCanvas.addEventListener('mousedown', (evt) => {
  if (!graphState) return;
  evt.preventDefault();
  const { x, y, width, height } = eventToCanvasPoint(evt);
  const world = screenToWorld(graphView, x, y, width, height);
  const hit = hitTestVertex(visibleGraphVertices(), world.x, world.y, 16 / graphView.scale);
  dragMoved = false;
  if (hit) {
    hit.fixed = true;
    dragTarget = hit;
    reheat(graphState);
  } else {
    dragTarget = 'pan';
    panStart = { x: evt.clientX, y: evt.clientY, offsetX: graphView.offsetX, offsetY: graphView.offsetY };
  }
});
window.addEventListener('mousemove', (evt) => {
  if (!dragTarget) return;
  dragMoved = true;
  if (dragTarget === 'pan') {
    graphView.offsetX = panStart.offsetX + (evt.clientX - panStart.x);
    graphView.offsetY = panStart.offsetY + (evt.clientY - panStart.y);
  } else {
    const { x, y, width, height } = eventToCanvasPoint(evt);
    const world = screenToWorld(graphView, x, y, width, height);
    dragTarget.x = world.x;
    dragTarget.y = world.y;
    dragTarget.vx = 0;
    dragTarget.vy = 0;
  }
});
window.addEventListener('mouseup', () => {
  if (dragTarget && dragTarget !== 'pan') {
    dragTarget.fixed = false;
    if (!dragMoved) {
      focusVertex(dragTarget);
      showNodeDetail(dragTarget);
    }
  }
  dragTarget = null;
  panStart = null;
});

/** Hover (GRAPH G3): hit-tests under the cursor to highlight a vertex + its neighbors
 * (see drawGraph's `highlight` set), show a small tooltip, and switch the cursor to a
 * pointer over a hittable vertex. Skipped mid-drag/pan — that has its own feedback. */
graphCanvas.addEventListener('mousemove', (evt) => {
  if (dragTarget || !graphState) return;
  const { x, y, width, height } = eventToCanvasPoint(evt);
  const world = screenToWorld(graphView, x, y, width, height);
  const hit = hitTestVertex(visibleGraphVertices(), world.x, world.y, 16 / graphView.scale);
  hoveredVertexId = hit ? hit.id : null;
  graphCanvas.style.cursor = hit ? 'pointer' : 'grab';
  updateTooltip(hit, evt);
});
graphCanvas.addEventListener('mouseleave', () => {
  hoveredVertexId = null;
  updateTooltip(null);
});

/** Small canvas-adjacent tooltip for the hovered vertex — a real DOM element (not canvas
 * text) built with el()/textContent like every other dynamic DOM piece in this file. */
function updateTooltip(vertex, evt) {
  if (!vertex) {
    graphTooltip.hidden = true;
    return;
  }
  graphTooltip.replaceChildren();
  graphTooltip.appendChild(el('div', 'graph-tooltip-title', vertex.label));
  const sub = vertex.type === 'document' ? '文件' : (vertex.category?.sub ?? vertex.kind ?? '');
  if (sub) graphTooltip.appendChild(el('div', 'graph-tooltip-meta', sub));
  graphTooltip.hidden = false;
  const rect = graphCanvas.getBoundingClientRect();
  graphTooltip.style.left = `${evt.clientX - rect.left + 14}px`;
  graphTooltip.style.top = `${evt.clientY - rect.top + 14}px`;
}
graphCanvas.addEventListener(
  'wheel',
  (evt) => {
    if (!graphState) return;
    evt.preventDefault();
    const { x, y, width, height } = eventToCanvasPoint(evt);
    const before = screenToWorld(graphView, x, y, width, height);
    const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(Math.max(graphView.scale * factor, 0.15), 4);
    graphView.offsetX = x - width / 2 - before.x * newScale;
    graphView.offsetY = y - height / 2 - before.y * newScale;
    graphView.scale = newScale;
  },
  { passive: false },
);

// ---- add/edit dialog ---------------------------------------------------
const nodeDialog = $('node-dialog');
const nodeForm = $('node-form');
const nodeErr = $('node-err');
const nodeDialogTitle = $('node-dialog-title');
const edgeSection = $('edge-section');
const edgeList = $('edge-list');
const nodeTitleList = $('node-title-list');

let titleToId = new Map();

async function loadEdgesPanel(nodeId) {
  let graph;
  try { graph = await api('/api/knowledge/graph', 'GET'); }
  catch (e) { edgeList.replaceChildren(el('div', 'muted', '載入連結失敗：' + e)); return; }
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  titleToId = new Map(nodes.map((n) => [n.title, n.id]));
  const idToTitle = new Map(nodes.map((n) => [n.id, n.title]));

  nodeTitleList.replaceChildren();
  for (const n of nodes) {
    if (n.id === nodeId) continue;
    const opt = document.createElement('option');
    opt.value = n.title;
    nodeTitleList.appendChild(opt);
  }

  const nodeEdges = edges.filter((e) => e.src === nodeId || e.dst === nodeId);
  edgeList.replaceChildren();
  if (!nodeEdges.length) {
    edgeList.appendChild(el('div', 'muted', '（尚無連結）'));
  }
  for (const e of nodeEdges) {
    const otherId = e.src === nodeId ? e.dst : e.src;
    const row = el('div', 'edge-row');
    row.appendChild(el('span', 'chip', e.relation));
    row.appendChild(el('span', 'edge-other', idToTitle.get(otherId) || otherId));
    const delBtn = el('button', 'btn sm danger-ghost', '刪除');
    delBtn.type = 'button';
    delBtn.onclick = async () => {
      try { await api(`/api/knowledge/edges/${e.id}`, 'DELETE'); await loadEdgesPanel(nodeId); }
      catch (err) { alert('刪除連結失敗: ' + err); }
    };
    row.appendChild(delBtn);
    edgeList.appendChild(row);
  }
}

$('edge-add-btn').onclick = async () => {
  const id = nodeForm.elements.id.value;
  if (!id) return; // no edges until the node itself is saved
  const dstTitle = String(nodeForm.elements.edge_dst.value || '').trim();
  const dstId = titleToId.get(dstTitle);
  if (!dstId) { alert('找不到節點：' + dstTitle); return; }
  const relation = nodeForm.elements.edge_relation.value;
  try {
    await postJSON('/api/knowledge/edges', { src: id, dst: dstId, relation });
    nodeForm.elements.edge_dst.value = '';
    await loadEdgesPanel(id);
  } catch (e) {
    alert('加連結失敗: ' + e);
  }
};

function openNodeDialog(n) {
  nodeForm.reset();
  nodeErr.hidden = true;
  if (n) {
    nodeDialogTitle.textContent = '編輯知識';
    nodeForm.elements.id.value = n.id;
    nodeForm.elements.title.value = n.title || '';
    nodeForm.elements.body.value = n.body || '';
    nodeForm.elements.kind.value = n.kind || 'fact';
    nodeForm.elements.scope.value = n.scope || 'global';
    nodeForm.elements.weight.value = n.weight ?? 3;
    let tags = [];
    try { tags = JSON.parse(n.tags || '[]'); } catch (e) { /* leave empty */ }
    nodeForm.elements.tags.value = Array.isArray(tags) ? tags.join(', ') : '';
    edgeSection.hidden = false;
    loadEdgesPanel(n.id);
  } else {
    nodeDialogTitle.textContent = '新增知識';
    nodeForm.elements.id.value = '';
    nodeForm.elements.scope.value = 'global';
    nodeForm.elements.weight.value = 3;
    edgeSection.hidden = true;
    edgeList.replaceChildren();
  }
  nodeDialog.showModal();
}
$('new-node-btn').onclick = () => openNodeDialog(null);
$('node-cancel').onclick = () => nodeDialog.close();

nodeForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value !== 'save') return; // cancel closes normally
  e.preventDefault();
  const fd = new FormData(nodeForm);
  const tags = String(fd.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const body = {
    title: fd.get('title'),
    body: fd.get('body') || '',
    kind: fd.get('kind'),
    scope: String(fd.get('scope') || '').trim() || 'global',
    weight: Number(fd.get('weight') || 3),
    tags,
  };
  const saveBtn = $('node-save');
  saveBtn.disabled = true;
  nodeErr.hidden = true;
  try {
    await postJSON('/api/knowledge', body);
    nodeDialog.close();
    await fetchAndRender();
  } catch (err) {
    nodeErr.textContent = '儲存失敗：' + err;
    nodeErr.hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
});

// ---- SSoT quick-capture dialog (Phase 4) --------------------------------
// Writes a markdown note into the registered SSoT vault + ingests it immediately
// (POST /api/capture) — a distinct, lighter flow from the node dialog above: this lands
// in the RAG corpus layer (documents/chunks), not the curated knowledge_nodes layer.
const captureDialog = $('capture-dialog');
const captureForm = $('capture-form');
const captureMsg = $('capture-msg');

$('capture-btn').onclick = () => {
  captureForm.reset();
  captureMsg.hidden = true;
  captureMsg.className = 'banner';
  captureDialog.showModal();
};
$('capture-cancel').onclick = () => captureDialog.close();

captureForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value !== 'save') return; // cancel closes normally
  e.preventDefault();
  const fd = new FormData(captureForm);
  const body = {
    title: String(fd.get('title') || '').trim() || undefined,
    body: String(fd.get('body') || ''),
    tags: String(fd.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  const saveBtn = $('capture-save');
  saveBtn.disabled = true;
  captureMsg.hidden = true;
  try {
    const r = await postJSON('/api/capture', body);
    captureMsg.className = 'banner ok';
    captureMsg.textContent = `已寫入 ${r.filename}（新增 ${r.ingest?.documents_created ?? 0} 份文件、${r.ingest?.chunks_created ?? 0} 個片段）`;
    captureMsg.hidden = false;
    captureForm.reset();
  } catch (err) {
    captureMsg.className = 'banner danger';
    captureMsg.textContent = '寫入失敗：' + err;
    captureMsg.hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
});

// ---- initial load ------------------------------------------------------
fetchAndRender();
fetchDraftEdges();
