(() => {
  'use strict';
  // ---- auth / token ----
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // textContent only — never innerHTML
    return e;
  };

  // ---- theme ----
  const themeBtn = $('theme-btn');
  const curMode = () => (document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light');
  const paint = () => { themeBtn.textContent = curMode() === 'dark' ? '☀' : '☾'; };
  themeBtn.onclick = () => {
    const next = curMode() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-mode', next);
    try { localStorage.setItem('loop_mode', next); } catch (e) {}
    paint();
  };
  paint();

  async function api(path, { method = 'GET', body } = {}) {
    const r = await fetch(path, {
      method,
      headers: { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
    if (!r.ok) throw new Error(j.error || j.message || t || r.statusText);
    return j;
  }

  const stagesOf = (p) => {
    if (Array.isArray(p.stages)) return p.stages;
    try { return (typeof p.def === 'string' ? JSON.parse(p.def) : p.def)?.stages || []; } catch { return []; }
  };

  const dialog = $('run-dialog');
  let currentName = null;

  function openRun(name) {
    currentName = name;
    $('run-title').textContent = `執行 pipeline：${name}`;
    $('run-note').hidden = true;
    $('run-form').reset();
    $('run-form').elements.namedItem('base_branch').value = 'main';
    dialog.showModal();
  }
  $('run-cancel').onclick = () => dialog.close();
  $('run-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value !== 'go') return;
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      goal: fd.get('goal'),
      repo_path: fd.get('repo_path'),
      base_branch: fd.get('base_branch') || 'main',
    };
    const env = (fd.get('environment') || '').trim();
    if (env) body.environment = env;
    const go = $('run-go'); go.disabled = true;
    try {
      const res = await api(`/api/pipelines/${encodeURIComponent(currentName)}/run`, { method: 'POST', body });
      const ids = res.task_ids || res.tasks || res.ids || [];
      const note = $('run-note');
      note.hidden = false;
      note.textContent = `✓ 已建立 ${Array.isArray(ids) ? ids.length : ''} 個階段任務並排程。回看板查看執行。`;
      setTimeout(() => dialog.close(), 1400);
    } catch (err) {
      const note = $('run-note'); note.hidden = false; note.style.color = 'var(--danger)';
      note.textContent = '執行失敗：' + err.message;
    } finally { go.disabled = false; }
  });

  async function load() {
    const list = $('list');
    list.replaceChildren();
    let pipes;
    try {
      const d = await api('/api/pipelines');
      pipes = d.pipelines || d.templates || (Array.isArray(d) ? d : []);
    } catch (err) {
      list.appendChild(el('div', 'note danger', '載入失敗：' + err.message));
      return;
    }
    if (!pipes.length) { list.appendChild(el('p', 'lead', '（目前沒有模板）')); return; }
    for (const p of pipes) {
      const card = el('div', 'pipe-card');
      card.appendChild(el('h3', null, p.name));
      if (p.description) card.appendChild(el('div', 'desc', p.description));
      const stages = stagesOf(p);
      const row = el('div', 'stages');
      stages.forEach((s, i) => {
        if (i) row.appendChild(el('span', 'arrow', '→'));
        const st = el('span', 'stage');
        st.appendChild(el('span', 'n', String(i + 1)));
        st.appendChild(el('span', null, s.name || s.stage || `stage ${i + 1}`));
        const bits = [];
        if (s.coding_tool) bits.push(s.coding_tool);
        if (s.verify_mode) bits.push('verify=' + s.verify_mode);
        if (s.environment) bits.push('env=' + s.environment);
        if (bits.length) st.appendChild(el('span', 'meta', bits.join(' · ')));
        row.appendChild(st);
      });
      card.appendChild(row);
      const btn = el('button', 'btn primary', '執行這條 pipeline');
      btn.type = 'button';
      btn.onclick = () => openRun(p.name);
      card.appendChild(btn);
      list.appendChild(card);
    }
  }

  load();
})();
