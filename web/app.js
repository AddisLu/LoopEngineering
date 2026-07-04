(() => {
  const C = 2 * Math.PI * 24; // ring circumference
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const COLUMNS = [
    ['Draft · 入場審核', ['draft']],
    ['Ready', ['ready']],
    ['Queued', ['queued', 'blocked']],
    ['Running', ['running']],
    ['Verifying', ['verifying']],
    ['Review · 結案', ['review', 'failed']],
    ['Closed', ['closed']],
  ];

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(path, method = 'POST') {
    const r = await fetch(path, { method, headers: authHeaders });
    return r.ok ? r.json().catch(() => ({})) : Promise.reject(await r.text());
  }

  function color(pct) {
    return pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--success)';
  }
  function setRing(id, pct) {
    const wrap = $(id);
    const fill = wrap.querySelector('.fill');
    fill.style.strokeDasharray = `${(Math.min(100, pct) / 100) * C} ${C}`;
    fill.style.stroke = color(pct);
  }

  function renderTop(s) {
    $('session-pct').textContent = `${s.usage.session}%`;
    $('weekly-pct').textContent = `${s.usage.weekly}%`;
    setRing('ring-session', s.usage.session);
    setRing('ring-weekly', s.usage.weekly);
    const sr = s.usage.sessionResetsInMin;
    $('resets').textContent =
      sr != null ? `session 重置 ${Math.floor(sr / 60)}:${String(sr % 60).padStart(2, '0')}` : 'session 重置 –';
    $('policy').querySelector('span').textContent =
      `${s.policy.window === 'night' ? '夜間' : '日間'} · 門檻 ${s.policy.sessionMax}%`;

    const state = $('sched-state');
    state.classList.toggle('paused', s.paused);
    state.querySelector('span').textContent = s.paused ? '已暫停' : '排程執行中';
    $('pause-btn').textContent = s.paused ? '恢復排程' : '暫停排程';
  }

  function cardEl(c) {
    const card = el('div', `card s-${c.status}${c.status === 'draft' && !c.gate.ok ? ' gate-bad' : ''}`);
    card.appendChild(el('div', 't', esc(c.title)));

    const sub = el('div', 'sub');
    sub.appendChild(el('span', 'tag', esc(c.complexity)));
    sub.appendChild(el('span', null, `P${c.priority}`));
    sub.appendChild(el('span', null, esc(c.model || c.coding_tool)));
    if (c.status === 'queued') sub.appendChild(el('span', null, `~${c.est_pct}%`));
    if (c.elapsedMin != null) sub.appendChild(el('span', null, `${c.elapsedMin}m`));
    card.appendChild(sub);

    if (c.status === 'draft') {
      const chk = el('div', 'check');
      const items = [
        ['goal', !c.gate.missing.some((m) => m.startsWith('goal'))],
        ['plan', !c.gate.missing.some((m) => m.startsWith('plan_ref'))],
        ['tool', !c.gate.missing.some((m) => m.startsWith('coding_tool'))],
        ['verify', !c.gate.missing.some((m) => m.startsWith('verification'))],
        ['repo', !c.gate.missing.some((m) => m.startsWith('repo') || m.startsWith('base_branch'))],
      ];
      for (const [label, ok] of items) chk.appendChild(el('span', ok ? 'ok' : 'no', esc(label)));
      card.appendChild(chk);
      if (!c.gate.ok) card.appendChild(el('div', 'banner danger', '缺項，無法入列'));
    }

    if (c.status === 'blocked') card.appendChild(el('div', 'banner', '⏸ blocked · 可自動 resume'));
    if (c.status === 'failed') card.appendChild(el('div', 'banner danger', 'verify/執行失敗'));
    if (c.status === 'review') card.appendChild(el('div', 'banner ok', '✓ verify 通過，待結案'));

    if (c.logTail && c.logTail.length) {
      const lt = el('div', 'logtail');
      for (const line of c.logTail) lt.appendChild(el('div', null, esc(line)));
      card.appendChild(lt);
    }

    const actions = el('div', 'actions');
    const btn = (label, cls, fn) => {
      const b = el('button', `btn sm ${cls || ''}`, esc(label));
      b.onclick = fn;
      return b;
    };
    if (c.status === 'draft' && c.gate.ok) actions.appendChild(btn('加入排程', 'primary', () => act(`/api/tasks/${c.id}/queue`)));
    if (c.status === 'running' || c.status === 'verifying') actions.appendChild(btn('中止', '', () => act(`/api/tasks/${c.id}/abort`)));
    if (c.status === 'review') {
      if (c.pr_url) actions.appendChild(btn('看 PR', '', () => window.open(c.pr_url, '_blank')));
      actions.appendChild(btn('結案', 'primary', () => act(`/api/tasks/${c.id}/close`)));
    }
    if (c.status === 'failed') actions.appendChild(btn('結案', '', () => act(`/api/tasks/${c.id}/close`)));
    if (actions.childElementCount) card.appendChild(actions);
    return card;
  }

  function render(s) {
    renderTop(s);
    const board = $('board');
    board.innerHTML = '';
    for (const [title, statuses] of COLUMNS) {
      const col = el('div', 'col');
      const cards = s.cards.filter((c) => statuses.includes(c.status));
      col.appendChild(el('h2', null, `<span>${esc(title)}</span><span class="n">${cards.length}</span>`));
      for (const c of cards) col.appendChild(cardEl(c));
      board.appendChild(col);
    }
  }

  async function act(path) {
    try {
      await api(path);
    } catch (e) {
      alert('操作失敗: ' + e);
    }
  }

  $('pause-btn').onclick = async () => {
    const paused = $('sched-state').classList.contains('paused');
    await act(paused ? '/api/resume-scheduler' : '/api/pause');
  };

  $('fab').onclick = () => $('new-dialog').showModal();
  $('new-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value !== 'create') return;
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.priority = Number(body.priority || 2);
    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
      });
      $('new-dialog').close();
      e.target.reset();
    } catch (err) {
      alert('建立失敗: ' + err);
    }
  });

  // SSE with polling fallback
  function connect() {
    const url = '/api/stream' + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
    const es = new EventSource(url);
    es.onopen = () => ($('conn').textContent = '●');
    es.onmessage = (m) => {
      try { render(JSON.parse(m.data)); } catch {}
    };
    es.onerror = () => {
      $('conn').textContent = '○';
      es.close();
      setTimeout(connect, 2000);
    };
  }
  connect();
})();
