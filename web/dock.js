import { $, api, boardState, drawer, el, onBoard, phone, rail, setText, store, stored, toast, when } from './shell.js';
import { parseTuneMarkdown } from './chat-md.js';
import { awaiting, needsYou, paintInbox } from './inbox.js';

/**
 * Right-hand dock: the light-touch view of everything that is not the conversation.
 *
 * Four tabs: 需要你處理 (the same cards as 總覽, web/inbox.js), 調參, 知識庫, 模型 (with the
 * machine's speed, memory and GPU). Deliberately shallow: anything that needs a real form or a
 * decision links out to its own page (/board.html, /brain.html, /flow.html, /task.html) rather
 * than re-implementing it here — two copies would drift. textContent only; task titles and model
 * output are untrusted text.
 */

// This module owns the whole dock: which panel is selected AND whether the panel is open.
// Splitting those two across files is what produced "the ▤ button does nothing" earlier.
const TABS = [
  ['tasks', '需要你處理'],
  ['tune', '調參'],
  ['kb', '知識庫'],
  ['model', '模型'],
];
const LABEL = Object.fromEntries(TABS);
const actId = (tab) => `act-${tab}`;
const paneId = (tab) => `pane-${tab}`;

const shellMain = $('shell-main');
const dockInner = document.querySelector('.dock-inner');
// tolerate the ids this used to store ('tab-model', and the 機台 / PRD / 評比 panels that are gone)
// first visit lands on 需要你處理 (what needs you today); afterwards the last-used panel is remembered
const MOVED = { status: 'model', prd: 'tasks', bench: 'tasks' };
let active = (stored('loop_shell_tab') || 'tasks').replace(/^tab-/, '');
active = MOVED[active] || active;
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
  $('dock-toggle').setAttribute('aria-expanded', String(open));
  paintNeedBadge();
  // the suggestion table wants more room than a column of cards does
  shellMain.classList.toggle('dock-wide', active === 'tune');
  if (open && active === 'tasks' && boardState()) paintTasks(boardState());
  if (open && active === 'tune') loadTuneHistory();
  document.dispatchEvent(new CustomEvent('loop-tab', { detail: { tab: active, open } }));
}

/** Clicking the tab that is already showing collapses the panel; anything else switches to it. */
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
  if (document.querySelector('dialog[open]')) return;
  const m = /^Digit([1-4])$/.exec(e.code);
  if (!m) return;
  e.preventDefault();
  select(TABS[Number(m[1]) - 1][0]);
});

// ---- 需要你處理 ------------------------------------------------------------
// The same cards as 總覽 (web/inbox.js), fed by the single board SSE connection in shell.js —
// the snapshot /board.html renders. Details open on 總覽; one-click actions run from here.
const inboxAct = (path) =>
  api(path, { method: 'POST', body: '{}' })
    .then(() => toast('已送出', 'ok'))
    .catch((err) => toast(`沒有成功：${err.message}`, 'bad'));

function paintTasks(s) {
  paintInbox($('dock-inbox'), s, { act: inboxAct });
}

// The same two numbers as 總覽's tiles and the list's two groups: 需要你處理 (orange) and, when
// nothing needs you, 待核可 (blue). On the tab, and on the top bar's panel toggle while the panel is
// closed (below 1280px it starts closed, and on a phone it is a drawer: the count must not live only
// inside it).
let needCount = 0;
let waitCount = 0;
function paintNeedBadge() {
  const n = needCount || waitCount;
  const kind = needCount ? 'need' : 'wait';
  for (const id of ['act-tasks-badge', 'dock-badge']) {
    setText(id, n ? String(n) : '');
    $(id).dataset.kind = kind;
  }
  $('act-tasks-badge').hidden = !n;
  $('dock-badge').hidden = !n || isOpen();
  const what = [needCount ? `需要你處理 ${needCount}` : null, waitCount ? `待核可 ${waitCount}` : null].filter(Boolean).join('・');
  $('act-tasks').title = `${what || '需要你處理'}（Alt+1）`;
  $('dock-toggle').title = what ? `顯示或收起右側面板（${what}）` : '顯示或收起右側面板';
}

/** Registered in the init block, after every `let` it reads: a snapshot already in hand is delivered at once. */
function onSnapshot(s) {
  const benchKey = () => (benchBusy ? `${benchBusy.id}|${benchBusy.status}|${benchBusy.arms_done}|${schedPaused}` : '');
  const was = benchKey();
  benchBusy = s.benchmark || null;
  schedPaused = Boolean(s.paused);
  if (benchKey() !== was && catalogData) paintCatalog(catalogData);
  needCount = (s.cards || []).filter(needsYou).length;
  waitCount = (s.cards || []).filter(awaiting).length;
  paintNeedBadge();
  if (!$('pane-tasks').hidden) paintTasks(s);
}

// ---- 模型切換 ---------------------------------------------------------------
// One model fits the GPU at a time, and a switch restarts vLLM (minutes, chat unavailable), so
// this is deliberately a confirm + a visible state — never a one-click surprise during a demo.
// Downloads and image builds are background jobs (one at a time) that never touch the running
// model, so those are a single click.
const GiB = 1024 ** 3;
const size = (b) => (b == null ? '—' : `${(b / GiB).toFixed(b >= 100 * GiB ? 0 : 1)} GB`);
const tb = (b) => (b == null ? '' : b >= 1024 * GiB ? `${(b / (1024 * GiB)).toFixed(1)} TB` : size(b));
// 用途標籤 — the server derives `role` for every recipe (src/local/catalog.ts roleFor); the panel
// owns the wording. The hint answers "why does this one say that", which a bare badge cannot.
const ROLE_LABEL = { chat: '對話', code: '寫程式', fast: '小而快', vision: '看得懂圖', think: '會推理', big: '大模型' };
const ROLE_HINT = {
  chat: '一般問答、寫文件，日常就用這種',
  code: '針對寫程式調校過的模型',
  fast: '單機就跑得動、約 30 GB 以內，回得快',
  vision: '看得懂圖片，不是只有文字',
  think: '會先想過再回答，慢但比較穩',
  big: '參數或體積很大，要很多記憶體或兩台 Spark',
};

function roleTag(e, small) {
  const tag = el('span', `reco-tag ${e.role || 'chat'}${small ? ' sm' : ''}`, ROLE_LABEL[e.role] || '模型');
  if (ROLE_HINT[e.role]) tag.title = ROLE_HINT[e.role];
  return tag;
}
let switching = false;
let jobTimer = null;
let catalogData = null;
let benchBusy = null; // board snapshot: the benchmark in progress, if any
let schedPaused = false; // board snapshot: nothing dispatches, so a benchmark between arms is not on the GPU

/** A benchmark owns the GPU (switching must wait) unless the scheduler is paused before it judges. */
function benchHolds() {
  return Boolean(benchBusy) && !(schedPaused && benchBusy.status === 'running');
}

function actionButton(e, data) {
  const busy = data.job && data.job.status === 'running';
  if (e.loaded) return el('span', 'badge-now', '使用中');
  if (e.action === 'none') return el('span', 's blocked', e.blocked_by || '這台跑不動');
  const b = el('button', 'mini');
  b.type = 'button';
  if (e.action === 'switch') {
    b.textContent = '切換';
    b.onclick = () => switchModel(e);
  } else if (e.action === 'download') {
    b.classList.add('dl');
    b.textContent = e.partial
      ? `續傳（${size(e.disk_bytes)} / ${e.size_bytes ? size(e.size_bytes) : '?'}）`
      : `下載${e.size_bytes ? `（≈${size(e.size_bytes)}）` : ''}`;
    b.onclick = () => startJob('download', e.recipe, e.name);
  } else {
    b.classList.add('dl');
    b.textContent = `建置映像（${e.container}）`;
    b.onclick = () => startJob('build', e.recipe, e.name);
  }
  // one download or build at a time; a switch only restarts vLLM and runs beside either
  const queued = busy && e.action !== 'switch';
  const held = benchHolds() && e.action === 'switch';
  if (queued || switching || held) b.disabled = true;
  if (queued) b.title = '已有下載或建置在跑，等它結束';
  if (held) b.title = `評比使用中：${benchBusy.title}`;
  return b;
}

function modelRow(e, data) {
  const row = el('div', `model-row${e.loaded ? ' on' : ''}${e.action === 'none' ? ' off' : ''}`);
  const txt = el('div', 'txt');
  const n = el('div', 'n');
  n.append(roleTag(e, true), el('span', 'name', e.name));
  txt.append(n);
  const bits = [];
  if (e.downloaded) bits.push(`已下載 ${size(e.disk_bytes)}`);
  else if (e.partial) bits.push(`下載到一半 ${size(e.disk_bytes)}`);
  else if (e.size_bytes) bits.push(`約 ${size(e.size_bytes)}`);
  if (e.nodes > 1) bits.push(`${e.nodes} 台 Spark`);
  if (e.action === 'build') bits.push(`缺映像 ${e.container}`);
  if (e.recipe !== e.name) bits.push(e.recipe);
  txt.append(el('div', 's', bits.join(' · ')));
  if (e.description) txt.title = e.description;
  row.append(txt, actionButton(e, data));
  return row;
}

function recoCard(e, data) {
  const card = el('div', `reco-card${e.loaded ? ' on' : ''}`);
  const head = el('div', 'head');
  head.append(roleTag(e, false));
  head.append(el('span', 'n', e.name));
  card.append(head);
  const bits = [e.downloaded ? `已下載 ${size(e.disk_bytes)}` : e.partial ? `下載到一半 ${size(e.disk_bytes)}` : e.size_bytes ? `約 ${size(e.size_bytes)}` : null, e.blocked_by]
    .filter(Boolean)
    .join(' · ');
  card.append(el('div', 's', bits));
  card.append(actionButton(e, data));
  return card;
}

function paintCatalog(data) {
  catalogData = data;
  const st = data.state;
  const cur = data.entries.find((e) => e.loaded);
  setText('spark-count', `· ${data.sparks} 台 Spark`);
  const note = $('switch-state');
  note.classList.toggle('busy', st.status !== 'ready' && st.status !== 'idle');
  note.classList.toggle('bad', st.status === 'error');
  // the benchmark gets its own line: the lists below must still paint, or the panel goes blank
  const bench = $('switch-bench');
  bench.hidden = !benchBusy;
  bench.classList.toggle('busy', benchHolds());
  if (benchBusy) {
    const which = `${benchBusy.title}（${benchBusy.arms_done}/${benchBusy.arm_count} 組）`;
    bench.textContent = benchHolds()
      ? `評比使用中：${which}——評比會自己輪流切換模型，結束後切回原本的`
      : `評比暫停中：${which}——現在可以切換模型；恢復排程後，評比會自己換回它要用的模型`;
  }
  note.textContent =
    st.status === 'ready'
      ? (cur && cur.name) || st.loaded || '目前模型'
      : st.status === 'error'
        ? `載入失敗：${st.error || '未知原因'}`
        : st.status === 'idle'
          ? '目前沒有載入任何模型'
          : `${st.status}：正在準備 ${st.wanted || ''}…`;

  // 推薦: the three we vouch for, in a fixed order, only if this checkout has them
  const reco = ['chat', 'code', 'fast'].map((k) => data.entries.find((e) => e.recommend === k)).filter(Boolean);
  $('model-reco-list').replaceChildren(...reco.map((e) => recoCard(e, data)));
  $('model-reco').hidden = reco.length === 0;

  // one notice for the shared image, not one per row
  const missing = data.images.filter((i) => !i.ready && i.waiting > 0);
  const img = missing.find((i) => i.kind === 'pull') || missing[0];
  $('model-image-notice').hidden = !img;
  if (img) {
    setText(
      'model-image-text',
      `${img.waiting} 個模型在等容器映像 ${img.container}（${img.kind === 'pull' ? `下載現成映像約 ${img.gb} GB：有線幾分鐘，這台走 Wi-Fi 約 1 小時` : `要編譯，約 ${img.minutes} 分鐘以上`}）。建一次就全部解鎖，在背景跑、不影響目前的模型。`,
    );
    const b = $('model-image-build');
    b.textContent = `建置 ${img.container}`;
    b.disabled = Boolean(data.job && data.job.status === 'running') || switching;
    b.onclick = () => startJob('build', img.recipe, img.container);
  }

  // 全部: grouped by what the operator can do
  const groups = [
    ['可切換', (e) => e.action === 'switch'],
    ['可下載', (e) => e.action === 'download'],
    ['需要建置映像', (e) => e.action === 'build'],
    [`需要 2 台以上 Spark`, (e) => e.action === 'none' && e.nodes > data.sparks],
    ['其他', (e) => e.action === 'none' && e.nodes <= data.sparks],
  ];
  const out = [];
  for (const [label, pick] of groups) {
    const list = data.entries.filter(pick);
    if (!list.length) continue;
    out.push(el('p', 'model-group', `${label}（${list.length}）`));
    for (const e of list) out.push(modelRow(e, data));
  }
  $('model-list').replaceChildren(...out);
  setText('model-disk', `· ${data.entries.length} 個配方${data.disk_free_bytes != null ? ` · 磁碟剩餘 ${tb(data.disk_free_bytes)}` : ''}`);

  paintJob(data.job);
}

function paintJob(job) {
  const card = $('model-job');
  if (!job || job.status !== 'running') {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(job.started_at)) / 60000));
  setText('model-job-title', `${job.kind === 'download' ? '下載' : '建置映像'} ${job.kind === 'download' ? job.recipe : job.container || job.recipe} · 已 ${mins} 分鐘`);
  const bar = $('model-job-bar');
  const known = job.kind === 'download' && job.size_bytes && job.bytes_now != null;
  bar.classList.toggle('indeterminate', !known);
  bar.style.width = known ? `${Math.min(100, (100 * job.bytes_now) / job.size_bytes).toFixed(1)}%` : '';
  setText('model-job-meta', known ? `${size(job.bytes_now)} / ${size(job.size_bytes)}` : job.kind === 'download' ? `已下載 ${size(job.bytes_now)}` : 'docker 進行中…');
  setText('model-job-line', job.last_line || '');
}

async function loadModels() {
  try {
    const data = await api('/api/local/catalog');
    paintCatalog(data);
    if (data.job && data.job.status === 'running') watchJob();
  } catch (err) {
    setText('switch-state', /404/.test(err.message) ? '本地模型未啟用：loop config set local_models_enabled true' : `讀不到模型清單：${err.message}`);
  }
}

// ---- background jobs (download / build) ----
async function startJob(kind, recipe, label) {
  if (jobTimer) return toast('已有工作在跑，等它結束', 'warn');
  try {
    const r = await api('/api/local/jobs', { method: 'POST', body: JSON.stringify({ kind, recipe }) });
    toast(`${kind === 'download' ? '開始下載' : '開始建置'} ${label}，在背景進行`, 'ok');
    paintJob(r.job);
    if (catalogData) paintCatalog({ ...catalogData, job: r.job });
    watchJob();
  } catch (err) {
    toast(`起不來：${err.message}`, 'bad');
  }
}

function watchJob() {
  if (jobTimer) return;
  const tick = async () => {
    let r;
    try {
      r = await api('/api/local/jobs/current');
    } catch (e) {
      return;
    }
    const job = r.job;
    paintJob(job);
    if (!job || job.status !== 'running') {
      clearInterval(jobTimer);
      jobTimer = null;
      const what = job ? (job.kind === 'download' ? '下載' : '建置') : '工作';
      if (job && job.status === 'done') toast(`${what} ${job.recipe} 完成`, 'ok');
      else if (job && job.status === 'error') toast(`${what}失敗：${job.error || '看 log'}`, 'bad');
      else if (job) toast(`${what}${job.status === 'cancelled' ? '已取消' : '結果不明'}：${job.error || ''}`, 'warn');
      loadModels();
    }
  };
  jobTimer = setInterval(tick, 3000);
}

$('model-job-log').onclick = () => {
  if (window.LoopTerminal) window.LoopTerminal.openPreset('joblog');
};

$('model-job-cancel').onclick = async () => {
  if (!window.confirm('取消目前的工作？下載到一半的檔案會留著，之後可以續傳。')) return;
  try {
    await api('/api/local/jobs/current/cancel', { method: 'POST', body: '{}' });
  } catch (err) {
    toast(`取消失敗：${err.message}`, 'bad');
  }
};

async function switchModel(e) {
  if (switching) return;
  if (document.getElementById('stop-btn').disabled === false) {
    return toast('還有回答正在產生，先按停止再切換模型', 'warn');
  }
  const ok = window.confirm(
    [
      `切換到「${e.name}」？`,
      '',
      'vLLM 會重新啟動，期間無法對話，通常要幾分鐘（大模型更久）。',
      '目前的對話紀錄不會受影響。',
    ].join('\n'),
  );
  if (!ok) return;

  switching = true;
  try {
    await api(`/api/local/catalog/${encodeURIComponent(e.recipe)}/load`, { method: 'POST', body: '{}' });
    toast(`正在切換到 ${e.name}，載入完成前無法對話`, 'ok');
    // poll until vLLM answers again (or gives up) — the status line shows progress meanwhile
    const started = Date.now();
    const timer = setInterval(async () => {
      let data;
      try {
        data = await api('/api/local/catalog');
      } catch (err) {
        return;
      }
      paintCatalog(data);
      const mins = Math.round((Date.now() - started) / 60000);
      const now = data.entries.find((x) => x.loaded);
      if (data.state.status === 'ready' && now && now.recipe === e.recipe) {
        clearInterval(timer);
        switching = false;
        toast(`${e.name} 已就緒（花了約 ${mins} 分鐘）`, 'ok');
        paintCatalog(data);
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

// the 模型 panel re-reads on every visit; while a switch or job is running the poller keeps it fresh
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
// 歷史建議 are kept per person: a new 你是 means another list, and the latest one was the old person's
document.addEventListener('ops:who', () => {
  tuneLatest = null;
  paintTuneLatest();
  if (!$('pane-tune').hidden) loadTuneHistory();
});

// ---- init -------------------------------------------------------------------
// Last on purpose. paintTabs() may call paintTasks()/loadTuneHistory(), and both read state
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
onBoard(onSnapshot);
loadModels();
