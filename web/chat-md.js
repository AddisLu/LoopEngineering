import { el } from './shell.js';

/**
 * Markdown → DOM for model output, plus the sandboxed HTML/SVG preview.
 *
 * Everything is built node by node with textContent: the model's answer is untrusted text and
 * must never be parsed as markup (a static test enforces this across every chat script). Shared
 * by the chat shell (index.html) and the read-only share page.
 */

// ---- markdown → DOM nodes built one by one (model output is untrusted) -----------
// http(s), or a page of this site ('/task.html?id=…' from 對話操作) — never '//host' or '/\\host'
const SAFE_URL = /^(?:https?:\/\/|\/(?![\/\\]))/i;
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_\s][^_]*?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)）」]+)/g;

function link(href, parent, label) {
  const a = el('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (label != null) inline(label, a);
  else a.textContent = href;
  parent.append(a);
}

function inline(text, parent) {
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) parent.append(el('code', null, m[2]));
    else if (m[3] || m[4]) {
      const b = el('strong');
      inline(m[3] || m[4], b);
      parent.append(b);
    } else if (m[5]) {
      const d = el('del');
      inline(m[5], d);
      parent.append(d);
    } else if (m[6]) {
      const i = el('em');
      inline(m[6], i);
      parent.append(i);
    } else if (m[7]) {
      if (SAFE_URL.test(m[8])) link(m[8], parent, m[7]);
      else parent.append(document.createTextNode(m[0]));
    } else if (m[9]) link(m[9], parent);
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function renderList(lines, start, parent, final) {
  const first = LIST_ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = el(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) > 1) list.start = parseInt(first[2], 10);
  let cur = null;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
      if (next && next[1].length >= base) {
        i = j;
        continue;
      }
      break;
    }
    const m = LIST_ITEM.exec(line);
    if (m && m[1].length === base) {
      if (/\d/.test(m[2]) !== ordered) break;
      cur = el('li');
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[3]);
      if (task) {
        const cb = el('input');
        cb.type = 'checkbox';
        cb.disabled = true;
        cb.checked = task[1] !== ' ';
        cur.append(cb, document.createTextNode(' '));
        inline(task[2], cur);
      } else {
        inline(m[3], cur);
      }
      list.append(cur);
      i++;
    } else if (m && m[1].length > base && cur) {
      i = renderList(lines, i, cur, final);
    } else if (!m && cur && /^\s+\S/.test(line) && !/^\s*(```|~~~)/.test(line)) {
      cur.append(el('br'));
      inline(line.trim(), cur);
      i++;
    } else {
      break;
    }
  }
  parent.append(list);
  return i;
}

export function renderMarkdown(src, final) {
  const root = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const startsBlock = (k) =>
    /^\s*(```|~~~|#{1,6}\s|>|<svg[\s>])/i.test(lines[k]) ||
    LIST_ITEM.test(lines[k]) ||
    (lines[k].includes('|') && k + 1 < lines.length && isTableSep(lines[k + 1]));

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(fence[1])) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      root.append(codeBlock(body.join('\n'), fence[2].toLowerCase(), final && closed));
      continue;
    }
    if (/^\s*<svg[\s>]/i.test(line)) {
      // bare SVG without a fence — models often answer a drawing request this way
      const body = [];
      let closed = false;
      while (i < lines.length) {
        body.push(lines[i]);
        i++;
        if (/<\/svg>/i.test(lines[i - 1])) {
          closed = true;
          break;
        }
      }
      root.append(codeBlock(body.join('\n'), 'svg', final && closed));
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const e = el(`h${Math.min(h[1].length + 2, 6)}`);
      inline(h[2].replace(/\s+#+\s*$/, ''), e);
      root.append(e);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      root.append(el('hr'));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const bq = el('blockquote');
      bq.append(renderMarkdown(quoted.join('\n'), final));
      root.append(bq);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const wrap = el('div', 'tbl');
      const table = el('table');
      const head = el('tr');
      for (const c of splitRow(line)) {
        const th = el('th');
        inline(c, th);
        head.append(th);
      }
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const tr = el('tr');
        for (const c of splitRow(lines[i])) {
          const td = el('td');
          inline(c, td);
          tr.append(td);
        }
        tbody.append(tr);
        i++;
      }
      table.append(thead, tbody);
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      i = renderList(lines, i, root, final);
      continue;
    }
    const p = el('p');
    let k = i;
    while (k < lines.length && lines[k].trim() && (k === i || !startsBlock(k))) {
      if (k > i) p.append(el('br'));
      inline(lines[k], p);
      k++;
    }
    root.append(p);
    i = Math.max(k, i + 1);
  }
  return root;
}

// ---- HTML / SVG previews ------------------------------------------------------
// Sandbox grants scripts only (no same-origin): the preview runs in an opaque origin, so it cannot read
// this page, its stored API token, or call /api. The CSP blocks every network request except
// scripts/fonts from the two big CDNs, so a generated page cannot send data anywhere.
const PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src data: https://fonts.gstatic.com; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com";
const SIZER =
  "<script>(function(){function s(){try{parent.postMessage({loopChatFrameHeight:Math.ceil(document.documentElement.scrollHeight)},'*')}catch(e){}}" +
  "addEventListener('load',s);if(window.ResizeObserver)new ResizeObserver(s).observe(document.documentElement);setTimeout(s,60);setTimeout(s,700)})()<\/script>";

function withHead(html, head) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

function previewFrame(code, isSvg) {
  const frame = el('iframe', 'artifact');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = isSvg ? 'SVG 預覽' : 'HTML 預覽';
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const doc = isSvg
    ? `<!doctype html><html><head>${head}<style>html,body{margin:0;background:#fff}body{display:flex;justify-content:center;padding:12px}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`
    : withHead(code, head);
  frame.srcdoc = doc + SIZER;
  return frame;
}

window.addEventListener('message', (e) => {
  const h = e.data && e.data.loopChatFrameHeight;
  if (typeof h !== 'number') return;
  for (const f of document.querySelectorAll('iframe.artifact')) {
    if (f.contentWindow === e.source) {
      f.style.height = `${Math.max(120, Math.min(h + 4, 2400))}px`;
      break;
    }
  }
});

/** Full-window preview: a CF-AOI flow diagram is unreadable inside a narrow column. */
function openFull(code, isSvg) {
  const dlg = el('dialog', 'artifact-full');
  const bar = el('div', 'codebar');
  bar.append(el('span', 'lang', isSvg ? 'svg 預覽' : 'html 預覽'));
  const close = el('button', 'mini', '關閉');
  close.type = 'button';
  close.onclick = () => dlg.close();
  bar.append(close);
  dlg.append(bar, previewFrame(code, isSvg));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---- 調參建議 ---------------------------------------------------------------
// Mirror of parseTuneBlock in src/chat/tune.ts: same shape, same tolerance. A model that ignores
// the format must degrade to an ordinary code block, never to a broken page.
const RISK_LABEL = { low: '低', medium: '中', high: '高' };

/** Whole answer → card. Mirrors parseTuneBlock (src/chat/tune.ts): first fence only, tolerant. */
export function parseTuneMarkdown(markdown) {
  const m = /```loop-tune(?:\s+json)?\s*\n([\s\S]*?)```/i.exec(markdown || '');
  return m && m[1] ? parseTune(m[1]) : null;
}

export function parseTune(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return null;
  }
  if (!raw || !Array.isArray(raw.suggestions)) return null;
  const suggestions = [];
  for (const s of raw.suggestions.slice(0, 20)) {
    if (!s || typeof s !== 'object') continue;
    const clamp = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 400);
    const file = clamp(s.file);
    const param = clamp(s.param);
    const proposed = clamp(s.proposed);
    if (!file || !param || !proposed) continue;
    const risk = RISK_LABEL[String(s.risk || '').toLowerCase()] ? String(s.risk).toLowerCase() : 'medium';
    suggestions.push({ file, param, proposed, risk, current: clamp(s.current) || null, why: clamp(s.why), verify: clamp(s.verify) });
  }
  if (!suggestions.length) return null;
  return { symptom: String(raw.symptom || '').trim(), suggestions };
}

function tuneCard(card) {
  const box = el('div', 'tune-card');
  const head = el('div', 'tune-head');
  head.append(el('strong', null, '調參建議'), el('span', 'tune-warn', '建議而已，尚未套用到任何機台'));
  box.append(head);
  if (card.symptom) box.append(el('p', 'tune-symptom', `症狀：${card.symptom}`));

  const wrap = el('div', 'tbl');
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['檔案', '參數', '目前', '建議', '風險']) hr.append(el('th', null, h));
  thead.append(hr);
  const tbody = el('tbody');
  for (const s of card.suggestions) {
    const tr = el('tr');
    tr.append(el('td', 'mono', s.file), el('td', 'mono', s.param));
    tr.append(el('td', null, s.current == null ? '（未記載）' : s.current));
    tr.append(el('td', 'proposed', s.proposed));
    const riskCell = el('td');
    riskCell.append(el('span', `risk r-${s.risk}`, RISK_LABEL[s.risk]));
    tr.append(riskCell);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  box.append(wrap);

  for (const s of card.suggestions) {
    if (!s.why && !s.verify) continue;
    const d = el('details', 'tune-why');
    d.append(el('summary', null, `${s.param}：為什麼、怎麼驗`));
    if (s.why) d.append(el('p', null, s.why));
    if (s.verify) d.append(el('p', 'verify', `驗證：${s.verify}`));
    box.append(d);
  }
  box.append(el('p', 'hint', '按這則回答下方的「轉成任務」，會開一張 Loop 草稿任務帶著這張表；實際數值仍由工程師確認後才改。'));
  return box;
}

export function codeBlock(code, lang, ready) {
  if (lang === 'loop-tune' && ready) {
    const card = parseTune(code);
    if (card) return tuneCard(card);
  }
  const isSvg = lang === 'svg' || ((lang === 'xml' || lang === '') && /^\s*<svg[\s>]/i.test(code));
  const canPreview = lang === 'html' || lang === 'htm' || isSvg;
  const box = el('div', 'codebox');
  const bar = el('div', 'codebar');
  bar.append(el('span', 'lang', isSvg ? 'svg' : lang || 'code'));
  const pre = el('pre');
  pre.append(el('code', null, code));
  const copy = el('button', 'mini', '複製');
  copy.type = 'button';
  copy.onclick = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(
      () => {
        copy.textContent = '已複製';
        setTimeout(() => (copy.textContent = '複製'), 1200);
      },
      () => {},
    );
  };
  if (canPreview && ready) {
    const frame = previewFrame(code, isSvg);
    const showPreview = el('button', 'mini on', '預覽');
    const showCode = el('button', 'mini', '原始碼');
    showPreview.type = 'button';
    showCode.type = 'button';
    pre.hidden = true;
    showPreview.onclick = () => {
      frame.hidden = false;
      pre.hidden = true;
      showPreview.classList.add('on');
      showCode.classList.remove('on');
    };
    showCode.onclick = () => {
      frame.hidden = true;
      pre.hidden = false;
      showCode.classList.add('on');
      showPreview.classList.remove('on');
    };
    const zoom = el('button', 'mini', '放大');
    zoom.type = 'button';
    zoom.title = '在整個視窗裡看這張圖／這個頁面';
    zoom.onclick = () => openFull(code, isSvg);
    bar.append(showPreview, showCode, zoom, copy);
    box.append(bar, frame, pre);
  } else {
    if (canPreview) bar.append(el('span', 'hint', '寫完後顯示預覽'));
    bar.append(copy);
    box.append(bar, pre);
  }
  return box;
}

