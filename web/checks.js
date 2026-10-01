// 檢查 — the Repo page's 檢查 tab and its editor — and 圖資, the tab next to it.
//   mountChecks(el, ctx):  the list (drag the handle to reorder, the 必過 switch, ⋯ 試跑一次 / 編輯 /
//                          停用 / 刪除) and an empty state that builds checks from the detected commands.
//   the editor dialog:     five kinds (建置 · 測試 · 重現腳本 · 圖資回歸 · 自訂) plus 人工; where it
//                          runs; how it passes — and a threshold's metric can only be picked from what
//                          the last 試跑 printed (LOOP_METRICS), never typed; the 試跑 log polls the run.
//   mountDatasets(el, ctx) and openDatasetDialog(): the linked 圖資 repos.
// ctx = { repo, machines: Map name → GET /api/machines row, openTab?(name) }.
// Every request goes through checks-api.js. textContent-only.
import { h, fill, icon, toast, popMenu } from './frame.js';
import * as C from './checks-api.js';
import { ago, secs, csv, csvShow, healthOf, healthDot, machineLabel, fillMachineSelect, linesOf, dialogShell } from './repo-ui.js';

export const KINDS = [
  ['build', '建置'],
  ['test', '測試'],
  ['repro', '重現腳本'],
  ['dataset', '圖資回歸'],
  ['custom', '自訂'],
  ['manual', '人工'],
];
const KIND_LABEL = Object.fromEntries(KINDS);
/** what a new check is called when its name is left empty */
const DEFAULT_NAME = { build: '建置', test: '單元測試', repro: '重現', dataset: '圖資回歸', custom: '自訂檢查', manual: '人工確認' };
const PLACEHOLDER = {
  build: 'cmake --build build -j',
  test: 'ctest --test-dir build --output-on-failure',
  repro: 'pytest tests/test_issue_12.py',
  dataset: 'run_inference --in {images} --out {out}',
  custom: 'python tools/check_format.py',
};
/** a 圖資回歸 always reports these (src/checks compares the answers itself), so they never need a 試跑 */
const DATASET_METRICS = ['correct_rate', 'mismatches', 'missing', 'total', 'time_ms'];
const OPS = [['>=', '≥'], ['<=', '≤'], ['==', '='], ['!=', '≠'], ['>', '>'], ['<', '<']];
const FORMAT = { auto: '自動判斷', json: 'JSON', csv: 'CSV', labels: '標記檔' };
const enc = encodeURIComponent;

const opText = (op) => (OPS.find(([o]) => o === op) || [op, op])[1];
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(round(v, 4)));
/** a flag from the API: 1 / 0 from SQLite, or a boolean */
const yes = (v) => v === true || v === 'true' || Number(v) === 1;
const lowerIsBetter = (name) => /(_ms|_s|_us|time|latency|mismatch|missing|error|fail|loss)/i.test(name);
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo ? Math.min(n, hi) : dflt;
}
function parseJson(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** "correct_rate >= 0.98; time_ms <= 5300" → [{ name, op, target }] (target kept as typed) */
export function parseMetrics(spec) {
  return String(spec || '')
    .split(/[;\n]/)
    .map((s) => /^\s*([A-Za-z_][\w.-]*)\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*$/i.exec(s))
    .filter(Boolean)
    .map((m) => ({ name: m[1], op: m[2], target: m[3] }));
}
/** the rows back into the stored form; a row without a number is dropped */
export function metricsText(rows) {
  return rows
    .filter((r) => r.name && r.target !== '' && Number.isFinite(Number(r.target)))
    .map((r) => `${r.name} ${r.op} ${r.target}`)
    .join('; ');
}
/** the numbers a run reported: `metrics` (the route parses metrics_json) is {values, checks, pass} or the flat values */
export function runValues(run) {
  const v = parseJson(run && (run.metrics != null ? run.metrics : run.metrics_json));
  const src = v && typeof v.values === 'object' && v.values ? v.values : v;
  const out = {};
  for (const [k, x] of Object.entries(src || {})) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return out;
}
const baselineOf = (c) => {
  const b = parseJson(c && c.baseline_json);
  return b && typeof b === 'object' ? b : null;
};
/** 基準：正確率 98.7%，5.1 s（@ 3f2a1c） */
export function baselineText(b) {
  const v = (b && b.values) || {};
  const parts = [];
  if (typeof v.correct_rate === 'number') parts.push(`正確率 ${round(v.correct_rate <= 1 ? v.correct_rate * 100 : v.correct_rate, 2)}%`);
  if (typeof v.time_ms === 'number') parts.push(secs(v.time_ms));
  for (const [k, x] of Object.entries(v)) {
    if (k === 'correct_rate' || k === 'time_ms' || typeof x !== 'number' || parts.length >= 4) continue;
    parts.push(`${k} ${fmtNum(x)}`);
  }
  if (!parts.length && typeof b.ms === 'number') parts.push(secs(b.ms));
  return `基準：${parts.join('，') || '（沒有數值）'}${b.sha ? `（@ ${String(b.sha).slice(0, 7)}）` : ''}`;
}
/** 怎麼算過, as the list says it */
function passText(c) {
  if (c.kind === 'manual') return '勾選';
  if (c.pass_rule === 'metrics') {
    const rows = parseMetrics(c.metrics);
    return rows.length ? rows.map((r) => `${r.name} ${opText(r.op)} ${r.target}`).join(' · ') : '指標門檻';
  }
  if (c.pass_rule === 'baseline') return '不比基準差';
  return 'exit 0';
}

// =============================================================================================
// the 檢查 tab
// =============================================================================================

export function mountChecks(el, ctx) {
  let checks = [];
  let orderTimer = null;
  const box = h('div.rp-tabpane');
  const hasDetected = () => !!(ctx.repo.build_cmd || ctx.repo.test_cmd);
  const detectedBtn = h('button.btn', { type: 'button', onclick: (e) => fromDetected(e) }, '用偵測到的指令建立');
  fill(
    el,
    h(
      'div.rp-sechead',
      null,
      h('h2', null, '檢查'),
      h('span.rp-muted', null, '每張問題單都會跑這些；必過的紅了就不算修好'),
      h('span.grow'),
      h('button.btn.primary', { type: 'button', onclick: () => edit(null) }, '＋ 新增檢查'),
      detectedBtn,
    ),
    box,
  );

  const edit = (c, o = {}) => openCheckEditor(ctx, c, { ...o, onSaved: refresh });

  async function refresh() {
    detectedBtn.disabled = !hasDetected();
    detectedBtn.title = hasDetected() ? '' : '沒有偵測到建置或測試指令：到「設定」補上，或按「重新偵測」';
    try {
      checks = await C.listChecks(ctx.repo.id);
    } catch (err) {
      fill(box, h('p.err-line', null, `讀不到檢查：${err.message}`));
      return;
    }
    paint();
  }

  async function fromDetected(e) {
    const btn = e && e.currentTarget;
    if (btn) btn.disabled = true;
    try {
      const r = await C.checksFromDetected(ctx.repo.id);
      await refresh();
      toast(r.created.length ? `已建立：${r.created.map((c) => c.name).join('、')}` : `偵測到的指令都已經有檢查了${r.skipped.length ? `（${r.skipped.join('、')}）` : ''}`);
    } catch (err) {
      toast(`建立失敗：${err.message}`, 'bad');
    } finally {
      if (btn) btn.disabled = !hasDetected();
    }
  }

  function empty() {
    const cmds = [ctx.repo.build_cmd, ctx.repo.test_cmd].filter(Boolean);
    return h(
      'div.rp-empty',
      null,
      icon('list', { size: 30 }),
      h('p', null, '還沒有檢查。先加一個建置或測試檢查；之後每張問題單都會跑它們。'),
      cmds.length ? h('p.rp-hint', null, `偵測到的指令：${cmds.join(' · ')}`) : h('p.rp-hint', null, '這個 repo 沒有偵測到建置或測試指令。'),
      h(
        'div.rp-row',
        null,
        cmds.length
          ? h('button.btn.primary', { type: 'button', onclick: (e) => fromDetected(e) }, '用偵測到的指令建立')
          : ctx.openTab
            ? h('button.btn', { type: 'button', onclick: () => ctx.openTab('settings') }, '到「設定」補指令')
            : null,
        h('button.btn', { type: 'button', onclick: () => edit(null) }, '＋ 新增檢查'),
      ),
    );
  }

  function paint() {
    if (!checks.length) {
      fill(box, empty());
      return;
    }
    const sorted = [...checks].sort((a, b) => (Number(a.ord) || 0) - (Number(b.ord) || 0));
    const tbody = h('tbody', null, sorted.map(row));
    const heads = ['名稱', '類型', '在哪跑', '怎麼算過', '最近一次', '必過'].map((t) => h('th', { scope: 'col' }, t));
    const table = h('table.rp-table', { id: 'check-table' }, h('thead', null, h('tr', null, heads, h('th.th-more', { scope: 'col' }, h('span.rp-sr', null, '更多動作'), '⋯'))), tbody);
    fill(box, h('div.rp-tablewrap', null, table), h('p.rp-muted', null, '拖曳左側把手可以排序（選到把手按 ↑ ↓ 也行）· 「⋯」裡有試跑一次、編輯、停用、刪除'));
  }

  function whereCell(name) {
    if (!name) return h('span.rp-where', null, healthDot('ok', '引擎主機'), '引擎主機');
    if (String(name).startsWith('sandbox:')) return h('span.rp-where', null, icon('box', { size: 15 }), machineLabel(name, ctx.machines));
    const m = ctx.machines.get(name);
    const hl = m ? healthOf(m) : { state: 'bad', text: '找不到這台機台' };
    return h('span.rp-where', { title: `${hl.text}${hl.when ? ` · ${hl.when}檢查` : ''}` }, healthDot(hl.state), machineLabel(name, ctx.machines));
  }

  function lastCell(c) {
    if (c.kind === 'manual') return h('span.rp-muted', null, '—');
    const r = c.last_run;
    if (!r || (r.ok == null && !r.started_at)) return h('span.rp-muted', null, '未跑過');
    if (r.running || r.ok == null) return h('span.rp-last.run', null, icon('spin', { size: 16 }), '執行中');
    return h(
      `span.rp-last.${r.ok ? 'ok' : 'bad'}`,
      { title: r.started_at ? `${r.ok ? '通過' : '沒過'} · ${ago(r.started_at)}` : null },
      icon(r.ok ? 'okCircle' : 'xCircle', { size: 18, sw: 2 }),
      h('span.rp-sr', null, r.ok ? '通過' : '沒過'),
      h('span', null, ago(r.started_at) || (r.ok ? '通過' : '沒過')),
    );
  }

  function row(c) {
    const grip = h('button.rp-grip', { type: 'button', 'aria-label': `調整順序：${c.name}（↑ ↓ 移動）`, title: '拖曳排序' }, icon('grip', { size: 16, sw: 3.2 }));
    const flags = [
      !yes(c.enabled) ? h('span.chip-s', null, '已停用') : null,
      c.kind === 'dataset' && !c.command ? h('span.rp-flag', null, '還沒有命令列入口') : null,
    ];
    const req = h('button.rp-switch', {
      type: 'button',
      role: 'switch',
      'aria-checked': String(yes(c.required)),
      'aria-label': `必過：${c.name}`,
      onclick: (e) => toggleRequired(c, e.currentTarget),
    });
    const more = h('button.btn.icon', { type: 'button', 'aria-label': `更多：${c.name}`, onclick: (e) => menu(e.currentTarget, c) }, icon('more', { size: 18 }));
    const on = yes(c.enabled);
    const tr = h(
      'tr',
      { dataset: { id: c.id }, class: on ? null : 'off' },
      h('td', null, h('div.rp-namecell', null, grip, h('b', null, c.name), flags)),
      h('td', null, h(`span.chip-s${c.kind === 'dataset' ? '.info' : ''}`, null, KIND_LABEL[c.kind] || c.kind)),
      h('td', null, c.kind === 'manual' ? h('span.rp-muted', null, '—') : whereCell(c.machine)),
      h('td', { class: c.kind !== 'manual' && c.pass_rule !== 'baseline' ? 'mono' : null }, passText(c)),
      h('td', null, lastCell(c)),
      h('td', null, req),
      h('td', null, more),
    );
    wireDrag(grip, tr);
    return tr;
  }

  function menu(anchor, c) {
    const on = yes(c.enabled);
    popMenu(anchor, [
      ...(c.kind !== 'manual' ? [['試跑一次', () => edit(c, { trial: true })]] : []),
      ['編輯', () => edit(c)],
      [on ? '停用' : '啟用', () => update(c, { enabled: !on }, on ? `已停用「${c.name}」` : `已啟用「${c.name}」`)],
      'hr',
      ['刪除', () => remove(c)],
    ]);
  }

  async function update(c, patch, done) {
    try {
      const up = await C.updateCheck(c.id, patch);
      Object.assign(c, up && up.id ? up : patch);
      if (done) toast(done);
    } catch (err) {
      toast(`改不了：${err.message}`, 'bad');
    }
    paint();
  }

  function toggleRequired(c, sw) {
    const next = !yes(c.required);
    sw.setAttribute('aria-checked', String(next)); // at once; paint() puts it back if the save fails
    update(c, { required: next }, next ? `「${c.name}」改成必過` : `「${c.name}」改成選擇性`);
  }

  async function remove(c) {
    if (!confirm(`刪除檢查「${c.name}」？已經排入的問題單不受影響（它們帶著當時的檢查）。`)) return;
    try {
      await C.deleteCheck(c.id);
      toast(`已刪除「${c.name}」`);
      await refresh();
    } catch (err) {
      toast(`刪不掉：${err.message}`, 'bad');
    }
  }

  // ---- ordering: pointer events (mouse and touch) move the row live; ↑ / ↓ on the handle too ----
  function saveOrder(tbody) {
    const ids = [...tbody.children].map((r) => r.dataset.id);
    ids.forEach((id, i) => {
      const c = checks.find((x) => x.id === id);
      if (c) c.ord = i;
    });
    clearTimeout(orderTimer);
    orderTimer = setTimeout(async () => {
      try {
        await C.reorderChecks(ctx.repo.id, ids);
      } catch (err) {
        toast(`順序沒存到：${err.message}`, 'bad');
        refresh();
      }
    }, 350);
  }

  function wireDrag(grip, tr) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const tbody = tr.parentElement;
      const table = tbody.parentElement;
      const before = [...tbody.children].map((r) => r.dataset.id).join(',');
      tr.classList.add('dragging');
      table.classList.add('sorting');
      // listeners on the document, not pointer capture: moving the row in the DOM would drop a capture
      const move = (ev) => {
        let target = null;
        for (const r of tbody.children) {
          if (r === tr) continue;
          const b = r.getBoundingClientRect();
          if (ev.clientY < b.top + b.height / 2) {
            target = r;
            break;
          }
        }
        if (target) {
          if (tr.nextElementSibling !== target) tbody.insertBefore(tr, target);
        } else if (tbody.lastElementChild !== tr) tbody.appendChild(tr);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        tr.classList.remove('dragging');
        table.classList.remove('sorting');
        if ([...tbody.children].map((r) => r.dataset.id).join(',') !== before) saveOrder(tbody);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const tbody = tr.parentElement;
      const sib = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling;
      if (!sib) return;
      if (e.key === 'ArrowUp') tbody.insertBefore(tr, sib);
      else tbody.insertBefore(sib, tr);
      grip.focus();
      saveOrder(tbody);
    });
  }

  refresh();
  return { refresh };
}

// =============================================================================================
// the editor dialog
// =============================================================================================

let editorSeq = 0;

/**
 * 新增 / 編輯 one check. `o.trial` starts a 試跑 as soon as it opens (the list's ⋯ 試跑一次);
 * `o.onSaved` runs after every save, 試跑 and 設為基準 so the list stays current.
 */
export function openCheckEditor(ctx, check, o = {}) {
  const seq = ++editorSeq; // a reopened editor retires the old one's polling
  const repo = ctx.repo;
  const { dlg, title, sub, body, foot } = dialogShell('check-dialog', { wide: true });
  let saved = check ? { ...check } : null; // the row as the API last returned it
  let dirty = !check;
  let kind = (check && check.kind) || 'build';
  let pass = (check && check.pass_rule) || 'exit0';
  let thresholds = parseMetrics(check && check.metrics);
  let run = null; // the latest 試跑 (GET /api/check-runs/:id → run)
  let discovered = [];
  let values = {};
  let running = false;
  let runErr = null;
  let datasets = [];
  let dsCur = (check && check.dataset_id) || '';
  const touch = () => (dirty = true);
  title.textContent = saved ? '編輯檢查' : '新增檢查';
  sub.textContent = repo.name;

  // ---- fields ----
  const nameIn = h('input.rp-in', { id: 'ck-name', type: 'text', maxlength: '60', value: (check && check.name) || '', oninput: touch });
  const kindBtns = KINDS.map(([k, label]) => h(`button${k === 'manual' ? '.manual' : ''}`, { type: 'button', 'data-kind': k, 'aria-pressed': String(k === kind), onclick: () => setKind(k) }, label));
  const whereSel = h('select.rp-in', { id: 'ck-where', onchange: () => (touch(), paintCmdHint()) });
  fillMachineSelect(whereSel, ctx.machines, check ? check.machine : repo.machine);
  const dsSel = h('select.rp-in', { id: 'ck-dataset', onchange: onDataset });
  const dsField = h('label.rp-f', null, h('span.cap', null, '圖資'), dsSel);
  const cmdCap = h('span', null, '指令');
  const cmdIn = h('input.rp-in.mono', { id: 'ck-cmd', type: 'text', spellcheck: 'false', value: (check && check.command) || '', oninput: () => (touch(), paintCli(), paintFoot()) });
  const cmdHint = h('span.rp-hint');
  const redCb = h('input', { type: 'checkbox', id: 'ck-red', checked: check ? yes(check.red_on_base) : true, onchange: touch });
  const globsIn = h('input.rp-in.mono', { id: 'ck-globs', type: 'text', spellcheck: 'false', value: csvShow(check && check.test_globs), placeholder: 'tests/test_issue_*.py', oninput: touch });
  const passRadios = [
    ['exit0', 'exit 0', null],
    ['metrics', '指標門檻', '名稱只能從試跑偵測到的指標裡選'],
    ['baseline', '不比基準差', null],
  ].map(([v, label, hint]) =>
    h('label.rp-opt', null, h('input', { type: 'radio', name: 'ck-pass', value: v, checked: v === pass, onchange: () => setPass(v) }), h('span', { class: v === 'exit0' ? 'rp-mono' : null }, label), hint ? h('span.rp-hint', null, hint) : null),
  );
  const passBox = h('fieldset.rp-radios', null, h('legend', null, '怎麼算過'), passRadios);
  const tolIn = h('input', { id: 'ck-tol', type: 'number', min: '1', max: '10', step: '0.05', value: String(round(1 + Number(check && check.baseline_tol != null ? check.baseline_tol : 0.1), 3)), oninput: touch });
  const ruleBox = h('div.rp-radios');
  const chips = h('div.rp-mchips');
  const thrBox = h('div.rp-thrs');
  const timeoutIn = h('input.rp-in.num', { id: 'ck-timeout', type: 'number', min: '1', max: '600', value: String((check && check.timeout_min) || 20), oninput: touch });
  const artIn = h('input.rp-in.mono', { id: 'ck-artifacts', type: 'text', spellcheck: 'false', value: csvShow(check && check.artifacts), placeholder: '{out}/overlays/**, build/*.log', oninput: touch });
  const protIn = h('input.rp-in.mono', { id: 'ck-protected', type: 'text', spellcheck: 'false', value: csvShow(check && check.protected_paths), placeholder: 'tests/**, datasets/**', oninput: touch });
  const manualIn = h('input.rp-in', { id: 'ck-manual', type: 'text', maxlength: '300', value: (check && check.manual_text) || '', placeholder: '例：上產線機台跑一次，確認判型畫面正確', oninput: touch });
  const cli = h('div', { hidden: true });
  const trialBox = h('div.rp-trial', { hidden: true });
  const baseBox = h('div.rp-baseline', { hidden: true });
  const err = h('p.err-line', { hidden: true, role: 'alert' });
  const showErr = (m) => {
    err.textContent = m || '';
    err.hidden = !m;
  };

  const S = {
    where: h('div.rp-grid2', null, h('label.rp-f', null, h('span.cap', null, '在哪裡跑'), whereSel), dsField),
    cmd: h('label.rp-f', null, h('span.cap', null, cmdCap), cmdIn, cmdHint),
    repro: h(
      'div.rp-grid2',
      null,
      h('label.rp-opt', null, redCb, h('span', null, '修改前必須失敗'), h('span.rp-hint', null, '修改前要紅、修改後要綠')),
      h('label.rp-f', null, h('span.cap', null, '測試檔案 glob'), globsIn),
    ),
    pass: h('div.rp-grid2', null, passBox, ruleBox),
    metrics: h('div.rp-tabpane', null, chips, thrBox),
    extras: h(
      'div.rp-grid3',
      null,
      h('label.rp-f', null, h('span.cap', null, '逾時'), h('span.rp-row', null, timeoutIn, h('span', null, '分鐘'))),
      h('label.rp-f', null, h('span.cap', null, '產出物'), artIn),
      h('label.rp-f', null, h('span.cap', null, '保護路徑', h('span.rp-hint', null, '（量尺、評估程式、答案檔）')), protIn),
    ),
    manual: h('label.rp-f', null, h('span.cap', null, '清單文字', h('span.rp-hint', null, '會出現在結果頁的清單，要有人勾選才算過')), manualIn),
  };
  fill(
    body,
    h('div.rp-namekind', null, h('label.rp-f', null, h('span.cap', null, '名稱'), nameIn), h('div.rp-f', null, h('span.cap', null, '類型'), h('div.rp-seg', { role: 'group', 'aria-label': '類型' }, kindBtns))),
    S.where,
    cli,
    S.cmd,
    S.repro,
    S.pass,
    S.metrics,
    S.extras,
    S.manual,
    trialBox,
    baseBox,
    err,
  );

  const trialBtn = h('button.btn', { type: 'button', onclick: () => doTrial() }, icon('play', { size: 14, fill: true }), h('span', null, '試跑一次'));
  const trialHint = h('span.rp-hint', null, `在預設分支 ${repo.default_branch} 跑，輸出會即時顯示在上面；試跑前會先儲存`);
  const saveBtn = h('button.btn.primary', { type: 'button', onclick: () => doSave() }, '儲存');
  fill(foot, trialBtn, trialHint, h('span.grow'), h('button.btn', { type: 'button', onclick: () => dlg.close() }, '取消'), saveBtn);

  // ---- painting ----
  function applyKind() {
    const manual = kind === 'manual';
    for (const b of kindBtns) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    nameIn.placeholder = DEFAULT_NAME[kind];
    S.where.hidden = manual;
    dsField.hidden = kind !== 'dataset';
    S.cmd.hidden = manual;
    S.repro.hidden = kind !== 'repro';
    S.pass.hidden = manual;
    S.metrics.hidden = manual;
    S.extras.hidden = manual;
    S.manual.hidden = !manual;
    trialBtn.hidden = manual;
    trialHint.hidden = manual;
    cmdCap.textContent = kind === 'dataset' ? '指令範本' : '指令';
    cmdIn.placeholder = PLACEHOLDER[kind] || '';
    paintCmdHint();
    paintCli();
    paintPass();
    paintTrial();
    paintFoot();
  }

  function paintCmdHint() {
    const m = ctx.machines.get(whereSel.value);
    const win = !!m && m.os === 'windows';
    if (kind === 'dataset') {
      fill(
        cmdHint,
        h('code', null, '{images}'),
        ' 圖片資料夾 · ',
        h('code', null, '{answers}'),
        ' 答案檔 · ',
        h('code', null, '{out}'),
        ' 輸出資料夾（Loop 會收回來比對）',
        win ? ' · Windows 機台用 PowerShell 語法' : null,
      );
    } else {
      fill(cmdHint, `一行指令，在 repo 根目錄執行${win ? ' · Windows 機台用 PowerShell 語法' : ''}`);
    }
  }

  function paintCli() {
    const need = kind === 'dataset' && !cmdIn.value.trim();
    cli.hidden = !need;
    if (!need) return fill(cli);
    fill(
      cli,
      h(
        'div.rp-callout.warn',
        null,
        icon('warnTri', { size: 20, sw: 2 }),
        h(
          'div.tx',
          null,
          h('b', null, '這個 repo 還沒有命令列入口，圖資回歸無法自動跑'),
          h('p', null, '圖資回歸要能用一行指令跑：給它圖片資料夾，它把結果寫進輸出資料夾。可以請 Loop 開一張問題單幫這個 repo 加上；在那之前，這一項先用人工驗收。'),
          h(
            'div.rp-row',
            null,
            h('a.btn.sm', { id: 'ck-cli-ticket', href: `/fix.html?repo=${enc(repo.id)}&template=cli-entry` }, '請 Loop 幫這個 repo 加命令列入口'),
            h('button.btn.sm', { type: 'button', onclick: toManual }, '先當人工驗收'),
          ),
        ),
      ),
    );
  }

  function setPassRadio(v) {
    pass = v;
    for (const r of passBox.querySelectorAll('input')) r.checked = r.value === v;
  }

  function paintPass() {
    if (pass === 'baseline') {
      const b = baselineOf(saved);
      fill(
        ruleBox,
        h('span.rp-hint', null, '比較規則'),
        h('div.rp-opt', null, icon('check', { size: 16 }), kind === 'dataset' ? '正確率不低於基準' : '每個指標都不比基準差'),
        h('label.rp-tol', null, h('span', null, '時間不超過基準 ×'), tolIn),
        h('span.rp-hint', null, b ? baselineText(b) : '還沒有基準：試跑一次，再按「設為基準」'),
      );
    } else if (pass === 'metrics') {
      fill(ruleBox, h('span.rp-hint', null, '門檻'), h('span.rp-hint', null, '從下面「偵測到的指標」挑一個以上；輸出裡少了哪一個指標，這項就算沒過。'));
    } else {
      fill(ruleBox, h('span.rp-hint', null, '比較規則'), h('span.rp-hint', null, '指令結束時 exit code 是 0 就算過。'));
    }
    paintChips();
    paintThresholds();
  }

  /** every name a 試跑 showed us (and, for a 圖資回歸, the fixed five) */
  function knownNames() {
    const names = new Set(discovered);
    for (const k of Object.keys(values)) names.add(k);
    if (kind === 'dataset') for (const n of DATASET_METRICS) names.add(n);
    return [...names];
  }
  const haveRunInfo = () => discovered.length > 0 || Object.keys(values).length > 0 || kind === 'dataset';

  function paintChips() {
    if (kind === 'manual') return fill(chips);
    const names = knownNames();
    const label = h('span.lbl', null, '偵測到的指標');
    if (!names.length) {
      return fill(
        chips,
        label,
        h('span.rp-hint', { id: 'ck-no-metrics' }, pass === 'metrics' ? '還沒有：先按「試跑一次」，Loop 會從輸出的 LOOP_METRICS 抓出指標名稱，再從這裡挑門檻。' : '還沒試跑過；試跑後這裡會列出輸出裡的 LOOP_METRICS 指標。'),
      );
    }
    fill(
      chips,
      label,
      names.map((n) => {
        const t = pass === 'metrics' ? thresholds.find((x) => x.name === n) : null;
        return h(
          'button.rp-mchip',
          { type: 'button', 'aria-pressed': String(!!t), title: t ? '按一下取消這個門檻' : '按一下設成門檻', onclick: () => pickMetric(n) },
          t ? `${n} ${opText(t.op)} ${t.target || '?'}` : n,
          !t && values[n] != null ? h('span.v', null, `= ${fmtNum(values[n])}`) : null,
        );
      }),
      pass !== 'metrics' ? h('span.rp-hint', null, '點一個指標，就改用「指標門檻」') : null,
    );
  }

  function pickMetric(n) {
    const has = thresholds.some((t) => t.name === n);
    if (pass !== 'metrics') {
      setPassRadio('metrics');
      if (!has) thresholds.push({ name: n, op: lowerIsBetter(n) ? '<=' : '>=', target: values[n] != null ? fmtNum(values[n]) : '' });
    } else if (has) thresholds = thresholds.filter((t) => t.name !== n);
    else thresholds.push({ name: n, op: lowerIsBetter(n) ? '<=' : '>=', target: values[n] != null ? fmtNum(values[n]) : '' });
    touch();
    paintPass();
  }

  function paintThresholds() {
    if (kind === 'manual' || pass !== 'metrics') return fill(thrBox);
    const known = new Set(knownNames());
    fill(
      thrBox,
      thresholds.map((t) =>
        h(
          'div.rp-thr',
          null,
          h('span.nm', null, t.name, haveRunInfo() && !known.has(t.name) ? h('small', null, '上次試跑沒看到這個指標') : null),
          h(
            'select',
            { 'aria-label': `${t.name} 的比較`, onchange: (e) => ((t.op = e.target.value), touch(), paintChips()) },
            OPS.map(([v, s]) => h('option', { value: v, selected: v === t.op }, s)),
          ),
          h('input', { type: 'text', inputmode: 'decimal', 'aria-label': `${t.name} 的門檻`, value: t.target, placeholder: '數值', oninput: (e) => ((t.target = e.target.value.trim()), touch(), paintChips()) }),
          h('button.btn.icon', { type: 'button', 'aria-label': `拿掉 ${t.name} 這個門檻`, onclick: () => ((thresholds = thresholds.filter((x) => x !== t)), touch(), paintPass()) }, icon('x', { size: 14 })),
        ),
      ),
    );
  }

  function consoleText(text) {
    const s = String(text || '');
    if (!s) return [running ? '等機台回應…' : '（沒有輸出）'];
    const out = [];
    for (const ln of s.split('\n')) out.push(/LOOP_METRICS/.test(ln) ? h('span.m', null, ln) : ln, '\n');
    out.pop();
    return out;
  }

  function paintTrial() {
    const show = kind !== 'manual' && !!(running || run || runErr);
    trialBox.hidden = !show;
    if (show) {
      const r = run || {};
      const where = machineLabel(r.machine !== undefined ? r.machine : whereSel.value || null, ctx.machines, { short: true });
      const bits = [where, `${repo.default_branch}${r.head_sha ? ` @ ${String(r.head_sha).slice(0, 7)}` : ''}`, r.started_at ? ago(r.started_at) : null, r.ms != null ? secs(r.ms) : null].filter(Boolean);
      const status = running
        ? h('span.chip-s.info', null, '試跑中…')
        : runErr
          ? h('span.chip-s.bad', null, '試跑失敗')
          : r.timed_out
            ? h('span.chip-s.bad', null, '逾時')
            : r.ok
              ? h('span.chip-s.ok', null, `exit ${r.exit_code != null ? r.exit_code : 0}`)
              : h('span.chip-s.bad', null, r.exit_code != null ? `exit ${r.exit_code}` : '沒過');
      const pre = h('pre.rp-console', { id: 'ck-log' }, consoleText(runErr || r.output_tail));
      fill(trialBox, h('div.hd', null, h('span', null, running ? '試跑' : '上次試跑'), h('span.who', null, bits.join(' · ')), status), pre);
      pre.scrollTop = pre.scrollHeight;
    }
    paintBase();
  }

  function paintBase() {
    const b = baselineOf(saved);
    const canSet = !!(saved && run && run.id && !running && run.ok && Object.keys(values).length);
    baseBox.hidden = kind === 'manual' || (!b && !canSet);
    if (baseBox.hidden) return;
    fill(baseBox, h('span.tx', null, b ? baselineText(b) : '還沒有基準'), canSet ? h('button.btn.sm', { type: 'button', onclick: (e) => doBaseline(e) }, '設為基準') : null);
  }

  function paintFoot() {
    const noCmd = !cmdIn.value.trim();
    trialBtn.disabled = running || noCmd;
    trialBtn.title = noCmd ? '先填指令' : running ? '試跑中' : '';
  }

  // ---- kind / pass / dataset ----
  function setKind(k) {
    if (k === kind) return;
    kind = k;
    touch();
    if (k === 'dataset') {
      if (pass === 'exit0') setPassRadio('baseline'); // a regression compares numbers, not an exit code
      loadDatasets();
    }
    applyKind();
  }

  function setPass(v) {
    pass = v;
    touch();
    paintPass();
  }

  async function loadDatasets(select) {
    try {
      datasets = await C.listDatasets();
    } catch {
      datasets = [];
    }
    if (select) dsCur = select;
    fill(
      dsSel,
      h('option', { value: '' }, datasets.length ? '選一個圖資…' : '還沒有圖資'),
      datasets.map((d) => h('option', { value: d.id }, `${d.name}${d.cases != null ? ` · ${Number(d.cases).toLocaleString('zh-TW')} 張` : ''}`)),
      h('option', { value: '__link' }, '＋ 連結圖資 repo…'),
    );
    dsSel.value = datasets.some((d) => d.id === dsCur) ? dsCur : '';
  }

  function onDataset() {
    if (dsSel.value === '__link') {
      dsSel.value = datasets.some((d) => d.id === dsCur) ? dsCur : '';
      openDatasetDialog({ onDone: (ds) => (touch(), loadDatasets(ds.id)) });
      return;
    }
    dsCur = dsSel.value;
    touch();
  }

  function toManual() {
    const ds = datasets.find((d) => d.id === dsSel.value);
    if (!manualIn.value.trim()) manualIn.value = `圖資回歸：人工確認${ds ? ` ${ds.name} ` : ''}的結果（結果頁附圖勾選）`;
    if (!nameIn.value.trim() || nameIn.value.trim() === DEFAULT_NAME.dataset) nameIn.value = '人工：圖資回歸';
    setKind('manual');
  }

  // ---- save / 試跑 / 基準 ----
  function collect() {
    const manual = kind === 'manual';
    const b = {
      name: nameIn.value.trim() || DEFAULT_NAME[kind],
      kind,
      machine: manual ? null : whereSel.value || null,
      command: manual ? null : cmdIn.value.trim() || null,
      pass_rule: manual ? 'exit0' : pass,
      metrics: !manual && pass === 'metrics' ? metricsText(thresholds) || null : null,
      baseline_tol: Math.max(0, round((Number(tolIn.value) || 1.1) - 1, 3)),
      dataset_id: kind === 'dataset' ? dsSel.value || null : null,
      test_globs: kind === 'repro' ? csv(globsIn.value) || null : null,
      timeout_min: manual ? null : clampInt(timeoutIn.value, 1, 600, 20),
      protected_paths: manual ? null : csv(protIn.value) || null,
      artifacts: manual ? null : csv(artIn.value) || null,
      manual_text: manual ? manualIn.value.trim() || null : null,
    };
    if (kind === 'repro') b.red_on_base = redCb.checked;
    return b;
  }

  function problem(b) {
    if (b.kind === 'manual') return b.manual_text ? null : '人工檢查要寫一行清單文字';
    if (b.kind === 'dataset' && !b.command) return '圖資回歸要一行指令範本；這個 repo 還沒有命令列入口的話，先請 Loop 加，或先當人工驗收';
    if (!b.command) return '要填指令';
    if (b.kind === 'dataset' && !b.command.includes('{out}')) return '圖資回歸的指令要用 {out} 指定輸出資料夾（Loop 會把它收回來比對），例如 run_inference --in {images} --out {out}';
    if (b.kind !== 'dataset' && /\{(images|answers|out)\}/.test(b.command)) return '只有圖資回歸可以用 {images} {answers} {out}';
    if (b.kind === 'dataset' && !b.dataset_id) return '選一個圖資（或「＋ 連結圖資 repo…」）';
    if (b.pass_rule === 'metrics') {
      if (!thresholds.length) return '指標門檻至少挑一個：先按「試跑一次」，再從「偵測到的指標」裡挑';
      const bad = thresholds.find((t) => t.target === '' || !Number.isFinite(Number(t.target)));
      if (bad) return `「${bad.name}」的門檻要是數字`;
    }
    return null;
  }

  /**
   * Save the form (create or PATCH) → the row, or null with the reason shown. `provisional`: a
   * 試跑 picked 指標門檻 before any metric was seen — save as exit 0 for now (what the store asks
   * for) and keep the form unsaved, so the thresholds picked after the run are saved next.
   */
  async function persist(provisional = false) {
    const b = collect();
    if (provisional) Object.assign(b, { pass_rule: 'exit0', metrics: null });
    const p = problem(b);
    if (p) {
      showErr(p);
      return null;
    }
    if (saved && !dirty) return saved;
    saveBtn.disabled = true;
    try {
      const row = saved ? await C.updateCheck(saved.id, b) : await C.createCheck(repo.id, { ...b, required: !['dataset', 'manual'].includes(kind), enabled: true });
      if (row && row.id) saved = { ...(saved || {}), ...row };
      else if (saved) saved = { ...saved, ...b };
      else throw new Error('建立了，但沒有拿到檢查的編號；重新整理再試');
      dirty = provisional;
      title.textContent = '編輯檢查';
      if (o.onSaved) o.onSaved();
      return saved;
    } catch (e) {
      showErr(`儲存失敗：${e.message}`);
      return null;
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function doSave() {
    showErr('');
    if (await persist()) {
      dlg.close();
      toast('已儲存');
    }
  }

  async function doTrial() {
    if (kind === 'manual' || running) return;
    showErr('');
    if (!cmdIn.value.trim()) return showErr(kind === 'dataset' ? '先填指令範本（這個 repo 要有命令列入口）' : '先填指令');
    trialBtn.disabled = true;
    const row = await persist(pass === 'metrics' && !thresholds.length);
    if (!row) return paintFoot();
    running = true;
    runErr = null;
    run = null;
    paintTrial();
    paintFoot();
    try {
      const runId = await C.startTrial(row.id);
      if (!runId) throw new Error('沒有拿到試跑的編號');
      poll(runId);
    } catch (e) {
      running = false;
      runErr = `開始不了試跑：${e.message}`;
      paintTrial();
      paintFoot();
    }
  }

  const finished = (r) => !!(r && (r.finished_at || (r.ok != null && (r.exit_code != null || r.timed_out))));

  function poll(runId) {
    running = true;
    const tick = async () => {
      if (seq !== editorSeq || !dlg.open) return;
      try {
        const r = await C.getCheckRun(runId);
        if (seq !== editorSeq) return;
        run = r.run;
        if (r.discovered.length) discovered = r.discovered;
        values = runValues(run);
        if (!finished(run)) {
          paintTrial();
          setTimeout(tick, 1500);
          return;
        }
        running = false;
        paintTrial();
        paintPass();
        paintFoot();
        if (o.onSaved) o.onSaved(); // the list's 最近一次
      } catch (e) {
        running = false;
        runErr = `讀不到試跑結果：${e.message}`;
        paintTrial();
        paintFoot();
      }
    };
    tick();
  }

  async function doBaseline(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const row = await C.setBaseline(saved.id, run.id);
      saved = row ? { ...saved, ...row } : { ...saved, baseline_json: JSON.stringify({ sha: run.head_sha || null, values, ms: run.ms != null ? run.ms : null, at: new Date().toISOString() }) };
      toast('已設為基準');
      paintPass();
      paintBase();
      if (o.onSaved) o.onSaved();
    } catch (err2) {
      toast(`設不了基準：${err2.message}`, 'bad');
      btn.disabled = false;
    }
  }

  /** the last 試跑 of a saved check — and if it is still running, keep watching it */
  async function loadLastRun() {
    if (!saved || kind === 'manual') return;
    try {
      const runs = await C.listCheckRuns(saved.id);
      const latest = runs.find((r) => !r.kind || r.kind === 'trial' || r.kind === 'baseline') || runs[0];
      if (!latest || seq !== editorSeq) return;
      const r = await C.getCheckRun(latest.id);
      if (seq !== editorSeq) return;
      run = r.run;
      discovered = r.discovered;
      values = runValues(run);
      if (!finished(run)) poll(latest.id);
      paintTrial();
      paintPass();
      paintFoot();
    } catch {
      /* no history yet, or the route is not there: the editor works without it */
    }
  }

  applyKind();
  if (kind === 'dataset') loadDatasets();
  if (!dlg.open) dlg.showModal();
  if (!saved) nameIn.focus();
  const ready = loadLastRun();
  if (o.trial) ready.then(() => !running && doTrial());
}

// =============================================================================================
// 圖資
// =============================================================================================

export function mountDatasets(el, ctx) {
  const box = h('div.rp-tabpane');
  fill(
    el,
    h(
      'div.rp-sechead',
      null,
      h('h2', null, '圖資'),
      h('span.rp-muted', null, '圖資回歸用的圖資 repo：一個原圖資料夾加一個答案檔'),
      h('span.grow'),
      h('button.btn.primary', { type: 'button', onclick: () => openDatasetDialog({ onDone: refresh }) }, '＋ 連結圖資 repo'),
    ),
    box,
  );

  function cacheCell(ds) {
    if (!ctx.repo.machine) return h('span.rp-muted', { title: '在引擎主機跑，不用另外快取' }, '—');
    const m = ctx.machines.get(ctx.repo.machine);
    if (!m) return h('span.rp-muted', null, '找不到機台');
    const line = linesOf(m).find((l) => l.label === '圖資快取' && String(l.detail || '').startsWith(`${ds.name} `));
    if (!line) return h('span.rp-muted', { title: '機台檢查時會順便看圖資快取' }, '未檢查');
    return line.ok ? h('span.rp-last.ok', null, icon('okCircle', { size: 16, sw: 2 }), '已抓好') : h('span.rp-muted', null, '還沒抓；第一次跑時會抓');
  }

  async function refresh() {
    let list;
    let checks = [];
    try {
      [list, checks] = await Promise.all([C.listDatasets(), C.listChecks(ctx.repo.id).catch(() => [])]);
    } catch (err) {
      fill(box, h('p.err-line', null, `讀不到圖資：${err.message}`));
      return;
    }
    if (!list.length) {
      fill(
        box,
        h(
          'div.rp-empty',
          null,
          icon('box', { size: 30 }),
          h('p', null, '還沒有連結圖資。圖資 repo 是一個 Gitea repo：放原圖的資料夾＋一個答案檔（json、csv 或標記檔）。'),
          h('div.rp-row', null, h('button.btn.primary', { type: 'button', onclick: () => openDatasetDialog({ onDone: refresh }) }, '＋ 連結圖資 repo')),
        ),
      );
      return;
    }
    const where = ctx.repo.machine || '引擎主機';
    const rows = list.map((ds) => {
      const used = checks.filter((c) => c.dataset_id === ds.id).map((c) => c.name);
      return h(
        'tr',
        null,
        h('td', null, h('b', null, ds.name), h('span.rp-ttl-sub.rp-mono', null, ds.remote_url || '')),
        h('td.nowrap', null, ds.cases != null ? `${Number(ds.cases).toLocaleString('zh-TW')} 張` : '—'),
        h('td', null, h('span.rp-mono', null, ds.answer_file || '—'), h('span.rp-ttl-sub', null, FORMAT[ds.answer_format] || ds.answer_format || '')),
        h('td.mono', null, ds.images_dir || '—'),
        h('td', null, cacheCell(ds)),
        h('td', null, used.length ? used.join('、') : h('span.rp-muted', null, '—')),
        h(
          'td',
          null,
          h(
            'button.btn.icon',
            {
              type: 'button',
              'aria-label': `更多：${ds.name}`,
              onclick: (e) =>
                popMenu(e.currentTarget, [
                  ['編輯', () => openDatasetDialog({ dataset: ds, onDone: refresh })],
                  'hr',
                  ['刪除', () => removeDs(ds, used)],
                ]),
            },
            icon('more', { size: 18 }),
          ),
        ),
      );
    });
    const heads = ['名稱', '張數', '答案檔', '圖片資料夾', `在 ${where} 的快取`, '這個 repo 用在'].map((t) => h('th', { scope: 'col' }, t));
    fill(box, h('div.rp-tablewrap', null, h('table.rp-table', { id: 'dataset-table' }, h('thead', null, h('tr', null, heads, h('th.th-more', { scope: 'col' }, h('span.rp-sr', null, '更多動作'), '⋯'))), h('tbody', null, rows))));
  }

  async function removeDs(ds, used) {
    const warn = used.length ? `\n這個 repo 的「${used.join('、')}」在用它；其他 repo 也可能在用。` : '\n其他 repo 也可能在用它。';
    if (!confirm(`刪除圖資「${ds.name}」？${warn}`)) return;
    try {
      await C.deleteDataset(ds.id);
      toast(`已刪除「${ds.name}」`);
      refresh();
    } catch (err) {
      toast(`刪不掉：${err.message}`, 'bad');
    }
  }

  refresh();
  return { refresh };
}

/** "http://gitea:3000/aoi/dataset-2026Q2.git" → "dataset-2026Q2" (a name the 圖資 store accepts: no spaces or separators) */
export const datasetNameOf = (url) =>
  (String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || '')
    .replace(/[^A-Za-z0-9\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 80);

/**
 * 「＋ 連結圖資 repo」: paste the URL (and a name) → confirm or correct the images folder, the
 * answer file and its format (the store starts from images / answers.json / auto). With `dataset`, just the edit.
 */
export function openDatasetDialog({ dataset = null, onDone } = {}) {
  const { dlg, title, sub, body, foot } = dialogShell('dataset-dialog');
  let ds = dataset ? { ...dataset } : null;
  const err = h('p.err-line', { hidden: true, role: 'alert' });
  const showErr = (m) => {
    err.textContent = m || '';
    err.hidden = !m;
  };
  const cancel = () => h('button.btn', { type: 'button', onclick: () => dlg.close() }, '取消');

  function paste() {
    title.textContent = '連結圖資 repo';
    sub.textContent = '';
    const urlIn = h('input.rp-in.mono', { id: 'ds-url', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'http://gitea.corp:3000/aoi/dataset-2026Q2' });
    const nameIn = h('input.rp-in', { id: 'ds-name', type: 'text', maxlength: '80', placeholder: '可留空：用 repo 的名稱' });
    const go = h('button.btn.primary', { type: 'button' }, '連結');
    fill(
      body,
      h('p.rp-muted', null, '圖資是一個 Gitea repo：放原圖的資料夾＋一個答案檔（json、csv 或標記檔）。貼上網址，下一步確認圖片資料夾、答案檔與格式。'),
      h('label.rp-f', null, h('span.cap', null, '圖資 repo 網址'), urlIn),
      h('label.rp-f', null, h('span.cap', null, '名稱'), nameIn),
      err,
    );
    fill(foot, h('span.grow'), cancel(), go);
    go.onclick = async () => {
      const url = urlIn.value.trim();
      if (!url) return showErr('先貼上圖資 repo 的網址');
      showErr('');
      go.disabled = true;
      go.textContent = '偵測中…';
      try {
        ds = await C.createDataset({ remote_url: url, name: nameIn.value.trim() || datasetNameOf(url) });
        if (!ds || !ds.id) throw new Error('沒有拿到圖資的編號');
        confirmStep(true);
      } catch (e) {
        showErr(e.message);
        go.disabled = false;
        go.textContent = '連結';
      }
    };
    urlIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go.click();
      }
    });
    setTimeout(() => urlIn.focus(), 0);
  }

  function confirmStep(fresh) {
    title.textContent = fresh ? '確認圖資' : '編輯圖資';
    sub.textContent = ds.name || '';
    const nameIn = h('input.rp-in', { id: 'ds-name2', type: 'text', maxlength: '80', value: ds.name || '' });
    const imgIn = h('input.rp-in.mono', { id: 'ds-images', type: 'text', value: ds.images_dir || '' });
    const ansIn = h('input.rp-in.mono', { id: 'ds-answers', type: 'text', value: ds.answer_file || '' });
    const fmtSel = h('select.rp-in', { id: 'ds-format' }, Object.entries(FORMAT).map(([v, s]) => h('option', { value: v, selected: v === (ds.answer_format || 'auto') }, s)));
    const save = h('button.btn.primary', { type: 'button' }, fresh ? '確認' : '儲存');
    fill(
      body,
      fresh
        ? h(
            'div.rp-callout',
            null,
            icon('okCircle', { size: 20, sw: 2 }),
            h('div.tx', null, h('b', null, '已連結'), h('p', null, `圖片在 ${ds.images_dir || '？'}、答案檔 ${ds.answer_file || '？'}（${FORMAT[ds.answer_format] || ds.answer_format || '自動判斷'}）${ds.cases != null ? `，${Number(ds.cases).toLocaleString('zh-TW')} 張` : '；張數第一次跑時會算'}。和 repo 裡不一樣就直接改。`)),
          )
        : null,
      h('div.rp-ro', null, ds.remote_url || ''),
      h('div.rp-grid2', null, h('label.rp-f', null, h('span.cap', null, '名稱'), nameIn), h('label.rp-f', null, h('span.cap', null, '答案檔格式'), fmtSel)),
      h('div.rp-grid2', null, h('label.rp-f', null, h('span.cap', null, '圖片資料夾'), imgIn), h('label.rp-f', null, h('span.cap', null, '答案檔'), ansIn)),
      err,
    );
    fill(foot, h('span.grow'), cancel(), save);
    save.onclick = async () => {
      const next = { name: nameIn.value.trim(), images_dir: imgIn.value.trim(), answer_file: ansIn.value.trim(), answer_format: fmtSel.value };
      const patch = {};
      for (const [k, v] of Object.entries(next)) if (v && v !== (ds[k] || '')) patch[k] = v;
      showErr('');
      save.disabled = true;
      try {
        if (Object.keys(patch).length) {
          const row = await C.updateDataset(ds.id, patch);
          ds = row && row.id ? row : { ...ds, ...patch };
        }
        dlg.close();
        toast(fresh ? `已連結圖資「${ds.name}」` : '已儲存');
        if (onDone) onDone(ds);
      } catch (e) {
        showErr(e.message);
        save.disabled = false;
      }
    };
  }

  if (ds) confirmStep(false);
  else paste();
  if (!dlg.open) dlg.showModal();
}
