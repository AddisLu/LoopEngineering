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
