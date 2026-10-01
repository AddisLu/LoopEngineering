// The app frame shared by 總覽 / 工作流程 / 評比: the left rail (n8n-style), icons, and the small
// DOM helpers the pages build with. Rendering is textContent-only — nothing here builds markup
// from strings. Needs ops.js (window.Ops: api, token, toast) loaded first.

const NS = 'http://www.w3.org/2000/svg';

/** stroke icons, 24×24 paths */
export const ICONS = {
  loop: ['M8 8a4 4 0 1 0 0 8c3 0 5-8 8-8a4 4 0 1 1 0 8c-3 0-5-8-8-8z'],
  chat: ['M4 5h16v11H9l-5 4z'],
  overview: ['M3 5.5A1.5 1.5 0 0 1 4.5 4h4A1.5 1.5 0 0 1 10 5.5v3A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5z', 'M14 15.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z', 'M10 7h4a2 2 0 0 1 2 2v5'],
  flow: ['M5 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5', 'M19 3.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5', 'M19 15.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5', 'M7.5 12h4l5-5', 'M11.5 12l5 5'],
  bench: ['M5 20V11', 'M11 20V5', 'M17 20v-6', 'M3 20h18'],
  shield: ['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z', 'M9 12l2 2 4-4'],
  stars: ['M6 5.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6', 'M17 3.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6', 'M12 15.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6', 'M7.6 7.9l3.3 7.4', 'M16.2 6.6l-3.3 8.8', 'M7.8 6.8l7.4-1.4'],
  sunrise: ['M12 9a4 4 0 1 0 0 8a4 4 0 1 0 0-8', 'M12 3v2', 'M4.9 6.9l1.4 1.4', 'M3 13h2', 'M19 13h2', 'M17.7 8.3l1.4-1.4', 'M3 20h18'],
  gear: ['M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M12 2v3', 'M12 19v3', 'M4.2 4.2l2.1 2.1', 'M17.7 17.7l2.1 2.1', 'M2 12h3', 'M19 12h3', 'M4.2 19.8l2.1-2.1', 'M17.7 6.3l2.1-2.1'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  sun: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  search: ['M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13', 'M16 16l4.5 4.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  bang: ['M12 6v8', 'M12 18.5v.5'],
  spin: ['M12 4a8 8 0 1 1-8 8'],
  retry: ['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v5h-5'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 9.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6'],
  clock: ['M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16', 'M12 8v4.5l3 2'],
  pause: ['M9 5v14', 'M15 5v14'],
  chip: ['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M9 2v4', 'M15 2v4', 'M9 18v4', 'M15 18v4', 'M2 9h4', 'M2 15h4', 'M18 9h4', 'M18 15h4'],
  code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5'],
  doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  // 問題單 (fix.js): the rail item, 改一下, a pasted link, the import hint, 重現 before-run results
  ticket: ['M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z', 'M13 8v8'],
  pencil: ['M4 20h4l10-10-4-4L4 16v4z', 'M13 7l4 4'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5'],
  info: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 11v5', 'M12 8h.01'],
  alert: ['M12 3l9.5 17h-19z', 'M12 10v4', 'M12 17.5v.5'],
  circleCheck: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M8.5 12.5l2.5 2.5 4.5-5'],
  bolt: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  box: ['M3 7.5l9-4.5 9 4.5-9 4.5z', 'M3 7.5v9l9 4.5 9-4.5v-9', 'M12 12v9'],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
  term: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M7 9l3 3-3 3', 'M12 15h5'],
  gate: ['M4 5h16l-6 7.5V19l-4 2v-8.5z'],
  person: ['M12 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'M5 20c1-4 4-6 7-6s6 2 7 6'],
  merge: ['M6 2.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4', 'M6 16.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4', 'M18 9.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4', 'M6 7.2v9.6', 'M6 7.5c0 4 4 4.5 9.8 4.5'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  scale: ['M12 3v18', 'M5 7h14', 'M5 7l-3 7a3.5 3.5 0 0 0 6 0z', 'M19 7l-3 7a3.5 3.5 0 0 0 6 0z'],
  server: ['M4.5 4h15A1.5 1.5 0 0 1 21 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 9.5v-4A1.5 1.5 0 0 1 4.5 4z', 'M4.5 13h15a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-4A1.5 1.5 0 0 1 4.5 13z', 'M7 7.5h.01', 'M7 16.5h.01'],
  // Repo / 機台 pages: the rail's Repo item, check results (✓ / ⚠ / ✗) and the drag handle
  branch: ['M6 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4', 'M6 17a2 2 0 1 0 0 4a2 2 0 1 0 0-4', 'M18 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4', 'M6 7v10', 'M18 10c0 4-12 3-12 7'],
  okCircle: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M8.5 12.5l2.5 2.5 4.5-5'],
  xCircle: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M9 9l6 6', 'M15 9l-6 6'],
  warnTri: ['M12 3.5l9.5 17h-19z', 'M12 10v4.5', 'M12 17.5h.01'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z'],
  fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  zin: ['M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13', 'M16 16l4.5 4.5', 'M8.5 11h5', 'M11 8.5v5'],
  zout: ['M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13', 'M16 16l4.5 4.5', 'M8.5 11h5'],
  tidy: ['M4 4h5v5H4z', 'M15 4h5v5h-5z', 'M9.5 15h5v5h-5z', 'M9 6.5h6', 'M12 9v6'],
  chevR: ['M9 6l6 6-6 6'],
  chevL: ['M15 6l-6 6 6 6'],
  chevD: ['M6 9l6 6 6-6'],
  chevU: ['M6 15l6-6 6 6'],
  more: ['M5 11.2a.8.8 0 1 0 0 1.6a.8.8 0 1 0 0-1.6', 'M12 11.2a.8.8 0 1 0 0 1.6a.8.8 0 1 0 0-1.6', 'M19 11.2a.8.8 0 1 0 0 1.6a.8.8 0 1 0 0-1.6'],
  ext: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M4 20h16'],
  play: ['M7 4.5v15l12-7.5z'],
  crown: ['M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z'],
  flask: ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  mic: ['M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  arrowR: ['M5 12h14', 'M13 6l6 6-6 6'],
};

/** an <svg> icon; `fill` for the solid glyphs (play, dots) */
export function icon(name, opts = {}) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', opts.fill ? 'currentColor' : 'none');
  s.setAttribute('stroke', opts.fill ? 'none' : 'currentColor');
  s.setAttribute('stroke-width', String(opts.sw ?? 1.9));
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (opts.size) {
    s.setAttribute('width', String(opts.size));
    s.setAttribute('height', String(opts.size));
  }
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}

/**
 * h('div.card-s', { title: 'x', onclick }, child, 'text', …) — element + class list + attributes;
 * strings become text nodes (never markup), null/false children are skipped.
 */
export function h(spec, attrs, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const e = document.createElement(tag || 'div');
  if (classes.length) e.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  append(e, children);
  return e;
}

function append(e, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(e, c);
    else e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (id) => document.getElementById(id);
/** el.replaceChildren(...) that skips null / false, the way h() does (replaceChildren would print "null") */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
export const api = (...a) => window.Ops.api(...a);
export const toast = (...a) => window.Ops.toast(...a);
export const withToken = (p) => window.Ops.withToken(p);

/** "YYYY-MM-DD HH:MM:SS" (UTC, sqlite) or ISO → ms since epoch */
export function tsMs(s) {
  if (!s) return NaN;
  return new Date(/[TZ]/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`).getTime();
}
/** local HH:MM of a stored timestamp */
export function hhmm(s) {
  const t = tsMs(s);
  if (!Number.isFinite(t)) return '–';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** a short local time: HH:MM today, M/D HH:MM otherwise */
export function shortTime(s) {
  const t = tsMs(s);
  if (!Number.isFinite(t)) return '–';
  const d = new Date(t);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? hhmm(s) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(s)}`;
}
/** 45 秒 · 12 分 · 1 時 20 分 */
export function dur(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '–';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 時 ${m % 60} 分`;
}
/** 16.8 萬 · 3,300 */
export function tokens(n) {
  if (n == null || !Number.isFinite(Number(n))) return '–';
  const v = Number(n);
  if (v >= 10000) return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)} 萬`;
  return v.toLocaleString('zh-TW');
}
/** model id → the name people use: local:qwen38-flash → qwen38-flash */
export const modelName = (m) => String(m || '').replace(/^local:/, '') || '預設模型';
export const isLocal = (m) => String(m || '').startsWith('local:');

const NAV = [
  ['chat', '對話', '/', 'chat'],
  // 問題單 replaced 工作流程 here; /flow.html stays reachable from the links that still point at it
  ['fix', '問題單', '/fix.html', 'ticket'],
  ['board', '總覽', '/board.html', 'overview'],
  ['repos', 'Repo', '/repos.html', 'branch'],
  ['machines', '機台', '/machines.html', 'server', 'minor'],
  ['bench', '評比', '/benchmarks.html', 'bench'],
  ['brain', '知識星圖', '/brain.html', 'stars', 'minor'],
  ['morning', '晨報', '/morning.html', 'sunrise', 'minor'],
];

const RING_C = 2 * Math.PI * 14;

/** Build the left rail into <nav id="app-rail"> (or `o.el`) and keep its usage ring fresh. */
export function mountRail(active, o = {}) {
  const nav = o.el || document.getElementById('app-rail');
  if (!nav) return;
  nav.className = 'app-rail';
  nav.setAttribute('aria-label', '主選單');
  nav.replaceChildren();
  const logo = h('a.logo', { href: '/', 'aria-label': 'Loop 首頁' }, icon('loop', { sw: 2 }));
  nav.appendChild(logo);
  for (const [key, label, href, ic, minor] of NAV) {
    const a = h(`a.nav${minor ? '.minor' : ''}`, { href, 'aria-current': key === active ? 'page' : null }, icon(ic, { sw: 1.8 }), h('span', null, label));
    nav.appendChild(a);
  }
  nav.appendChild(h('div.grow'));

  const ring = document.createElementNS(NS, 'svg');
  ring.setAttribute('viewBox', '0 0 36 36');
  ring.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'circle');
  const fill = document.createElementNS(NS, 'circle');
  for (const c of [track, fill]) {
    c.setAttribute('cx', '18');
    c.setAttribute('cy', '18');
    c.setAttribute('r', '14');
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', '4');
  }
  track.setAttribute('class', 'track');
  fill.setAttribute('class', 'fill');
  fill.setAttribute('stroke-linecap', 'round');
  fill.setAttribute('transform', 'rotate(-90 18 18)');
  fill.setAttribute('stroke-dasharray', `0 ${RING_C}`);
  ring.append(track, fill);
  const usageLabel = h('span', null, '5h –');
  const usage = h('a.usage', { href: '/board.html', title: '5 小時視窗用量' }, ring, usageLabel);
  nav.appendChild(usage);

  const settings = h('a.ibtn', { href: '/board.html#settings', 'aria-label': '設定', title: '設定' }, icon('gear', { sw: 1.8 }));
  // already on 總覽: open the dialog directly (a second click on the same #settings link changes nothing)
  settings.onclick = (e) => {
    const btn = location.pathname === '/board.html' && document.getElementById('settings-btn');
    if (!btn) return;
    e.preventDefault();
    btn.click();
  };
  nav.appendChild(settings);
  const theme = h('button.ibtn.theme', { type: 'button' });
  const paintTheme = () => {
    const dark = document.documentElement.getAttribute('data-mode') === 'dark';
    theme.replaceChildren(icon(dark ? 'sun' : 'moon', { sw: 1.8 }));
    theme.setAttribute('aria-label', dark ? '切換淺色' : '切換深色');
    theme.title = dark ? '切換淺色' : '切換深色';
  };
  theme.onclick = () => {
    const next = document.documentElement.getAttribute('data-mode') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-mode', next);
    window.Ops.store('loop_mode', next);
    paintTheme();
    document.dispatchEvent(new CustomEvent('frame:theme'));
  };
  paintTheme();
  nav.appendChild(theme);

  const paintUsage = (u) => {
    if (!u) return;
    const p = Math.max(0, Math.min(100, Number(u.session) || 0));
    fill.setAttribute('stroke-dasharray', `${(p / 100) * RING_C} ${RING_C}`);
    usage.dataset.state = p >= 90 ? 'danger' : p >= 70 ? 'warn' : 'ok';
    usageLabel.textContent = `5h ${Math.round(p)}%`;
    usage.title = `5 小時視窗 ${Math.round(p)}% · 本週 ${Math.round(Number(u.weekly) || 0)}%${u.error ? '（讀數非即時）' : ''}`;
  };
  const poll = () => api('/api/usage').then(paintUsage).catch(() => {});
  poll();
  setInterval(poll, 60_000);
  return { paintUsage };
}

/** 你是 … in the top bar (#ops-who): the Tailscale login, or the name typed on this browser. */
export function mountWho(el = document.getElementById('ops-who')) {
  if (el) window.Ops.mountWho(el);
}

/** A small popup menu anchored under `anchor`; items: [label, onClick] | 'hr' | [label, href, 'link'] */
export function popMenu(anchor, items) {
  // only the menus this function made: a page's own (總覽's ⋯, #more-menu) is hidden, never removed —
  // removing it left its button throwing on every click and settings out of reach until a reload
  document.querySelectorAll('.menu-pop[data-pop]').forEach((m) => m.remove());
  document.querySelectorAll('.menu-pop:not([data-pop])').forEach((m) => (m.hidden = true));
  const r = anchor.getBoundingClientRect();
  const m = h('div.menu-pop', { role: 'menu', 'data-pop': '' });
  for (const it of items) {
    if (it === 'hr') {
      m.appendChild(h('hr'));
      continue;
    }
    const [label, act, kind] = it;
    const b = kind === 'link' ? h('a', { href: act, role: 'menuitem' }, label) : h('button', { type: 'button', role: 'menuitem' }, label);
    if (kind !== 'link') b.onclick = () => {
      m.remove();
      act();
    };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const w = m.offsetWidth;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  m.style.top = `${r.bottom + 6}px`;
  const close = (e) => {
    if (!m.contains(e.target) && e.target !== anchor) {
      m.remove();
      document.removeEventListener('pointerdown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  return m;
}
