// Shared helpers for the operator pages (job.html, task.html, plans.html). Rendering is
// textContent-only: nothing here or in the pages builds HTML from strings.
(() => {
  'use strict';

  const stored = (k) => {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  };
  const store = (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (e) { /* private mode */ }
  };

  // token bootstrap, same as the board: ?token= once, then localStorage
  const params = new URLSearchParams(location.search);
  if (params.get('token')) store('loop_token', params.get('token'));
  const TOKEN = stored('loop_token') || '';

  const who = () => (stored('loop_chat_user') || '').trim();
  function headers(json) {
    const h = {};
    if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
    const n = who();
    if (n) h['x-loop-user'] = encodeURIComponent(n);
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status, data });
    return data;
  }

  /** a link a plain <a href> can open: the API takes the token as ?token= too */
  const withToken = (path) => (TOKEN ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : path);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // stroke icons (24×24 paths), drawn with createElementNS
  const ICONS = {
    check: ['M5 12.5l4.2 4.2L19 7'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    circleCheck: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M8 12.5l2.7 2.7L16 9.8'],
    alert: ['M12 3l9.5 17h-19z', 'M12 10v4', 'M12 17.5v.5'],
    clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 7v5l3 2'],
    hand: ['M8 13V5.5a1.5 1.5 0 0 1 3 0V12', 'M11 11.5V4.5a1.5 1.5 0 0 1 3 0V12', 'M14 12V6.5a1.5 1.5 0 0 1 3 0V14', 'M8 13l-1.6-1.6a1.6 1.6 0 0 0-2.3 2.2L8.5 19a4 4 0 0 0 3 1.3H14a5 5 0 0 0 5-5V9.5a1.5 1.5 0 0 0-3 0'],
    play: ['M8 5v14l11-7z'],
    download: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'],
    upload: ['M12 20V9', 'M7 13l5-5 5 5', 'M5 4h14'],
    sun: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
    moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
    back: ['M15 5l-7 7 7 7'],
  };
  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    }
    return s;
  }

  // SQLite writes UTC ("YYYY-MM-DD HH:MM:SS"); ISO strings pass as is
  function localTime(s) {
    if (!s) return '–';
    const d = new Date(/[TZ]/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`);
    return isNaN(d) ? String(s) : d.toLocaleString('zh-TW', { hour12: false }).replace(/:\d\d$/, '');
  }

  let toastTimer = null;
  function toast(msg, kind) {
    let t = document.getElementById('ops-toast');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'ops-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.className = `toast${kind === 'bad' ? ' bad' : ''}`;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), kind === 'bad' ? 7000 : 3500);
  }

  // header: theme toggle + "你是" (the name every record on these pages is kept under)
  function initChrome() {
    const btn = document.getElementById('theme-btn');
    if (btn) {
      const mode = () => (document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light');
      const paint = () => {
        btn.replaceChildren(icon(mode() === 'dark' ? 'sun' : 'moon'));
        btn.setAttribute('aria-label', mode() === 'dark' ? '切換淺色' : '切換深色');
      };
      btn.onclick = () => {
        const next = mode() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-mode', next);
        store('loop_mode', next);
        paint();
      };
      paint();
    }
    const box = document.getElementById('ops-who');
    if (box) {
      const paint = () => {
        box.replaceChildren();
        box.appendChild(el('span', null, who() ? `你是 ${who()}` : '還沒填名字'));
        const b = el('button', null, who() ? '更改' : '填名字');
        b.type = 'button';
        b.onclick = () => {
          const n = prompt('你的名字（勾選、核可、發佈都會記在這個名字下）', who());
          if (n === null) return;
          store('loop_chat_user', n.trim().slice(0, 40) || null);
          paint();
          document.dispatchEvent(new CustomEvent('ops:who'));
        };
        box.appendChild(b);
      };
      paint();
    }
  }

  window.Ops = { api, el, icon, localTime, toast, withToken, who, initChrome, stored, store };
})();
