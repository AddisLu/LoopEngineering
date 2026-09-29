(() => {
  'use strict';
  const { api, el, icon, toast, initChrome } = window.Ops;
  const $ = (id) => document.getElementById(id);
  initChrome();

  const OPS = [['>=', '≥'], ['<=', '≤'], ['==', '='], ['!=', '≠'], ['>', '>'], ['<', '<']];
  let plans = [];
  let hosts = [];
  let repos = [];
  let current = null; // plan id being edited, null = new

  async function load() {
    try {
      const [p, o] = await Promise.all([api('/api/verify-plans'), api('/api/jobs/options')]);
      plans = p.plans;
      hosts = p.hosts;
      repos = o.repos;
      fillSelects();
      renderList();
      edit(current && plans.find((x) => x.id === current) ? current : plans[0] ? plans[0].id : null);
    } catch (e) {
      $('page-err').textContent = `讀取失敗：${e.message}`;
      $('page-err').hidden = false;
    }
  }

  function fillSelects() {
    const repo = $('f-repo');
    repo.replaceChildren();
    const any = el('option', null, '所有軟體');
    any.value = '';
    repo.appendChild(any);
    for (const r of repos) {
      const o = el('option', null, `${r.name}（${r.path}）`);
      o.value = r.path;
      repo.appendChild(o);
    }
    const host = $('f-host');
    host.replaceChildren();
    const shell = el('option', null, '引擎主機（不在沙盒，直接執行）');
    shell.value = '';
    host.appendChild(shell);
    for (const h of hosts) {
      const o = el('option', null, h.name === 'local' ? '這台 Spark 的沙盒（local）' : `${h.name} — ${h.description}`);
      o.value = h.name;
      host.appendChild(o);
    }
  }

  function renderList() {
    const box = $('plan-list');
    box.replaceChildren();
    if (!plans.length) box.appendChild(el('p', 'hint', '還沒有方案。按「新增」建立第一個。'));
    for (const p of plans) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(p.id === current));
      b.appendChild(el('strong', null, p.name));
      const repo = p.repo_path ? p.repo_path.split('/').pop() : '所有軟體';
      const metrics = p.metrics ? `${p.metrics.split(';').length} 項門檻` : '沒有數字門檻';
      b.appendChild(el('span', 'hint', `${repo} · ${p.host || '引擎主機'} · ${metrics}`));
      b.onclick = () => edit(p.id);
      box.appendChild(b);
    }
  }

  function metricRow(spec) {
    const m = (spec || '').match(/^(\S+)\s*(>=|<=|==|!=|>|<)\s*(\S+)$/);
    const row = el('div', 'metric-row');
    const name = el('input');
    name.className = 'mono';
    name.placeholder = 'detection_rate';
    name.setAttribute('aria-label', '指標名稱');
    name.value = m ? m[1] : '';
    const op = el('select');
    op.setAttribute('aria-label', '比較');
    for (const [v, t] of OPS) {
      const o = el('option', null, t);
      o.value = v;
      op.appendChild(o);
    }
    op.value = m ? m[2] : '>=';
    const target = el('input');
    target.className = 'mono';
    target.placeholder = '0.98';
    target.setAttribute('aria-label', '門檻');
    target.value = m ? m[3] : '';
    const rm = el('button', 'icon-btn');
    rm.type = 'button';
    rm.setAttribute('aria-label', '移除這項門檻');
    rm.appendChild(icon('x'));
    rm.onclick = () => row.remove();
    row.append(name, op, target, rm);
    return row;
  }
  $('add-metric').onclick = () => $('f-metrics').appendChild(metricRow(''));

  function edit(id) {
    current = id;
    const p = plans.find((x) => x.id === id) || null;
    renderList();
    $('form-err').hidden = true;
    $('check-out').replaceChildren();
    $('delete-btn').hidden = !p;
    $('f-name').value = p ? p.name : '';
    $('f-repo').value = p && p.repo_path ? p.repo_path : '';
    $('f-host').value = p && p.host ? p.host : '';
    $('f-domain').value = p ? p.domain : 'cuda';
    $('f-desc').value = p && p.description ? p.description : '';
    $('f-steps').value = p ? p.steps.join('\n') : '';
    $('f-root').value = p && p.dataset_root ? p.dataset_root : '';
    $('f-default').value = p && p.dataset_default ? p.dataset_default : '';
    $('f-protect').value = p ? p.protected_paths.join(', ') : '';
    $('f-artifacts').value = p ? p.artifacts.join(', ') : '';
    $('f-manual').value = p ? p.manual_checks.join('\n') : '';
    $('f-setup').value = p && p.setup_cmd ? p.setup_cmd : '';
    const mb = $('f-metrics');
    mb.replaceChildren();
    for (const spec of (p && p.metrics ? p.metrics.split(';') : ['']).map((s) => s.trim())) mb.appendChild(metricRow(spec));
  }
  $('new-btn').onclick = () => edit(null);

  function formBody() {
    const metrics = [...$('f-metrics').querySelectorAll('.metric-row')]
      .map((r) => {
        const [name, op, target] = r.querySelectorAll('input, select');
        return name.value.trim() && target.value.trim() ? `${name.value.trim()} ${op.value} ${target.value.trim()}` : '';
      })
      .filter(Boolean)
      .join('; ');
    return {
      name: $('f-name').value,
      repo_path: $('f-repo').value || null,
      host: $('f-host').value || null,
      domain: $('f-domain').value,
      description: $('f-desc').value,
      steps: $('f-steps').value.split('\n'),
      dataset_root: $('f-root').value || null,
      dataset_default: $('f-default').value || null,
      metrics,
      protected_paths: $('f-protect').value,
      artifacts: $('f-artifacts').value,
      manual_checks: $('f-manual').value.split('\n'),
      setup_cmd: $('f-setup').value || null,
    };
  }

  $('plan-form').onsubmit = async (e) => {
    e.preventDefault();
    $('form-err').hidden = true;
    $('save-btn').disabled = true;
    try {
      const p = current ? await api(`/api/verify-plans/${encodeURIComponent(current)}`, 'PUT', formBody()) : await api('/api/verify-plans', 'POST', formBody());
      current = p.id;
      toast('已儲存');
      await load();
    } catch (err) {
      $('form-err').textContent = err.message;
      $('form-err').hidden = false;
    } finally {
      $('save-btn').disabled = false;
    }
  };

  $('delete-btn').onclick = async () => {
    const p = plans.find((x) => x.id === current);
    if (!p || !confirm(`刪除「${p.name}」？已經用它建立的任務不受影響。`)) return;
    try {
      await api(`/api/verify-plans/${encodeURIComponent(p.id)}`, 'DELETE');
      current = null;
      toast('已刪除');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  $('check-btn').onclick = async () => {
    if (!current) {
      toast('先儲存，再檢查', 'bad');
      return;
    }
    const out = $('check-out');
    out.replaceChildren(el('p', 'hint', '檢查中…（連到機台、看 Docker、映像、GPU、圖資，約 10–60 秒）'));
    $('check-btn').disabled = true;
    try {
      const r = await api(`/api/verify-plans/${encodeURIComponent(current)}/check`, 'POST', {});
      out.replaceChildren();
      const line = (ok, label, detail) => {
        const l = el('div', 'l');
        const i = icon(ok === false ? 'x' : ok ? 'check' : 'alert');
        i.style.width = '18px';
        i.style.height = '18px';
        i.style.flex = '0 0 auto';
        i.style.color = ok === false ? 'var(--danger)' : ok ? 'var(--ok)' : 'var(--warn)';
        l.appendChild(i);
        l.appendChild(el('span', null, `${label}：${detail}`));
        out.appendChild(l);
      };
      for (const c of r.lines) line(c.ok, c.label, c.detail);
      if (r.datasets) line(r.datasets.ok, '圖資', r.datasets.detail);
      out.appendChild(el('strong', null, r.ok ? '可以用了。' : '有項目要處理（見上面的 ✕）。'));
    } catch (err) {
      out.replaceChildren(el('p', 'err', err.message));
    } finally {
      $('check-btn').disabled = false;
    }
  };

  load();
})();
