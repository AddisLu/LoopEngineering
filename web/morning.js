(() => {
  'use strict';

  // ---- auth / token (same bootstrap as app.js) --------------------------
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const OUTCOME = {
    attention: ['⚠', '要你處理'],
    failed: ['✖', '失敗'],
    pass: ['✅', '驗收通過'],
    manual: ['📝', '待人工驗收'],
    blocked: ['⏸', '中斷，會自動續跑'],
    running: ['▶', '執行中'],
    queued: ['…', '還沒輪到'],
  };
  const MERGE = { merged: '已併入', pending: '待合併（按看板上的合併）', conflict: '合併衝突，已建解衝突任務' };
  // SQLite writes UTC; show it in the reader's own clock
  const localTime = (s) => {
    if (!s) return '–';
    const d = new Date(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return isNaN(d) ? s : d.toLocaleString('zh-TW', { hour12: false }).replace(/:\d\d$/, '');
  };
  const safeHref = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

  // ---- theme ------------------------------------------------------------
  const themeBtn = $('theme-btn');
  const mode = () => (document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light');
  const paintTheme = () => (themeBtn.textContent = mode() === 'dark' ? '☀' : '☾');
  themeBtn.onclick = () => {
    const next = mode() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-mode', next);
    try {
      localStorage.setItem('loop_mode', next);
    } catch (e) { /* private mode */ }
    paintTheme();
  };
  paintTheme();

  // ---- one task ---------------------------------------------------------
  function metricsTable(t) {
    const table = el('table');
    const head = el('tr');
    for (const h of ['指標', '實際', '要求', '結果']) head.append(el('th', null, h));
    table.append(head);
    for (const c of t.metrics.checks) {
      const tr = el('tr');
      tr.append(el('td', null, c.name), el('td', null, c.actual == null ? '沒回報' : String(c.actual)), el('td', null, `${c.op} ${c.target}`));
      tr.append(el('td', c.pass ? 'good' : 'bad', c.pass ? '✅ 達標' : '❌ 未達'));
      table.append(tr);
    }
    const wrap = el('div', 'scroll');
    wrap.append(table);
    const extra = Object.entries(t.metrics.values || {}).filter(([k]) => !t.metrics.checks.some((c) => c.name === k));
    if (extra.length) wrap.append(el('p', 'hint', `其他回報：${extra.map(([k, v]) => `${k}=${v}`).join('、')}`));
    return wrap;
  }

  function card(t) {
    const [icon, label] = OUTCOME[t.outcome] || ['•', t.outcome];
    const box = el('section', `card ${t.outcome}`);

    const title = el('p', 'title');
    title.append(el('span', `chip ${t.outcome}`, `${icon} ${label}`), ' ');
    const a = el('a', null, t.title);
    a.href = `/board.html#task=${encodeURIComponent(t.id)}`;
    title.append(a);
    box.append(title);

    const meta = [
      t.id,
      t.model || '預設模型',
      t.repo ? `${t.repo}${t.base ? `@${t.base}` : ''}` : null,
      t.runs ? `這段時間跑了 ${t.runs} 次` : null,
      t.run && t.run.minutes != null ? `最後一次 ${t.run.minutes} 分鐘` : null,
      t.run && t.run.finished_at ? `結束於 ${localTime(t.run.finished_at)}` : t.run ? `開始於 ${localTime(t.run.started_at)}` : null,
    ].filter(Boolean);
    box.append(el('div', 'meta', meta.join(' · ')));

    if (t.reason) box.append(el('div', 'reason', t.reason));

    if (t.steps && t.steps.length) {
      const ul = el('ul', 'steps');
      for (const s of t.steps) {
        const li = el('li', null, s.ok ? '✅ ' : '❌ ');
        li.append(el('code', null, s.step));
        li.append(s.timedOut ? '（逾時）' : s.exitCode != null ? `（exit ${s.exitCode}）` : '');
        ul.append(li);
      }
      box.append(ul);
      if (t.failed_step && t.failed_step.tail) {
        const d = el('details');
        d.open = t.outcome === 'attention' || t.outcome === 'failed';
        d.append(el('summary', null, `${t.failed_step.step} 的輸出（最後幾行）`), el('pre', null, t.failed_step.tail));
        box.append(d);
      }
    }

    if (t.metrics && t.metrics.checks && t.metrics.checks.length) box.append(metricsTable(t));
    else if (t.thresholds && t.outcome !== 'queued') box.append(el('div', 'meta', `驗收指標沒有量到（門檻：${t.thresholds}）`));

    const links = el('div', 'meta');
    if (t.merge_status) links.append(`合併：${MERGE[t.merge_status] || t.merge_status}${t.merge_status === 'merged' && t.base ? ` ${t.base}` : ''}`);
    const pr = safeHref(t.pr_url);
    if (pr) {
      if (links.childNodes.length) links.append(' · ');
      const pa = el('a', null, '開啟 PR ↗');
      pa.href = pr;
      pa.target = '_blank';
      pa.rel = 'noopener';
      links.append(pa);
    }
    if (links.childNodes.length) box.append(links);

    if (t.verify_md) {
      const d = el('details');
      d.append(el('summary', null, '人工驗收清單（VERIFY.md）'), el('pre', null, t.verify_md));
      box.append(d);
    }
    return box;
  }

  // ---- load -------------------------------------------------------------
  async function load() {
    const err = $('page-err');
    err.hidden = true;
    try {
      const r = await fetch(`/api/morning?hours=${encodeURIComponent($('hours').value)}`, { headers: authHeaders });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText);
      $('headline').textContent = data.headline;
      $('subline').textContent = `產生於 ${localTime(data.generated_at)}${data.local_task_window ? ` · 本地模型任務只在 ${data.local_task_window} 執行` : ''}`;
      const counts = $('counts');
      counts.replaceChildren();
      for (const [k, [icon, label]] of Object.entries(OUTCOME)) {
        const n = (data.counts || {})[k];
        if (n) counts.append(el('span', `chip ${k}`, `${icon} ${label} ${n}`));
      }
      const list = $('list');
      list.replaceChildren();
      if (!data.tasks || !data.tasks.length) list.append(el('p', 'empty', '這段時間沒有任務執行。'));
      for (const t of data.tasks || []) list.append(card(t));
    } catch (e) {
      err.textContent = `讀取失敗：${e.message || e}`;
      err.hidden = false;
    }
  }

  const saved = (() => {
    try {
      return localStorage.getItem('loop_morning_hours');
    } catch (e) {
      return null;
    }
  })();
  if (saved && [...$('hours').options].some((o) => o.value === saved)) $('hours').value = saved;
  $('hours').onchange = () => {
    try {
      localStorage.setItem('loop_morning_hours', $('hours').value);
    } catch (e) { /* private mode */ }
    load();
  };
  $('reload').onclick = load;
  load();
})();
