import { $, api, el, setText, store, stored, toast, when, wireTheme } from './shell.js';
import { DATASET_NOTICE, composePrd, datasetCommand, emptyDataset, emptyForm, verifyModes } from './prd-compose.js';
import { KINDS, METHOD_NOTES, MODULE_DOMAIN } from './prd-kinds.js';

/**
 * PRD 精靈: five steps that end in a PRD the gate accepts and a Loop task the engine can run.
 *
 * The page never composes anything itself — every keystroke re-renders the form through
 * prd-compose.js and the preview shows exactly what will be sent. Server calls are small and
 * independent (repo facts, image-set counts, file suggestions, acceptance drafts, drafts,
 * check, submit); any one failing leaves the engineer with a form they can still finish by hand.
 * textContent only: file names, model output and gate messages are untrusted text.
 */

wireTheme($('theme-btn'));

const params = new URLSearchParams(location.search);
let form = emptyForm();
let step = 1;
let draftId = params.get('draft');
let repoInfo = null; // GET /api/prd/repo result for the chosen repo
let lastChecked = null; // markdown that passed the gate; submit only allows that exact text
let dsCmdEdited = false; // the engineer took over the dataset command template
let gateOff = false;
const aborts = {}; // in-flight helper requests, by name

// ---- small helpers ----------------------------------------------------------
const debounce = (fn, ms) => {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const clean = (s) => String(s == null ? '' : s).trim();

function listEditor(containerId, get, set, placeholder) {
  const box = $(containerId);
  const rows = get();
  box.replaceChildren(
    ...rows.map((value, i) => {
      const row = el('div', 'lrow');
      const input = el('input');
      input.value = value;
      input.placeholder = placeholder;
      input.oninput = () => {
        const next = get().slice();
        next[i] = input.value;
        set(next);
        changed();
      };
      const x = el('button', 'mini', '✕');
      x.type = 'button';
      x.title = '移除';
      x.onclick = () => {
        set(get().filter((_, j) => j !== i));
        listEditor(containerId, get, set, placeholder);
        changed();
      };
      row.append(input, x);
      return row;
    }),
  );
}

function chip(label, opts = {}) {
  const b = el('button', `chip toggle${opts.on ? ' on' : ''}`, label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(Boolean(opts.on)));
  if (opts.title) b.title = opts.title;
  b.onclick = opts.onClick;
  return b;
}

// ---- preview + drafts (every change funnels through here) ----------------------
const paintPreview = () => {
  const md = composePrd(form);
  $('preview-md').textContent = md;
  if (form.markdown_override == null) $('md-edit').value = md;
  const synced = form.markdown_override == null;
  setText('preview-state', synced ? '與表單同步' : '已手動編輯');
  setText('md-state', synced ? '與表單同步' : '已手動編輯，表單不再同步');
  $('md-reset').hidden = synced;
  if (lastChecked !== null && lastChecked !== md) {
    lastChecked = null;
    $('submit-btn').disabled = true;
  }
  paintVerifySummary();
};

let saving = false;
const saveDraft = debounce(async () => {
  if (gateOff) return;
  const body = { title: clean(form.change.title) || undefined, form, markdown: composePrd(form), step };
  saving = true;
  setText('draft-state', '儲存中…');
  try {
    if (draftId) await api(`/api/prd/drafts/${draftId}`, { method: 'PUT', body: JSON.stringify(body) });
    else {
      const d = await api('/api/prd/drafts', { method: 'POST', body: JSON.stringify(body) });
      draftId = d.id;
      history.replaceState(null, '', `/prd.html?draft=${encodeURIComponent(draftId)}`);
    }
    setText('draft-state', `已儲存 ${when(new Date().toISOString().replace('T', ' ').slice(0, 19))}`);
  } catch (e) {
    setText('draft-state', '未儲存（留在本頁）');
    store('loop_prd_wizard', JSON.stringify({ form, step }));
  } finally {
    saving = false;
  }
}, 800);

function changed() {
  paintPreview();
  saveDraft();
}

// ---- steps ---------------------------------------------------------------------
function showStep(n) {
  step = Math.min(5, Math.max(1, n));
  for (let i = 1; i <= 5; i++) $(`step-${i}`).hidden = i !== step;
  for (const b of document.querySelectorAll('#prd-steps .step')) {
    const s = Number(b.dataset.step);
    b.classList.toggle('current', s === step);
    b.classList.toggle('done', s < step);
  }
  if (step === 5) paintPreview();
  saveDraft();
  window.scrollTo({ top: 0 });
}
for (const b of document.querySelectorAll('#prd-steps .step')) b.onclick = () => showStep(Number(b.dataset.step));
for (const [id, n] of [['next-1', 2], ['prev-2', 1], ['next-2', 3], ['prev-3', 2], ['next-3', 4], ['prev-4', 3], ['next-4', 5], ['prev-5', 4]]) {
  $(id).onclick = () => showStep(n);
}

// ---- ① 改哪套軟體 ---------------------------------------------------------------
function paintKinds() {
  const box = $('kind-cards');
  box.replaceChildren(
    ...Object.entries(KINDS).map(([key, k]) => {
      const card = el('button', `kind-card${form.kind === key ? ' on' : ''}`);
      card.type = 'button';
      card.append(el('b', null, k.label), el('span', null, k.blurb));
      card.onclick = () => {
        form.kind = key;
        applyKind(k);
        paintKinds();
        changed();
      };
      return card;
    }),
  );
}

/** presets fill empty fields only — never over what the engineer typed */
function applyKind(k) {
  const v = form.verify;
  if (k.methods.includes('dataset') && !v.dataset) v.dataset = emptyDataset();
  if (!k.methods.includes('dataset') && v.dataset && !clean(v.dataset.input)) v.dataset = null;
  if (k.methods.includes('manual') && !v.manual.length) v.manual = [{ given: '', when: '', then: '' }];
  if (!form.scope.non_goals.length) form.scope.non_goals = k.nonGoals.slice();
  if (!form.scope.constraints.length) form.scope.constraints = k.constraints.slice();
  if (!form.acceptance.length) form.acceptance = k.acceptance.slice();
  if (form.scope.domain === 'other' && !repoInfo) form.scope.domain = k.domain;
  form.scope.complexity = form.scope.complexity || k.complexity;
  $('symptom').placeholder = k.hints.symptom;
  $('expected').placeholder = k.hints.expected;
  paintStep3();
  paintStep4();
}

async function loadRepos() {
  const sel = $('repo-select');
  sel.replaceChildren(el('option', null, '選擇 repo…'));
  sel.firstChild.value = '';
  try {
    const { sources } = await api('/api/sources');
    for (const s of sources.filter((x) => x.kind === 'git' && x.enabled)) {
      const o = el('option', null, s.uri);
      o.value = s.uri;
      sel.append(o);
    }
  } catch (e) {
    /* the manual field still works */
  }
  const manual = el('option', null, '手動輸入路徑…');
  manual.value = '__manual';
  sel.append(manual);
  if (form.repo.path) {
    const known = [...sel.options].some((o) => o.value === form.repo.path);
    sel.value = known ? form.repo.path : '__manual';
    $('repo-path').hidden = known;
    $('repo-path').value = form.repo.path;
    probeRepo(form.repo.path);
  }
}

$('repo-select').onchange = () => {
  const v = $('repo-select').value;
  $('repo-path').hidden = v !== '__manual';
  if (v === '__manual') {
    $('repo-path').focus();
    return;
  }
  form.repo.path = v;
  probeRepo(v);
  changed();
};
$('repo-path').addEventListener('change', () => {
  form.repo.path = clean($('repo-path').value);
  probeRepo(form.repo.path);
  changed();
});

async function probeRepo(p) {
  repoInfo = null;
  if (!p) return setText('repo-status', '請先選一個 repo。');
  setText('repo-status', '讀取中…');
  try {
    repoInfo = await api(`/api/prd/repo?path=${encodeURIComponent(p)}`);
  } catch (e) {
    setText('repo-status', `✗ ${e.message}`);
    $('repo-status').className = 'hint err';
    return;
  }
  $('repo-status').className = 'hint';
  setText(
    'repo-status',
    repoInfo.is_git
      ? `✓ git repo，目前分支 ${repoInfo.branch || '（detached）'}${repoInfo.registered ? '，已在知識庫' : '，尚未登錄到知識庫（「用知識庫找」會找不到）'}`
      : '✗ 這不是 git repo：任務會卡在入場審核',
  );
  const bs = $('branch-select');
  bs.replaceChildren();
  const branches = repoInfo.branches.length ? repoInfo.branches : [form.repo.branch || 'main'];
  for (const b of branches) {
    const o = el('option', null, b);
    o.value = b;
    bs.append(o);
  }
  if (!branches.includes(form.repo.branch)) form.repo.branch = repoInfo.branch && branches.includes(repoInfo.branch) ? repoInfo.branch : branches[0];
  bs.value = form.repo.branch;
  paintModules();
  setText('host-caps', repoInfo.host_capabilities.length ? `本主機能力：${repoInfo.host_capabilities.join('、')}` : '本主機沒有登記任何能力（host_capabilities 未設）：需要 GPU 的驗證會自動改成人工。');
  paintCmdPresets();
  paintVerifySummary();
}
$('branch-select').onchange = () => {
  form.repo.branch = $('branch-select').value;
  changed();
};

function paintModules() {
  const box = $('module-chips');
  if (!repoInfo || !repoInfo.dirs.length) return box.replaceChildren(el('span', 'hint', '這個 repo 沒有頂層子目錄。'));
  box.replaceChildren(
    ...repoInfo.dirs.map((d) =>
      chip(d, {
        on: form.repo.module === d,
        onClick: () => {
          form.repo.module = form.repo.module === d ? null : d;
          if (form.repo.module && MODULE_DOMAIN[form.repo.module]) {
            form.scope.domain = MODULE_DOMAIN[form.repo.module];
            $('domain-select').value = form.scope.domain;
          }
          paintModules();
          changed();
        },
      }),
    ),
  );
}

// ---- ② 要改什麼 ------------------------------------------------------------------
for (const [id, key] of [['title', 'title'], ['symptom', 'symptom'], ['expected', 'expected']]) {
  $(id).addEventListener('input', () => {
    form.change[key] = $(id).value;
    changed();
  });
}

function paintFiles() {
  const box = $('file-chips');
  box.replaceChildren(
    ...form.change.files.map((f, i) => {
      const c = el('span', 'chip file');
      c.append(el('code', null, f.path));
      if (f.why) c.append(el('span', 'why', ` — ${f.why}`));
      const x = el('button', 'x', '✕');
      x.type = 'button';
      x.onclick = () => {
        form.change.files.splice(i, 1);
        paintFiles();
        changed();
      };
      c.append(x);
      return c;
    }),
  );
  if (!form.change.files.length) box.append(el('span', 'hint', '還沒有列出檔案（可以不填，但模型會多花時間找）。'));
}

$('file-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const p = clean($('file-input').value);
  if (!p) return;
  if (!form.change.files.some((f) => f.path === p)) form.change.files.push({ path: p, why: '' });
  $('file-input').value = '';
  paintFiles();
  changed();
});

$('suggest-btn').onclick = async () => {
  const description = [clean(form.change.symptom), clean(form.change.expected), clean(form.change.title)].filter(Boolean).join('。');
  if (!description) return toast('先寫症狀或期望，才有東西可以找', 'warn');
  if (!form.repo.path) return toast('先在第 1 步選 repo', 'warn');
  aborts.suggest = new AbortController();
  $('suggest-btn').disabled = true;
  $('suggest-cancel').hidden = false;
  setText('suggest-status', '本地模型正在找相關檔案（幾十秒）…');
  const timer = setTimeout(() => aborts.suggest?.abort(), 90000);
  try {
    const r = await api('/api/prd/suggest-files', {
      method: 'POST',
      body: JSON.stringify({ repo_path: form.repo.path, module: form.repo.module, description }),
      signal: aborts.suggest.signal,
    });
    paintSuggestions(r);
    setText('suggest-status', r.ranked ? `找到 ${r.files.length} 個候選（本地模型已排序；關鍵字：${r.keywords.join('、') || '—'}）` : `找到 ${r.files.length} 個候選（模型沒排序，照檢索相關度）`);
  } catch (e) {
    setText('suggest-status', e.name === 'AbortError' ? '已取消' : `找不到：${e.message}`);
  } finally {
    clearTimeout(timer);
    $('suggest-btn').disabled = false;
    $('suggest-cancel').hidden = true;
    aborts.suggest = null;
  }
};
$('suggest-cancel').onclick = () => aborts.suggest?.abort();

function paintSuggestions(r) {
  const box = $('suggest-results');
  box.replaceChildren(
    ...r.files.map((f) => {
      const row = el('label', 'suggest-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.path = f.path;
      cb.dataset.why = f.why || '';
      row.append(cb, el('code', null, f.path));
      if (f.lines) row.append(el('span', 'lines', ` L${f.lines}`));
      if (f.why) row.append(el('span', 'why', ` — ${f.why}`));
      return row;
    }),
  );
  $('suggest-add').hidden = !r.files.length;
}
$('suggest-add').onclick = () => {
  for (const cb of document.querySelectorAll('#suggest-results input:checked')) {
    if (!form.change.files.some((f) => f.path === cb.dataset.path)) form.change.files.push({ path: cb.dataset.path, why: cb.dataset.why });
  }
  $('suggest-results').replaceChildren();
  $('suggest-add').hidden = true;
  paintFiles();
  changed();
};

// ---- ③ 怎麼驗證 ------------------------------------------------------------------
setText('note-cmd', METHOD_NOTES.cmd);
setText('note-dataset', METHOD_NOTES.dataset);
setText('note-manual', METHOD_NOTES.manual);

function paintCmdPresets() {
  const box = $('cmd-presets');
  const presets = [];
  const p = repoInfo?.presets;
  if (p?.npm_test) presets.push('npm test');
  if (p?.cmake) presets.push('ctest --test-dir ip/build', './ip/build/rules_verify', './ip/build/edge_verify');
  if (p?.pytest) presets.push('pytest');
  for (const s of p?.verify_scripts || []) presets.push(`python3 scripts/${s}`);
  box.replaceChildren(
    ...(presets.length ? presets : ['npm test']).map((c) =>
      chip(c, {
        title: '加入這條指令',
        onClick: () => {
          if (!form.verify.commands.includes(c)) form.verify.commands.push(c);
          $('m-cmd-on').checked = true;
          $('m-cmd').open = true;
          paintStep3();
          changed();
        },
      }),
    ),
  );
}

function paintStep3() {
  const v = form.verify;
  $('m-cmd-on').checked = v.commands.length > 0;
  listEditor('cmd-list', () => v.commands, (a) => (v.commands = a), '例：ctest --test-dir ip/build');
  $('m-dataset-on').checked = Boolean(v.dataset);
  if (v.dataset) {
    const ds = v.dataset;
    $('ds-input').value = ds.input || '';
    $('ds-golden').value = ds.golden || '';
    $('ds-recipe').value = ds.recipe || 'DEFAULT';
    $('ds-fp').value = ds.fp_rate ?? '';
    $('ds-miss').value = ds.miss ?? '';
    $('ds-tol').value = ds.tol ?? '';
    if (!dsCmdEdited || !ds.commands.length) $('ds-cmd').value = ds.commands[0] || datasetCommand(ds);
    setText('ds-requires', (ds.requires || ['gpu']).join(', '));
  }
  $('m-manual-on').checked = v.manual.length > 0;
  paintManual();
  $('m-llm').checked = Boolean(v.llm);
  listEditor('acc-list', () => form.acceptance, (a) => (form.acceptance = a), 'Given … When … Then …');
  paintVerifySummary();
}

function paintManual() {
  const box = $('manual-rows');
  box.replaceChildren(
    ...form.verify.manual.map((row, i) => {
      const r = el('div', 'gwt-row');
      for (const [k, ph] of [['given', 'Given：前提'], ['when', 'When：動作'], ['then', 'Then：可看到的結果']]) {
        const input = el('input');
        input.placeholder = ph;
        input.value = row[k] || '';
        input.oninput = () => {
          row[k] = input.value;
          changed();
        };
        r.append(input);
      }
      const x = el('button', 'mini', '✕');
      x.type = 'button';
      x.onclick = () => {
        form.verify.manual.splice(i, 1);
        paintManual();
        changed();
      };
      r.append(x);
      return r;
    }),
  );
}

$('m-cmd-on').onchange = () => {
  if (!$('m-cmd-on').checked) form.verify.commands = [];
  else if (!form.verify.commands.length) form.verify.commands = [''];
  $('m-cmd').open = $('m-cmd-on').checked;
  paintStep3();
  changed();
};
$('cmd-add').onclick = () => {
  form.verify.commands.push('');
  $('m-cmd-on').checked = true;
  paintStep3();
};
$('m-dataset-on').onchange = () => {
  form.verify.dataset = $('m-dataset-on').checked ? form.verify.dataset || emptyDataset() : null;
  $('m-dataset').open = $('m-dataset-on').checked;
  paintStep3();
  changed();
};
for (const [id, key, numeric] of [['ds-input', 'input'], ['ds-golden', 'golden'], ['ds-recipe', 'recipe'], ['ds-fp', 'fp_rate', true], ['ds-miss', 'miss', true], ['ds-tol', 'tol', true]]) {
  $(id).addEventListener('input', () => {
    if (!form.verify.dataset) form.verify.dataset = emptyDataset();
    const raw = $(id).value;
    form.verify.dataset[key] = numeric ? (raw === '' ? null : Number(raw)) : raw;
    if (!dsCmdEdited) {
      form.verify.dataset.commands = [];
      $('ds-cmd').value = datasetCommand(form.verify.dataset);
    }
    $('m-dataset-on').checked = true;
    changed();
  });
}
$('ds-cmd').addEventListener('input', () => {
  if (!form.verify.dataset) form.verify.dataset = emptyDataset();
  dsCmdEdited = true;
  form.verify.dataset.commands = [$('ds-cmd').value.replace(/\n+/g, ' ').trim()];
  changed();
});
for (const [btn, inputId, statId] of [['ds-input-check', 'ds-input', 'ds-input-stat'], ['ds-golden-check', 'ds-golden', 'ds-golden-stat']]) {
  $(btn).onclick = async () => {
    const p = clean($(inputId).value);
    if (!p) return setText(statId, '先填路徑');
    setText(statId, '檢查中…');
    try {
      const s = await api(`/api/prd/stat?path=${encodeURIComponent(p)}`);
      setText(statId, s.kind === 'dir' ? `✓ 目錄：${s.images} 張影像、${s.result_json} 個 ResultInfo.json` : '✓ 檔案存在');
    } catch (e) {
      setText(statId, `✗ ${e.message}`);
    }
  };
}
$('m-manual-on').onchange = () => {
  form.verify.manual = $('m-manual-on').checked ? form.verify.manual.length ? form.verify.manual : [{ given: '', when: '', then: '' }] : [];
  $('m-manual').open = $('m-manual-on').checked;
  paintStep3();
  changed();
};
$('manual-add').onclick = () => {
  form.verify.manual.push({ given: '', when: '', then: '' });
  $('m-manual-on').checked = true;
  paintManual();
};
$('draft-acc-btn').onclick = async () => {
  const description = [clean(form.change.symptom), clean(form.change.title)].filter(Boolean).join('。');
  if (!description) return toast('先在第 2 步寫症狀', 'warn');
  aborts.acc = new AbortController();
  $('draft-acc-btn').disabled = true;
  $('draft-acc-cancel').hidden = false;
  setText('draft-acc-status', '本地模型正在寫草稿…');
  const timer = setTimeout(() => aborts.acc?.abort(), 90000);
  try {
    const method = verifyModes(form).join(',') || 'manual';
    const r = await api('/api/prd/draft-acceptance', {
      method: 'POST',
      body: JSON.stringify({ description, expected: form.change.expected, method, module: form.repo.module }),
      signal: aborts.acc.signal,
    });
    for (const line of r.items) {
      if (!form.acceptance.includes(line)) form.acceptance.push(line);
    }
    setText('draft-acc-status', `已加入 ${r.items.length} 條到「驗收標準」，請改成你要的數字`);
    paintStep3();
    changed();
  } catch (e) {
    setText('draft-acc-status', e.name === 'AbortError' ? '已取消' : `寫不出來：${e.message}`);
  } finally {
    clearTimeout(timer);
    $('draft-acc-btn').disabled = false;
    $('draft-acc-cancel').hidden = true;
    aborts.acc = null;
  }
};
$('draft-acc-cancel').onclick = () => aborts.acc?.abort();
$('m-llm').onchange = () => {
  form.verify.llm = $('m-llm').checked;
  changed();
};
$('acc-add').onclick = () => {
  form.acceptance.push('');
  paintStep3();
};

function paintVerifySummary() {
  const modes = verifyModes(form);
  const requires = form.verify.dataset ? form.verify.dataset.requires || ['gpu'] : [];
  const caps = repoInfo?.host_capabilities || [];
  const missing = requires.filter((r) => !caps.includes(r));
  const parts = [`verify_mode = ${modes.join(', ') || '（還沒選）'}`];
  if (requires.length) parts.push(`requires = ${requires.join(', ')}`);
  if (missing.length && repoInfo) parts.push(`⚠ 本主機缺 ${missing.join('、')}：指令驗證會被跳過、改成人工`);
  if (form.verify.llm) parts.push('AI 評審會花 token');
  setText('verify-summary', parts.join('　·　'));
  $('verify-summary').classList.toggle('warn', missing.length > 0 && Boolean(repoInfo));
}

// ---- ④ 範圍與限制 ----------------------------------------------------------------
function paintStep4() {
  listEditor('nongoal-list', () => form.scope.non_goals, (a) => (form.scope.non_goals = a), '例：不改 recipe 格式');
  listEditor('constraint-list', () => form.scope.constraints, (a) => (form.scope.constraints = a), '例：輸出必須 bit-exact');
  $('domain-select').value = form.scope.domain || 'other';
  $('cx-chips').replaceChildren(
    ...['S', 'M', 'L'].map((c) =>
      chip(c, {
        on: form.scope.complexity === c,
        onClick: () => {
          form.scope.complexity = c;
          paintStep4();
          changed();
        },
      }),
    ),
  );
  $('setup-cmd').value = form.scope.setup.join('\n');
}
$('nongoal-add').onclick = () => {
  form.scope.non_goals.push('');
  paintStep4();
};
$('constraint-add').onclick = () => {
  form.scope.constraints.push('');
  paintStep4();
};
$('domain-select').onchange = () => {
  form.scope.domain = $('domain-select').value;
  changed();
};
$('setup-cmd').addEventListener('input', () => {
  form.scope.setup = $('setup-cmd')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  changed();
});

// ---- ⑤ 預覽與送出 ----------------------------------------------------------------
$('md-edit').addEventListener('input', () => {
  form.markdown_override = $('md-edit').value;
  paintPreview();
  saveDraft();
});
$('md-reset').onclick = () => {
  form.markdown_override = null;
  changed();
};
$('copy-btn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(composePrd(form));
    toast('已複製 PRD', 'ok');
  } catch (e) {
    toast('這個瀏覽器不給複製，請從右側手動選取', 'warn');
  }
};

async function loadModels() {
  const sel = $('model-select');
  try {
    const { models } = await api('/api/local/models');
    for (const m of models.filter((x) => x.enabled)) {
      const o = el('option', null, `${m.display_name}（本地）`);
      o.value = `local:${m.id}`;
      sel.append(o);
    }
  } catch (e) {
    /* leave the default */
  }
  for (const alias of ['sonnet', 'opus']) {
    const o = el('option', null, `${alias}（雲端，花 token）`);
    o.value = alias;
    sel.append(o);
  }
}

function ul(id, items, cls) {
  const box = $(id);
  box.replaceChildren(...items.map((t) => el('li', cls || null, t)));
  box.hidden = !items.length;
}

function renderCheck(check) {
  $('result-empty').hidden = true;
  $('result').hidden = false;
  const v = $('verdict');
  v.textContent = check.ok ? '✓ 檢查通過，可以建立任務' : '✗ 還不能建立任務——先補下面這些';
  v.className = check.ok ? 'ok' : 'err';
  ul('missing', check.missing || []);
  ul('warnings', check.warnings || []);
  const llm = check.llm || {};
  setText(
    'llm-status',
    llm.status === 'ok'
      ? llm.ok
        ? '本地模型審查：通過'
        : '本地模型審查：有疑慮（見下）'
      : llm.status === 'skipped'
        ? '本地模型審查：規則檢查沒過，這次沒有審'
        : llm.status === 'unavailable'
          ? '本地模型審查：模型未載入，這次只有規則檢查'
          : `本地模型審查失敗：${llm.error || ''}`,
  );
  ul('questions', [...(llm.missing || []), ...(llm.questions || [])]);
  ul('risks', llm.risk_notes || []);
  const f = check.fields || {};
  const rows = [
    ['標題', f.title],
    ['Repo', f.repo_path ? `${f.repo_path} @ ${f.base_branch || 'main'}` : null],
    ['領域／複雜度', f.domain ? `${f.domain} / ${f.complexity || 'M'}` : null],
    ['驗證指令', (f.verify_steps || []).length ? `${f.verify_steps.length} 條` : '無'],
    ['驗證方式', (f.verify_mode || []).join(', ') || '（依段落推導）'],
    ['圖集', f.dataset ? f.dataset.input : null],
    ['人工驗收', (f.manual_checks || []).length ? `${f.manual_checks.length} 條` : null],
    ['需求能力', f.requires],
    ['前置指令', (f.setup_steps || []).length ? `${f.setup_steps.length} 條` : null],
  ].filter(([, val]) => val != null);
  const dl = $('fields');
  dl.replaceChildren(...rows.flatMap(([k, val]) => [el('dt', null, k), el('dd', null, String(val))]));
}

$('check-btn').onclick = async () => {
  const markdown = composePrd(form);
  $('check-btn').disabled = true;
  $('result-empty').hidden = false;
  setText('result-empty', '檢查中（規則幾秒、本地模型審查幾十秒）…');
  $('result').hidden = true;
  try {
    const check = await api('/api/prd/check', { method: 'POST', body: JSON.stringify({ markdown }) });
    renderCheck(check);
    lastChecked = check.ok ? markdown : null;
    $('submit-btn').disabled = !check.ok;
  } catch (e) {
    setText('result-empty', `檢查失敗：${e.message}`);
  } finally {
    $('check-btn').disabled = false;
  }
};

$('submit-btn').onclick = async () => {
  const markdown = composePrd(form);
  if (lastChecked !== markdown) return toast('內容變了，請再檢查一次', 'warn');
  $('submit-btn').disabled = true;
  const box = $('submit-result');
  box.replaceChildren(el('p', 'hint', '建立中…'));
  try {
    const r = await api('/api/prd', {
      method: 'POST',
      body: JSON.stringify({
        markdown,
        model: $('model-select').value || null,
        queue: $('queue-box').checked,
        verify_llm: Boolean(form.verify.llm),
        draft_id: draftId || undefined,
      }),
    });
    const p = el('p', 'ok');
    p.append(`✓ 已建立任務 ${r.task.id}（${r.task.status}）　`);
    const a = el('a', null, '在看板打開 →');
    a.href = `/board.html#task=${encodeURIComponent(r.task.id)}`;
    p.append(a);
    box.replaceChildren(p);
    if (r.gate && r.gate.warnings && r.gate.warnings.length) box.append(el('p', 'warn', `入場審核提醒：${r.gate.warnings.join('；')}`));
    if (r.gate && r.gate.missing && r.gate.missing.length) box.append(el('p', 'err', `入場審核未過（任務留在草稿）：${r.gate.missing.join('；')}`));
    setText('draft-state', '已建成任務');
    toast(`已建立任務 ${r.task.id}`, 'ok', { text: '在看板打開 ↗', href: `/board.html#task=${r.task.id}` });
  } catch (e) {
    box.replaceChildren(el('p', 'err', `建立失敗：${e.message}`));
    if (e.body && e.body.check) renderCheck(e.body.check);
    $('submit-btn').disabled = false;
  }
};

// ---- boot ----------------------------------------------------------------------
function paintAll() {
  paintKinds();
  if (form.kind && KINDS[form.kind]) {
    $('symptom').placeholder = KINDS[form.kind].hints.symptom;
    $('expected').placeholder = KINDS[form.kind].hints.expected;
  }
  $('title').value = form.change.title || '';
  $('symptom').value = form.change.symptom || '';
  $('expected').value = form.change.expected || '';
  paintFiles();
  paintStep3();
  paintStep4();
  paintPreview();
}

function hydrate(f, atStep) {
  form = { ...emptyForm(), ...f };
  form.repo = { ...emptyForm().repo, ...(f.repo || {}) };
  form.change = { ...emptyForm().change, ...(f.change || {}) };
  form.verify = { ...emptyForm().verify, ...(f.verify || {}) };
  form.scope = { ...emptyForm().scope, ...(f.scope || {}) };
  dsCmdEdited = Boolean(form.verify.dataset && form.verify.dataset.commands && form.verify.dataset.commands.length);
  paintAll();
  showStep(atStep || 1);
}

async function boot() {
  try {
    await api('/api/prd/template'); // cheapest gate probe
  } catch (e) {
    if (e.status === 404) {
      gateOff = true;
      $('disabled-note').hidden = false;
    }
  }
  await Promise.all([loadRepos(), loadModels()]);

  if (draftId) {
    try {
      const d = await api(`/api/prd/drafts/${draftId}`);
      hydrate(JSON.parse(d.form_json || '{}'), d.step);
      if (d.status === 'submitted') setText('draft-state', `已建成任務 ${d.task_id || ''}`);
      else setText('draft-state', `草稿 · 上次 ${when(d.updated_at)}`);
      await loadRepos();
      return;
    } catch (e) {
      toast('找不到那份草稿，從頭開始', 'warn');
      draftId = null;
      history.replaceState(null, '', '/prd.html');
    }
  }
  const local = stored('loop_prd_wizard');
  if (local) {
    try {
      const { form: f, step: s } = JSON.parse(local);
      hydrate(f, s);
      await loadRepos();
      setText('draft-state', '從本頁上次未儲存的內容還原');
      return;
    } catch (e) {
      /* ignore */
    }
  }
  const legacy = stored('loop_prd_draft');
  if (legacy && legacy.trim()) {
    $('legacy-banner').hidden = false;
    $('legacy-import').onclick = async () => {
      try {
        const { form: f } = await api('/api/prd/parse', { method: 'POST', body: JSON.stringify({ markdown: legacy }) });
        hydrate(f, 5);
        await loadRepos();
        localStorage.removeItem('loop_prd_draft');
        $('legacy-banner').hidden = true;
        toast('已匯入舊草稿；解析不到的部分留在「目標」裡', 'ok');
      } catch (e) {
        toast(`匯入失敗：${e.message}`, 'bad');
      }
    };
    $('legacy-drop').onclick = () => {
      localStorage.removeItem('loop_prd_draft');
      $('legacy-banner').hidden = true;
    };
  }
  paintAll();
  showStep(1);
}

boot();
