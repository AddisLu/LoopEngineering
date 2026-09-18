import { $, el, TOKEN, nameHeader, store, stored, toast } from './shell.js';

/**
 * 終端機 drawer: a real shell on the Spark, in the browser, for the people on the allowlist.
 *
 * Loaded by shell.js only after GET /api/terminal/access says yes, so everyone else pays nothing
 * and sees no button. xterm.js lives in web/lib/xterm (committed, no CDN — this box is Wi-Fi only
 * and sometimes offline) and is injected the first time the drawer opens. One WebSocket carries
 * every tab; closing the drawer hides it but keeps the shells, reopening re-attaches.
 * textContent only, like every other page script.
 */

const drawer = $('term-drawer');
const tabsBar = $('term-tabs');
const panes = $('term-panes');
const toggle = $('term-toggle');
const newBtn = $('term-new');
const handle = $('term-handle');

let ws = null;
let wsReady = null;
let libReady = null;
const tabs = new Map(); // id → { term, fit, pane, tab, title, alive }
let active = null;
let backoff = 1000;

// ---- xterm loader -----------------------------------------------------------------------------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`載入失敗：${src}`));
    document.head.append(s);
  });
}
function loadLib() {
  if (libReady) return libReady;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/lib/xterm/xterm.css';
  document.head.append(link);
  libReady = loadScript('/lib/xterm/xterm.js').then(() => loadScript('/lib/xterm/addon-fit.js'));
  return libReady;
}

// ---- socket ---------------------------------------------------------------------------------------
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams();
  if (TOKEN) q.set('token', TOKEN);
  const name = nameHeader()['x-loop-user'];
  if (name) q.set('user', name);
  const qs = q.toString();
  return `${proto}://${location.host}/api/terminal/ws${qs ? `?${qs}` : ''}`;
}

function connect() {
  if (wsReady) return wsReady;
  wsReady = new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl());
    sock.onopen = () => {
      ws = sock;
      backoff = 1000;
      resolve(sock);
    };
    sock.onmessage = (ev) => onFrame(JSON.parse(ev.data));
    sock.onerror = () => reject(new Error('終端機連線失敗'));
    sock.onclose = (ev) => {
      ws = null;
      wsReady = null;
      if (ev.code === 4403 || ev.code === 4404) {
        toast(`終端機：${ev.reason || '沒有權限'}`, 'bad');
        return;
      }
      for (const t of tabs.values()) if (t.alive) t.term.write('\r\n\x1b[2m[連線中斷，重新連線中…]\x1b[0m\r\n');
      if (!drawer.hidden || tabs.size) {
        setTimeout(() => {
          connect()
            .then(() => {
              for (const id of tabs.keys()) send({ t: 'attach', id });
            })
            .catch(() => {});
        }, backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    };
  });
  return wsReady;
}

function send(frame) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
}

// ---- tabs -----------------------------------------------------------------------------------------
function makeTab(session) {
  if (tabs.has(session.id)) return tabs.get(session.id);
  const pane = el('div', 'term-pane');
  pane.hidden = true;
  panes.append(pane);
  const term = new window.Terminal({ scrollback: 5000, fontSize: 13, fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace', cursorBlink: true, theme: themeColors() });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  term.onData((data) => send({ t: 'in', id: session.id, data }));
  term.onResize(({ cols, rows }) => send({ t: 'resize', id: session.id, cols, rows }));
  const tab = el('button', 'term-tab');
  tab.type = 'button';
  const label = el('span', 'lbl', session.title || session.id);
  const x = el('span', 'x', '✕');
  x.title = '關閉這個終端機';
  tab.append(label, x);
  tab.onclick = (e) => {
    if (e.target === x) {
      closeTab(session.id);
      return;
    }
    activate(session.id);
  };
  tab.ondblclick = () => {
    const title = window.prompt('終端機名稱', label.textContent);
    if (title) send({ t: 'rename', id: session.id, title });
  };
  tabsBar.insertBefore(tab, newBtn);
  const entry = { term, fit, pane, tab, label, title: session.title, alive: session.alive !== false };
  tabs.set(session.id, entry);
  return entry;
}

function themeColors() {
  const dark = document.documentElement.getAttribute('data-mode') === 'dark';
  return dark ? { background: '#14171c', foreground: '#e6e1d8', cursor: '#e6e1d8' } : { background: '#1f2328', foreground: '#f2ede4', cursor: '#f2ede4' };
}

function activate(id) {
  active = id;
  for (const [k, t] of tabs) {
    t.pane.hidden = k !== id;
    t.tab.classList.toggle('on', k === id);
  }
  const t = tabs.get(id);
  if (t && !drawer.hidden) {
    requestAnimationFrame(() => {
      try {
        t.fit.fit();
      } catch (e) {
        /* pane not laid out yet */
      }
      t.term.focus();
    });
  }
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  send({ t: 'close', id });
  t.term.dispose();
  t.pane.remove();
  t.tab.remove();
  tabs.delete(id);
  if (active === id) {
    const next = [...tabs.keys()].pop();
    if (next) activate(next);
    else active = null;
  }
}

function onFrame(f) {
  switch (f.t) {
    case 'hello':
      for (const s of f.sessions || []) {
        makeTab(s);
        send({ t: 'attach', id: s.id });
      }
      if (!active && f.sessions && f.sessions.length) activate(f.sessions[f.sessions.length - 1].id);
      break;
    case 'opened':
      makeTab(f.session);
      activate(f.session.id);
      break;
    case 'attached':
      makeTab(f.session);
      break;
    case 'out': {
      const t = tabs.get(f.id);
      if (t) t.term.write(f.data);
      break;
    }
    case 'exit': {
      const t = tabs.get(f.id);
      if (t) {
        t.alive = false;
        t.term.write(`\r\n\x1b[2m[已結束，exit ${f.code == null ? '?' : f.code}]\x1b[0m\r\n`);
        t.tab.classList.add('dead');
      }
      break;
    }
    case 'renamed': {
      const t = tabs.get(f.session.id);
      if (t) t.label.textContent = f.session.title;
      break;
    }
    case 'error':
      toast(`終端機：${f.message}`, 'bad');
      break;
    default:
      break;
  }
}

// ---- drawer ---------------------------------------------------------------------------------------
async function open(opts = {}) {
  drawer.hidden = false;
  document.body.classList.add('term-open');
  toggle.setAttribute('aria-expanded', 'true');
  try {
    await loadLib();
    await connect();
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }
  if (opts.preset) {
    const t = tabs.get(active);
    send({ t: 'open', preset: opts.preset, title: opts.title || null, cols: t ? t.term.cols : 100, rows: t ? t.term.rows : 30 });
  } else if (!tabs.size) {
    send({ t: 'open', cols: 100, rows: 30 });
  } else if (active) {
    activate(active);
  }
}

function close() {
  drawer.hidden = true;
  document.body.classList.remove('term-open');
  toggle.setAttribute('aria-expanded', 'false');
}

function toggleDrawer() {
  if (drawer.hidden) open();
  else close();
}

// drag handle: remember the height, refit the active tab
let dragging = null;
handle.onpointerdown = (e) => {
  dragging = { y: e.clientY, h: drawer.getBoundingClientRect().height };
  handle.setPointerCapture(e.pointerId);
};
handle.onpointermove = (e) => {
  if (!dragging) return;
  const h = Math.max(160, Math.min(window.innerHeight * 0.85, dragging.h + (dragging.y - e.clientY)));
  document.documentElement.style.setProperty('--term-h', `${h}px`);
};
handle.onpointerup = () => {
  if (!dragging) return;
  dragging = null;
  store('loop_term_h', document.documentElement.style.getPropertyValue('--term-h'));
  if (active) activate(active);
};
const savedH = stored('loop_term_h');
if (savedH) document.documentElement.style.setProperty('--term-h', savedH);

window.addEventListener('resize', () => {
  if (!drawer.hidden && active) activate(active);
});

// say where a new shell starts, so nobody has to run pwd to find out (setting terminal_cwd)
fetch('/api/terminal/access', { headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...nameHeader() } })
  .then((r) => r.json())
  .then((a) => {
    const hint = $('term-hint');
    if (a && a.cwd && hint) hint.textContent = `${a.worktree ? '你的 worktree' : '開在'} ${a.cwd} · Ctrl+\` 開關 · 關掉抽屜不會結束 shell`;
  })
  .catch(() => {});

toggle.onclick = toggleDrawer;
newBtn.onclick = () => {
  const t = tabs.get(active);
  send({ t: 'open', cols: t ? t.term.cols : 100, rows: t ? t.term.rows : 30 });
};
$('term-close').onclick = close;
document.addEventListener('keydown', (e) => {
  // Ctrl+` (Backquote by e.code so the layout does not matter); never while a dialog is up
  if (!e.ctrlKey || e.altKey || e.metaKey || e.code !== 'Backquote') return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  toggleDrawer();
});

/** Other page scripts (the 模型 panel's 「看 log」) open preset tabs through this. */
window.LoopTerminal = {
  open,
  close,
  openPreset: (preset, title) => open({ preset, title }),
};
toggle.hidden = false;
for (const b of document.querySelectorAll('[data-term-preset]')) b.hidden = false;
