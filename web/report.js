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
    if (text != null) e.textContent = text; // textContent only, never raw HTML
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

  // ---- render generated markdown as DOM (DOM API only, no md->html package) ----
  // Simple line-based structure recognizer: "# "/"## " headings, "- "/"* " bullet
  // lists, blank-line-separated paragraphs. Good enough for the fixed report shape
  // (heading + bullet sections) this feature always produces.
  function renderMarkdown(container, md) {
    container.replaceChildren();
    let list = null;
    for (const raw of md.split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) { list = null; continue; }
      const h1 = line.match(/^#\s+(.*)/);
      const h2 = line.match(/^##\s+(.*)/);
      const li = line.match(/^[-*]\s+(.*)/);
      if (h2) { list = null; container.appendChild(el('h3', null, h2[1])); continue; }
      if (h1) { list = null; container.appendChild(el('h2', null, h1[1])); continue; }
      if (li) {
        if (!list) { list = el('ul'); container.appendChild(list); }
        list.appendChild(el('li', null, li[1]));
        continue;
      }
      list = null;
      container.appendChild(el('p', null, line));
    }
  }

  async function loadTemplates() {
    const select = $('f-template');
    try {
      const d = await api('/api/report/templates');
      const templates = d.templates || [];
      for (const t of templates) {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.description ? `${t.name} — ${t.description}` : t.name;
        select.appendChild(opt);
      }
    } catch (err) {
      // report disabled or unreachable — leave just the default option, form still usable
      // for the generate call itself (which will surface the same error on submit).
    }
  }

  function setNote(msg, isError) {
    const note = $('rpt-note');
    note.hidden = !msg;
    note.textContent = msg || '';
    note.className = 'rpt-note' + (isError ? ' danger' : '');
  }

  function renderMeta(meta) {
    const chips = $('rpt-meta-chips');
    chips.replaceChildren();
    if (!meta) return;
    if (meta.source) chips.appendChild(el('span', 'chip', `來源：${meta.source === 'live' ? '即時查詢' : meta.source === 'snapshot' ? '既有語料快照' : '無資料'}`));
    if (meta.project) chips.appendChild(el('span', 'chip', `專案：${meta.project}`));
    if (typeof meta.itemCount === 'number') chips.appendChild(el('span', 'chip mono', `項目數：${meta.itemCount}`));
    if (meta.template) chips.appendChild(el('span', 'chip', `範本：${meta.template}`));
  }

  const genBtn = $('gen-btn');
  const printBtn = $('print-btn');
  printBtn.onclick = () => window.print();

  genBtn.onclick = async () => {
    const description = $('f-description').value.trim();
    if (!description) { setNote('請先輸入描述', true); return; }
    const body = { description };
    const project = $('f-project').value.trim();
    if (project) body.project = project;
    const template = $('f-template').value;
    if (template) body.template = template;

    genBtn.disabled = true;
    setNote('產生中…', false);
    try {
      const res = await api('/api/report', { method: 'POST', body });
      renderMarkdown($('rpt-output'), res.markdown || '（無內容）');
      renderMeta(res.meta);
      printBtn.hidden = !res.markdown;
      setNote('', false);
    } catch (err) {
      setNote('產生失敗：' + err.message, true);
    } finally {
      genBtn.disabled = false;
    }
  };

  loadTemplates();
})();
