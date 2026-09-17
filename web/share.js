import { $, el, fmtInt, fmtSec, when } from './shell.js';
import { renderMarkdown } from './chat-md.js';

/**
 * Read-only transcript for a shared conversation.
 *
 * The token lives in the URL fragment, so it is never sent to the server as part of a normal
 * navigation and never lands in a proxy log; this page reads it and asks for exactly one
 * conversation. No composer, no actions, no images — text only.
 */

const token = location.hash.slice(1);
const log = $('log');

function fail(text) {
  $('share-title').textContent = '打不開這個連結';
  log.replaceChildren(el('p', 'empty', text));
}

function render(m) {
  const cloud = String(m.model_id || '').startsWith('cloud:');
  const wrap = el('div', `msg ${m.role}${cloud ? ' cloud' : ''}`);
  const who = m.role === 'user' ? '你' : cloud ? `雲端複核 · ${String(m.model_id).replace('cloud:', '')}` : '本地模型';
  wrap.append(el('div', 'who', who));
  const body = el('div', m.role === 'assistant' ? 'body md' : 'body');
  if (m.role === 'assistant') body.replaceChildren(renderMarkdown(m.content, true));
  else body.textContent = m.content;
  wrap.append(body);

  if (m.sources && m.sources.length) {
    const refs = el('details', 'refs');
    refs.append(el('summary', null, `參考資料 ${m.sources.length} 則（CF-AOI 知識庫）`));
    const ol = el('ol');
    for (const s of m.sources) {
      const li = el('li');
      const d = el('details');
      d.append(el('summary', null, `[${s.n}] ${s.source}/${s.path}`), el('pre', null, s.snippet || ''));
      li.append(d);
      ol.append(li);
    }
    refs.append(ol);
    wrap.append(refs);
  }
  const bits = [
    m.ttft_ms != null ? `首字 ${fmtSec(m.ttft_ms)}` : null,
    m.tokens_out != null ? `輸出 ${fmtInt(m.tokens_out)} tokens` : null,
    m.duration_ms != null ? `共 ${fmtSec(m.duration_ms)}` : null,
  ].filter(Boolean);
  if (bits.length) wrap.append(el('div', 'meta', bits.join(' · ')));
  return wrap;
}

if (!token) {
  fail('網址少了分享代碼。請跟分享的人拿完整連結。');
} else {
  try {
    const r = await fetch(`/api/chat/shared/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error('gone');
    const data = await r.json();
    document.title = `${data.conversation.title} · 分享的對話`;
    $('share-title').textContent = data.conversation.title;
    $('share-meta').textContent = `分享於 ${when(data.conversation.shared_at)} · 唯讀`;
    log.replaceChildren(...data.messages.map(render));
  } catch (e) {
    fail('這個連結已經失效或被取消分享了。');
  }
}
