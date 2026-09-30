// 總覽: the board as a flow canvas (n8n-style: every task a node, grouped by the workflow it
// belongs to — a benchmark, a pipeline, an epic, a depends_on chain — with its status on the node),
// a list view, the KPI strip, the "需要你處理" inbox and the change log. app.js still owns the live
// stream, the dialogs and the classic columns (看板); it hands every snapshot over as a
// 'board:snapshot' event and its actions as window.Board. textContent-only.
import { $, fill, h, icon, dur, hhmm, tsMs, modelName, isLocal, popMenu } from './frame.js';
import { createCanvas } from './flow/canvas.js';
import { layered, grid, stackGroups } from './flow/layout.js';

const Board = () => window.Board;

const store = (k, v) => window.Ops.store(k, v);
const stored = (k) => window.Ops.stored(k);

// ---- how a task reads ----------------------------------------------------------------------------
const RUNNING = new Set(['running', 'verifying']);
const WAITING = new Set(['queued', 'blocked', 'ready']);
const needsYou = (c) => c.status === 'attention' || (c.status === 'draft' && c.gate && !c.gate.ok) || (c.status === 'review' && c.merge_status === 'conflict');
const awaiting = (c) => c.status === 'review' && c.merge_status !== 'conflict';
const today = (s) => {
  const t = tsMs(s);
  return Number.isFinite(t) && new Date(t).toDateString() === new Date().toDateString();
};
const recent = (s, hours) => {
  const t = tsMs(s);
  return Number.isFinite(t) && Date.now() - t < hours * 3600_000;
};
const manualMode = (c) => String(c.verify_mode || '').split(',').map((m) => m.trim()).includes('manual');

/** why a task stopped, in a few words */
function why(c) {
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

function subText(c) {
  switch (c.status) {
    case 'draft':
      return c.gate && !c.gate.ok ? `草稿 · 缺 ${(c.gate.missing || []).length} 項` : '草稿 · 可以排入';
    case 'queued':
    case 'ready':
      return c.dep_state === 'waiting' ? '等上一步完成' : `排隊中${c.est_pct ? ` · 預估 ${c.est_pct}%` : ''}`;
    case 'running':
      return `實作中${c.elapsedMin != null ? ` · ${c.elapsedMin} 分` : ''}`;
    case 'verifying':
      return '驗證中';
    case 'blocked':
      return why(c) || '等續跑';
    case 'attention':
      return why(c) || '要你決定下一步';
    case 'review':
      if (c.coding_tool === 'generic') return '待驗收產出';
      if (c.merge_status === 'conflict') return '合併衝突';
      if (c.merge_status === 'pending') return manualMode(c) ? '待人工核可' : '待合併';
      return c.merge_status === 'merged' ? '已合併 · 待結案' : '待結案';
    case 'failed':
      return why(c) || '失敗';
    case 'closed':
      return '已結案';
    default:
      return c.status;
  }
}

function nodeState(c) {
  switch (c.status) {
    case 'running':
      return 'active';
    case 'verifying':
      return 'verifying';
    case 'queued':
    case 'ready':
      return 'queued';
    case 'blocked':
    case 'attention':
      return 'warn';
    case 'review':
      return c.merge_status === 'conflict' ? 'fail' : 'review';
    case 'failed':
      return 'fail';
    case 'closed':
      return 'ok';
    default:
      return c.gate && !c.gate.ok ? 'warn' : 'idle';
  }
}

function badge(c) {
  switch (c.status) {
    case 'running':
      return { kind: 'run' };
    case 'verifying':
      return { kind: 'verify' };
    case 'queued':
    case 'ready':
      return { kind: 'queued' };
    case 'blocked':
      return { kind: 'warn', icon: /^interrupted/.test(c.fail_detail || '') ? 'pause' : 'retry' };
    case 'attention':
      return { kind: 'warn' };
    case 'review':
      return c.merge_status === 'conflict' ? { kind: 'fail' } : { kind: 'review' };
    case 'failed':
      return { kind: 'fail' };
    case 'closed':
      return { kind: 'ok' };
    default:
      return c.gate && !c.gate.ok ? { kind: 'warn' } : null;
  }
}

function iconFor(c) {
  if (c.benchmark_id) return isLocal(c.model) ? 'server' : 'cloud';
  if (c.parent_task_id || /^\[merge\]/.test(c.title)) return 'merge';
  if (c.coding_tool === 'plan') return 'flow';
  if (c.coding_tool === 'deploy') return 'box';
  if (c.coding_tool === 'generic') return 'doc';
  return 'code';
}

/** the name a node carries: a benchmark arm is its model, a pipeline stage its stage */
function nodeTitle(c) {
  if (c.benchmark_id) return modelName(c.model);
  if (c.stage_name) return c.stage_name;
  if (c.parent_task_id) return '解衝突';
  return String(c.title).replace(/^\[bench\]\s*/, '');
}

const STATUS_WORD = { draft: '草稿', ready: '就緒', queued: '排隊中', blocked: '等續跑', running: '執行中', verifying: '驗證中', review: '待核可', attention: '需要處理', failed: '失敗', closed: '已結案' };

// ---- state -------------------------------------------------------------------------------------------
let snap = null;
let view = stored('loop_board_view') || (window.innerWidth <= 820 ? 'list' : 'canvas');
let filter = null; // KPI / list chip: running | waiting | need | review | done
let query = '';
const events = [];
const prevStatus = new Map();

const canvas = createCanvas($('canvas'), {
  onNodeClick: (id) => {
    const n = sceneNodes.get(id);
    if (!n) return;
    if (n.bench) location.href = `/benchmarks.html#b=${encodeURIComponent(n.bench)}`;
    else Board()?.openDetail(id);
  },
  onNodeHover: (id, el) => hover(id, el),
  onBackground: () => canvas.select(null),
});
const sceneNodes = new Map();

function matches(c) {
  if (query) {
    const hay = `${c.title} ${c.model || ''} ${c.repo || ''} ${c.id} ${c.stage_name || ''}`.toLowerCase();
    if (!hay.includes(query)) return false;
  }
  if (!filter) return true;
  if (filter === 'running') return RUNNING.has(c.status);
  if (filter === 'waiting') return WAITING.has(c.status);
  if (filter === 'need') return needsYou(c);
  if (filter === 'review') return awaiting(c);
  if (filter === 'done') return c.status === 'closed';
  return true;
}

// ---- groups: which workflow a task belongs to ----------------------------------------------------------
/**
 * Every card lands in exactly one group: its benchmark, its pipeline, its epic, the depends_on
 * chain it is part of, or 單一任務. A merge-conflict task joins the group of the task it fixes.
 */
function buildGroups(cards, s) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const groupOf = new Map();
  const groups = [];
  const add = (g) => {
    groups.push(g);
    for (const c of g.cards) groupOf.set(c.id, g);
    return g;
  };
  // benchmarks
  const benches = new Map((s.benchmarks || []).map((b) => [b.id, b]));
  const byBench = new Map();
  for (const c of cards) if (c.benchmark_id) (byBench.get(c.benchmark_id) || byBench.set(c.benchmark_id, []).get(c.benchmark_id)).push(c);
  for (const [bid, list] of byBench) add({ kind: 'benchmark', id: `b:${bid}`, bench: benches.get(bid) || { id: bid, title: '評比', status: 'running' }, cards: list });
  // pipelines
  const byPipe = new Map();
  for (const c of cards) if (!groupOf.has(c.id) && c.pipeline_id) (byPipe.get(c.pipeline_id) || byPipe.set(c.pipeline_id, []).get(c.pipeline_id)).push(c);
  for (const [pid, list] of byPipe) {
    const p = (s.pipelines || []).find((x) => x.pipeline_id === pid);
    add({ kind: 'pipeline', id: `p:${pid}`, title: p ? p.name : '流程', cards: list });
  }
  // epics: the epic and its children
  for (const c of cards) {
    if (groupOf.has(c.id) || !c.children) continue;
    const kids = cards.filter((k) => k.parent_id === c.id && !groupOf.has(k.id));
    add({ kind: 'epic', id: `e:${c.id}`, title: c.title, cards: [c, ...kids] });
  }
  // depends_on chains (connected components of two or more)
  const adj = new Map();
  const link = (a, b) => {
    (adj.get(a) || adj.set(a, new Set()).get(a)).add(b);
    (adj.get(b) || adj.set(b, new Set()).get(b)).add(a);
  };
  for (const c of cards) if (!groupOf.has(c.id) && c.depends_on && byId.has(c.depends_on) && !groupOf.has(c.depends_on)) link(c.id, c.depends_on);
  const seen = new Set();
  for (const c of cards) {
    if (groupOf.has(c.id) || seen.has(c.id) || !adj.has(c.id)) continue;
    const comp = [];
    const stack = [c.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      comp.push(byId.get(id));
      for (const n of adj.get(id) || []) stack.push(n);
    }
    const root = comp.find((x) => !x.depends_on || !comp.some((y) => y.id === x.depends_on)) || comp[0];
    add({ kind: 'chain', id: `c:${root.id}`, title: String(root.title).replace(/^\[bench\]\s*/, ''), cards: comp });
  }
  // merge-conflict tasks follow the task they fix
  for (const c of cards) {
    if (groupOf.has(c.id) || !c.parent_task_id) continue;
    const g = groupOf.get(c.parent_task_id);
    if (g) {
      g.cards.push(c);
      groupOf.set(c.id, g);
    }
  }
  const singles = cards.filter((c) => !groupOf.has(c.id));
  // live work first, then what needs a person, then the rest by last change
  const rank = (g) => (g.cards.some((c) => RUNNING.has(c.status)) ? 0 : g.cards.some((c) => needsYou(c) || awaiting(c)) ? 1 : g.cards.some((c) => WAITING.has(c.status)) ? 2 : 3);
  const last = (g) => Math.max(...g.cards.map((c) => tsMs(c.updated_at) || 0));
  groups.sort((a, b) => rank(a) - rank(b) || last(b) - last(a));
  if (singles.length) groups.push({ kind: 'single', id: 'single', title: '單一任務', cards: singles.sort((a, b) => (tsMs(b.updated_at) || 0) - (tsMs(a.updated_at) || 0)) });
  return groups;
}

const NODE_W = 216;
const NODE_H = 60;
const SYN_W = 150;

function taskNode(c) {
  const title = nodeTitle(c);
  const sub = subText(c);
  const ic = iconFor(c);
  return {
    id: c.id,
    w: NODE_W,
    h: NODE_H,
    state: nodeState(c),
    badge: badge(c),
    prog: c.elapsedPct != null && RUNNING.has(c.status) ? { pct: Math.min(100, c.elapsedPct), state: c.elapsedPct >= 90 ? 'danger' : c.elapsedPct >= 70 ? 'warn' : '' } : null,
    dim: !matches(c),
    label: `${title}：${sub}`,
    title: c.title,
    sig: `${ic}|${title}|${sub}`,
    build: () => [h('span.ic', null, icon(ic)), h('span.tx', null, h('span.t', null, title), h('span.s', null, sub))],
    card: c,
  };
}

function synNode(id, bench, title, sub, ic, state, badgeKind) {
  return {
    id,
    w: SYN_W,
    h: NODE_H,
    state,
    bench,
    badge: badgeKind ? { kind: badgeKind } : null,
    cls: id.endsWith(':q') ? 'trigger' : '',
    label: `${title}：${sub}`,
    sig: `${ic}|${title}|${sub}`,
    build: () => [h('span.ic', null, icon(ic)), h('span.tx', null, h('span.t', null, title), h('span.s', null, sub))],
  };
}

function groupScene(g, widthHint) {
  const nodes = [];
  const edges = [];
  if (g.kind === 'benchmark') {
    const b = g.bench;
    const bid = b.id;
    const done = g.cards.filter((c) => ['review', 'attention', 'failed', 'closed'].includes(c.status)).length;
    const judging = b.status === 'judging';
    const judged = b.status === 'judged';
    nodes.push(synNode(`${bid}:q`, bid, '題目', `${g.cards.length} 個模型`, 'doc', 'ok', null));
    for (const c of g.cards) {
      nodes.push(taskNode(c));
      edges.push({ from: `${bid}:q`, to: c.id, cls: '' });
    }
    const allDone = done === g.cards.length;
    nodes.push(synNode(`${bid}:final`, bid, '最終量測', judged ? '已量完' : judging ? '一組一組量測中' : `等 ${g.cards.length - done} 組完成`, 'chip', judged ? 'ok' : judging ? 'active' : 'idle', judged ? 'ok' : judging ? 'run' : null));
    nodes.push(
      synNode(
        `${bid}:judge`,
        bid,
        '評審',
        judged ? (b.winner ? `勝出 ${modelName(b.winner)}` : '沒有組別過關') : b.status === 'judge_failed' ? '評審失敗' : `${modelName((b.judge_models || b.judge_model || 'opus').split(',')[0])} · 等待`,
        'scale',
        judged ? 'ok' : b.status === 'judge_failed' ? 'fail' : 'idle',
        judged ? 'ok' : b.status === 'judge_failed' ? 'fail' : null,
      ),
    );
    for (const c of g.cards) edges.push({ from: c.id, to: `${bid}:final`, cls: allDone || judged ? 'ok' : 'wait' });
    edges.push({ from: `${bid}:final`, to: `${bid}:judge`, cls: judged ? 'ok' : 'wait' });
    // a filter or search dims the benchmark's own steps too, unless one of its arms matches
    const shown = g.cards.some(matches);
    for (const n of nodes) if (!n.card) n.dim = !shown;
    return { nodes, edges, layout: layered(nodes, edges, { gapX: 56, gapY: 16 }) };
  }
  if (g.kind === 'single') {
    for (const c of g.cards) nodes.push(taskNode(c));
    const cols = Math.max(1, Math.floor((widthHint - 80) / (NODE_W + 24)));
    return { nodes, edges, layout: grid(nodes, { cols, gapX: 24, gapY: 20 }) };
  }
  const ids = new Set(g.cards.map((c) => c.id));
  for (const c of g.cards) {
    nodes.push(taskNode(c));
    const from = c.depends_on && ids.has(c.depends_on) ? c.depends_on : c.parent_task_id && ids.has(c.parent_task_id) ? c.parent_task_id : g.kind === 'epic' && c.parent_id && ids.has(c.parent_id) && !(c.depends_on && ids.has(c.depends_on)) ? c.parent_id : null;
    if (from) {
      const src = g.cards.find((x) => x.id === from);
      const merged = src && (src.status === 'closed' || src.merge_status === 'merged');
      edges.push({ from, to: c.id, cls: c.parent_task_id ? 'fail' : merged ? 'ok' : ['draft', 'queued'].includes(c.status) ? 'wait' : '', label: c.parent_task_id ? '衝突' : merged && ['draft', 'queued'].includes(c.status) ? '已合併' : null, labelCls: merged ? 'ok' : null });
    }
  }
  return { nodes, edges, layout: layered(nodes, edges, { gapX: 64, gapY: 18 }) };
}

const GROUP_ICON = { benchmark: 'bench', pipeline: 'flow', epic: 'flow', chain: 'flow', single: 'list' };
const GROUP_WORD = { benchmark: '評比', pipeline: '流程', epic: '拆解', chain: '依序', single: '' };

function groupHead(g) {
  const doneN = g.cards.filter((c) => c.status === 'closed' || (c.status === 'review' && c.merge_status === 'merged')).length;
  const title = g.kind === 'benchmark' ? g.bench.title : g.title;
  const parts = [icon(GROUP_ICON[g.kind]), h('b', null, `${GROUP_WORD[g.kind] ? `${GROUP_WORD[g.kind]} · ` : ''}${title}`)];
  if (g.kind === 'benchmark') {
    parts.push(h('span.chip-s', null, g.bench.domain === 'cuda' ? 'cuda' : g.bench.domain || '評比'));
    parts.push(h('span.meta-s', null, `${g.cards.filter((c) => ['review', 'attention', 'failed', 'closed'].includes(c.status)).length}/${g.cards.length} 組完成`));
    parts.push(h('a', { href: `/benchmarks.html#b=${encodeURIComponent(g.bench.id)}` }, '開啟評比'));
  } else if (g.kind === 'single') {
    parts.push(h('span.meta-s', null, `${g.cards.length} 個 · 依更新時間`));
  } else {
    parts.push(h('span.meta-s', null, `${doneN}/${g.cards.length} 完成`));
  }
  return parts;
}

function paintCanvas() {
  if (!snap) return;
  // closed work stays on the canvas for a day, then only the list shows it
  const cards = snap.cards.filter((c) => c.status !== 'closed' || recent(c.updated_at, 24) || filter === 'done');
  const groups = buildGroups(cards, snap);
  const width = $('canvas').clientWidth || 1000;
  const scenes = groups.map((g) => ({ g, ...groupScene(g, width) }));
  const stacked = stackGroups(
    scenes.map((sc) => ({ id: sc.g.id, layout: sc.layout, minW: Math.min(width - 40, 560) })),
    { pad: 24, head: 44, gap: 16, origin: 16 },
  );
  sceneNodes.clear();
  const nodes = [];
  const edges = [];
  for (const sc of scenes) {
    for (const n of sc.nodes) {
      const p = stacked.pos.get(n.id);
      if (!p) continue;
      const placed = { ...n, x: p.x, y: p.y };
      sceneNodes.set(n.id, placed);
      nodes.push(placed);
    }
    edges.push(...sc.edges);
  }
  const heads = new Map(scenes.map((sc) => [sc.g.id, sc.g]));
  canvas.render({
    groups: stacked.groups.map((gb) => {
      const g = heads.get(gb.id);
      return { ...gb, sig: JSON.stringify([g.kind, g.bench?.status, g.cards.map((c) => c.status)]), head: () => groupHead(g) };
    }),
    nodes,
    edges,
    empty: '總覽上還沒有任務。按右上角「新工作流程」開始。',
  });
}

// ---- hover toolbar ---------------------------------------------------------------------------------------
let hovEl = null;
let hovTimer = null;
function actionsFor(c) {
  const B = Board();
  const confirmAct = (msg, path) => () => {
    if (confirm(msg)) B.act(path);
  };
  const go = (url) => () => (location.href = url);
  const flow = ['看流程', go(`/flow.html?task=${encodeURIComponent(c.id)}`)];
  switch (c.status) {
    case 'draft':
      return c.gate && !c.gate.ok
        ? [['補齊', go(`/flow.html#new?title=${encodeURIComponent(c.title || '')}&expected=${encodeURIComponent(c.goal || '')}`), 'primary'], ['詳情', () => B.openDetail(c.id)]]
        : [['加入排程', () => B.act(`/api/tasks/${c.id}/queue`), 'primary'], ['詳情', () => B.openDetail(c.id)]];
    case 'queued':
    case 'ready':
      return [flow, ['詳情', () => B.openDetail(c.id)]];
    case 'running':
    case 'verifying':
      return [flow, ['中止', confirmAct(`確定中止「${c.title}」？正在跑的會被停掉，任務標成失敗。`, `/api/tasks/${c.id}/abort`), 'danger']];
    case 'blocked':
      return [flow, ['轉待確認', () => B.act(`/api/tasks/${c.id}/hold`)]];
    case 'attention':
      return [
        ['續跑', () => B.act(`/api/tasks/${c.id}/resume`), 'primary'],
        ['重來', confirmAct(`確定重來「${c.title}」？將刪除現有 worktree／branch，從最新 base 重新開始。`, `/api/tasks/${c.id}/restart`)],
        ['放棄', confirmAct(`確定放棄「${c.title}」？任務將標記為 failed。`, `/api/tasks/${c.id}/abandon`), 'danger'],
      ];
    case 'review':
      return [
        ['驗收', go(`/task.html?id=${encodeURIComponent(c.id)}`), 'primary'],
        ...(c.merge_status === 'merged' ? [['結案', () => B.act(`/api/tasks/${c.id}/close`)]] : []),
        flow,
      ];
    case 'failed':
      return [['重來', confirmAct(`確定重來「${c.title}」？將刪除現有 worktree／branch，從最新 base 重新開始。`, `/api/tasks/${c.id}/restart`)], ['結案', () => B.act(`/api/tasks/${c.id}/close`)], flow];
    default:
      return [flow, ['詳情', () => B.openDetail(c.id)]];
  }
}

function hover(id, el) {
  clearTimeout(hovTimer);
  if (!id) {
    hovTimer = setTimeout(() => {
      hovEl?.remove();
      hovEl = null;
    }, 250);
    return;
  }
  const n = sceneNodes.get(id);
  if (!n || !n.card) {
    hovEl?.remove();
    hovEl = null;
    return;
  }
  hovEl?.remove();
  const bar = h('div.hovbar', { role: 'toolbar', 'aria-label': '節點動作' });
  for (const [label, fn, cls] of actionsFor(n.card)) {
    bar.appendChild(h(`button${cls ? `.${cls}` : ''}`, { type: 'button', onclick: (e) => { e.stopPropagation(); fn(); } }, label));
  }
  bar.appendChild(h('button', { type: 'button', 'aria-label': '更多', onclick: (e) => { e.stopPropagation(); Board()?.openDetail(id); } }, icon('more', { fill: true, size: 16 })));
  bar.style.left = `${n.x}px`;
  bar.style.top = `${n.y - 40}px`;
  bar.addEventListener('pointerenter', () => clearTimeout(hovTimer));
  bar.addEventListener('pointerleave', () => hover(null));
  canvas.layer.appendChild(bar);
  hovEl = bar;
  void el;
}

// ---- KPI strip ---------------------------------------------------------------------------------------------
function paintKpis() {
  const cards = snap.cards;
  const count = (fn) => cards.filter(fn).length;
  const tile = (key, label, n, dotSt, extra, cls) =>
    h(
      `button.kpi${cls ? `.${cls}` : ''}`,
      { type: 'button', 'aria-pressed': String(filter === key), onclick: () => setFilter(filter === key ? null : key), title: `只看${label}` },
      h('span.k', null, h('span.dot', { dataset: { st: dotSt } }), label),
      h('span.n', null, String(n), extra ? h('small', null, ` ${extra}`) : null),
    );
  const blocked = count((c) => c.status === 'blocked');
  const need = count(needsYou);
  const u = snap.usage || {};
  const bar = (label, v, max) =>
    h(
      'div.bar-row',
      { dataset: { state: v >= 90 ? 'danger' : v >= Math.max(60, (max || 80) - 10) ? 'warn' : 'ok' } },
      h('span.lbl', null, label),
      h('span.track', null, h('span', { style: { width: `${Math.max(0, Math.min(100, v || 0))}%` } })),
      h('span.v', null, `${Math.round(v || 0)}%`),
    );
  const fc = snap.forecast;
  const usageTile = h(
    'div.kpi.usage-tile',
    { title: fc ? `待處理任務預計再吃本週 ${Math.round(fc.weekly_backlog_pct)}%，跑完後距上限還剩 ${Math.round(fc.weekly_headroom)}%，約可再加 ${fc.capacity_more_M} 個 M 任務${u.error ? `\n用量讀數非即時：${u.error}` : ''}` : '' },
    bar('5 小時', u.session, snap.policy?.sessionMax),
    bar('本週', u.weekly, snap.policy?.weeklyMax),
  );
  fill($('kpis'), 
    tile('running', '執行中', count((c) => RUNNING.has(c.status)), 'running'),
    tile('waiting', '等候中', count((c) => WAITING.has(c.status)), 'queued', blocked ? `等續跑 ${blocked}` : null),
    tile('need', '需要你處理', need, 'attention', null, need ? 'need' : null),
    tile('review', '待核可', count(awaiting), 'review'),
    tile('done', '今日完成', count((c) => c.status === 'closed' && today(c.updated_at)), 'closed'),
    usageTile,
  );
}

function setFilter(f) {
  filter = f;
  paintAll();
}

// ---- inbox ----------------------------------------------------------------------------------------------------
function paintInbox() {
  const box = $('inbox');
  const items = [];
  const B = Board();
  const focusBtn = (c) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); setView('canvas'); requestAnimationFrame(() => canvas.focus(c.id)); } }, '在畫布上看');
  for (const c of snap.cards) {
    if (c.status === 'attention') {
      items.push({ order: 0, el: h('article.need', { onclick: () => B.openDetail(c.id) }, h('div.kind', null, icon('bang', { sw: 2.4 }), '需要處理'), h('div.ttl', null, nodeTitle(c)), h('div.why', null, why(c) || '執行出了問題，worktree 還在，等你決定'), h('div.acts', null, h('button.btn.primary.sm', { type: 'button', onclick: (e) => { e.stopPropagation(); B.act(`/api/tasks/${c.id}/resume`); } }, '續跑'), h('button.btn.sm', { type: 'button', onclick: (e) => { e.stopPropagation(); B.openDetail(c.id); } }, '看原因'), focusBtn(c))) });
    } else if (c.status === 'review' && c.merge_status === 'conflict') {
      items.push({ order: 1, el: h('article.need.bad', { onclick: () => B.openDetail(c.id) }, h('div.kind', null, icon('merge'), '合併衝突'), h('div.ttl', null, nodeTitle(c)), h('div.why', null, '已建一張解衝突任務；它結案後再合併'), h('div.acts', null, h('a.btn.primary.sm', { href: `/task.html?id=${encodeURIComponent(c.id)}`, onclick: (e) => e.stopPropagation() }, '去驗收'), focusBtn(c))) });
    } else if (c.status === 'draft' && c.gate && !c.gate.ok) {
      items.push({ order: 3, el: h('article.need', { onclick: () => B.openDetail(c.id) }, h('div.kind', null, icon('doc'), '草稿缺資料'), h('div.ttl', null, nodeTitle(c)), h('div.why', null, `缺：${(c.gate.missing || []).map((m) => String(m).split(/[ (]/)[0]).join('、')}`), h('div.acts', null, h('a.btn.primary.sm', { href: `/flow.html#new?title=${encodeURIComponent(c.title || '')}&expected=${encodeURIComponent(c.goal || '')}`, onclick: (e) => e.stopPropagation() }, '用工作流程補齊'), focusBtn(c))) });
    } else if (awaiting(c)) {
      const merged = c.merge_status === 'merged';
      const manual = c.merge_status === 'pending' && manualMode(c);
      items.push({
        order: 2,
        el: h(
          'article',
          { onclick: () => (location.href = `/task.html?id=${encodeURIComponent(c.id)}`) },
          h('div.kind', null, icon(merged ? 'check' : 'eye'), merged ? '已合併，待結案' : manual ? '待人工核可' : '待核可'),
          h('div.ttl', null, nodeTitle(c)),
          h('div.why', null, merged ? '結案後會釋放依賴它的下一步，並整理知識' : manual ? '驗證過了，照清單看過一遍再核可（核可就會合併）' : '驗證過了，看一眼結果再合併'),
          h('div.acts', null, merged ? h('button.btn.primary.sm', { type: 'button', onclick: (e) => { e.stopPropagation(); B.act(`/api/tasks/${c.id}/close`); } }, '結案') : h('a.btn.primary.sm', { href: `/task.html?id=${encodeURIComponent(c.id)}`, onclick: (e) => e.stopPropagation() }, '去驗收'), focusBtn(c)),
        ),
      });
    }
  }
  items.sort((a, b) => a.order - b.order);
  const next = h('div.next', null, h('b', null, '接下來'));
  const nextLine = (st, text) => next.appendChild(h('div', null, h('span.dot', { dataset: { st } }), h('span', null, text)));
  if (snap.paused) nextLine('blocked', '排程已暫停：不會開始新的任務');
  else if (snap.reason) nextLine('queued', schedWhy(snap.reason));
  for (const c of snap.cards.filter((x) => x.status === 'blocked').slice(0, 3)) nextLine('blocked', `${nodeTitle(c)}：${why(c) || '等續跑'}`);
  const q = snap.cards.filter((x) => x.status === 'queued');
  if (q.length) nextLine('queued', `排隊中 ${q.length} 個：${q.slice(0, 2).map(nodeTitle).join('、')}${q.length > 2 ? '…' : ''}`);
  if (snap.local && (snap.local.enabled || snap.local.inflight)) nextLine(snap.local.status === 'error' ? 'failed' : 'running', `本地模型：${snap.local.loaded ? modelName(snap.local.loaded) : '未載入'}${snap.local.inflight ? ` · 執行中 ${snap.local.inflight}` : ''}`);
  if (snap.benchmark) nextLine('running', `評比「${snap.benchmark.title}」：${snap.benchmark.arms_done}/${snap.benchmark.arm_count} 組完成，全部完成後一組一組量測再評分`);
  if (next.children.length === 1) next.appendChild(h('div', null, h('span.sub', null, '沒有排隊或等續跑的任務。')));
  fill(box,
    h('h2', null, '需要你處理', h('span.count', null, String(items.length))),
    ...(items.length ? items.map((i) => i.el) : [h('p.empty-s', null, '目前沒有要你處理的事。')]),
    next,
  );
}

/** the scheduler's last reason ("session 82% >= 65%", …) in words */
function schedWhy(r) {
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

// ---- list view ------------------------------------------------------------------------------------------------
const LIST_CHIPS = [
  [null, '全部'],
  ['running', '執行中'],
  ['waiting', '等候中'],
  ['need', '需要你處理'],
  ['review', '待核可'],
  ['done', '已完成'],
];
function groupLabel(c, groups) {
  const g = groups.find((x) => x.cards.includes(c));
  if (!g || g.kind === 'single') return '單一任務';
  return `${GROUP_WORD[g.kind]} · ${g.kind === 'benchmark' ? g.bench.title : g.title}`;
}
function paintList() {
  const groups = buildGroups(snap.cards, snap);
  fill($('list-filters'), 
    ...LIST_CHIPS.map(([key, label]) => {
      const n = key ? snap.cards.filter((c) => (key === 'running' ? RUNNING.has(c.status) : key === 'waiting' ? WAITING.has(c.status) : key === 'need' ? needsYou(c) : key === 'review' ? awaiting(c) : c.status === 'closed')).length : snap.cards.length;
      return h('button.fchip', { type: 'button', 'aria-pressed': String(filter === key), onclick: () => setFilter(key) }, `${label} ${n}`);
    }),
  );
  const order = (c) => (needsYou(c) ? 0 : RUNNING.has(c.status) ? 1 : awaiting(c) ? 2 : WAITING.has(c.status) ? 3 : c.status === 'draft' ? 4 : 5);
  const rows = snap.cards.filter(matches).sort((a, b) => order(a) - order(b) || (tsMs(b.updated_at) || 0) - (tsMs(a.updated_at) || 0));
  const head = h('thead', null, h('tr', null, ['狀態', '任務', '工作流程', '模型', '更新', '耗時', '結果', ''].map((x) => h('th', null, x))));
  const body = h('tbody');
  for (const c of rows.slice(0, 300)) {
    const more = h('button.btn.icon', { type: 'button', 'aria-label': '動作', onclick: (e) => { e.stopPropagation(); popMenu(e.currentTarget, actionsFor(c).map(([label, fn]) => [label, fn])); } }, icon('more', { fill: true, size: 16 }));
    body.appendChild(
      h(
        `tr.row${needsYou(c) ? '.need' : ''}`,
        { onclick: () => Board()?.openDetail(c.id) },
        h('td', null, h('span.stc', null, h('span.dot', { dataset: { st: c.status } }), STATUS_WORD[c.status] || c.status)),
        h('td', null, h('div.ttl', { title: c.title }, c.benchmark_id ? `${modelName(c.model)} · ${String(c.title).replace(/^\[bench\]\s*/, '').replace(/ · [^·]+$/, '')}` : String(c.title).replace(/^\[bench\]\s*/, ''))),
        h('td.sub', null, groupLabel(c, groups)),
        h('td.nowrap', null, c.model ? `${isLocal(c.model) ? '本地 ' : ''}${modelName(c.model)}` : c.coding_tool === 'claude-code' ? '預設模型' : c.coding_tool),
        h('td.num.sub', null, hhmmOrDate(c.updated_at)),
        h('td.num', null, c.elapsedMin != null ? `${c.elapsedMin} 分` : '–'),
        h('td.sub', null, subText(c)),
        h('td', null, more),
      ),
    );
  }
  const table = $('list-table');
  fill(table, head, body);
  if (!rows.length) body.appendChild(h('tr', null, h('td', { colspan: '8' }, h('p.empty-s', null, '沒有符合的任務。'))));
}
const hhmmOrDate = (s) => (today(s) ? hhmm(s) : `${new Date(tsMs(s)).getMonth() + 1}/${new Date(tsMs(s)).getDate()} ${hhmm(s)}`);

// ---- log bar -----------------------------------------------------------------------------------------------------
function trackChanges() {
  const first = prevStatus.size === 0;
  for (const c of snap.cards) {
    const was = prevStatus.get(c.id);
    if (!first && was !== c.status) {
      events.unshift({ ts: new Date(), text: `${nodeTitle(c)}${c.benchmark_id ? '（評比）' : ''}：${was ? `${STATUS_WORD[was] || was} → ` : '新增 · '}${STATUS_WORD[c.status] || c.status}` });
    }
    prevStatus.set(c.id, c.status);
  }
  if (events.length > 100) events.length = 100;
  const last = events[0];
  $('log-ts').textContent = last ? hhmm(last.ts.toISOString()) : '';
  $('log-last').textContent = last ? last.text : '開著這頁時，任務狀態一有變化會記在這裡';
  if (!$('log-list').hidden) paintLog();
}
function paintLog() {
  fill($('log-list'), ...(events.length ? events.map((e) => h('div', null, h('span.ts', null, hhmm(e.ts.toISOString())), h('span', null, e.text))) : [h('p.empty-s', null, '還沒有變化。')]));
}
$('log-toggle').onclick = () => {
  const box = $('log-list');
  box.hidden = !box.hidden;
  $('log-toggle').setAttribute('aria-expanded', String(!box.hidden));
  if (!box.hidden) paintLog();
};

// ---- view switch, search, menu ---------------------------------------------------------------------------------------
function setView(v) {
  view = v;
  store('loop_board_view', v);
  for (const b of $('view-switch').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  $('view-canvas').hidden = v !== 'canvas';
  $('view-list').hidden = v !== 'list';
  $('view-kanban').hidden = v !== 'kanban';
  // the kanban's own columns already sort out what needs you, and its cards need the width
  $('inbox').hidden = v === 'kanban';
  paintAll();
  if (v === 'canvas') requestAnimationFrame(() => canvas.fit(false));
}
for (const b of $('view-switch').querySelectorAll('button')) b.onclick = () => setView(b.dataset.view);
$('search').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  paintAll();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    $('search').focus();
  }
});
$('more-btn').onclick = (e) => {
  e.stopPropagation();
  const m = $('more-menu');
  m.hidden = !m.hidden;
  $('more-btn').setAttribute('aria-expanded', String(!m.hidden));
};
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.more-wrap')) $('more-menu').hidden = true;
});
for (const id of ['settings-btn', 'prune-btn', 'new-btn']) $(id).addEventListener('click', () => ($('more-menu').hidden = true));

function paintAll() {
  if (!snap) return;
  paintKpis();
  paintInbox();
  if (view === 'canvas') paintCanvas();
  else if (view === 'list') paintList();
}

document.addEventListener('board:snapshot', (e) => {
  snap = e.detail;
  trackChanges();
  paintAll();
});
document.addEventListener('frame:theme', () => paintAll());
setView(view);
// app.js may have received the first snapshot before this module ran
{
  const first = window.Board?.snapshot?.();
  if (first) {
    snap = first;
    trackChanges();
    paintAll();
  }
}
