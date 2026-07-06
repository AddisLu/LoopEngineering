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
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  async function api(path, method = 'GET') {
    const r = await fetch(path, { method, headers: authHeaders });
    return r.ok ? r.json().catch(() => ({})) : Promise.reject(await r.text().catch(() => r.statusText));
  }

  const fmtDur = (min) => {
    if (min == null || isNaN(min)) return '–';
    const m = Math.max(0, Math.round(Number(min)));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };
  const fmtPct = (n) => (n == null || isNaN(n) ? '–' : `${Math.round(n * 100)}%`);
  const fmtNum = (n, digits = 1) => (n == null || isNaN(n) ? '–' : Number(n).toFixed(digits));

  // ---- theme (same as app.js/brain.js) ----------------------------------
  const themeBtn = $('theme-btn');
  function currentMode() {
    return document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light';
  }
  function paintThemeBtn() {
    const dark = currentMode() === 'dark';
    themeBtn.textContent = dark ? '☀' : '☾';
    themeBtn.setAttribute('aria-label', dark ? '切換至淺色佈景' : '切換至深色佈景');
  }
  themeBtn.onclick = () => {
    const next = currentMode() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-mode', next);
    try { localStorage.setItem('loop_mode', next); } catch (e) {}
    paintThemeBtn();
  };
  paintThemeBtn();

  // ---- stat tiles --------------------------------------------------------
  const statTiles = $('stat-tiles');
  function renderStatTiles(m) {
    statTiles.replaceChildren();
    const tiles = [
      ['已結案總數', m.throughput.total_closed],
      ['結案／天', fmtNum(m.throughput.total_closed / Math.max(1, m.days))],
      ['成功率', fmtPct(m.funnel.close_rate)],
      ['平均週期', fmtDur(m.cycle_time.avg_min)],
      ['平均 token %／任務', m.token_cost.avg_pct == null ? '–' : `${fmtNum(m.token_cost.avg_pct)}%`],
      ['引擎自我更新', m.autonomy.self_updates],
      ['自動合併', m.autonomy.auto_merged],
    ];
    for (const [label, value] of tiles) {
      const tile = el('div', 'stat-tile');
      tile.appendChild(el('div', 'stat-value', String(value)));
      tile.appendChild(el('div', 'stat-label', label));
      statTiles.appendChild(tile);
    }
  }

  // ---- usage-trend line chart (hand-built SVG, session + weekly) --------
  const trendSvg = $('trend-svg');
  const trendEmpty = $('trend-empty');
  const W = 640, H = 200, PAD = 24;

  function renderTrend(points) {
    trendSvg.replaceChildren();
    if (!points.length) {
      trendEmpty.hidden = false;
      return;
    }
    trendEmpty.hidden = true;
    const n = points.length;
    const x = (i) => (n <= 1 ? PAD : PAD + (i / (n - 1)) * (W - 2 * PAD));
    const y = (pct) => H - PAD - (Math.max(0, Math.min(100, Number(pct) || 0)) / 100) * (H - 2 * PAD);

    trendSvg.appendChild(svgEl('line', { x1: PAD, y1: y(0), x2: W - PAD, y2: y(0), class: 'trend-axis' }));
    trendSvg.appendChild(svgEl('line', { x1: PAD, y1: y(100), x2: W - PAD, y2: y(100), class: 'trend-axis' }));

    const sessionPts = points.map((p, i) => `${x(i)},${y(p.session_pct)}`).join(' ');
    const weeklyPts = points.map((p, i) => `${x(i)},${y(p.weekly_pct)}`).join(' ');
    trendSvg.appendChild(svgEl('polyline', { points: sessionPts, class: 'trend-line trend-session' }));
    trendSvg.appendChild(svgEl('polyline', { points: weeklyPts, class: 'trend-line trend-weekly' }));
  }

  // ---- throughput bar chart (hand-built SVG, closed/day) -----------------
  const throughputSvg = $('throughput-svg');
  const throughputEmpty = $('throughput-empty');

  function renderThroughput(byDay) {
    throughputSvg.replaceChildren();
    if (!byDay.length) {
      throughputEmpty.hidden = false;
      return;
    }
    throughputEmpty.hidden = true;
    const max = Math.max(1, ...byDay.map((d) => d.count));
    const n = byDay.length;
    const gap = 4;
    const barW = Math.max(2, (W - 2 * PAD) / n - gap);
    byDay.forEach((d, i) => {
      const bx = PAD + i * ((W - 2 * PAD) / n);
      const bh = (d.count / max) * (H - 2 * PAD);
      const by = H - PAD - bh;
      const bar = svgEl('rect', { x: bx, y: by, width: barW, height: bh, class: 'throughput-bar' });
      const title = svgEl('title', {});
      title.textContent = `${d.day}: ${d.count}`;
      bar.appendChild(title);
      throughputSvg.appendChild(bar);
    });
  }

  // ---- status funnel row --------------------------------------------------
  const funnelRow = $('funnel-row');
  function renderFunnel(f) {
    funnelRow.replaceChildren();
    const steps = [
      ['建立', f.created, null],
      ['進入 Review', f.reached_review, f.review_rate],
      ['結案', f.closed, f.close_rate],
      ['待確認', f.went_attention, f.attention_rate],
      ['失敗', f.went_failed, f.failed_rate],
    ];
    for (const [label, count, rate] of steps) {
      const step = el('div', 'funnel-step');
      step.appendChild(el('div', 'funnel-count', String(count)));
      step.appendChild(el('div', 'funnel-label', rate == null ? label : `${label}（${fmtPct(rate)}）`));
      funnelRow.appendChild(step);
    }
  }

  // ---- load + poll --------------------------------------------------------
  const daysSelect = $('days-select');
  let timer = null;

  async function load() {
    let m;
    try {
      m = await api(`/api/metrics?days=${encodeURIComponent(daysSelect.value)}`);
    } catch (e) {
      return; // best-effort poll — keep the last good render on a transient failure
    }
    renderStatTiles(m);
    renderTrend(m.usage_trend);
    renderThroughput(m.throughput.by_day);
    renderFunnel(m.funnel);
  }

  daysSelect.addEventListener('change', load);
  load();
  timer = setInterval(load, 30000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
