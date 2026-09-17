import { $, api, boardState, drawer, el, fmtInt, onBoard, phone, rail, setText, store, stored, toast, when } from './shell.js';
import { parseTuneMarkdown } from './chat-md.js';

/**
 * Right-hand dock: the light-touch view of everything that is not the conversation.
 *
 * Deliberately shallow. Anything that needs a real form or a decision links out to its own page
 * (/board.html, /brain.html, /prd.html, /benchmarks.html) rather than re-implementing it here —
 * the board's task detail alone is 140 lines of nine actions, and two copies would drift.
 * textContent only; task titles and PRD output are untrusted text.
 */

// This module owns the whole dock: which panel is selected AND whether the panel is open.
// Splitting those two across files is what produced "the ▤ button does nothing" earlier.
const TABS = [
  ['tasks', '任務'],
  ['tune', '調參'],
  ['kb', '知識庫'],
  ['prd', 'PRD'],
  ['model', '模型'],
  ['bench', 'Benchmark'],
];
const LABEL = Object.fromEntries(TABS);
const actId = (tab) => `act-${tab}`;
const paneId = (tab) => `pane-${tab}`;

const shellMain = $('shell-main');
const dockInner = document.querySelector('.dock-inner');
// tolerate the ids this used to store ('tab-model')
// first visit lands on 任務 (what needs you today); afterwards the last-used panel is remembered
let active = (stored('loop_shell_tab') || 'tasks').replace(/^tab-/, '');
if (!TABS.some(([tab]) => tab === active)) active = 'tasks';
let dockRail = null; // built in the init block at the end — rail() paints as it constructs

const isOpen = () => (phone() ? drawer.isOpen() && drawer.showing() === dockInner : Boolean(dockRail) && dockRail.open);

function setOpen(next) {
  if (phone()) {
    if (next) drawer.show(dockInner, LABEL[active]);
    else drawer.close();
    paintTabs();
    return;
  }
  dockRail.set(next); // rail() has no onChange: it must not call back into this file
  paintTabs();
}

function paintTabs() {
  for (const [tab] of TABS) {
    const on = tab === active;
    $(actId(tab)).setAttribute('aria-selected', String(on));
    $(paneId(tab)).hidden = !on;
  }
  const open = isOpen();
  $('activity-bar').dataset.open = String(open);
  $('dock-toggle').setAttribute('aria-expanded', String(open));
  // the task list and the suggestion table want more room than a stats column does
  shellMain.classList.toggle('dock-wide', active === 'tasks' || active === 'tune');
  if (open && active === 'bench') loadBenchmarks();
  if (open && active === 'tasks' && boardState()) paintTasks(boardState());
  if (open && active === 'tune') loadTuneHistory();
  if (open && active === 'prd') loadPrdDrafts();
  document.dispatchEvent(new CustomEvent('loop-tab', { detail: { tab: active, open } }));
}

/** Clicking the icon that is already showing collapses the panel; anything else switches to it. */
function select(tab) {
  if (tab === active && isOpen()) return setOpen(false);
  active = tab;
  store('loop_shell_tab', tab);
  if (!isOpen()) return setOpen(true);
  if (phone()) drawer.show(dockInner, LABEL[tab]);
  paintTabs();
}

for (const [tab] of TABS) $(actId(tab)).onclick = () => select(tab);
$('dock-toggle').onclick = () => setOpen(!isOpen());
document.addEventListener('keydown', (e) => {
  // e.code, not e.key: Alt+digit types a symbol on macOS
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const m = /^Digit([1-6])$/.exec(e.code);
  if (!m) return;
  e.preventDefault();
  select(TABS[Number(m[1]) - 1][0]);
});

// ---- 任務 ------------------------------------------------------------------
// Fed by the single board SSE connection in shell.js — the same snapshot /board.html renders.
const GROUPS = [
  ['attention', '要你處理'],
  ['review', '待結案'],
  ['running', '執行中'],
  ['verifying', '驗證中'],
  ['queued', '排隊中'],
  ['blocked', '卡住'],
  ['ready', '就緒'],
  ['draft', '草稿'],
];

function countsStrip(counts) {
  const box = el('div', 'counts');
  for (const [status, label] of GROUPS) {
    const n = counts[status] || 0;
    if (!n) continue;
    const c = el('span', `count s-${status}`);
    c.append(el('b', null, String(n)), el('span', null, label));
    box.append(c);
  }
  if (!box.childElementCount) box.append(el('span', 'hint', '目前沒有進行中的任務'));
  return box;
}

function taskCard(card) {
  const a = el('a', `mini-card s-${card.status}`);
  a.href = `/board.html#task=${encodeURIComponent(card.id)}`;
  a.title = card.goal || card.title;
  a.append(el('div', 't', card.title));
  const meta = el('div', 'm');
  const bits = [
    card.complexity,
    card.model || null,
    card.est_pct ? `~${card.est_pct}%` : null,
    card.merge_status === 'merged' ? '已合併' : card.merge_status === 'pending' ? '待合併' : null,
    card.updated_at ? when(card.updated_at) : null,
  ].filter(Boolean);
  for (const b of bits) meta.append(el('span', 'chip', b));
  a.append(meta);
  return a;
}

function paintTasks(s) {
  $('task-counts').replaceChildren(countsStrip(s.counts || {}));
  const note = [];
  if (s.paused) note.push('排程已暫停');
  if (s.self_update_pending) note.push('引擎更新排隊中');
  if (s.usage) note.push(`session ${Math.round(s.usage.session)}% · weekly ${Math.round(s.usage.weekly)}%`);
  $('sched-note').textContent = note.join(' · ') || '排程執行中';

  const cards = Array.isArray(s.cards) ? s.cards : [];
  const list = $('task-list');
  const out = [];
  for (const [status, label] of GROUPS) {
    const group = cards.filter((c) => c.status === status);
    if (!group.length) continue;
    out.push(el('h3', null, `${label}（${group.length}）`));
    for (const c of group) out.push(taskCard(c));
  }
  if (!out.length) out.push(el('p', 'hint', '看板上沒有待辦的任務。可以從對話裡的建議直接開一張。'));
  list.replaceChildren(...out);
}

function paintTopbarUsage(s) {
  const u = s.usage || {};
  const set = (id, label, value) => {
    const node = $(id);
    if (!node) return;
    node.textContent = `${label} ${value == null ? '–' : `${Math.round(value)}%`}`;
    node.dataset.state = value == null ? 'ok' : value >= 90 ? 'danger' : value >= 70 ? 'warn' : 'ok';
  };
  set('usage-session', 'session', u.session);
  set('usage-weekly', 'weekly', u.weekly);
}

onBoard((s) => {
  paintTopbarUsage(s);
  const needsYou = (s.counts || {}).attention || 0;
  setText('act-tasks-badge', needsYou ? String(needsYou) : '');
  $('act-tasks-badge').hidden = !needsYou;
  if (!$('pane-tasks').hidden) paintTasks(s);
});

// ---- 模型切換 ---------------------------------------------------------------
// One model fits the GPU at a time, and a switch restarts vLLM (minutes, chat unavailable), so
// this is deliberately a confirm + a visible state — never a one-click surprise during a demo.
const GiB = 1024 ** 3;
const size = (b) => (b == null ? '—' : `${(b / GiB).toFixed(b >= 100 * GiB ? 0 : 1)} GB`);
let switching = false;

function modelRow(m, loaded) {
  const row = el('div', `model-row${m.id === loaded ? ' on' : ''}${m.runnable ? '' : ' off'}`);
  const txt = el('div', 'txt');
  txt.append(el('div', 'n', m.display_name));
  // blocked_by already names the node requirement when that is the blocker — don't say it twice
  const bits = [size(m.disk_bytes), m.blocked_by ?? (m.nodes > 1 ? `${m.nodes} 台 Spark` : null)].filter(Boolean);
  txt.append(el('div', 's', bits.join(' · ')));
  if (m.notes) txt.title = m.notes;
  row.append(txt);

  if (m.id === loaded) {
    row.append(el('span', 'badge-now', '使用中'));
  } else if (m.runnable) {
    const b = el('button', 'mini', '切換');
    b.type = 'button';
    b.onclick = () => switchModel(m);
    row.append(b);
  }
  return row;
}

function paintModels(data) {
  const loaded = data.state.loaded;
  setText('spark-count', `· 這台部署有 ${data.sparks} 台 Spark`);

  const ready = data.models.filter((m) => m.runnable);
  const needMore = data.models.filter((m) => !m.runnable && m.nodes > data.sparks);
  const other = data.models.filter((m) => !m.runnable && m.nodes <= data.sparks);

  const out = [];
  const group = (label, list) => {
    if (!list.length) return;
    out.push(el('p', 'model-group', label));
    for (const m of list) out.push(modelRow(m, loaded));
  };
  group(`可直接切換（${data.sparks} 台 Spark 跑得動、已下載）`, ready);
  group('需要更多 Spark', needMore);
  group('尚未下載或未啟用', other);
  $('model-list').replaceChildren(...out);

  const st = data.state;
  const note = $('switch-state');
  note.classList.toggle('busy', st.status !== 'ready' && st.status !== 'idle');
  note.classList.toggle('bad', st.status === 'error');
  note.textContent =
    st.status === 'ready'
      ? `目前：${(data.models.find((m) => m.id === loaded) || {}).display_name || loaded}`
      : st.status === 'error'
        ? `載入失敗：${st.error || '未知原因'}`
        : st.status === 'idle'
          ? '目前沒有載入任何模型'
          : `${st.status}：正在準備 ${st.wanted || ''}…`;
}

async function loadModels() {
  try {
    paintModels(await api('/api/local/models'));
  } catch (err) {
    setText('switch-state', `讀不到模型清單：${err.message}`);
  }
}

async function switchModel(m) {
  if (switching) return;
  if (document.getElementById('stop-btn').disabled === false) {
    return toast('還有回答正在產生，先按停止再切換模型', 'warn');
  }
  const ok = window.confirm(
    [
      `切換到「${m.display_name}」？`,
      '',
      'vLLM 會重新啟動，期間無法對話，通常要幾分鐘（大模型更久）。',
      '目前的對話紀錄不會受影響。',
    ].join('\n'),
  );
  if (!ok) return;

  switching = true;
  try {
    await api(`/api/local/models/${encodeURIComponent(m.id)}/load`, { method: 'POST', body: '{}' });
    toast(`正在切換到 ${m.display_name}，載入完成前無法對話`, 'ok');
    // poll until vLLM answers again (or gives up) — the status line shows progress meanwhile
    const started = Date.now();
    const timer = setInterval(async () => {
      let data;
      try {
        data = await api('/api/local/models');
      } catch (e) {
        return;
      }
      paintModels(data);
      const mins = Math.round((Date.now() - started) / 60000);
      if (data.state.status === 'ready' && data.state.loaded === m.id) {
        clearInterval(timer);
        switching = false;
        toast(`${m.display_name} 已就緒（花了約 ${mins} 分鐘）`, 'ok');
      } else if (data.state.status === 'error') {
        clearInterval(timer);
        switching = false;
        toast(`切換失敗：${data.state.error || '看 server log'}`, 'bad');
      } else if (Date.now() - started > 20 * 60000) {
        clearInterval(timer);
        switching = false;
        toast('切換超過 20 分鐘還沒完成，請看 server log', 'warn');
      }
    }, 5000);
  } catch (err) {
    switching = false;
    toast(`切不過去：${err.message}`, 'bad');
    loadModels();
  }
}

// the 模型 panel re-reads on every visit; while a switch is running the poller keeps it fresh
document.addEventListener('loop-tab', (e) => {
  if (e.detail && e.detail.open && e.detail.tab === 'model' && !switching) loadModels();
});

// ---- 知識庫 ----------------------------------------------------------------
$('rag-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('rag-q').value.trim();
  const box = $('rag-results');
  if (!q) return box.replaceChildren();
  box.replaceChildren(el('p', 'hint', '搜尋中…'));
  try {
    const data = await api(`/api/rag/search?q=${encodeURIComponent(q)}&topK=5`);
    const hits = data.results || [];
    if (!hits.length) return box.replaceChildren(el('p', 'hint', '沒有找到相關片段'));
    box.replaceChildren(
      ...hits.map((h) => {
        const d = el('details', 'rag-hit');
        d.append(el('summary', null, `${h.path || h.uri || '片段'}${h.section ? ` · ${h.section}` : ''}`));
        d.append(el('pre', null, (h.text || h.snippet || '').slice(0, 1200)));
        return d;
      }),
    );
  } catch (err) {
    box.replaceChildren(el('p', 'err', err.message));
  }
});

$('capture-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('capture-body').value.trim();
  if (!body) return;
  const btn = $('capture-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/capture', {
      method: 'POST',
      body: JSON.stringify({ title: $('capture-title').value.trim() || undefined, body, tags: ['chat'] }),
    });
    $('capture-title').value = '';
    $('capture-body').value = '';
    toast(`已存進知識庫：${r.filename}`, 'ok');
  } catch (err) {
    toast(`存不進去：${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
});

// ---- PRD -------------------------------------------------------------------
// The wizard lives on /prd.html (it needs the width); this pane is the way in and the way back
// to a half-written draft.
const STEP_LABEL = ['', '改哪套軟體', '要改什麼', '怎麼驗證', '範圍與限制', '預覽與送出'];

function draftRow(d) {
  const a = el('a', 'mini-card');
  a.href = d.status === 'submitted' && d.task_id ? `/board.html#task=${encodeURIComponent(d.task_id)}` : `/prd.html?draft=${encodeURIComponent(d.id)}`;
  a.append(el('div', 't', d.title));
  const m = el('div', 'm');
  m.append(el('span', 'chip', d.status === 'submitted' ? `已建任務 ${d.task_id || ''} ↗` : `第 ${d.step} 步 · ${STEP_LABEL[d.step] || ''}`));
  m.append(el('span', 'chip', when(d.updated_at)));
  a.append(m);
  return a;
}

async function loadPrdDrafts() {
  const box = $('prd-drafts');
  try {
    const { drafts } = await api('/api/prd/drafts?limit=5');
    if (!drafts.length) return box.replaceChildren(el('p', 'hint', '還沒有草稿。按「開新的 PRD」開始。'));
    box.replaceChildren(...drafts.map(draftRow));
  } catch (err) {
    box.replaceChildren(el('p', 'hint', err.status === 404 ? 'PRD 閘門未啟用：loop config set prd_gate_enabled true' : err.message));
  }
}
$('prd-refresh').onclick = loadPrdDrafts;

// ---- Benchmark --------------------------------------------------------------
let benchLoaded = false;
async function loadBenchmarks() {
  if (benchLoaded) return;
  benchLoaded = true;
  const box = $('bench-list');
  box.replaceChildren(el('p', 'hint', '載入中…'));
  try {
    const data = await api('/api/benchmarks');
    const items = data.benchmarks || data.items || [];
    if (!items.length) return box.replaceChildren(el('p', 'hint', '還沒有 benchmark。'));
    box.replaceChildren(
      ...items.slice(0, 20).map((b) => {
        const a = el('a', 'bench-row');
        a.href = '/benchmarks.html';
        a.append(el('span', 't', b.title || b.name || b.id));
        const meta = el('span', 'm');
        meta.append(el('span', 'chip', b.status || '—'));
        if (b.winner) meta.append(el('span', 'chip', `勝：${b.winner}`));
        if (b.arms) meta.append(el('span', 'chip', `${fmtInt(b.arms.length || b.arms)} 組`));
        a.append(meta);
        return a;
      }),
    );
  } catch (err) {
    box.replaceChildren(el('p', 'err', err.message));
  }
}

// ---- 智慧調整參數 -------------------------------------------------------------
// The panel drives the ordinary conversation: it asks chat.js to send the question (loop-ask),
// chat.js reports back when the answer is saved (loop-answer). Neither module imports the other.
const RISK_LABEL = { low: '低', medium: '中', high: '高' };
const TASK_LABEL = {
  draft: '草稿',
  ready: '就緒',
  queued: '排隊中',
  blocked: '卡住',
  running: '執行中',
  verifying: '驗證中',
  review: '待結案',
  attention: '要你處理',
  failed: '失敗',
  closed: '已結案',
};
let tuneLatest = null; // { messageId, conversationId, card }
let tuneBusy = false;

const tuneStatus = (text) => setText('tune-status', text);

function paintTuneLatest() {
  const box = $('tune-latest');
  if (!tuneLatest) {
    box.hidden = true;
    return;
  }
  const { card } = tuneLatest;
  const top = card.suggestions[0];
  const body = $('tune-latest-body');
  const out = [];
  if (card.symptom) out.push(el('div', null, card.symptom));
  out.push(el('div', 'kv', `${top.file} · ${top.param}：${top.current == null ? '（未記載）' : top.current} → ${top.proposed}`));
  const meta = el('div', 'm');
  meta.append(el('span', `risk r-${top.risk}`, `風險 ${RISK_LABEL[top.risk] || top.risk}`));
  meta.append(el('span', 'chip', `${card.suggestions.length} 筆建議`));
  out.push(meta);
  body.replaceChildren(...out);
  $('tune-to-task').disabled = !tuneLatest.messageId;
  $('tune-to-task').textContent = tuneLatest.messageId ? '轉成任務' : '未存進歷史，無法轉任務';
  box.hidden = false;
}

$('tune-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const symptom = $('tune-symptom').value.trim();
  if (!symptom) return toast('先描述症狀', 'warn');
  // send() returns silently while an answer is streaming — say so instead of looking broken
  if ($('stop-btn').disabled === false) return toast('還有回答正在產生，先按停止再產生建議', 'warn');
  const scope = $('tune-scope').value.trim();
  tuneBusy = true;
  $('tune-submit').disabled = true;
  tuneStatus('產生中…（回答會出現在對話區）');
  if (phone()) drawer.close(); // let the answer be visible while it streams
  document.dispatchEvent(
    new CustomEvent('loop-ask', { detail: { text: scope ? `${scope}：${symptom}` : symptom, mode: 'tune' } }),
  );
});

document.addEventListener('loop-answer', (e) => {
  const d = e.detail || {};
  if (d.phase === 'start') {
    if (d.mode === 'tune') tuneStatus('產生中…（回答會出現在對話區）');
    return;
  }
  const done = d.phase === 'done';
  tuneBusy = false;
  $('tune-submit').disabled = false;
  if (d.mode !== 'tune') return;
  if (!done) return tuneStatus(d.phase === 'abort' ? '已停止' : '產生失敗，看對話區的訊息');
  const card = parseTuneMarkdown(d.content || '');
  if (!card) {
    tuneLatest = null;
    paintTuneLatest();
    tuneStatus('模型沒有照格式輸出建議表，回答仍在對話區');
    loadTuneHistory(); // the server parses independently — it may still have caught it
    return;
  }
  tuneLatest = { messageId: d.messageId || null, conversationId: d.conversationId || null, card };
  paintTuneLatest();
  tuneStatus(`完成：${card.suggestions.length} 筆建議`);
  $('tune-symptom').value = '';
  loadTuneHistory();
});

$('tune-to-task').onclick = async () => {
  if (!tuneLatest || !tuneLatest.messageId) return;
  const btn = $('tune-to-task');
  btn.disabled = true;
  try {
    const r = await api(`/api/chat/messages/${tuneLatest.messageId}/task`, { method: 'POST', body: '{}' });
    btn.textContent = `已建任務 ${r.task.id} ↗`;
    toast(r.existing ? `這則建議已經開過任務 ${r.task.id}` : `已建立草稿任務 ${r.task.id}（還沒排程）`, 'ok', {
      text: '在看板打開 ↗',
      href: `/board.html#task=${r.task.id}`,
    });
    loadTuneHistory();
  } catch (err) {
    btn.disabled = false;
    toast(`建立任務失敗：${err.message}`, 'bad');
  }
};

const openInChat = (conversationId, messageId) =>
  document.dispatchEvent(new CustomEvent('loop-open', { detail: { conversationId, messageId } }));

$('tune-show').onclick = () => tuneLatest && openInChat(tuneLatest.conversationId, tuneLatest.messageId);

function tuneRow(item) {
  const row = el('button', 'tune-row');
  row.type = 'button';
  row.append(el('div', 't', item.symptom || `${item.top.file} · ${item.top.param}`));
  const meta = el('div', 'm');
  meta.append(el('span', 'chip', when(item.created_at)));
  meta.append(el('span', 'chip', `${item.suggestions_count} 筆`));
  meta.append(el('span', `risk r-${item.top.risk}`, `風險 ${RISK_LABEL[item.top.risk] || item.top.risk}`));
  if (item.conversation_title) meta.append(el('span', 'chip', item.conversation_title));
  row.append(meta);
  row.append(
    item.task
      ? el('div', 'task', `任務 ${item.task.id} · ${TASK_LABEL[item.task.status] || item.task.status}`)
      : el('div', 'task none', '尚未轉成任務'),
  );
  row.title = `${item.top.file} · ${item.top.param}：${item.top.current == null ? '（未記載）' : item.top.current} → ${item.top.proposed}`;
  row.onclick = () => openInChat(item.conversation_id, item.message_id);
  return row;
}

async function loadTuneHistory() {
  const box = $('tune-history');
  try {
    const { items } = await api('/api/chat/tune/history');
    if (!items.length) {
      return box.replaceChildren(
        el('p', 'hint', '還沒有任何調參建議。在上面描述症狀，或在對話輸入框打開「調參建議」晶片。'),
      );
    }
    box.replaceChildren(...items.map(tuneRow));
  } catch (err) {
    box.replaceChildren(el('p', 'err', err.message));
  }
}

$('tune-refresh').onclick = loadTuneHistory;

// ---- init -------------------------------------------------------------------
// Last on purpose. paintTabs() may call loadBenchmarks()/paintTasks(), and both read state
// declared above; running it any earlier is a temporal-dead-zone crash that silently kills
// every handler below the crash (the tabs still switch, nothing behind them works).
dockRail = rail({
  main: shellMain,
  key: 'loop_shell_dock',
  cls: 'dock-collapsed',
  toggle: $('dock-toggle'),
  defaultOpen: window.innerWidth >= 1280,
});
paintTabs();
loadModels();
