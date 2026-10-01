import { api, authHeaders, el, nameHeader, toast } from './shell.js';
import { openTicket } from './fix-handoff.js';

/**
 * The per-message action bar.
 *
 * Kept out of chat.js on purpose: these call /api/chat/messages/:id/* endpoints that are *not*
 * history writes, and chat.js's static guard requires every history call there to sit inside
 * histSafe. Failures here surface as a toast and change nothing else.
 */

function actionBtn(label, title, onClick) {
  const b = el('button', 'mini', label);
  b.type = 'button';
  b.title = title;
  b.onclick = () => onClick(b);
  return b;
}

/** Best-effort copy: the clipboard is unavailable in plenty of contexts, and losing the thing
 *  being copied because of that is never acceptable — callers must still show the value. */
async function copyQuiet(text) {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

function copyText(text, btn) {
  if (!navigator.clipboard) return toast('這個瀏覽器不給複製', 'warn');
  navigator.clipboard.writeText(text).then(
    () => {
      const was = btn.textContent;
      btn.textContent = '已複製';
      setTimeout(() => (btn.textContent = was), 1200);
    },
    () => toast('複製失敗', 'bad'),
  );
}

function markDone(btn, label) {
  btn.textContent = label;
  btn.classList.add('done');
  btn.disabled = true;
}

function linkTask(btn, taskId) {
  btn.textContent = `已建任務 ${taskId} ↗`;
  btn.classList.add('done');
  btn.disabled = false;
  btn.onclick = () => window.open(`/board.html#task=${encodeURIComponent(taskId)}`, '_blank', 'noopener');
}

/** 存進知識庫: writes the answer into the vault source and re-indexes it (captureNote). */
async function capture(view, btn) {
  if (!view.messageId) return toast('這則回答還沒存進歷史，稍等一下再試', 'warn');
  btn.disabled = true;
  try {
    const r = await api(`/api/chat/messages/${view.messageId}/capture`, { method: 'POST', body: '{}' });
    view.capturedPath = r.path;
    markDone(btn, r.existing ? '已存 KB' : '已存進知識庫');
    if (!r.existing) toast(`已存進知識庫：${r.path}`, 'ok');
  } catch (err) {
    btn.disabled = false;
    toast(`存不進去：${err.message}`, 'bad');
  }
}

/**
 * 轉成任務: first ask the server what kind of work this answer looks like (local model, keyword
 * fallback), then let the operator confirm in a small dialog. Each choice has its own exit:
 * a fix / feature / perf → a new 問題單 (fix.html, prefilled with the question, the symptom and
 * the answer), spike → a fresh repo + task, todo → the plain draft task.
 */
const INTENTS = [
  ['ticket', '開問題單', '程式錯誤、要加功能或變快 — 帶著問題與這則回答開一張問題單，Loop 分析後修'],
  ['spike', '驗證新技術／套件', '在 ~/Addis/spikes 開一個新 repo，裝起來跑 demo、寫 REPORT.md'],
  ['todo', '待辦／純紀錄', '只留一張草稿任務，內容就是這則回答'],
];
const KIND_OPTS = [['algo', '演算法／判定規則'], ['bugfix', '程式錯誤'], ['feature', '功能新增'], ['perf', '效能']];

function linkDraft(btn, draftId) {
  btn.textContent = '工作流程草稿 ↗';
  btn.classList.add('done');
  btn.disabled = false;
  btn.onclick = () => window.open(`/flow.html?draft=${encodeURIComponent(draftId)}`, '_blank', 'noopener');
}

function field(labelText, input) {
  const l = el('label');
  l.append(el('span', null, labelText), input);
  return l;
}
function textInput(value, placeholder) {
  const i = el('input');
  i.type = 'text';
  i.value = value || '';
  if (placeholder) i.placeholder = placeholder;
  return i;
}

async function repoOptions(hint) {
  const sel = el('select');
  let uris = [];
  try {
    const r = await api('/api/sources');
    uris = (r.sources || []).filter((x) => x.kind === 'git' && x.enabled).map((x) => x.uri);
  } catch (e) {
    /* no sources → manual only */
  }
  for (const u of uris) {
    const o = el('option', null, u);
    o.value = u;
    sel.append(o);
  }
  const manual = el('option', null, '（在問題單上再選）');
  manual.value = '';
  sel.append(manual);
  sel.value = hint && uris.includes(hint) ? hint : uris[0] || '';
  return sel;
}

async function openTaskChooser(view, s) {
  const dlg = el('dialog', 'task-chooser');
  dlg.append(el('h3', null, '這則回答要變成什麼任務？'));
  const why = s.model_ready && s.confidence !== 'low' ? `建議：${s.reason}` : `不太確定（${s.reason}），請你選`;
  dlg.append(el('p', 'dialog-hint', why));

  let intent = ['fix', 'feature', 'perf'].includes(s.intent) ? 'ticket' : s.intent;
  const opts = el('div', 'opts');
  const cards = new Map();
  for (const [key, label, blurb] of INTENTS) {
    const c = el('button', 'opt');
    c.type = 'button';
    c.append(el('b', null, label), el('span', null, blurb));
    c.onclick = () => choose(key);
    cards.set(key, c);
    opts.append(c);
  }
  dlg.append(opts);

  const title = textInput(s.title, '任務標題');
  dlg.append(field('標題', title));

  // 開問題單: what goes into the ticket's description
  const fixBox = el('div', 'intent-fields');
  const kindSel = el('select');
  for (const [k, l] of KIND_OPTS) {
    const o = el('option', null, l);
    o.value = k;
    kindSel.append(o);
  }
  kindSel.value = (s.fix && s.fix.kind) || (s.intent === 'perf' ? 'perf' : s.intent === 'feature' ? 'feature' : 'algo');
  const repoSel = await repoOptions(s.repo_hint);
  const symptom = textInput(s.fix ? s.fix.symptom : '', '現況／症狀');
  const expected = textInput(s.fix ? s.fix.expected : '', '期望行為');
  fixBox.append(field('改動類型', kindSel), field('Repo', repoSel), field('現況／症狀', symptom), field('期望行為', expected));
  fixBox.append(el('p', 'dialog-hint', '問題單會在新分頁打開，確認 repo 後按「請 Loop 分析」'));
  dlg.append(fixBox);

  // spike
  const spikeBox = el('div', 'intent-fields');
  const spName = textInput(s.spike ? s.spike.name : '', '英文短名，例如 tgv-inspector');
  const slugNote = el('p', 'dialog-hint', '');
  const paintSlug = () => (slugNote.textContent = `會建立 ~/Addis/spikes/${(spName.value || 'spike').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}（含 git origin）`);
  spName.oninput = paintSlug;
  paintSlug();
  const spGoal = el('textarea');
  spGoal.rows = 3;
  spGoal.value = s.spike ? s.spike.goal : '';
  spGoal.placeholder = '要驗證什麼、怎樣算成功';
  const urlBox = el('div', 'url-list');
  const urlChecks = [];
  const urls = [...new Set([...(s.spike ? s.spike.urls : []), ...(s.sources || []).map((x) => x.url)])].slice(0, 8);
  for (const u of urls) {
    const l = el('label', 'url');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = u;
    l.append(cb, el('span', null, u));
    urlChecks.push(cb);
    urlBox.append(l);
  }
  spikeBox.append(field('名稱', spName), slugNote, field('目標', spGoal));
  if (urls.length) spikeBox.append(field('來源網址', urlBox));
  dlg.append(spikeBox);

  const menu = el('menu');
  const cancel = el('button', 'btn', '取消');
  cancel.type = 'button';
  cancel.onclick = () => dlg.close();
  const go = el('button', 'btn primary', '建立');
  go.type = 'button';
  menu.append(cancel, go);
  dlg.append(menu);

  const NOTE = { ticket: '開問題單 ↗', spike: '建立 spike', todo: '建立待辦' };
  function choose(key) {
    intent = key;
    for (const [k, c] of cards) c.classList.toggle('on', k === key);
    fixBox.hidden = key !== 'ticket';
    spikeBox.hidden = key !== 'spike';
    go.textContent = NOTE[key];
  }
  choose(cards.has(intent) ? intent : 'todo');

  go.onclick = async () => {
    go.disabled = true;
    if (intent === 'ticket') {
      const { dropped } = openTicket({ description: ticketText(view, title.value, symptom.value, expected.value, s.sources), repoHint: repoSel.value, kind: kindSel.value });
      if (dropped) toast('截圖太大帶不過去，請在問題單上再貼一次', 'warn');
      dlg.close();
      return;
    }
    const body = { intent, title: title.value.trim() };
    if (intent === 'spike') {
      body.spike = { name: spName.value.trim(), goal: spGoal.value.trim(), urls: urlChecks.filter((c) => c.checked).map((c) => c.value) };
    }
    try {
      const r = await api(`/api/chat/messages/${view.messageId}/task`, { method: 'POST', body: JSON.stringify(body) });
      applyTaskResult(view, r);
      dlg.close();
    } catch (err) {
      go.disabled = false;
      toast(`建立失敗：${err.message}`, 'bad');
    }
  };
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/** The 問題單 description: the person's question, the symptom and expectation, and the answer (trimmed). */
function ticketText(view, title, symptom, expected, sources) {
  let q = view.wrap.previousElementSibling;
  while (q && !q.classList.contains('user')) q = q.previousElementSibling;
  const question = q ? (q.querySelector('.body') || q).textContent.trim() : '';
  const answer = view.entry && typeof view.entry.content === 'string' ? view.entry.content : view.body.textContent;
  const parts = [title.trim(), question && question !== title.trim() ? question : ''];
  if (symptom.trim()) parts.push(`現況：${symptom.trim()}`);
  if (expected.trim()) parts.push(`期望：${expected.trim()}`);
  parts.push(`（對話裡的回答，供參考）\n${String(answer || '').trim().slice(0, 3000)}`);
  const refs = (sources || []).slice(0, 5).map((x) => x.url || x.path || x.title).filter(Boolean);
  if (refs.length) parts.push(`參考：\n${refs.map((r) => `- ${r}`).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}

function applyTaskResult(view, r) {
  const btn = view.taskBtn;
  if (r.kind === 'draft') {
    view.draftId = r.draft.id;
    if (btn) linkDraft(btn, r.draft.id);
    if (!r.existing) window.open(r.url, '_blank', 'noopener');
    toast(r.existing ? '這則回答已經有一份工作流程草稿' : '已開工作流程草稿（新分頁）', 'ok', { text: '開工作流程 ↗', href: r.url });
    return;
  }
  view.taskId = r.task.id;
  if (btn) linkTask(btn, r.task.id);
  toast(
    r.existing ? `這則回答已經開過任務 ${r.task.id}` : r.repo_path ? `已建立 spike：${r.repo_path}（任務 ${r.task.id}，還沒排程）` : `已建立草稿任務 ${r.task.id}（還沒排程）`,
    'ok',
    { text: '在看板打開 ↗', href: `/board.html#task=${r.task.id}` },
  );
}

async function toTask(view, btn) {
  if (!view.messageId) return toast('這則回答還沒存進歷史，稍等一下再試', 'warn');
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = '判斷中…';
  try {
    const s = await api(`/api/chat/messages/${view.messageId}/intent`, { method: 'POST', body: '{}' });
    if (s.existing_task_id || s.existing_draft_id) {
      // already turned into something — the server returns it without a dialog
      applyTaskResult(view, await api(`/api/chat/messages/${view.messageId}/task`, { method: 'POST', body: '{}' }));
      return;
    }
    await openTaskChooser(view, s);
  } catch (err) {
    toast(`無法判斷：${err.message}`, 'bad');
  } finally {
    if (!view.taskId && !view.draftId) {
      btn.disabled = false;
      btn.textContent = was;
    }
  }
}

/**
 * 請雲端複核: the only action that leaves this machine. Can take a minute, so the button shows a
 * running clock and the answer arrives as its own bubble.
 */
async function escalate(view, btn, ctx) {
  if (!view.messageId) return toast('這則回答還沒存進歷史，稍等一下再試', 'warn');
  btn.disabled = true;
  const started = Date.now();
  const tick = setInterval(() => (btn.textContent = `雲端複核中 ${Math.round((Date.now() - started) / 1000)}s`), 1000);
  btn.textContent = '雲端複核中 0s';
  try {
    const msg = await api(`/api/chat/messages/${view.messageId}/escalate`, { method: 'POST', body: '{}' });
    ctx.addCloudReview(msg, view);
    markDone(btn, '已複核');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '請雲端複核';
    // a dropped connection does not cancel the review: it is saved when the cloud model answers
    const hint = /fetch|network|timeout|逾時/i.test(err.message) ? '（連線斷了，複核可能仍在背景完成，重新整理看看）' : '';
    toast(`${err.message}${hint}`, 'bad');
  } finally {
    clearInterval(tick);
  }
}

/**
 * The ⋯ menu for the open conversation: export, share, delete.
 * Sharing publishes a read-only page, so the button says so and the link is shown, not hidden.
 */
/**
 * The 說明 menu in the topbar. Static links (the pages are plain HTML), so this only has to open
 * and close — but it has to be in the topbar: both guides used to live at the bottom of the
 * history drawer, below the conversation list, where nobody scrolls.
 */
export function mountHelpMenu() {
  const btn = document.getElementById('help-menu');
  const list = document.getElementById('help-menu-list');
  if (!btn || !list) return;
  const close = () => {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.onclick = () => {
    if (!list.hidden) return close();
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  for (const a of list.querySelectorAll('a')) a.addEventListener('click', close);
  // the button holds an icon: a click on it lands on the <svg>, which is still the button
  document.addEventListener('click', (e) => {
    if (!list.hidden && !list.contains(e.target) && !btn.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

export function mountConvMenu(ctx) {
  const btn = document.getElementById('conv-menu');
  const list = document.getElementById('conv-menu-list');

  const close = () => {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const item = (label, onClick) => {
    const b = el('button', 'menu-item', label);
    b.type = 'button';
    b.onclick = async () => {
      close();
      await onClick();
    };
    return b;
  };

  // build() awaits the server in the middle, so two quick opens used to interleave: the second
  // pass cleared and refilled the list, then the first pass appended 分享／刪除 on top of it.
  let buildSeq = 0;
  async function build() {
    const mine = ++buildSeq;
    const id = ctx.conversation();
    list.replaceChildren();
    if (!id) return list.append(el('p', 'menu-note', '先問一個問題，這個對話才會存起來。'));

    list.append(
      el('p', 'menu-note', '只要存一則回答（含它產生的圖或程式碼），用那則回答下方的「存檔」。'),
      item('匯出整段對話（Markdown）', () => {
        // a plain link download: the server sets the filename, including Chinese titles
        const a = el('a');
        a.href = `/api/chat/conversations/${id}/export?format=md`;
        a.download = '';
        a.click();
      }),
      item('匯出整段對話（HTML）', () => exportHtml()),
    );

    let shared = null;
    try {
      shared = await api(`/api/chat/conversations/${id}`);
    } catch (e) {
      /* the menu still offers export */
    }
    if (mine !== buildSeq) return; // a newer build owns the list now
    const token = shared && shared.conversation ? shared.conversation.share_token : null;
    if (token) {
      const url = `${location.origin}/share.html#${token}`;
      list.append(
        item('複製分享連結', async () => {
          const copied = await copyQuiet(url);
          toast(copied ? '連結已複製' : url, 'ok', { text: '開啟 ↗', href: `/share.html#${token}` });
        }),
        item('取消分享', async () => {
          try {
            await api(`/api/chat/conversations/${id}/share`, { method: 'DELETE' });
            toast('已取消分享，舊連結立刻失效', 'ok');
          } catch (err) {
            toast(err.message, 'bad');
          }
        }),
      );
      list.append(el('p', 'menu-note', '任何拿到這個連結的人都看得到這段對話（唯讀、不含圖片）。'));
    } else {
      list.append(
        item('建立分享連結', async () => {
          let r;
          try {
            r = await api(`/api/chat/conversations/${id}/share`, { method: 'POST', body: '{}' });
          } catch (err) {
            return toast(err.message, 'bad');
          }
          // the link exists now — copying is a convenience, never a reason to lose it
          const copied = await copyQuiet(`${location.origin}${r.url}`);
          toast(copied ? '分享連結已建立並複製（唯讀，可隨時取消）' : `分享連結已建立：${r.url}`, 'ok', {
            text: '開啟 ↗',
            href: r.url,
          });
        }),
      );
    }

    list.append(
      item('刪除這個對話', async () => {
        if (!window.confirm('刪除這個對話？')) return;
        try {
          await api(`/api/chat/conversations/${id}`, { method: 'DELETE' });
          ctx.afterDelete();
        } catch (err) {
          toast(err.message, 'bad');
        }
      }),
    );
  }

  btn.onclick = async () => {
    if (!list.hidden) return close();
    await build();
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('click', (e) => {
    if (!list.hidden && !list.contains(e.target) && !btn.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

// ---- saving one answer -------------------------------------------------------------------
// The whole-conversation export lives in the ⋯ menu; what people actually want is the diagram or
// the script *this* answer produced, as a file, without the rest of the conversation around it.

const EXPORT_CSS = [
  'body{font:15px/1.7 system-ui,"PingFang TC","Noto Sans TC",sans-serif;max-width:900px;margin:32px auto;padding:0 18px;color:#2a2621;background:#fbf8f2}',
  '.msg{margin:0 0 22px}.who{font-size:12px;opacity:.6;margin-bottom:4px}',
  '.msg.user .body{background:#e7eef7;padding:10px 14px;border-radius:12px;white-space:pre-wrap}',
  'pre{background:#efeae0;padding:10px 12px;border-radius:8px;overflow-x:auto}',
  'table{border-collapse:collapse}th,td{border:1px solid #e4ddd0;padding:6px 10px}',
  'svg{max-width:100%;height:auto}',
  '.meta{font-size:12px;opacity:.6}.refs{font-size:13px}.tools{font-size:13px}.tools ol{list-style:none;padding:0}.tools ul{font-size:12.5px}',
].join('');

/** Strip everything interactive from a copy of a rendered message/log. */
function staticCopy(node) {
  const copy = node.cloneNode(true);
  for (const n of copy.querySelectorAll('button, iframe, .actions, .trim-note, .codebar')) n.remove();
  for (const d of copy.querySelectorAll('details')) d.setAttribute('open', '');
  return copy;
}

function htmlDoc(title, bodyHtml) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title><style>${EXPORT_CSS}</style></head><body><h1>${title}</h1>${bodyHtml}</body></html>`;
}

function download(name, text, mime) {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([text], { type: `${mime}; charset=utf-8` }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Print to paper or to PDF without touching the page: same document, hidden iframe. */
function printDoc(title, bodyHtml) {
  const frame = el('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0';
  document.body.append(frame);
  frame.srcdoc = htmlDoc(title, bodyHtml);
  frame.onload = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      toast('這個瀏覽器不給列印，請用「匯出 HTML」再列印', 'warn');
    }
    setTimeout(() => frame.remove(), 60000);
  };
}

const CODE_EXT = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', bash: 'sh', sh: 'sh', shell: 'sh',
  json: 'json', yaml: 'yml', yml: 'yml', sql: 'sql', cpp: 'cpp', 'c++': 'cpp', c: 'c', csharp: 'cs', cs: 'cs',
  html: 'html', htm: 'html', xml: 'xml', css: 'css', markdown: 'md', md: 'md', svg: 'svg', mermaid: 'mmd',
};

/** Fenced blocks of an answer, in order — the same source the renderer drew from. */
export function fencedBlocks(markdown) {
  const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown || '')) !== null) {
    const lang = (m[1] || '').trim().toLowerCase().split(/\s+/)[0] || '';
    const code = m[2] ?? '';
    const isSvg = lang === 'svg' || ((lang === '' || lang === 'xml') && /^\s*<svg[\s>]/i.test(code));
    out.push({ lang: isSvg ? 'svg' : lang, code, ext: isSvg ? 'svg' : CODE_EXT[lang] || 'txt' });
  }
  return out;
}

const safeName = (s) => (s || '回答').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 60) || '回答';

// The browser can make every format except the deck: python-pptx lives on the server. Asked once.
let pptxReady = null;
async function pptxAvailable() {
  if (pptxReady === null) {
    try {
      const r = await api('/api/chat/export/formats');
      pptxReady = { ok: Boolean(r.pptx), detail: r.pptx_detail || '' };
    } catch (e) {
      pptxReady = { ok: false, detail: e.message };
    }
  }
  return pptxReady;
}

/** Ask the server to draw this answer as slides, then hand the file to the browser. */
async function downloadPptx(view, btn) {
  if (!view.messageId) return toast('這則回答還沒存好，稍等一下再試', 'warn');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    const r = await fetch(`/api/chat/messages/${encodeURIComponent(view.messageId)}/pptx`, { method: 'POST', headers: { ...authHeaders, ...nameHeader() } });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const name = /filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') || '');
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = name && name[1] ? decodeURIComponent(name[1]) : '回答.pptx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('簡報已下載', 'ok');
  } catch (e) {
    toast(`簡報產生失敗：${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

/** 存檔: everything this one answer can become. Only offers what the answer actually contains. */
function openSaveDialog(view) {
  const md = view.entry && typeof view.entry.content === 'string' ? view.entry.content : view.body.textContent;
  const title = document.getElementById('conv-title');
  const base = safeName(`${title ? title.textContent : '對話'}-回答${view.ord ? ` ${view.ord}` : ''}`);
  const bodyHtml = staticCopy(view.wrap).outerHTML;
  const blocks = fencedBlocks(md);

  const dlg = el('dialog', 'save-dialog');
  dlg.append(el('h3', null, '存這則回答'));
  dlg.append(el('p', 'dialog-hint', '只存這一則，不含對話的其他部分。圖與程式碼各自成檔。'));
  const rows = el('div', 'save-rows');
  const row = (label, hint, run) => {
    const b = el('button', 'opt');
    b.type = 'button';
    b.append(el('b', null, label), el('span', null, hint));
    b.onclick = () => {
      run();
      dlg.close();
    };
    rows.append(b);
  };

  row('Markdown（.md）', '模型寫出來的原始文字', () => download(`${base}.md`, md, 'text/markdown'));
  row('HTML（.html）', '排版後的樣子，含表格與圖', () => download(`${base}.html`, htmlDoc(base, bodyHtml), 'text/html'));
  row('列印／存成 PDF', '開列印視窗，目的地選「另存為 PDF」', () => printDoc(base, bodyHtml));

  // the deck is drawn on the server; the row appears only once the server says it can
  const deckRow = el('button', 'opt');
  deckRow.type = 'button';
  deckRow.hidden = true;
  deckRow.append(el('b', null, '簡報（.pptx）'), el('span', null, '標題、條列、表格與圖各成一頁'));
  deckRow.onclick = () => downloadPptx(view, deckRow.querySelector('b'));
  rows.append(deckRow);
  pptxAvailable().then((p) => {
    deckRow.hidden = false;
    if (!p.ok) {
      deckRow.disabled = true;
      deckRow.querySelector('span').textContent = p.detail || '這台機器沒有 python-pptx';
    }
  });

  const svgs = blocks.filter((b) => b.lang === 'svg');
  const pages = blocks.filter((b) => b.lang === 'html' || b.lang === 'htm');
  const code = blocks.filter((b) => b.lang !== 'svg' && b.lang !== 'html' && b.lang !== 'htm');
  svgs.forEach((b, i) => row(`圖 ${i + 1}（.svg）`, '向量圖，可放進簡報或 Word', () => download(`${base}-圖${i + 1}.svg`, b.code, 'image/svg+xml')));
  pages.forEach((b, i) => row(`網頁 ${i + 1}（.html）`, '這則回答產生的頁面本身', () => download(`${base}-頁${i + 1}.html`, b.code, 'text/html')));
  code.forEach((b, i) => row(`程式碼 ${i + 1}（.${b.ext}）`, b.lang || '純文字', () => download(`${base}-${i + 1}.${b.ext}`, b.code, 'text/plain')));

  dlg.append(rows);
  const foot = el('div', 'dialog-foot');
  const close = el('button', 'btn sm', '關閉');
  close.type = 'button';
  close.onclick = () => dlg.close();
  foot.append(close);
  dlg.append(foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/**
 * HTML export is done here rather than on the server: the page already holds the rendered
 * answer, tables and all. Interactive bits (buttons, previews) are dropped; code stays as text.
 */
function exportHtml() {
  const log = document.getElementById('log').cloneNode(true);
  for (const n of log.querySelectorAll('button, iframe, .actions, .trim-note')) n.remove();
  for (const d of log.querySelectorAll('details')) d.setAttribute('open', '');
  const title = document.getElementById('conv-title').textContent || '對話';
  const css = [
    'body{font:15px/1.7 system-ui,"PingFang TC","Noto Sans TC",sans-serif;max-width:900px;margin:32px auto;padding:0 18px;color:#2a2621;background:#fbf8f2}',
    '.msg{margin:0 0 22px}.who{font-size:12px;opacity:.6;margin-bottom:4px}',
    '.msg.user .body{background:#e7eef7;padding:10px 14px;border-radius:12px;white-space:pre-wrap}',
    'pre{background:#efeae0;padding:10px 12px;border-radius:8px;overflow-x:auto}',
    'table{border-collapse:collapse}th,td{border:1px solid #e4ddd0;padding:6px 10px}',
    '.meta{font-size:12px;opacity:.6}.refs{font-size:13px}.tools{font-size:13px}.tools ol{list-style:none;padding:0}.tools ul{font-size:12.5px}',
  ].join('');
  const doc = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body><h1>${title}</h1>${log.outerHTML}</body></html>`;
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
  a.download = `${title}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/**
 * Attach (or re-attach) the bar to a rendered message.
 * `view` is the handle chat.js builds in addMsg/replayMsg: { wrap, body, ord, messageId, entry }.
 */
export function mountActions(view, ctx) {
  if (view.actions) view.actions.remove();
  const bar = el('div', 'actions');
  const isUser = view.wrap.classList.contains('user');
  const text = () => (view.entry && typeof view.entry.content === 'string' ? view.entry.content : view.body.textContent);

  if (isUser) {
    bar.append(
      actionBtn('編輯重問', '把這個問題放回輸入框，重新問一次（之後的回答會被移除）', () => ctx.editAgain(view)),
      actionBtn('複製', '複製這則訊息', (b) => copyText(view.text || text(), b)),
    );
  } else {
    bar.append(
      actionBtn('重答', '丟掉這個回答，請模型重新回答一次', () => ctx.regenerate(view)),
      actionBtn('複製', '複製這個回答的原始文字', (b) => copyText(text(), b)),
      actionBtn('存檔', '把這則回答存成檔案：Markdown、HTML、PDF，或它產生的圖與程式碼', () => openSaveDialog(view)),
      actionBtn('存進知識庫', '把這個回答存成知識庫筆記，之後對話查得到', (b) => capture(view, b)),
      actionBtn('轉成任務', '先判斷這則回答該變成哪種工作（開問題單／驗證新技術／待辦），確認後再開', (b) => toTask(view, b)),
      actionBtn('請雲端複核', '把這個回答送給雲端高階模型複核（會花訂閱額度，預設關閉）', (b) => escalate(view, b, ctx)),
    );
    const byLabel = (label) => [...bar.children].find((c) => c.textContent === label);
    if (view.capturedPath) markDone(byLabel('存進知識庫'), '已存 KB');
    view.taskBtn = byLabel('轉成任務');
    if (view.taskId) linkTask(view.taskBtn, view.taskId);
    else if (view.draftId) linkDraft(view.taskBtn, view.draftId);
  }

  view.wrap.append(bar);
  view.actions = bar;
  return bar;
}
