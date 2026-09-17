import { api, el, toast } from './shell.js';

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
 * fix/feature/perf → a pre-filled PRD-wizard draft, spike → a fresh repo + task, todo → the
 * plain draft task. All idempotent on the server (one task or draft per answer).
 */
const INTENTS = [
  ['fix', '軟體修正', '機況／判錯／crash — 帶著症狀與參考資料進 PRD 精靈，改現有程式'],
  ['feature', '功能或效能', '要多一個功能，或要更快 — 進 PRD 精靈'],
  ['spike', '驗證新技術／套件', '在 ~/Addis/spikes 開一個新 repo，裝起來跑 demo、寫 REPORT.md'],
  ['todo', '待辦／純紀錄', '只留一張草稿任務，內容就是這則回答'],
];
const KIND_OPTS = [['algo', '演算法／判定規則'], ['bugfix', '程式錯誤'], ['feature', '功能新增'], ['perf', '效能']];

function linkDraft(btn, draftId) {
  btn.textContent = 'PRD 草稿 ↗';
  btn.classList.add('done');
  btn.disabled = false;
  btn.onclick = () => window.open(`/prd.html?draft=${encodeURIComponent(draftId)}`, '_blank', 'noopener');
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
  const manual = el('option', null, '（在精靈裡再選）');
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

  let intent = s.intent === 'perf' ? 'feature' : s.intent;
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

  // fix / feature: PRD wizard prefill
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
  if (s.sources && s.sources.length) fixBox.append(el('p', 'dialog-hint', `會帶入 ${Math.min(5, s.sources.length)} 個參考來源到精靈的範圍段落`));
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

  const NOTE = { fix: '開精靈 ↗', feature: '開精靈 ↗', spike: '建立 spike', todo: '建立待辦' };
  function choose(key) {
    intent = key;
    for (const [k, c] of cards) c.classList.toggle('on', k === key);
    fixBox.hidden = !(key === 'fix' || key === 'feature');
    spikeBox.hidden = key !== 'spike';
    go.textContent = NOTE[key];
    if (key === 'fix' && !['algo', 'bugfix'].includes(kindSel.value)) kindSel.value = 'algo';
    if (key === 'feature' && !['feature', 'perf'].includes(kindSel.value)) kindSel.value = 'feature';
  }
  choose(intent);
  if (!s.prd_gate_enabled) {
    for (const k of ['fix', 'feature']) {
      cards.get(k).disabled = true;
      cards.get(k).title = 'PRD 精靈未啟用（prd_gate_enabled）';
    }
    if (intent === 'fix' || intent === 'feature') choose('todo');
  }

  go.onclick = async () => {
    go.disabled = true;
    const body = { intent, title: title.value.trim() };
    if (intent === 'fix' || intent === 'feature') {
      Object.assign(body, {
        intent: kindSel.value === 'perf' ? 'perf' : intent,
        kind: kindSel.value,
        repo_path: repoSel.value,
        symptom: symptom.value.trim(),
        expected: expected.value.trim(),
        sources: (s.sources || []).slice(0, 5),
      });
    } else if (intent === 'spike') {
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

function applyTaskResult(view, r) {
  const btn = view.taskBtn;
  if (r.kind === 'draft') {
    view.draftId = r.draft.id;
    if (btn) linkDraft(btn, r.draft.id);
    if (!r.existing) window.open(r.url, '_blank', 'noopener');
    toast(r.existing ? '這則回答已經有一份 PRD 草稿' : '已開 PRD 草稿，精靈在新分頁', 'ok', { text: '開精靈 ↗', href: r.url });
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

  async function build() {
    const id = ctx.conversation();
    list.replaceChildren();
    if (!id) return list.append(el('p', 'menu-note', '先問一個問題，這個對話才會存起來。'));

    list.append(
      item('匯出 Markdown', () => {
        // a plain link download: the server sets the filename, including Chinese titles
        const a = el('a');
        a.href = `/api/chat/conversations/${id}/export?format=md`;
        a.download = '';
        a.click();
      }),
      item('匯出 HTML（目前畫面）', () => exportHtml()),
    );

    let shared = null;
    try {
      shared = await api(`/api/chat/conversations/${id}`);
    } catch (e) {
      /* the menu still offers export */
    }
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
    if (!list.hidden && !list.contains(e.target) && e.target !== btn) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
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
      actionBtn('存進知識庫', '把這個回答存成知識庫筆記，之後對話查得到', (b) => capture(view, b)),
      actionBtn('轉成任務', '先判斷這則回答該變成哪種工作（軟體修正／功能／驗證新技術／待辦），確認後再開', (b) => toTask(view, b)),
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
