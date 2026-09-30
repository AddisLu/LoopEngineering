// 需要你處理: what needs a person, in the order it needs them, and what happens next — painted from
// one board snapshot. 總覽 (board-flow.js) and the chat's right panel (dock.js) both use it, so a
// task reads the same wherever you meet it. textContent-only (frame.js h()).
import { fill, h, icon, modelName } from './frame.js';

export const needsYou = (c) => c.status === 'attention' || (c.status === 'draft' && c.gate && !c.gate.ok) || (c.status === 'review' && c.merge_status === 'conflict');
export const awaiting = (c) => c.status === 'review' && c.merge_status !== 'conflict';
export const manualMode = (c) => String(c.verify_mode || '').split(',').map((m) => m.trim()).includes('manual');

/** why a task stopped, in a few words */
export function why(c) {
  const d = String(c.fail_detail || '').split('\n')[0];
  if (!d) return '';
  let m = /^verify failed \(resumable (\d+)\/(\d+)\) at: (.*)$/.exec(d);
  if (m) return `沒過${m[3] === '驗收指標' ? '驗收門檻' : `「${m[3]}」`}，自動續跑 ${m[1]}/${m[2]}`;
  m = /^verify failed at: (.*)$/.exec(d);
  if (m) return `驗證沒過：${m[1] === '驗收指標' ? '驗收門檻未達' : m[1]}`;
  if (/^watchdog timeout/.test(d)) return '執行逾時';
  if (/^setup_cmd failed/.test(d)) return '準備環境失敗';
  if (/aborted/.test(d)) return '被中止';
  m = /^interrupted: (\w+)/.exec(d);
  if (m) return m[1] === 'breaker' ? '額度保護暫停，會自動續跑' : m[1] === 'window' ? '時段外暫停，會自動續跑' : '暫停，會自動續跑';
  if (/^resume limit/.test(d)) return '續跑次數用完';
  if (/held by user/.test(d)) return '你把它轉成待確認';
  return d.slice(0, 60);
}

/**
 * Paint the inbox into `box` from a board snapshot, in the same two groups — and so the same two
 * numbers — as 總覽's tiles: 需要你處理 (a task that failed, a merge conflict, a draft missing
 * something) and 待核可 (waiting for your 核可 or 結案). One heading over both used to count them
 * together, so the panel said 3 where the tile said 1. Returns { need, wait }.
 *   o.title(c)  the name a card carries (總覽 names 評比 / 快篩 arms by their model)
 *   o.open(c)   open the task (總覽: its detail dialog; the default: 總覽, deep-linked)
 *   o.act(path) run a one-click action (續跑, 結案)
 *   o.focus(c)  optional extra link on a card (總覽: 在畫布上看)
 */
export function paintInbox(box, snap, o = {}) {
  const nodeTitle = o.title || ((c) => String(c.title).replace(/^\[bench\]\s*/, ''));
  const open = o.open || ((c) => (location.href = `/board.html#task=${encodeURIComponent(c.id)}`));
  const act = o.act || (() => {});
  const focusBtn = (c) => (o.focus ? o.focus(c) : null);
  const items = [];
  for (const c of snap.cards) {
    if (c.status === 'attention') {
      items.push({ order: 0, wait: false, el: h('article.need', { onclick: () => open(c) }, h('div.kind', null, icon('bang', { sw: 2.4 }), '需要處理'), h('div.ttl', null, nodeTitle(c)), h('div.why', null, why(c) || '執行出了問題，worktree 還在，等你決定'), h('div.acts', null, h('button.btn.primary.sm', { type: 'button', onclick: (e) => { e.stopPropagation(); act(`/api/tasks/${c.id}/resume`); } }, '續跑'), h('button.btn.sm', { type: 'button', onclick: (e) => { e.stopPropagation(); open(c); } }, '看原因'), focusBtn(c))) });
    } else if (c.status === 'review' && c.merge_status === 'conflict') {
      items.push({ order: 1, wait: false, el: h('article.need.bad', { onclick: () => open(c) }, h('div.kind', null, icon('merge'), '合併衝突'), h('div.ttl', null, nodeTitle(c)), h('div.why', null, '已建一張解衝突任務；它結案後再合併'), h('div.acts', null, h('a.btn.primary.sm', { href: `/task.html?id=${encodeURIComponent(c.id)}`, onclick: (e) => e.stopPropagation() }, '去驗收'), focusBtn(c))) });
    } else if (c.status === 'draft' && c.gate && !c.gate.ok) {
      items.push({ order: 2, wait: false, el: h('article.need', { onclick: () => open(c) }, h('div.kind', null, icon('doc'), '草稿缺資料'), h('div.ttl', null, nodeTitle(c)), h('div.why', null, `缺：${(c.gate.missing || []).map((m) => String(m).split(/[ (]/)[0]).join('、')}`), h('div.acts', null, h('a.btn.primary.sm', { href: `/flow.html#new?title=${encodeURIComponent(c.title || '')}&expected=${encodeURIComponent(c.goal || '')}`, onclick: (e) => e.stopPropagation() }, '用工作流程補齊'), focusBtn(c))) });
    } else if (awaiting(c)) {
      const merged = c.merge_status === 'merged';
      const manual = c.merge_status === 'pending' && manualMode(c);
      items.push({
        order: 3,
        wait: true,
        el: h(
          'article',
          { onclick: () => (location.href = `/task.html?id=${encodeURIComponent(c.id)}`) },
          h('div.kind', null, icon(merged ? 'check' : 'eye'), merged ? '已合併，待結案' : manual ? '待人工核可' : '待核可'),
          h('div.ttl', null, nodeTitle(c)),
          h('div.why', null, merged ? '結案後會釋放依賴它的下一步，並整理知識' : manual ? '驗證過了，照清單看過一遍再核可（核可就會合併）' : '驗證過了，看一眼結果再合併'),
          h('div.acts', null, merged ? h('button.btn.primary.sm', { type: 'button', onclick: (e) => { e.stopPropagation(); act(`/api/tasks/${c.id}/close`); } }, '結案') : h('a.btn.primary.sm', { href: `/task.html?id=${encodeURIComponent(c.id)}`, onclick: (e) => e.stopPropagation() }, '去驗收'), focusBtn(c)),
        ),
      });
    }
  }
  items.sort((a, b) => a.order - b.order);
  const next = h('div.next', null, h('b', null, '接下來'));
  const nextLine = (st, text) => next.appendChild(h('div', null, h('span.dot', { dataset: { st } }), h('span', null, text)));
  if (snap.paused) nextLine('blocked', '排程已暫停：不會開始新的任務');
  else if (snap.reason) nextLine('queued', schedWhy(snap.reason, snap));
  for (const c of snap.cards.filter((x) => x.status === 'blocked').slice(0, 3)) nextLine('blocked', `${nodeTitle(c)}：${why(c) || '等續跑'}`);
  const q = snap.cards.filter((x) => x.status === 'queued');
  if (q.length) nextLine('queued', `排隊中 ${q.length} 個：${q.slice(0, 2).map(nodeTitle).join('、')}${q.length > 2 ? '…' : ''}`);
  if (snap.local && (snap.local.enabled || snap.local.inflight)) nextLine(snap.local.status === 'error' ? 'failed' : 'running', `本地模型：${snap.local.loaded ? modelName(snap.local.loaded) : '未載入'}${snap.local.inflight ? ` · 執行中 ${snap.local.inflight}` : ''}`);
  if (snap.benchmark && snap.benchmark.mode === 'screen') nextLine('running', `模型快篩「${String(snap.benchmark.title).replace(/^快篩：/, '')}」進行中：一題一題跑，不評分`);
  else if (snap.benchmark) nextLine('running', `評比「${snap.benchmark.title}」：${snap.benchmark.arms_done}/${snap.benchmark.arm_count} 組完成，全部完成後一組一組量測再評分`);
  if (next.children.length === 1) next.appendChild(h('div', null, h('span.sub', null, '沒有排隊或等續跑的任務。')));
  const need = items.filter((i) => !i.wait);
  const wait = items.filter((i) => i.wait);
  fill(box,
    h('h2', null, '需要你處理', h('span.count', null, String(need.length))),
    ...(need.length ? need.map((i) => i.el) : [h('p.empty-s', null, '目前沒有要你處理的事。')]),
    wait.length ? h('h2.wait', null, '待核可', h('span.count', null, String(wait.length))) : null,
    ...wait.map((i) => i.el),
    next,
  );
  return { need: need.length, wait: wait.length };
}

/** the scheduler's last reason ("session 82% >= 65%", …) in words */
export function schedWhy(r, snap) {
  let m = /session (\d+)% >= (\d+)%/.exec(r);
  if (m) return `5 小時用量 ${m[1]}% 已到門檻 ${m[2]}%，等額度回補再派工`;
  m = /weekly (\d+)% >= (\d+)%/.exec(r);
  if (m) return `本週用量 ${m[1]}% 已到門檻 ${m[2]}%，等額度回補再派工`;
  if (/idle|no queued|nothing/i.test(r)) return '沒有排隊的任務';
  if (/no fitting candidate/i.test(r)) {
    return snap && snap.cards.some((c) => c.status === 'queued') ? '排隊的任務目前放不進額度或時段，等回補' : '沒有排隊的任務';
  }
  if (/concurrency|max_concurrency/i.test(r)) return '同時執行數已滿，等手上的做完';
  return `排程：${r}`;
}
