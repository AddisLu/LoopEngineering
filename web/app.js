(() => {
  'use strict';

  // ---- auth / token ----------------------------------------------------
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const RING_C = 2 * Math.PI * 18; // ring circumference (r=18)

  // 5 columns: 'ready' is never produced by the pipeline (folded into Queued),
  // and 'verifying' is a sub-state of an active run (folded into Running) — so the
  // whole lifecycle fits one screen without horizontal scroll.
  const COLUMNS = [
    ['Draft · 入場審核', ['draft']],
    ['Queued', ['ready', 'queued', 'blocked']],
    ['Running', ['running', 'verifying']],
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
  // Permanent delete with a confirm gate. The SSE stream drops the card on the next tick.
  // Returns true if the task was actually deleted.
  async function delTask(id, title) {
    if (!confirm(`確定永久刪除「${title}」？此動作無法復原（含 worktree／plan／logs）。`)) return false;
    try { await api('/api/tasks/' + id, 'DELETE'); return true; }
    catch (e) { alert('刪除失敗：' + e); return false; }
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
    card.dataset.id = c.id; // for the click-to-open detail modal

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
    // serial-chain dependency chip (draft/queued cards waiting on another task)
    if (c.depends_on && c.dep_state && c.dep_state !== 'satisfied') {
      const depLabel = c.dep_state === 'waiting' ? `⏳ 等 ${c.depends_on}`
        : c.dep_state === 'dep-failed' ? `⚠ 依賴失敗 ${c.depends_on}`
        : `⚠ 依賴不存在 ${c.depends_on}`;
      meta.appendChild(el('span', 'chip mono dep', depLabel));
    }
    if (c.elapsedMin != null) {
      // show elapsed against the run's timeout budget when we know it
      const label = c.timeoutMin != null ? `${fmtDur(c.elapsedMin)} / ${fmtDur(c.timeoutMin)}` : fmtDur(c.elapsedMin);
      meta.appendChild(el('span', 'chip mono', label));
    }
    if (c.status === 'running' || c.status === 'verifying') {
      const w = el('span', 'chip working');
      w.appendChild(el('span', 'spin'));
      w.appendChild(el('span', null, c.status === 'verifying' ? 'verifying…' : 'working…'));
      meta.appendChild(w);
    }
    card.appendChild(meta);

    // run progress toward the timeout budget — only when timeoutMin is known
    // (never fabricate progress; queued/verifying cards have no active run)
    if (c.timeoutMin != null && c.elapsedPct != null) {
      const w = Math.max(0, Math.min(100, Number(c.elapsedPct) || 0));
      const prog = el('div', 'progress');
      prog.dataset.state = c.elapsedPct >= 90 ? 'danger' : c.elapsedPct >= 70 ? 'warn' : 'ok';
      prog.setAttribute('role', 'progressbar');
      prog.setAttribute('aria-valuenow', String(Math.round(c.elapsedPct)));
      prog.setAttribute('aria-valuemin', '0');
      prog.setAttribute('aria-valuemax', '100');
      const bar = el('div', 'bar');
      bar.style.width = w + '%';
      prog.appendChild(bar);
      card.appendChild(prog);
    }

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
    // small trash action on terminal cards (review/failed/closed) — permanent delete
    if (c.status === 'review' || c.status === 'failed' || c.status === 'closed') {
      const del = btn('🗑', 'del danger-ghost', () => delTask(c.id, c.title));
      del.title = '永久刪除';
      del.setAttribute('aria-label', '永久刪除');
      actions.appendChild(del);
    }
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
  $('new-cancel').onclick = () => dialog.close();

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

  // ---- settings panel (day/night thresholds etc.) ----------------------
  const settingsDialog = $('settings-dialog');
  const settingsForm = $('settings-form');
  const settingsErr = $('settings-err');
  $('settings-btn').onclick = async () => {
    settingsErr.hidden = true;
    try {
      const { settings } = await api('/api/settings', 'GET');
      for (const [k, v] of Object.entries(settings || {})) {
        const input = settingsForm.elements.namedItem(k);
        if (input) input.value = v;
      }
    } catch (e) { /* open anyway; inputs just start blank */ }
    settingsDialog.showModal();
  };
  $('settings-cancel').onclick = () => settingsDialog.close();
  settingsForm.addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value !== 'save') return; // cancel closes normally
    e.preventDefault();
    const settings = {};
    for (const [k, v] of new FormData(settingsForm).entries()) {
      if (String(v).trim() !== '') settings[k] = String(v).trim();
    }
    const saveBtn = $('settings-save');
    saveBtn.disabled = true;
    settingsErr.hidden = true;
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ settings }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw body.errors ? Object.values(body.errors).join('；') : (body.error || r.statusText);
      }
      settingsDialog.close();
    } catch (err) {
      settingsErr.textContent = '儲存失敗：' + err;
      settingsErr.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ---- prune / cleanup panel -------------------------------------------
  const pruneDialog = $('prune-dialog');
  const pruneForm = $('prune-form');
  const pruneResult = $('prune-result');
  const pruneErr = $('prune-err');
  $('prune-btn').onclick = () => {
    pruneResult.hidden = true;
    pruneErr.hidden = true;
    pruneDialog.showModal();
  };
  $('prune-cancel').onclick = () => pruneDialog.close();

  function pruneBody() {
    const status = [...pruneForm.querySelectorAll('input[name="status"]:checked')].map((i) => i.value);
    const older = String(pruneForm.elements.older_than.value || '').trim();
    const body = {};
    if (status.length) body.status = status;
    if (older !== '') body.olderThanDays = Number(older);
    return body;
  }
  async function prunePost(body) {
    const r = await fetch('/api/tasks/prune', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await r.text().catch(() => r.statusText);
    return r.json();
  }
  function showPruneList(res, verb) {
    pruneErr.hidden = true;
    pruneResult.textContent = res.count
      ? `${verb} ${res.count} 個任務：${res.ids.join('、')}`
      : '沒有符合條件的任務。';
    pruneResult.hidden = false;
  }
  $('prune-preview').onclick = async () => {
    try { showPruneList(await prunePost({ ...pruneBody(), dryRun: true }), '將刪除'); }
    catch (e) { pruneErr.textContent = '預覽失敗：' + e; pruneErr.hidden = false; }
  };
  $('prune-run').onclick = async () => {
    pruneErr.hidden = true;
    let preview;
    try { preview = await prunePost({ ...pruneBody(), dryRun: true }); }
    catch (e) { pruneErr.textContent = '清理失敗：' + e; pruneErr.hidden = false; return; }
    if (!preview.count) { showPruneList(preview, '將刪除'); return; }
    if (!confirm(`確定永久刪除 ${preview.count} 個任務及其產物（worktree／plan／logs）？此動作無法復原。`)) return;
    try {
      showPruneList(await prunePost(pruneBody()), '已刪除');
      setTimeout(() => pruneDialog.close(), 1000);
    } catch (e) {
      pruneErr.textContent = '清理失敗：' + e;
      pruneErr.hidden = false;
    }
  };

  // ---- card detail modal (click a card) --------------------------------
  const detailDialog = $('detail-dialog');
  const detailBody = $('detail-body');
  const STATUS_LABEL = {
    draft: 'Draft', ready: 'Ready', queued: 'Queued', running: 'Running',
    verifying: 'Verifying', blocked: 'Blocked', review: 'Review', failed: 'Failed', closed: 'Closed',
  };
  function statusExplain(t, gate) {
    switch (t.status) {
      case 'draft':
        return gate.ok
          ? '已通過入場審核。這是「草稿」——按卡片上的「加入排程」才會進入佇列（例如 Phase 2/3 是刻意保留的草稿）。'
          : '缺少必填項：' + (gate.missing || []).join('、') + '。補齊後才能加入排程。';
      case 'queued':
        return '已排隊，等排程器派工。需 session/weekly 用量低於「當前時段門檻」、剩餘 runway 足夠、且此任務預估用量放得下時才會開始。';
      case 'blocked': return '執行中被中斷（斷路器/暫停），保留 session，用量降回後會自動 resume。';
      case 'running': return '正在執行中。';
      case 'verifying': return '正在跑驗證步驟。';
      case 'review': return '驗證通過，等你結案（或看 PR）。';
      case 'failed': return '逾時或驗證/執行失敗。';
      case 'closed': return '已結案。';
      default: return '';
    }
  }
  function dRow(k, v) {
    const r = el('div', 'd-row');
    r.appendChild(el('span', 'd-k', k));
    const val = el('span', 'd-v');
    if (v instanceof Node) val.appendChild(v); else val.textContent = v == null || v === '' ? '–' : v;
    r.appendChild(val);
    return r;
  }
  async function openDetail(id) {
    detailBody.replaceChildren(el('div', 'd-loading', '載入中…'));
    detailDialog.showModal();
    let data;
    try { data = await api('/api/tasks/' + id, 'GET'); }
    catch (e) { detailBody.replaceChildren(el('div', 'banner danger', '讀取失敗：' + e)); return; }
    const t = data.task || {};
    const gate = data.gate || { ok: false, missing: [] };
    let steps = [];
    try { steps = JSON.parse(t.verification_steps || '[]'); } catch (e) {}

    detailBody.replaceChildren();
    const head = el('div', 'd-head');
    head.appendChild(el('h3', null, t.title || t.id));
    head.appendChild(el('span', `d-badge s-${t.status}`, STATUS_LABEL[t.status] || t.status));
    detailBody.appendChild(head);
    detailBody.appendChild(el('div', 'd-explain', statusExplain(t, gate)));

    const list = el('div', 'd-list');
    list.appendChild(dRow('Goal', t.goal));
    list.appendChild(dRow('Plan', t.plan_ref));
    list.appendChild(dRow('Verify', steps.length ? steps.join('　•　') : '–'));
    list.appendChild(dRow('Repo', t.repo_path ? `${t.repo_path}${t.base_branch ? '  @ ' + t.base_branch : ''}` : '–'));
    if (t.setup_cmd) list.appendChild(dRow('Setup', t.setup_cmd));
    list.appendChild(dRow('Tool / Model', `${t.coding_tool || '–'}${t.model ? ' · ' + t.model : ''}`));
    list.appendChild(dRow('Complexity / Priority', `${t.complexity} · P${t.priority}`));
    if (t.pr_url) {
      const a = el('a', null, t.pr_url); a.href = t.pr_url; a.target = '_blank'; a.rel = 'noopener';
      list.appendChild(dRow('PR', a));
    }
    list.appendChild(dRow('建立 / 更新', `${t.created_at || '–'}  /  ${t.updated_at || '–'}`));
    detailBody.appendChild(list);

    const menu = el('menu');
    // Delete from the detail modal — hidden for active states (running/verifying/queued),
    // which the API refuses without force; abort/dequeue those first.
    if (t.status !== 'running' && t.status !== 'verifying' && t.status !== 'queued') {
      const del = el('button', 'btn danger-ghost', '刪除'); del.type = 'button';
      del.onclick = async () => {
        del.disabled = true;
        if (await delTask(t.id, t.title)) detailDialog.close();
        else del.disabled = false;
      };
      menu.appendChild(del);
    }
    const close = el('button', 'btn primary', '關閉'); close.type = 'button';
    close.onclick = () => detailDialog.close();
    menu.appendChild(close);
    detailBody.appendChild(menu);
  }
  boardEl.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return; // let card action buttons work
    const card = e.target.closest('.card');
    if (card && card.dataset.id) openDetail(card.dataset.id);
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
