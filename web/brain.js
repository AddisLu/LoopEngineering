import {
  buildGraphState,
  mergeGraphState,
  stepForce,
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
  }
  actions.appendChild(btn('關聯', '', () => openGraphView(n.id)));
  actions.appendChild(btn('編輯', '', () => openNodeDialog(n)));
  actions.appendChild(btn('刪除', 'danger-ghost', () => delNode(n.id, n.title)));
  row.appendChild(actions);

  return row;
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

// ---- force-directed knowledge graph (SSoT Phase 3) ----------------------
// Hand-rolled canvas 2D: pan/zoom/drag/click-to-expand + kind/tag/scope/source filters,
// documents rendered as a distinct (square) node type. No CDN/library — see
// web/graph-layout.js for the DOM-free state/physics/filter logic this wires up.
const graphPanel = $('graph-panel');
const graphTitle = $('graph-title');
const graphEmpty = $('graph-empty');
const graphCanvas = $('graph-canvas');
const gctx = graphCanvas.getContext('2d');
const graphDepthInput = $('graph-depth');
const graphTagFilter = $('graph-tag-filter');
const graphScopeFilter = $('graph-scope-filter');
const graphShowDocuments = $('graph-show-documents');
const graphKindChips = $('graph-kind-chips');
const graphSourceChips = $('graph-source-chips');

let graphState = null; // { vertices: Map<id, Vertex>, edges: Edge[] } — see graph-layout.js
let graphView = { offsetX: 0, offsetY: 0, scale: 1 };
let graphRaf = null;
let graphCenterId = null; // null = whole-graph mode

const ALL_KINDS = KIND_CHIPS.slice(1).map(([v]) => v);
let selectedGraphKinds = new Set(ALL_KINDS); // opt-out: all kinds shown by default
let selectedGraphSources = new Set(); // opt-in: empty = no source filter applied

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
  return [...graphState.vertices.values()].filter((v) => matchesFilter(v, filters));
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function vertexColor(v) {
  return v.type === 'document' ? cssVar('--k-document', '#888') : cssVar(`--k-${v.kind}`, cssVar('--k-fact', '#888'));
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

function drawGraph() {
  const { cssW, cssH, dpr } = resizeGraphCanvas();
  gctx.save();
  gctx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
  gctx.scale(dpr, dpr); // world<->screen math below stays in CSS-pixel units regardless of DPR

  const vertices = visibleGraphVertices();
  const visibleIds = new Set(vertices.map((v) => v.id));
  const borderColor = cssVar('--border-2', '#999');
  const textColor = cssVar('--text-2', '#333');

  gctx.strokeStyle = borderColor;
  gctx.lineWidth = 1;
  for (const e of graphState ? graphState.edges : []) {
    if (!visibleIds.has(e.src) || !visibleIds.has(e.dst)) continue;
    const a = graphState.vertices.get(e.src);
    const b = graphState.vertices.get(e.dst);
    const pa = worldToScreen(graphView, a.x, a.y, cssW, cssH);
    const pb = worldToScreen(graphView, b.x, b.y, cssW, cssH);
    gctx.beginPath();
    gctx.moveTo(pa.x, pa.y);
    gctx.lineTo(pb.x, pb.y);
    gctx.stroke();
  }

  gctx.textAlign = 'center';
  gctx.textBaseline = 'top';
  gctx.font = '11px system-ui, sans-serif';
  for (const v of vertices) {
    const p = worldToScreen(graphView, v.x, v.y, cssW, cssH);
    const r = vertexRadius(v) * Math.sqrt(graphView.scale);
    gctx.fillStyle = vertexColor(v);
    gctx.beginPath();
    if (v.type === 'document') gctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    else gctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    gctx.fill();
    if (v.id === graphCenterId) {
      gctx.lineWidth = 2;
      gctx.strokeStyle = textColor;
      gctx.stroke();
    }
    gctx.fillStyle = textColor;
    gctx.fillText(String(v.label ?? '').slice(0, 22), p.x, p.y + r + 3);
  }
  gctx.restore();
}

function graphLoop() {
  if (graphState) stepForce(graphState);
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

async function fetchGraph(nodeId, depth) {
  const qs = new URLSearchParams();
  if (nodeId) qs.set('nodeId', nodeId);
  if (depth) qs.set('depth', String(depth));
  return api('/api/knowledge/graph' + (qs.toString() ? '?' + qs.toString() : ''), 'GET');
}

/** Opens the graph panel: `nodeId` centers a depth-hop BFS neighborhood (see the
 * `關聯` button and click-to-expand below); omit it for the whole curated graph. */
async function openGraphView(nodeId) {
  graphPanel.hidden = false;
  graphEmpty.hidden = true;
  graphCenterId = nodeId ?? null;
  graphView = { offsetX: 0, offsetY: 0, scale: 1 };

  let g;
  try {
    g = await fetchGraph(nodeId, nodeId ? Number(graphDepthInput.value || 2) : undefined);
  } catch (e) {
    graphState = null;
    graphTitle.textContent = '';
    graphEmpty.hidden = false;
    graphEmpty.textContent = '載入圖譜失敗：' + e;
    return;
  }

  graphState = buildGraphState(g);
  populateGraphFilterChips();

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
 * into the live graph (new vertices seeded near it, existing layout undisturbed). */
async function expandVertex(vertex) {
  let g;
  try {
    g = await fetchGraph(vertex.id, 1);
  } catch (e) {
    alert('展開失敗: ' + e);
    return;
  }
  mergeGraphState(graphState, g, vertex.id);
  populateGraphFilterChips();
  graphEmpty.hidden = true;
}

$('graph-close').onclick = () => { graphPanel.hidden = true; stopGraphLoop(); };
$('graph-btn').onclick = () => openGraphView(null);
$('graph-reset').onclick = () => { graphView = { offsetX: 0, offsetY: 0, scale: 1 }; };
$('graph-zoom-in').onclick = () => { graphView.scale = Math.min(graphView.scale * 1.25, 4); };
$('graph-zoom-out').onclick = () => { graphView.scale = Math.max(graphView.scale / 1.25, 0.15); };
graphDepthInput.addEventListener('change', () => {
  if (graphCenterId) openGraphView(graphCenterId);
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
    if (!dragMoved) expandVertex(dragTarget);
  }
  dragTarget = null;
  panStart = null;
});
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

// ---- initial load ------------------------------------------------------
fetchAndRender();
