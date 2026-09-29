(() => {
  'use strict';

  // ---- auth / token (same bootstrap as app.js) --------------------------
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  // a link a plain <a href> can open: the API takes the token as ?token= too
  const withToken = (p) => (TOKEN ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : p);

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
  const STATUS = { running: '進行中', judging: '評分中', judged: '已評分', judge_failed: '評分失敗', cancelled: '已取消' };
  const DOMAIN = { cuda: 'CUDA／GPU', cv: '影像處理', cpp: 'C++', csharp: 'C#', typescript: 'TypeScript', python: 'Python', other: '其他' };
  const domainLabel = (d) => DOMAIN[d] || d || '其他';
  // SQLite writes UTC; show it in the operator's own clock
  const localTime = (s) => {
    if (!s) return '–';
    const d = new Date(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return isNaN(d) ? s : d.toLocaleString('zh-TW', { hour12: false }).replace(/:\d\d$/, '');
  };
  const VERIFY = { pass: '通過', manual: '待人工', fail: '失敗' };
  const CONSENSUS = { unanimous: '評審一致', split: '評審分歧', single: '單一評審' };
  // the same wording the dock uses for a task's state
  const TASK_LABEL = { draft: '草稿', ready: '就緒', queued: '排隊中', blocked: '卡住', running: '執行中', verifying: '驗證中', review: '待結案', attention: '要你處理', failed: '失敗', closed: '已結案' };
  const taskLabel = (s) => TASK_LABEL[s] || s || '未知';
  const SOURCE = { builtin: '內建題庫', task: '看板任務', draft: 'PRD 草稿', manual: '自己出題' };
  // id -> human name, filled from the local catalog; the page never shows a raw id if it can help it
  const MODEL_NAMES = new Map();
  const modelName = (id) => MODEL_NAMES.get(id) || String(id || '').replace(/^local:/, '');
  const CLOUD = [
    ['sonnet', 'Sonnet', '雲端 · 快、便宜'],
    ['opus', 'Opus', '雲端 · 最強，最貴'],
    ['haiku', 'Haiku', '雲端 · 最便宜'],
  ];
  for (const [id, name] of [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']]) MODEL_NAMES.set(id, name);
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
  // the list and detail views have no error slot of their own; #form-err lives inside 新評比
  function pageError(msg) {
    const box = $('page-err');
    box.hidden = !msg;
    box.textContent = msg || '';
  }

  // ================= list view =================
  let summary = { running: null, recent: [], models: [] };
  let allBenchmarks = [];

  async function loadList() {
    summary = await api('/api/benchmarks/summary');
    allBenchmarks = (await api('/api/benchmarks')).benchmarks;
    await Promise.all([paintMatrix(), paintRecommend()]);

    const run = summary.running;
    $('running-box').hidden = !run;
    if (run) {
      $('running-line').replaceChildren(
        el('b', null, run.title),
        el('span', null, `　${STATUS[run.status] || run.status} · ${run.arms_done}/${run.arm_count} 組完成 · ${run.models.map(modelName).join('、')}`),
      );
      $('running-line').onclick = () => go(`#b=${run.id}`);
      $('running-line').style.cursor = 'pointer';
    }

    fillTable(
      $('records'),
      ['模型', '參賽', '勝場', '平均分', '驗證通過率'],
      summary.models.map((m) => row([m.label, m.n, m.wins, fmt(m.avg_score), pct(m.verify_pass_rate)])),
    );
    paintBenchList();
  }

  const kindLabel = (m) => (m.local ? '本地' : '雲端');

  // 模型 × 領域, narrowed by software type, local/cloud, pass rate and sample size
  async function paintMatrix() {
    const q = new URLSearchParams();
    for (const [id, key] of [['mx-domain', 'domain'], ['mx-kind', 'kind'], ['mx-pass', 'min_pass'], ['mx-n', 'min_n']]) {
      if ($(id).value) q.set(key, $(id).value);
    }
    const { matrix } = await api(`/api/benchmarks/matrix${q.toString() ? `?${q}` : ''}`);
    $('matrix-empty').hidden = matrix.length > 0;
    fillTable(
      $('matrix'),
      ['領域', '模型', '類型', '場數', '通過率', '一次就過', '第幾次過', '用 ncu', '平均分數', '勝率', '平均輸出 token', '平均耗時'],
      matrix.map((m) =>
        row([
          domainLabel(m.domain),
          m.model_label || modelName(m.model),
          kindLabel(m),
          m.n,
          el('span', 'heat', pct(m.verify_pass_rate)),
          pct(m.first_try_rate),
          fmt(m.avg_passed_at),
          pct(m.profiler_rate),
          fmt(m.avg_score),
          pct(m.win_rate),
          m.avg_tokens_out,
          dur(m.avg_duration_s),
        ]),
      ),
    );
  }
  for (const id of ['mx-domain', 'mx-kind', 'mx-pass', 'mx-n']) $(id).onchange = () => paintMatrix().catch((e) => pageError(e.message));

  // which local model to hand each kind of software to, next to the best cloud model
  async function paintRecommend() {
    const { recommendations } = await api('/api/benchmarks/recommend');
    $('recommend-empty').hidden = recommendations.length > 0;
    const who = (m) => (m ? `${m.model_label || modelName(m.model)}（${m.n} 場 · 通過 ${pct(m.verify_pass_rate)} · 一次就過 ${pct(m.first_try_rate)}）` : '–');
    fillTable(
      $('recommend'),
      ['軟體類型', '建議的本地模型', '雲端對照', '結論'],
      recommendations.map((r) => row([domainLabel(r.domain), who(r.local), who(r.cloud), r.verdict])),
    );
  }

  // the final re-measurement (or the arm's own verification) in one cell: verdict + the thresholds
  function finalCell(a) {
    let f = null;
    try {
      f = a.final_json ? JSON.parse(a.final_json) : null;
    } catch (e) { /* older rows */ }
    if (!f) return VERIFY[a.verify_outcome] || '–';
    const checks = (f.checks || []).map((c) => `${c.name} ${c.actual == null ? '—' : Math.round(c.actual * 1000) / 1000}${c.pass ? '' : ` ✗(${c.op}${c.target})`}`);
    const head = f.outcome === 'pass' ? '通過' : f.outcome === 'metrics' ? '指標未達' : f.outcome === 'protected' ? '改了保護路徑' : '功能沒過';
    return `${head}${checks.length ? `：${checks.join('、')}` : ''}`;
  }
  function iterCell(a) {
    try {
      return (a.attempts_json && JSON.parse(a.attempts_json).label) || '–';
    } catch (e) {
      return '–';
    }
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
            localTime(b.created_at),
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
    chips.push(chip(domainLabel(b.domain)), chip(`${arms.length} 組`), chip(`評審：${(b.judge_models || b.judge_model || '').split(',').join('、')}`), chip(localTime(b.created_at)));
    $('detail-chips').replaceChildren(...chips);
    const src = [SOURCE[b.source_kind] || '–', b.source_ref, b.repo_path].filter(Boolean).join(' · ');
    const live = b.status === 'running' || b.status === 'judging';
    $('detail-source').textContent = `題目來源：${src}`;
    $('detail-summary').textContent = b.summary || (b.status === 'judged' ? '' : '還沒有評分結果。');
    $('detail-error').hidden = !b.error;
    $('detail-error').textContent = b.error || '';
    // re-judging a finished benchmark is exactly what the button is for; only a live run blocks it
    $('rejudge-btn').hidden = live || b.status === 'cancelled';
    $('cancel-bench-btn').hidden = !live;
    $('delete-bench-btn').hidden = live;
    $('detail-actions-hint').textContent = live
      ? '取消會把還沒跑完的組別標成失敗，並把機器讓出來。'
      : '重新評分會再花一次雲端額度（每位評審一次）；刪除只移除這次比較，任務會留在看板。';

    const judges = (b.judge_models || b.judge_model || '').split(',').filter(Boolean);
    const sorted = [...arms].sort((x, y) => (x.judge_rank ?? 99) - (y.judge_rank ?? 99));
    $('report-link').hidden = false;
    $('report-link').href = withToken(`/api/benchmarks/${encodeURIComponent(id)}/report.md`);
    fillTable(
      $('detail-arms'),
      ['名次', '模型', '最終量測', '迭代', '平均分', ...judges, '輸出 token', '耗時', '變更', '任務', '評語'],
      sorted.map((a) => {
        let per = {};
        try {
          per = JSON.parse(a.scores_json || '{}') || {};
        } catch (e) { /* older rows */ }
        const perJudge = judges.map((j) => (per[j] ? fmt(per[j].total) : '–'));
        const task = el('a', null, a.task_status ? taskLabel(a.task_status) : '任務已刪除');
        task.href = `/board.html#task=${encodeURIComponent(a.task_id)}`;
        const notes = el('details');
        notes.append(el('summary', null, '看評語'), el('p', 'summary', a.notes || '（無）'));
        return row([
          a.judge_rank ?? '–',
          a.model_label || modelName(a.model),
          finalCell(a),
          iterCell(a),
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

  $('cancel-bench-btn').onclick = async () => {
    if (!detailId) return;
    if (!window.confirm('取消這次評比？還沒跑完的組別會標成失敗，機器讓出來給下一個評比。')) return;
    const btn = $('cancel-bench-btn');
    btn.disabled = true;
    try {
      await api(`/api/benchmarks/${encodeURIComponent(detailId)}/cancel`, 'POST', {});
      await loadDetail(detailId);
    } catch (e) {
      pageError(`取消失敗：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  };

  $('delete-bench-btn').onclick = async () => {
    if (!detailId) return;
    if (!window.confirm('刪除這次評比的比較結果？每個模型跑出來的任務會留在看板上。')) return;
    const btn = $('delete-bench-btn');
    btn.disabled = true;
    try {
      await api(`/api/benchmarks/${encodeURIComponent(detailId)}`, 'DELETE');
      go('#list');
    } catch (e) {
      pageError(`刪不掉：${e.message}`);
      btn.disabled = false;
    }
  };

  // ================= new view =================
  const draftState = { source: 'task', ref: null, models: new Set(), judges: new Set(['opus']), switchMin: 6 };
  let usage = null; // { session, weekly } percent of the subscription window, from /api/board
  let runningNow = null; // a benchmark already owns the machine: only one at a time

  function setSource(kind) {
    draftState.source = kind;
    draftState.ref = null;
    for (const t of $('source-tabs').querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.src === kind);
    for (const k of ['task', 'draft', 'manual', 'builtin']) $(`src-${k}`).hidden = k !== kind;
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

  const taskGate = new Map(); // task id -> passes the PRD gate (can be used as a question)
  // the gate speaks in column names; this page is Chinese all the way through
  const GATE_FIELD = { plan_ref: '計畫檔', repo_path: 'repo 路徑', base_branch: '分支', verification_steps: '驗證指令', goal: '目標', verify_rubric: '驗收標準', setup_cmd: '前置指令', requires: '執行環境' };
  const gateLabel = (m) => GATE_FIELD[String(m).split(/[ (]/)[0]] || String(m).split(/[ (]/)[0];

  async function loadTasks() {
    const sel = $('task-select');
    sel.replaceChildren(el('option', null, '（選一張任務）'));
    try {
      // the board snapshot is the task list this deployment already serves — show all of it, so
      // "what is on my board" and "what can I benchmark" are the same list
      const board = await api('/api/board');
      const { cards } = board;
      usage = board.usage || null;
      runningNow = board.benchmark || null;
      taskGate.clear();
      for (const t of cards.slice(0, 200)) {
        const arm = t.title.startsWith('[bench]');
        const ok = !t.gate || t.gate.ok !== false;
        taskGate.set(t.id, ok);
        const why = ok ? '' : ` · 缺 ${(t.gate.missing || []).map(gateLabel).join('、') || '必填欄位'}`;
        const o = el('option', null, `${t.title}（${taskLabel(t.status)}${arm ? ' · 評比用' : ''}${why}）`);
        o.value = t.id;
        sel.appendChild(o);
      }
      if (!cards.length) sel.appendChild(el('option', null, '看板上還沒有任務'));
    } catch (e) {
      sel.replaceChildren(el('option', null, `讀不到看板：${e.message}`));
    }
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
        // a draft the wizard never composed has no markdown, so the gate has nothing to read
        const ready = d.has_markdown !== 0;
        const o = el('option', null, `${d.title}（第 ${d.step} 步 · ${localTime(d.updated_at)}${ready ? '' : ' · 還沒按過「檢查」，不能當題目'}）`);
        o.value = d.id;
        o.disabled = !ready;
        sel.appendChild(o);
      }
      if (!drafts.length) sel.appendChild(el('option', null, '還沒有草稿'));
    } catch (e) {
      sel.replaceChildren(el('option', null, 'PRD 精靈未啟用'));
    }
    sel.onchange = () => {
      draftState.ref = sel.value || null;
      paintEstimate();
    };
  }

  // 驗證方案 for a typed-in question: the same measured bar for every arm
  async function loadPlans() {
    const sel = $('m-plan');
    sel.replaceChildren(el('option', null, '不用方案'));
    sel.firstChild.value = '';
    try {
      const { plans } = await api('/api/verify-plans');
      for (const p of plans) {
        const o = el('option', null, `${p.name}${p.metrics ? `（門檻：${p.metrics}）` : ''}`);
        o.value = p.id;
        o.dataset.repo = p.repo_path || '';
        o.dataset.domain = p.domain || '';
        sel.appendChild(o);
      }
    } catch (e) { /* the question can still be typed in full */ }
    sel.onchange = () => {
      const o = sel.selectedOptions[0];
      if (o && o.value) {
        if (!$('m-repo').value.trim() && o.dataset.repo) $('m-repo').value = o.dataset.repo;
        if (o.dataset.domain) $('m-domain').value = o.dataset.domain;
      }
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
      for (const e of cat.entries) if (e.registered_id) MODEL_NAMES.set(`local:${e.registered_id}`, e.name);
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
    if (draftState.source === 'manual') return $('m-title').value.trim() || '（自己出題）';
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
    if (draftState.source === 'manual' && !$('m-goal').value.trim()) problems.push('自己出題要填目標');
    if (draftState.source === 'manual' && !$('m-repo').value.trim() && !$('m-plan').value) problems.push('自己出題要填 Repo 路徑（或選一個有 repo 的驗證方案）');
    if (draftState.source === 'manual' && !$('m-plan').value && !$('m-verify').value.trim()) problems.push('自己出題要填驗證指令（或選一個驗證方案）');
    if (draftState.source === 'task' && taskGate.get(draftState.ref) === false) problems.push('這張任務還缺 repo 或計畫，先在看板補齊才能當題目');
    if (models.length < 2) problems.push('至少選 2 個參賽模型');
    if (!draftState.judges.size) problems.push('至少選 1 位評審');

    const cloud = models.filter((m) => !m.startsWith('local:'));
    if (runningNow) problems.push(`已經有一個評比在跑：「${runningNow.title}」，先讓它跑完或取消`);

    const switches = Math.max(0, locals.length);
    const minutes = switches * draftState.switchMin + models.length * 12 + draftState.judges.size * 3;
    box.replaceChildren();
    box.append(el('div', null, `題目：${label || '—'}`));
    box.append(el('div', null, `參賽：${models.length ? models.map(modelName).join('、') : '—'}`));
    box.append(el('div', null, `評審：${[...draftState.judges].map(modelName).join('、') || '—'}`));
    if (!problems.length) {
      box.append(el('div', null, `預計 ${minutes} 分鐘上下：切換本地模型 ${switches} 次（每次約 ${draftState.switchMin} 分鐘）＋ 每組實作時間 ＋ 評分。`));
      // the only thing that spends the subscription is cloud arms and the judges
      const spend = cloud.length + draftState.judges.size;
      const now = usage ? `目前用量 session ${usage.session}%、weekly ${usage.weekly}%` : '用量讀不到';
      box.append(el('div', 'hint', `會花訂閱額度的有 ${spend} 次雲端呼叫：參賽 ${cloud.length} 組＋評審 ${draftState.judges.size} 位。${now}。`));
      if (usage && (usage.session >= 70 || usage.weekly >= 80) && spend > 0) {
        box.append(el('div', 'err', `用量偏高（session ${usage.session}%、weekly ${usage.weekly}%），雲端組別可能會被排到額度回補之後才跑。`));
      }
      if (locals.length) box.append(el('div', 'hint', '評比期間對話頁會顯示「評比使用中」，模型切換鈕會鎖住；結束後自動切回原本的模型。'));
    } else {
      box.append(el('div', 'err', problems.join('；')));
    }
    $('bench-submit').disabled = problems.length > 0;
  }
  for (const id of ['m-title', 'm-goal', 'm-repo', 'm-verify']) $(id).oninput = paintEstimate;

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
        ...($('m-plan').value ? { verify_plan_id: $('m-plan').value } : {}),
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
      pageError('');
      if (detail) {
        await loadDetail(decodeURIComponent(detail[1]));
        timer = setInterval(() => loadDetail(detailId).catch((e) => pageError(`更新不了這頁：${e.message}`)), 10000);
      } else if (hash === '#new') {
        await Promise.all([loadBuiltin(), loadTasks(), loadDrafts(), loadPlans(), loadModelPicks()]);
        setSource(draftState.source);
      } else {
        await loadList();
        timer = setInterval(() => loadList().catch((e) => pageError(`更新不了列表：${e.message}`)), 15000);
      }
      $('disabled-note').hidden = true;
    } catch (e) {
      if (e.status === 404) {
        $('disabled-note').hidden = false;
        for (const v of ['view-list', 'view-detail', 'view-new']) $(v).hidden = true;
      } else if (hash === '#new') {
        $('form-err').hidden = false;
        $('form-err').textContent = e.message;
      } else {
        pageError(e.message);
      }
    }
  }

  window.addEventListener('hashchange', render);
  render();
})();
