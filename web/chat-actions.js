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

/** 轉成任務: one draft task per answer, whatever the button is pressed (source_ref idempotency). */
async function toTask(view, btn) {
  if (!view.messageId) return toast('這則回答還沒存進歷史，稍等一下再試', 'warn');
  btn.disabled = true;
  try {
    const r = await api(`/api/chat/messages/${view.messageId}/task`, { method: 'POST', body: '{}' });
    view.taskId = r.task.id;
    linkTask(btn, r.task.id);
    toast(
      r.existing ? `這則回答已經開過任務 ${r.task.id}` : `已建立草稿任務 ${r.task.id}（還沒排程）`,
      'ok',
      { text: '在看板打開 ↗', href: `/board.html#task=${r.task.id}` },
    );
  } catch (err) {
    btn.disabled = false;
    toast(`建立任務失敗：${err.message}`, 'bad');
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
    '.meta{font-size:12px;opacity:.6}.refs{font-size:13px}',
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
      actionBtn('轉成任務', '開一張 Loop 草稿任務（調參建議會帶上整張建議表）', (b) => toTask(view, b)),
      actionBtn('請雲端複核', '把這個回答送給雲端高階模型複核（會花訂閱額度，預設關閉）', (b) => escalate(view, b, ctx)),
    );
    if (view.capturedPath) markDone(bar.children[2], '已存 KB');
    if (view.taskId) linkTask(bar.children[3], view.taskId);
  }

  view.wrap.append(bar);
  view.actions = bar;
  return bar;
}
