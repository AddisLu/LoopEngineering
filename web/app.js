(() => {
  'use strict';

  // ---- auth / token ----------------------------------------------------
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const RING_C = 2 * Math.PI * 18; // ring circumference (r=18)

  const COLUMNS = [
    ['Draft · 入場審核', ['draft']],
    ['Ready', ['ready']],
    ['Queued', ['queued', 'blocked']],
    ['Running', ['running']],
    ['Verifying', ['verifying']],
    ['Review · 結案', ['review', 'failed']],
    ['Closed', ['closed']],
  ];

  // ---- tiny DOM helpers ------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  // Kept for the security contract; rendering uses textContent throughout so
  // no untrusted value ever reaches innerHTML.
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Duration formatter: 45m, 1h 20m — reads better than raw "125m".
  const fmtDur = (min) => {
    if (min == null || isNaN(min)) return '–';
    const m = Math.max(0, Math.round(Number(min)));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };

  async function api(path, method = 'POST') {
    const r = await fetch(path, { method, headers: authHeaders });
    return r.ok ? r.json().catch(() => ({})) : Promise.reject(await r.text().catch(() => r.statusText));
  }
  async function act(path) {
    try { await api(path); }
    catch (e) { alert('操作失敗: ' + e); }
  }

  // ---- theme -----------------------------------------------------------
  const themeBtn = $('theme-btn');
  function currentMode() {
    return document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light';
  }
  function paintThemeBtn() {
    // show the glyph of the mode you'd switch TO
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

  // ---- usage / topbar --------------------------------------------------
  function usageState(pct) {
    return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
  }
  function setRing(id, pctId, pct) {
    const wrap = $(id);
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const fill = wrap.querySelector('.fill');
    fill.style.strokeDasharray = `${(p / 100) * RING_C} ${RING_C}`;
    wrap.setAttribute('data-state', usageState(p));
    $(pctId).textContent = `${Math.round(pct)}%`;
  }

  function renderTop(s) {
    setRing('ring-session', 'session-pct', s.usage.session);
    setRing('ring-weekly', 'weekly-pct', s.usage.weekly);

    $('resets').querySelector('.tick-v').textContent = fmtDur(s.usage.sessionResetsInMin);
    $('policy').querySelector('.tick-v').textContent =
      `${s.policy.window === 'night' ? '夜間' : '日間'} · ${s.policy.sessionMax}%`;

    const state = $('sched-state');
    state.classList.toggle('paused', !!s.paused);
    state.querySelector('.s-text').textContent = s.paused ? '已暫停' : '排程執行中';
    $('pause-btn').textContent = s.paused ? '恢復排程' : '暫停排程';
  }

  // ---- card rendering --------------------------------------------------
  const GATE_ITEMS = [
    ['goal', (m) => !m.some((x) => x.startsWith('goal'))],
    ['plan', (m) => !m.some((x) => x.startsWith('plan_ref'))],
    ['tool', (m) => !m.some((x) => x.startsWith('coding_tool'))],
    ['verify', (m) => !m.some((x) => x.startsWith('verification'))],
    ['repo', (m) => !m.some((x) => x.startsWith('repo') || x.startsWith('base_branch'))],
  ];

  function buildCard(card, c) {
    card.className = `card s-${c.status}` +
      (c.status === 'draft' && !c.gate.ok ? ' gate-bad' : '') +
      (c.status === 'running' || c.status === 'verifying' ? ' is-working' : '');

    // head: title + status dot
    const head = el('div', 'card-head');
    head.appendChild(el('div', 'title', c.title));
    head.appendChild(el('span', 'status-dot'));
    card.appendChild(head);

    // goal subtitle — quiet extra context, only when it adds something
    if (c.goal && c.goal !== c.title) card.appendChild(el('div', 'goal', c.goal));

    // meta chips
    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'chip cx', c.complexity));
    meta.appendChild(el('span', 'chip mono', `P${c.priority}`));
    meta.appendChild(el('span', 'chip tool', c.model || c.coding_tool));
    if (c.status === 'queued') meta.appendChild(el('span', 'chip mono', `~${c.est_pct}%`));
    if (c.elapsedMin != null) meta.appendChild(el('span', 'chip mono', fmtDur(c.elapsedMin)));
    if (c.status === 'running' || c.status === 'verifying') {
      const w = el('span', 'chip working');
      w.appendChild(el('span', 'spin'));
      w.appendChild(el('span', null, c.status === 'verifying' ? 'verifying…' : 'working…'));
      meta.appendChild(w);
    }
    card.appendChild(meta);

    // draft gate checklist
    if (c.status === 'draft') {
      const missing = Array.isArray(c.gate.missing) ? c.gate.missing : [];
      const chk = el('div', 'check');
      for (const [label, okFn] of GATE_ITEMS) {
        chk.appendChild(el('span', okFn(missing) ? 'ok' : 'no', label));
      }
      card.appendChild(chk);
      if (!c.gate.ok) card.appendChild(el('div', 'banner danger', '缺項，無法入列'));
    }

    // status banners
    if (c.status === 'blocked') card.appendChild(el('div', 'banner info', '⏸ blocked · 可自動 resume'));
    if (c.status === 'failed') card.appendChild(el('div', 'banner danger', 'verify/執行失敗'));
    if (c.status === 'review') card.appendChild(el('div', 'banner ok', '✓ verify 通過，待結案'));

    // log tail for active runs
    if (Array.isArray(c.logTail) && c.logTail.length) {
      const lt = el('div', 'logtail');
      for (const line of c.logTail) lt.appendChild(el('div', null, line));
      card.appendChild(lt);
    }

    // actions
    const actions = el('div', 'actions');
    const btn = (label, cls, fn) => {
      const b = el('button', `btn sm ${cls || ''}`.trim(), label);
      b.type = 'button';
      b.onclick = fn;
      return b;
    };
    if (c.status === 'draft' && c.gate.ok)
      actions.appendChild(btn('加入排程', 'primary', () => act(`/api/tasks/${c.id}/queue`)));
    if (c.status === 'running' || c.status === 'verifying')
      actions.appendChild(btn('中止', 'danger-ghost', () => act(`/api/tasks/${c.id}/abort`)));
    if (c.status === 'review') {
      if (c.pr_url) actions.appendChild(btn('看 PR', '', () => window.open(c.pr_url, '_blank', 'noopener')));
      actions.appendChild(btn('結案', 'primary', () => act(`/api/tasks/${c.id}/close`)));
    }
    if (c.status === 'failed')
      actions.appendChild(btn('結案', '', () => act(`/api/tasks/${c.id}/close`)));
    if (actions.childElementCount) card.appendChild(actions);
  }

  // ---- board skeleton + reconciler -------------------------------------
  const boardEl = $('board');
  const colBodies = [];
  (function buildSkeleton() {
    for (const [title] of COLUMNS) {
      const col = el('section', 'col');
      const head = el('div', 'col-head');
      head.appendChild(el('h2', null, title));
      const count = el('span', 'count', '0');
      head.appendChild(count);
      col.appendChild(head);
      const body = el('div', 'col-body');
      col.appendChild(body);
      boardEl.appendChild(col);
      colBodies.push({ body, count });
    }
  })();

  const cardMap = new Map(); // id -> { el, sig }

  function render(s) {
    renderTop(s);
    const seen = new Set();
    const cards = Array.isArray(s.cards) ? s.cards : [];

    COLUMNS.forEach(([, statuses], i) => {
      const { body, count } = colBodies[i];
      const list = cards.filter((c) => statuses.includes(c.status));
      count.textContent = list.length;

      // update / create + place in order (appendChild moves existing nodes,
      // so live cards keep their DOM node — no flicker, no shimmer restart)
      for (const c of list) {
        seen.add(c.id);
        const sig = JSON.stringify(c);
        let entry = cardMap.get(c.id);
        if (!entry) {
          entry = { el: el('div', 'card'), sig: '' };
          cardMap.set(c.id, entry);
        }
        if (entry.sig !== sig) {
          entry.el.replaceChildren();
          buildCard(entry.el, c);
          entry.sig = sig;
        }
        body.appendChild(entry.el); // moves if already elsewhere, preserving node
      }

      // empty-state placeholder
      const placeholder = body.querySelector(':scope > .empty');
      if (list.length === 0) {
        if (!placeholder) body.appendChild(el('div', 'empty', '沒有項目'));
      } else if (placeholder) {
        placeholder.remove();
      }
    });

    // drop cards no longer present anywhere
    for (const [id, entry] of cardMap) {
      if (!seen.has(id)) {
        entry.el.remove();
        cardMap.delete(id);
      }
    }
  }

  // ---- topbar controls -------------------------------------------------
  $('pause-btn').onclick = () => {
    const paused = $('sched-state').classList.contains('paused');
    act(paused ? '/api/resume-scheduler' : '/api/pause');
  };

  const dialog = $('new-dialog');
  $('new-btn').onclick = () => dialog.showModal();

  $('new-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value !== 'create') return; // cancel closes normally
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.priority = Number(body.priority || 2);
    const createBtn = $('create-btn');
    createBtn.disabled = true; // guard against a double-submit creating two tasks
    try {
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw await r.text().catch(() => r.statusText);
      dialog.close();
      e.target.reset();
    } catch (err) {
      alert('建立失敗: ' + err);
    } finally {
      createBtn.disabled = false;
    }
  });

  // ---- SSE with reconnect fallback -------------------------------------
  const conn = $('conn');
  function setConn(kind, text) {
    // kind: 'connecting' | 'live' | 'down'
    conn.classList.remove('connecting', 'live', 'down');
    conn.classList.add(kind);
    conn.querySelector('.conn-text').textContent = text;
  }

  function connect() {
    setConn('connecting', '連線中');
    const url = '/api/stream' + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
    const es = new EventSource(url);
    es.onopen = () => setConn('live', '即時連線');
    es.onmessage = (m) => {
      try { render(JSON.parse(m.data)); } catch (e) {}
    };
    es.onerror = () => {
      setConn('down', '重新連線…');
      try { es.close(); } catch (e) {}
      setTimeout(connect, 2000);
    };
  }
  connect();
})();
