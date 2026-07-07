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

  async function api(path, { method = 'GET', body, signal } = {}) {
    const r = await fetch(path, {
      method,
      headers: { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const t = await r.text();
    let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
    if (!r.ok) throw new Error(j.error || j.message || t || r.statusText);
    return j;
  }

  // ---- Mermaid: loaded on demand from the local vendor bundle (never a CDN) ----
  // securityLevel 'strict' sanitizes the SVG mermaid.render() returns — that sanitized
  // SVG is the ONE controlled exception to this file's textContent-only rule (see
  // appendMermaidBlock below); everything else stays DOM-API/textContent, no innerHTML.
  let mermaidLoadPromise = null;
  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (!mermaidLoadPromise) {
      mermaidLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/mermaid.min.js';
        s.onload = () => {
          if (!window.mermaid) { reject(new Error('mermaid.min.js loaded but window.mermaid is missing')); return; }
          window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
          resolve(window.mermaid);
        };
        s.onerror = () => reject(new Error('failed to load /vendor/mermaid.min.js'));
        document.head.appendChild(s);
      });
    }
    return mermaidLoadPromise;
  }

  let mermaidSeq = 0;

  async function appendMermaidBlock(container, mmd) {
    const wrap = el('div', 'mmd-block');
    const actions = el('div', 'mmd-actions no-print');
    const copyBtn = el('button', 'btn sm', '複製 Mermaid 原始碼');
    copyBtn.type = 'button';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(mmd);
        copyBtn.textContent = '已複製';
      } catch (e) {
        copyBtn.textContent = '複製失敗';
      }
      setTimeout(() => { copyBtn.textContent = '複製 Mermaid 原始碼'; }, 1500);
    };
    actions.appendChild(copyBtn);
    wrap.appendChild(actions);

    const target = el('div', 'mmd-render');
    wrap.appendChild(target);
    container.appendChild(wrap);

    try {
      const mermaid = await loadMermaid();
      const id = `mmd-${Date.now()}-${mermaidSeq++}`;
      const { svg } = await mermaid.render(id, mmd);
      target.innerHTML = svg; // controlled exception — see comment above loadMermaid
    } catch (err) {
      target.replaceChildren();
      const pre = el('pre', 'mmd-fallback');
      pre.appendChild(el('code', null, mmd));
      target.appendChild(pre);
    }
  }

  // ---- render generated markdown as DOM (DOM API only, no md->html package) ----
  // Simple line-based structure recognizer: "#"/"##"/"###" headings, "- "/"* " bullet
  // lists, blank-line-separated paragraphs, and ```mermaid fenced blocks (rendered via
  // Mermaid — see appendMermaidBlock; any other fenced block renders as plain <pre><code>
  // text). Good enough for the fixed report shape this feature always produces.
  async function renderMarkdown(container, md) {
    container.replaceChildren();
    const lines = md.split('\n');
    let list = null;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trimEnd();
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && lines[i].trimEnd() !== '```') { body.push(lines[i]); i++; }
        i++; // skip the closing fence (or run off the end if unterminated)
        list = null;
        if (lang === 'mermaid') {
          await appendMermaidBlock(container, body.join('\n'));
        } else {
          const pre = el('pre');
          pre.appendChild(el('code', null, body.join('\n')));
          container.appendChild(pre);
        }
        continue;
      }
      if (!line.trim()) { list = null; i++; continue; }
      const h1 = line.match(/^#\s+(.*)/);
      const h2 = line.match(/^##\s+(.*)/);
      const h3 = line.match(/^###\s+(.*)/);
      const li = line.match(/^[-*]\s+(.*)/);
      if (h3) { list = null; container.appendChild(el('h4', null, h3[1])); i++; continue; }
      if (h2) { list = null; container.appendChild(el('h3', null, h2[1])); i++; continue; }
      if (h1) { list = null; container.appendChild(el('h2', null, h1[1])); i++; continue; }
      if (li) {
        if (!list) { list = el('ul'); container.appendChild(list); }
        list.appendChild(el('li', null, li[1]));
        i++;
        continue;
      }
      list = null;
      container.appendChild(el('p', null, line));
      i++;
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

  function renderMeta(meta, files) {
    const chips = $('rpt-meta-chips');
    chips.replaceChildren();
    if (!meta) return;
    if (meta.source) chips.appendChild(el('span', 'chip', `來源：${meta.source === 'live' ? '即時查詢' : meta.source === 'snapshot' ? '既有語料快照' : '無資料'}`));
    if (meta.project) chips.appendChild(el('span', 'chip', `專案：${meta.project}`));
    if (typeof meta.itemCount === 'number') chips.appendChild(el('span', 'chip mono', `項目數：${meta.itemCount}`));
    if (meta.template) chips.appendChild(el('span', 'chip', `範本：${meta.template}`));
    if (meta.charts && meta.charts.length) chips.appendChild(el('span', 'chip', `圖表：${meta.charts.join('/')}`));
    if (files && files.length) chips.appendChild(el('span', 'chip', `已存檔：${files.length} 個檔案`));
  }

  const genBtn = $('gen-btn');
  const printBtn = $('print-btn');
  printBtn.onclick = () => window.print();

  // Progress stages shown while POST /api/report is in flight. There's no server-side
  // progress channel (it's one request/response) -- this is a time-based heuristic that
  // roughly mirrors generateReport's own sequence (parse -> fetch -> synth, see
  // src/report/generate.ts), so "產生中…" doesn't look stalled on a 70-90s call.
  const STAGE_HINTS = [
    { afterSec: 0, label: '解析描述中…' },
    { afterSec: 4, label: '抓取專案資料中…' },
    { afterSec: 12, label: '產生報告內容中…' },
  ];
  const CLIENT_TIMEOUT_MS = 120_000;

  genBtn.onclick = async () => {
    const description = $('f-description').value.trim();
    if (!description) { setNote('請先輸入描述', true); return; }
    const body = { description };
    const project = $('f-project').value.trim();
    if (project) body.project = project;
    const template = $('f-template').value;
    if (template) body.template = template;
    if ($('f-save').checked) body.save = true;

    genBtn.disabled = true;
    const startedAt = Date.now();
    const tick = () => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      let stage = STAGE_HINTS[0].label;
      for (const s of STAGE_HINTS) { if (elapsedSec >= s.afterSec) stage = s.label; }
      setNote(`${stage}（已等待 ${elapsedSec} 秒）`, false);
    };
    tick();
    const timer = setInterval(tick, 1000);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await api('/api/report', { method: 'POST', body, signal: controller.signal });
      await renderMarkdown($('rpt-output'), res.markdown || '（無內容）');
      renderMeta(res.meta, res.files);
      printBtn.hidden = !res.markdown;
      setNote('', false);
    } catch (err) {
      setNote(err.name === 'AbortError' ? '產生逾時，請稍後再試' : '產生失敗：' + err.message, true);
    } finally {
      clearInterval(timer);
      clearTimeout(abortTimer);
      genBtn.disabled = false;
    }
  };

  loadTemplates();
})();
