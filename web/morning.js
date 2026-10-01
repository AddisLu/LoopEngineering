(() => {
  'use strict';
  const { api, el, icon, localTime, initChrome, stored, store } = window.Ops;
  const $ = (id) => document.getElementById(id);
  initChrome();

  // outcome → [pill class, icon, label]; needs-a-person first, as the server orders them
  const OUTCOME = {
    attention: ['bad', 'alert', '要你處理'],
    failed: ['bad', 'x', '失敗'],
    pass: ['ok', 'circleCheck', '驗收通過'],
    manual: ['warn', 'hand', '待人工驗收'],
    blocked: ['warn', 'clock', '中斷，會自動續跑'],
    running: ['info', 'clock', '執行中'],
    queued: ['', 'clock', '還沒輪到'],
  };
  const MERGE = { merged: '已併入', pending: '待合併（在驗收頁核可）', conflict: '合併衝突，已建解衝突任務' };
  const OPS = { '>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '>': '>', '<': '<' };
  const safeHref = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

  function pill(outcome) {
    const [cls, ic, label] = OUTCOME[outcome] || ['', 'clock', outcome];
    const p = el('span', `pill ${cls}`);
    p.appendChild(icon(ic));
    p.appendChild(document.createTextNode(label));
    return p;
  }

  function stepRow(s, open) {
    const d = el('details', 'step');
    d.open = open;
    const sum = el('summary');
    sum.appendChild(icon(s.ok ? 'check' : 'x', s.ok ? 'ok-i' : 'bad-i'));
    sum.appendChild(el('span', 'cmd', s.step));
    sum.appendChild(el('span', 'st', s.timedOut ? '逾時' : s.exitCode != null ? `exit ${s.exitCode}` : ''));
    d.appendChild(sum);
    d.appendChild(el('pre', 'console', (s.tail || '（沒有輸出）').trim()));
    return d;
  }

  function metricsTable(m) {
    const wrap = el('div', 'scroll-x');
    const table = el('table', 'mtable');
    const head = el('tr');
    for (const h of ['指標', '實際', '門檻', '結果']) head.appendChild(el('th', null, h));
    table.appendChild(head);
    for (const c of m.checks) {
      const tr = el('tr');
      tr.appendChild(el('td', 'num', c.name));
      tr.appendChild(el('td', 'num', c.actual == null ? '沒有回報' : String(c.actual)));
      tr.appendChild(el('td', 'num', `${OPS[c.op] || c.op} ${c.target}`));
      tr.appendChild(el('td', c.pass ? 'good' : 'bad', c.pass ? '達標' : '未達'));
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    const extra = Object.entries(m.values || {}).filter(([k]) => !m.checks.some((c) => c.name === k));
    if (extra.length) wrap.appendChild(el('p', 'hint', `另外回報：${extra.map(([k, v]) => `${k} = ${v}`).join('、')}`));
    return wrap;
  }

  function card(t) {
    const box = el('section', 'panel');
    const head = el('div', 'row');
    head.appendChild(pill(t.outcome));
    const a = el('a', null, t.title);
    a.href = `/task.html?id=${encodeURIComponent(t.id)}`;
    a.style.fontSize = '17px';
    a.style.fontWeight = '700';
    a.style.color = 'var(--text)';
    head.appendChild(a);
    box.appendChild(head);

    const meta = el('div', 'meta');
    for (const p of [
      t.id,
      t.model || '預設模型',
      t.repo ? `${t.repo}${t.base ? ` · ${t.base}` : ''}` : null,
      t.runs ? `這段時間跑了 ${t.runs} 次` : null,
      t.run && t.run.minutes != null ? `最後一次 ${t.run.minutes} 分鐘` : null,
      t.run && t.run.finished_at ? `結束於 ${localTime(t.run.finished_at)}` : t.run ? `開始於 ${localTime(t.run.started_at)}` : null,
    ].filter(Boolean)) meta.appendChild(el('span', null, p));
    box.appendChild(meta);

    if (t.reason) {
      const r = el('div', 'hint', t.reason.length > 500 ? `${t.reason.slice(0, 500)}…` : t.reason);
      r.style.whiteSpace = 'pre-wrap';
      box.appendChild(r);
    }
    if (t.steps && t.steps.length) {
      const steps = el('div', 'steps');
      const bad = t.outcome === 'attention' || t.outcome === 'failed';
      for (const s of t.steps) steps.appendChild(stepRow(s, bad && !s.ok));
      box.appendChild(steps);
    }
    if (t.metrics && t.metrics.checks && t.metrics.checks.length) box.appendChild(metricsTable(t.metrics));
    else if (t.thresholds && t.outcome !== 'queued') box.appendChild(el('div', 'hint', `驗收指標沒有量到（門檻：${t.thresholds}）`));

    const links = el('div', 'row');
    if (t.merge_status) links.appendChild(el('span', 'hint', `合併：${MERGE[t.merge_status] || t.merge_status}${t.merge_status === 'merged' && t.base ? ` ${t.base}` : ''}`));
    const pr = safeHref(t.pr_url);
    if (pr) {
      const pa = el('a', null, '開啟 PR ↗');
      pa.href = pr;
      pa.target = '_blank';
      pa.rel = 'noopener';
      links.appendChild(pa);
    }
    if (t.outcome !== 'queued' && t.outcome !== 'running') {
      const rv = el('a', 'btn', t.outcome === 'attention' || t.outcome === 'failed' ? '看原因、退回修改' : '驗收：看程式碼、試跑、勾清單');
      rv.href = `/task.html?id=${encodeURIComponent(t.id)}`;
      links.appendChild(el('span', 'grow'));
      links.appendChild(rv);
    }
    if (links.childNodes.length) box.appendChild(links);
    if (t.verify_md) {
      const d = el('details');
      d.appendChild(el('summary', 'hint', '人工驗收清單（VERIFY.md）'));
      d.lastChild.style.cursor = 'pointer';
      d.appendChild(el('pre', 'console', t.verify_md));
      box.appendChild(d);
    }
    return box;
  }

  async function load() {
    const err = $('page-err');
    err.hidden = true;
    try {
      const data = await api(`/api/morning?hours=${encodeURIComponent($('hours').value)}`);
      $('headline').textContent = data.headline;
      $('subline').textContent = `產生於 ${localTime(data.generated_at)}${data.local_task_window ? ` · 本地模型的工作在 ${data.local_task_window} 之間開始` : ''}`;
      const counts = $('counts');
      counts.replaceChildren();
      for (const k of Object.keys(OUTCOME)) {
        const n = (data.counts || {})[k];
        if (!n) continue;
        const p = pill(k);
        p.appendChild(document.createTextNode(` ${n}`));
        counts.appendChild(p);
      }
      const list = $('list');
      list.replaceChildren();
      if (!data.tasks || !data.tasks.length) {
        const p = el('p', 'empty', '這段時間沒有任務執行。');
        const a = el('a', null, '開一張問題單');
        a.href = '/fix.html';
        p.appendChild(document.createTextNode(' '));
        p.appendChild(a);
        list.appendChild(p);
      }
      for (const t of data.tasks || []) list.appendChild(card(t));
    } catch (e) {
      err.textContent = `讀取失敗：${e.message || e}`;
      err.hidden = false;
    }
  }

  const saved = stored('loop_morning_hours');
  if (saved && [...$('hours').options].some((o) => o.value === saved)) $('hours').value = saved;
  $('hours').onchange = () => {
    store('loop_morning_hours', $('hours').value);
    load();
  };
  $('reload').onclick = load;
  load();
})();
