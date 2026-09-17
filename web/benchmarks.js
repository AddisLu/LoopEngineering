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

  async function api(path, method = 'GET', body) {
    const r = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json', ...authHeaders } : authHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
    return data;
  }

  const fmt = (n, d = 1) => (n == null || isNaN(n) ? '–' : Number(n).toFixed(d));
  const pct = (n) => (n == null || isNaN(n) ? '–' : `${Math.round(n * 100)}%`);
  const dur = (s) => (s == null ? '–' : s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
  const STATUS = { running: '執行中', judging: '評比中', judged: '已評比', judge_failed: '評比失敗' };
  const VERIFY = { pass: '通過', manual: '待人工', fail: '失敗' };

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

  // ---- table helper -----------------------------------------------------
  function fillTable(table, headers, rows) {
    table.replaceChildren();
    const thead = el('thead');
    const hr = el('tr');
    for (const h of headers) hr.appendChild(el('th', null, h));
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const r of rows) tbody.appendChild(r);
    table.append(thead, tbody);
  }
  function row(cells, onClick) {
    const tr = el('tr', onClick ? 'clickable' : null);
    for (const c of cells) {
      const td = el('td');
      if (c instanceof Node) td.appendChild(c);
      else td.textContent = c == null ? '–' : String(c);
      tr.appendChild(td);
    }
    if (onClick) tr.onclick = onClick;
    return tr;
  }

  // ---- matrix -----------------------------------------------------------
  async function loadMatrix() {
    const { matrix } = await api('/api/benchmarks/matrix');
    $('matrix-empty').hidden = matrix.length > 0;
    fillTable(
      $('matrix'),
      ['領域', '模型', '次數', '平均分數', '勝率', '驗證通過率', '平均輸出 token', '平均耗時'],
      matrix.map((m) => {
        const score = el('span', 'heat', fmt(m.avg_score));
        return row([m.domain, m.model, m.n, score, pct(m.win_rate), pct(m.verify_pass_rate), m.avg_tokens_out, dur(m.avg_duration_s)]);
      }),
    );
  }

  // ---- list + detail ----------------------------------------------------
  let selected = null;
  async function loadList() {
    const { benchmarks } = await api('/api/benchmarks');
    $('list-empty').hidden = benchmarks.length > 0;
    fillTable(
      $('bench-list'),
      ['標題', '領域', '狀態', '完成 arm', '勝出', '評審', '建立'],
      benchmarks.map((b) => {
        const tr = row(
          [b.title, b.domain, STATUS[b.status] || b.status, `${b.arms_done}/${b.arm_count}`, b.winner, b.judge_model, b.created_at],
          () => showDetail(b.id),
        );
        if (b.id === selected) tr.classList.add('selected');
        return tr;
      }),
    );
  }

  async function showDetail(id) {
    selected = id;
    const { benchmark: b, arms } = await api(`/api/benchmarks/${encodeURIComponent(id)}`);
    $('detail').hidden = false;
    $('detail-title').textContent = `${b.title} · ${b.domain} · ${STATUS[b.status] || b.status}`;
    $('detail-summary').textContent = b.summary || '';
    $('detail-error').hidden = !b.error;
    $('detail-error').textContent = b.error || '';
    $('rejudge-btn').hidden = b.status !== 'judge_failed';
    const sorted = [...arms].sort((x, y) => (x.judge_rank ?? 99) - (y.judge_rank ?? 99));
    fillTable(
      $('detail-arms'),
      ['名次', '模型', '任務', '驗證', '分數', '各項（正確/完整/品質/遵循）', '輸出 token', '耗時', '評語'],
      sorted.map((a) => {
        let parts = '–';
        try {
          const s = JSON.parse(a.scores_json || 'null');
          if (s) parts = `${s.correctness} / ${s.completeness} / ${s.code_quality} / ${s.adherence}`;
        } catch (e) { /* ignore */ }
        return row([a.judge_rank, a.model, `${a.task_id} (${a.task_status || '?'})`, VERIFY[a.verify_outcome] || '–', fmt(a.judge_score), parts, a.tokens_out, dur(a.duration_s), a.notes]);
      }),
    );
    loadList().catch(() => {});
  }

  $('rejudge-btn').onclick = async () => {
    if (!selected) return;
    const btn = $('rejudge-btn');
    btn.disabled = true;
    btn.textContent = '評比中…';
    try {
      await api(`/api/benchmarks/${encodeURIComponent(selected)}/judge`, 'POST', {});
    } catch (e) {
      $('detail-error').hidden = false;
      $('detail-error').textContent = `重新評比失敗：${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '重新評比';
      refresh();
    }
  };

  // ---- create form ------------------------------------------------------
  async function loadModelChoices() {
    const box = $('model-choices');
    box.replaceChildren();
    let models = [];
    try {
      ({ models } = await api('/api/local/models'));
    } catch (e) { /* no local models endpoint */ }
    const options = (models || []).filter((m) => m.enabled).map((m) => [`local:${m.id}`, `local:${m.id}（${m.display_name}）`]);
    options.push(['sonnet', 'sonnet（雲端對照組，會花 token）']);
    for (const [value, text] of options) {
      const label = el('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = 'models';
      cb.value = value;
      label.append(cb, el('span', null, text));
      box.appendChild(label);
    }
  }

  $('bench-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => k !== 'models'));
    body.models = fd.getAll('models');
    const err = $('form-err');
    const btn = $('bench-submit');
    err.hidden = true;
    btn.disabled = true;
    try {
      const { benchmark } = await api('/api/benchmarks', 'POST', body);
      e.target.reset();
      await refresh();
      showDetail(benchmark.id);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ---- refresh loop -----------------------------------------------------
  async function refresh() {
    try {
      await Promise.all([loadMatrix(), loadList()]);
      $('disabled-note').hidden = true;
      if (selected) await showDetail(selected);
    } catch (e) {
      if (e.status === 404) $('disabled-note').hidden = false;
    }
  }

  loadModelChoices();
  refresh();
  setInterval(refresh, 15000);
})();
