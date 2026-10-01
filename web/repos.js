// Repo page (/repos.html). Without ?id: every imported repo as a card, and the Vercel-style
// import dialog — paste a Gitea URL → watch the job clone and detect → confirm the name, the
// default branch and the machine the checks run on. With ?id=r_…: one repo and its tabs
// 設定 · 檢查 · 圖資 · 過去修法 (?tab= remembers which). textContent-only: every string reaches the
// page through h() / fill() / textContent.
import { $, h, fill, api, toast, icon, modelName, tsMs } from './frame.js';
import { ago, byName, healthOf, healthDot, fillMachineSelect, attachSpecNote, shortRemote, normalizeRepoUrl } from './repo-ui.js';
import { listChecks } from './checks-api.js';
import { mountChecks, mountDatasets } from './checks.js';

const enc = encodeURIComponent;
const LANG = {
  cpp: 'C++', c: 'C', cuda: 'CUDA', csharp: 'C#', fsharp: 'F#', vb: 'VB', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript',
  go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', scala: 'Scala', swift: 'Swift', objc: 'Objective-C', ruby: 'Ruby', php: 'PHP',
  lua: 'Lua', dart: 'Dart', r: 'R', julia: 'Julia', perl: 'Perl', shell: 'Shell', powershell: 'PowerShell', batch: 'Batch', sql: 'SQL',
  html: 'HTML', css: 'CSS', shader: 'Shader', opencl: 'OpenCL',
};
const TABS = ['settings', 'checks', 'datasets', 'fixes'];
const OUTCOME = { merged: ['已合併', 'ok'], returned: ['被退回', 'warn'], abandoned: ['放棄', ''] };
/** the import job's steps as src/repo/import.ts names them, so the ones still to come show as ○ */
const IMPORT_STEPS = ['複製中', '偵測建置與測試指令', '完成'];

const params = new URLSearchParams(location.search);
const repoId = params.get('id');
let machines = new Map(); // name → GET /api/machines row (OS tag, health, 規格)
let engineSpecs = ''; // this Spark's 規格 line (the GPU 沙盒 host 'local'), for 引擎主機 in the pickers

function pageError(msg, link) {
  const box = $('page-err');
  box.hidden = !msg && !link;
  fill(box, msg || '', link || null);
}

async function loadMachines() {
  try {
    const r = await api('/api/machines');
    machines = byName(r.machines);
    const local = (r.sandbox_hosts || []).find((x) => x.name === 'local');
    engineSpecs = local && local.specs_line ? `這台 Spark：${local.specs_line}` : '';
  } catch {
    machines = new Map(); // the pickers still offer the engine host
  }
}

const langText = (stack) =>
  stack && stack.languages && Object.keys(stack.languages).length
    ? Object.entries(stack.languages)
        .slice(0, 4)
        .map(([l, v]) => `${LANG[l] || l} ${Math.round(Number(v) * 100)}%`)
        .join(' · ')
    : null;

/** the dot on a card and in the header: is the place this repo's checks run on usable */
function repoHealth(r) {
  if (!Number(r.enabled)) return { state: 'off', text: '這個 repo 停用了' };
  if (!r.machine) return { state: 'ok', text: '在引擎主機驗證' };
  const m = machines.get(r.machine);
  if (!m) return { state: 'bad', text: `找不到機台 ${r.machine}` };
  const hl = healthOf(m);
  return { state: hl.state, text: `機台 ${r.machine}：${hl.text}${hl.when ? `（${hl.when}檢查）` : ''}` };
}

const sepJoin = (parts) => parts.flatMap((p, i) => (i ? [h('span.rp-sep', { 'aria-hidden': 'true' }, '·'), p] : [p]));

// =============================================================================================
// the list
// =============================================================================================

let listTimer = null;

async function showList() {
  $('view-list').hidden = false;
  $('import-btn').hidden = false;
  let data;
  try {
    [data] = await Promise.all([api('/api/repos'), loadMachines()]);
  } catch (err) {
    pageError(`讀取失敗：${err.message}`);
    return;
  }
  pageError('');
  const repos = data.repos || [];
  const running = data.imports || [];
  // 「3 個必過檢查」: the checks live behind their own routes — a repo whose checks cannot be read just says less
  const counts = await Promise.all(
    repos.map((r) =>
      listChecks(r.id).then(
        (cs) => cs.filter((c) => Number(c.required) && (c.enabled === undefined || Number(c.enabled))).length,
        () => null,
      ),
    ),
  );
  $('list-lead').textContent = repos.length ? `${repos.length} 個 repo · 每個 repo 只要匯入一次，之後的問題單都直接用` : '';
  $('list-lead').hidden = !repos.length;
  fill($('import-running'), running.map(importingCard));
  fill($('repo-list'), repos.map((r, i) => repoCard(r, counts[i])));
  $('repo-empty').hidden = repos.length > 0 || running.length > 0;
  // an import someone left running in the background: keep the list moving until it lands
  clearTimeout(listTimer);
  if (running.length) listTimer = setTimeout(showList, 3000);
}

function repoCard(r, nRequired) {
  const hl = repoHealth(r);
  const meta = [
    nRequired == null ? null : h('span', null, nRequired ? `${nRequired} 個必過檢查` : '還沒有必過檢查'),
    h('span', null, `機台 ${r.machine || '引擎主機'}`),
    r.map_at ? h('span', null, `地圖 ${ago(r.map_at)}`) : null,
    Number(r.enabled) ? null : h('span', null, '已停用'),
  ].filter(Boolean);
  return h(
    'a.rp-card',
    { href: `/repos.html?id=${enc(r.id)}` },
    healthDot(hl.state, hl.text),
    h('span.rp-card-id', null, h('span.nm', null, r.name), h('span.sub', null, r.gitea_owner && r.gitea_repo ? `${r.gitea_owner}/${r.gitea_repo}` : shortRemote(r.remote_url))),
    h('span.chip-s.mono', null, r.default_branch),
    h('span.rp-meta', null, sepJoin(meta)),
    h('span.rp-chev', null, icon('chevR', { size: 18 })),
  );
}

function importingCard(job) {
  const cur = job.steps && job.steps.length ? job.steps[job.steps.length - 1] : null;
  return h(
    'button.rp-card.importing',
    { type: 'button', onclick: () => openImport(job) },
    h('span.rp-spin', null, icon('spin', { size: 18 })),
    h('span.rp-card-id', null, h('span.nm', null, job.name), h('span.sub', null, job.url)),
    h('span.rp-meta', null, `匯入中 · ${cur ? cur.label : '開始'}…`),
    h('span.rp-chev', null, icon('chevR', { size: 18 })),
  );
}

// =============================================================================================
// the import dialog
// =============================================================================================

const imp = { step: 1, job: null, repo: null, timer: null, seq: 0 };

function setImpStep(n, failed = false) {
  imp.step = n;
  for (const st of $('imp-steps').querySelectorAll('.st')) {
    const k = Number(st.dataset.step);
    st.dataset.state = k < n ? 'done' : k === n ? (failed ? 'failed' : 'current') : 'todo';
  }
  $('imp-step1').hidden = n !== 1;
  $('imp-step2').hidden = n !== 2;
  $('imp-step3').hidden = n !== 3;
  const running = n === 2 && !failed;
  $('imp-go').hidden = n !== 1;
  $('imp-bg').hidden = !running;
  $('imp-retry').hidden = !(n === 2 && failed);
  $('imp-done').hidden = n !== 3;
  $('imp-fail').hidden = !failed;
  $('imp-wait-note').hidden = !running;
  impError('');
}

function impError(msg, link) {
  const e = $('imp-err');
  e.hidden = !msg && !link;
  fill(e, msg || '', link || null);
}

function openImport(job) {
  clearTimeout(imp.timer);
  imp.seq++;
  imp.job = job || null;
  imp.repo = null;
  $('imp-url').value = job ? job.url : '';
  $('imp-url-echo').textContent = job ? job.url : '';
  if (!$('import-dialog').open) $('import-dialog').showModal();
  if (job) {
    setImpStep(2);
    paintProgress();
    pollJob(imp.seq);
  } else {
    setImpStep(1);
    $('imp-url').focus();
  }
}

async function startImport() {
  const url = normalizeRepoUrl($('imp-url').value);
  if (!url) return impError('先貼上 repo 的網址');
  $('imp-url').value = url;
  $('imp-go').disabled = true;
  try {
    const { job } = await api('/api/repos/import', 'POST', { url });
    imp.job = job;
    $('imp-url-echo').textContent = job.url;
    setImpStep(2);
    paintProgress();
    pollJob(imp.seq);
  } catch (err) {
    // 「已經匯入過了：cf-aoi（r_…）」 → a way to it
    const known = /[（(](r_[\w-]+)[)）]/.exec(err.message);
    impError(err.message, known ? h('a', { href: `/repos.html?id=${enc(known[1])}`, style: { marginLeft: '8px' } }, '打開它') : null);
  } finally {
    $('imp-go').disabled = false;
  }
}

function paintProgress() {
  const job = imp.job;
  const steps = (job && job.steps) || [];
  const seen = new Set(steps.map((s) => s.label));
  const items = steps.map((s) => {
    const st = s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'run';
    return h(
      'li',
      { 'data-s': st },
      icon(st === 'ok' ? 'okCircle' : st === 'bad' ? 'xCircle' : 'spin', { size: 18, sw: 2 }),
      h('span.tx', null, h('span', null, s.label), s.detail ? h('span.d', null, s.detail) : null),
    );
  });
  if (!job || job.status === 'running') {
    if (!steps.length) items.push(h('li', { 'data-s': 'run' }, icon('spin', { size: 18, sw: 2 }), h('span.tx', null, h('span', null, '開始匯入'))));
    for (const label of IMPORT_STEPS) if (!seen.has(label)) items.push(h('li', { 'data-s': 'todo' }, icon('clock', { size: 18 }), h('span.tx', null, h('span', null, label))));
  }
  fill($('imp-progress'), items);
}

async function pollJob(seq) {
  clearTimeout(imp.timer);
  if (seq !== imp.seq || !$('import-dialog').open || !imp.job) return;
  try {
    const { job } = await api(`/api/repos/import/${enc(imp.job.id)}`);
    if (seq !== imp.seq) return;
    imp.job = job;
  } catch (err) {
    if (err.status === 404) return importFailed('找不到這個匯入工作（引擎可能重新啟動過）。請再匯入一次。');
    imp.timer = setTimeout(() => pollJob(seq), 2000); // a blip: try again
    return;
  }
  paintProgress();
  if (imp.job.status === 'running') imp.timer = setTimeout(() => pollJob(seq), 1000);
  else if (imp.job.status === 'done') await toConfirm(seq);
  else importFailed(imp.job.error || '匯入失敗');
}

function importFailed(msg) {
  setImpStep(2, true);
  $('imp-fail-text').textContent = msg;
  const known = /[（(](r_[\w-]+)[)）]/.exec(msg);
  if (known) impError('', h('a', { href: `/repos.html?id=${enc(known[1])}` }, '打開已經匯入的那一個'));
}

async function toConfirm(seq) {
  let repo;
  try {
    ({ repo } = await api(`/api/repos/${enc(imp.job.repo_id)}`));
  } catch (err) {
    return importFailed(`匯入完成，但讀不到 repo：${err.message}`);
  }
  if (seq !== imp.seq) return;
  imp.repo = repo;
  await loadMachines();
  $('imp-name').value = repo.name;
  $('imp-branch').value = repo.default_branch;
  fillMachineSelect($('imp-machine'), machines, repo.machine);
  attachSpecNote($('imp-machine'), machines, engineSpecs);
  paintDetected(repo);
  setImpStep(3);
  showList(); // the new card is there even if the dialog is cancelled now
}

function paintDetected(repo) {
  const s = repo.stack;
  const bits = ['複製完成'];
  if (s && s.files) bits.push(`${Number(s.files).toLocaleString('zh-TW')} 個檔案`);
  if (repo.map_at) bits.push('已產生 repo 地圖');
  $('imp-detected-sub').textContent = bits.join(' · ');
  const row = (k, v, mono) => [h('span.k', null, k), h(`span.v${v ? (mono ? '.mono' : '') : '.none'}`, null, v || '偵測不到')];
  fill($('imp-detected-kv'), row('語言', langText(s)), row('建置', repo.build_cmd, true), row('測試', repo.test_cmd, true), row('前置', repo.setup_cmd, true));
}

async function finishImport() {
  const repo = imp.repo;
  if (!repo) return;
  const patch = {};
  const name = $('imp-name').value.trim();
  const branch = $('imp-branch').value.trim();
  const machine = $('imp-machine').value || null;
  if (!name) return impError('名稱不能是空的');
  if (!branch) return impError('預設分支不能是空的');
  if (name !== repo.name) patch.name = name;
  if (branch !== repo.default_branch) patch.default_branch = branch;
  if (machine !== (repo.machine || null)) patch.machine = machine;
  $('imp-done').disabled = true;
  try {
    if (Object.keys(patch).length) await api(`/api/repos/${enc(repo.id)}`, 'PATCH', patch);
    $('import-dialog').close();
    toast(`已匯入「${name}」：下一步到它的「檢查」設定每張問題單都要過的檢查`);
    showList();
  } catch (err) {
    impError(err.message);
  } finally {
    $('imp-done').disabled = false;
  }
}

function wireImport() {
  $('import-btn').onclick = () => openImport(null);
  $('empty-import-btn').onclick = () => openImport(null);
  $('imp-close').onclick = () => $('import-dialog').close();
  $('imp-cancel').onclick = () => $('import-dialog').close();
  $('imp-bg').onclick = () => {
    $('import-dialog').close();
    showList();
  };
  $('imp-retry').onclick = () => {
    const url = imp.job ? imp.job.url : $('imp-url').value;
    openImport(null);
    $('imp-url').value = url;
  };
  $('imp-done').onclick = finishImport;
  $('import-form').onsubmit = (e) => {
    e.preventDefault();
    if (imp.step === 1) startImport();
    else if (imp.step === 3) finishImport();
  };
  $('import-dialog').addEventListener('close', () => {
    clearTimeout(imp.timer);
    imp.seq++;
  });
}

// =============================================================================================
// one repo
// =============================================================================================

let cur = null; // the repo row (GET /api/repos/:id)
let settings = {}; // GET /api/settings: the global cloud switch the 設定 tab shows
const mounted = {};

async function showDetail(id) {
  $('view-detail').hidden = false;
  $('crumb').hidden = false;
  $('crumb-sep').hidden = false;
  $('page-title').textContent = '載入中…';
  try {
    const [r] = await Promise.all([
      api(`/api/repos/${enc(id)}`),
      loadMachines(),
      api('/api/settings').then(
        (s) => (settings = s.settings || {}),
        () => (settings = {}),
      ),
    ]);
    cur = r.repo;
  } catch (err) {
    $('page-title').textContent = 'Repo';
    $('view-detail').hidden = true;
    pageError(err.status === 404 ? `找不到這個 repo（${id}），可能已經移除了。` : `讀取失敗：${err.message}`, h('a', { href: '/repos.html', style: { marginLeft: '8px' } }, '回到 Repo 清單'));
    return;
  }
  document.title = `${cur.name} · Repo · Loop Engineering`;
  paintHeader();
  $('repo-tabs').hidden = false;
  for (const b of $('repo-tabs').querySelectorAll('button')) b.onclick = () => openTab(b.dataset.tab);
  wireSettings();
  const want = params.get('tab');
  openTab(TABS.includes(want) ? want : 'checks');
}

function paintHeader() {
  $('page-title').textContent = cur.name;
  const hl = repoHealth(cur);
  const pill = $('repo-pill');
  pill.hidden = false;
  pill.title = hl.text;
  fill(pill, healthDot(hl.state), h('span', null, [cur.default_branch, cur.map_at ? `地圖 ${ago(cur.map_at)}` : null].filter(Boolean).join(' · ')));
  const remote = $('repo-remote');
  remote.hidden = false;
  remote.textContent = cur.gitea_owner && cur.gitea_repo ? `${cur.gitea_owner}/${cur.gitea_repo}` : shortRemote(cur.remote_url);
  remote.title = cur.remote_url;
}

/** what checks.js reads: always the current row and machines (a settings save replaces `cur`) */
const CTX = {
  get repo() {
    return cur;
  },
  get machines() {
    return machines;
  },
  get engineSpecs() {
    return engineSpecs;
  },
  openTab: (name) => openTab(name),
};

function openTab(name) {
  for (const b of $('repo-tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const t of TABS) $(`tab-${t}`).hidden = t !== name;
  const q = new URLSearchParams(location.search);
  q.set('tab', name);
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  if (name === 'settings') paintSettings();
  else if (name === 'checks') mounted.checks ? mounted.checks.refresh() : (mounted.checks = mountChecks($('tab-checks'), CTX));
  else if (name === 'datasets') mounted.datasets ? mounted.datasets.refresh() : (mounted.datasets = mountDatasets($('tab-datasets'), CTX));
  else if (name === 'fixes') loadFixes();
}

// ---- 設定 ----
let settingsWired = false;

function paintSettings() {
  const r = cur;
  $('set-name').value = r.name;
  $('set-domain').value = r.domain || 'other';
  fill($('set-remote'), r.remote_url, /^https?:\/\//i.test(r.remote_url) ? h('a', { href: r.remote_url, target: '_blank', rel: 'noopener', style: { marginLeft: 'auto', fontFamily: 'inherit' } }, '開啟') : null);
  $('set-path').textContent = r.local_path;
  $('set-branch').value = r.default_branch;
  $('set-prbase').value = r.pr_base || '';
  $('set-prbase').placeholder = r.default_branch;
  fillMachineSelect($('set-machine'), machines, r.machine);
  attachSpecNote($('set-machine'), machines, engineSpecs);
  const localOnly = String(settings.cloud_llm_allowed ?? 'true') === 'false';
  const cloud = $('set-cloud');
  cloud.className = `chip-s ${localOnly ? 'local' : 'cloud'}`;
  cloud.textContent = localOnly ? '只用本地模型（全域）' : '允許雲端模型（全域）';
  cloud.title = '公司模式是全域的：總覽的設定裡「允許雲端模型」';
  $('set-build').value = r.build_cmd || '';
  $('set-test').value = r.test_cmd || '';
  $('set-setup').value = r.setup_cmd || '';
  const s = r.stack;
  $('set-stack').textContent = [langText(s) ? `語言 ${langText(s)}` : null, s && s.files ? `${Number(s.files).toLocaleString('zh-TW')} 個檔案` : null, s && s.entry_points && s.entry_points.length ? `入口 ${s.entry_points.slice(0, 5).join('、')}` : null]
    .filter(Boolean)
    .join(' · ') || '還沒有偵測結果：按「重新偵測」';
  $('map-status').textContent = r.map_at ? `已產生 · ${ago(r.map_at)}${r.map_sha ? ` @ ${String(r.map_sha).slice(0, 7)}` : ''}：分析問題單時用它找檔案與符號` : '還沒有 repo 地圖。有了地圖，分析問題單時比較找得到相關的檔案與符號。';
  const gitea = !!(r.gitea_owner && r.gitea_repo);
  $('gitea-note').hidden = gitea;
  $('set-issue-on').checked = !!r.issue_label;
  $('set-issue-label').value = r.issue_label || 'loop';
  $('set-issue-comments').checked = !!Number(r.issue_comments);
  for (const id of ['set-issue-on', 'set-issue-label', 'set-issue-comments']) $(id).disabled = !gitea;
  $('set-issue-label').disabled = !gitea || !$('set-issue-on').checked;
  $('set-err').hidden = true;
  $('save-note').textContent = r.updated_at ? `上次修改 ${ago(r.updated_at)}` : '';
  $('delete-note').textContent = `只移除登錄與允許清單：本機的複本 ${r.local_path} 留在磁碟上，已經排入的問題單不受影響。要再用它，重新匯入同一個網址即可。`;
}

function settingsPatch() {
  const r = cur;
  const patch = {};
  const put = (k, v) => {
    if ((v ?? null) !== (r[k] ?? null)) patch[k] = v;
  };
  put('name', $('set-name').value.trim());
  put('domain', $('set-domain').value);
  put('default_branch', $('set-branch').value.trim());
  put('pr_base', $('set-prbase').value.trim() || null);
  put('machine', $('set-machine').value || null);
  put('build_cmd', $('set-build').value.trim() || null);
  put('test_cmd', $('set-test').value.trim() || null);
  put('setup_cmd', $('set-setup').value.trim() || null);
  if (r.gitea_owner && r.gitea_repo) {
    put('issue_label', $('set-issue-on').checked ? $('set-issue-label').value.trim() || 'loop' : null);
    const comments = $('set-issue-comments').checked;
    if (comments !== !!Number(r.issue_comments)) patch.issue_comments = comments;
  }
  return patch;
}

function wireSettings() {
  if (settingsWired) return;
  settingsWired = true;
  $('set-issue-on').onchange = () => ($('set-issue-label').disabled = !$('set-issue-on').checked);
  $('settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const patch = settingsPatch();
    $('set-err').hidden = true;
    if (!Object.keys(patch).length) return toast('沒有要儲存的變更');
    $('save-btn').disabled = true;
    try {
      const { repo } = await api(`/api/repos/${enc(cur.id)}`, 'PATCH', patch);
      cur = repo;
      paintHeader();
      paintSettings();
      toast('已儲存');
    } catch (err) {
      $('set-err').textContent = err.message;
      $('set-err').hidden = false;
    } finally {
      $('save-btn').disabled = false;
    }
  };
  $('redetect-btn').onclick = async () => {
    const unsaved = Object.keys(settingsPatch()).length > 0;
    if (!confirm(`${unsaved ? '還有沒儲存的修改，會被蓋掉。\n' : ''}重新偵測會用偵測結果蓋掉預設分支與建置／測試／前置指令。繼續？`)) return;
    const btn = $('redetect-btn');
    btn.disabled = true;
    btn.textContent = '偵測中…';
    try {
      const { repo } = await api(`/api/repos/${enc(cur.id)}/redetect`, 'POST', {});
      cur = repo;
      paintHeader();
      paintSettings();
      toast('已重新偵測');
    } catch (err) {
      toast(`偵測失敗：${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = '重新偵測';
    }
  };
  // 重新產生: POST /api/repos/:id/map rebuilds the map from the clone's HEAD
  $('map-btn').onclick = async () => {
    const btn = $('map-btn');
    btn.disabled = true;
    try {
      const r = await api(`/api/repos/${enc(cur.id)}/map`, 'POST', {});
      if (r && r.repo) cur = r.repo;
      paintSettings();
      toast('已重新產生 repo 地圖');
    } catch (err) {
      toast(`產生失敗：${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
    }
  };
  $('delete-btn').onclick = async () => {
    if (!confirm(`移除「${cur.name}」？\n只移除登錄與允許清單；本機的複本 ${cur.local_path} 留在磁碟上，已經排入的問題單不受影響。`)) return;
    try {
      await api(`/api/repos/${enc(cur.id)}`, 'DELETE');
      toast(`已移除「${cur.name}」`);
      location.href = '/repos.html';
    } catch (err) {
      toast(`移除失敗：${err.message}`, 'bad');
    }
  };
}

// ---- 過去修法 ----
async function loadFixes() {
  const pane = $('tab-fixes');
  const head = h('div.rp-sechead', null, h('h2', null, '過去修法'), h('span.rp-muted', null, '這個 repo 修過什麼、改了哪些檔、結果如何；分析新的問題單時會參考相似的'));
  fill(pane, head, h('p.rp-muted', null, '讀取中…'));
  let fixes;
  try {
    ({ fixes } = await api(`/api/repos/${enc(cur.id)}/fixes`));
  } catch (err) {
    fill(pane, head, h('p.err-line', null, `讀取失敗：${err.message}`));
    return;
  }
  if (!fixes.length) {
    fill(pane, head, h('div.rp-empty', null, icon('clock', { size: 30 }), h('p', null, '還沒有修過的紀錄。問題單合併、退回或放棄時會記在這裡。')));
    return;
  }
  const rows = fixes.map((f) => {
    const files = String(f.files || '').split('\n').filter(Boolean);
    const [label, cls] = OUTCOME[f.outcome] || [f.outcome, ''];
    const open = f.task_id ? `/task.html?id=${enc(f.task_id)}` : null;
    return h(
      `tr${open ? '.link' : ''}`,
      { onclick: open ? (e) => (e.target.closest('a') ? null : (location.href = open)) : null },
      h('td.nowrap', null, Number.isFinite(tsMs(f.created_at)) ? new Date(tsMs(f.created_at)).toLocaleDateString('zh-TW') : '–'),
      h('td', null, open ? h('a.rp-ttl', { href: open }, f.title) : h('span.rp-ttl', null, f.title), f.symptom && f.symptom !== f.title ? h('span.rp-ttl-sub', null, f.symptom) : null),
      h('td', null, files.length ? h('span.rp-files', null, `${files.slice(0, 3).join('、')}${files.length > 3 ? ` 等 ${files.length} 個` : ''}`) : h('span.rp-muted', null, '—')),
      h('td', null, h(`span.chip-s${cls ? `.${cls}` : ''}`, null, label), f.attempts > 1 ? h('span.rp-hint', null, ` 第 ${f.attempts} 次`) : null),
      h('td.nowrap', null, f.model ? modelName(f.model) : h('span.rp-muted', null, '—')),
    );
  });
  const heads = ['日期', '問題', '改了哪些檔', '結果', '模型'].map((t) => h('th', { scope: 'col' }, t));
  fill(pane, head, h('div.rp-tablewrap', null, h('table.rp-table', { id: 'fix-table' }, h('thead', null, h('tr', null, heads)), h('tbody', null, rows))));
}

// =============================================================================================

wireImport();
if (repoId) showDetail(repoId);
else showList();
// keep the page's relative times (「3 分鐘前」) honest on a tab left open
setInterval(() => {
  if (!repoId && !$('import-dialog').open) showList();
}, 5 * 60_000);
