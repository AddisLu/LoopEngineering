// 問題單 (/fix.html; /fix.html?id=t_… is the same ticket with its 分析卡). The engineer writes what is
// wrong (a description, screenshots, a pasted Gitea issue or repo link) and presses 請 Loop 分析; the
// 分析卡 then says where the bug probably is, how to make it fail first, which checks must pass and
// on what, and 開始修 queues it (manager mode: 送出核可). Screens: the design canvas Main, TicketNew,
// PhoneTicket. Every server call lives in tickets-api.js; rendering is textContent-only (h / fill).
import { $, h, fill, icon, toast, tsMs, shortTime, dur, modelName } from './frame.js';
import { tickets, registry, links } from './tickets-api.js';
import { takeHandoff } from './fix-handoff.js';

const MAX_IMAGES = 6;
const MAX_EDGE = 1600; // px on the long edge, as the chat shrinks a pasted screenshot
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // per image, decoded: the contract's cap
const MIN_DESC = 10;
const MAX_CAUSES = 6;
const POLL_MS = 3000; // while Loop analyses
const SLOW_POLL_MS = 15000; // while a ticket waits for a manager, or runs
const STASH_KEY = 'loop_fix_new';
const IMPORT = '__import';
const OTHER = '__other';
const PHONE = window.matchMedia('(max-width: 820px)');
const KINDS = [['bugfix', '錯誤修復'], ['feature', '功能'], ['perf', '效能'], ['algo', '演算法']];
const PRIORITIES = [[1, '低'], [2, '中'], [3, '高']];
const OS = { windows: 'Windows', linux: 'Linux' };
const CHECK_KIND = { repro: ['重現', 'bad'], dataset: ['圖資回歸', 'info'], manual: ['人工', null] };
const STEP = { done: ['✓', '完成'], running: ['●', '進行中'], todo: ['○', '還沒開始'], failed: ['✗', '失敗'], skipped: ['–', '跳過'] };
const TEMPLATES = {
  // 圖資回歸 needs a headless entry; an AOI repo that only has a GUI gets this ticket first
  'cli-entry': { kind: 'feature', description: '請幫這個 repo 加一個命令列入口：給一個圖片資料夾，把判定結果寫成檔案（每張一行：檔名、OK/NG），讓圖資回歸可以自動跑。' },
};

// the pill, from the contract: analysis pending/running → 分析中, ready + draft → 就緒, awaiting →
// 待核可, queued → 已排入, running/verifying → 執行中, review/closed → 已完成, failed/attention → 需要處理
const PHASES = {
  new: ['草稿', 'draft'],
  draft: ['草稿', 'draft'],
  analysing: ['分析中', 'busy'],
  failed: ['分析失敗', 'bad'],
  ready: ['就緒', 'ok'],
  rejected: ['已退回', 'warn'],
  awaiting: ['待核可', 'warn'],
  queued: ['已排入', 'busy'],
  running: ['執行中', 'busy'],
  done: ['已完成', 'ok'],
  trouble: ['需要處理', 'bad'],
};
const OPEN = new Set(['draft', 'ready', 'rejected', 'failed']); // still the engineer's to change
const DECIDED = new Set(['ready', 'rejected']); // analysed: 開始修 is one press away
const AFTER = new Set(['awaiting', 'queued', 'running', 'done', 'trouble']); // handed on: the card is a record

/** a ticket (TicketView or TicketSummary) → one of PHASES */
function phaseOf(t) {
  if (!t) return 'new';
  switch (t.status) {
    case 'queued':
      return 'queued';
    case 'running':
    case 'verifying':
    case 'blocked':
      return 'running';
    case 'review':
    case 'closed':
      return 'done';
    case 'attention':
    case 'failed':
      return 'trouble';
    default:
  }
  if (t.approval_state === 'awaiting') return 'awaiting';
  if (t.analysis_status === 'pending' || t.analysis_status === 'running') return 'analysing';
  if (t.analysis_status === 'failed') return 'failed';
  if (t.analysis_status === 'ready') return t.approval_state === 'rejected' ? 'rejected' : 'ready';
  return 'draft';
}

const params = new URLSearchParams(location.search);
const S = {
  t: null, // the ticket, normalised by tickets-api.js; null = a new one being written
  tJson: '',
  repos: [],
  machines: [],
  models: null, // enabled local models; null = none to offer, the 模型 select hides
  f: { title: '', description: '', repo_id: '', branch: '', kind: null, model: '', priority: 2, images: [] },
  formDirty: false, // a ticket's own title/description edited and not saved yet
  link: null, // the pasted link in use: { url, res } (res = resolve-link's answer)
  linkBusy: false,
  expanded: false, // a ticket's form unfolded from its one-line summary
  manual: false, // 改成手動填寫 after a failed analysis
  edit: { causes: null, repro: null, cond: null }, // a section's unsaved edit while its pencil is on
  answer: null, // { i, text }: a 「回答」 being written
  reject: null, // { text }: a manager's 退回 reason being written
  busy: false,
  footErr: null, // { msg, reasons } when 開始修 is refused (409)
  propsOpen: null, // phone: 屬性 opened or closed by hand (null = the page decides)
};
const resolved = new Map(); // pasted url → resolve-link's answer
const dismissed = new Set(); // urls whose chip was removed with ✕
const prefilled = new Set(); // issue urls whose title / body / screenshots were already brought in
let version = 0; // bumps around every write, so a poll that started earlier never lands after it
let pollTimer = 0;

const EMPTY = { steps: [], causes: [], repro: null, checks: [], conditions: null, questions: [], error: null, model_used: null, took_ms: null };
const phase = () => phaseOf(S.t);
const isNew = () => !S.t;
const analysis = () => (S.t && S.t.analysis) || EMPTY;
const cardReadOnly = () => !(DECIDED.has(phase()) || (phase() === 'failed' && S.manual));
const repoById = (id) => S.repos.find((r) => r.id === id) || null;
const machineOf = (name) => S.machines.find((m) => m.name === name) || null;
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const secs = (ms) => `${(Number(ms) / 1000).toFixed(1)} s`;
const startLabel = (t) => (t.approval_mode === 'manager' && !t.is_manager ? '送出核可' : '開始修');

/** aoi/cf-aoi — the owner/name people know a repo by */
function repoLabel(r) {
  if (!r) return '';
  if (r.gitea_owner && r.gitea_repo) return `${r.gitea_owner}/${r.gitea_repo}`;
  const m = /([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(r.remote_url || ''));
  return m ? `${m[1]}/${m[2]}` : r.name || r.id || '';
}
/** the repo this form or ticket is about (the registry row when there is one: it has the stack) */
function currentRepo() {
  if (S.t) return S.t.repo ? repoById(S.t.repo.id) || S.t.repo : null;
  return repoById(S.f.repo_id);
}
function machineText(name, os) {
  if (!name) return '引擎主機';
  if (/^sandbox:/.test(name)) return `GPU 沙盒（${name.slice(8) || 'local'}）`; // a check migrated from a 驗證方案
  const o = OS[os] || OS[(machineOf(name) || {}).os];
  return o ? `${name}（${o}）` : name;
}
/** 剛剛 · 10 分鐘前 · 3 小時前 · 2 天前 */
function ago(s) {
  const t = tsMs(s);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.round(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小時前`;
  return `${Math.round(sec / 86400)} 天前`;
}
function errText(err) {
  if (!err) return '出錯了';
  if (err.status === 413) return '截圖太大，送不出去：少貼幾張再試';
  return err.message || String(err);
}
/** a 409's reasons (validateTask's gate), whatever the key they came under */
function reasonsOf(err) {
  const d = (err && err.data) || {};
  for (const k of ['reasons', 'missing', 'issues', 'errors']) {
    if (Array.isArray(d[k])) return d[k].map((x) => (typeof x === 'string' ? x : (x && (x.message || x.detail)) || JSON.stringify(x)));
  }
  return [];
}
function showPageErr(msg) {
  const p = $('page-err');
  p.textContent = msg;
  p.hidden = !msg;
}

// ---- the new-ticket form: kept in this tab while it is being written --------------------------
let stashTimer = 0;
function stash() {
  if (S.t) return;
  const { title, description, repo_id, branch, kind, model, priority } = S.f;
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ title, description, repo_id, branch, kind, model, priority }));
  } catch (e) {
    /* private mode or full: the form is just not kept */
  }
}
const stashSoon = () => {
  clearTimeout(stashTimer);
  stashTimer = setTimeout(stash, 400);
};
function unstash() {
  try {
    return JSON.parse(sessionStorage.getItem(STASH_KEY) || 'null');
  } catch (e) {
    return null;
  }
}
function clearStash() {
  clearTimeout(stashTimer);
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch (e) {
    /* nothing kept */
  }
}

/** what still keeps 請 Loop 分析 grey */
function missing() {
  const out = [];
  const n = S.f.description.trim().length;
  if (n < MIN_DESC) out.push(n ? `描述還差 ${MIN_DESC - n} 個字` : '先寫描述');
  if (!currentRepo()) out.push(S.link && !S.link.res.repo ? '先匯入這個 repo' : '先選 repo');
  return out;
}

function grow() {
  const ta = $('t-desc');
  if (!ta.offsetParent) return; // folded away: measured when it opens
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.max(240, Math.round(window.innerHeight * 0.6)))}px`;
}

/** a ticket's own title and description into the form (unless the engineer is editing them) */
function loadForm() {
  if (!S.t) return;
  S.f.title = S.t.title;
  S.f.description = S.t.description;
  $('t-title').value = S.f.title;
  $('t-desc').value = S.f.description;
  grow();
}

// ---- screenshots: Ctrl+V, drag & drop, the picker; shrunk to 1600 px like the chat --------------
const decodedBytes = (url) => Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);
function shrink(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const ht = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = ht;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, ht);
      ctx.drawImage(img, 0, 0, w, ht);
      let url = canvas.toDataURL('image/png');
      if (url.length > 3_000_000) url = canvas.toDataURL('image/jpeg', 0.9);
      if (url.length > 3_000_000) url = canvas.toDataURL('image/jpeg', 0.75);
      if (decodedBytes(url) > MAX_IMAGE_BYTES) reject(new Error('這張圖縮小後還是超過 4 MB'));
      else resolve(url);
    };
    img.onerror = () => reject(new Error('無法讀取這張圖片'));
    img.src = src;
  });
}
let imageQueue = Promise.resolve(); // one at a time, so the 6-image cap holds
function addImages(files) {
  imageQueue = imageQueue.then(async () => {
    for (const file of files) {
      if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        toast('只收 PNG、JPEG、WebP、GIF 圖片', 'bad');
        continue;
      }
      if (S.f.images.length >= MAX_IMAGES) {
        toast(`最多 ${MAX_IMAGES} 張截圖`, 'bad');
        break;
      }
      const src = URL.createObjectURL(file);
      try {
        S.f.images.push({ url: await shrink(src), name: file.name || '截圖' });
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        URL.revokeObjectURL(src);
      }
      paintThumbs();
      paintProps();
    }
  });
  return imageQueue;
}
/** an issue's attachments (data URLs from resolve-link) join the screenshots */
function addIssueImages(list) {
  imageQueue = imageQueue.then(async () => {
    for (const im of list) {
      if (S.f.images.length >= MAX_IMAGES) break;
      if (!im || !/^data:image\//.test(String(im.data_url))) continue;
      try {
        S.f.images.push({ url: await shrink(im.data_url), name: im.name || 'issue 附件' });
      } catch (e) {
        /* an attachment that is not a readable image */
      }
      paintThumbs();
      paintProps();
    }
  });
}
function removeImage(i) {
  S.f.images.splice(i, 1);
  paintThumbs();
  paintProps();
}

// ---- pasted links: an issue fills the ticket and fixes the repo; a repo link picks the repo ------
const URL_RE = /(?:https?|ssh):\/\/[^\s<>"'`，。；、）」』】]+|\bgit@[\w.-]+:[\w./-]+/gi;
function urlsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?)\]}>]+$/, '');
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= 3) break;
  }
  return out;
}
async function scanLinks() {
  if (!isNew()) return;
  const urls = urlsIn(S.f.description).filter((u) => !dismissed.has(u));
  const todo = urls.filter((u) => !resolved.has(u));
  if (todo.length) {
    S.linkBusy = true;
    paintLinks();
    await Promise.all(
      todo.map(async (u) => {
        try {
          resolved.set(u, await tickets.resolveLink(u));
        } catch (err) {
          resolved.set(u, { kind: null, error: errText(err) });
        }
      }),
    );
    S.linkBusy = false;
  }
  if (!isNew()) return; // sent while the link was being read
  pickLink(urlsIn(S.f.description).filter((u) => !dismissed.has(u)));
  paintLinks();
  paintImport();
  paintProps();
  paintFoot();
}
function pickLink(urls) {
  const found = urls.map((url) => ({ url, res: resolved.get(url) })).filter((x) => x.res && x.res.kind);
  const best = found.find((x) => x.res.kind === 'issue') || found.find((x) => x.res.kind === 'repo' || x.res.kind === 'pr') || null;
  if (!best) {
    S.link = null;
    return;
  }
  if (S.link && S.link.url === best.url && S.link.res === best.res) return;
  S.link = best;
  const r = best.res;
  const known = r.repo && repoById(r.repo.id);
  if (known) {
    S.f.repo_id = known.id;
    S.f.branch = known.default_branch;
  } else if (!r.repo) {
    S.f.repo_id = ''; // not imported yet: the select says （未匯入） and the import card offers it
  }
  if (r.kind === 'issue' && r.issue && !prefilled.has(best.url)) {
    prefilled.add(best.url);
    if (!S.f.title.trim() && r.issue.title) {
      S.f.title = String(r.issue.title);
      $('t-title').value = S.f.title;
    }
    const body = String(r.issue.body || '').trim();
    if (body) {
      const quoted = body
        .split('\n')
        .map((l) => (l.trim() ? `> ${l}` : '>'))
        .join('\n');
      S.f.description = `${S.f.description.trimEnd()}\n\n${quoted}\n`;
      $('t-desc').value = S.f.description;
      grow();
    }
    addIssueImages(Array.isArray(r.issue.images) ? r.issue.images : []);
  }
  stash();
}
function dropLink() {
  if (!S.link) return;
  dismissed.add(S.link.url);
  S.link = null;
  render();
  stash();
}

/** the Repo page's import dialog (a new tab: this form stays as it is) */
function openImport(url) {
  stash();
  const w = window.open(links.importRepo(url), '_blank');
  if (!w) location.href = links.importRepo(url);
}
/** back from importing: a new repo in the registry gets picked (and a pasted link re-read) */
let returnAt = 0;
async function onReturn() {
  if (S.t || Date.now() - returnAt < 4000) return;
  returnAt = Date.now();
  const before = new Set(S.repos.map((r) => r.id));
  try {
    S.repos = await registry.repos();
  } catch (e) {
    return;
  }
  const added = S.repos.filter((r) => !before.has(r.id));
  if (!added.length || S.t) return;
  if (S.link && !S.link.res.repo) {
    resolved.delete(S.link.url);
    S.link = null;
    await scanLinks();
  } else if (!S.f.repo_id && added.length === 1) {
    S.f.repo_id = added[0].id;
    S.f.branch = added[0].default_branch;
  }
  render();
  toast(`已匯入 ${added.map(repoLabel).join('、')}`);
}

// ---- actions --------------------------------------------------------------------------------------
/** run one write; the ticket it returns becomes the page. o.ok: toast text (or a function of it) */
async function act(run, o = {}) {
  if (S.busy) return null;
  S.busy = true;
  S.footErr = null;
  version++;
  render();
  try {
    const t = await run();
    version++;
    if (t && t.id) setTicket(t, { force: true });
    if (o.ok) toast(typeof o.ok === 'function' ? o.ok(t) : o.ok);
    return t || true;
  } catch (err) {
    if (!(o.onError && o.onError(err))) toast(errText(err), 'bad');
    return null;
  } finally {
    S.busy = false;
    render();
  }
}

function createBody(analyse) {
  const f = S.f;
  const issue = S.link && S.link.res.kind === 'issue' && S.link.res.issue ? S.link.res.issue.html_url || S.link.url : null;
  const body = { description: f.description.trim(), repo_id: f.repo_id, priority: f.priority, model: f.model || '', images: f.images.map((i) => i.url) };
  if (f.title.trim()) body.title = f.title.trim();
  if (f.branch) body.branch = f.branch;
  if (f.kind) body.kind = f.kind;
  if (issue) body.issue_url = issue;
  if (!analyse) body.analyse = false; // 先存草稿: not in the contract yet — keep the draft un-analysed
  return body;
}
/** a ticket's own title / description, when they changed */
function formPatch() {
  const body = {};
  if (S.f.title.trim() !== S.t.title.trim()) body.title = S.f.title.trim();
  if (S.f.description.trim() !== S.t.description.trim()) body.description = S.f.description.trim();
  return body;
}

/** 請 Loop 分析 (analyse) / 先存草稿 */
async function submit(analyse) {
  if (S.t) return submitDraft(analyse);
  const miss = missing();
  if (miss.length) {
    toast(analyse ? miss.join('；') : `存草稿也需要：${miss.join('；')}`, 'bad');
    return null;
  }
  const t = await act(
    async () => {
      await imageQueue; // a screenshot still being shrunk goes with it
      return tickets.create(createBody(analyse));
    },
    { ok: analyse ? '已送出，Loop 開始分析' : '草稿存好了' },
  );
  if (t && t.id) {
    clearStash();
    history.replaceState(null, '', links.ticket(t.id));
  }
  return t;
}
/** the same two buttons on a saved draft */
function submitDraft(analyse) {
  const body = formPatch();
  if (S.f.description.trim().length < MIN_DESC) {
    toast(`描述至少 ${MIN_DESC} 個字`, 'bad');
    return null;
  }
  return act(
    async () => {
      let t = Object.keys(body).length ? await tickets.patch(S.t.id, body) : S.t;
      S.formDirty = false;
      if (analyse && t.analysis_status !== 'pending' && t.analysis_status !== 'running') t = await tickets.analyse(S.t.id);
      return t;
    },
    { ok: analyse ? 'Loop 開始分析' : '草稿存好了' },
  );
}
/** the unfolded form of an analysed ticket: a new description means a new analysis */
function saveForm() {
  const body = formPatch();
  if (!Object.keys(body).length) return null;
  if (body.description !== undefined && body.description.length < MIN_DESC) {
    toast(`描述至少 ${MIN_DESC} 個字`, 'bad');
    return null;
  }
  return act(
    async () => {
      const t = await tickets.patch(S.t.id, body);
      S.formDirty = false;
      S.expanded = false;
      return t;
    },
    { ok: body.description !== undefined ? '已儲存，Loop 重新分析' : '已儲存' },
  );
}
function toggleExpand() {
  if (S.expanded && S.formDirty && !confirm('放棄還沒儲存的修改？')) return;
  S.expanded = !S.expanded;
  if (!S.expanded) {
    S.formDirty = false;
    loadForm();
  }
  paintForm();
  if (S.expanded) {
    grow();
    $('t-desc').focus();
  }
}

function startTicket() {
  return act(() => tickets.start(S.t.id), {
    ok: (t) => (t && t.approval_state === 'awaiting' ? '已送出，等主管核可' : '已排入，Loop 有額度就開始'),
    onError: (err) => {
      if (err.status !== 409) return false;
      S.footErr = { msg: err.message || '還不能開始', reasons: reasonsOf(err) };
      return true;
    },
  });
}
async function cancelTicket() {
  if (!confirm('取消這張問題單？草稿和截圖會一起刪掉。')) return;
  const ok = await act(async () => {
    await tickets.cancel(S.t.id);
    return null;
  });
  if (ok) {
    toast('已取消');
    location.href = links.newTicket();
  }
}
function retry() {
  S.manual = false;
  return act(() => tickets.analyse(S.t.id), { ok: 'Loop 重新分析中' });
}
function goManual() {
  S.manual = true;
  startEdit('causes', false);
  startEdit('repro', false);
  render();
  $('card').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function approve() {
  return act(() => tickets.approve(S.t.id), { ok: '已核可，Loop 有額度就開始' });
}
function rejectStart() {
  const reason = S.reject ? S.reject.text.trim() : '';
  if (!reason) {
    toast('寫一句退回的原因', 'bad');
    return null;
  }
  return act(
    async () => {
      const t = await tickets.reject(S.t.id, reason);
      S.reject = null;
      return t;
    },
    { ok: '已退回' },
  );
}
/** a property of a saved ticket: kind, model, priority, branch */
function patchProps(body) {
  return act(() => tickets.patch(S.t.id, body));
}
function setKind(k) {
  if (S.t) return S.t.kind === k ? null : patchProps({ kind: k });
  S.f.kind = S.f.kind === k ? null : k;
  paintProps();
  stash();
  return null;
}
function setPriority(v) {
  if (S.t) return S.t.priority === v ? null : patchProps({ priority: v });
  S.f.priority = v;
  paintProps();
  stash();
  return null;
}

// ---- the 分析卡's inline edits ------------------------------------------------------------------------
const SECTION = { causes: 'sec-causes', repro: 'sec-repro', cond: 'sec-cond' };
function startEdit(key, focus = true) {
  const a = analysis();
  if (key === 'causes') S.edit.causes = { rows: a.causes.slice(0, MAX_CAUSES).map((c) => ({ ...c })), path: '', why: '' };
  if (key === 'repro') S.edit.repro = { mode: (a.repro && a.repro.mode) || 'command', command: (a.repro && a.repro.command) || '', test_file: (a.repro && a.repro.test_file) || '' };
  if (key === 'cond') S.edit.cond = { model: S.t.model || '', priority: S.t.priority };
  if (!focus) return;
  paintCard();
  const first = $(SECTION[key]).querySelector('input, select, textarea');
  if (first) first.focus();
}
function stopEdit(key) {
  S.edit[key] = null;
  paintCard();
}
/** save one section: only its own key goes up */
function saveSection(key, body) {
  return act(async () => {
    const t = await tickets.patch(S.t.id, body);
    S.edit[key] = null;
    return t;
  }, { ok: '已儲存' });
}
function saveCauses() {
  return saveSection('causes', { causes: S.edit.causes.rows });
}
function saveRepro() {
  const e = S.edit.repro;
  if (e.mode === 'command' && !e.command.trim()) {
    toast('先填重現指令', 'bad');
    return null;
  }
  const prev = analysis().repro;
  return saveSection('repro', {
    repro: {
      mode: e.mode,
      command: e.mode === 'command' ? e.command.trim() : null,
      test_file: e.mode === 'new_test' ? e.test_file.trim() || null : null,
      description: prev && prev.mode === e.mode ? prev.description || '' : '',
    },
  });
}
function saveCond() {
  const e = S.edit.cond;
  return saveSection('cond', { model: e.model, priority: e.priority });
}
/** an optional check ticked or not: the unticked ones go up as checks_off (a refusal repaints the box back) */
function toggleCheck(c, on) {
  const off = analysis()
    .checks.filter((x) => !x.required && (x.id === c.id ? !on : !x.on))
    .map((x) => x.id);
  return act(() => tickets.patch(S.t.id, { checks_off: off }));
}
function sendAnswer(i) {
  const text = S.answer ? S.answer.text.trim() : '';
  if (!text) {
    toast('先寫下答案', 'bad');
    return null;
  }
  // index-aligned with analysis.questions; the ones not answered go up empty
  const answers = analysis().questions.map((_, j) => (j === i ? text : ''));
  return act(
    async () => {
      const t = await tickets.patch(S.t.id, { answers });
      S.answer = null;
      return t;
    },
    { ok: '收到，Loop 重新分析' },
  );
}

// ---- the ticket, and keeping it fresh -------------------------------------------------------------
function setTicket(t, o = {}) {
  const prev = S.t ? phaseOf(S.t) : null;
  const json = JSON.stringify(t);
  const changed = json !== S.tJson;
  S.t = t;
  S.tJson = json;
  const ph = phaseOf(t);
  if (!S.formDirty) loadForm();
  if (prev === 'analysing' && ph !== 'analysing') {
    S.expanded = false;
    if (ph === 'ready') toast('分析好了，看一下分析卡');
    else if (ph === 'failed') toast('分析沒有完成', 'bad');
  }
  // a failed analysis the engineer already filled in by hand opens as such
  if (ph === 'failed' && !S.manual && t.analysis && (t.analysis.causes.length || t.analysis.repro)) S.manual = true;
  if (ph !== 'failed') S.manual = false;
  if (changed || o.force) render();
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!S.t) return;
  const ph = phase();
  const ms = ph === 'analysing' ? POLL_MS : ph === 'awaiting' || ph === 'queued' || ph === 'running' ? SLOW_POLL_MS : 0;
  if (!ms) return;
  const id = S.t.id;
  pollTimer = setTimeout(async () => {
    const v = version;
    try {
      const t = await tickets.get(id);
      if (v === version && !S.busy && S.t && S.t.id === id) setTicket(t);
      else schedulePoll();
    } catch (err) {
      if (err.status === 404) showPageErr('這張問題單已經取消了。');
      else schedulePoll();
    }
  }, ms);
}

// ---- painting -------------------------------------------------------------------------------------------
function render() {
  paintTop();
  paintForm();
  paintProps();
  paintProgress();
  paintFailed();
  paintBanner();
  paintCard();
  paintFoot();
  if (S.t) $('recent').hidden = true;
}

function paintTop() {
  const t = S.t;
  const ph = phase();
  const title = t ? t.title || (ph === 'analysing' ? '（Loop 取名中…）' : '（未命名）') : '新問題單';
  $('title').textContent = title;
  document.title = `${title} · 問題單 · Loop Engineering`;
  const [label, tone] = PHASES[ph];
  const pill = $('status-pill');
  pill.textContent = label;
  pill.dataset.tone = tone;
  pill.hidden = false;
  $('back-sm').hidden = !t;
}

function paintForm() {
  const t = S.t;
  const ph = phase();
  const folded = Boolean(t) && ph !== 'draft';
  $('summary').hidden = !folded;
  $('form-card').hidden = folded && !S.expanded;
  if (folded) paintSummary();
  const editable = isNew() || (OPEN.has(ph) && !S.busy);
  $('t-title').readOnly = !editable;
  $('t-desc').readOnly = !editable;
  // screenshots go up with the first send (the contract has no image PATCH)
  $('drop').hidden = !isNew();
  $('shots-field').hidden = Boolean(t) && !t.images.length;
  paintThumbs();
  paintLinks();
  paintImport();
  paintFormFoot();
}

function paintSummary() {
  const t = S.t;
  const bits = [t.images.length ? `${t.images.length} 張截圖` : null, t.repo ? `${repoLabel(t.repo)} @ ${t.branch}` : null, t.issue ? `來源 Gitea issue #${t.issue.number}` : null].filter(Boolean);
  const first = t.description.split('\n').find((l) => l.trim()) || '（沒有描述）';
  fill(
    $('summary'),
    h('b', null, '描述'),
    h('span.fx-sum-text', { title: t.description || null }, first),
    bits.length ? h('span.fx-sum-meta', null, `· ${bits.join(' · ')}`) : null,
    h('button.btn', { type: 'button', 'aria-expanded': String(S.expanded), 'aria-controls': 'form-card', onclick: toggleExpand }, S.expanded ? '收起' : '展開'),
  );
}

/** 儲存 / 收起 under an analysed ticket's unfolded form */
function paintFormFoot() {
  const foot = $('form-foot');
  const t = S.t;
  const show = Boolean(t) && phase() !== 'draft' && S.expanded;
  foot.hidden = !show;
  if (!show) return;
  const editable = OPEN.has(phase());
  const newDesc = S.f.description.trim() !== t.description.trim();
  const changed = newDesc || S.f.title.trim() !== t.title.trim();
  fill(
    foot,
    editable ? h('button.btn.primary', { type: 'button', disabled: S.busy || !changed, onclick: saveForm }, newDesc ? '儲存並重新分析' : '儲存') : null,
    h('button.btn', { type: 'button', onclick: toggleExpand }, '收起'),
    editable && newDesc ? h('span.fx-note', null, '改了描述，Loop 會重新分析一次') : null,
  );
}

function paintThumbs() {
  const t = S.t;
  const items = t ? t.images.map((im) => ({ url: tickets.imageUrl(t.id, im.n), name: im.name, text: im.text || im.note })) : S.f.images;
  const box = $('thumbs');
  box.hidden = !items.length;
  fill(
    box,
    items.map((it, i) =>
      h(
        'div.fx-thumb',
        { title: it.text || it.name || null },
        h('img', { src: it.url, alt: it.name || `截圖 ${i + 1}` }),
        t ? null : h('button.fx-thumb-x', { type: 'button', 'aria-label': `移除${it.name ? `「${it.name}」` : '這張截圖'}`, onclick: () => removeImage(i) }, icon('x', { sw: 2.4 })),
      ),
    ),
  );
  const n = S.f.images.length;
  $('drop-title').textContent = n ? `再加截圖（${n}/${MAX_IMAGES}）` : '貼上或拖進截圖';
  $('drop').disabled = n >= MAX_IMAGES;
}

function paintLinks() {
  const row = $('link-row');
  const kids = [];
  if (isNew() && S.link) {
    const r = S.link.res;
    const issue = r.kind === 'issue' && r.issue ? r.issue : null;
    const label = issue ? `issue #${issue.number} · ${issue.title}` : `${r.kind === 'pr' ? 'PR' : 'repo'} ${r.owner}/${r.repo_name}`;
    kids.push(
      h(
        'span.fx-chip-link',
        null,
        icon('link', { sw: 2 }),
        issue && issue.html_url ? h('a', { href: issue.html_url, target: '_blank', rel: 'noopener', title: label }, label) : h('span', { title: label }, label),
        h('button.fx-chip-x', { type: 'button', 'aria-label': '不用這個連結', title: '不用這個連結', onclick: dropLink }, icon('x', { sw: 2.4 })),
      ),
    );
    if (r.error) kids.push(h('span.fx-note.warn', null, r.error));
  }
  if (isNew() && S.linkBusy) kids.push(h('span.fx-note', null, '偵測連結中…'));
  row.hidden = !kids.length;
  if (kids.length) fill(row, h('span.fx-lbl', null, '偵測到連結'), kids);
}

function paintImport() {
  const r = isNew() && S.link ? S.link.res : null;
  const show = Boolean(r && !r.repo && r.remote_url);
  const card = $('import-card');
  card.hidden = !show;
  if (!show) return;
  const name = r.owner && r.repo_name ? `${r.owner}/${r.repo_name}` : r.remote_url;
  fill(
    card,
    icon('info', { sw: 2 }),
    h('span.fx-import-t', null, '這個 repo 還沒匯入 Loop。匯入需要一次（約 1 分鐘）。'),
    h('a.btn.primary', { href: links.importRepo(r.remote_url), target: '_blank', onclick: () => stash() }, `匯入 ${name}`),
  );
}

function modelOptions(current) {
  const picked = S.t && !S.t.model && analysis().conditions && analysis().conditions.model;
  const auto = picked && picked.label ? `由 Loop 依領域挑（${picked.label}）` : '由 Loop 依領域挑';
  const ids = (S.models || []).map((m) => `local:${m.id}`);
  return [
    h('option', { value: '' }, auto),
    (S.models || []).map((m) => h('option', { value: `local:${m.id}`, title: m.display_name || null }, `${m.id}（本地）`)),
    current && !ids.includes(current) ? h('option', { value: current }, modelName(current)) : null,
  ];
}
function prioritySeg(value, disabled, onPick) {
  return PRIORITIES.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(Number(value) === v), disabled, onclick: () => onPick(v) }, label));
}

function paintProps() {
  const t = S.t;
  const ph = phase();
  const editable = (isNew() || OPEN.has(ph)) && !S.busy;
  const repo = currentRepo();

  // Repo: the imported ones, and a way to import another
  const pending = isNew() && S.link && !S.link.res.repo && S.link.res.remote_url ? S.link.res : null;
  const list = S.repos.filter((r) => r.enabled === undefined || Number(r.enabled) !== 0);
  if (repo && !list.some((r) => r.id === repo.id)) list.push(repo);
  const sel = $('p-repo');
  fill(
    sel,
    h('option', { value: '' }, pending ? '（未匯入）' : list.length ? '（選一個 repo）' : '（還沒有 repo）'),
    list.map((r) => h('option', { value: r.id }, repoLabel(r))),
    isNew() ? h('option', { value: IMPORT }, '＋ 匯入 Repo…') : null,
  );
  sel.value = repo ? repo.id : '';
  const locked = isNew() && S.link && S.link.res.kind === 'issue';
  sel.disabled = !isNew() || locked || S.busy;
  const note = pending ? `偵測到 ${pending.owner}/${pending.repo_name}，匯入後會自動選上` : locked && repo ? '由 issue 決定（拿掉連結才能換）' : '';
  $('p-repo-note').textContent = note;
  $('p-repo-note').hidden = !note;

  // 分支: the repo's default (and PR target), or any other by name
  const branch = t ? t.branch : S.f.branch;
  const names = uniq([branch, repo && repo.default_branch, repo && repo.pr_base]);
  const bsel = $('p-branch');
  fill(bsel, names.length ? names.map((b) => h('option', { value: b }, b)) : h('option', { value: '' }, '—'), repo && editable ? h('option', { value: OTHER }, '其他分支…') : null);
  bsel.value = branch || (repo && repo.default_branch) || '';
  bsel.disabled = !repo || !editable;

  // 類型
  const kind = t ? t.kind : S.f.kind;
  fill($('p-kind'), KINDS.map(([k, label]) => h('button.fx-chip', { type: 'button', 'aria-pressed': String(kind === k), disabled: !editable, onclick: () => setKind(k) }, label)));
  $('p-kind-note').hidden = Boolean(t && t.analysis_status === 'ready');

  paintMachine(repo);

  // 模型: only when there are local models to offer
  $('p-model-row').hidden = !S.models;
  if (S.models) {
    const cur = t ? t.model : S.f.model;
    const msel = $('p-model');
    fill(msel, modelOptions(cur));
    msel.value = cur || '';
    msel.disabled = !editable;
  }

  const priority = t ? t.priority : S.f.priority;
  fill($('p-priority'), prioritySeg(priority, !editable, setPriority));
  paintSource();
  paintShots();

  const pl = (PRIORITIES.find(([v]) => v === Number(priority)) || PRIORITIES[1])[1];
  $('props-sum').textContent = [repo ? repoLabel(repo) : '還沒選 repo', repo ? branch || repo.default_branch : null, `優先 ${pl}`].filter(Boolean).join(' · ');
  paintPropsOpen();
}

function paintMachine(repo) {
  const box = $('p-machine');
  if (!repo) {
    fill(box, h('span.fx-dot'), h('span.fx-note', null, '依 repo 設定'));
    return;
  }
  const cond = S.t && S.t.analysis && S.t.analysis.conditions;
  const cm = cond ? cond.machine : null;
  const name = cond ? (cm ? cm.name : null) : repo.machine || null;
  const m = name ? machineOf(name) : null;
  let ok = 'host';
  if (name) ok = cm && cm.ok != null ? String(Boolean(cm.ok)) : m && m.last_check_ok != null ? String(Boolean(Number(m.last_check_ok))) : 'null';
  fill(
    box,
    h('span.fx-dot', { dataset: { ok }, title: ok === 'false' ? '上次檢查連不上' : ok === 'true' ? '上次檢查正常' : null }),
    h('span', null, machineText(name, cm && cm.os)),
    h('a.fx-side-link', { href: links.repoChecks(repo.id) }, '改檢查'),
  );
}

function paintSource() {
  const box = $('p-source');
  const t = S.t;
  let issue = null;
  if (t && t.issue) issue = { number: t.issue.number, url: t.issue.url, title: '' };
  else if (!t && S.link && S.link.res.kind === 'issue' && S.link.res.issue) issue = { number: S.link.res.issue.number, url: S.link.res.issue.html_url, title: S.link.res.issue.title };
  if (issue) {
    fill(box, h('a', { href: issue.url || null, target: '_blank', rel: 'noopener' }, `Gitea issue #${issue.number}${issue.title ? ` · ${issue.title}` : ''}`));
    return;
  }
  if (t && t.source_ref) {
    fill(box, h('span', null, /^chat[:/]/.test(t.source_ref) ? '對話' : t.source_ref));
    return;
  }
  fill(box, h('span.fx-note', null, t ? '直接開單' : '— 貼 issue 連結會自動帶入'));
}

function visionNote(images) {
  const count = (v) => images.filter((im) => im.via === v).length;
  const model = count('model');
  const ocr = count('ocr');
  if (!model && !ocr) return images.some((im) => im.via === 'none') ? '截圖未辨識' : '還沒辨識';
  return `已辨識：${model + ocr} 張（${[model ? `模型看圖 ${model}` : null, ocr ? `文字辨識 ${ocr}` : null].filter(Boolean).join('、')}）`;
}
function paintShots() {
  const box = $('p-shots');
  const t = S.t;
  if (!t) {
    fill(box, h('span.fx-note', null, S.f.images.length ? `${S.f.images.length} 張，送出後 Loop 會先看圖` : '還沒有'));
    return;
  }
  if (!t.images.length) {
    fill(box, h('span.fx-note', null, '沒有'));
    return;
  }
  fill(
    box,
    h(
      'div.fx-mini',
      null,
      t.images.map((im, i) => {
        const url = tickets.imageUrl(t.id, im.n);
        return h('a', { href: url, target: '_blank', rel: 'noopener', title: im.text || im.note || im.name || null }, h('img', { src: url, alt: im.name || `截圖 ${i + 1}` }));
      }),
    ),
    h('span.fx-note', null, visionNote(t.images)),
  );
}

// phone: 屬性 sits under the description, folded to one line
function placeProps() {
  if (PHONE.matches) $('form-card').after($('props'));
  else $('fix-cols').appendChild($('props'));
  paintPropsOpen();
}
const propsOpen = () => !PHONE.matches || (S.propsOpen != null ? S.propsOpen : isNew() && !currentRepo());
function paintPropsOpen() {
  const open = propsOpen();
  $('props').classList.toggle('collapsed', !open);
  $('props-toggle').setAttribute('aria-expanded', String(open));
}

const stepRow = (s) => {
  const [glyph, word] = STEP[s.state] || STEP.todo;
  return h('li', { dataset: { state: STEP[s.state] ? s.state : 'todo' } }, h('span.fx-glyph', { role: 'img', 'aria-label': word }, glyph), h('span.fx-step-l', null, s.label || s.key || ''), s.detail ? h('span.fx-step-d', null, s.detail) : null);
};

function paintProgress() {
  const card = $('progress-card');
  card.hidden = phase() !== 'analysing';
  if (card.hidden) return;
  const steps = analysis().steps;
  fill(
    card,
    h('div.fx-sec-h', null, h('h3', null, 'Loop 正在分析'), h('span.fx-sub', null, '約 30 秒到 2 分鐘 · 每 3 秒更新')),
    steps.length ? h('ol.fx-steps', null, steps.map(stepRow)) : h('p.fx-muted', null, '排隊中，馬上開始…'),
  );
}

function paintFailed() {
  const card = $('failed-card');
  card.hidden = !(phase() === 'failed' && !S.manual);
  if (card.hidden) return;
  const a = analysis();
  fill(
    card,
    h('div.fx-sec-h', null, icon('bang', { sw: 2.4 }), h('h3', null, '分析沒有完成')),
    h('p.fx-fail-msg', null, a.error || '分析中途停了，沒有留下原因。'),
    a.steps.length ? h('ol.fx-steps', null, a.steps.map(stepRow)) : null,
    h('div.fx-row', null, h('button.btn.primary', { type: 'button', disabled: S.busy, onclick: retry }, icon('retry'), '重試'), h('button.btn', { type: 'button', disabled: S.busy, onclick: goManual }, '改成手動填寫')),
  );
}

function paintBanner() {
  const b = $('approval-banner');
  const ph = phase();
  b.hidden = ph !== 'awaiting' && ph !== 'rejected';
  if (b.hidden) return;
  const t = S.t;
  b.dataset.tone = ph === 'rejected' ? 'warn' : 'info';
  if (ph === 'rejected') {
    fill(b, h('div.fx-banner-row', null, icon('bang', { sw: 2.4 }), h('div.fx-banner-text', null, h('b', null, '主管退回了這張單'), h('span', null, '原因寫在下面「Loop 還不確定」；回答或改好之後再送出核可。'))));
    return;
  }
  const row = h(
    'div.fx-banner-row',
    null,
    icon('clock'),
    h('div.fx-banner-text', null, h('b', null, '已送出，等主管核可後才會開始'), h('span', null, t.can_approve ? '你是主管：看過分析卡再核可。' : 'Loop 會在主管核可後才開始，可以先關掉這頁。')),
    t.can_approve && !S.reject
      ? [
          h('button.btn.primary', { type: 'button', disabled: S.busy, onclick: approve }, '核可'),
          h('button.btn', { type: 'button', disabled: S.busy, onclick: () => ((S.reject = { text: '' }), paintBanner(), $('reject-text').focus()) }, '退回'),
        ]
      : null,
  );
  let form = null;
  if (t.can_approve && S.reject) {
    const ta = h('textarea.fx-in', { id: 'reject-text', rows: 3, 'aria-label': '退回的原因', placeholder: '退回的原因：哪裡要先改、要補什麼（工程師會看到）', oninput: (e) => (S.reject.text = e.target.value) });
    ta.value = S.reject.text;
    form = h('div.fx-q-form', null, ta, h('div.fx-row', null, h('button.btn.primary', { type: 'button', disabled: S.busy, onclick: rejectStart }, '送出退回'), h('button.btn', { type: 'button', onclick: () => ((S.reject = null), paintBanner()) }, '取消')));
  }
  fill(b, row, form);
}

// ---- 分析卡 ------------------------------------------------------------------------------------------------
function paintCard() {
  const t = S.t;
  const ph = phase();
  const show = Boolean(t) && (DECIDED.has(ph) || (ph === 'failed' && S.manual) || (AFTER.has(ph) && Boolean(t.analysis)));
  $('card').hidden = !show;
  if (!show) return;
  paintCardHead();
  paintCauses();
  paintRepro();
  paintChecks();
  paintConditions();
  paintQuestions();
}

function paintCardHead() {
  const t = S.t;
  const a = analysis();
  const kind = KINDS.find(([k]) => k === t.kind);
  const meta =
    phase() === 'failed'
      ? '分析沒有完成，改成手動填寫'
      : [a.took_ms != null ? `分析花了 ${dur(a.took_ms / 1000)}` : null, a.model_used ? `${modelName(a.model_used)}（本地）` : a.took_ms != null ? '只用規則，沒有模型' : null].filter(Boolean).join(' · ');
  fill(
    $('card-head'),
    h('h2', null, '分析卡'),
    kind ? h('span.fx-tag', null, kind[1]) : null,
    t.repo ? h('span.fx-tag.mono', null, `${repoLabel(t.repo)} @ ${t.branch}`) : null,
    meta ? h('span.fx-card-meta', null, meta) : null,
    h('button.fx-link-btn.fx-sm-only', { type: 'button', onclick: openPlan }, '看需求文件'),
  );
}

/** a section's title row, with its 改一下 pencil while the card can still change */
function secHead(title, sub, key, extra) {
  return h(
    'div.fx-sec-h',
    null,
    h('h3', null, title),
    sub ? h('span.fx-sub', null, sub) : null,
    extra || null,
    key && !cardReadOnly() && !S.edit[key] ? h('button.fx-pencil', { type: 'button', title: '改一下', 'aria-label': `改一下：${title}`, disabled: S.busy, onclick: () => startEdit(key) }, icon('pencil', { sw: 1.8 })) : null,
  );
}
function editFoot(key, save) {
  return h('div.fx-edit-foot', null, h('button.btn.primary', { type: 'button', disabled: S.busy, onclick: save }, '儲存'), h('button.btn', { type: 'button', onclick: () => stopEdit(key) }, '取消'));
}

// 1. 可能原因與位置
function causeRow(c, i, e) {
  const ev = (c.evidence || []).slice(0, 3);
  const recent = c.recent || [];
  return h(
    'div.fx-cause',
    null,
    h('span.fx-num', { dataset: { first: String(i === 0) } }, String(i + 1)),
    h(
      'div.fx-cause-b',
      null,
      h('div.fx-cause-f', null, c.symbol ? `${c.file} · ${c.symbol}` : c.file),
      c.why ? h('div', null, c.why) : null,
      ev.map((x) => h('div.fx-ev', null, x && x.line != null ? `第 ${x.line} 行：${x.text}` : String((x && x.text) || x))),
      recent.length ? h('div.fx-cause-r', { title: recent.join('\n') }, `最近修改：${recent[0]}`) : null,
    ),
    e ? h('button.fx-x', { type: 'button', 'aria-label': `拿掉 ${c.file}`, title: '拿掉這一列', onclick: () => (e.rows.splice(i, 1), paintCauses()) }, icon('x', { sw: 2.2 })) : null,
  );
}
/** where a path to add can come from: the files already named, the repo's top dirs and entry points */
function pathHints() {
  const repo = currentRepo();
  const stack = (repo && repo.stack) || {};
  return uniq([...analysis().causes.map((c) => c.file), ...(stack.entry_points || []), ...(stack.dirs || []).map((d) => `${d}/`)]).slice(0, 200);
}
function causeAdder(e) {
  const full = e.rows.length >= MAX_CAUSES;
  const add = () => {
    const path = e.path.trim();
    if (!path || e.rows.length >= MAX_CAUSES) return;
    e.rows.push({ file: path, symbol: null, why: e.why.trim() || '手動加入', evidence: [], recent: [] });
    e.path = '';
    e.why = '';
    paintCauses();
    const input = $('cause-path');
    if (input) input.focus();
  };
  const path = h('input.fx-in.mono', { id: 'cause-path', type: 'text', list: 'cause-paths', autocomplete: 'off', placeholder: 'src/…/file.cpp', 'aria-label': '要加的檔案路徑', value: e.path, disabled: full, oninput: (ev) => (e.path = ev.target.value) });
  path.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      add();
    }
  });
  const why = h('input.fx-in', { type: 'text', autocomplete: 'off', placeholder: '為什麼懷疑它（選填）', 'aria-label': '為什麼懷疑它', value: e.why, disabled: full, oninput: (ev) => (e.why = ev.target.value) });
  return h(
    'div.fx-adder',
    null,
    path,
    why,
    h('button.btn', { type: 'button', disabled: full, onclick: add }, icon('plus'), '加一個檔案'),
    full ? h('span.fx-note', null, `最多 ${MAX_CAUSES} 個`) : null,
    h('datalist', { id: 'cause-paths' }, pathHints().map((p) => h('option', { value: p }))),
  );
}
function paintCauses() {
  const e = S.edit.causes;
  const rows = e ? e.rows : analysis().causes;
  const ro = cardReadOnly();
  const kids = [secHead('可能原因與位置', rows.length ? `${rows.length} 個候選` : null, 'causes')];
  if (!rows.length) kids.push(h('p.fx-muted', null, e ? '一個都還沒有：在下面加一個檔案。' : ro ? '沒有找到可能的位置。' : '還沒有找到可能的位置。按「改一下」自己加一個檔案。'));
  kids.push(h('div.fx-causes', null, rows.slice(0, MAX_CAUSES).map((c, i) => causeRow(c, i, e))));
  if (e) kids.push(causeAdder(e), editFoot('causes', saveCauses));
  fill($('sec-causes'), kids);
}

// 2. 重現方式
function beforeLine(b) {
  if (!b) return h('div.fx-before', { dataset: { tone: 'muted' } }, icon('clock'), h('span', null, '還沒試跑：開工前 Loop 會先跑一次，確定它現在是紅的。'));
  // ok = the command passed; the red light we want is a failure
  const failed = b.exit_code != null ? Number(b.exit_code) !== 0 : !b.ok;
  const how = [b.exit_code != null ? `exit ${b.exit_code}` : null, b.ms != null ? secs(b.ms) : null].filter(Boolean).join('，');
  const line = failed
    ? h('div.fx-before', { dataset: { tone: 'ok' } }, icon('circleCheck', { sw: 2 }), h('span', null, `現在：✗ 失敗${how ? `（${how}）` : ''}— 正確，可以拿來當紅燈`))
    : h('div.fx-before', { dataset: { tone: 'warn' } }, icon('alert', { sw: 2 }), h('span', null, `現在就通過了${how ? `（${how}）` : ''}，可能重現不了`));
  return b.tail ? [line, h('details.fx-tail', null, h('summary', null, '看輸出'), h('pre', null, b.tail))] : line;
}
function reproEditor(e) {
  if (e.mode === 'command') {
    return [
      h('label.fx-lbl', { for: 'repro-cmd' }, '重現指令'),
      h('input.fx-in.mono', { id: 'repro-cmd', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'python -m pytest tests/test_x.py -k case', value: e.command, oninput: (ev) => (e.command = ev.target.value) }),
      h('p.fx-note', null, '修改前必須失敗：開工前 Loop 會先跑一次，確定它現在是紅的；修好之後它必須變綠。'),
    ];
  }
  return [
    h('label.fx-lbl', { for: 'repro-file' }, '測試檔（選填）'),
    h('input.fx-in.mono', { id: 'repro-file', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'tests/test_x.py（留空由 Loop 決定）', value: e.test_file, oninput: (ev) => (e.test_file = ev.target.value) }),
    h('p.fx-note', null, 'Loop 會先寫一個現在會失敗的測試，修好之後它必須通過；它不能靠改測試過關。'),
  ];
}
function paintRepro() {
  const e = S.edit.repro;
  const r = analysis().repro;
  const ro = cardReadOnly();
  const mode = e ? e.mode : r ? r.mode : null;
  const pick = (m) => {
    if (ro) return;
    if (!S.edit.repro) startEdit('repro', false);
    S.edit.repro.mode = m;
    paintRepro();
  };
  const modeBtn = (m, label) => h('button.fx-mode', { type: 'button', 'aria-pressed': String(mode === m), disabled: ro, onclick: () => pick(m) }, label);
  const kids = [secHead('重現方式', null, 'repro'), h('div.fx-modes', { role: 'group', 'aria-label': '重現方式' }, modeBtn('command', '有現成的重現指令'), modeBtn('new_test', '請 Loop 先寫一個會失敗的測試'))];
  if (e) kids.push(...reproEditor(e), editFoot('repro', saveRepro));
  else if (!r) kids.push(h('p.fx-muted', null, ro ? '沒有重現方式。' : '還沒有重現方式。按「改一下」填一個指令，或請 Loop 先寫一個會失敗的測試。'));
  else if (r.mode === 'command') kids.push(h('div.fx-cmd', null, h('code', null, r.command || '（沒有指令）'), h('span.fx-badge.bad', null, '修改前必須失敗')), beforeLine(r.before));
  else kids.push(h('p.fx-muted', null, r.test_file ? `Loop 會先在 ${r.test_file} 新增一個會失敗的測試，修好之後它必須通過。` : 'Loop 會先寫一個會失敗的測試（放在哪個測試檔由 Loop 決定），修好之後它必須通過。'));
  if (!e && r && r.description) kids.push(h('p.fx-muted', null, r.description));
  fill($('sec-repro'), kids);
}

// 3. 驗收清單
function checkRow(c, i) {
  const ro = cardReadOnly();
  const id = `ck-${c.id || i}`;
  const on = Boolean(c.required || c.on);
  const [label, tone] = CHECK_KIND[c.kind] || [c.required ? '必過' : '選用', null];
  const what = c.kind === 'dataset' || !c.command ? (c.rule ? h('span.fx-ck-what', null, c.rule) : null) : h('code.fx-ck-what', { title: c.rule ? `怎麼算過：${c.rule}` : null }, c.command);
  return h(
    'div.fx-check',
    { dataset: { on: String(on) } },
    h('input', { type: 'checkbox', id, checked: on, disabled: Boolean(c.required) || ro || S.busy, onchange: (e) => toggleCheck(c, e.target.checked) }),
    h('label', { for: id }, h('span.fx-ck-badge', { dataset: { tone: tone || '' } }, label), h('span.fx-ck-name', null, c.name), what, h('span.fx-ck-where', null, machineText(c.machine))),
  );
}
function paintChecks() {
  const t = S.t;
  const checks = analysis().checks;
  const manage = t.repo ? h('a.fx-side-link', { href: links.repoChecks(t.repo.id) }, '管理這個 repo 的檢查') : null;
  const empty = t.analysis ? '這個 repo 還沒有檢查。先加一個建置或測試檢查，之後每張問題單都會跑它。' : '分析沒有完成，所以還沒列出檢查；開始修時會用這個 repo 的必過檢查。';
  fill($('sec-checks'), secHead('驗收清單', '每一項都綠才算修好', null, manage), checks.length ? h('div.fx-checks', null, checks.map(checkRow)) : h('p.fx-muted', null, empty));
}

// 4. 執行條件
const tile = (label, value, sub, lead) => h('div.fx-tile', null, h('span.fx-tile-l', null, label), h('span.fx-tile-v', null, lead || null, value), sub ? h('span.fx-tile-s', null, sub) : null);
function conditionTiles(c) {
  const m = c.machine;
  const machine = m
    ? tile('機台', machineText(m.name, m.os), m.ok == null ? '還沒檢查過' : `上次檢查 ${m.ok ? '✓' : '✗ 連不上'}${m.last_check_at ? ` ${ago(m.last_check_at)}` : ''}`, h('span.fx-dot', { dataset: { ok: m.ok == null ? 'null' : String(Boolean(m.ok)) } }))
    : tile('機台', '引擎主機', '就在這台 Spark 上跑', h('span.fx-dot', { dataset: { ok: 'host' } }));
  const md = c.model;
  const model = tile('模型', (md && (md.label || modelName(md.id))) || (S.t.model ? modelName(S.t.model) : '由 Loop 依領域挑'), (md && md.reason) || null);
  const e = c.estimate;
  const estimate = e ? tile('預估', `規模 ${e.complexity} · 約 ${e.minutes} 分鐘`, e.window || '有額度就開始') : tile('預估', '—', null);
  const l = c.ladder;
  const ladder = l ? tile('修不好時', l.attempts != null ? `最多 ${l.attempts} 次` : '照預設次數', l.next && l.next.length ? `之後換 ${l.next.map(modelName).join('、')} 再試` : '不換模型') : tile('修不好時', '—', null);
  return h('div.fx-tiles', null, machine, model, estimate, ladder);
}
function paintConditions() {
  const e = S.edit.cond;
  const c = analysis().conditions;
  const kids = [secHead('執行條件', null, 'cond')];
  if (e) {
    const rows = [];
    if (S.models) {
      const sel = h('select.fx-in', { id: 'cond-model', onchange: (ev) => (e.model = ev.target.value) }, modelOptions(e.model));
      sel.value = e.model || '';
      rows.push(h('label.fx-lbl', { for: 'cond-model' }, '模型'), sel);
    }
    rows.push(h('span.fx-lbl', null, '優先'), h('div.fx-segs', { role: 'group', 'aria-label': '優先' }, prioritySeg(e.priority, false, (v) => ((e.priority = v), paintConditions()))));
    kids.push(h('div.fx-cond-edit', null, rows), editFoot('cond', saveCond));
  } else if (c) kids.push(conditionTiles(c));
  else kids.push(h('p.fx-muted', null, '分析完成後才會算出機台、預估與修不好時的做法。'));
  fill($('sec-cond'), kids);
}

// 5. Loop 還不確定
function paintQuestions() {
  const sec = $('sec-questions');
  const qs = analysis().questions;
  sec.hidden = !qs.length;
  if (sec.hidden) return;
  const ro = cardReadOnly();
  const row = (q, i) => {
    const open = Boolean(S.answer) && S.answer.i === i;
    const line = h('div.fx-q', null, h('span', null, q), !ro && !open ? h('button.fx-q-btn', { type: 'button', onclick: () => ((S.answer = { i, text: '' }), paintQuestions(), $(`answer-${i}`).focus()) }, '回答') : null);
    if (!open) return line;
    const ta = h('textarea.fx-in', { id: `answer-${i}`, rows: 3, 'aria-label': `回答：${q}`, placeholder: '寫下答案；送出後 Loop 會重新分析', oninput: (e) => (S.answer.text = e.target.value) });
    ta.value = S.answer.text;
    return h('div', null, line, h('div.fx-q-form', null, ta, h('div.fx-row', null, h('button.btn.primary', { type: 'button', disabled: S.busy, onclick: () => sendAnswer(i) }, '送出並重新分析'), h('button.btn', { type: 'button', onclick: () => ((S.answer = null), paintQuestions()) }, '取消'))));
  };
  fill(sec, h('h3', null, 'Loop 還不確定'), qs.map(row));
}

// ---- the footer (on a phone: the fixed action bar) ---------------------------------------------------
function paintFoot() {
  const t = S.t;
  const ph = phase();
  const big = (label, onclick, o = {}) => h(`button.btn.fx-big${o.primary ? '.primary' : ''}`, { type: 'button', onclick, disabled: S.busy || Boolean(o.disabled), title: o.title || null }, label);
  const plan = t ? h('button.fx-link-btn.fx-plan-link', { type: 'button', onclick: openPlan }, '看需求文件') : null;
  let kids;
  if (ph === 'new' || ph === 'draft') {
    const miss = missing();
    kids = [
      big('請 Loop 分析', () => submit(true), { primary: true, disabled: miss.length > 0, title: miss.join('；') || null }),
      big('先存草稿', () => submit(false)),
      ph === 'draft' ? big('刪除草稿', cancelTicket) : null,
      h('span.fx-foot-hint', null, miss.length ? '描述滿 10 字、repo 匯入後，「請 Loop 分析」才會亮' : 'Ctrl+Enter 也能送出'),
    ];
  } else if (ph === 'analysing') {
    kids = [big('取消', cancelTicket), h('span.fx-foot-hint', null, '分析好了，這裡會出現「開始修」')];
  } else if (DECIDED.has(ph) || (ph === 'failed' && S.manual)) {
    kids = [big(startLabel(t), startTicket, { primary: true }), big('取消', cancelTicket), h('span.fx-spacer'), plan];
  } else if (ph === 'failed') {
    kids = [big('取消', cancelTicket)];
  } else if (ph === 'awaiting') {
    kids = [big('取消', cancelTicket), h('span.fx-spacer'), plan];
  } else {
    kids = [h('a.btn.primary.fx-big', { href: links.task(t.id) }, '看進度'), h('span.fx-spacer'), plan];
  }
  if (S.footErr) kids.push(h('div.fx-foot-err', { role: 'alert' }, h('b', null, S.footErr.msg), S.footErr.reasons.length ? h('ul', null, S.footErr.reasons.map((r) => h('li', null, r))) : null));
  fill($('foot'), kids);
}

// ---- 看需求文件 --------------------------------------------------------------------------------------
let planFrom = null;
function openPlan() {
  if (!S.t) return;
  planFrom = document.activeElement;
  $('plan-md').textContent = '讀取中…';
  $('plan-scrim').hidden = false;
  $('plan-drawer').hidden = false;
  $('plan-close').focus();
  tickets
    .plan(S.t.id)
    .then((md) => ($('plan-md').textContent = md || '（還沒有需求文件：分析好了才會有）'))
    .catch((err) => ($('plan-md').textContent = `讀不到需求文件：${errText(err)}`));
}
function closePlan() {
  $('plan-scrim').hidden = true;
  $('plan-drawer').hidden = true;
  if (planFrom && planFrom.focus) planFrom.focus();
}

// ---- 最近的問題單 -------------------------------------------------------------------------------------
async function loadRecent() {
  const sec = $('recent');
  if (S.t) {
    sec.hidden = true;
    return;
  }
  try {
    const list = await tickets.list(20);
    if (S.t) return;
    sec.hidden = false;
    fill(
      $('recent-list'),
      list.length
        ? list.map((x) => {
            const [label, tone] = PHASES[phaseOf(x)];
            const when = x.updated_at || x.created_at;
            return h('a.fx-recent-row', { href: links.ticket(x.id) }, h('span.fx-title', null, x.title || '（未命名）'), x.repo_name ? h('span.fx-recent-repo', null, x.repo_name) : null, h('span.fx-pill.sm', { dataset: { tone } }, label), h('time', { datetime: when || null }, shortTime(when)));
          })
        : h('p.fx-muted.fx-pad', null, '還沒有問題單。寫下第一張，Loop 會先分析再動手。'),
    );
  } catch (err) {
    sec.hidden = err.status === 404; // the ticket routes are not there yet: nothing to say
    if (!sec.hidden) fill($('recent-list'), h('p.fx-muted.fx-pad', null, `讀不到最近的問題單：${errText(err)}`));
  }
}

// ---- wiring -------------------------------------------------------------------------------------------
function edited() {
  if (S.t) {
    S.formDirty = true;
    paintFormFoot();
  } else stashSoon();
  paintFoot();
}
function onPaste(e) {
  if (!isNew()) return;
  const items = [...((e.clipboardData && e.clipboardData.items) || [])];
  const files = items
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return; // text: the field takes it (and the link check runs after)
  if (!items.some((it) => it.kind === 'string' && it.type === 'text/plain')) e.preventDefault();
  addImages(files);
}
function wire() {
  const title = $('t-title');
  const desc = $('t-desc');
  title.addEventListener('input', () => {
    S.f.title = title.value;
    edited();
  });
  desc.addEventListener('input', () => {
    S.f.description = desc.value;
    grow();
    edited();
  });
  desc.addEventListener('paste', () => setTimeout(scanLinks, 0));
  desc.addEventListener('blur', () => scanLinks());
  desc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (isNew() || phase() === 'draft')) {
      e.preventDefault();
      submit(true);
    }
  });
  document.addEventListener('paste', onPaste);

  const card = $('form-card');
  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  card.addEventListener('dragover', (e) => {
    if (!isNew() || !hasFiles(e)) return;
    e.preventDefault();
    card.classList.add('drag');
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('drag');
  });
  card.addEventListener('drop', (e) => {
    card.classList.remove('drag');
    if (!isNew() || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addImages([...e.dataTransfer.files]);
  });
  $('drop').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    addImages([...e.target.files]);
    e.target.value = '';
  });

  $('p-repo').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === IMPORT) {
      e.target.value = S.f.repo_id || '';
      openImport(S.link && !S.link.res.repo ? S.link.res.remote_url : '');
      return;
    }
    const r = repoById(v);
    S.f.repo_id = r ? r.id : '';
    S.f.branch = r ? r.default_branch : '';
    render();
    stash();
  });
  $('p-branch').addEventListener('change', (e) => {
    let v = e.target.value;
    if (v === OTHER) {
      v = (prompt('分支名稱', '') || '').trim();
      if (!v || /\s/.test(v)) {
        paintProps();
        return;
      }
    }
    if (S.t) {
      if (v !== S.t.branch) patchProps({ branch: v });
      return;
    }
    S.f.branch = v;
    paintProps();
    stash();
  });
  $('p-model').addEventListener('change', (e) => {
    if (S.t) {
      patchProps({ model: e.target.value });
      return;
    }
    S.f.model = e.target.value;
    stash();
  });
  $('props-toggle').addEventListener('click', () => {
    if (!PHONE.matches) return;
    S.propsOpen = !propsOpen();
    paintPropsOpen();
  });

  $('plan-close').addEventListener('click', closePlan);
  $('plan-scrim').addEventListener('click', closePlan);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('plan-drawer').hidden) closePlan();
  });

  window.addEventListener('focus', onReturn);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onReturn();
  });
  // 你是 changed: another person's list, and what they may do with this ticket
  document.addEventListener('ops:who', () => {
    if (!S.t) {
      loadRecent();
      return;
    }
    tickets
      .get(S.t.id)
      .then((t) => setTicket(t, { force: true }))
      .catch(() => {});
  });
  // screenshots are not kept like the words are: say so before they are lost
  window.addEventListener('beforeunload', (e) => {
    if (S.t || !S.f.images.length) return;
    e.preventDefault();
    e.returnValue = '';
  });
  PHONE.addEventListener('change', placeProps);
}

/** a blank ticket — or the one this tab was writing, a template, a repo from the link */
function startNew() {
  const kept = unstash();
  if (kept) for (const k of ['title', 'description', 'repo_id', 'branch', 'kind', 'model', 'priority']) if (kept[k] !== undefined && kept[k] !== null) S.f[k] = kept[k];
  const tpl = TEMPLATES[params.get('template') || ''];
  if (tpl) Object.assign(S.f, { description: tpl.description, kind: tpl.kind });
  // from the chat (「轉成問題單」, 轉成任務 → 開問題單): its text, screenshots and repo hint, once
  const handoff = params.get('handoff') ? takeHandoff() : null;
  if (handoff) {
    Object.assign(S.f, { title: '', description: handoff.description, images: handoff.images || [] });
    if (handoff.kind) S.f.kind = handoff.kind;
    const hint = String(handoff.repo_hint || '').replace(/\/+$/, '');
    const hit = hint && S.repos.find((r) => [r.local_path, r.remote_url, r.name].some((x) => x && (x === hint || String(x).replace(/\.git$/, '').endsWith(hint))));
    if (hit) Object.assign(S.f, { repo_id: hit.id, branch: '' });
    history.replaceState(null, '', '/fix.html');
  }
  const want = params.get('repo');
  if (want) {
    if (repoById(want)) Object.assign(S.f, { repo_id: want, branch: '' });
    else toast('網址指定的 repo 不在清單裡（可能還沒匯入好，或停用了）', 'bad');
  }
  const repo = repoById(S.f.repo_id);
  if (!repo) S.f.repo_id = '';
  if (repo && !S.f.branch) S.f.branch = repo.default_branch;
  if (S.f.model && !(S.models || []).some((m) => `local:${m.id}` === S.f.model)) S.f.model = '';
  $('t-title').value = S.f.title;
  $('t-desc').value = S.f.description;
  render();
  grow();
  loadRecent();
  if (urlsIn(S.f.description).length) scanLinks();
}

async function init() {
  wire();
  placeProps();
  const id = params.get('id');
  if (id) {
    // a ticket is on its way: no blank form in the meantime
    $('title').textContent = '載入中…';
    $('status-pill').hidden = true;
    $('form-card').hidden = true;
  }
  const [repos] = await Promise.allSettled([
    registry.repos(),
    registry.machines().then((m) => (S.machines = m)),
    registry.localModels().then((m) => (S.models = m)),
  ]);
  if (repos.status === 'fulfilled') S.repos = repos.value;
  else showPageErr(`讀不到 repo 清單：${errText(repos.reason)}`);
  if (id) {
    try {
      setTicket(await tickets.get(id), { force: true });
      return;
    } catch (err) {
      if (err.status === 404) {
        showPageErr('找不到這張問題單（可能已經取消了）。下面可以開一張新的。');
        history.replaceState(null, '', links.newTicket());
      } else showPageErr(`讀取問題單失敗：${errText(err)}`);
    }
  }
  startNew();
}

init();
