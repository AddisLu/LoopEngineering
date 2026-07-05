(() => {
  'use strict';

  // ---- auth / token ----------------------------------------------------
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  // ---- tiny DOM helpers --------------------------------------------------
  // XSS contract: every dynamic value below is placed via el()/textContent, never as a
  // raw HTML string, so no server-sourced value is ever parsed as markup.
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
    actions.appendChild(btn('關聯', '', () => openRelationView(n.id)));
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

  // ---- relation view (lightweight SVG, one-hop neighbors, no physics) ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const relationPanel = $('relation-panel');
  const relationTitle = $('relation-title');
  const relationEmpty = $('relation-empty');
  const relationSvg = $('relation-svg');
  $('relation-close').onclick = () => { relationPanel.hidden = true; };

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  async function openRelationView(nodeId) {
    relationPanel.hidden = false;
    relationSvg.replaceChildren();
    relationEmpty.hidden = true;

    let g;
    try { g = await api('/api/knowledge/graph', 'GET'); }
    catch (e) {
      relationTitle.textContent = '';
      relationEmpty.hidden = false;
      relationEmpty.textContent = '載入關聯失敗：' + e;
      return;
    }
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const center = byId.get(nodeId);
    if (!center) {
      relationTitle.textContent = '';
      relationEmpty.hidden = false;
      relationEmpty.textContent = '此節點尚無關聯';
      return;
    }
    relationTitle.textContent = center.title;

    const neighbors = [];
    for (const e of edges) {
      if (e.src === nodeId && byId.has(e.dst)) neighbors.push({ node: byId.get(e.dst), relation: e.relation });
      else if (e.dst === nodeId && byId.has(e.src)) neighbors.push({ node: byId.get(e.src), relation: e.relation });
    }
    if (!neighbors.length) {
      relationEmpty.hidden = false;
      relationEmpty.textContent = '此節點尚無關聯';
      return;
    }

    // static circle layout — no physics/drag: neighbors spaced evenly around the center
    const W = 480, H = 480, cx = W / 2, cy = H / 2, r = 170;
    const n = neighbors.length;
    const positions = neighbors.map((nb, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      return { node: nb.node, relation: nb.relation, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });

    // lines + relation labels first, so node circles paint on top
    for (const p of positions) {
      relationSvg.appendChild(svgEl('line', { x1: cx, y1: cy, x2: p.x, y2: p.y, class: 'relation-line' }));
      const label = svgEl('text', {
        x: (cx + p.x) / 2, y: (cy + p.y) / 2 - 4, class: 'relation-label', 'text-anchor': 'middle',
      });
      label.textContent = p.relation;
      relationSvg.appendChild(label);
    }

    // center node
    const centerGroup = svgEl('g', { class: 'relation-node-group' });
    centerGroup.appendChild(svgEl('circle', { cx, cy, r: 30, class: `relation-node k-${center.kind}` }));
    const centerLabel = svgEl('text', { x: cx, y: cy + 46, class: 'relation-node-label', 'text-anchor': 'middle' });
    centerLabel.textContent = center.title;
    centerGroup.appendChild(centerLabel);
    relationSvg.appendChild(centerGroup);

    // neighbor nodes — click to recenter
    for (const p of positions) {
      const group = svgEl('g', { class: 'relation-node-group', role: 'button', tabindex: '0' });
      group.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 22, class: `relation-node k-${p.node.kind}` }));
      const label = svgEl('text', { x: p.x, y: p.y + 36, class: 'relation-node-label', 'text-anchor': 'middle' });
      label.textContent = p.node.title;
      group.appendChild(label);
      group.addEventListener('click', () => openRelationView(p.node.id));
      relationSvg.appendChild(group);
    }
  }

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
})();
