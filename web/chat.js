import {
  $,
  api,
  authHeaders,
  drawer,
  el,
  fmtInt,
  fmtSec,
  nameHeader,
  phone,
  rail,
  setText,
  store,
  stored,
  toast,
  when,
  wireTheme,
} from './shell.js';
import { renderMarkdown } from './chat-md.js';
import { mountActions, mountConvMenu } from './chat-actions.js';

/**
 * The conversation itself: streaming answers from the local model, pasted screenshots, and the
 * server-side history (src/chat/store.ts). The surrounding shell (rails, theme, API helper) is
 * shell.js; the markdown/preview renderer is chat-md.js; the right-hand panels are dock.js.
 *
 * Every history call goes through histSafe, so a storage failure degrades to in-memory-only
 * behaviour instead of breaking the answer the user is waiting for (a static test enforces this).
 */

wireTheme($('theme-btn'));

// ---- rails ----------------------------------------------------------------
const shellMain = $('shell-main');
const railInner = $('rail-inner');
// true while an answer is streaming — the model panel keeps refreshing even when collapsed then
let busyNow = false;

// rail() paints as it is constructed, so nothing here may call into code declared further down.
const histRail = rail({
  main: shellMain,
  key: 'loop_shell_rail',
  cls: 'rail-collapsed',
  toggle: $('rail-toggle'),
  defaultOpen: window.innerWidth >= 1000,
});
// The dock (which panel, open or closed) belongs to dock.js — this file only needs to know
// whether the 模型 panel is on screen, so the 1 s stats poll can stop when it is not.
const statsVisible = () =>
  !$('pane-status').hidden && (phone() ? drawer.isOpen() : !shellMain.classList.contains('dock-collapsed'));

// On a phone there is no width to hand back, so the same markup moves into the shared drawer
// (shell.js `drawer`); the dock does the same in dock.js. Closing returns both.
const closeDrawer = () => drawer.close();

$('rail-toggle').onclick = () => {
  if (phone()) {
    if (drawer.isOpen() && drawer.showing() === railInner) drawer.close();
    else drawer.show(railInner, '對話紀錄');
    return;
  }
  histRail.toggle();
};
// dock.js tells us when 模型 becomes the visible panel, so it is never stale on arrival
document.addEventListener('loop-tab', (e) => {
  const d = e.detail || {};
  if (d.open && d.tab === 'status') refreshStats();
});
$('drawer-close').onclick = closeDrawer;
$('drawer-scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawer.isOpen()) closeDrawer();
});
// leaving phone width: put every borrowed panel back where the grid expects it
window.addEventListener('resize', () => {
  if (!phone() && drawer.isOpen()) closeDrawer();
});

const samplesBox = $('samples');
let samplesOpen = stored('loop_shell_samples') === 'open';
function paintSamples() {
  samplesBox.hidden = !samplesOpen;
  $('samples-toggle').setAttribute('aria-expanded', String(samplesOpen));
  $('samples-toggle').classList.toggle('on', samplesOpen);
}
$('samples-toggle').onclick = () => {
  samplesOpen = !samplesOpen;
  store('loop_shell_samples', samplesOpen ? 'open' : 'closed');
  paintSamples();
};
paintSamples(); // the markup ships visible; the remembered state decides

// ---- composer chips (checkbox semantics without the checkbox) --------------
const chipOn = (id) => $(id).getAttribute('aria-pressed') === 'true';
const setChip = (id, on) => $(id).setAttribute('aria-pressed', String(Boolean(on)));
function wireChip(id, onToggle) {
  $(id).onclick = () => {
    if ($(id).disabled) return;
    setChip(id, !chipOn(id));
    if (onToggle) onToggle(chipOn(id));
  };
}

// ---- formatting -----------------------------------------------------------
const GiB = 1024 ** 3;
const fmtGiB = (b) => (b == null ? '–' : `${(b / GiB).toFixed(1)} GiB`);
const pct = (x) => `${Math.max(0, Math.min(100, x * 100)).toFixed(1)}%`;

// ---- stats panel ----------------------------------------------------------
let lastGen = null; // { tokens, t } for the live tokens/s estimate

function paintStats(s) {
  const up = s.vllm_up && s.status === 'ready';
  const svc = $('svc-state');
  svc.textContent = !s.vllm_up ? 'vLLM 離線' : up ? '模型就緒' : `模型狀態：${s.status}`;
  svc.dataset.state = up ? 'ok' : 'bad';

  setText('model-name', s.display_name || '（沒有載入模型）');
  setText('model-id', s.served_id || '');
  const pr = s.model && s.model.params;
  const fmtB = (n) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (pr && pr.language_total) {
    $('m-params').hidden = false;
    setText('m-params-total', `${fmtB(pr.language_total)} 參數`);
    setText('m-params-active', pr.active_per_token ? `MoE：每個 token 實際運算約 ${fmtB(pr.active_per_token)}` : '');
    const extra = [
      pr.routed_experts ? `路由專家 ${fmtB(pr.routed_experts)}` : null,
      pr.per_layer_embedding ? `n-gram 嵌入表 ${fmtB(pr.per_layer_embedding)}（查表，每個 token 只讀幾列）` : null,
      pr.other_language ? `其他語言層 ${fmtB(pr.other_language)}` : null,
      pr.speculative ? `另有推測解碼頭 ${fmtB(pr.speculative)}` : null,
      pr.vision ? `視覺編碼器 ${fmtB(pr.vision)}` : null,
    ].filter(Boolean);
    setText('m-params-detail', extra.join('、') || '–');
  } else {
    $('m-params').hidden = true;
    setText('m-params-detail', '–');
  }
  setText('m-disk', fmtGiB(s.model && s.model.disk_bytes));
  setText('m-quant', (s.model && s.model.quant) || '–');
  const a = s.model && s.model.arch;
  const arch = a
    ? [a.experts ? `MoE：${a.experts} 個專家，每個 token 只啟用 ${a.experts_per_token}` : null, a.layers ? `${a.layers} 層` : null]
        .filter(Boolean)
        .join('，')
    : '';
  setText('m-arch', arch || '–');
  setText('m-ctx', s.model && s.model.max_model_len ? `${fmtInt(s.model.max_model_len)} tokens` : '–');
  setText(
    'm-spec',
    s.spec_decode
      ? `MTP 草稿接受率 ${Math.round(s.spec_decode.acceptance_rate * 100)}%` +
          (s.spec_decode.accepted_per_draft ? `（每步平均多產 ${s.spec_decode.accepted_per_draft.toFixed(1)} 個 token）` : '')
      : '–',
  );

  const mem = s.memory;
  if (mem) {
    $('mem-bar').style.width = pct(mem.used_bytes / mem.total_bytes);
    setText('mem-used', `${fmtGiB(mem.used_bytes)} / ${fmtGiB(mem.total_bytes)}（${Math.round((mem.used_bytes / mem.total_bytes) * 100)}%）`);
    setText('mem-free', fmtGiB(mem.available_bytes));
    if (mem.vllm_fraction) {
      const mark = $('mem-mark');
      mark.hidden = false;
      mark.style.left = pct(mem.vllm_fraction);
      setText('mem-vllm', `總記憶體的 ${Math.round(mem.vllm_fraction * 100)}%（約 ${fmtGiB(mem.total_bytes * mem.vllm_fraction)}，圖中直線）`);
    } else {
      setText('mem-vllm', '–');
    }
  }

  const kv = s.kv_cache || {};
  $('kv-bar').style.width = kv.usage_pct != null ? pct(kv.usage_pct / 100) : '0%';
  setText('kv-size', kv.size_tokens != null ? `${fmtInt(kv.size_tokens)} tokens${kv.dtype ? `（${kv.dtype}）` : ''}` : '–');
  setText('kv-usage', kv.usage_pct != null ? `${kv.usage_pct.toFixed(1)}%` : '–');
  setText(
    'kv-conc',
    kv.max_concurrency_full_context != null && s.model && s.model.max_model_len
      ? `每人都用滿 ${fmtInt(s.model.max_model_len)} tokens 時約 ${kv.max_concurrency_full_context.toFixed(1)} 人；一般對話可同時更多`
      : '–',
  );

  const req = s.requests || {};
  setText('req-running', fmtInt(req.running));
  setText('req-waiting', fmtInt(req.waiting));

  const g = s.gpu;
  setText('gpu-name', g ? g.name : '–');
  setText('gpu-tp', g ? `${g.temp_c ?? '–'} °C · ${g.power_w != null ? g.power_w.toFixed(1) : '–'} W` : '–');
  setText('gpu-util', g && g.util_pct != null ? `${g.util_pct}%` : '–');
  const tot = s.totals || {};
  setText('tot-gen', tot.generation_tokens != null ? `${fmtInt(tot.generation_tokens)} tokens（vLLM 啟動後）` : '–');
  setText('tot-prompt', tot.prompt_tokens != null ? `${fmtInt(tot.prompt_tokens)} tokens` : '–');

  const kb = s.knowledge;
  if (kb) {
    setText('kb-docs', kb.rag_enabled ? `${fmtInt(kb.documents)} 份` : '未啟用（rag_enabled=false）');
    setText('kb-chunks', kb.rag_enabled ? `${fmtInt(kb.chunks)} 段` : '–');
    const label = (uri) => {
      const segs = String(uri || '').replace(/\/+$/, '').split('/');
      const base = segs.pop() || '';
      return base.startsWith('_') && segs.length ? `${segs.pop()}/${base}` : base;
    };
    setText('kb-sources', kb.sources && kb.sources.length ? kb.sources.map((x) => `${label(x.uri)}（${fmtInt(x.documents)}）`).join('、') : '–');
  }

  // live server-side throughput while something is generating
  const now = Date.parse(s.ts) || Date.now();
  if (tot.generation_tokens != null) {
    if (lastGen && (req.running || 0) > 0 && now > lastGen.t) {
      const rate = (tot.generation_tokens - lastGen.tokens) / ((now - lastGen.t) / 1000);
      setText('live-tps', rate > 0 ? rate.toFixed(1) : '–');
    } else if (!(req.running > 0)) {
      setText('live-tps', '–');
    }
    lastGen = { tokens: tot.generation_tokens, t: now };
  }
}

let statsInFlight = false;
async function refreshStats() {
  if (statsInFlight) return;
  if (!statsVisible() && !busyNow) return; // panel hidden and idle — nothing to paint
  statsInFlight = true;
  try {
    const r = await fetch('/api/chat/stats', { headers: authHeaders });
    if (r.status === 404) {
      $('disabled-note').hidden = false;
      setText('svc-state', '未啟用');
      return;
    }
    if (r.ok) paintStats(await r.json());
  } catch (e) {
    setText('svc-state', '無法取得狀態');
  } finally {
    statsInFlight = false;
  }
}
refreshStats();
setInterval(refreshStats, 1000);


// ---- image attachments (Ctrl+V / drag & drop / file picker) ------------------------
const MAX_IMAGES = 4;
const pending = []; // { url, name }

function hint(msg) {
  setText('attach-hint', msg);
  if (msg) setTimeout(() => $('attach-hint').textContent === msg && setText('attach-hint', ''), 2500);
}

function paintAttach() {
  const box = $('attach');
  box.replaceChildren();
  box.hidden = pending.length === 0;
  pending.forEach((p, idx) => {
    const t = el('div', 'thumb');
    const img = el('img');
    img.src = p.url;
    img.alt = p.name;
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.title = '移除這張圖';
    x.onclick = () => {
      pending.splice(idx, 1);
      paintAttach();
    };
    t.append(img, x);
    box.append(t);
  });
}

// Screenshots are shrunk to 1600 px on the long edge: enough to read UI text, far fewer image tokens.
function downscale(file) {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(src);
      let url = canvas.toDataURL('image/png');
      if (url.length > 3_000_000) url = canvas.toDataURL('image/jpeg', 0.9);
      resolve(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error('無法讀取這張圖片'));
    };
    img.src = src;
  });
}

async function addImages(files) {
  for (const file of files) {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) continue;
    if (pending.length >= MAX_IMAGES) {
      hint(`一次最多 ${MAX_IMAGES} 張圖`);
      break;
    }
    try {
      pending.push({ url: await downscale(file), name: file.name || '截圖' });
      paintAttach();
      hint('已加入圖片，輸入問題後送出');
    } catch (e) {
      hint(e.message);
    }
  }
}

document.addEventListener('paste', (e) => {
  const files = [...((e.clipboardData && e.clipboardData.items) || [])]
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile());
  if (!files.length) return; // plain text paste keeps its default behaviour
  e.preventDefault();
  addImages(files);
  $('prompt').focus();
});
const convo = $('convo');
convo.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
    convo.classList.add('drag');
  }
});
convo.addEventListener('dragleave', (e) => {
  if (!convo.contains(e.relatedTarget)) convo.classList.remove('drag');
});
convo.addEventListener('drop', (e) => {
  convo.classList.remove('drag');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  addImages([...e.dataTransfer.files]);
});
$('file-btn').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  addImages([...e.target.files]);
  e.target.value = '';
};

// ---- conversation ---------------------------------------------------------
const SAMPLES = [
  'RDMA 收圖為什麼從 WRITE_WITH_IMM 改成 SEND/RECV？當時發生了什麼問題？',
  '行車紀錄（flight recorder）的 incident 檔怎麼看？同類事件的節流規則是什麼？',
  '我想調整瑕疵偵測的門檻，應該改哪個檔案、哪個參數？',
  '最近 cf-aoi 改了哪些東西？用表格整理日期、模組與重點。',
  '用 SVG 畫出 CF-AOI 從取像、影像處理到 Control 的資料流程圖。',
];
setChip('kb-box', stored('loop_chat_kb') !== 'off');
wireChip('kb-box', (on) => store('loop_chat_kb', on ? 'on' : 'off'));
wireChip('think-box');
// 調參建議 always needs the knowledge base: a parameter suggestion with no source is a guess
wireChip('tune-box', (on) => {
  $('tune-note').hidden = !on;
  $('kb-box').disabled = on;
  if (on) setChip('kb-box', true);
  $('prompt').placeholder = on
    ? '描述症狀：例如「ROI 邊緣常把正常紋路判成刮傷」'
    : '輸入問題，Shift+Enter 送出、Enter 換行；可 Ctrl+V 貼上截圖';
});
for (const q of SAMPLES) {
  const b = el('button', 'btn', q);
  b.type = 'button';
  b.onclick = () => send(q);
  $('samples').append(b);
}

const log = $('log');
const history = [];
let controller = null;

function setBusy(on) {
  busyNow = on;
  $('send-btn').disabled = on;
  $('stop-btn').disabled = !on;
  for (const b of $('samples').querySelectorAll('button')) b.disabled = on;
}

const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 120;

function addMsg(role) {
  const empty = $('empty');
  if (empty) empty.remove();
  const wrap = el('div', `msg ${role}`);
  wrap.append(el('div', 'who', role === 'user' ? '你' : '本地模型'));
  const think = el('details', 'think');
  think.hidden = true;
  const thinkText = el('pre');
  think.append(el('summary', null, '思考過程（點開）'), thinkText);
  const body = el('div', role === 'assistant' ? 'body md' : 'body');
  wrap.append(think, body);
  log.append(wrap);
  log.scrollTop = log.scrollHeight;
  return { wrap, think, thinkText, body };
}

function resetRunTiles() {
  for (const id of ['r-ttft', 'r-tps', 'r-tokens', 'r-total']) setText(id, '–');
}

async function send(raw, opts = {}) {
  let text = (raw || '').trim();
  const carried = opts.images;
  if ((!text && pending.length === 0 && !(carried && carried.length)) || controller) return;
  if (!text) text = '請說明這張圖的內容。';
  $('prompt').value = '';
  if (samplesOpen) {
    samplesOpen = false;
    store('loop_shell_samples', 'closed');
    paintSamples();
  }
  const images = carried && carried.length ? carried : pending.splice(0, pending.length);
  if (!carried) paintAttach();

  const u = addMsg('user');
  if (images.length) {
    const row = el('div', 'imgs');
    for (const im of images) {
      const img = el('img');
      img.src = im.url;
      img.alt = im.name;
      img.onclick = () => img.classList.toggle('big');
      row.append(img);
    }
    u.wrap.insertBefore(row, u.body);
  }
  u.body.textContent = text;
  u.text = text;
  u.images = images;
  mountActions(u, actionCtx);
  const content = images.length
    ? [{ type: 'text', text }, ...images.map((im) => ({ type: 'image_url', image_url: { url: im.url } }))]
    : text;
  const entry = { role: 'user', content };
  u.entry = entry;
  history.push(entry);
  const thinking = chipOn('think-box');
  const mode = opts.mode || (chipOn('tune-box') ? 'tune' : 'chat');
  await saveUserTurn(u, text, images, thinking);

  const a = addMsg('assistant');
  a.wrap.classList.add('pending');
  a.knowledge = chipOn('kb-box');
  a.mode = mode;
  a.userOrd = u.ord;
  a.body.textContent = a.knowledge ? '正在查 CF-AOI 知識庫…' : images.length ? '正在看圖…' : '等待模型回應…';
  // the empty row is created up front so an interrupted answer still has somewhere to live
  await saveAssistantRow(a);
  await generate(a, { thinking, cont: false, mode });
  mountActions(a, actionCtx);
  loadConvs();
}

// ---- 重答 / 編輯重問 ----------------------------------------------------------
// Both are built on truncate: the stored turn is soft-deleted and a new one appended, so `ord`
// keeps increasing and the replay order survives (src/chat/store.ts).
const actionCtx = {
  regenerate: async (a) => {
    if (controller || a.ord == null) return;
    await histSafe(() =>
      chatApi(`/api/chat/conversations/${convId}/truncate`, { method: 'POST', body: JSON.stringify({ ord: a.ord }) }),
    );
    const at = history.lastIndexOf(a.entry);
    if (at >= 0) history.splice(at, 1);
    a.wrap.remove();

    const next = addMsg('assistant');
    next.wrap.classList.add('pending');
    next.knowledge = a.knowledge;
    next.userOrd = a.userOrd;
    next.body.textContent = '重新回答中…';
    await saveAssistantRow(next);
    await generate(next, { thinking: chipOn('think-box'), cont: false, mode: a.mode });
    mountActions(next, actionCtx);
    loadConvs();
  },
  editAgain: async (u) => {
    if (controller || u.ord == null) return;
    await histSafe(() =>
      chatApi(`/api/chat/conversations/${convId}/truncate`, { method: 'POST', body: JSON.stringify({ ord: u.ord }) }),
    );
    // drop this turn and everything after it, on screen and in what the model will see
    const at = history.findIndex((h) => h === u.entry);
    if (at >= 0) history.splice(at);
    let node = u.wrap;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }
    $('prompt').value = u.text || '';
    $('prompt').focus();
    if (u.images && u.images.length) {
      pending.splice(0, pending.length, ...u.images);
      paintAttach();
    }
    loadConvs();
  },
  conversation: () => convId,
  // A cloud review is shown but deliberately NOT pushed into `history`: the local model must not
  // start quoting the cloud model in later turns (and the cost would compound silently).
  addCloudReview: (msg, after) => {
    const v = addMsg('assistant');
    v.messageId = msg.id;
    v.ord = msg.ord;
    v.entry = { role: 'assistant', content: msg.content };
    v.wrap.classList.add('cloud');
    v.wrap.querySelector('.who').textContent = `雲端複核 · ${String(msg.model_id || '').replace('cloud:', '')}`;
    v.body.replaceChildren(renderMarkdown(msg.content, true));
    v.wrap.append(el('div', 'note', '這段來自雲端模型，只顯示給你看；接下來的提問不會帶著它。'));
    if (after && after.wrap.nextSibling) log.insertBefore(v.wrap, after.wrap.nextSibling);
    mountActions(v, actionCtx);
    log.scrollTop = log.scrollHeight;
  },
};

// Citation list under an answer: [n] matches the numbers the model cites in its text.
function renderRefs(a, k) {
  if (a.refs) a.refs.remove();
  const box = el('details', 'refs');
  const n = k.sources.length;
  const summary = k.error
    ? `知識庫檢索失敗：${k.error}`
    : n
      ? `參考資料 ${n} 則（CF-AOI 知識庫，檢索 ${k.ms} ms${k.keywords && k.keywords.length ? `；關鍵字：${k.keywords.join('、')}` : ''}）`
      : '知識庫中沒有找到相關資料';
  const sum = el('summary', k.error ? 'err' : null, summary);
  box.append(sum);
  if (n) {
    const list = el('ol');
    for (const src of k.sources) {
      const item = el('li');
      const d = el('details');
      const lines = src.start_line != null ? ` · 第 ${src.start_line}–${src.end_line ?? src.start_line} 行` : '';
      d.append(el('summary', null, `[${src.n}] ${src.source}/${src.path}${lines}${src.section ? ` · ${src.section}` : ''}`), el('pre', null, src.snippet));
      item.append(d);
      list.append(item);
    }
    box.append(list);
  }
  a.body.after(box);
  a.refs = box;
}

// 繼續產生 is offered only on the newest answer: history must still end with that exact turn.
function addContinue(a) {
  const row = el('div', 'cont');
  row.append(el('span', 'note', '已達單次輸出上限，回答還沒寫完。'));
  const b = el('button', 'btn', '繼續產生');
  b.type = 'button';
  b.onclick = () => {
    if (controller) return;
    if (history[history.length - 1] !== a.entry) {
      hint('只能接續最新的一則回答');
      return;
    }
    row.remove();
    generate(a, { thinking: false, cont: true, mode: a.mode });
  };
  row.append(b);
  a.wrap.append(row);
}

// One streamed generation into assistant message `a`. With cont, vLLM extends the truncated
// answer from the exact character it stopped at and the new text is appended to the same message.
async function generate(a, { thinking, cont, mode }) {
  controller = new AbortController();
  setBusy(true);
  resetRunTiles();
  const prefix = cont ? a.entry.content : '';
  let added = '';
  const answer = () => prefix + added;

  const announce = (phase, extra = {}) =>
    document.dispatchEvent(
      new CustomEvent('loop-answer', {
        detail: { phase, mode: a.mode, messageId: a.messageId || null, conversationId: convId, ...extra },
      }),
    );
  announce('start');

  const t0 = performance.now();
  let tFirst = null;
  let usage = null;
  let finish = null;
  let reasoning = '';
  let raf = 0;
  const paint = (final) => {
    const stick = nearBottom();
    try {
      a.body.replaceChildren(renderMarkdown(answer(), final));
    } catch (e) {
      // never lose an answer to a rendering bug — fall back to plain text
      a.body.textContent = answer();
    }
    if (stick) log.scrollTop = log.scrollHeight;
  };
  const schedule = () => {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint(false);
      });
    }
  };
  const commit = () => {
    if (cont) a.entry.content = answer();
    else {
      a.entry = { role: 'assistant', content: answer() };
      history.push(a.entry);
    }
  };
  const timer = setInterval(() => setText('r-total', fmtSec(performance.now() - t0)), 100);
  // a long answer is worth keeping even if the tab closes mid-stream
  const draft = setInterval(() => added && saveAnswer(a, { content: answer() }), 15000);
  if (cont) paint(false);

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        messages: modelHistory(),
        thinking,
        continue: cont,
        knowledge: Boolean(a.knowledge),
        ...(mode === 'tune' ? { mode } : {}),
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch (e) {
            continue;
          }
          if (j.loop_knowledge) {
            a.sources = j.loop_knowledge.sources || [];
            a.keywords = j.loop_knowledge.keywords || [];
            renderRefs(a, j.loop_knowledge);
            if (!answer()) a.body.textContent = j.loop_knowledge.sources.length ? '已找到參考資料，等待模型回應…' : '等待模型回應…';
            continue;
          }
          if (j.usage) usage = j.usage;
          const ch = j.choices && j.choices[0];
          if (!ch) continue;
          const d = ch.delta || {};
          const rs = d.reasoning || d.reasoning_content || '';
          const ct = d.content || '';
          if ((rs || ct) && tFirst == null) {
            tFirst = performance.now();
            setText('r-ttft', fmtSec(tFirst - t0));
            a.wrap.classList.remove('pending');
          }
          if (rs) {
            reasoning += rs;
            a.think.hidden = false;
            a.thinkText.textContent = reasoning;
            if (!answer()) a.body.textContent = '（思考中…）';
          }
          if (ct) {
            added += ct;
            schedule();
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      }
    }

    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const tEnd = performance.now();
    commit();
    if (answer()) paint(true);
    else a.body.textContent = '（沒有產生回答）';
    const tokens = usage ? usage.completion_tokens : null;
    const genSec = tFirst != null ? (tEnd - tFirst) / 1000 : null;
    const tps = tokens && tokens > 1 && genSec ? tokens / genSec : null;
    setText('r-total', fmtSec(tEnd - t0));
    setText('r-tokens', fmtInt(tokens));
    setText('r-tps', tps ? tps.toFixed(1) : '–');
    a.wrap.append(
      el(
        'div',
        'meta',
        `${cont ? '接續：' : ''}首字 ${fmtSec(tFirst != null ? tFirst - t0 : null)} · ${tps ? tps.toFixed(1) : '–'} tok/s · 輸出 ${fmtInt(tokens)} tokens · 讀入 ${fmtInt(usage && usage.prompt_tokens)} tokens · 共 ${fmtSec(tEnd - t0)}`,
      ),
    );
    // the 調參 panel looks this message up as soon as it hears 'done' — wait for the write
    Promise.resolve(
      saveAnswer(a, {
        content: answer(),
        reasoning,
        finish_reason: finish,
        ttft_ms: tFirst != null ? tFirst - t0 : null,
        duration_ms: tEnd - t0,
        tokens_in: usage ? usage.prompt_tokens : null,
        tokens_out: tokens,
        sources: a.sources || [],
        keywords: a.keywords || [],
      }),
    ).then(() => announce('done', { content: answer() }));
    nameThread();
    if (finish === 'length') addContinue(a);
  } catch (e) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    a.wrap.classList.remove('pending');
    if (e.name === 'AbortError') {
      commit();
      if (answer()) paint(true);
      else a.body.textContent = '（已停止）';
      a.wrap.append(el('div', 'note', '（已停止）'));
      saveAnswer(a, { content: answer(), reasoning, finish_reason: 'abort', duration_ms: performance.now() - t0 });
      announce('abort', { content: answer() });
    } else if (cont) {
      paint(true); // keep what was already written; the truncated turn stays continuable
      a.wrap.append(el('div', 'note', `接續失敗：${e.message}`));
      addContinue(a);
      announce('error');
    } else {
      history.pop(); // drop the unanswered question so the next turn stays consistent
      a.wrap.classList.add('error');
      a.body.textContent = `沒有送出成功：${e.message}`;
      announce('error');
      dropTurn(a); // …and soft-delete the same turn from the stored history
    }
  } finally {
    clearInterval(timer);
    clearInterval(draft);
    controller = null;
    setBusy(false);
    refreshStats();
  }
}

// ---- 面板要求提問 / 回報答案 ---------------------------------------------------
// dock.js's 調參 panel drives an ordinary turn through send(), and waits for the answer to be
// saved before it looks it up — hence 'done' fires after saveAnswer settles, not before.
document.addEventListener('loop-ask', (e) => {
  const d = e.detail || {};
  if (d.text) send(d.text, { mode: d.mode });
});

document.addEventListener('loop-open', async (e) => {
  const d = e.detail || {};
  if (!d.conversationId) return;
  if (d.conversationId !== convId) await openConv(d.conversationId);
  const node = d.messageId && log.querySelector(`[data-mid="${d.messageId}"]`);
  if (node) node.scrollIntoView({ block: 'center' });
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send($('prompt').value);
});
$('prompt').addEventListener('keydown', (e) => {
  // Shift+Enter sends; a plain Enter stays a newline so a stray keypress never sends a half-written question
  if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send($('prompt').value);
  }
});
$('stop-btn').onclick = () => controller && controller.abort();
function resetChat() {
  if (controller) controller.abort();
  history.length = 0;
  pending.length = 0;
  paintAttach();
  const empty = el('p', 'empty', '點上面的範例問題、輸入問題，或直接 Ctrl+V 貼上截圖');
  empty.id = 'empty';
  log.replaceChildren(empty);
  resetRunTiles();
}
$('clear-btn').onclick = () => newChat();

// ---- 對話紀錄：伺服器端歷史 (src/chat/store.ts) --------------------------------
// The page drives every save and the server just stores: the SSE deltas and the timings are
// already parsed here. Every call goes through histSafe, so if storage fails the chat simply
// behaves like it did before history existed instead of breaking.
let me = null;
let convId = null; // server id of the open thread; null until the first turn is saved
let contextTurns = 12;
let histLive = true; // false once the server says the feature is off
let searchTimer = 0;

/** shell.api plus the one reaction this page needs: the server telling us history is switched off. */
async function chatApi(path, opts = {}) {
  try {
    return await api(path, opts);
  } catch (err) {
    if (err.status === 404 && /disabled/.test(err.message || '')) {
      histLive = false;
      paintConvNote('對話紀錄未啟用（chat_history_enabled）。這次的對話只留在這個分頁。');
    }
    throw err;
  }
}

async function histSafe(fn, fallback = null) {
  if (!histLive) return fallback;
  try {
    return await fn();
  } catch (e) {
    return fallback;
  }
}

// ---- 誰在問 -----------------------------------------------------------------
function paintWho() {
  setText('who-label', me ? me.label : '（未知）');
  const needName = Boolean(me && me.needs_name);
  $('who-form').hidden = !needName;
  $('who-change').hidden = !me || me.source !== 'manual';
  if (needName) setText('who-label', '（還沒留名字）');
}

async function loadMe() {
  me = await histSafe(() => chatApi('/api/chat/me'));
  paintWho();
}

$('who-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('who-name').value.trim();
  if (!name) return;
  store('loop_chat_user', name);
  $('who-name').value = '';
  convId = null;
  resetChat();
  await loadMe();
  loadConvs();
});
$('who-change').onclick = () => {
  $('who-form').hidden = false;
  $('who-name').value = (stored('loop_chat_user') || '').trim();
  $('who-name').focus();
};

// ---- 側欄列表 ---------------------------------------------------------------
function paintConvNote(text) {
  const p = el('p', 'conv-empty', text);
  $('conv-list').replaceChildren(p);
}

function startRename(row, txt, item) {
  const input = el('input');
  input.className = 'rename';
  input.value = item.title;
  const cancel = () => row.replaceChild(txt, input);
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = async (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') cancel();
    if (e.key !== 'Enter') return;
    const title = input.value.trim();
    if (!title) return cancel();
    await histSafe(() => chatApi(`/api/chat/conversations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title }) }));
    loadConvs();
  };
  input.onblur = cancel;
  row.replaceChild(input, txt);
  input.focus();
  input.select();
}

function convRow(item) {
  const row = el('div', `conv${item.id === convId ? ' on' : ''}`);
  row.tabIndex = 0;
  const txt = el('div', 'txt');
  txt.append(el('div', 't', item.title), el('div', 's', `${item.msg_count} 則 · ${when(item.last_msg_at || item.created_at)}`));
  if (item.preview) txt.title = item.preview;
  const ren = el('button', 'row-btn', '✎');
  ren.type = 'button';
  ren.title = '改名';
  const del = el('button', 'row-btn', '✕');
  del.type = 'button';
  del.title = '刪除這個對話';
  row.append(txt, ren, del);
  row.onclick = () => openConv(item.id);
  row.onkeydown = (e) => e.key === 'Enter' && openConv(item.id);
  ren.onclick = (e) => {
    e.stopPropagation();
    startRename(row, txt, item);
  };
  del.onclick = async (e) => {
    e.stopPropagation();
    if (!window.confirm(`刪除「${item.title}」？`)) return;
    await histSafe(() => chatApi(`/api/chat/conversations/${item.id}`, { method: 'DELETE' }));
    if (item.id === convId) newChat();
    else loadConvs();
  };
  return row;
}

async function loadConvs() {
  if (!histLive) return;
  const q = $('conv-search').value.trim();
  const data = await histSafe(() => chatApi(`/api/chat/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  if (!data) return;
  if (data.user) {
    me = { ...data.user, needs_name: data.user.source === 'local' };
    paintWho();
  }
  if (!data.items.length) {
    paintConvNote(q ? '找不到符合的對話' : '還沒有紀錄。問一個問題就會自動存下來，之後可以搜尋、改名、接著問。');
    return;
  }
  $('conv-list').replaceChildren(...data.items.map(convRow));
  const open = data.items.find((c) => c.id === convId);
  if (open) paintTitle(open.title);
}

// ---- 對話標題（頂欄，點一下改名）---------------------------------------------
function paintTitle(title) {
  const node = $('conv-title');
  node.textContent = title || '新對話';
  node.disabled = !convId;
}

$('conv-title').onclick = () => {
  if (!convId) return;
  const node = $('conv-title');
  const input = el('input');
  input.value = node.textContent;
  input.maxLength = 60;
  const done = async (save) => {
    const title = input.value.trim();
    input.replaceWith(node);
    if (!save || !title || title === node.textContent) return;
    const saved = await histSafe(() =>
      chatApi(`/api/chat/conversations/${convId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    );
    if (saved) {
      paintTitle(saved.title);
      loadConvs();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  };
  input.onblur = () => done(true);
  node.replaceWith(input);
  input.focus();
  input.select();
};

function newChat() {
  convId = null;
  paintTitle('新對話');
  resetChat();
  loadConvs();
  if (drawer.isOpen()) closeDrawer();
  $('prompt').focus();
}
$('new-chat-btn').onclick = newChat;
$('conv-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadConvs, 250);
});

// ---- 保存 -------------------------------------------------------------------
async function saveUserTurn(u, text, images, thinking) {
  await histSafe(async () => {
    if (!convId) {
      const conv = await chatApi('/api/chat/conversations', {
        method: 'POST',
        body: JSON.stringify({ knowledge: chipOn('kb-box'), thinking }),
      });
      convId = conv.id;
    }
    const saved = await chatApi(`/api/chat/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: text, images: images.map((im) => ({ url: im.url, name: im.name })) }),
    });
    u.messageId = saved.id;
    u.ord = saved.ord;
  });
}

async function saveAssistantRow(a) {
  await histSafe(async () => {
    if (!convId) return;
    const saved = await chatApi(`/api/chat/conversations/${convId}/messages`, { method: 'POST', body: JSON.stringify({ role: 'assistant', content: '' }) });
    a.messageId = saved.id;
    a.ord = saved.ord;
    a.wrap.dataset.mid = saved.id; // 調參 panel's 在對話中查看 scrolls to this
  });
}

// 繼續產生 updates the same row, so this is an idempotent PATCH rather than a second insert
function saveAnswer(a, patch) {
  if (!a.messageId) return;
  histSafe(() => chatApi(`/api/chat/messages/${a.messageId}`, { method: 'PATCH', body: JSON.stringify(patch) }));
}

/** A turn that never got an answer is soft-deleted, question included, so replay stays clean. */
function dropTurn(a) {
  if (convId && a.userOrd != null) {
    histSafe(() => chatApi(`/api/chat/conversations/${convId}/truncate`, { method: 'POST', body: JSON.stringify({ ord: a.userOrd }) }));
  }
}

function nameThread() {
  if (!convId || history.length > 2) return;
  histSafe(async () => {
    const named = await chatApi(`/api/chat/conversations/${convId}/title`, { method: 'POST', body: '{}' });
    if (named) paintTitle(named.title);
    loadConvs();
  });
}

/** Only the newest turns are replayed INTO the model; everything else stays on screen only. */
function modelHistory() {
  const keep = Math.max(2, contextTurns * 2);
  return history.length > keep ? history.slice(-keep) : history;
}

// ---- 回放 -------------------------------------------------------------------
// Stored screenshots come back as URLs, fetched with the same auth headers as everything else —
// an <img src> could not carry the bearer token. They are for reading: a follow-up question
// sends the text of this turn, not the picture again.
function paintStoredImages(v, images) {
  const row = el('div', 'imgs');
  for (const im of images) {
    const img = el('img');
    img.alt = im.name;
    img.onclick = () => img.classList.toggle('big');
    row.append(img);
    fetch(im.url, { headers: { ...authHeaders, ...nameHeader() } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('gone'))))
      .then((b) => {
        img.src = URL.createObjectURL(b);
      })
      .catch(() => img.replaceWith(el('span', 'note', '（圖片已不在伺服器上）')));
  }
  v.wrap.insertBefore(row, v.body);
}

function replayMsg(m) {
  const v = addMsg(m.role);
  v.messageId = m.id;
  v.ord = m.ord;
  v.wrap.dataset.mid = m.id;
  if (m.role === 'user') {
    if (m.images && m.images.length) paintStoredImages(v, m.images);
    v.body.textContent = m.content;
    v.text = m.content;
  } else {
    v.body.replaceChildren(renderMarkdown(m.content, true));
    if (m.reasoning) {
      v.think.hidden = false;
      v.thinkText.textContent = m.reasoning;
    }
    if (m.sources && m.sources.length) renderRefs(v, { sources: m.sources, ms: 0, keywords: m.keywords });
    const bits = [
      m.ttft_ms != null ? `首字 ${fmtSec(m.ttft_ms)}` : null,
      m.tokens_out != null ? `輸出 ${fmtInt(m.tokens_out)} tokens` : null,
      m.duration_ms != null ? `共 ${fmtSec(m.duration_ms)}` : null,
    ].filter(Boolean);
    if (bits.length) v.wrap.append(el('div', 'meta', bits.join(' · ')));
  }
  v.capturedPath = m.captured_path || null;
  v.taskId = m.task_id || null;
  const cloud = String(m.model_id || '').startsWith('cloud:');
  if (cloud) {
    v.wrap.classList.add('cloud');
    v.wrap.querySelector('.who').textContent = `雲端複核 · ${String(m.model_id).replace('cloud:', '')}`;
  }
  const entry = { role: m.role, content: m.content };
  v.entry = entry;
  // cloud reviews stay out of what the local model sees, on replay too
  if (!cloud) history.push(entry);
  // 重答 needs the ord of the *answer*; 編輯重問 the ord of the question — both come from the row
  mountActions(v, actionCtx);
}

async function openConv(id) {
  if (controller) {
    hint('回答還在產生中，先按停止再切換對話');
    return;
  }
  const data = await histSafe(() => chatApi(`/api/chat/conversations/${id}`));
  if (!data) return;
  resetChat();
  convId = id;
  paintTitle(data.conversation.title);
  contextTurns = data.context_turns || 12;
  setChip('kb-box', data.conversation.knowledge === 1);
  if (drawer.isOpen()) closeDrawer();

  log.replaceChildren();
  const keep = Math.max(2, contextTurns * 2);
  data.messages.forEach((m, i) => {
    if (data.messages.length - i === keep) {
      log.append(el('div', 'trim-note', `↑ 以上內容只留在畫面上；接續提問時只會帶最近 ${contextTurns} 輪進模型`));
    }
    replayMsg(m);
  });
  if (!data.messages.length) log.append(el('p', 'empty', '這個對話還沒有訊息'));
  log.scrollTop = log.scrollHeight;
  loadConvs();
  $('prompt').focus();
}

mountConvMenu({
  conversation: () => convId,
  afterDelete: () => {
    newChat();
    toast('對話已刪除', 'ok');
  },
});
paintTitle('新對話');
loadMe().then(loadConvs);
