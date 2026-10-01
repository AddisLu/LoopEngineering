// 機台 page (/machines.html): the SSH machines (Linux / Windows) a repo's checks run on — the
// table, add / edit, and the health check with its ✓ / ⚠ / ✗ lines (every failure says what to
// run). The GPU 沙盒 hosts (exec_hosts) sit underneath, collapsed and read-only. #<name> selects
// a machine, so other pages can link to one. textContent-only.
import { $, h, fill, api, toast, icon, popMenu } from './frame.js';
import { ago, osLabel, healthOf, healthDot, checkLine, linesOf, SHELL_LABEL, TRANSPORT_LABEL } from './repo-ui.js';

const enc = encodeURIComponent;
let machines = []; // GET /api/machines rows (+ labels_list, last_check)
let repos = []; // GET /api/repos rows: which repo verifies on which machine
let sandbox = []; // GET /api/machines sandbox_hosts
let selected = null;
let editing = null; // the row the dialog edits; null = a new machine
const checking = new Set();

const fromHash = () => {
  try {
    return decodeURIComponent(location.hash.slice(1)) || null;
  } catch {
    return null;
  }
};
const on = (m) => m.enabled === true || Number(m.enabled) === 1;
const sshText = (m) => `${m.ssh_target}${m.ssh_port ? `:${m.ssh_port}` : ''}`;

function pageError(msg) {
  $('page-err').hidden = !msg;
  $('page-err').textContent = msg || '';
}

async function load() {
  const [m, r] = await Promise.allSettled([api('/api/machines'), api('/api/repos')]);
  if (m.status === 'rejected') {
    pageError(`讀取失敗：${m.reason.message}`);
    return;
  }
  pageError('');
  machines = m.value.machines || [];
  sandbox = m.value.sandbox_hosts || [];
  repos = r.status === 'fulfilled' ? r.value.repos || [] : [];
  const want = fromHash();
  if (want && machines.some((x) => x.name === want)) selected = want;
  if (!machines.some((x) => x.name === selected)) selected = machines[0] ? machines[0].name : null;
  paint();
}

function upsert(row) {
  if (!row || !row.name) return;
  const i = machines.findIndex((x) => x.name === row.name);
  if (i >= 0) machines[i] = row;
  else machines.push(row);
  machines.sort((a, b) => a.name.localeCompare(b.name));
}

function select(name) {
  selected = name;
  history.replaceState(null, '', `${location.pathname}${location.search}#${enc(name)}`);
  paint();
}

// ---- the table ----
function paint() {
  const has = machines.length > 0;
  $('machine-table-wrap').hidden = !has;
  $('machine-empty').hidden = has;
  fill($('machine-rows'), machines.map(row));
  paintDetail();
  paintSandbox();
}

function statusCell(m) {
  if (checking.has(m.name)) return h('span.rp-where', null, h('span.rp-spin', null, icon('spin', { size: 16 })), '檢查中…');
  const hl = healthOf(m);
  return h('span.rp-where', null, healthDot(hl.state), h(`span${hl.state === 'bad' ? '.rp-bad' : ''}`, null, hl.text), hl.when ? h('span.rp-hint', null, hl.when) : null);
}

function row(m) {
  const used = repos.filter((r) => r.machine === m.name);
  return h(
    `tr.link${on(m) ? '' : '.off'}`,
    {
      'aria-selected': String(m.name === selected),
      onclick: (e) => {
        if (!e.target.closest('button, a')) select(m.name);
      },
    },
    h('td', null, h('a.mc-name', { href: `#${enc(m.name)}`, onclick: (e) => (e.preventDefault(), select(m.name)) }, m.name)),
    h('td.mono', null, sshText(m)),
    h('td.nowrap', null, osLabel(m) || '—'),
    h('td', null, (m.labels_list || []).length ? h('span.rp-tags', null, m.labels_list.map((l) => h('span.rp-tag', null, l))) : h('span.rp-muted', null, '—')),
    h('td', null, statusCell(m)),
    h('td', null, used.length ? h('span.rp-tags', null, used.map((r) => h('a', { href: `/repos.html?id=${enc(r.id)}` }, r.name))) : h('span.rp-muted', null, '—')),
    h('td', null, h('button.btn.icon', { type: 'button', 'aria-label': `更多：${m.name}`, onclick: (e) => menu(e.currentTarget, m) }, icon('more', { size: 18 }))),
  );
}

function menu(anchor, m) {
  popMenu(anchor, [
    ['檢查', () => runCheck(m.name)],
    ['編輯', () => openDialog(m)],
    [on(m) ? '停用' : '啟用', () => toggleEnabled(m)],
    'hr',
    ['刪除', () => remove(m)],
  ]);
}

// ---- the selected machine: its last health check ----
function paintDetail() {
  const box = $('machine-detail');
  const m = machines.find((x) => x.name === selected);
  box.hidden = !m;
  if (!m) return fill(box);
  const hl = healthOf(m);
  const lines = linesOf(m);
  const busy = checking.has(m.name);
  const pill = busy
    ? h('span.chip-s.info', null, '檢查中…')
    : hl.state === 'ok'
      ? h('span.chip-s.ok', null, '可以用')
      : hl.state === 'bad'
        ? h('span.chip-s.bad', null, hl.text)
        : h('span.chip-s', null, hl.text);
  fill(
    box,
    h(
      'section.rp-panel',
      null,
      h('div.hd', null, h('h2', null, m.name), h('span.rp-sep', null, '·'), h('span', null, '檢查結果'), m.last_check_at ? [h('span.rp-sep', null, '·'), h('span.rp-hint', null, ago(m.last_check_at))] : null, pill),
      h(
        'div.facts',
        null,
        h('span.k', null, 'SSH'),
        h('span.v.rp-mono', null, sshText(m)),
        h('span.k', null, '作業系統'),
        h('span.v', null, `${osLabel(m) || '—'} · ${SHELL_LABEL[m.shell] || m.shell}`),
        h('span.k', null, '工作目錄'),
        h('span.v.rp-mono', null, m.work_root),
        h('span.k', null, '取碼方式'),
        h('span.v', null, TRANSPORT_LABEL[m.transport] || m.transport),
        m.description ? [h('span.k', null, '說明'), h('span.v', null, m.description)] : null,
      ),
      busy
        ? h('p.rp-muted', null, '檢查中…（SSH 登入、git、能不能讀 Gitea、工作目錄、Python、GPU，約 10–60 秒）')
        : lines.length
          ? h('div.rp-lines', { id: 'detail-lines' }, lines.map(checkLine))
          : h('p.rp-muted', null, '還沒檢查過。按「檢查」看這台能不能用：SSH 登入、git、能不能讀 Gitea、工作目錄、Python、GPU。'),
      h(
        'div.rp-row',
        null,
        h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => runCheck(m.name) }, icon('retry', { size: 15 }), h('span', null, lines.length ? '再檢查' : '檢查')),
        h('button.btn', { type: 'button', onclick: () => openDialog(m) }, '編輯'),
        h('span.grow'),
        h('span.rp-hint', null, '失敗會直接給你指令照著做'),
      ),
    ),
  );
}

async function runCheck(name, o = {}) {
  if (checking.has(name)) return;
  checking.add(name);
  selected = name;
  paint();
  try {
    const r = await api(`/api/machines/${enc(name)}/check`, 'POST', {});
    const i = machines.findIndex((x) => x.name === name);
    if (r.machine) upsert(r.machine);
    else if (i >= 0) machines[i] = { ...machines[i], last_check: r.lines, last_check_ok: r.ok ? 1 : 0, last_check_at: new Date().toISOString() };
    if (o.into) {
      fill(o.into, (r.lines || []).map(checkLine));
      o.into.hidden = false;
    }
    toast(r.ok ? `${name} 可以用了` : `${name} 有項目要處理（看打 ✗ 的那幾行）`, r.ok ? undefined : 'bad');
  } catch (err) {
    toast(`檢查失敗：${err.message}`, 'bad');
    if (o.into) fill(o.into, h('p.err-line', null, `檢查失敗：${err.message}`));
  } finally {
    checking.delete(name);
    paint();
  }
}

async function toggleEnabled(m) {
  try {
    upsert(await api(`/api/machines/${enc(m.name)}`, 'PATCH', { enabled: !on(m) }));
    toast(on(m) ? `已停用 ${m.name}` : `已啟用 ${m.name}`);
  } catch (err) {
    toast(`改不了：${err.message}`, 'bad');
  }
  paint();
}

async function remove(m) {
  const used = repos.filter((r) => r.machine === m.name).map((r) => r.name);
  const warn = used.length ? `\n${used.join('、')} 還設定在這台驗證；刪掉後要到它們的 Repo 設定改。` : '';
  if (!confirm(`刪除機台「${m.name}」？${warn}\n機台上的檔案不會動。`)) return;
  try {
    await api(`/api/machines/${enc(m.name)}`, 'DELETE');
    toast(`已刪除 ${m.name}`);
    if (selected === m.name) selected = null;
    await load();
  } catch (err) {
    toast(`刪不掉：${err.message}`, 'bad');
  }
}

// ---- GPU 沙盒主機（進階）: read-only ----
function paintSandbox() {
  $('sandbox-count').textContent = `· ${sandbox.length} 台 · 唯讀`;
  if (!sandbox.length) return fill($('sandbox-list'), h('p.rp-muted', null, '沒有沙盒主機。'));
  fill(
    $('sandbox-list'),
    h(
      'div.rp-tablewrap',
      null,
      h(
        'table.rp-table',
        { id: 'sandbox-table' },
        h('thead', null, h('tr', null, ['名稱', '說明', '資料掛載（唯讀）'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          null,
          sandbox.map((s) =>
            h(
              'tr',
              null,
              h('td.nowrap', null, h('b', null, s.name), s.default ? h('span.chip-s.info', { style: { marginLeft: '8px' } }, '預設') : null),
              h('td', null, s.description || '—'),
              h('td.mono', null, (s.data || []).length ? (s.data || []).map((d) => h('div', null, `${d.source} → ${d.target}`)) : '—'),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---- 新增／編輯 ----
function mdError(msg) {
  $('md-err').hidden = !msg;
  $('md-err').textContent = msg || '';
}

function paintOsHints() {
  const os = $('md-os').value;
  $('md-root').placeholder = os === 'windows' ? 'C:\\loop' : os === 'linux' ? '/srv/loop' : '/srv/loop 或 C:\\loop';
  const shell = $('md-shell');
  for (const o of shell.options) o.disabled = (os === 'linux' && (o.value === 'powershell' || o.value === 'cmd')) || (os === 'windows' && o.value === 'bash');
  if (shell.selectedOptions[0] && shell.selectedOptions[0].disabled) shell.value = 'auto';
}

function openDialog(m) {
  editing = m || null;
  $('md-title').textContent = m ? `編輯機台 ${m.name}` : '新增機台';
  $('md-name').value = m ? m.name : '';
  $('md-name').disabled = !!m;
  $('md-name-hint').textContent = m ? '機台不能改名（要改就刪掉再加一台）' : '小寫英數、_、-，例 aoi-1';
  $('md-ssh').value = m ? m.ssh_target : '';
  $('md-port').value = m && m.ssh_port ? String(m.ssh_port) : '';
  $('md-os').value = m ? m.os : 'auto';
  $('md-shell').value = m ? m.shell : 'auto';
  $('md-root').value = m ? m.work_root : '';
  $('md-labels').value = m ? (m.labels_list || []).join(', ') : '';
  $('md-desc').value = m ? m.description || '' : '';
  const lines = m ? linesOf(m) : [];
  fill($('md-lines'), lines.map(checkLine));
  $('md-lines').hidden = !lines.length;
  mdError('');
  paintOsHints();
  if (!$('machine-dialog').open) $('machine-dialog').showModal();
  (m ? $('md-ssh') : $('md-name')).focus();
}

/** save what the dialog says (create or PATCH); the saved row, or null with the reason shown */
async function saveDialog() {
  mdError('');
  const port = $('md-port').value.trim();
  const body = {
    ssh_target: $('md-ssh').value.trim(),
    ssh_port: port ? Number(port) : null,
    os: $('md-os').value,
    shell: $('md-shell').value,
    work_root: $('md-root').value.trim(),
    labels: $('md-labels').value,
    description: $('md-desc').value.trim() || null,
  };
  $('md-save').disabled = true;
  $('md-check').disabled = true;
  try {
    const row = editing ? await api(`/api/machines/${enc(editing.name)}`, 'PATCH', body) : await api('/api/machines', 'POST', { name: $('md-name').value.trim(), ...body });
    upsert(row);
    editing = row; // from here the dialog edits the saved row
    selected = row.name;
    $('md-name').disabled = true;
    $('md-title').textContent = `編輯機台 ${row.name}`;
    paint();
    return row;
  } catch (err) {
    mdError(err.message);
    return null;
  } finally {
    $('md-save').disabled = false;
    $('md-check').disabled = false;
  }
}

function wire() {
  $('add-btn').onclick = () => openDialog(null);
  $('empty-add-btn').onclick = () => openDialog(null);
  $('md-close').onclick = () => $('machine-dialog').close();
  $('md-cancel').onclick = () => $('machine-dialog').close();
  $('md-os').onchange = paintOsHints;
  $('machine-form').onsubmit = async (e) => {
    e.preventDefault();
    const row = await saveDialog();
    if (!row) return;
    $('machine-dialog').close();
    toast(`已儲存 ${row.name}`);
    select(row.name);
  };
  $('md-check').onclick = async () => {
    const row = await saveDialog();
    if (!row) return;
    const box = $('md-lines');
    fill(box, h('p.rp-muted', null, '檢查中…（約 10–60 秒）'));
    box.hidden = false;
    $('md-check').disabled = true;
    await runCheck(row.name, { into: box });
    $('md-check').disabled = false;
  };
  window.addEventListener('hashchange', () => {
    const want = fromHash();
    if (want && want !== selected && machines.some((x) => x.name === want)) {
      selected = want;
      paint();
    }
  });
}

wire();
load();
// 「10 分鐘前」 stays true on a page left open
setInterval(() => {
  if (!$('machine-dialog').open && !document.querySelector('.menu-pop[data-pop]')) paint();
}, 60_000);
