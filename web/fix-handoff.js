/**
 * Hand a problem from the chat to a new 問題單: the text, the screenshots and a repo hint ride in
 * sessionStorage (window.open copies it into the new tab; nothing goes in the URL), and fix.js
 * picks them up once. When the screenshots do not fit, the text still goes.
 */
export const HANDOFF_KEY = 'loop_fix_handoff';

export function openTicket({ description, images = [], repoHint = '', kind = null }) {
  const pack = (imgs) => JSON.stringify({ description: String(description || ''), images: imgs, repo_hint: repoHint || '', kind, at: Date.now() });
  let dropped = false;
  try {
    sessionStorage.setItem(HANDOFF_KEY, pack(images.slice(0, 6).map((i) => ({ url: i.url, name: i.name || '截圖' }))));
  } catch (e) {
    try {
      sessionStorage.setItem(HANDOFF_KEY, pack([]));
      dropped = images.length > 0;
    } catch (e2) {
      /* storage blocked: the page opens blank */
    }
  }
  // not noopener: the new tab needs this tab's sessionStorage copy (same origin)
  window.open('/fix.html?handoff=1', '_blank');
  return { dropped };
}

/** fix.js: the hand-off, once (it is removed as it is read); stale ones (> 10 min) are ignored. */
export function takeHandoff() {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    sessionStorage.removeItem(HANDOFF_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.description === 'string' && Date.now() - (Number(v.at) || 0) < 600_000 ? v : null;
  } catch (e) {
    return null;
  }
}

/** 機況分析 from the chat: the pasted log / incident text goes to the 知識 page's 機況診斷 tab (once). */
export const DIAG_KEY = 'loop_diag_handoff';
export function openDiag(text) {
  try {
    sessionStorage.setItem(DIAG_KEY, JSON.stringify({ text: String(text || ''), at: Date.now() }));
  } catch (e) {
    /* too big or blocked: the tab opens empty */
  }
  window.open('/brain.html#diag', '_blank');
}
export function takeDiagHandoff() {
  try {
    const raw = sessionStorage.getItem(DIAG_KEY);
    sessionStorage.removeItem(DIAG_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.text === 'string' && Date.now() - (Number(v.at) || 0) < 600_000 ? v.text : null;
  } catch (e) {
    return null;
  }
}
