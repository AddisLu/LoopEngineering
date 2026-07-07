(() => {
  'use strict';
  // ============================================================
  // Loop Engineering — 報告 Deck front-end.
  // Turns a generated report (markdown + meta.stats + meta.items + Mermaid charts)
  // into a full-board, 16:9 (1920×1080) navigable slide deck, exportable to
  // PDF / PNG / standalone HTML / PPTX. Rendering is DOM-API/textContent only; the
  // SOLE innerHTML use is the sanitized Mermaid SVG (see renderMermaidInto).
  // ============================================================

  // ---- auth / token ----
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  // XML namespaces for the PNG rasteriser's <foreignObject> (identifiers, never fetched).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // textContent only, never raw markup
    return e;
  };
  const add = (parent, ...kids) => {
    for (const k of kids) if (k != null) parent.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    return parent;
  };
  // Render **bold** inline spans as real <b> nodes via the DOM API (no innerHTML).
  const inline = (parent, text) => {
    String(text).split('**').forEach((seg, i) => {
      if (!seg) return;
      if (i % 2 === 1) parent.appendChild(el('b', null, seg));
      else parent.appendChild(document.createTextNode(seg));
    });
    return parent;
  };

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

  // ---- vendored script loaders (local /vendor bundles only, never a CDN) ----
  const scriptCache = {};
  function loadScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(globalName ? window[globalName] : true);
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }
  async function loadMermaid() {
    const m = await loadScript('/vendor/mermaid.min.js', 'mermaid');
    if (!m) throw new Error('mermaid.min.js loaded but window.mermaid is missing');
    if (!loadMermaid._init) {
      // securityLevel 'strict' sanitizes the SVG mermaid.render() returns.
      m.initialize({ startOnLoad: false, securityLevel: 'strict' });
      loadMermaid._init = true;
    }
    return m;
  }

  let mermaidSeq = 0;
  // The one controlled innerHTML: mermaid.render() output, sanitized by securityLevel 'strict'.
  async function renderMermaidInto(target, code) {
    try {
      const mermaid = await loadMermaid();
      const id = `mmd-${Date.now()}-${mermaidSeq++}`;
      const { svg } = await mermaid.render(id, code);
      target.innerHTML = svg; // controlled exception — sanitized mermaid SVG only
    } catch (err) {
      target.replaceChildren(add(el('pre', 'chart-fallback'), el('code', null, code)));
    }
  }

  // ---- deck CSS text (for standalone-HTML + PNG export), fetched once ----
  let deckCssPromise = null;
  const getDeckCss = () => (deckCssPromise || (deckCssPromise = fetch('/report.css').then((r) => r.text()).catch(() => '')));

  // ============================================================
  // Markdown → structured sections
  // ============================================================
  // Recognises: "# title", "## section", "### sub", "- / *" bullets, blank-line
  // paragraphs, and ```mermaid fenced blocks. Good enough for the fixed report shape.
  function parseReport(md) {
    const lines = md.split('\n');
    const out = { title: '', sections: [] };
    let cur = null;
    const ensure = (heading) => { cur = { heading: heading || '', blocks: [] }; out.sections.push(cur); return cur; };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].replace(/\s+$/, '');
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && lines[i].replace(/\s+$/, '') !== '```') { body.push(lines[i]); i++; }
        i++; // skip closing fence
        if (!cur) ensure('');
        cur.blocks.push(lang === 'mermaid' ? { type: 'mermaid', code: body.join('\n') } : { type: 'pre', text: body.join('\n') });
        continue;
      }
      const h1 = line.match(/^#\s+(.*)/);
      const h2 = line.match(/^##\s+(.*)/);
      const h3 = line.match(/^###\s+(.*)/);
      const li = line.match(/^\s*[-*]\s+(.*)/);
      if (h3) { if (!cur) ensure(''); cur.blocks.push({ type: 'h3', text: h3[1].trim() }); i++; continue; }
      if (h2) { ensure(h2[1].trim()); i++; continue; }
      if (h1) { if (!out.title) out.title = h1[1].trim(); i++; continue; }
      if (li) {
        if (!cur) ensure('');
        let blk = cur.blocks[cur.blocks.length - 1];
        if (!blk || blk.type !== 'ul') { blk = { type: 'ul', items: [] }; cur.blocks.push(blk); }
        blk.items.push(li[1].trim());
        i++;
        continue;
      }
      if (line.trim()) { if (!cur) ensure(''); cur.blocks.push({ type: 'p', text: line.trim() }); }
      i++;
    }
    return out;
  }

  const CHART_SECTION = '圖表';
  const bulletTone = (t) => {
    if (/逾期|超期|風險|紅燈|卡住|卡點|落後|未結|delay|overdue|🔴/i.test(t)) return 'c';
    if (/完成|已結案|100%|done|✅|🟢|上線|達成|通過/i.test(t)) return 'g';
    if (/待|注意|簽核|剩|待辦|留意|警示|🟡/i.test(t)) return 'w';
    return '';
  };

  function resolvePersona(meta, fallback) {
    const name = (meta && meta.template) || fallback || '';
    if (/plant|廠長/i.test(name)) return 'plant';
    if (/manager|經理/i.test(name)) return 'manager';
    if (/pm|detailed|逐/i.test(name)) return 'pm';
    return 'default';
  }
  const PERSONA_LABEL = { plant: '廠長一頁綜覽', manager: '經理 PR 週報', pm: 'PM 詳細進度', default: '專案報告' };

  const todayStr = () => new Date().toISOString().slice(0, 10);

  // ============================================================
  // Slide builders
  // ============================================================
  function slideEl(idxNum, total, persona) {
    const s = el('section', 'slide');
    s.setAttribute('data-persona', persona);
    const idx = el('div', 'idx');
    add(idx, el('b', null, String(idxNum).padStart(2, '0')), ' / ' + String(total).padStart(2, '0'));
    s.appendChild(idx);
    return s;
  }

  function coverSlide(rep, meta, ctx, total) {
    const s = slideEl(1, total, ctx.persona);
    const eyebrow = el('div', 'eyebrow');
    add(eyebrow, `${PERSONA_LABEL[ctx.persona]} · ${todayStr()}`);
    s.appendChild(eyebrow);

    const spread = el('div', 'spread');
    const left = el('div', 'col'); left.style.gap = '38px';
    const title = meta && meta.project ? meta.project : rep.title || '專案報告';
    left.appendChild(add(el('h1'), inline(el('span', null), title)));
    const desc = ctx.description || rep.title || (meta && meta.project) || '';
    if (desc && desc !== title) left.appendChild(el('div', 'lede', desc));

    // KPI strip
    if (meta && meta.stats) {
      const st = meta.stats;
      const stats = el('div', 'stats'); stats.style.marginTop = '18px';
      stats.appendChild(statBox(String(st.total), '總項目'));
      stats.appendChild(statBox(String(st.open), '進行中'));
      stats.appendChild(statBox(String(st.overdue), '逾期', st.overdue > 0 ? 'crit' : ''));
      stats.appendChild(statBox(st.donePercent + '%', '完成度', 'good'));
      left.appendChild(stats);
    }
    spread.appendChild(left);

    // Right: source tag + a mini agenda / snapshot chip
    const right = el('div', 'col'); right.style.gap = '22px'; right.style.alignItems = 'flex-end';
    const src = meta ? meta.source : 'none';
    const tag = el('div', 'tag' + (src === 'live' ? '' : ' snap'));
    add(tag, el('span', 'lv'), src === 'live' ? 'LIVE · 即時' : src === 'snapshot' ? '既有快照' : '無資料');
    right.appendChild(tag);
    if (meta && typeof meta.itemCount === 'number' && meta.itemCount > 0) {
      const chips = el('div', 'chips'); chips.style.justifyContent = 'flex-end';
      if (meta.stats && meta.stats.overdue > 0) chips.appendChild(add(el('span', 'chip c'), el('span', 'd'), `逾期 ${meta.stats.overdue}`));
      chips.appendChild(add(el('span', 'chip g'), el('span', 'd'), `即時 ${meta.itemCount} 筆`));
      right.appendChild(chips);
    }
    spread.appendChild(right);
    s.appendChild(spread);

    // footline agenda from content sections
    const foot = el('div', 'footline');
    ctx.agenda.slice(0, 3).forEach((h, k) => add(foot.appendChild(el('div')), el('span', 'n', String(k + 1).padStart(2, '0')), h));
    add(foot.appendChild(el('div')).appendChild(el('span', 'br', 'Loop Engineering')));
    foot.lastChild.style.borderRight = 'none';
    s.appendChild(foot);
    return s;
  }

  function statBox(n, label, tone) {
    const box = el('div', 'stat');
    box.appendChild(el('div', 'n' + (tone ? ' ' + tone : ''), n));
    box.appendChild(el('div', 'l', label));
    return box;
  }

  // Native progress panel from meta.items (paginated at 9 rows/slide).
  function progressSlides(meta, ctx, startIdx, total) {
    const items = (meta && meta.items) || [];
    if (!items.length) return [];
    const PER = 9;
    const pages = [];
    for (let p = 0; p * PER < items.length; p++) {
      const chunk = items.slice(p * PER, p * PER + PER);
      const s = slideEl(startIdx + p, total, ctx.persona);
      add(s.appendChild(el('div', 'eyebrow')), '進度總覽' + (p > 0 ? '（續）' : ''));
      const panel = el('div', 'panel'); panel.style.marginTop = '40px';
      const phead = el('div', 'phead');
      phead.appendChild(el('span', 'pt', (meta.project || '專案') + ' · 逐項進度'));
      const tag = el('div', 'tag' + (meta.source === 'live' ? '' : ' snap'));
      add(tag, el('span', 'lv'), meta.source === 'live' ? 'LIVE' : '快照');
      phead.appendChild(tag);
      panel.appendChild(phead);
      const pbody = el('div', 'pbody');
      chunk.forEach((it) => pbody.appendChild(glineRow(it)));
      panel.appendChild(pbody);
      // risk chips only on the first page, summarising the whole set
      if (p === 0 && meta.stats) {
        const risks = el('div', 'prisks');
        if (meta.stats.overdue > 0) risks.appendChild(add(el('span', 'chip c'), el('span', 'd'), `逾期 ${meta.stats.overdue} 項`));
        risks.appendChild(add(el('span', 'chip w'), el('span', 'd'), `進行中 ${meta.stats.open} 項`));
        risks.appendChild(add(el('span', 'chip g'), el('span', 'd'), `已結案 ${meta.stats.closed} 項`));
        panel.appendChild(risks);
      }
      s.appendChild(panel);
      pages.push(s);
    }
    return pages;
  }

  function glineRow(it) {
    const row = el('div', 'gline');
    const gl = el('div', 'gl');
    inline(gl, it.subject);
    const meta = [it.status, it.assignee, it.due].filter(Boolean).join(' · ');
    if (meta) gl.appendChild(el('small', null, meta));
    row.appendChild(gl);
    let fillCls = 'n', pct = it.percent, tone = '', txt = it.percent + '%';
    if (it.closed) { fillCls = 'g'; pct = 100; tone = 'g'; txt = '完成'; }
    else if (it.overdue) { fillCls = 'c'; pct = Math.max(it.percent, 4); tone = 'c'; txt = '逾期'; }
    else if (it.percent > 0) { fillCls = 'w'; tone = 'w'; }
    const track = el('div', 'gtrack');
    const fill = el('div', 'gfill ' + fillCls); fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'gpct' + (tone ? ' ' + tone : ''), txt));
    return row;
  }

  // Content section → one or more slides (weight-packed to avoid 16:9 overflow).
  // Weight is length-aware: a long paragraph/bullet wraps to several lines and must
  // consume proportionally more of the per-slide budget, or it overflows the fixed height.
  const textLen = (t) => String(t).replace(/\*\*/g, '').length;
  function sectionSlides(section, ctx, startIdx, total) {
    const units = [];
    for (const b of section.blocks) {
      if (b.type === 'p') units.push({ w: Math.max(1.6, Math.ceil(textLen(b.text) / 38) * 1.2), make: () => inline(el('div', 'txt'), b.text) });
      else if (b.type === 'ul') for (const it of b.items) units.push({ w: Math.max(1, Math.ceil(textLen(it) / 46)), li: it });
      else if (b.type === 'pre') units.push({ w: Math.max(2, Math.ceil(textLen(b.text) / 70)), make: () => add(el('pre', 'chart-fallback'), el('code', null, b.text)) });
    }
    if (!units.length) return [];
    const BUDGET = 7;
    const heading = section.heading || '內容';
    const pages = [];
    let cursor = 0, page = 0;
    while (cursor < units.length) {
      const s = slideEl(startIdx + page, total, ctx.persona);
      add(s.appendChild(el('div', 'eyebrow')), heading);
      const h2 = el('h2'); h2.style.marginTop = '24px'; inline(h2, heading + (page > 0 ? '（續）' : ''));
      s.appendChild(h2);
      const body = el('div', 'col grow'); body.style.gap = '22px'; body.style.justifyContent = 'center';
      let list = null, used = 0, placed = 0;
      while (cursor < units.length && (used + units[cursor].w <= BUDGET || placed === 0)) {
        const u = units[cursor];
        if (u.li != null) {
          if (!list) { list = el('ul', 'pts'); body.appendChild(list); }
          const li = el('li');
          const tone = bulletTone(u.li);
          li.appendChild(el('i', tone || null));
          inline(li.appendChild(el('span')), u.li);
          list.appendChild(li);
        } else { list = null; body.appendChild(u.make()); }
        used += u.w; placed++; cursor++;
      }
      s.appendChild(body);
      pages.push(s);
      page++;
    }
    return pages;
  }

  // Collect every mermaid block across ALL sections (not just 圖表) so a diagram under
  // any heading — or with none — still renders. Label from a preceding ### else the
  // section heading else 圖表.
  function collectCharts(sections) {
    const charts = [];
    for (const sec of sections) {
      let label = '';
      for (const b of sec.blocks) {
        if (b.type === 'h3') label = b.text;
        else if (b.type === 'mermaid') {
          charts.push({ label: label || (sec.heading && sec.heading !== CHART_SECTION ? sec.heading : '圖表'), code: b.code });
          label = '';
        }
      }
    }
    return charts;
  }

  // Chart slides from the collected mermaid blocks (async-rendered).
  function chartSlides(charts, ctx, startIdx, total, renderJobs) {
    return charts.map((c, k) => {
      const s = slideEl(startIdx + k, total, ctx.persona);
      add(s.appendChild(el('div', 'eyebrow')), '圖表 · ' + c.label);
      const h2 = el('h2'); h2.style.marginTop = '20px'; inline(h2, c.label); s.appendChild(h2);
      const wrap = el('div', 'chart-wrap');
      const target = el('div', 'chart-render');
      wrap.appendChild(target);
      s.appendChild(wrap);
      renderJobs.push(renderMermaidInto(target, c.code));
      return s;
    });
  }

  function buildDeck(rep, meta, ctx) {
    const persona = ctx.persona;
    const parsed = parseReport(rep.markdown || '');
    // Any section carrying prose/bullets/code is content — including the implicit
    // empty-heading section for text that precedes the first ## (or a template with no
    // ## at all). Chart-only sections (mermaid blocks) are excluded here and handled below.
    const contentSections = parsed.sections.filter((s) => s.blocks.some((b) => b.type === 'p' || b.type === 'ul' || b.type === 'pre'));
    const charts = collectCharts(parsed.sections);
    ctx.agenda = contentSections.map((s) => s.heading || '內容');

    // Pre-count total for the "NN / total" index badges (two-pass: build, then renumber).
    const renderJobs = [];
    const slides = [];
    slides.push(coverSlide(parsed, meta, ctx, 0));
    for (const s of progressSlides(meta, ctx, 0, 0)) slides.push(s);
    for (const sec of contentSections) for (const s of sectionSlides(sec, ctx, 0, 0)) slides.push(s);
    for (const s of chartSlides(charts, ctx, 0, 0, renderJobs)) slides.push(s);

    // renumber idx badges now that we know the total
    const total = slides.length;
    slides.forEach((s, k) => {
      const idx = s.querySelector('.idx');
      idx.replaceChildren(el('b', null, String(k + 1).padStart(2, '0')), document.createTextNode(' / ' + String(total).padStart(2, '0')));
    });
    return { slides, ready: Promise.allSettled(renderJobs), persona };
  }

  // ============================================================
  // Deck controller (scale-to-fit + nav)
  // ============================================================
  const viewport = $('viewport');
  const deckUi = $('deck-ui');
  const dotsBox = $('deck-dots');
  const countEl = $('deck-count');
  let deck = null; // { slides, canvas, i, show, fit }

  function mountDeck(built) {
    if (deck && deck.canvas) deck.canvas.remove();
    const empty = $('empty'); if (empty) empty.style.display = 'none';
    const canvas = el('div', 'deck-canvas');
    canvas.setAttribute('data-persona', built.persona);
    built.slides.forEach((s) => canvas.appendChild(s));
    viewport.appendChild(canvas);

    dotsBox.replaceChildren();
    built.slides.forEach((_, k) => {
      const b = el('button'); b.type = 'button'; b.setAttribute('aria-label', '第 ' + (k + 1) + ' 頁');
      b.addEventListener('click', () => d.show(k));
      dotsBox.appendChild(b);
    });
    deckUi.hidden = built.slides.length <= 1 ? false : false; // always show controls once a deck exists
    deckUi.hidden = false;

    const d = {
      slides: built.slides, canvas, ready: built.ready, persona: built.persona, i: 0,
      fit() {
        const s = Math.min(viewport.clientWidth / 1920, viewport.clientHeight / 1080) * 0.97;
        canvas.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
      },
      show(n) {
        this.i = Math.max(0, Math.min(this.slides.length - 1, n));
        this.slides.forEach((s, k) => s.classList.toggle('on', k === this.i));
        Array.prototype.forEach.call(dotsBox.children, (dot, k) => dot.className = k === this.i ? 'on' : '');
        countEl.textContent = (this.i + 1) + ' / ' + this.slides.length;
      },
    };
    deck = d;
    d.fit(); d.show(0);
    return d;
  }

  // resize / keyboard wired once
  const ro = new ResizeObserver(() => { if (deck) deck.fit(); });
  ro.observe(viewport);
  window.addEventListener('resize', () => { if (deck) deck.fit(); });
  window.addEventListener('keydown', (e) => {
    if (!deck) return;
    if (/^(TEXTAREA|INPUT|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); deck.show(deck.i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); deck.show(deck.i - 1); }
    else if (e.key === 'Home') deck.show(0);
    else if (e.key === 'End') deck.show(deck.slides.length - 1);
  });
  $('deck-prev').addEventListener('click', () => deck && deck.show(deck.i - 1));
  $('deck-next').addEventListener('click', () => deck && deck.show(deck.i + 1));

  // ============================================================
  // Exports
  // ============================================================
  const setExportsEnabled = (on) => ['print-btn', 'png-btn', 'html-btn', 'pptx-btn'].forEach((id) => { $(id).disabled = !on; });

  function download(blobOrUrl, filename) {
    const a = el('a');
    a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const reportName = () => (deck && deck.canvas && deck.canvas.querySelector('h1') ? (deck.canvas.querySelector('h1').textContent || '報告').trim() : '報告').replace(/[\\/:*?"<>|]/g, '') || '報告';

  // PDF: browser print — the @media print rule lays every slide out as a 1920×1080 page.
  const exportPDF = () => window.print();

  // Standalone single-file HTML deck (inlined CSS + a tiny inline controller).
  async function exportHTML() {
    await deck.ready; // charts may still be rendering — don't serialise an empty chart target
    const css = await getDeckCss();
    const canvasHtml = new XMLSerializer().serializeToString(deck.canvas);
    const ctrl = "(function(){var C=document.querySelector('.deck-canvas');var S=[].slice.call(C.querySelectorAll('.slide'));var i=0;" +
      "function fit(){var s=Math.min(innerWidth/1920,innerHeight/1080)*0.97;C.style.transform='translate(-50%,-50%) scale('+s+')';}" +
      "function show(n){i=Math.max(0,Math.min(S.length-1,n));S.forEach(function(x,k){x.classList.toggle('on',k===i);});}" +
      "addEventListener('resize',fit);addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key===' '){show(i+1);}else if(e.key==='ArrowLeft'){show(i-1);}});" +
      "fit();show(0);})();";
    const doc = '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      reportName() + '</title><style>' + css + '</style><style>html,body{overflow:hidden;background:var(--stage-bg)}.deck-viewport{position:fixed;inset:0}</style></head>' +
      '<body><div class="deck-viewport">' + canvasHtml + '</div><script>' + ctrl + '<\/script></body></html>';
    download(new Blob([doc], { type: 'text/html;charset=utf-8' }), reportName() + '.html');
  }

  // Rasterise one slide to a 1920×1080 PNG data URL via <foreignObject> (same-origin,
  // no external assets → untainted canvas). Best-effort; some browsers restrict this.
  function loadImage(url) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('image decode failed')); img.src = url; });
  }
  async function slideToPng(section) {
    const css = await getDeckCss();
    const persona = deck.persona || 'default';
    const clone = section.cloneNode(true);
    clone.classList.add('on');
    clone.style.opacity = '1'; clone.style.animation = 'none';
    const xml = new XMLSerializer().serializeToString(clone);
    // The CSS is inlined into an XML <style> node, so bare & / < must be entity-escaped
    // or the whole foreignObject SVG fails to parse (the browser then can't rasterise it).
    // Append a universal animation/transition kill: an <img>-loaded SVG renders at time 0,
    // and report.css animates slide descendants with fill-mode `both`, so without this the
    // capture freezes on the `from` keyframe (opacity:0) and exports blank — mirrors the
    // @media print `.slide * { animation:none }` guard.
    const cssXml = css.replace(/&/g, '&amp;').replace(/</g, '&lt;') + ' *{animation:none!important;transition:none!important}';
    const wrapStyle = 'width:1920px;height:1080px;background:#f3efe7;font-family:system-ui,-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;color:#1b1a17';
    const wrapper = '<div xmlns="' + XHTML_NS + '" data-persona="' + persona + '" style="' + wrapStyle + '"><style>' + cssXml + '</style>' + xml + '</div>';
    const svg = '<svg xmlns="' + SVG_NS + '" width="1920" height="1080"><foreignObject x="0" y="0" width="1920" height="1080">' + wrapper + '</foreignObject></svg>';
    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    const canvas = el('canvas'); canvas.width = 1920; canvas.height = 1080;
    const cx = canvas.getContext('2d');
    cx.fillStyle = '#f3efe7'; cx.fillRect(0, 0, 1920, 1080);
    cx.drawImage(img, 0, 0, 1920, 1080);
    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      // Some browsers taint the canvas when drawing an SVG <foreignObject> and refuse toDataURL.
      throw new Error('此瀏覽器不支援投影片轉圖，請改用 PDF 或 HTML 匯出');
    }
  }
  async function exportPNG() {
    await deck.ready; // charts may still be rendering
    const png = await slideToPng(deck.slides[deck.i]);
    download(png, reportName() + '-' + (deck.i + 1) + '.png');
  }

  // PPTX: one full-bleed slide image per deck slide (vendored pptxgenjs bundle).
  async function exportPPTX() {
    const Ppt = await loadScript('/vendor/pptxgen.bundle.js', 'PptxGenJS');
    if (!Ppt) throw new Error('pptxgenjs unavailable');
    await deck.ready; // ensure charts are rendered before rasterising
    const pptx = new Ppt();
    pptx.defineLayout({ name: 'LOOP16x9', width: 13.333, height: 7.5 });
    pptx.layout = 'LOOP16x9';
    for (const s of deck.slides) {
      const data = await slideToPng(s);
      pptx.addSlide().addImage({ data, x: 0, y: 0, w: 13.333, h: 7.5 });
    }
    await pptx.writeFile({ fileName: reportName() + '.pptx' });
  }

  function wireExport(id, fn, busyLabel, doneLabel) {
    $(id).addEventListener('click', async () => {
      if (!deck) return;
      const btn = $(id); const orig = btn.textContent;
      btn.disabled = true; if (busyLabel) btn.textContent = busyLabel;
      try { await fn(); setNote('已輸出 ' + doneLabel, 'ok'); }
      catch (e) { setNote('匯出失敗（' + orig + '）：' + e.message, 'danger'); }
      finally { btn.disabled = false; btn.textContent = orig; }
    });
  }
  $('print-btn').addEventListener('click', () => { if (deck) exportPDF(); });
  wireExport('png-btn', exportPNG, '產生中…', 'PNG 圖檔');
  wireExport('html-btn', exportHTML, '打包中…', '單檔 HTML');
  wireExport('pptx-btn', exportPPTX, '轉檔中…', 'PPTX 簡報');

  // ============================================================
  // Rail interactions: persona cards, template select, collapse
  // ============================================================
  const templateSel = $('f-template');
  const personaGrid = $('persona-grid');
  personaGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.persona'); if (!card) return;
    Array.prototype.forEach.call(personaGrid.children, (c) => c.classList.toggle('on', c === card));
    templateSel.value = card.getAttribute('data-template') || '';
  });
  templateSel.addEventListener('change', () => {
    const v = templateSel.value;
    Array.prototype.forEach.call(personaGrid.children, (c) => c.classList.toggle('on', (c.getAttribute('data-template') || '') === v));
  });

  const appEl = $('app');
  $('rail-toggle').addEventListener('click', () => {
    appEl.classList.toggle('rail-collapsed');
    $('rail-toggle').textContent = appEl.classList.contains('rail-collapsed') ? '›' : '‹';
    setTimeout(() => deck && deck.fit(), 300);
  });

  async function loadTemplates() {
    try {
      const d = await api('/api/report/templates');
      const known = new Set(['plant-manager-onepage', 'manager-pr-weekly', 'pm-detailed']);
      for (const t of (d.templates || [])) {
        const opt = el('option'); opt.value = t.name; opt.textContent = t.description ? `${t.name} — ${t.description}` : t.name;
        templateSel.appendChild(opt);
      }
      // hide any persona card whose template isn't actually installed (keeps 自動 always)
      Array.prototype.forEach.call(personaGrid.children, (c) => {
        const tn = c.getAttribute('data-template');
        if (tn && (d.templates || []).length && !(d.templates || []).some((t) => t.name === tn)) c.style.display = 'none';
      });
    } catch (err) { /* report disabled/unreachable — form still usable; submit surfaces the error */ }
  }

  // ============================================================
  // Generate flow (staged progress + client timeout, like the classic report page)
  // ============================================================
  function setNote(msg, kind) {
    const n = $('note');
    n.textContent = msg || '';
    n.className = 'note' + (kind ? ' ' + kind : '');
  }
  const STAGE_HINTS = [
    { afterSec: 0, label: '解析描述中…' },
    { afterSec: 4, label: '抓取專案資料中…' },
    { afterSec: 12, label: '產生報告內容中…' },
    { afterSec: 30, label: '排版投影片中…' },
  ];
  const CLIENT_TIMEOUT_MS = 120_000;

  $('gen-btn').addEventListener('click', async () => {
    const genBtn = $('gen-btn');
    const description = $('f-description').value.trim();
    if (!description) { setNote('請先輸入描述', 'danger'); return; }
    const body = { description };
    const project = $('f-project').value.trim();
    if (project) body.project = project;
    const template = templateSel.value;
    if (template) body.template = template;
    if ($('f-save').checked) body.save = true;

    genBtn.disabled = true;
    const startedAt = Date.now();
    const tick = () => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      let stage = STAGE_HINTS[0].label;
      for (const s of STAGE_HINTS) if (elapsedSec >= s.afterSec) stage = s.label;
      setNote(`${stage}（已等待 ${elapsedSec} 秒）`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await api('/api/report', { method: 'POST', body, signal: controller.signal });
      if (!res.markdown) { setNote('沒有產生內容（可能無資料或功能未啟用）', 'danger'); return; }
      const ctx = { persona: resolvePersona(res.meta, template), description };
      const built = buildDeck(res, res.meta || null, ctx);
      appEl.setAttribute('data-persona', built.persona);
      mountDeck(built);
      setExportsEnabled(true);
      const parts = [];
      if (res.meta) {
        parts.push(res.meta.source === 'live' ? '即時資料' : res.meta.source === 'snapshot' ? '既有快照' : '無資料');
        if (typeof res.meta.itemCount === 'number') parts.push(`${res.meta.itemCount} 筆`);
        if (res.meta.template) parts.push(`範本 ${res.meta.template}`);
      }
      parts.push(`${built.slides.length} 張投影片`);
      if (res.files && res.files.length) parts.push(`已存檔 ${res.files.length} 檔`);
      setNote('完成 · ' + parts.join(' · '), 'ok');
    } catch (err) {
      setNote(err.name === 'AbortError' ? '產生逾時，請稍後再試' : '產生失敗：' + err.message, 'danger');
    } finally {
      clearInterval(timer);
      clearTimeout(abortTimer);
      genBtn.disabled = false;
    }
  });

  loadTemplates();
})();
