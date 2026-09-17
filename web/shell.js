/**
 * Shared shell layer for the chat-first workspace (index.html) and the pages it links to.
 *
 * Holds the things every panel needs and nobody should re-implement: the API token bootstrap,
 * the identity header, a JSON fetch helper, the theme toggle, the single board SSE connection,
 * toasts, and the collapsible rail/dock state. DOM is built with textContent only — never as
 * parsed markup, since everything here can end up rendering model or task text.
 */

// ---- auth / identity --------------------------------------------------------
const params = new URLSearchParams(location.search);
if (params.get('token')) {
  try {
    localStorage.setItem('loop_token', params.get('token'));
  } catch (e) {
    /* private mode */
  }
}
export const TOKEN = (() => {
  try {
    return localStorage.getItem('loop_token') || '';
  } catch (e) {
    return '';
  }
})();
export const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

export const store = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch (e) {
    /* private mode */
  }
};
export const stored = (k) => {
  try {
    return localStorage.getItem(k);
  } catch (e) {
    return null;
  }
};

/** HTTP headers are latin1, so a Chinese name only survives percent-encoded (identity.ts decodes). */
export const nameHeader = () => {
  const n = (stored('loop_chat_user') || '').trim();
  return n ? { 'x-loop-user': encodeURIComponent(n) } : {};
};

/**
 * JSON fetch with the bearer + identity headers. Throws Error(server message) on failure.
 *
 * content-type is set only when something is actually being sent: Fastify rejects a request that
 * declares a JSON body and then has none with a bare 400, which is how every DELETE on this page
 * (取消分享, 刪除對話) silently broke — and app.inject in the tests does not set the header, so
 * the suite could not see it.
 */
export async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.body == null ? {} : { 'content-type': 'application/json' }),
      ...authHeaders,
      ...nameHeader(),
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const err = new Error(d.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = d;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

// ---- tiny DOM helpers -------------------------------------------------------
export const $ = (id) => document.getElementById(id);
export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
export const setText = (id, text) => {
  const node = $(id);
  if (node) node.textContent = text;
};

export const fmtInt = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
export const fmtSec = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
export const pct = (x) => `${Math.max(0, Math.min(100, x * 100)).toFixed(1)}%`;

/**
 * SQLite writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker — without the Z this would be
 * read as local time and every row would be hours off.
 */
export function when(raw) {
  if (!raw) return '';
  const d = new Date(`${String(raw).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
}

// ---- theme ------------------------------------------------------------------
const mode = () => (document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light');

export function wireTheme(btn) {
  if (!btn) return;
  const paint = () => (btn.textContent = mode() === 'dark' ? '☀' : '☾');
  btn.onclick = () => {
    const next = mode() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-mode', next);
    store('loop_mode', next);
    paint();
  };
  paint();
}

// ---- toast ------------------------------------------------------------------
// The only visible channel for an action that failed in the background (save to KB, create task).
let toastBox = null;
export function toast(text, kind = 'ok', link = null) {
  if (!toastBox) {
    toastBox = el('div', 'toasts');
    document.body.append(toastBox);
  }
  const t = el('div', `toast ${kind}`);
  t.append(el('span', null, text));
  if (link) {
    const a = el('a', null, link.text);
    a.href = link.href;
    t.append(a);
  }
  const close = el('button', 'x', '✕');
  close.type = 'button';
  close.onclick = () => t.remove();
  t.append(close);
  toastBox.append(t);
  setTimeout(() => t.remove(), link ? 12000 : 6000);
  return t;
}

// ---- board SSE --------------------------------------------------------------
// One connection for the whole shell: the topbar gauges and the 任務 dock pane share it.
const boardListeners = new Set();
let boardStarted = false;
let lastBoardState = null;

export function onBoard(fn) {
  boardListeners.add(fn);
  if (lastBoardState) fn(lastBoardState);
  if (!boardStarted) {
    boardStarted = true;
    connectBoard();
  }
  return () => boardListeners.delete(fn);
}

export const boardState = () => lastBoardState;

function connectBoard() {
  const url = '/api/stream' + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
  const es = new EventSource(url);
  es.onmessage = (m) => {
    try {
      lastBoardState = JSON.parse(m.data);
    } catch (e) {
      return;
    }
    for (const fn of boardListeners) {
      try {
        fn(lastBoardState);
      } catch (e) {
        /* one bad panel must not kill the stream */
      }
    }
  };
  es.onerror = () => {
    try {
      es.close();
    } catch (e) {
      /* already closed */
    }
    setTimeout(connectBoard, 2000);
  };
}

// ---- phone drawer -----------------------------------------------------------
// On a phone there is no width to hand over, so a rail's markup moves into one shared off-canvas
// drawer. Whoever borrows an element registers where it came from, and closing the drawer puts
// *everything* back — so a resize to desktop can never strand a panel inside a hidden drawer.
const homes = new Map(); // element -> its original parent
export const drawer = {
  el: () => document.getElementById('chat-drawer'),
  body: () => document.getElementById('drawer-body'),
  isOpen() {
    const d = this.el();
    return Boolean(d) && !d.hidden;
  },
  /** Which borrowed element is currently showing, if any. */
  showing() {
    const body = this.body();
    return body ? body.firstElementChild : null;
  },
  show(element, title) {
    const d = this.el();
    const body = this.body();
    if (!d || !body || !element) return;
    this.close();
    if (!homes.has(element)) homes.set(element, element.parentElement);
    body.append(element);
    const t = document.getElementById('drawer-title');
    if (t) t.textContent = title || '';
    d.hidden = false;
    const scrim = document.getElementById('drawer-scrim');
    if (scrim) scrim.hidden = false;
  },
  close() {
    const d = this.el();
    const body = this.body();
    if (!d || !body) return;
    for (const child of [...body.children]) {
      const home = homes.get(child);
      if (home) home.append(child);
    }
    d.hidden = true;
    const scrim = document.getElementById('drawer-scrim');
    if (scrim) scrim.hidden = true;
  },
};

// ---- collapsible rails ------------------------------------------------------
export const phone = () => window.matchMedia('(max-width: 720px)').matches;

/**
 * Collapsing animates a grid track on `main`, so the width goes back to the conversation instead
 * of being overlaid. `key` is the localStorage key, `cls` the class toggled on `main`.
 */
export function rail({ main, key, cls, toggle, defaultOpen, onChange }) {
  const saved = stored(key);
  let open = saved ? saved === 'open' : defaultOpen;
  const paint = () => {
    main.classList.toggle(cls, !open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (onChange) onChange(open);
  };
  paint();
  return {
    get open() {
      return open;
    },
    set(next) {
      open = next;
      store(key, open ? 'open' : 'closed');
      paint();
    },
    toggle() {
      this.set(!open);
    },
  };
}

// ---- 終端機 -----------------------------------------------------------------
// Only the allowlist sees the drawer: ask once, load the module only on a yes. Any failure
// (feature off, no permission, offline) just means no button.
if (document.getElementById('term-drawer')) {
  api('/api/terminal/access')
    .then((a) => {
      if (a && a.allowed) return import('./terminal.js');
      return null;
    })
    .catch(() => null);
}
