import {
  buildGraphState,
  mergeGraphState,
  stepForceClustered,
  categoryAnchors,
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

// ---- Chinese label maps (fixes the garbled English/src_ chips) -----------
// kind -> 中文 (curated-node kinds). Covers the 6 filter chips plus person/repo used elsewhere.
const KIND_ZH = {
  environment: '環境', constraint: '限制', preference: '偏好',
  project: '專案', tech: '技術', fact: '事實', person: '人物', repo: '儲存庫',
};
// curated-node provenance (knowledge_nodes.source) -> 中文
const NODE_SOURCE_ZH = { seed: '種子', distilled: 'AI 草稿', manual: '手動', mcp: 'MCP' };
// friendly overrides for a registered source's uri basename (else the basename is used as-is)
const SOURCE_BASENAME_ZH = { SSoT: 'SSoT 筆記', OpenProject_Exec_Report: 'OpenProject 報表' };

// id -> {kind, uri} for every registered ingest source, loaded once from /api/sources so the
// graph can show a human name for each src_xxx (survives a knowledge-base rebuild, which
// regenerates the ids: the name is derived from the still-stable uri, never hard-coded).
let sourceMeta = new Map();
async function loadSourceMeta() {
  try {
    const res = await api('/api/sources', 'GET');
    sourceMeta = new Map((res.sources || []).map((s) => [s.id, s]));
  } catch { /* leave empty — friendlySource() falls back to a short id */ }
}
/** Resolve a raw source token to a readable 中文/product name. Handles both curated-node
 * provenance (seed/distilled/manual) and ingest source ids (src_xxx -> uri basename). */
function friendlySource(id) {
  if (NODE_SOURCE_ZH[id]) return NODE_SOURCE_ZH[id];
  const s = sourceMeta.get(id);
  if (!s) return String(id).startsWith('src_') ? '來源 ' + String(id).slice(4, 10) : id;
  if (s.kind === 'openproject' || s.kind === 'github-issues') return 'OpenProject';
  const base = String(s.uri || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || id;
  return SOURCE_BASENAME_ZH[base] || base;
}

// ---- filter chips --------------------------------------------------------
const KIND_CHIPS = [
  ['all', '全部'], ['environment', '環境'], ['constraint', '限制'],
  ['preference', '偏好'], ['project', '專案'], ['tech', '技術'], ['fact', '事實'],
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
  actions.appendChild(btn('關聯', '', () => { closeDrawer(); openGraphView(n.id); }));
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
const graphStage = $('graph-stage');
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
const graphLegend = $('graph-legend');

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

// ---- G5 "Quiet Observatory" immersive tunables -------------------------
// Dark-immersive numbers, centralized so the look retunes without touching rendering logic.
// Category hue mirrors the four view=brain top-level buckets (see store.ts::categorizeDocument);
// saturation is pulled to 45-70% (not neon) so four categories separate on the dark field yet
// read as premium restraint. Sub-category varies lightness only (subLightnessOffset), never
// hue, so a category's members always read as one family of color.
const CATEGORY_HSL = {
  策展: { h: 217, s: 70, l: 64 },       // hero = the product's blue accent family
  程式碼: { h: 165, s: 45, l: 54 },     // teal
  OpenProject: { h: 34, s: 60, l: 58 }, // amber, deliberately the calmest surface (296 nodes)
  筆記: { h: 270, s: 45, l: 70 },       // violet
};
const CATEGORY_DEFAULT_HSL = { h: 220, s: 8, l: 60 };
// legend / KPI-strip order (top -> bottom)
const CATEGORY_ORDER = ['策展', '程式碼', 'OpenProject', '筆記'];

// Nebula rendering. The old pass drew fat bead-like nodes with source-over halos and nearly
// invisible edges, so the picture read as confetti: no structure, every vertex equally loud.
// This one inverts it the way a force-graph galaxy does — the EDGES carry the structure, drawn
// additively so overlapping filaments accumulate toward white, and nodes are small bright cores
// with an additive bloom whose size follows degree, so hubs burn and leaves stay quiet.
// Additive only ever touches the dark canvas (never the page), which is why it glows instead of
// turning to mud — the trap the earlier note warned about was additive on a light surface.
const GRAPH_VISUAL = Object.freeze({
  glowBlur: 5,       // kept for the selected-ring pass
  glowBlurHi: 15,
  edgeWidth: 0.9,    // hair-thin but visible; additive stacking does the rest
  edgeAlphaBase: 0.26,
  edgeAlphaHi: 0.75,
  edgeAlphaDim: 0.04,
  coreMin: 1.5,      // smallest node core in CSS px — a leaf is a pinpoint, not a bead
  coreMax: 5.4,      // hub core
  haloScale: 5.2,    // bloom radius = core * this
  haloAlpha: 0.5,    // bloom peak (additive)
  docCoreScale: 0.85,
  nodeAlphaDim: 0.14,
  curveAmount: 0.12, // fraction of edge length the bezier control point offsets by
  curveMax: 40,
  zoomFocusScale: 2.2,
  zoomAnimMs: 460,
  focusEase: 0.14,   // per-frame lerp of the global spotlight dim (0..1)
  wellAlpha: 0.14,   // click-lock gravity-well bloom peak alpha
  starCount: 70,
});

let graphFocus = 0; // eased 0..1 spotlight strength: 0 = full sky, 1 = one lineage lit
let starfield = null; // cached {w,h,dots:[{x,y,a}]} regenerated only on canvas resize
let soloCategory = null; // legend click-to-isolate: when set, only this top-category is shown

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
  return [...graphState.vertices.values()].filter(
    (v) => matchesFilter(v, filters) && (!soloCategory || v.category?.top === soloCategory),
  );
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

/** #rrggbb (the --k-* kind swatches) -> {h,s,l}, so per-kind colors flow through the same
 * hue-based canvas builders as category colors. Falls back to a neutral grey on a bad value. */
function hexToHSL(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim());
  if (!m) return { h: 220, s: 8, l: 60 };
  const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** {h,s,l} for a vertex — the single source of truth every canvas color builder derives from.
 * view=brain/brain-full vertices carry `category` and are colored by it (sub-category rides
 * lightness only, never hue); the node-centric 關聯 relation view keeps the per-kind swatch. */
function vertexHSL(v) {
  const top = v.category?.top;
  if (top) {
    const base = CATEGORY_HSL[top] ?? CATEGORY_DEFAULT_HSL;
    const l = Math.min(85, Math.max(28, base.l + subLightnessOffset(v.category.sub)));
    return { h: base.h, s: base.s, l };
  }
  const swatch = v.type === 'document' ? cssVar('--k-document', '#8892a0') : cssVar(`--k-${v.kind}`, cssVar('--k-fact', '#8892a0'));
  return hexToHSL(swatch);
}
/** Node fill; `dim` desaturates to a quiet grey-blue (not merely fades) for the spotlight. */
/** three.js's Color.setStyle only parses the comma form of hsl(), not the modern space form. */
function vertexColorCss(v) {
  const c = vertexHSL(v);
  return `hsl(${Math.round(c.h)}, ${Math.round(c.s)}%, ${Math.round(c.l)}%)`;
}
function vertexColor(v, dim = false) {
  const c = vertexHSL(v);
  return `hsl(${c.h} ${dim ? c.s * 0.25 : c.s}% ${c.l}%)`;
}
/** Edge endpoint stop: desaturated + fixed mid-lightness so a same-category edge is a near-
 * solid quiet line and a cross-category bridge a subtle two-tone — structure without rainbow. */
function edgeStop(v, a) { const c = vertexHSL(v); return `hsla(${c.h}, 52%, 52%, ${a})`; }
/** White-hot pinpoint core for structural hubs. */
function hubCore(v) { const c = vertexHSL(v); return `hsl(${c.h} 90% 96%)`; }
/** Additive bloom around a node: saturated hue, mid lightness — it is summed, not blended. */
function haloColor(v, a) { const c = vertexHSL(v); return `hsla(${c.h}, ${Math.min(95, c.s + 18)}%, 56%, ${a})`; }
/** Faint watermark ink for a category's zone title drawn out in the sky. */
function watermarkColor(top, a) { const c = CATEGORY_HSL[top] ?? CATEGORY_DEFAULT_HSL; return `hsla(${c.h}, 40%, 72%, ${a})`; }
/** Per-zone nebula glow center color. */
function nebulaColor(top, a) { const c = CATEGORY_HSL[top] ?? CATEGORY_DEFAULT_HSL; return `hsla(${c.h}, 45%, 45%, ${a})`; }
/** Gravity-well bloom color under a click-locked node. */
function wellColor(v, a) { const c = vertexHSL(v); return `hsla(${c.h}, 55%, 50%, ${a})`; }

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

/** Seeds a deterministic starfield sized to the canvas — recomputed only when the CSS size
 * changes, never per frame. Static and faint: the void isn't dead flat, but nothing twinkles
 * or blends additively. */
function ensureStarfield(cssW, cssH) {
  if (starfield && starfield.w === cssW && starfield.h === cssH) return starfield;
  let seed = (0x9e3779b1 ^ (Math.round(cssW) * 73856093) ^ (Math.round(cssH) * 19349663)) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const dots = [];
  for (let i = 0; i < GRAPH_VISUAL.starCount; i++) dots.push({ x: rnd() * cssW, y: rnd() * cssH, a: 0.04 + rnd() * 0.04 });
  starfield = { w: cssW, h: cssH, dots };
  return starfield;
}

/** Dark immersive "night sky": warm charcoal base, a center-biased vignette, one faint nebula
 * per category glowing at its ring zone, and a sparse static starfield. Independent of the
 * page's light/dark theme; strictly source-over (additive blending is the neon/mud trap). */
function drawBackground(cssW, cssH) {
  gctx.fillStyle = cssVar('--graph-bg-1', '#080b10');
  gctx.fillRect(0, 0, cssW, cssH);

  const r = Math.max(cssW, cssH) * 0.85;
  const grad = gctx.createRadialGradient(cssW / 2, cssH * 0.4, 0, cssW / 2, cssH * 0.4, r);
  grad.addColorStop(0, 'hsl(220 26% 11%)');
  grad.addColorStop(0.6, 'hsl(222 30% 6%)');
  grad.addColorStop(1, 'hsl(224 42% 3%)');
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, cssW, cssH);

  // one faint nebula per category, centered on its ring anchor projected to the screen
  if (graphState) {
    const nr = Math.max(cssW, cssH) * 0.42 * Math.min(1.6, Math.max(0.4, graphView.scale));
    for (const [top, a] of categoryAnchors(graphState)) {
      const p = worldToScreen(graphView, a.x, a.y, cssW, cssH);
      const ng = gctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, nr);
      ng.addColorStop(0, nebulaColor(top, 0.05));
      ng.addColorStop(1, nebulaColor(top, 0));
      gctx.fillStyle = ng;
      gctx.fillRect(0, 0, cssW, cssH);
    }
  }

  const sf = ensureStarfield(cssW, cssH);
  for (const d of sf.dots) {
    gctx.fillStyle = `rgba(233, 228, 218, ${d.a})`;
    gctx.fillRect(d.x, d.y, 1, 1);
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
const isHub = (v) => (v.degree ?? 0) >= 6;

function drawGraph() {
  const { cssW, cssH, dpr } = resizeGraphCanvas();
  gctx.save();
  gctx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
  gctx.scale(dpr, dpr); // world<->screen math below stays in CSS-pixel units regardless of DPR

  drawBackground(cssW, cssH);

  const vertices = visibleGraphVertices();
  const visibleIds = new Set(vertices.map((v) => v.id));
  const textColor = cssVar('--graph-text', '#e9e4da');
  // hover wins over the (rarer) click-focus lock when both are set — it's the more immediate
  // signal of what the user is looking at right now.
  const highlightId = hoveredVertexId ?? graphFocusId;
  const highlight = highlightId ? neighborIds(graphState, highlightId) : null;
  const focus = highlight ? graphFocus : 0; // eased 0..1 planetarium "lights-down" strength
  const zoom = Math.sqrt(graphView.scale);

  // ---- gravity-well bloom under a click-locked node (grafted from the Atlas direction) ----
  if (graphFocusId && focus > 0.01) {
    const fv = graphState?.vertices.get(graphFocusId);
    if (fv && visibleIds.has(graphFocusId)) {
      const p = worldToScreen(graphView, fv.x, fv.y, cssW, cssH);
      const wr = 180 * Math.min(1.5, Math.max(0.5, zoom)) * focus;
      const wg = gctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, wr);
      wg.addColorStop(0, wellColor(fv, GRAPH_VISUAL.wellAlpha * focus));
      wg.addColorStop(1, wellColor(fv, 0));
      gctx.fillStyle = wg;
      gctx.fillRect(0, 0, cssW, cssH);
    }
  }

  // ---- edges: the structure. Additive so crossing filaments brighten each other. ----
  gctx.globalCompositeOperation = 'lighter';
  for (const e of graphState ? graphState.edges : []) {
    if (!visibleIds.has(e.src) || !visibleIds.has(e.dst)) continue;
    const a = graphState.vertices.get(e.src);
    const b = graphState.vertices.get(e.dst);
    const pa = worldToScreen(graphView, a.x, a.y, cssW, cssH);
    const pb = worldToScreen(graphView, b.x, b.y, cssW, cssH);
    const related = highlight && (e.src === highlightId || e.dst === highlightId);
    const alpha = related
      ? lerp(GRAPH_VISUAL.edgeAlphaBase, GRAPH_VISUAL.edgeAlphaHi, focus)
      : lerp(GRAPH_VISUAL.edgeAlphaBase, GRAPH_VISUAL.edgeAlphaDim, focus);
    gctx.lineWidth = GRAPH_VISUAL.edgeWidth * Math.min(1.7, zoom) + (related ? 0.15 * focus : 0);
    const grad = gctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    grad.addColorStop(0, edgeStop(a, alpha));
    grad.addColorStop(1, edgeStop(b, alpha));
    gctx.strokeStyle = grad;
    // gentle quadratic bow (Obsidian-style): offset the control point perpendicular, capped.
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(len * GRAPH_VISUAL.curveAmount, GRAPH_VISUAL.curveMax);
    gctx.beginPath();
    gctx.moveTo(pa.x, pa.y);
    gctx.quadraticCurveTo((pa.x + pb.x) / 2 + (-dy / len) * bow, (pa.y + pb.y) / 2 + (dx / len) * bow, pb.x, pb.y);
    gctx.stroke();
  }
  gctx.globalCompositeOperation = 'source-over';
  gctx.globalAlpha = 1;

  // ---- zone-title watermarks: the four 中文 category names living in the sky ----
  if (graphState && graphView.scale >= 0.6 && graphView.scale <= 2.4) {
    gctx.textAlign = 'center';
    gctx.textBaseline = 'middle';
    gctx.font = '600 30px "PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif';
    for (const [top, a] of categoryAnchors(graphState)) {
      const p = worldToScreen(graphView, a.x, a.y, cssW, cssH);
      gctx.fillStyle = watermarkColor(top, 0.12 * (1 - 0.6 * focus));
      gctx.fillText(top, p.x, p.y);
    }
  }

  // ---- nodes: bloom first (additive, all of them), then the cores on top ----
  const coreRadius = (v) => {
    const deg = Math.max(0, v.degree ?? 0);
    const base = GRAPH_VISUAL.coreMin + (GRAPH_VISUAL.coreMax - GRAPH_VISUAL.coreMin) * Math.min(1, Math.sqrt(deg) / 4);
    return base * (v.type === 'document' ? GRAPH_VISUAL.docCoreScale : 1) * Math.min(2.2, Math.max(0.7, zoom));
  };

  gctx.globalCompositeOperation = 'lighter';
  for (const v of vertices) {
    const dimmed = highlight && !highlight.has(v.id);
    const strength = dimmed ? lerp(1, 0.12, focus) : 1;
    if (strength < 0.03) continue;
    const p = worldToScreen(graphView, v.x, v.y, cssW, cssH);
    const r = coreRadius(v);
    const selected = v.id === graphCenterId || v.id === graphFocusId || v.id === hoveredVertexId;
    const hubBloom = 1 + Math.min(0.8, Math.sqrt(Math.max(0, v.degree ?? 0)) / 6);
    const halo = r * GRAPH_VISUAL.haloScale * hubBloom * (selected ? 1.7 : 1);
    const g = gctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
    g.addColorStop(0, haloColor(v, GRAPH_VISUAL.haloAlpha * strength * (selected ? 1.5 : 1)));
    g.addColorStop(0.45, haloColor(v, GRAPH_VISUAL.haloAlpha * 0.28 * strength));
    g.addColorStop(1, haloColor(v, 0));
    gctx.fillStyle = g;
    gctx.fillRect(p.x - halo, p.y - halo, halo * 2, halo * 2);
  }
  gctx.globalCompositeOperation = 'source-over';

  gctx.textAlign = 'center';
  gctx.textBaseline = 'top';
  for (const v of vertices) {
    const p = worldToScreen(graphView, v.x, v.y, cssW, cssH);
    const r = coreRadius(v);
    const selected = v.id === graphCenterId || v.id === graphFocusId || v.id === hoveredVertexId;
    const dimmed = highlight && !highlight.has(v.id);
    const hub = isHub(v);
    const doc = v.type === 'document';

    gctx.globalAlpha = dimmed ? lerp(1, GRAPH_VISUAL.nodeAlphaDim, focus) : 1;
    const color = vertexColor(v, dimmed && focus > 0.5);
    const shape = () => { gctx.beginPath(); doc ? gctx.rect(p.x - r, p.y - r, r * 2, r * 2) : gctx.arc(p.x, p.y, r, 0, Math.PI * 2); };

    gctx.fillStyle = color;
    shape();
    gctx.fill();
    // a white-hot pinpoint in the middle of anything that matters: hubs, hovered, focused
    if (!dimmed && (hub || selected)) {
      gctx.fillStyle = hubCore(v);
      gctx.beginPath();
      gctx.arc(p.x, p.y, Math.max(0.9, r * 0.42), 0, Math.PI * 2);
      gctx.fill();
    }

    if (selected) {
      gctx.lineWidth = 1.2;
      gctx.strokeStyle = textColor;
      gctx.beginPath();
      gctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2);
      gctx.stroke();
    }

    // labels: LoD-gated; during a spotlight only the lit lineage is labeled; doc labels only
    // when hovered/focused (keeps 503 squares from becoming a mush of text).
    const lit = v.id === hoveredVertexId || v.id === graphFocusId;
    const labelOK = shouldShowLabel(v, { scale: graphView.scale, hoveredId: hoveredVertexId, focusId: graphFocusId });
    const suppressed = focus > 0.05 && highlight && !highlight.has(v.id);
    if (labelOK && !suppressed && (!doc || lit)) {
      gctx.globalAlpha = 1;
      gctx.font = `${hub ? 12 : 11}px "PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif`;
      const text = String(v.label ?? '').slice(0, 22);
      const ty = p.y + r + 4;
      gctx.lineWidth = 3;
      gctx.strokeStyle = 'hsla(222, 30%, 5%, 0.85)'; // halo so a label survives crossing an edge
      gctx.strokeText(text, p.x, ty);
      gctx.fillStyle = textColor;
      gctx.fillText(text, p.x, ty);
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
  // ease the spotlight dim in/out so the sky fades like a planetarium instead of snapping
  const focusTarget = (hoveredVertexId ?? graphFocusId) ? 1 : 0;
  graphFocus += (focusTarget - graphFocus) * GRAPH_VISUAL.focusEase;
  drawGraph();
  graphRaf = requestAnimationFrame(graphLoop);
}
// ---- 立體 (WebGL) mode ---------------------------------------------------------------
// The 2D canvas stays the default and keeps every behaviour it had; 3D is a second renderer
// fed from the same graphState, the same filters and the same hover/focus ids. brain3d.js is
// imported lazily so nobody downloads three.js (670 KB) unless they ask for the view.
let galaxy3d = null;
let mode3d = false;

function labelFor3D(v) {
  const lit = v.id === hoveredVertexId || v.id === graphFocusId;
  if (lit) return String(v.label ?? '').slice(0, 26);
  if (hoveredVertexId || graphFocusId) return '';
  // no selection: the same LoD rule the 2D view uses, so the sky is not a wall of text
  return shouldShowLabel(v, { scale: 1.2, hoveredId: null, focusId: null }) && v.type !== 'document'
    ? String(v.label ?? '').slice(0, 22)
    : '';
}

async function enter3D() {
  const canvas = $('graph-canvas-3d');
  const labels = $('graph-labels-3d');
  // show the canvas BEFORE asking for a WebGL context: a display:none canvas has no backing
  // surface, and some software renderers refuse to create a context for one
  $('graph-canvas').hidden = true;
  canvas.hidden = false;
  labels.hidden = false;
  if (!galaxy3d) {
    const mod = await import('./brain3d.js');
    galaxy3d = mod.createGalaxy3D({
      canvas,
      labelLayer: labels,
      background: cssVar('--graph-bg-1', '#070a0f'),
      getState: () => graphState,
      visible: () => visibleGraphVertices(),
      colorOf: (v) => vertexColorCss(v),
      labelFor: labelFor3D,
      onHover: (id, evt) => {
        const v = id ? graphState?.vertices.get(id) : null;
        canvas.style.cursor = v ? 'pointer' : 'grab';
        if (hoveredVertexId !== id) {
          hoveredVertexId = id;
          galaxy3d.setHighlight(id, id ? neighborIds(graphState, id) : null);
        }
        updateTooltip(v ?? null, evt);
      },
      onPick: (id) => {
        const v = id ? graphState?.vertices.get(id) : null;
        graphFocusId = id ?? null;
        galaxy3d.setHighlight(id, id ? neighborIds(graphState, id) : null);
        galaxy3d.focus(id);
        if (v) expandVertex(v);
      },
      onRebuildNeeded: () => galaxy3d?.rebuild(),
    });
  }
  stopGraphLoop();
  galaxy3d.start();
  mode3d = true;
  $('graph-3d').setAttribute('aria-pressed', 'true');
  $('graph-3d').textContent = '平面';
  try {
    localStorage.setItem('loop_graph_3d', '1');
  } catch (e) { /* private mode */ }
}

function exit3D() {
  if (galaxy3d) galaxy3d.stop();
  $('graph-canvas-3d').hidden = true;
  $('graph-labels-3d').hidden = true;
  $('graph-canvas').hidden = false;
  mode3d = false;
  $('graph-3d').setAttribute('aria-pressed', 'false');
  $('graph-3d').textContent = '立體';
  try {
    localStorage.removeItem('loop_graph_3d');
  } catch (e) { /* private mode */ }
  stopGraphLoop();
  graphLoop();
}

$('graph-3d').onclick = () => {
  if (mode3d) exit3D();
  else {
    void enter3D().catch((err) => {
      graphEmpty.hidden = false;
      graphEmpty.textContent = `立體檢視載入失敗：${err.message}`;
      exit3D();
    });
  }
};

function stopGraphLoop() {
  if (graphRaf) cancelAnimationFrame(graphRaf);
  graphRaf = null;
}

function populateGraphFilterChips() {
  // kind chips — 中文 label (KIND_ZH), raw kind kept as the filter value/dataset
  graphKindChips.replaceChildren();
  for (const kind of ALL_KINDS) {
    const chip = el('button', 'chip-btn', KIND_ZH[kind] ?? kind);
    chip.type = 'button';
    chip.dataset.value = kind;
    chip.title = kind;
    chip.classList.toggle('active', selectedGraphKinds.has(kind));
    chip.onclick = () => {
      if (selectedGraphKinds.has(kind)) selectedGraphKinds.delete(kind);
      else selectedGraphKinds.add(kind);
      chip.classList.toggle('active', selectedGraphKinds.has(kind));
    };
    graphKindChips.appendChild(chip);
  }

  // source chips — friendly 中文/product name (friendlySource), never the raw src_xxx id
  const sources = new Set();
  for (const v of graphState ? graphState.vertices.values() : []) {
    if (v.type === 'node' && v.raw.source) sources.add(v.raw.source);
    if (v.type === 'document' && v.raw.source_id) sources.add(v.raw.source_id);
  }
  graphSourceChips.replaceChildren();
  for (const s of [...sources].sort((a, b) => friendlySource(a).localeCompare(friendlySource(b), 'zh-Hant'))) {
    const chip = el('button', 'chip-btn', friendlySource(s));
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

  renderLegend();
}

/** The 中文 category legend / KPI strip in the left dock: a color key (fixes the demand for a
 * readable category map that raw ids never gave) with live per-category counts, plus click-
 * to-isolate (solo one category; click again to release). Counts are totals from the whole
 * graph so the strip reads as a stable KPI, not a filtered subset. */
function renderLegend() {
  if (!graphLegend) return;
  graphLegend.replaceChildren();
  const counts = new Map();
  for (const v of graphState ? graphState.vertices.values() : []) {
    const top = v.category?.top;
    if (top) counts.set(top, (counts.get(top) || 0) + 1);
  }
  // the node-centered 關聯 view has no categories (nodes are colored per-kind there) — showing
  // four "0" rows would be misleading, so drop the category key and keep only the shape key.
  const categorized = counts.size > 0;
  for (const top of categorized ? CATEGORY_ORDER : []) {
    const c = CATEGORY_HSL[top] ?? CATEGORY_DEFAULT_HSL;
    const col = `hsl(${c.h} ${c.s}% ${c.l}%)`;
    const row = el('div', 'glegend-item');
    if (soloCategory === top) row.classList.add('active');
    else if (soloCategory) row.classList.add('dimmed');
    const sw = el('span', 'glegend-swatch');
    sw.style.background = col;
    sw.style.boxShadow = `0 0 9px ${col}`;
    row.appendChild(sw);
    row.appendChild(el('span', 'glegend-label', top));
    row.appendChild(el('span', 'glegend-count', String(counts.get(top) || 0)));
    row.title = soloCategory === top ? '顯示全部' : `只看「${top}」`;
    row.onclick = () => toggleSoloCategory(top);
    graphLegend.appendChild(row);
  }
  // shape-encoding key
  const key = el('div', 'glegend-key');
  const mk = (sq, label) => {
    const k = el('span', 'k');
    k.appendChild(el('span', 'kd' + (sq ? ' sq' : '')));
    k.appendChild(el('span', '', label));
    return k;
  };
  key.appendChild(mk(false, '節點'));
  key.appendChild(mk(true, '文件'));
  graphLegend.appendChild(key);
}

function toggleSoloCategory(top) {
  // no-op unless some visible vertex actually carries this category — otherwise soloing would
  // blank the canvas (e.g. the node-centered 關聯 view has no categories at all).
  if (soloCategory !== top && !(graphState && [...graphState.vertices.values()].some((v) => v.category?.top === top))) return;
  soloCategory = soloCategory === top ? null : top;
  renderLegend();
  if (graphState) { reheat(graphState); fitGraphView(); }
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
  graphEmpty.hidden = true;
  // reset every per-view filter so a chip/legend/solo selected in one view can't persist as
  // an invisible active filter into the next (which could blank the graph with no chip to clear).
  soloCategory = null;
  selectedGraphKinds = new Set(ALL_KINDS);
  selectedGraphSources = new Set();
  graphCenterId = nodeId ?? null;
  graphFocusId = null;
  hoveredVertexId = null;
  viewAnim = null;
  graphView = { offsetX: 0, offsetY: 0, scale: 1 };
  graphViewMode = nodeId ? 'default' : 'brain';

  let g;
  try {
    g = await fetchGraph(nodeId, nodeId ? Number(graphDepthInput.value || 2) : undefined, nodeId ? undefined : 'brain');
  } catch (e) {
    graphState = null;
    graphTitle.textContent = '';
    graphEmpty.hidden = false;
    graphEmpty.textContent = '載入圖譜失敗：' + e;
    return;
  }

  graphState = buildGraphState(g);
  computeDegrees(graphState);
  reheat(graphState);
  populateGraphFilterChips();
  if (mode3d) galaxy3d?.rebuild();

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
  // The force layout keeps spreading for a few seconds after open; re-frame the whole
  // graph a few times so a large view=brain graph (which settles taller than the canvas)
  // ends fully in view instead of clipped off the top/bottom. See fitGraphView.
  for (const ms of [250, 1500, 3500, 6000, 9000]) setTimeout(() => { if (graphState) fitGraphView(); }, ms);
}

/** Frame every current vertex into the canvas with padding (pan + zoom together). Called
 * right after a graph opens (the layout is still settling then) and by the 重置視圖 button,
 * so a 500+ vertex brain graph is actually visible instead of scattered off-canvas. */
function fitGraphView() {
  if (!graphState || graphState.vertices.size === 0) return;
  const { cssW, cssH } = resizeGraphCanvas();
  const vs = visibleGraphVertices();
  if (!vs.length) return;
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const v of vs) {
    if (v.x < minx) minx = v.x;
    if (v.x > maxx) maxx = v.x;
    if (v.y < miny) miny = v.y;
    if (v.y > maxy) maxy = v.y;
  }
  const w = (maxx - minx) || 1;
  const h = (maxy - miny) || 1;
  const s = Math.max(0.15, Math.min(Math.min(cssW / w, cssH / h) * 0.82, 2));
  graphView = { scale: s, offsetX: -((minx + maxx) / 2) * s, offsetY: -((miny + maxy) / 2) * s };
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

$('graph-reset').onclick = () => {
  viewAnim = null;
  graphFocusId = null;
  soloCategory = null;
  renderLegend();
  if (mode3d) {
    hoveredVertexId = null;
    galaxy3d?.setHighlight(null, null);
    galaxy3d?.focus(null);
    return;
  }
  fitGraphView();
};
$('graph-zoom-in').onclick = () => { graphView.scale = Math.min(graphView.scale * 1.25, 4); };
$('graph-zoom-out').onclick = () => { graphView.scale = Math.max(graphView.scale / 1.25, 0.15); };
graphDepthInput.addEventListener('change', () => {
  if (graphCenterId) openGraphView(graphCenterId);
});

// ---- management drawer (☰ 清單): curated-node list over the immersive graph ----
const manageDrawer = $('manage-drawer');
const drawerScrim = $('drawer-scrim');
function openDrawer() {
  manageDrawer.hidden = false;
  drawerScrim.hidden = false;
  fetchAndRender();
  fetchDraftEdges();
}
function closeDrawer() { manageDrawer.hidden = true; drawerScrim.hidden = true; }
$('manage-toggle').onclick = openDrawer;
$('manage-close').onclick = closeDrawer;
drawerScrim.onclick = closeDrawer;

// ---- left dock collapse ----
const gdock = $('gdock');
$('dock-collapse').onclick = () => {
  const collapsed = gdock.classList.toggle('collapsed');
  $('dock-collapse').textContent = collapsed ? '›' : '‹';
};

// ---- idle-fade chrome: instruments recede when you're just watching the sky ----
let chromeIdleTimer = null;
function wakeChrome() {
  graphStage.classList.remove('chrome-idle');
  clearTimeout(chromeIdleTimer);
  chromeIdleTimer = setTimeout(() => graphStage.classList.add('chrome-idle'), 2500);
}
for (const ev of ['mousemove', 'keydown', 'focusin', 'wheel', 'mousedown']) {
  window.addEventListener(ev, wakeChrome, { passive: true });
}
wakeChrome();

// ---- keyboard: 1-4 isolate a category, Esc clears focus/solo, / opens the list search ----
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  // a modal dialog (add/edit node, capture) owns its own keys — never solo/clear behind it
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (!manageDrawer.hidden) closeDrawer();
    else { graphFocusId = null; soloCategory = null; renderLegend(); }
  } else if (e.key >= '1' && e.key <= '4') {
    toggleSoloCategory(CATEGORY_ORDER[Number(e.key) - 1]);
  }
});

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
    if (!dragMoved) focusVertex(dragTarget);
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
  // meta line: type/category + a readable source name (never a raw src_ id)
  const bits = [];
  if (vertex.type === 'document') {
    bits.push('文件');
    if (vertex.raw?.source_id) bits.push(friendlySource(vertex.raw.source_id));
  } else {
    bits.push(vertex.category?.sub ?? KIND_ZH[vertex.kind] ?? vertex.kind ?? '節點');
    if (vertex.raw?.source) bits.push(friendlySource(vertex.raw.source));
  }
  const meta = bits.filter(Boolean).join(' · ');
  if (meta) graphTooltip.appendChild(el('div', 'graph-tooltip-meta', meta));
  graphTooltip.hidden = false;
  // position:fixed → viewport coords; flip left of the cursor near the right edge
  const flip = evt.clientX + 260 > window.innerWidth;
  graphTooltip.style.left = `${flip ? evt.clientX - 254 : evt.clientX + 14}px`;
  graphTooltip.style.top = `${Math.min(evt.clientY + 14, window.innerHeight - 70)}px`;
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
// Graph-first: the immersive whole-graph view opens immediately (the page IS the graph);
// the curated list is fetched lazily when the ☰ 清單 drawer is first opened. Source metadata
// is loaded up front so source chips/tooltips show friendly names from the very first paint.
(async () => {
  await loadSourceMeta();
  await openGraphView(null);
  // whoever left in 立體 comes back to it — three.js is still only fetched in that case
  let want3d = false;
  try {
    want3d = localStorage.getItem('loop_graph_3d') === '1';
  } catch (e) { /* private mode */ }
  if (want3d) await enter3D().catch(() => exit3D());
})();
