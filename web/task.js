// 驗收頁 / 結果頁 (/task.html?id=): a task's result, its code, 試跑 and what was asked. For a 問題單
// (the bundle has `ticket`) it reads like a PR: the conclusion, Loop 的自評, the checks with their
// logs, the 圖資回歸 viewer, the attempts and a sticky action bar. Any other task renders exactly as
// before — the new sections stay hidden without their data. Rendering is textContent-only.
import { h, fill } from './frame.js';

const { api, el, icon, localTime, toast, withToken, initChrome } = window.Ops;
const $ = (id) => document.getElementById(id);
initChrome();

const id = new URLSearchParams(location.search).get('id') || '';
const STATUS = { draft: '草稿', ready: '就緒', queued: '排隊中', running: '執行中', verifying: '驗證中', blocked: '中斷，會自動續跑', attention: '要你處理', review: '待驗收', failed: '失敗', closed: '已結案' };
const PILL = { review: 'info', closed: 'ok', attention: 'bad', failed: 'bad', blocked: 'warn', running: 'info', verifying: 'info', queued: 'info' };
const OPS = { '>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '>': '>', '<': '<' };
let bundle = null;
let pollTimer = null;

// ---- tabs ----
const TABS = ['result', 'code', 'trial', 'ask'];
function showTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`pane-${t}`).hidden = t !== name;
  }
  if (name === 'code') ensureCode();
  if (name === 'trial') loadTrials();
  history.replaceState(null, '', `${location.pathname}${location.search}#${name}`);
}
for (const t of TABS) $(`tab-${t}`).onclick = () => showTab(t);

// ---- load ----
async function load() {
  if (!id) {
    $('page-err').textContent = '網址少了任務編號（task.html?id=t_…）';
    $('page-err').hidden = false;
    return;
  }
  try {
    bundle = await api(`/api/tasks/${encodeURIComponent(id)}/review`);
    $('page-err').hidden = true;
    render();
  } catch (e) {
    $('page-err').textContent = `讀取失敗：${e.message}`;
    $('page-err').hidden = false;
  }
  clearTimeout(pollTimer);
  if (bundle && bundle.verdict === 'in_progress') pollTimer = setTimeout(load, 5000);
}
document.addEventListener('ops:who', load);

function render() {
  const b = bundle;
  const t = b.task;
  document.title = `${t.title} · 驗收`;
  $('title').textContent = t.title;
  $('title').title = t.title; // the top bar cuts a long title short
  const meta = $('meta');
  meta.replaceChildren();
  if (b.ticket) renderTicketMeta(b);
  const parts = b.ticket ? [] : [
    t.id,
    t.repo_path ? `${t.repo_path.split('/').pop()}${t.base_branch ? ` · ${t.base_branch}` : ''}` : null,
    b.run ? `${b.run.model || t.model || '預設模型'} · 第 ${b.run.attempt} 次${b.run.minutes != null ? ` · ${b.run.minutes} 分鐘` : ''}` : null,
    b.run && b.run.finished_at ? `結束於 ${localTime(b.run.finished_at)}` : null,
  ].filter(Boolean);
  for (const p of parts) meta.appendChild(el('span', null, p));
  const pill = el('span', `pill ${PILL[t.status] || ''}`, STATUS[t.status] || t.status);
  $('status-pill').replaceChildren(pill);

  // verdict
  const v = $('verdict');
  const kind = { passed: 'ok', failed: 'bad', manual: 'manual', in_progress: 'running' }[b.verdict];
  v.className = `verdict ${kind}`;
  v.replaceChildren();
  v.appendChild(icon({ passed: 'circleCheck', failed: 'alert', manual: 'hand', in_progress: 'clock' }[b.verdict]));
  const txt = el('div', 'stack');
  txt.style.gap = '2px';
  txt.appendChild(el('div', 'v-title', b.headline));
  const unchecked = b.checklist.filter((c) => !c.checked).length;
  const sub =
    b.ticket && b.verdict !== 'in_progress' ? ticketSub(b, unchecked)
    : b.verdict === 'in_progress' ? (b.reason || '完成後這一頁會自動更新')
    : b.verdict === 'failed' ? (b.reason || '')
    : [
        t.approved_at ? `已由 ${t.approved_by} 核可` : unchecked ? `還差：人工驗收 ${unchecked} 項` : '人工驗收都勾完了，可以核可',
        b.hosts.length ? `量測機台：${b.hosts.map((h) => (h === 'local' ? '這台 Spark' : h)).join('、')}` : null,
      ].filter(Boolean).join('。');
  if (sub) txt.appendChild(el('div', 'v-sub', sub.length > 400 ? `${sub.slice(0, 400)}…` : sub));
  v.appendChild(txt);
  v.hidden = false;
  // a ticket reads like a PR: the conclusion opens the 結果 tab, one column, actions in a bar
  if (b.ticket && v.parentElement !== $('pane-result')) $('pane-result').prepend(v);
  $('result-cols').classList.toggle('single', !!b.ticket);

  $('tab-code').textContent = b.changed_files ? `程式碼（${b.changed_files.length} 個檔案）` : '程式碼';
  renderMetrics(b);
  renderSteps(b);
  renderLog(b);
  renderArtifacts(b);
  renderChecks(b);
  renderDeliver(b);
  renderTrialControls(b);
  renderAsk(b);
  renderTicket(b);
  if (!$('pane-code').hidden) ensureCode();
  else if (codeLoaded) renderFiles();
}

function renderMetrics(b) {
  const m = b.metrics;
  $('metrics-card').hidden = !(m && m.checks && m.checks.length);
  if ($('metrics-card').hidden) return;
  const table = $('metrics-table');
  table.replaceChildren();
  const head = el('tr');
  for (const h of ['指標', '實際', '門檻', '結果']) head.appendChild(el('th', null, h));
  table.appendChild(head);
  for (const c of m.checks) {
    const tr = el('tr');
    tr.appendChild(el('td', 'num', c.name));
    tr.appendChild(el('td', 'num', c.actual == null ? '沒有回報' : String(c.actual)));
    tr.appendChild(el('td', 'num', `${OPS[c.op] || c.op} ${c.target}`));
    tr.appendChild(el('td', c.pass ? 'good' : 'bad', c.pass ? '達標' : '未達'));
    table.appendChild(tr);
  }
  const extra = Object.entries(m.values || {}).filter(([k]) => !m.checks.some((c) => c.name === k));
  $('metrics-extra').hidden = !extra.length;
  $('metrics-extra').textContent = `另外回報：${extra.map(([k, val]) => `${k} = ${val}`).join('、')}`;
}

function stepRow(s) {
  const d = el('details', 'step');
  if (!s.ok) d.open = true;
  const sum = el('summary');
  sum.appendChild(icon(s.ok ? 'check' : 'x', s.ok ? 'ok-i' : 'bad-i'));
  sum.appendChild(el('span', 'cmd', s.step));
  sum.appendChild(el('span', 'st', s.timedOut ? '逾時' : `exit ${s.exitCode == null ? '?' : s.exitCode}`));
  d.appendChild(sum);
  d.appendChild(el('pre', 'console', (s.tail || s.output || '（沒有輸出）').trim()));
  return d;
}

function renderSteps(b) {
  const box = $('steps');
  box.replaceChildren();
  $('steps-sub').textContent = b.run && b.steps.length ? '點一下看輸出' : '';
  if (!b.steps.length) box.appendChild(el('p', 'empty', b.verdict === 'in_progress' ? '還沒驗證' : '這個任務沒有自動驗證的紀錄'));
  for (const s of b.steps) box.appendChild(stepRow(s));
}

function renderLog(b) {
  $('log-card').hidden = !(b.verdict === 'in_progress' && b.log_tail.length);
  $('log').textContent = b.log_tail.join('\n');
}

function renderArtifacts(b) {
  const box = $('artifacts');
  box.replaceChildren();
  const files = b.artifacts ? b.artifacts.files : [];
  $('artifacts-sub').textContent = files.length ? '驗證通過後收回，附 sha256' : '';
  const zip = $('zip-btn');
  zip.hidden = !files.length;
  zip.href = withToken(`/api/tasks/${encodeURIComponent(id)}/artifacts.zip`);
  if (!files.length) {
    box.appendChild(el('p', 'hint', b.verdict === 'in_progress' ? '驗證通過後會出現在這裡。' : '這個任務沒有收集產出物（驗證方案或 PRD 的「產出物」可以設定要收哪些檔案）。'));
    return;
  }
  for (const f of files) {
    const row = el('div', 'a');
    row.appendChild(el('span', 'path', f.path));
    row.appendChild(el('span', 'muted', `${fmtSize(f.size)} · ${f.from === 'local' ? '這台' : f.from}`));
    const sha = el('code', 'muted', f.sha256.slice(0, 12));
    sha.title = f.sha256;
    row.appendChild(sha);
    const a = el('a', null, '下載');
    a.href = withToken(`/api/tasks/${encodeURIComponent(id)}/artifacts/file?path=${encodeURIComponent(f.path)}`);
    row.appendChild(a);
    box.appendChild(row);
  }
  for (const s of b.artifacts.skipped || []) box.appendChild(el('p', 'hint', `略過：${s}`));
}
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function renderChecks(b) {
  const box = $('checks');
  box.replaceChildren();
  if (!b.checklist.length) {
    box.appendChild(el('p', 'hint', b.verdict === 'in_progress' ? '執行結束後會列出要人工確認的項目。' : '沒有要人工確認的項目。'));
    return;
  }
  b.checklist.forEach((c, index) => {
    const label = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!c.checked;
    cb.disabled = !!b.task.approved_at || b.verdict === 'in_progress';
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const r = await api(`/api/tasks/${encodeURIComponent(id)}/checks`, 'POST', { index, checked: cb.checked });
        bundle.checklist = r.checklist;
        await load();
      } catch (e) {
        cb.checked = !cb.checked;
        toast(`沒有存到：${e.message}`, 'bad');
      } finally {
        cb.disabled = false;
      }
    };
    label.appendChild(cb);
    const t = el('span');
    t.appendChild(el('span', null, c.text));
    t.appendChild(el('span', 'by', c.checked ? `${c.by || '?'} 勾選 · ${localTime(c.at)}` : '尚未確認'));
    label.appendChild(t);
    box.appendChild(label);
  });
}

function actionButton(label, cls, onClick, disabledReason) {
  const b = el('button', `btn big ${cls || ''}`.trim(), label);
  b.type = 'button';
  if (disabledReason) {
    b.disabled = true;
    b.title = disabledReason;
  }
  b.onclick = async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  };
  return b;
}

function renderDeliver(b) {
  const box = $('deliver-body');
  box.replaceChildren();
  const t = b.task;
  if (!t.approved_at) {
    const base = t.base_branch || 'base';
    const label = t.merge_status === 'pending' || t.merge_status === 'conflict' ? `核可並合併到 ${base}` : '核可';
    box.appendChild(actionButton(label, 'primary', approve, b.can.approve ? null : b.can.approve_reason));
    box.appendChild(el('div', 'hint', b.can.approve ? approveHint(b) : b.can.approve_reason || ''));
  } else {
    box.appendChild(el('div', 'pill ok', `已由 ${t.approved_by} 核可 · ${localTime(t.approved_at)}`));
    const grid = el('div', 'grid2');
    const dl = el('a', 'btn big', '下載 zip');
    if (b.artifacts && b.artifacts.files.length) dl.href = withToken(`/api/tasks/${encodeURIComponent(id)}/artifacts.zip`);
    else {
      dl.setAttribute('aria-disabled', 'true');
      dl.title = '沒有收集到產出物';
      dl.style.opacity = '0.55';
    }
    grid.appendChild(dl);
    grid.appendChild(actionButton('發佈到 Gitea', '', openRelease, b.can.release ? null : b.can.release_reason));
    box.appendChild(grid);
    if (!b.can.release && b.can.release_reason) box.appendChild(el('div', 'hint', `發佈：${b.can.release_reason}`));
    if (t.status !== 'closed') box.appendChild(actionButton('結案', '', closeTask, null));
  }
  if (b.can.request_changes && !t.approved_at) box.appendChild(actionButton('退回修改…', 'warn-ghost', openChanges, null));
  const links = el('div', 'stack');
  links.style.gap = '4px';
  const link = (href, text) => {
    if (!/^https?:\/\//i.test(href || '')) return;
    const a = el('a', null, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    links.appendChild(a);
  };
  link(t.pr_url, 'Gitea／GitHub PR ↗');
  link(t.release_url, 'Gitea Release ↗');
  if (links.childNodes.length) box.appendChild(links);
}

/** What 核可 does on this host: where the code goes, and what delivery needs afterwards. */
function approveHint(b) {
  const t = b.task;
  const base = t.base_branch || 'main';
  const merge =
    t.merge_status === 'pending' || t.merge_status === 'conflict'
      ? `核可時會先把最新的 ${base} 併進任務分支並重新驗證，通過才合併。`
      : t.merge_status === 'merged'
        ? `程式碼已經在 ${base}。`
        : b.gitea
          ? '程式碼由 Gitea 的 PR 合併。'
          : '';
  const deliver = b.gitea ? '核可後才能發佈到 Gitea 或下載交付包。' : '核可後可以下載交付包（有收集到產出物時）。';
  return merge + deliver;
}

/** 核可 (and, for a ticket, 合併 — `close_issue` closes its Gitea issue too). */
async function approve(body = {}) {
  const b = bundle;
  if (b && (b.task.merge_status === 'pending' || b.task.merge_status === 'conflict')) {
    toast('合併前重新驗證中，會花一點時間…');
  }
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(id)}/approve`, 'POST', body);
    toast(`已核可：${r.detail}`);
    await load();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
async function closeTask() {
  if (!confirm('結案？結案後這個任務就算完成，串在它後面的工作會開始。')) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/close`, 'POST', {});
    toast('已結案');
    await load();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
function openChanges() {
  $('changes-text').value = '';
  $('changes-dialog').showModal();
}
$('changes-dialog').addEventListener('close', async () => {
  if ($('changes-dialog').returnValue !== 'send') return;
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/request-changes`, 'POST', { feedback: $('changes-text').value });
    toast('已退回，任務回到佇列');
    await load();
  } catch (e) {
    toast(e.message, 'bad');
  }
});
function openRelease() {
  $('release-tag').value = '';
  $('release-dialog').showModal();
}
$('release-dialog').addEventListener('close', async () => {
  if ($('release-dialog').returnValue !== 'send') return;
  toast('發佈中…');
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(id)}/release`, 'POST', { tag: $('release-tag').value });
    toast('已發佈到 Gitea');
    await load();
    if (/^https?:\/\//.test(r.url)) window.open(r.url, '_blank', 'noopener');
  } catch (e) {
    toast(e.message, 'bad');
  }
});

// ---- 程式碼 ----
let codeLoaded = false;
let current = null;
let mode = 'diff';
function ensureCode() {
  if (codeLoaded || !bundle) return;
  codeLoaded = true;
  renderFiles();
}
function renderFiles() {
  const box = $('files');
  box.replaceChildren();
  const files = bundle.changed_files || [];
  $('files-sub').textContent = bundle.code.available ? (files.length ? `這次改了 ${files.length} 個檔案` : '沒有改動的檔案') : '找不到這個任務的程式碼（分支已刪除？）';
  for (const f of files) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(current === f.path));
    b.appendChild(el('span', `tag ${f.status}`, f.status));
    b.appendChild(el('span', 'path', f.old_path ? `${f.old_path} → ${f.path}` : f.path));
    b.onclick = () => openFile(f);
    box.appendChild(b);
  }
  if (!current && files.length) openFile(files[0]);
}
$('view-diff').onclick = () => setMode('diff');
$('view-full').onclick = () => setMode('full');
function setMode(m) {
  mode = m;
  $('view-diff').setAttribute('aria-pressed', String(m === 'diff'));
  $('view-full').setAttribute('aria-pressed', String(m === 'full'));
  const f = (bundle.changed_files || []).find((x) => x.path === current);
  if (f) openFile(f);
}
async function openFile(f) {
  current = f.path;
  for (const b of $('files').querySelectorAll('button')) b.setAttribute('aria-current', String(b.lastChild.textContent.endsWith(f.path)));
  $('viewer-path').textContent = f.path;
  const code = $('code');
  code.replaceChildren(el('p', 'empty', '讀取中…'));
  try {
    if (mode === 'diff') {
      const r = await api(`/api/tasks/${encodeURIComponent(id)}/code/diff?path=${encodeURIComponent(f.path)}`);
      showDiff(r.diff || '');
    } else {
      const side = f.status === 'D' ? 'base' : 'head';
      const r = await api(`/api/tasks/${encodeURIComponent(id)}/code/file?path=${encodeURIComponent(f.path)}&side=${side}`);
      showFile(r);
    }
  } catch (e) {
    code.replaceChildren(el('p', 'err', `讀不到：${e.message}`));
  }
}
function line(no, sign, text, cls) {
  const row = el('div', `ln ${cls || ''}`.trim());
  row.appendChild(el('span', 'no', no));
  row.appendChild(el('span', 'sg', sign));
  row.appendChild(el('span', 'tx', text));
  return row;
}
function showDiff(diff) {
  const code = $('code');
  code.replaceChildren();
  if (!diff.trim()) {
    code.appendChild(el('p', 'empty', '這個檔案沒有文字差異（可能是二進位檔或只改了權限）。'));
    return;
  }
  let oldNo = 0;
  let newNo = 0;
  const frag = document.createDocumentFragment();
  for (const l of diff.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |similarity|rename |new file|deleted file|old mode|new mode)/.test(l)) continue;
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      frag.appendChild(line('…', '', h[3] ? h[3].trim() : '', 'hunk'));
      continue;
    }
    if (l.startsWith('+')) frag.appendChild(line(String(newNo++), '+', l.slice(1), 'add'));
    else if (l.startsWith('-')) frag.appendChild(line(String(oldNo++), '-', l.slice(1), 'del'));
    else if (l.startsWith('\\')) continue;
    else {
      frag.appendChild(line(String(newNo), '', l.slice(1)));
      oldNo++;
      newNo++;
    }
  }
  code.appendChild(frag);
}
function showFile(r) {
  const code = $('code');
  code.replaceChildren();
  if (r.binary) {
    code.appendChild(el('p', 'empty', `二進位檔（${fmtSize(r.size)}），不顯示內容。`));
    return;
  }
  const frag = document.createDocumentFragment();
  (r.text || '').split('\n').forEach((t, i) => frag.appendChild(line(String(i + 1), '', t)));
  code.appendChild(frag);
  if (r.truncated) code.appendChild(el('p', 'hint', '檔案太大，只顯示前 512 KB。'));
}

// ---- 試跑 ----
let datasetsLoaded = false;
function renderTrialControls(b) {
  const denied = !b.can.trial;
  $('trial-denied').hidden = !denied;
  $('trial-denied').textContent = denied ? `不能試跑：${b.can.trial_reason}` : '';
  for (const x of ['trial-verify', 'trial-run', 'trial-dataset']) $(x).disabled = denied;
  $('trial-sub').textContent = b.hosts.length ? `執行機台：${b.hosts.map((h) => (h === 'local' ? '這台 Spark' : h)).join('、')}（沙盒）` : '';
  $('dataset-box').hidden = !(b.plan && b.plan.has_datasets);
  if (b.plan && b.plan.has_datasets && !datasetsLoaded) {
    datasetsLoaded = true;
    api(`/api/verify-plans/${encodeURIComponent(b.plan.id)}/datasets`).then(
      (r) => {
        const sel = $('dataset-select');
        sel.replaceChildren();
        for (const d of r.datasets || []) {
          const o = el('option', null, `${d.name}${d.images != null ? `（${d.images} 張）` : ''}`);
          o.value = d.name;
          sel.appendChild(o);
        }
      },
      (e) => {
        $('dataset-box').replaceChildren(el('span', 'hint', `讀不到圖資清單：${e.message}`));
      },
    );
  }
}
async function startTrial(body) {
  try {
    const t = await api(`/api/tasks/${encodeURIComponent(id)}/trials`, 'POST', body);
    toast('開始試跑…');
    loadTrials();
    pollTrial(t.id);
  } catch (e) {
    toast(e.message, 'bad');
  }
}
$('trial-verify').onclick = () => startTrial({ mode: 'verify' });
$('trial-dataset').onclick = () => startTrial({ mode: 'verify', dataset: $('dataset-select').value });
$('trial-form').onsubmit = (e) => {
  e.preventDefault();
  const c = $('trial-command').value.trim();
  if (c) startTrial({ mode: 'command', command: c });
};
function pollTrial(tid) {
  setTimeout(async () => {
    try {
      const t = await api(`/api/tasks/${encodeURIComponent(id)}/trials/${encodeURIComponent(tid)}`);
      if (t.status === 'running') pollTrial(tid);
      loadTrials();
    } catch (e) {
      /* the list shows what is known */
    }
  }, 1500);
}
async function loadTrials() {
  let r;
  try {
    r = await api(`/api/tasks/${encodeURIComponent(id)}/trials`);
  } catch (e) {
    return;
  }
  const box = $('trials');
  box.replaceChildren();
  if (!r.trials.length) box.appendChild(el('p', 'empty', '還沒有試跑過。試跑的結果只給你看，不會改變任務的驗收結果。'));
  for (const t of r.trials) {
    const card = el('section', 'panel');
    const head = el('div', 'row');
    const title = t.mode === 'command' ? t.command : `重跑驗證${t.dataset ? `（圖資 ${t.dataset}）` : ''}`;
    head.appendChild(el('strong', 'grow', title));
    const last = t.results[t.results.length - 1];
    const state =
      t.status === 'running' ? ['info', '執行中…']
      : t.status === 'error' ? ['bad', '錯誤']
      : last && last.ok && (!t.metrics || t.metrics.pass) ? ['ok', t.metrics && t.metrics.checks.length ? '成功，指標達標' : '成功']
      : ['bad', t.metrics && !t.metrics.pass ? '指標未達' : '失敗'];
    head.appendChild(el('span', `pill ${state[0]}`, state[1]));
    card.appendChild(head);
    card.appendChild(el('div', 'meta', `${t.by} · ${localTime(t.started_at)}${t.finished_at ? ` · ${Math.max(1, Math.round((new Date(t.finished_at) - new Date(t.started_at)) / 1000))} 秒` : ''}`));
    if (t.error) card.appendChild(el('p', 'err', t.error));
    const steps = el('div', 'steps');
    for (const s of t.results) steps.appendChild(stepRow(s));
    card.appendChild(steps);
    if (t.metrics && t.metrics.checks.length) {
      const table = el('table', 'mtable');
      for (const c of t.metrics.checks) {
        const tr = el('tr');
        tr.appendChild(el('td', 'num', c.name));
        tr.appendChild(el('td', 'num', c.actual == null ? '沒有回報' : String(c.actual)));
        tr.appendChild(el('td', 'num', `${OPS[c.op] || c.op} ${c.target}`));
        tr.appendChild(el('td', c.pass ? 'good' : 'bad', c.pass ? '達標' : '未達'));
        table.appendChild(tr);
      }
      card.appendChild(table);
    }
    box.appendChild(card);
  }
}

// ---- 需求 ----
function renderAsk(b) {
  $('goal').textContent = b.task.goal;
  const dl = $('ask-meta');
  dl.replaceChildren();
  const item = (k, v) => {
    if (!v) return;
    const d = el('div');
    d.appendChild(el('dt', 'muted', k));
    d.appendChild(el('dd', null, v));
    d.lastChild.style.margin = '2px 0 0';
    dl.appendChild(d);
  };
  item('驗證方案', b.plan ? `${b.plan.name}${b.plan.host ? `（${b.plan.host === 'local' ? '這台 Spark' : b.plan.host}）` : ''}` : '（沒有使用驗證方案）');
  item('驗收門檻', b.task.acceptance_metrics);
  item('建立時間', localTime(b.task.created_at));
}

// ---- 問題單：結果頁 -------------------------------------------------------------------------------
// The bundle's ticket keys (src/review/result.ts shapes; all empty / null for a task that is not a
// ticket): checks[], dataset[], review, attempts[], issue {number, url}, ticket {repo, repo_id,
// analysis, images[], prd}, escalation {next}.

/** 0.8 s · 41 s · 2 分 08 秒 (the same words as src/review/result.ts fmtMs) */
function fmtMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || ms < 0) return null;
  const s = ms / 1000;
  if (s < 9.95) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  if (whole < 60) return `${whole} s`;
  const m = Math.floor(whole / 60);
  if (m < 60) return `${m} 分 ${String(whole % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(m / 60)} 時 ${String(m % 60).padStart(2, '0')} 分`;
}
const modelName = (m) => String(m || '').replace(/^local:/, '') || '預設模型';
const prNumber = (url) => (/\/pulls?\/(\d+)/.exec(url || '') || [])[1] || null;
const num = (n) => Number(n || 0).toLocaleString('en-US');
const CONF = { high: '高', medium: '中', low: '低' };

/** GET /api/check-runs/:id → the row behind 看紀錄 (output tail, the repro's two sides). The one place it is fetched. */
async function fetchCheckRun(runId) {
  const r = await api(`/api/check-runs/${encodeURIComponent(runId)}`);
  return r.run || r;
}
/** A file a check run pulled back (GET /api/check-runs/:id/files/<path>), as a link an <img> can load. */
function runFileUrl(ref) {
  return withToken(`/api/check-runs/${encodeURIComponent(ref.run_id)}/files/${ref.path.split('/').map(encodeURIComponent).join('/')}`);
}
/** `apply_recipe()` in the self-review becomes <code>, the rest stays text */
function richText(text) {
  return String(text || '')
    .split(/`([^`]+)`/)
    .map((part, i) => (i % 2 ? h('code', null, part) : part));
}
function autoChecks(b) {
  return (b.checks || []).filter((c) => c.state !== 'manual');
}

function renderTicketMeta(b) {
  const t = b.task;
  const meta = $('meta');
  const repo = (b.ticket && b.ticket.repo) || (t.repo_path ? t.repo_path.split('/').pop() : null);
  if (repo) meta.appendChild(h('span.chip-s.mono', null, `${repo} @ ${t.base_branch || 'main'}`));
  const link = (href, text) => {
    if (/^https?:\/\//i.test(href || '')) meta.appendChild(h('a', { href, target: '_blank', rel: 'noopener' }, text));
  };
  if (t.pr_url) link(t.pr_url, prNumber(t.pr_url) ? `PR #${prNumber(t.pr_url)}` : 'PR');
  if (b.issue) link(b.issue.url, `issue #${b.issue.number}`);
  const runs = (b.attempts || []).length || b.runs;
  if (runs) meta.appendChild(h('span', null, `第 ${runs} 次嘗試 · ${modelName((b.run && b.run.model) || t.model)}`));
  if (t.owner) meta.appendChild(h('span', null, `負責：${String(t.owner).replace(/^name:/, '')}`));
  meta.appendChild(h('span.hide-sm', null, t.id));
}

/** The conclusion's second line for a ticket: where the checks ran and for how long, the self-review's confidence. */
function ticketSub(b, unchecked) {
  const t = b.task;
  const auto = autoChecks(b);
  if (b.verdict === 'failed') {
    const bad = auto.find((c) => c.state === 'failed');
    const next = b.escalation && b.escalation.next;
    return [bad ? `${bad.name}：${bad.summary}` : b.reason || '', next ? `可以換 ${modelName(next)} 再試一次` : null].filter(Boolean).join(' · ');
  }
  const ran = auto.filter((c) => c.state === 'passed' || c.state === 'failed');
  const wheres = [...new Set(ran.map((c) => c.where))];
  const total = ran.reduce((n, c) => n + (Number(c.ms) || 0), 0);
  return [
    ran.length && wheres.length ? `檢查在 ${wheres.join('、')} 跑了 ${fmtMs(total) || '—'}` : null,
    b.review && b.review.confidence ? `自評信心 ${CONF[b.review.confidence] || b.review.confidence}` : null,
    t.approved_at ? `已由 ${t.approved_by} 核可` : unchecked ? `還差：人工驗收 ${unchecked} 項` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function renderTicket(b) {
  const ticket = !!b.ticket;
  const checks = b.checks || [];
  renderReview(b);
  renderCheckList(b);
  renderDatasets(b);
  renderAttempts(b);
  renderTicketAsk(b);
  renderActionBar(b);
  if (!ticket) return; // anything else keeps today's layout exactly
  // the checks list replaces the raw step list and the metrics table it was built from
  $('steps-card').hidden = checks.length > 0;
  if (checks.length) $('metrics-card').hidden = true;
  // manual checks sit with the other checks; delivery (download / 發佈 / 結案) after 合併
  if ($('checklist-panel').previousElementSibling !== $('checks-card')) $('checks-card').after($('checklist-panel'));
  $('checklist-panel').hidden = !b.checklist.length;
  $('deliver-panel').hidden = !b.task.approved_at;
  $('deliver').hidden = !b.task.approved_at;
}

// ---- Loop 的自評 ----
function renderReview(b) {
  const card = $('review-card');
  const r = b.review;
  card.hidden = !(r || (b.ticket && b.verdict !== 'in_progress'));
  if (card.hidden) return;
  const body = $('review-body');
  $('review-more').hidden = true;
  if (!r) {
    $('review-sub').textContent = '';
    fill(body, h('p.hint', null, '這次沒有自評。設定裡的「本地自評」開著時，檢查都過之後 Loop 會在這裡寫改了什麼、為什麼、風險。'));
    return;
  }
  $('review-sub').textContent = `${r.model ? `${modelName(r.model)} ` : ''}看了 diff 和檢查結果後寫的，也會放進 PR 內文`;
  const list = (items) => (items && items.length ? h('ul', null, items.map((x) => h('li', null, richText(x)))) : h('span', null, '無'));
  fill(
    body,
    h('span.rv-k', null, '改了什麼'),
    list(r.summary),
    h('span.rv-k.rv-more', null, '為什麼'),
    h('p.rv-more', null, richText(r.why || '—')),
    h('span.rv-k.rv-more', null, '風險'),
    h('div.rv-more', null, list(r.risks)),
    h('span.rv-k.rv-more', null, '範圍外的改動'),
    h('div.rv-more', null, list(r.out_of_scope)),
  );
  // phones show 改了什麼 first; the rest opens on demand
  const more = $('review-more');
  more.hidden = false;
  more.onclick = () => card.classList.toggle('open');
}

// ---- 檢查 ----
const CK_ICON = { passed: ['check', 'ok-i'], failed: ['x', 'bad-i'], running: ['clock', 'run-i'], waiting: ['clock', 'wait-i'], manual: ['hand', 'wait-i'] };
function renderCheckList(b) {
  const checks = b.checks || [];
  $('checks-card').hidden = !checks.length;
  if (!checks.length) return;
  const auto = autoChecks(b);
  const passed = auto.filter((c) => c.state === 'passed').length;
  const ran = auto.filter((c) => c.state === 'passed' || c.state === 'failed');
  const wheres = [...new Set(ran.map((c) => c.where))];
  const total = ran.reduce((n, c) => n + (Number(c.ms) || 0), 0);
  $('checks-sub').textContent = [auto.length ? `${passed} / ${auto.length} 通過` : null, wheres.length ? `在 ${wheres.join('、')}` : null, ran.length ? fmtMs(total) : null].filter(Boolean).join(' · ');
  const manage = $('checks-manage');
  manage.hidden = !(b.ticket && b.ticket.repo_id);
  if (!manage.hidden) manage.href = `/repos.html?id=${encodeURIComponent(b.ticket.repo_id)}#checks`;
  fill(
    $('check-list'),
    checks.map((c) => {
      const [ic, cls] = CK_ICON[c.state] || CK_ICON.waiting;
      const showWhere = c.kind !== 'repro' && c.kind !== 'dataset' && c.kind !== 'manual';
      return h(
        'div.ck',
        { 'data-state': c.state },
        icon(ic, cls),
        h('span.ck-name', null, c.name),
        showWhere ? h('span.ck-where', null, c.where) : null,
        h('span.ck-sum', null, c.summary),
        c.command ? h('code.ck-cmd.hide-sm', null, c.command) : null,
        h('span.grow'),
        c.required ? null : h('span.chip-s', null, '選用'),
        c.cases ? h('button.linkish', { type: 'button', onclick: () => scrollToDataset(c.id) }, '看每張') : null,
        c.run_id || c.tail ? h('button.linkish', { type: 'button', onclick: () => openLog(c) }, '看紀錄') : null,
      );
    }),
  );
}
function scrollToDataset(checkId) {
  const box = document.querySelector(`.ds[data-check="${CSS.escape(checkId)}"]`);
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 看紀錄: the check's output (a 重現 shows both sides) in a drawer. */
async function openLog(c) {
  $('log-title').textContent = `${c.name} 的紀錄`;
  const body = $('log-body');
  const meta = [c.where, fmtMs(c.ms), c.timed_out ? '逾時' : c.exit_code != null ? `exit ${c.exit_code}` : null].filter(Boolean).join(' · ');
  fill(body, h('div.meta', null, meta), h('p.empty', null, '讀取中…'));
  $('log-drawer').showModal();
  if (!c.run_id) {
    fill(body, h('div.meta', null, meta), h('pre.console', null, (c.tail || '（沒有輸出）').trim()));
    return;
  }
  try {
    const run = await fetchCheckRun(c.run_id);
    let side = null;
    try {
      const r = run.result_json ? JSON.parse(run.result_json) : null;
      if (r && (r.before || r.after)) side = r;
    } catch (e) {
      side = null;
    }
    const when = run.started_at ? `開始於 ${localTime(run.started_at)}` : null;
    const parts = [h('div.meta', null, [meta, when].filter(Boolean).join(' · '))];
    if (side) {
      for (const [label, s] of [['修改前（應該失敗）', side.before], ['修改後（應該通過）', side.after]]) {
        if (!s) continue;
        parts.push(h('h4', null, `${label}：${s.ok ? '✓ 通過' : '✗ 失敗'}${s.exit_code != null ? `（exit ${s.exit_code}）` : ''}`));
        parts.push(h('pre.console', null, (s.tail || '（沒有輸出）').trim()));
      }
    }
    parts.push(h('h4', null, side ? '完整輸出' : '輸出（最後 20k 字）'));
    parts.push(h('pre.console', null, (run.output_tail || '（沒有輸出）').trim()));
    fill(body, parts);
  } catch (e) {
    fill(body, h('div.meta', null, meta), h('p.err', null, `讀不到紀錄：${e.message}`), c.tail ? h('pre.console', null, c.tail.trim()) : null);
  }
}
$('log-close').onclick = () => $('log-drawer').close();

// ---- 圖資回歸 ----
const CHANGE = { better: ['ok', '變好'], worse: ['bad', '變差'], missing: ['bad', '沒輸出'] };
const dsState = new Map(); // check id → { onlyChanges, limit }
function changePill(r) {
  if (CHANGE[r.change]) return h(`span.chip-s.${CHANGE[r.change][0]}`, null, CHANGE[r.change][1]);
  return r.ok_after ? h('span.chip-s', null, '相同') : h('span.chip-s.warn', null, '仍不符');
}
function thumb(ref, cls) {
  if (!ref) return h(`span.${cls}.noimg`, null, '沒有圖');
  return h(`img.${cls}`, { src: runFileUrl(ref), alt: '', loading: 'lazy', decoding: 'async' });
}
function valueCell(value, ok, changed, empty = '沒輸出') {
  const text = value == null ? empty : value;
  const cls = !changed ? '' : ok === true ? '.good' : '.bad';
  return h(`td.val${cls}`, null, text);
}
function renderDatasets(b) {
  const views = b.dataset || [];
  $('dataset-card').hidden = !views.length;
  if (!views.length) return;
  fill(
    $('datasets'),
    views.map((v) => {
      const st = dsState.get(v.check_id) || { onlyChanges: v.counts.better + v.counts.worse + v.counts.missing > 0, limit: 200 };
      dsState.set(v.check_id, st);
      const box = h('div.ds', { 'data-check': v.check_id });
      const paint = () => {
        const rows = st.onlyChanges ? v.rows.filter((r) => r.change !== 'same') : v.rows;
        const shown = rows.slice(0, st.limit);
        const c = v.counts;
        const toggle = h('button.fchip', { type: 'button', 'aria-pressed': String(st.onlyChanges) }, '只看變化');
        toggle.onclick = () => {
          st.onlyChanges = !st.onlyChanges;
          st.limit = 200;
          paint();
        };
        const table = h(
          'table.ds-table',
          null,
          h('thead', null, h('tr', null, ['案例', '輸入圖', '期望', '修前', '修後', '結果'].map((x) => h('th', null, x)))),
          h(
            'tbody',
            null,
            shown.map((r) => {
              const changed = r.change !== 'same';
              const tr = h(
                'tr',
                { tabindex: '0' },
                h('td.case', null, h('button.linkish', { type: 'button' }, r.case)),
                h('td.thumb', null, thumb(r.image, 'ds-img')),
                h('td.val', null, r.expected),
                valueCell(r.before, r.ok_before, changed, r.ok_before == null ? '—' : '沒輸出'),
                valueCell(r.after, r.ok_after, changed),
                h('td.vals', null, `期望 ${r.expected} · 修前 ${r.before == null ? '—' : r.before} · 修後 ${r.after == null ? '沒輸出' : r.after}`),
                h('td.res', null, changePill(r)),
              );
              tr.onclick = () => openCase(v, r);
              tr.onkeydown = (e) => {
                if (e.key === 'Enter') openCase(v, r);
              };
              return tr;
            }),
          ),
        );
        fill(
          box,
          h('h2', null, v.name, h('span.sub', null, [v.dataset, v.baseline_sha ? `基準 @ ${v.baseline_sha}` : null, '點案例可看左右對照'].filter(Boolean).join(' · '))),
          h(
            'div.ds-bar',
            null,
            h('span.chip-s', null, `總數 ${num(c.total)}`),
            h('span.chip-s', null, c.correct_before == null ? `正確 ${num(c.correct_after)}` : `正確 ${num(c.correct_before)} → ${num(c.correct_after)}`),
            h('span.chip-s.ok', null, `變好 ${num(c.better)}`),
            h('span.chip-s.bad', null, `變差 ${num(c.worse)}`),
            h('span.chip-s', null, `沒輸出 ${num(c.missing)}`),
            h('span.grow'),
            toggle,
          ),
          shown.length ? h('div.scroll-x', null, table) : h('p.empty', null, st.onlyChanges ? '沒有變化的案例：每一張都和修改前一樣。' : '沒有案例。'),
          rows.length > shown.length
            ? h('button.btn', { type: 'button', onclick: () => ((st.limit += 200), paint()) }, `再顯示 200 筆（還有 ${num(rows.length - shown.length)} 筆）`)
            : null,
          v.truncated ? h('p.hint', null, `案例太多，只列出 ${num(v.rows.length)} 筆（有變化的都在）。`) : null,
        );
      };
      paint();
      return box;
    }),
  );
}

/** One case, before and after side by side. */
function openCase(v, r) {
  $('case-title').textContent = r.case;
  fill($('case-pill'), changePill(r));
  const side = (label, value, ok, ref) =>
    h(
      'div.case-side',
      null,
      h('h4', null, label),
      thumb(ref, 'case-img'),
      h(`div.case-val${ok === true ? '.good' : ok === false ? '.bad' : ''}`, null, value == null ? '沒輸出' : value),
    );
  const input = r.image && !(r.after_image && r.image.path === r.after_image.path && r.image.run_id === r.after_image.run_id) ? r.image : null;
  fill(
    $('case-body'),
    h('div.meta', null, `${v.name}${v.dataset ? ` · ${v.dataset}` : ''} · 期望 ${r.expected}`),
    input ? h('div.case-input', null, h('h4', null, '輸入圖'), thumb(input, 'case-img')) : null,
    h('div.case-cols', null, side('修前', v.before_run_id ? r.before : '（沒有修前的結果）', r.ok_before, r.before_image), side('修後', r.after, r.ok_after, r.after_image)),
    r.note ? h('p.hint', null, r.note) : null,
  );
  $('case-drawer').showModal();
}
$('case-close').onclick = () => $('case-drawer').close();

// ---- 嘗試記錄 ----
function renderAttempts(b) {
  const list = b.attempts || [];
  $('attempts-card').hidden = !list.length;
  if (!list.length) return;
  fill(
    $('attempts'),
    list.map((a) =>
      h(
        'div.at',
        null,
        h('span.at-n', null, `第 ${a.n} 次`),
        h('span.chip-s.mono', null, modelName(a.model)),
        h(`span.at-out${a.ok === true ? '.good' : a.ok === false ? '.bad' : ''}`, null, a.outcome),
        h('span.grow'),
        h('span.muted', null, a.minutes == null ? '' : a.minutes < 1 ? '不到 1 分' : `${a.minutes} 分`),
      ),
    ),
  );
}

// ---- 動作列：合併 · 退回修改 · 交給同事 · 再試一次（換模型） ----
function renderActionBar(b) {
  const t = b.task;
  const bar = $('action-bar');
  bar.hidden = !b.ticket || !!t.approved_at;
  if (bar.hidden) return;
  const red = b.verdict === 'failed';
  const merge = $('act-merge');
  merge.disabled = !b.can.approve;
  merge.title = b.can.approve ? '' : b.can.approve_reason || '';
  merge.classList.toggle('primary', !red);
  merge.classList.toggle('hide-sm', red);
  $('act-changes').disabled = !b.can.request_changes;
  const esc = $('act-escalate');
  const next = b.escalation ? b.escalation.next : null;
  esc.hidden = !(red && b.escalation);
  esc.disabled = !next;
  esc.classList.toggle('primary', red);
  esc.title = next ? `換 ${modelName(next)}，從同一條分支接著修` : '沒有下一個模型';
  const pr = prNumber(t.pr_url);
  $('act-hint').textContent = red
    ? next
      ? `再試一次會換 ${modelName(next)}，從同一條分支接著修`
      : '沒有下一個模型可以換：在設定的「修不好時換模型」加上本地模型'
    : !b.can.approve
      ? b.can.approve_reason || ''
      : pr && b.gitea
        ? `合併走 Gitea PR #${pr}`
        : approveHint(b);
}
$('act-merge').onclick = () => {
  const b = bundle;
  const pr = prNumber(b.task.pr_url);
  $('merge-hint').textContent = `${pr && b.gitea ? `會合併 Gitea 上的 PR #${pr}。` : ''}${approveHint(b)}`;
  $('close-issue-row').hidden = !b.issue;
  if (b.issue) $('close-issue-label').textContent = `在 Gitea 留言並關閉 issue #${b.issue.number}`;
  $('close-issue').checked = true;
  $('merge-dialog').showModal();
};
$('merge-dialog').addEventListener('close', () => {
  if ($('merge-dialog').returnValue !== 'send') return;
  approve(bundle && bundle.issue ? { close_issue: $('close-issue').checked } : {});
});
$('act-changes').onclick = openChanges;
$('act-owner').onclick = () => {
  $('owner-name').value = (bundle && bundle.task.owner) || '';
  $('owner-dialog').showModal();
};
$('owner-dialog').addEventListener('close', async () => {
  if ($('owner-dialog').returnValue !== 'send') return;
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(id)}/owner`, 'POST', { owner: $('owner-name').value });
    toast(r.owner ? `已交給 ${r.owner}` : '不再指定負責人');
    await load();
  } catch (e) {
    toast(e.message, 'bad');
  }
});
$('act-escalate').onclick = async () => {
  const next = bundle && bundle.escalation && bundle.escalation.next;
  if (!next || !confirm(`換 ${modelName(next)} 再試一次？它會從同一條分支接著修，回到佇列排隊。`)) return;
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(id)}/escalate`, 'POST', {});
    toast(`已換 ${modelName(r.model || next)}，回到佇列`);
    await load();
  } catch (e) {
    toast(e.message, 'bad');
  }
};

// ---- 需求：唯讀分析卡、截圖、需求文件 ----
function renderTicketAsk(b) {
  const tk = b.ticket;
  const a = tk && tk.analysis;
  $('analysis-card').hidden = !(a || (tk && tk.prd));
  $('prd-btn').hidden = !(tk && tk.prd);
  if (!$('analysis-card').hidden) {
    $('analysis-sub').textContent = a && a.kind_label ? a.kind_label : '';
    const parts = [];
    if (a && a.summary) parts.push(h('p', null, a.summary));
    if (a && a.causes.length) {
      parts.push(h('h4', null, '可能原因與位置'));
      parts.push(
        h(
          'ul.causes',
          null,
          a.causes.map((c) =>
            h('li', null, h('code', null, c.file), c.why ? ` · ${c.why}` : '', c.evidence || c.line != null ? h('div.muted', null, `${c.line != null ? `第 ${c.line} 行` : ''}${c.evidence ? `：${c.evidence}` : ''}`) : null),
          ),
        ),
      );
    }
    if (a && a.repro && (a.repro.command || a.repro.note)) {
      parts.push(h('h4', null, '重現方式'));
      parts.push(a.repro.command ? h('code.block', null, a.repro.command) : h('p', null, a.repro.note));
    }
    if (a && a.questions.length) {
      parts.push(h('h4', null, 'Loop 還不確定'));
      parts.push(h('ul', null, a.questions.map((q) => h('li', null, q))));
    }
    if (!parts.length) parts.push(h('p.hint', null, '這張單沒有分析卡。'));
    fill($('analysis-body'), parts);
  }
  const imgs = (tk && tk.images) || [];
  $('images-card').hidden = !imgs.length;
  fill(
    $('images'),
    imgs.map((im) => {
      const url = withToken(`/api/tasks/${encodeURIComponent(id)}/images/${encodeURIComponent(im.index)}`);
      return h('figure.shot', null, h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: im.name || '截圖', loading: 'lazy' })), h('figcaption', null, im.text ? `讀到：${im.text}` : im.name || ''));
    }),
  );
}
$('prd-btn').onclick = () => {
  $('prd-text').textContent = (bundle && bundle.ticket && bundle.ticket.prd) || '';
  $('prd-drawer').showModal();
};
$('prd-close').onclick = () => $('prd-drawer').close();

const hash = (location.hash || '').replace('#', '');
showTab(TABS.includes(hash) ? hash : 'result');
load();
