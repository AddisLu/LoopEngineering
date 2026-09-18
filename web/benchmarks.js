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
  const gb = (b) => (b == null ? '' : `${(b / 1024 ** 3).toFixed(b >= 100 * 1024 ** 3 ? 0 : 1)} GB`);
  const STATUS = { running: '進行中', judging: '評分中', judged: '已評分', judge_failed: '評分失敗' };
  const VERIFY = { pass: '通過', manual: '待人工', fail: '失敗' };
  const CONSENSUS = { unanimous: '評審一致', split: '評審分歧', single: '單一評審' };
  const SOURCE = { builtin: '內建題庫', task: '看板任務', draft: 'PRD 草稿', manual: '現場輸入' };
  const CLOUD = [
    ['sonnet', 'Sonnet', '雲端 · 快、便宜'],
    ['opus', 'Opus', '雲端 · 最強，最貴'],
    ['haiku', 'Haiku', '雲端 · 最便宜'],
  ];
  const JUDGES = [
    ['opus', 'Opus', '預設評審，判斷最穩'],
    ['sonnet', 'Sonnet', '較快、較省'],
    ['fable', 'Fable', '另一種風格的第二意見'],
    ['fable-5', 'Fable 5', '同上，較新'],
  ];

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
  const chip = (text, cls) => el('span', `chip ${cls || ''}`.trim(), text);

  // ================= list view =================
  let summary = { running: null, recent: [], models: [] };
  let allBenchmarks = [];

  async function loadList() {
    summary = await api('/api/benchmarks/summary');
    const { matrix } = await api('/api/benchmarks/matrix');
    allBenchmarks = (await api('/api/benchmarks')).benchmarks;

    const run = summary.running;
    $('running-box').hidden = !run;
    if (run) {
      $('running-line').replaceChildren(
        el('b', null, run.title),
        el('span', null, `　${STATUS[run.status] || run.status} · ${run.arms_done}/${run.arm_count} 組完成 · ${run.models.join('、')}`),
      );
      $('running-line').onclick = () => go(`#b=${run.id}`);
      $('running-line').style.cursor = 'pointer';
    }

    fillTable(
      $('records'),
      ['模型', '參賽', '勝場', '平均分', '驗證通過率'],
      summary.models.map((m) => row([m.label, m.n, m.wins, fmt(m.avg_score), pct(m.verify_pass_rate)])),
    );
    $('matrix-empty').hidden = matrix.length > 0;
    fillTable(
      $('matrix'),
      ['領域', '模型', '次數', '平均分數', '勝率', '驗證通過率', '平均輸出 token', '平均耗時'],
      matrix.map((m) => row([m.domain, m.model, m.n, el('span', 'heat', fmt(m.avg_score)), pct(m.win_rate), pct(m.verify_pass_rate), m.avg_tokens_out, dur(m.avg_duration_s)])),
    );
    paintBenchList();
  }

  function paintBenchList() {
    const want = $('filter-status').value;
    const rows = allBenchmarks.filter((b) => !want || b.status === want);
    $('list-empty').hidden = rows.length > 0;
    $('list-count').textContent = `${rows.length} / ${allBenchmarks.length} 筆`;
    fillTable(
      $('bench-list'),
      ['標題', '來源', '狀態', '完成', '勝出', '評審', '建立時間'],
      rows.map((b) =>
        row(
          [
            b.title,
            SOURCE[b.source_kind] || b.source_kind || '–',
            STATUS[b.status] || b.status,
            `${b.arms_done}/${b.arm_count}`,
            b.winner_label || '–',
            b.judges.join('、') + (b.consensus && b.status === 'judged' ? `（${CONSENSUS[b.consensus] || b.consensus}）` : ''),
            b.created_at,
          ],
          () => go(`#b=${b.id}`),
        ),
      ),
    );
  }
  $('filter-status').onchange = paintBenchList;

  // ================= detail view =================
  let detailId = null;

  async function loadDetail(id) {
    detailId = id;
    const { benchmark: b, arms, judgements } = await api(`/api/benchmarks/${encodeURIComponent(id)}`);
    $('detail-title').textContent = b.title;
    const chips = [chip(STATUS[b.status] || b.status, b.status === 'judged' ? 'ok' : b.status === 'judge_failed' ? 'bad' : '')];
    if (b.consensus && b.status === 'judged') chips.push(chip(CONSENSUS[b.consensus] || b.consensus));
    chips.push(chip(b.domain), chip(`${arms.length} 組`), chip(`評審：${(b.judge_models || b.judge_model || '').split(',').join('、')}`));
    $('detail-chips').replaceChildren(...chips);
    const src = [SOURCE[b.source_kind] || '–', b.source_ref, b.repo_path].filter(Boolean).join(' · ');
    $('detail-source').textContent = `題目來源：${src}`;
    $('detail-summary').textContent = b.summary || (b.status === 'judged' ? '' : '還沒有評分結果。');
    $('detail-error').hidden = !b.error;
    $('detail-error').textContent = b.error || '';
    $('rejudge-btn').hidden = b.status === 'running';

    const judges = (b.judge_models || b.judge_model || '').split(',').filter(Boolean);
    const sorted = [...arms].sort((x, y) => (x.judge_rank ?? 99) - (y.judge_rank ?? 99));
    fillTable(
      $('detail-arms'),
      ['名次', '模型', '驗證', '平均分', ...judges, '輸出 token', '耗時', '變更', '任務', '評語'],
      sorted.map((a) => {
        let per = {};
        try {
          per = JSON.parse(a.scores_json || '{}') || {};
        } catch (e) { /* older rows */ }
        const perJudge = judges.map((j) => (per[j] ? fmt(per[j].total) : '–'));
        const task = el('a', null, a.task_status || '?');
        task.href = `/board.html#task=${encodeURIComponent(a.task_id)}`;
        const notes = el('details');
        notes.append(el('summary', null, '看評語'), el('p', 'summary', a.notes || '（無）'));
        return row([
          a.judge_rank ?? '–',
          a.model,
          VERIFY[a.verify_outcome] || '–',
          fmt(a.judge_score),
          ...perJudge,
          a.tokens_out,
          dur(a.duration_s),
          a.diff_stat || '–',
          task,
          a.notes ? notes : '–',
        ]);
      }),
    );

    $('detail-judges').replaceChildren(
      ...(judgements.length
        ? judgements.map((j) => {
            const card = el('div', 'judge-card');
            card.append(el('div', 'who', j.error ? `${j.judge_model}（失敗）` : `${j.judge_model}${j.winner ? ` · 選了 ${j.winner}` : ''}`));
            card.append(el('div', j.error ? 'err' : 'txt', j.error || j.summary || '（沒有摘要）'));
            return card;
          })
        : [el('p', 'hint', '還沒有評審意見。')]),
    );
  }

  $('back-btn').onclick = () => go('#list');
  $('rejudge-btn').onclick = async () => {
    if (!detailId) return;
    const btn = $('rejudge-btn');
    btn.disabled = true;
    btn.textContent = '評分中…（雲端模型，可能要幾分鐘）';
    try {
      await api(`/api/benchmarks/${encodeURIComponent(detailId)}/judge`, 'POST', {});
      await loadDetail(detailId);
    } catch (e) {
      $('detail-error').hidden = false;
      $('detail-error').textContent = `重新評分失敗：${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '重新評分';
    }
  };

  // ================= new view =================
  const draftState = { source: 'builtin', ref: null, models: new Set(), judges: new Set(['opus']), switchMin: 6 };

  function setSource(kind) {
    draftState.source = kind;
    draftState.ref = null;
    for (const t of $('source-tabs').querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.src === kind);
    for (const k of ['builtin', 'task', 'draft', 'manual']) $(`src-${k}`).hidden = k !== kind;
    paintEstimate();
  }
  for (const t of $('source-tabs').querySelectorAll('.tab')) t.onclick = () => setSource(t.dataset.src);

  function pickCard(opts) {
    const { id, title, sub, checked, disabled, onToggle } = opts;
    const label = el('label', `pick${checked ? ' on' : ''}${disabled ? ' off' : ''}`);
    const cb = el('input');
    cb.type = opts.radio ? 'radio' : 'checkbox';
    if (opts.radio) cb.name = opts.radio;
    cb.checked = Boolean(checked);
    cb.disabled = Boolean(disabled);
    cb.value = id;
    const txt = el('span');
    txt.append(el('span', 'b', title), el('span', 's', sub || ''));
    label.append(cb, txt);
    cb.onchange = () => {
      onToggle(cb.checked);
      label.classList.toggle('on', cb.checked);
      if (opts.radio) for (const other of label.parentElement.querySelectorAll('.pick')) other.classList.toggle('on', other.querySelector('input').checked);
      paintEstimate();
    };
    return label;
  }

  async function loadBuiltin() {
    const box = $('builtin-list');
    try {
      const { questions } = await api('/api/benchmarks/builtin');
      box.replaceChildren(
        ...questions.map((q) =>
          pickCard({
            id: q.key,
            radio: 'builtin',
            title: q.title,
            sub: `${q.domain} · ${q.complexity} · ${q.verification_steps[0]}`,
            checked: false,
            onToggle: (on) => {
              draftState.ref = on ? q.key : null;
            },
          }),
        ),
      );
    } catch (e) {
      box.replaceChildren(el('p', 'err', e.message));
    }
  }

  async function loadTasks() {
    const sel = $('task-select');
    sel.replaceChildren(el('option', null, '（選一張任務）'));
    try {
      // the board snapshot is the task list this deployment already serves
      const { cards } = await api('/api/board');
      for (const t of cards.filter((c) => !c.title.startsWith('[bench]')).slice(0, 200)) {
        const o = el('option', null, `${t.title}（${t.status}）`);
        o.value = t.id;
        sel.appendChild(o);
      }
    } catch (e) { /* board may be empty */ }
    sel.onchange = () => {
      draftState.ref = sel.value || null;
      paintEstimate();
    };
  }

  async function loadDrafts() {
    const sel = $('draft-select');
    sel.replaceChildren(el('option', null, '（選一份草稿）'));
    try {
      const { drafts } = await api('/api/prd/drafts?limit=50');
      for (const d of drafts) {
        const o = el('option', null, `${d.title}（第 ${d.step} 步 · ${d.updated_at}）`);
        o.value = d.id;
        sel.appendChild(o);
      }
    } catch (e) {
      sel.replaceChildren(el('option', null, 'PRD 精靈未啟用'));
    }
    sel.onchange = () => {
      draftState.ref = sel.value || null;
      paintEstimate();
    };
  }

  async function loadModelPicks() {
    const box = $('model-picks');
    const cards = [];
    let entries = null;
    try {
      const cat = await api('/api/local/catalog');
      entries = cat.entries.filter((e) => e.registered_id || e.action === 'switch');
      draftState.switchMin = 6;
    } catch (e) { /* local models disabled — fall back to the registered list */ }
    if (entries) {
      for (const e of entries) {
        const id = `local:${e.registered_id || e.recipe}`;
        const ready = e.action === 'switch';
        cards.push(
          pickCard({
            id,
            title: e.name + (e.loaded ? '（使用中）' : ''),
            sub: ready ? `本地 · ${gb(e.disk_bytes || e.size_bytes)}` : `不能參賽：${e.blocked_by || '未就緒'}`,
            disabled: !ready || !e.registered_id,
            checked: false,
            onToggle: (on) => (on ? draftState.models.add(id) : draftState.models.delete(id)),
          }),
        );
      }
    } else {
      try {
        const { models } = await api('/api/local/models');
        for (const m of models) {
          const id = `local:${m.id}`;
          cards.push(
            pickCard({
              id,
              title: m.display_name,
              sub: m.runnable ? '本地' : `不能參賽：${m.blocked_by || '未就緒'}`,
              disabled: !m.runnable,
              checked: false,
              onToggle: (on) => (on ? draftState.models.add(id) : draftState.models.delete(id)),
            }),
          );
        }
      } catch (e) { /* no local models at all */ }
    }
    for (const [id, name, sub] of CLOUD) {
      cards.push(
        pickCard({
          id,
          title: name,
          sub,
          checked: false,
          onToggle: (on) => (on ? draftState.models.add(id) : draftState.models.delete(id)),
        }),
      );
    }
    box.replaceChildren(...cards);

    $('judge-picks').replaceChildren(
      ...JUDGES.map(([id, name, sub]) =>
        pickCard({
          id,
          title: name,
          sub,
          checked: draftState.judges.has(id),
          onToggle: (on) => (on ? draftState.judges.add(id) : draftState.judges.delete(id)),
        }),
      ),
    );
  }

  function sourceLabel() {
    if (draftState.source === 'manual') return $('m-title').value.trim() || '（現場輸入）';
    if (!draftState.ref) return null;
    if (draftState.source === 'builtin') return `內建題：${draftState.ref}`;
    if (draftState.source === 'task') return $('task-select').selectedOptions[0]?.textContent || draftState.ref;
    return $('draft-select').selectedOptions[0]?.textContent || draftState.ref;
  }

  function paintEstimate() {
    const box = $('estimate');
    const models = [...draftState.models];
    const locals = models.filter((m) => m.startsWith('local:'));
    const problems = [];
    const label = sourceLabel();
    if (!label) problems.push('還沒選題目');
    if (draftState.source === 'manual' && !$('m-goal').value.trim()) problems.push('現場輸入要填目標');
    if (models.length < 2) problems.push('至少選 2 個參賽模型');
    if (!draftState.judges.size) problems.push('至少選 1 位評審');

    const switches = Math.max(0, locals.length);
    const minutes = switches * draftState.switchMin + models.length * 12 + draftState.judges.size * 3;
    box.replaceChildren();
    box.append(el('div', null, `題目：${label || '—'}`));
    box.append(el('div', null, `參賽：${models.length ? models.join('、') : '—'}`));
    box.append(el('div', null, `評審：${[...draftState.judges].join('、') || '—'}`));
    if (!problems.length) {
      box.append(el('div', null, `預計 ${minutes} 分鐘上下：切換本地模型 ${switches} 次（每次約 ${draftState.switchMin} 分鐘）＋ 每組實作時間 ＋ 評分。`));
      if (locals.length) box.append(el('div', 'hint', '評比期間對話頁會顯示「評比使用中」，模型切換鈕會鎖住；結束後自動切回原本的模型。'));
    } else {
      box.append(el('div', 'err', problems.join('；')));
    }
    $('bench-submit').disabled = problems.length > 0;
  }
  for (const id of ['m-title', 'm-goal']) $(id).oninput = paintEstimate;

  $('bench-submit').onclick = async () => {
    const btn = $('bench-submit');
    const err = $('form-err');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = '建立中…';
    const body = {
      source: { kind: draftState.source, ref: draftState.ref },
      models: [...draftState.models],
      judge_models: [...draftState.judges],
    };
    if (draftState.source === 'manual') {
      body.overrides = {
        title: $('m-title').value.trim(),
        goal: $('m-goal').value.trim(),
        repo_path: $('m-repo').value.trim(),
        base_branch: $('m-branch').value.trim() || 'main',
        verification_steps: $('m-verify').value.split('\n').map((s) => s.trim()).filter(Boolean),
        domain: $('m-domain').value,
      };
    }
    try {
      const { benchmark } = await api('/api/benchmarks', 'POST', body);
      go(`#b=${benchmark.id}`);
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '建立評比並排入佇列';
      paintEstimate();
    }
  };
  $('cancel-new').onclick = () => go('#list');
  $('nav-new').onclick = () => go('#new');

  // ================= routing =================
  let timer = null;
  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  async function render() {
    const hash = location.hash || '#list';
    const detail = /^#b=(.+)$/.exec(hash);
    $('view-list').hidden = Boolean(detail) || hash === '#new';
    $('view-detail').hidden = !detail;
    $('view-new').hidden = hash !== '#new';
    if (timer) clearInterval(timer);
    timer = null;
    try {
      if (detail) {
        await loadDetail(decodeURIComponent(detail[1]));
        timer = setInterval(() => loadDetail(detailId).catch(() => {}), 10000);
      } else if (hash === '#new') {
        await Promise.all([loadBuiltin(), loadTasks(), loadDrafts(), loadModelPicks()]);
        setSource(draftState.source);
      } else {
        await loadList();
        timer = setInterval(() => loadList().catch(() => {}), 15000);
      }
      $('disabled-note').hidden = true;
    } catch (e) {
      if (e.status === 404) {
        $('disabled-note').hidden = false;
        for (const v of ['view-list', 'view-detail', 'view-new']) $(v).hidden = true;
      } else {
        $('form-err').hidden = false;
        $('form-err').textContent = e.message;
      }
    }
  }

  window.addEventListener('hashchange', render);
  render();
})();
