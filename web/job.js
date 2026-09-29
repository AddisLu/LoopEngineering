(() => {
  'use strict';
  const { api, el, toast, initChrome, stored, store } = window.Ops;
  const $ = (id) => document.getElementById(id);
  initChrome();

  const OPS = { '>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '>': '>', '<': '<' };
  const DRAFT_KEY = 'loop_job_draft';
  let options = { repos: [], models: [], default_model: null, local_task_window: '', morning_report_time: '' };
  let plans = [];
  let datasets = [];
  let step = 1;
  let checked = null; // the answers the last successful check was for
  const state = (() => {
    try {
      return { complexity: 'M', ...JSON.parse(stored(DRAFT_KEY) || '{}') };
    } catch (e) {
      return { complexity: 'M' };
    }
  })();
  const save = () => store(DRAFT_KEY, JSON.stringify(state));
  // prefilled from elsewhere (the board's 「用新工作重寫」 on a stuck draft): ?title=&expected=&symptom=
  {
    const q = new URLSearchParams(location.search);
    let prefilled = false;
    for (const k of ['title', 'symptom', 'expected']) {
      const v = q.get(k);
      if (v) {
        state[k] = v.slice(0, 4000);
        prefilled = true;
      }
    }
    if (prefilled) {
      save();
      history.replaceState(null, '', location.pathname);
    }
  }

  // ---- step navigation ----
  function go(n) {
    step = Math.max(1, Math.min(4, n));
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = Number(p.dataset.pane) !== step;
    for (const b of $('stepper').querySelectorAll('button')) {
      const s = Number(b.dataset.step);
      if (s === step) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.parentElement.classList.toggle('done', s < step && stepOk(s));
      b.querySelector('.dot').textContent = s < step && stepOk(s) ? '✓' : String(s);
    }
    $('prev-btn').hidden = step === 1;
    $('next-btn').hidden = step === 4;
    $('next-btn').textContent = step === 3 ? '下一步：確認送出' : '下一步';
    if (step === 3) loadPlans();
    window.scrollTo({ top: 0 });
  }
  function stepOk(s) {
    if (s === 1) return !!(state.repo_path && state.base_branch);
    if (s === 2) return !!((state.title || '').trim() && (state.expected || '').trim());
    if (s === 3) return !!state.plan_id && (!planNeedsDataset() || !!state.dataset);
    return true;
  }
  const planNeedsDataset = () => {
    const p = plans.find((x) => x.id === state.plan_id);
    return !!(p && p.dataset_root && p.steps.some((s) => s.includes('{dataset}')));
  };
  for (const b of $('stepper').querySelectorAll('button')) b.onclick = () => go(Number(b.dataset.step));
  $('prev-btn').onclick = () => go(step - 1);
  $('next-btn').onclick = () => {
    if (!stepOk(step)) {
      toast(step === 1 ? '請選軟體與分支' : step === 2 ? '請至少寫標題與「改好後應該怎樣」' : '請選驗證方案與圖資', 'bad');
      return;
    }
    go(step + 1);
  };

  // ---- 1 軟體 ----
  function renderRepos() {
    const box = $('repos');
    box.replaceChildren();
    if (!options.repos.length) {
      box.appendChild(el('p', 'empty', '還沒有可以改的軟體。請工程師把 repo 加進知識庫來源或 prd_repo_allowlist。'));
      return;
    }
    for (const r of options.repos) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.repo_path === r.path));
      b.appendChild(el('span', 'c-title', r.name));
      b.appendChild(el('span', 'c-desc', r.path));
      b.appendChild(el('span', 'c-meta', `${r.branches.length} 個分支${r.branch ? ` · 目前在 ${r.branch}` : ''}`));
      b.onclick = () => {
        if (state.repo_path !== r.path) {
          state.repo_path = r.path;
          state.base_branch = r.branch || r.branches[0] || 'main';
          state.plan_id = null;
          state.dataset = null;
          plans = [];
        }
        save();
        renderRepos();
        renderSummary();
      };
      box.appendChild(b);
    }
    const repo = options.repos.find((r) => r.path === state.repo_path);
    $('branch-field').hidden = !repo;
    if (repo) {
      const sel = $('branch');
      sel.replaceChildren();
      for (const br of repo.branches) {
        const o = el('option', null, br);
        o.value = br;
        sel.appendChild(o);
      }
      sel.value = state.base_branch || repo.branch || repo.branches[0];
      sel.onchange = () => {
        state.base_branch = sel.value;
        save();
        renderSummary();
      };
    }
  }

  // ---- 2 要改什麼 ----
  for (const k of ['title', 'symptom', 'expected', 'files', 'notes']) {
    $(k).value = state[k] || '';
    $(k).addEventListener('input', () => {
      state[k] = $(k).value;
      save();
      renderSummary();
    });
  }

  // ---- 3 怎麼驗證 ----
  async function loadPlans() {
    if (!state.repo_path) return;
    try {
      const r = await api(`/api/verify-plans?repo=${encodeURIComponent(state.repo_path)}`);
      plans = r.plans;
      renderPlans(r.hosts || []);
    } catch (e) {
      $('plans').replaceChildren(el('p', 'err', `讀不到驗證方案：${e.message}`));
    }
  }
  function hostName(h) {
    return !h ? '引擎主機（不在沙盒）' : h === 'local' ? '這台 Spark 的沙盒' : h;
  }
  function renderPlans(hosts) {
    const box = $('plans');
    box.replaceChildren();
    if (!plans.length) {
      const p = el('p', 'empty');
      p.appendChild(el('span', null, '這個軟體還沒有驗證方案。請工程師到「'));
      const a = el('a', null, '驗證方案');
      a.href = '/plans.html';
      p.appendChild(a);
      p.appendChild(el('span', null, '」新增一個（例如：編譯＋跑標準圖集＋比對檢出率）。'));
      box.appendChild(p);
    }
    for (const p of plans) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.plan_id === p.id));
      b.appendChild(el('span', 'c-title', p.name));
      b.appendChild(el('span', 'c-desc', p.description || p.steps.join(' → ')));
      const bits = [hostName(p.host), p.metrics ? `${p.metrics.split(';').length} 項門檻` : null, p.artifacts.length ? `收 ${p.artifacts.length} 種產出物` : null].filter(Boolean);
      b.appendChild(el('span', 'c-meta', bits.join(' · ')));
      b.onclick = () => {
        if (state.plan_id !== p.id) {
          state.plan_id = p.id;
          state.dataset = p.dataset_default || null;
          datasets = [];
        }
        save();
        renderPlans(hosts);
        renderSummary();
      };
      box.appendChild(b);
    }
    const plan = plans.find((x) => x.id === state.plan_id);
    $('plan-detail').hidden = !plan;
    $('dataset-section').hidden = !(plan && plan.dataset_root);
    $('manual-section').hidden = !(plan && plan.manual_checks.length);
    if (!plan) return;
    const host = hosts.find((h) => h.name === (plan.host || 'local'));
    const hb = $('plan-host');
    hb.replaceChildren();
    hb.appendChild(el('div', null, hostName(plan.host)));
    hb.appendChild(el('div', 'hint', host ? host.description : plan.host ? '（這台機台沒有登記或已停用）' : '驗證步驟直接在引擎主機執行'));
    const mb = $('plan-metrics');
    mb.replaceChildren();
    if (!plan.metrics) mb.appendChild(el('div', 'hint', '沒有數字門檻：驗證步驟全部成功就算通過'));
    for (const spec of (plan.metrics || '').split(';').map((s) => s.trim()).filter(Boolean)) {
      const m = spec.match(/^(\S+)\s*(>=|<=|==|!=|>|<)\s*(\S+)$/);
      const row = el('div', 'row');
      row.style.justifyContent = 'space-between';
      row.appendChild(el('span', 'mono', m ? m[1] : spec));
      row.appendChild(el('span', 'mono', m ? `${OPS[m[2]]} ${m[3]}` : ''));
      mb.appendChild(row);
    }
    const ul = $('plan-manual');
    ul.replaceChildren();
    for (const c of plan.manual_checks) ul.appendChild(el('li', null, c));
    if (plan.dataset_root) loadDatasets(plan);
  }
  async function loadDatasets(plan) {
    $('dataset-where').textContent = `機台：${hostName(plan.host)}；位置：${plan.dataset_root}`;
    const box = $('datasets');
    if (!datasets.length) {
      box.replaceChildren(el('p', 'empty', '讀取圖資清單…'));
      try {
        datasets = (await api(`/api/verify-plans/${encodeURIComponent(plan.id)}/datasets`)).datasets;
      } catch (e) {
        box.replaceChildren(el('p', 'err', `讀不到圖資：${e.message}`));
        return;
      }
    }
    box.replaceChildren();
    if (!datasets.length) box.appendChild(el('p', 'empty', '這個位置沒有圖資資料夾'));
    for (const d of datasets) {
      const label = el('label');
      const r = el('input');
      r.type = 'radio';
      r.name = 'dataset';
      r.checked = state.dataset === d.name;
      r.onchange = () => {
        state.dataset = d.name;
        save();
        renderSummary();
      };
      label.appendChild(r);
      label.appendChild(el('span', 'name', d.name));
      label.appendChild(el('span', 'grow'));
      label.appendChild(el('span', 'hint', d.images != null ? `${d.images.toLocaleString()} 張` : ''));
      box.appendChild(label);
    }
  }

  // ---- 4 確認送出 ----
  function renderModels() {
    const sel = $('model');
    sel.replaceChildren();
    const add = (value, text) => {
      const o = el('option', null, text);
      o.value = value;
      sel.appendChild(o);
    };
    for (const m of options.models) add(m.id, `本地模型 ${m.name}（不花雲端額度）`);
    for (const [v, t] of [['sonnet', 'Claude Sonnet（雲端）'], ['opus', 'Claude Opus（雲端，最強）']]) add(v, t);
    sel.value = state.model || options.default_model || (options.models[0] && options.models[0].id) || 'sonnet';
    state.model = sel.value;
    sel.onchange = () => {
      state.model = sel.value;
      save();
      renderSummary();
    };
  }
  for (const b of $('complexity').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.cx === state.complexity));
    b.onclick = () => {
      state.complexity = b.dataset.cx;
      for (const x of $('complexity').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      save();
    };
  }
  const payload = () => ({
    repo_path: state.repo_path,
    base_branch: state.base_branch,
    title: state.title || '',
    symptom: state.symptom || '',
    expected: state.expected || '',
    files: (state.files || '').split('\n').map((s) => s.trim()).filter(Boolean),
    notes: state.notes || '',
    plan_id: state.plan_id,
    dataset: state.dataset,
    model: state.model,
    complexity: state.complexity,
  });
  $('check-btn').onclick = async () => {
    $('check-btn').disabled = true;
    $('submit-btn').disabled = true;
    $('check-state').textContent = '本地模型正在讀需求…（約 10–60 秒）';
    $('problems').replaceChildren();
    try {
      const r = await api('/api/jobs/check', 'POST', payload());
      showCheck(r.check, r.markdown);
      checked = r.check.ok ? JSON.stringify(payload()) : null;
      $('submit-btn').disabled = !r.check.ok;
    } catch (e) {
      $('problems').replaceChildren(el('p', 'err', e.message));
    } finally {
      $('check-btn').disabled = false;
      $('check-state').textContent = '';
    }
  };
  function showCheck(c, md) {
    const box = el('div', `problems${c.ok ? ' ok' : ''}`);
    box.appendChild(el('strong', null, c.ok ? '需求清楚，可以送出' : '還有這些要補：'));
    const ul = el('ul');
    ul.style.margin = '0';
    for (const m of c.missing) ul.appendChild(el('li', null, m));
    for (const q of (c.llm && c.llm.questions) || []) ul.appendChild(el('li', null, `本地模型想問：${q}`));
    for (const w of c.warnings) ul.appendChild(el('li', null, `提醒：${w}`));
    if (ul.childNodes.length) box.appendChild(ul);
    $('problems').replaceChildren(box);
    $('prd-box').hidden = !md;
    $('prd').textContent = md || '';
  }
  $('submit-btn').onclick = async () => {
    if (checked !== JSON.stringify(payload())) {
      toast('內容改過了，請再檢查一次', 'bad');
      $('submit-btn').disabled = true;
      return;
    }
    $('submit-btn').disabled = true;
    $('check-state').textContent = '送出中…';
    try {
      const r = await api('/api/jobs', 'POST', payload());
      store(DRAFT_KEY, null);
      location.href = `/task.html?id=${encodeURIComponent(r.task.id)}`;
    } catch (e) {
      if (e.data && e.data.check) showCheck(e.data.check, e.data.markdown);
      else toast(e.message, 'bad');
      $('check-state').textContent = '';
    }
  };

  // ---- summary ----
  function renderSummary() {
    const dl = $('summary');
    dl.replaceChildren();
    const repo = options.repos.find((r) => r.path === state.repo_path);
    const plan = plans.find((p) => p.id === state.plan_id);
    const model = options.models.find((m) => m.id === state.model);
    const rows = [
      ['軟體', repo ? `${repo.name} · ${state.base_branch || ''}` : '還沒選'],
      ['要改什麼', (state.expected || state.title || '').trim() || '還沒寫'],
      ['驗證', plan ? `${plan.name}${state.dataset ? `，圖資 ${state.dataset}` : ''}；機台：${hostName(plan.host)}` : '還沒選'],
      ['誰來做', model ? `本地模型 ${model.name}（不花雲端額度）` : state.model || '預設'],
    ];
    for (const [k, v] of rows) {
      const d = el('div');
      d.appendChild(el('dt', null, k));
      d.appendChild(el('dd', null, v));
      dl.appendChild(d);
    }
    const w = options.local_task_window;
    $('when').textContent = [
      w && String(state.model || '').startsWith('local:') ? `本地模型的工作在 ${w} 之間開始。` : '有額度就會開始。',
      options.morning_report_time ? `每天 ${options.morning_report_time} 推播晨報。` : '',
      '完成後會出現在晨報，也可以從任務的驗收頁看進度。',
    ].join('');
  }

  (async () => {
    try {
      options = await api('/api/jobs/options');
    } catch (e) {
      $('page-err').textContent = `讀取失敗：${e.message}`;
      $('page-err').hidden = false;
    }
    renderRepos();
    renderModels();
    renderSummary();
    if (state.repo_path) await loadPlans();
    go(1);
  })();
})();
