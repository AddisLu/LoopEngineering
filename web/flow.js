// 工作流程: one place to start work and follow it (replaces the PRD 精靈 and 新工作).
//   /flow.html            → start: say what you want, pick a 驗證方案 or a change type
//   /flow.html?draft=<id> → editor: the task's stages as nodes (需求 → 準備環境 → AI 實作 → 驗證 →
//                           驗收門檻 → 人工核可 → 合併 → 結案); click a node to fill it in (NDV)
//   /flow.html?task=<id>  → run: the same stages lit by what the task did, and every attempt
// The form behind the canvas is the PRD form (web/prd-compose.js composes the Markdown the gate
// reads), so a flow is exactly a PRD. textContent-only.
import { $, fill, h, icon, api, mountRail, dur, tokens, hhmm, shortTime, modelName, isLocal } from './frame.js';
import { createCanvas } from './flow/canvas.js';
import { composePrd, emptyForm, emptyDataset } from './prd-compose.js';
import { KINDS } from './prd-kinds.js';
import { hbars, fmtNum } from './charts.js';

mountRail('flow');

const qs = new URLSearchParams(location.search);
const hashQuery = () => new URLSearchParams((location.hash.split('?')[1] || ''));
const DOMAINS = [
  ['cuda', 'CUDA／GPU'],
  ['cv', '影像處理'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
  ['other', '其他'],
];
const CLOUD_MODELS = [
  ['sonnet', 'sonnet', '雲端 · 快、省'],
  ['opus', 'opus', '雲端 · 最強'],
  ['haiku', 'haiku', '雲端 · 最省'],
];
const JUDGES = ['opus', 'sonnet', 'fable-5'];
const OP_TEXT = { '<=': '≤', '>=': '≥', '==': '=', '!=': '≠' };

function notice(msg, kind) {
  const n = $('notice');
  n.hidden = !msg;
  n.className = `notice${kind === 'info' ? ' info' : ''}`;
  n.textContent = msg || '';
}

function show(view) {
  for (const v of ['start', 'editor', 'run']) $(`view-${v}`).hidden = v !== view;
}

/** deep-merge a stored form over an empty one: old drafts miss fields added since */
function mergeForm(stored) {
  const base = emptyForm();
  const f = { ...base, ...(stored || {}) };
  for (const k of ['repo', 'change', 'verify', 'scope']) f[k] = { ...base[k], ...((stored || {})[k] || {}) };
  f.verify.metrics = f.verify.metrics || [];
  f.verify.artifacts = f.verify.artifacts || [];
  f.scope.protected = f.scope.protected || [];
  f.flow = { type: 'task', models: [], judges: ['opus'], ...((stored || {}).flow || {}) };
  return f;
}

// the steps a 驗證方案 gives a task: aimed at its machine, {dataset} filled in (src/plans/store.ts planSteps)
function planSteps(plan, dataset) {
  const prefix = !plan.host ? '' : plan.host === 'local' ? 'sandbox: ' : `sandbox@${plan.host}: `;
  return (plan.steps || []).map((s) => {
    const cmd = dataset ? s.split('{dataset}').join(dataset) : s;
    return /^sandbox(@[a-z0-9][a-z0-9_-]*)?\s*:/i.test(cmd) ? cmd : `${prefix}${cmd}`;
  });
}

function applyPlan(f, plan) {
  const ds = plan.dataset_root && plan.dataset_default ? `${plan.dataset_root}/${plan.dataset_default}` : null;
  f.plan_id = plan.id;
  f.verify.commands = planSteps(plan, ds);
  f.verify.metrics = String(plan.metrics || '')
    .split(/\s*;\s*/)
    .filter(Boolean);
  f.verify.artifacts = [...(plan.artifacts || [])];
  f.scope.protected = [...(plan.protected_paths || [])];
  if (plan.manual_checks?.length) f.verify.manual = plan.manual_checks.map((m) => ({ given: '', when: '', then: m }));
  if (plan.setup_cmd) f.scope.setup = [plan.setup_cmd];
  if (plan.domain) f.scope.domain = plan.domain;
  if (plan.repo_path && !f.repo.path) f.repo.path = plan.repo_path;
  if (!f.scope.non_goals.length) f.scope.non_goals = [`不修改驗證方案「${plan.name}」用來量測的評估程式、標準答案與設定`, '不做與目標無關的重構、改名或格式調整'];
}

function applyKind(f, key) {
  const k = KINDS[key];
  if (!k) return;
  f.kind = key;
  if (!f.scope.non_goals.length) f.scope.non_goals = [...k.nonGoals];
  if (!f.scope.constraints.length) f.scope.constraints = [...k.constraints];
  if (!f.acceptance.length) f.acceptance = [...k.acceptance];
  if (!f.plan_id) {
    f.scope.domain = k.domain;
    f.scope.complexity = k.complexity;
  }
}

const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || p;

// =============================== start =======================================================
let options = { repos: [], models: [], default_model: null };
let plans = [];
let startState = { type: 'task', plan: null, kind: null };

async function loadOptions() {
  try {
    options = await api('/api/jobs/options');
  } catch (e) {
    options = { repos: [], models: [], default_model: null };
  }
  try {
    ({ plans } = await api('/api/verify-plans'));
  } catch (e) {
    plans = [];
  }
}

function fillRepos(sel, branchSel, current, currentBranch) {
  fill(sel, );
  const repos = options.repos || [];
  for (const r of repos) sel.appendChild(h('option', { value: r.path }, r.name || baseName(r.path)));
  if (current && !repos.some((r) => r.path === current)) sel.appendChild(h('option', { value: current }, baseName(current)));
  if (current) sel.value = current;
  const paintBranches = () => {
    const r = repos.find((x) => x.path === sel.value);
    const list = r?.branches?.length ? r.branches : [r?.branch || currentBranch || 'main'];
    fill(branchSel, ...list.map((b) => h('option', { value: b }, b)));
    branchSel.value = currentBranch && list.includes(currentBranch) ? currentBranch : r?.branch || list[0];
  };
  sel.onchange = paintBranches;
  paintBranches();
}

async function startView() {
  show('start');
  $('flow-title').textContent = '新工作流程';
  $('tabs').hidden = true;
  fill($('top-actions'), );
  await loadOptions();
  const pre = hashQuery();
  const text = [pre.get('title'), pre.get('symptom'), pre.get('expected')].filter(Boolean).join('\n');
  if (text && !$('goal').value) $('goal').value = text;
  fillRepos($('repo'), $('branch'), null, null);

  for (const b of $('types').querySelectorAll('[data-type]')) {
    b.onclick = () => {
      startState.type = b.dataset.type;
      for (const x of $('types').querySelectorAll('[data-type]')) x.setAttribute('aria-checked', String(x === b));
    };
  }

  // 驗證方案 cards
  const planCards = plans.map((p) =>
    h(
      'button.tcard',
      {
        type: 'button',
        'aria-pressed': 'false',
        onclick: (e) => {
          const on = startState.plan?.id !== p.id;
          startState.plan = on ? p : null;
          for (const x of $('plans').querySelectorAll('.tcard')) x.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', String(on));
          if (on && p.repo_path) fillRepos($('repo'), $('branch'), p.repo_path, null);
        },
      },
      h('b', null, p.name),
      p.description ? h('span.d', null, p.description) : null,
      h(
        'span.chips',
        null,
        ...String(p.metrics || '')
          .split(/\s*;\s*/)
          .filter(Boolean)
          .slice(0, 3)
          .map((m) => h('span.chip-s.mono', null, m.replace(/(<=|>=|==|!=)/, (o) => OP_TEXT[o]))),
        (p.protected_paths || []).length ? h('span.chip-s', null, `保護 ${p.protected_paths.length} 條`) : null,
        p.host ? h('span.chip-s', null, p.host === 'local' ? 'GPU 沙盒' : `機台 ${p.host}`) : null,
      ),
    ),
  );
  planCards.push(h('a.tcard.dashed', { href: '/plans.html', style: { alignItems: 'center', justifyContent: 'center', textDecoration: 'none' } }, icon('plus', { size: 20 }), h('span.d', null, '新增驗證方案')));
  fill($('plans'), ...planCards);

  // change types
  const kindCards = Object.entries(KINDS).map(([key, k]) =>
    h(
      'button.tcard',
      {
        type: 'button',
        'aria-pressed': 'false',
        onclick: (e) => {
          const on = startState.kind !== key;
          startState.kind = on ? key : null;
          for (const x of $('kinds').querySelectorAll('.tcard[data-kind]')) x.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', String(on));
          if (on && !$('goal').value.trim()) $('goal').placeholder = `${k.hints.symptom}\n${k.hints.expected}`;
        },
        dataset: { kind: key },
      },
      h('b', null, k.label),
      h('span.d', null, k.blurb),
    ),
  );
  kindCards.push(h('button.tcard.dashed', { type: 'button', onclick: () => $('paste-dialog').showModal() }, h('b', null, '貼上 PRD'), h('span.d', null, 'Markdown 轉成流程')));
  fill($('kinds'), ...kindCards);

  // recent drafts
  try {
    const { drafts } = await api('/api/prd/drafts?limit=8');
    fill($('drafts'), 
      ...(drafts.length
        ? drafts.map((d) =>
            h(
              'a',
              { href: d.status === 'submitted' && d.task_id ? `/flow.html?task=${encodeURIComponent(d.task_id)}` : `/flow.html?draft=${encodeURIComponent(d.id)}` },
              h('span.t', null, d.title),
              h(`span.chip-s${d.status === 'submitted' ? '.ok' : ''}`, null, d.status === 'submitted' ? '已送出' : '草稿'),
              h('span.w', null, shortTime(d.updated_at)),
            ),
          )
        : [h('p.empty-s', null, '還沒有草稿。')]),
    );
  } catch (e) {
    if (e.status === 404) notice('PRD 閘門沒有開（prd_gate_enabled=false）：工作流程要靠它檢查需求。可以用 loop config set prd_gate_enabled true 打開，或先用總覽的「新增單一任務（進階）」。');
    fill($('drafts'), h('p.empty-s', null, '讀不到草稿。'));
  }

  $('create').onclick = createFromStart;
}

async function createFromStart() {
  const err = $('start-err');
  err.hidden = true;
  const text = $('goal').value.trim();
  if (text.replace(/\s+/g, '').length < 8) {
    err.hidden = false;
    err.textContent = '先用一兩句話寫要做什麼（現在哪裡不對、改好後應該怎樣）。';
    return;
  }
  const f = mergeForm(null);
  f.repo = { path: $('repo').value || '', branch: $('branch').value || 'main', module: null };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  f.change.title = (lines[0] || text).replace(/[。．.]$/, '').slice(0, 60);
  f.change.expected = lines.length > 1 ? lines.slice(1).join(' ') : text;
  if (lines.length > 1) f.change.symptom = lines[0];
  if (startState.plan) applyPlan(f, startState.plan);
  if (startState.kind) applyKind(f, startState.kind);
  if (!f.scope.non_goals.length) f.scope.non_goals = ['不做與目標無關的重構、改名或格式調整'];
  // the gate needs a 範圍 line; this one says so plainly until files are named
  if (!f.change.files.length && !f.change.extra.length) f.change.extra = [`修改 ${baseName(f.repo.path) || '這個 repo'} 中與目標直接相關的程式；位置由實作者讀程式碼後判斷，只做達成目標所需的最小修改`];
  if (!f.acceptance.length) f.acceptance = [`Given 修改後的程式 When 在現況描述的情境下執行 Then ${f.change.expected.slice(0, 200)}`];
  f.flow.type = startState.type;
  const dm = options.default_model && options.default_model !== 'default' ? options.default_model : 'sonnet';
  f.flow.models = startState.type === 'bench' ? [dm, ...(options.models || []).slice(0, 1).map((m) => m.id)].filter((v, i, a) => v && a.indexOf(v) === i) : [dm];
  try {
    const d = await api('/api/prd/drafts', 'POST', { title: f.change.title, form: f, markdown: composePrd(f), step: 1 });
    location.href = `/flow.html?draft=${encodeURIComponent(d.id)}`;
  } catch (e) {
    err.hidden = false;
    err.textContent = e.status === 404 ? 'PRD 閘門沒有開，建不了工作流程（prd_gate_enabled）。' : `建不起來：${e.message}`;
  }
}

$('paste-close').onclick = () => $('paste-dialog').close();
$('paste-cancel').onclick = () => $('paste-dialog').close();
$('paste-go').onclick = async () => {
  const md = $('paste-md').value.trim();
  $('paste-err').hidden = true;
  if (!md) return;
  try {
    const { form } = await api('/api/prd/parse', 'POST', { markdown: md });
    const f = mergeForm(form);
    f.flow.models = [options.default_model && options.default_model !== 'default' ? options.default_model : 'sonnet'];
    const d = await api('/api/prd/drafts', 'POST', { title: f.change.title || '貼上的 PRD', form: f, markdown: composePrd(f), step: 1 });
    location.href = `/flow.html?draft=${encodeURIComponent(d.id)}`;
  } catch (e) {
    $('paste-err').hidden = false;
    $('paste-err').textContent = e.message;
  }
};

// =============================== the stage canvas =============================================
const STAGES = {
  need: { title: '需求', icon: 'bolt', cls: 'trigger', w: 156 },
  setup: { title: '準備環境', icon: 'box', w: 134 },
  ai: { title: 'AI 實作', icon: 'spark', cls: 'cluster', w: 180, h: 84 },
  split: { title: 'AI 拆解', icon: 'spark', cls: 'cluster', w: 180, h: 84 },
  kids: { title: '子任務', icon: 'flow', w: 170 },
  verify: { title: '驗證', icon: 'term', w: 144 },
  gate: { title: '驗收門檻', icon: 'gate', w: 150 },
  approve: { title: '人工核可', icon: 'person', w: 134 },
  merge: { title: '合併', icon: 'merge', w: 124 },
  final: { title: '最終量測', icon: 'chip', w: 140 },
  judge: { title: '評審', icon: 'scale', w: 128 },
  done: { title: '結案', icon: 'flag', cls: 'end', w: 56, h: 56 },
};

/** which stages a flow has, in order */
function stageOrder(kind, hasApprove) {
  if (kind === 'epic') return ['need', 'split', 'kids', 'done'];
  if (kind === 'bench') return ['need', 'setup', 'ai', 'verify', 'gate', 'final', 'judge'];
  return ['need', 'setup', 'ai', 'verify', 'gate', ...(hasApprove ? ['approve'] : []), 'merge', 'done'];
}

/**
 * Place the stages on one row (explicit, not layered: the order is the lifecycle) with the AI
 * node's sub-nodes under it. Returns the scene's nodes and edges.
 */
function stageScene(kind, hasApprove, info, subs) {
  const order = stageOrder(kind, hasApprove);
  const gap = 60;
  const rowY = 120;
  let x = 40;
  const nodes = [];
  for (const key of order) {
    const st = STAGES[key];
    const w = st.w;
    const hh = st.h || 64;
    const i = info[key] || {};
    const title = i.title || st.title;
    const sub = i.sub || '';
    nodes.push({
      id: key,
      x,
      y: rowY + (84 - hh) / 2,
      w,
      h: hh,
      cls: st.cls || '',
      state: i.state || '',
      badge: i.badge || null,
      prog: i.prog || null,
      label: `${title}：${sub}`,
      sig: `${st.icon}|${title}|${sub}|${key}`,
      build: key === 'done' ? () => [icon(st.icon, { size: 20 })] : () => [h('span.ic', null, icon(st.icon)), h('span.tx', null, h('span.t', null, title), h('span.s', null, sub))],
    });
    x += w + gap;
  }
  const edges = [];
  for (let k = 0; k < order.length - 1; k++) {
    const a = order[k];
    const b = order[k + 1];
    const e = { from: a, to: b, cls: info.edges?.[`${a}>${b}`]?.cls ?? '' };
    if (a === 'gate') {
      e.label = '通過';
      e.labelCls = 'ok';
      e.cls = e.cls || 'ok';
    }
    edges.push(e);
  }
  const ai = nodes.find((n) => n.id === 'ai');
  const gate = nodes.find((n) => n.id === 'gate');
  if (ai && gate) {
    edges.push({ from: 'gate', to: 'ai', kind: 'back', lift: 60, cls: `back${info.backHot ? ' hot' : ''}`, label: info.backLabel || '未通過：退回 AI 實作重做', labelCls: 'back' });
  }
  if (hasApprove && gate && kind !== 'bench') edges.push({ from: 'gate', to: 'approve', kind: 'below', lift: 36, cls: 'unsure', label: '無法判定', labelCls: 'unsure' });
  // the AI node's parts, hanging under it
  if (ai && subs?.length) {
    const w = 124;
    const total = subs.length * w + (subs.length - 1) * 12;
    let sx = ai.x + ai.w / 2 - total / 2;
    const sy = ai.y + ai.h + (hasApprove ? 96 : 70);
    for (const s of subs) {
      nodes.push({
        id: `sub:${s.key}`,
        x: Math.round(sx),
        y: sy,
        w,
        h: 44,
        cls: 'sub',
        state: s.state || '',
        label: `${s.cap}：${s.val}`,
        sig: `${s.cap}|${s.val}`,
        build: () => [h('span.tx', null, h('span.s', null, s.cap), h('span.t', null, s.val))],
      });
      edges.push({ from: 'ai', to: `sub:${s.key}`, kind: 'attach', cls: 'attach' });
      sx += w + 12;
    }
  }
  return { nodes, edges };
}

// =============================== editor =======================================================
let draft = null;
let form = null;
let canvas = null;
let serverIssues = [];
let saveTimer = null;
let tab = 'canvas';

function flowKind() {
  const t = form.flow?.type || 'task';
  if (t === 'epic') return 'epic';
  if (t === 'bench' || (form.flow?.models || []).length >= 2) return 'bench';
  return 'task';
}
const manualRows = () => (form.verify.manual || []).filter((m) => (typeof m === 'string' ? m.trim() : `${m.given}${m.when}${m.then}`.trim()));

/** what the gate would say, checked here as you type (the server check adds its own) */
function clientIssues() {
  const out = [];
  const add = (node, text) => out.push({ node, text });
  const c = form.change;
  if (!c.title.trim()) add('need', '缺標題：一句話說這次要做什麼');
  if (`${c.symptom}${c.expected}`.replace(/\s+/g, '').length < 15) add('need', '目標寫具體一點：現況＋期望合計至少 15 個字');
  if (!c.files.some((f) => f.path.trim()) && !c.extra.some((x) => x.trim())) add('need', '缺範圍：寫要改哪些檔案或哪一部分');
  if (!form.scope.non_goals.some((x) => x.trim())) add('need', '缺非範圍：至少寫一件這次不做的事');
  if (!form.repo.path) add('need', '缺 repo：選要改的軟體');
  if (!form.acceptance.some((x) => x.trim())) add('gate', '缺驗收標準（Given／When／Then）');
  const cmds = form.verify.commands.filter((x) => x.trim());
  if (!cmds.length && !form.verify.dataset && !manualRows().length && flowKind() !== 'epic') add('verify', '缺驗證：至少一條指令、圖集比對或人工清單');
  if (form.verify.metrics.some((x) => x.trim()) && !cmds.length) add('verify', '有驗收指標就要有一條會印出 LOOP_METRICS 的驗證指令');
  for (const m of form.verify.metrics.filter((x) => x.trim())) {
    if (!/^\s*[A-Za-z_][\w.-]*\s*(<=|>=|==|!=|<|>)\s*-?\d+(\.\d+)?\s*$/.test(m)) add('gate', `指標「${m}」看不懂：寫成 max_ms <= 10 這樣`);
  }
  if (flowKind() === 'bench' && (form.flow.models || []).length < 2) add('ai', '評比至少要選 2 個模型');
  if (flowKind() !== 'bench' && !(form.flow.models || []).length) add('ai', '選一個模型');
  return out;
}

/** a server gate message → the node it is about */
function nodeForMessage(m) {
  if (/驗收指標|保護路徑/.test(m)) return 'gate';
  if (/驗收標準|Acceptance/i.test(m)) return 'gate';
  if (/驗證|Verify|圖集|產出物/i.test(m)) return 'verify';
  if (/人工/.test(m)) return 'approve';
  if (/前置|Setup/i.test(m)) return 'setup';
  if (/領域|複雜度|Domain|Complexity/i.test(m)) return 'ai';
  return 'need';
}

function allIssues() {
  return [...clientIssues(), ...serverIssues.filter((s) => !clientIssues().some((c) => c.text === s.text))];
}

function editorInfo() {
  const issues = allIssues();
  const by = (k) => issues.filter((i) => i.node === k && !i.warnOnly);
  const warn = (k) => (by(k).length ? { state: 'warn', badge: { kind: 'warn' } } : {});
  const cmds = form.verify.commands.filter((x) => x.trim());
  const metrics = form.verify.metrics.filter((x) => x.trim());
  const models = form.flow.models || [];
  const kind = flowKind();
  const manual = manualRows();
  return {
    need: { sub: by('need').length ? `缺 ${by('need').length} 項` : `${form.kind && KINDS[form.kind] ? KINDS[form.kind].label : '草稿'} · 已填好`, ...warn('need') },
    setup: { sub: form.scope.setup.filter((x) => x.trim()).length ? `${form.scope.setup.filter((x) => x.trim()).length} 條前置指令` : '無前置指令', ...warn('setup') },
    ai: { sub: `${kind === 'bench' ? `${models.length} 個模型比` : models.map(modelName).join('、') || '選模型'} · ${form.scope.complexity}`, ...warn('ai') },
    split: { sub: `${models.map(modelName).join('、') || '預設模型'} 拆成 2–6 步` },
    kids: { sub: '依序執行，一步結案才放下一步' },
    verify: { sub: `${cmds.length ? `${cmds.length} 步${cmds.some((c) => /^sandbox/i.test(c)) ? ' · 沙盒' : ''}` : '沒有指令'}${form.verify.dataset ? ' · 圖集' : ''}`, ...warn('verify') },
    gate: { sub: metrics.length ? `${metrics.length} 條指標` : `${form.acceptance.filter((x) => x.trim()).length} 條驗收標準`, ...warn('gate') },
    approve: { sub: `${manual.length} 項清單`, ...warn('approve') },
    merge: { sub: form.repo.branch || 'main' },
    final: { sub: '一組一組重新量測' },
    judge: { sub: (form.flow.judges || ['opus']).map(modelName).join('、') },
    done: {},
    backLabel: '未通過：退回 AI 實作重做（自動續跑，用完轉給你）',
  };
}

function editorSubs() {
  const models = form.flow.models || [];
  const files = form.change.files.filter((f) => f.path.trim());
  const cmds = form.verify.commands.join(' ');
  return [
    { key: 'model', cap: '模型', val: models.length > 1 ? `${models.length} 個（評比）` : modelName(models[0]) || '預設' },
    { key: 'kb', cap: '知識', val: '派工時自動注入' },
    { key: 'tools', cap: '工具', val: /sandbox/i.test(cmds) ? 'GPU 沙盒' : '本機指令' },
    { key: 'scope', cap: '範圍', val: files.length ? (files.length === 1 ? baseName(files[0].path) : `${files.length} 個檔案`) : '由實作者判斷' },
  ];
}

function paintEditor() {
  const kind = flowKind();
  const scene = stageScene(kind, manualRows().length > 0, editorInfo(), kind === 'epic' ? null : editorSubs());
  canvas.render({ ...scene, lift: 60 });
  $('flow-title').textContent = form.change.title || '未命名工作流程';
  paintTopEditor();
}

function paintTopEditor() {
  const issues = allIssues().filter((i) => !i.warnOnly);
  fill($('top-chips'), 
    h(`span.chip-s${draft.status === 'submitted' ? '.ok' : ''}`, null, draft.status === 'submitted' ? '已送出' : '草稿'),
    form.repo.path ? h('span.chip-s.mono', null, `${baseName(form.repo.path)} · ${form.repo.branch || 'main'}`) : null,
    flowKind() === 'bench' ? h('span.chip-s.info', null, '評比') : flowKind() === 'epic' ? h('span.chip-s.info', null, '拆成多個任務') : null,
  );
  const tabs = $('tabs');
  tabs.hidden = false;
  fill(tabs, 
    ...[
      ['canvas', '編輯器'],
      ['doc', '文件'],
    ].map(([k, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => setTab(k) }, label)),
    draft.task_id ? h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => (location.href = `/flow.html?task=${encodeURIComponent(draft.task_id)}`) }, '執行紀錄') : null,
  );
  const issuesBtn = h('button.btn' + (issues.length ? '.warn' : ''), { type: 'button', 'aria-expanded': String(!$('issues-pop').hidden), onclick: toggleIssues }, issues.length ? `${issues.length} 個問題` : '沒有問題');
  const checkBtn = h('button.btn', { type: 'button', onclick: runCheck }, '檢查');
  const start = h('button.btn.primary', { type: 'button', onclick: () => submit(true) }, icon('play', { fill: true }), draft.status === 'submitted' ? '再送一次' : '開始執行');
  const later = h('button.btn', { type: 'button', title: '建立任務，但先不排入', onclick: () => submit(false) }, '存成任務');
  fill($('top-actions'), issuesBtn, checkBtn, later, start);
}

function setTab(k) {
  tab = k;
  $('canvas').hidden = k !== 'canvas';
  $('docview').hidden = k !== 'doc';
  if (k === 'doc') paintDoc();
  paintTopEditor();
}

function paintDoc() {
  const box = $('docview');
  const md = composePrd(form);
  const override = form.markdown_override != null && form.markdown_override !== '';
  const head = h(
    'div.panel-h',
    null,
    h('h2', null, override ? '直接編輯中的 PRD' : '這個工作流程寫成的 PRD'),
    h('span.sub', null, override ? '節點的修改不會再反映到這份文字；要回到節點編輯就還原' : '送出時就是這份文字；在節點裡改，這裡會跟著變'),
    h('span', { style: { flex: '1 1 auto' } }),
    override
      ? h('button.btn.sm', { type: 'button', onclick: () => { if (confirm('捨棄直接編輯的內容，回到用節點產生？')) { form.markdown_override = null; touch(); paintDoc(); } } }, '還原成節點產生')
      : h('button.btn.sm', { type: 'button', onclick: () => { form.markdown_override = md; touch(); paintDoc(); } }, '直接編輯 Markdown'),
  );
  if (override) {
    const ta = h('textarea', { 'aria-label': 'PRD Markdown' });
    ta.value = form.markdown_override;
    ta.oninput = () => {
      form.markdown_override = ta.value;
      touch(false);
    };
    fill(box, head, ta);
  } else fill(box, head, h('pre', null, md));
}

function toggleIssues() {
  const pop = $('issues-pop');
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  const issues = allIssues();
  fill(pop, 
    h('b', { style: { fontSize: '13px' } }, issues.length ? '送出前要處理' : '沒有問題，可以開始執行'),
    ...issues.map((i) =>
      h(
        `div.it${i.warnOnly ? '.warnonly' : ''}`,
        null,
        h('span', null, h('b', null, `${(STAGES[i.node] || STAGES.need).title}：`), i.text),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); pop.hidden = true; openNdv(i.node); } }, '前往'),
      ),
    ),
  );
  pop.hidden = false;
}

async function runCheck() {
  const btn = $('top-actions').querySelectorAll('button')[1];
  if (btn) {
    btn.disabled = true;
    btn.textContent = '檢查中…';
  }
  try {
    const r = await api('/api/prd/check', 'POST', { markdown: composePrd(form) });
    serverIssues = [
      ...(r.missing || []).map((m) => ({ node: nodeForMessage(m), text: m })),
      ...(r.warnings || []).map((m) => ({ node: nodeForMessage(m), text: m, warnOnly: true })),
      ...((r.llm && r.llm.questions) || []).map((q) => ({ node: 'need', text: `本地模型問：${q}`, warnOnly: true })),
      ...((r.llm && r.llm.missing) || []).map((q) => ({ node: nodeForMessage(q), text: `本地模型：${q}`, warnOnly: true })),
    ];
    paintEditor();
    $('issues-pop').hidden = true;
    toggleIssues();
  } catch (e) {
    window.Ops.toast(`檢查失敗：${e.message}`, 'bad');
  } finally {
    if (btn) btn.disabled = false;
    paintTopEditor();
  }
}

async function submit(queue) {
  const issues = clientIssues();
  if (issues.length) {
    $('issues-pop').hidden = true;
    toggleIssues();
    window.Ops.toast('還有問題要先處理', 'bad');
    return;
  }
  const kind = flowKind();
  const models = form.flow.models || [];
  const body = {
    markdown: composePrd(form),
    model: kind === 'bench' ? null : models[0] || null,
    queue,
    verify_llm: !!form.verify.llm,
    draft_id: draft.id,
    verify_plan_id: form.plan_id || null,
    ...(kind === 'bench' ? { benchmark_models: models, judge_models: form.flow.judges || ['opus'] } : {}),
    ...(kind === 'epic' ? { coding_tool: 'plan' } : {}),
  };
  const btns = $('top-actions').querySelectorAll('button');
  btns.forEach((b) => (b.disabled = true));
  $('save-state').textContent = '送出中…（會先跑一次檢查，本地模型複核可能要一分鐘）';
  try {
    await saveNow();
    const r = await api('/api/prd', 'POST', body);
    if (r.kind === 'benchmark') location.href = `/benchmarks.html#b=${encodeURIComponent(r.benchmark.id)}`;
    else location.href = `/flow.html?task=${encodeURIComponent(r.task.id)}`;
  } catch (e) {
    if (e.data && e.data.check) {
      const c = e.data.check;
      serverIssues = [...(c.missing || []).map((m) => ({ node: nodeForMessage(m), text: m })), ...((c.llm && c.llm.missing) || []).map((q) => ({ node: nodeForMessage(q), text: `本地模型：${q}` }))];
      paintEditor();
      $('issues-pop').hidden = true;
      toggleIssues();
    }
    window.Ops.toast(`送不出去：${e.message}`, 'bad');
    $('save-state').textContent = '沒有送出';
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

function touch(repaint = true) {
  $('save-state').textContent = '儲存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
  if (repaint) paintEditor();
}

async function saveNow() {
  clearTimeout(saveTimer);
  try {
    draft = await api(`/api/prd/drafts/${encodeURIComponent(draft.id)}`, 'PUT', { title: form.change.title || '未命名工作流程', form, markdown: composePrd(form), step: 1 });
    $('save-state').textContent = `草稿已自動儲存 · ${hhmm(new Date().toISOString())}`;
  } catch (e) {
    $('save-state').textContent = `儲存失敗：${e.message}`;
  }
}

async function editorView(id) {
  show('editor');
  try {
    draft = await api(`/api/prd/drafts/${encodeURIComponent(id)}`);
  } catch (e) {
    notice(e.status === 404 ? '找不到這份草稿（可能是別人的，或已刪除）。' : `讀不到草稿：${e.message}`);
    return;
  }
  let stored = null;
  try {
    stored = JSON.parse(draft.form_json || '{}');
  } catch (e) {
    stored = null;
  }
  form = mergeForm(stored);
  if (!form.flow.models.length) form.flow.models = [];
  await loadOptions();
  if (!form.flow.models.length && flowKind() !== 'bench') form.flow.models = [options.default_model && options.default_model !== 'default' ? options.default_model : 'sonnet'];
  if (draft.status === 'submitted' && draft.task_id) notice('這份已經送出成任務了；在這裡改不會影響那張任務，要再送一次會建一張新的。', 'info');
  canvas = createCanvas($('canvas'), {
    onNodeClick: (nodeId) => openNdv(nodeId.startsWith('sub:') ? 'ai' : nodeId),
  });
  $('mode-hint').textContent = '點節點填內容 · 拖曳空白處移動 · Ctrl＋滾輪縮放';
  paintEditor();
}

// ---- NDV: one node's input | parameters | output -------------------------------------------------
const ORDER_FOR_NAV = () => stageOrder(flowKind(), manualRows().length > 0).filter((k) => k !== 'done');

function field(label, input) {
  return h('label.f', null, label, input);
}
function textInput(value, onInput, attrs = {}) {
  const i = h('input', { type: 'text', ...attrs });
  i.value = value || '';
  i.oninput = () => onInput(i.value);
  return i;
}
function textArea(value, onInput, rows = 3, attrs = {}) {
  const t = h('textarea', { rows: String(rows), ...attrs });
  t.value = value || '';
  t.oninput = () => onInput(t.value);
  return t;
}
/** an editable list of one-line items */
function listEditor(items, onChange, opts = {}) {
  const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  const paint = () => {
    fill(box, 
      ...items.map((v, i) =>
        h(
          'div.li',
          null,
          textInput(v, (nv) => {
            items[i] = nv;
            onChange(items);
          }, { placeholder: opts.placeholder || '', 'aria-label': `${opts.label || '項目'} ${i + 1}`, style: opts.mono ? { fontFamily: 'var(--mono)' } : null }),
          h('button.btn.icon', { type: 'button', 'aria-label': '刪除這一條', onclick: () => { items.splice(i, 1); onChange(items); paint(); } }, icon('x', { size: 14 })),
        ),
      ),
      h('button.btn.sm.addbtn', { type: 'button', onclick: () => { items.push(''); onChange(items); paint(); box.querySelectorAll('input')[items.length - 1]?.focus(); } }, icon('plus', { size: 14 }), opts.add || '加一條'),
    );
  };
  paint();
  return box;
}
function section(title, sub, ...children) {
  return h('section.ndv-sec', null, h('h3', null, title), sub ? h('p.sub', null, sub) : null, ...children);
}
function issueBox(node) {
  const list = allIssues().filter((i) => i.node === node);
  return list.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, ...list.map((i) => h('div.issue', null, i.text))) : null;
}
function ro(text, mono) {
  return h(`div.ro${mono ? '.mono' : ''}`, null, text || '—');
}

function openNdv(node) {
  if (!STAGES[node] || node === 'done') return;
  const dlg = $('ndv');
  const st = STAGES[node];
  const nav = ORDER_FOR_NAV();
  const at = nav.indexOf(node);
  const prev = at > 0 ? nav[at - 1] : null;
  const next = at >= 0 && at < nav.length - 1 ? nav[at + 1] : null;
  const body = NDV[node] ? NDV[node]() : { input: [], params: [ro('這一步沒有要填的東西。')], output: [] };
  const tabsBox = h('div.tabs-s', { role: 'tablist' });
  const paramsPane = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
  const settingsPane = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' }, hidden: true });
  paramsPane.append(...[].concat(body.params).filter(Boolean));
  if (body.settings) settingsPane.append(...[].concat(body.settings).filter(Boolean));
  const mk = (label, pane, other) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(pane === paramsPane), onclick: (e) => { pane.hidden = false; other.hidden = true; for (const b of tabsBox.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); } }, label);
  tabsBox.append(mk('參數', paramsPane, settingsPane), ...(body.settings ? [mk('設定', settingsPane, paramsPane)] : []));
  fill(dlg, 
    h(
      'div.ndv-head',
      null,
      h('span.ic', null, icon(st.icon)),
      h('h2', null, st.title),
      body.chip ? h('span.chip-s', null, body.chip) : null,
      h('span', { style: { flex: '1 1 auto' } }),
      prev ? h('button.btn.sm', { type: 'button', onclick: () => openNdv(prev) }, icon('chevL', { size: 14 }), STAGES[prev].title) : null,
      next ? h('button.btn.sm', { type: 'button', onclick: () => openNdv(next) }, STAGES[next].title, icon('chevR', { size: 14 })) : null,
      h('button.btn.icon', { type: 'button', 'aria-label': '關閉', onclick: () => dlg.close() }, icon('x', { size: 16 })),
    ),
    h(
      'div.ndv-cols',
      null,
      h('div.ndv-col.ndv-in', null, h('div.cap', null, '輸入', h('span', null, body.inCap || '')), ...[].concat(body.input || []).filter(Boolean)),
      h('div.ndv-col.ndv-mid', null, tabsBox, issueBox(node), paramsPane, settingsPane),
      h('div.ndv-col.ndv-out', null, h('div.cap', null, '輸出', h('span', null, body.outCap || '')), ...[].concat(body.output || []).filter(Boolean)),
    ),
  );
  if (!dlg.open) dlg.showModal();
  dlg.onclose = () => paintEditor();
}

const summaryIn = () => [
  section('目標', null, ro([form.change.symptom && `現況：${form.change.symptom}`, form.change.expected && `期望：${form.change.expected}`].filter(Boolean).join('\n'))),
  section('範圍', null, ro([...form.change.files.filter((f) => f.path).map((f) => f.path), ...form.change.extra.filter(Boolean)].join('\n'))),
];

const NDV = {
  need() {
    const c = form.change;
    const files = c.files.map((f) => f.path);
    const suggestBox = h('div.suggest');
    const suggest = h(
      'button.btn.sm',
      {
        type: 'button',
        onclick: async () => {
          suggest.disabled = true;
          suggest.textContent = '找中…';
          try {
            const r = await api('/api/prd/suggest-files', 'POST', { repo_path: form.repo.path, module: form.repo.module, description: `${c.title} ${c.symptom} ${c.expected}` });
            fill(suggestBox, 
              ...(r.files || []).slice(0, 8).map((f) => {
                const cb = h('input', { type: 'checkbox' });
                cb.checked = c.files.some((x) => x.path === f.path);
                cb.onchange = () => {
                  if (cb.checked && !c.files.some((x) => x.path === f.path)) c.files.push({ path: f.path, why: f.why || '' });
                  if (!cb.checked) c.files = c.files.filter((x) => x.path !== f.path);
                  touch();
                };
                return h('label', null, cb, h('span', null, h('code', null, f.path), f.why ? ` — ${f.why}` : ''));
              }),
            );
            if (!(r.files || []).length) fill(suggestBox, h('span.sub', null, '知識庫沒有找到相關檔案。'));
          } catch (e) {
            fill(suggestBox, h('span.sub', null, `找不到：${e.message}`));
          } finally {
            suggest.disabled = false;
            suggest.textContent = '用知識庫找';
          }
        },
      },
      '用知識庫找',
    );
    const repoSel = h('select', { 'aria-label': 'Repo' });
    const branchSel = h('select', { 'aria-label': '分支' });
    fillRepos(repoSel, branchSel, form.repo.path, form.repo.branch);
    const syncRepo = () => {
      form.repo.path = repoSel.value;
      form.repo.branch = branchSel.value;
      touch();
    };
    repoSel.addEventListener('change', syncRepo);
    branchSel.onchange = syncRepo;
    const kindSel = h('select', { 'aria-label': '變更類型' }, h('option', { value: '' }, '（不指定）'), ...Object.entries(KINDS).map(([k, v]) => h('option', { value: k }, v.label)));
    kindSel.value = form.kind || '';
    kindSel.onchange = () => {
      form.kind = kindSel.value || null;
      if (form.kind) applyKind(form, form.kind);
      touch();
    };
    return {
      chip: '觸發',
      inCap: '這個工作流程從哪裡開始',
      input: [section('說明', null, h('p.sub', null, '需求是整個流程的起點：送出後會變成任務的目標與計畫檔，後面每個節點都照這裡寫的做。'))],
      params: [
        section('標題', null, textInput(c.title, (v) => { c.title = v; touch(); }, { 'aria-label': '標題', placeholder: '一句話說這次要做什麼' })),
        section('現況', '現在哪裡不對（可以空著）', textArea(c.symptom, (v) => { c.symptom = v; touch(); }, 2, { 'aria-label': '現況' })),
        section('期望', '改好後應該怎樣——寫得出數字就寫數字', textArea(c.expected, (v) => { c.expected = v; touch(); }, 3, { 'aria-label': '期望' })),
        section('範圍', '要改的檔案（repo 內相對路徑）；不知道就寫一句話描述要改哪一部分', listEditor(files, (list) => { c.files = list.map((p) => ({ path: p, why: c.files.find((x) => x.path === p)?.why || '' })); touch(); }, { mono: true, placeholder: 'ccl/ccl.cu', label: '檔案', add: '加一個檔案' }), listEditor(c.extra, (list) => { c.extra = list; touch(); }, { placeholder: '或用一句話描述範圍', label: '範圍', add: '加一句描述' }), h('div.row2', null, suggest), suggestBox),
        section('非範圍', '這次明確不做的事（至少一條）', listEditor(form.scope.non_goals, (list) => { form.scope.non_goals = list; touch(); }, { placeholder: '例：不改 ccl.h 的介面', label: '非範圍' })),
      ],
      settings: [
        section('要改的軟體', null, h('div.row2', null, repoSel, branchSel)),
        section('變更類型', '只會填空白的地方', kindSel),
        section('限制', '實作時要遵守的事', listEditor(form.scope.constraints, (list) => { form.scope.constraints = list; touch(); }, { placeholder: '例：輸出必須 bit-exact', label: '限制' })),
      ],
      outCap: '寫成 PRD 的樣子',
      output: [h('pre.ro.mono', { style: { maxHeight: '60vh', overflow: 'auto', margin: 0 } }, composePrd(form).split('## 驗收標準')[0])],
    };
  },
  setup() {
    return {
      chip: '失敗就停，不花額度',
      input: [section('會做什麼', null, h('p.sub', null, '從最新的 base 開一個獨立的 worktree，寫好任務說明，再跑下面的前置指令（例如安裝相依、編譯）。前置指令失敗會直接轉給你，不會開始花額度。'))],
      params: [section('前置指令', '一行一條，在 worktree 根目錄執行（可以空著）', listEditor(form.scope.setup, (list) => { form.scope.setup = list; touch(); }, { mono: true, placeholder: 'npm ci', label: '前置指令' }))],
      output: [h('p.sub', null, '開始執行後，這裡會顯示準備環境花了多久、有沒有失敗。')],
    };
  },
  ai() {
    const kind = flowKind();
    const models = form.flow.models || (form.flow.models = []);
    const judges = form.flow.judges || (form.flow.judges = ['opus']);
    const picks = h('div.picks');
    const judgePicks = h('div.picks');
    const all = [...(options.models || []).map((m) => [m.id, m.name || modelName(m.id), '本地 · 不花額度']), ...CLOUD_MODELS];
    const paintPicks = () => {
      fill(picks, 
        ...all.map(([id, name, sub]) =>
          h(
            'button.pick',
            {
              type: 'button',
              'aria-pressed': String(models.includes(id)),
              title: sub,
              onclick: () => {
                const i = models.indexOf(id);
                if (i >= 0) models.splice(i, 1);
                else if (form.flow.type === 'task' && models.length >= 1 && !confirm('選第二個模型會變成評比：每個模型各做一份，最後重新量測、由評審比較。要改成評比嗎？')) return;
                else models.push(id);
                form.flow.type = models.length >= 2 ? 'bench' : form.flow.type === 'bench' ? 'task' : form.flow.type;
                touch();
                paintPicks();
              },
            },
            h('span.chip-s' + (isLocal(id) ? '.local' : '.cloud'), null, isLocal(id) ? '本地' : '雲端'),
            name,
          ),
        ),
      );
      fill(judgePicks, 
        ...JUDGES.map((j) =>
          h('button.pick', { type: 'button', 'aria-pressed': String(judges.includes(j)), onclick: () => { const i = judges.indexOf(j); if (i >= 0) judges.splice(i, 1); else judges.push(j); touch(); paintPicks(); } }, modelName(j)),
        ),
      );
    };
    paintPicks();
    const cx = h('div.seg', { role: 'radiogroup', 'aria-label': '規模' }, ...['S', 'M', 'L'].map((k) => h('button', { type: 'button', role: 'radio', 'aria-pressed': String(form.scope.complexity === k), onclick: () => { form.scope.complexity = k; touch(); openNdv('ai'); } }, k)));
    const dom = h('select', { 'aria-label': '領域' }, ...DOMAINS.map(([k, l]) => h('option', { value: k }, l)));
    dom.value = form.scope.domain || 'other';
    dom.onchange = () => {
      form.scope.domain = dom.value;
      touch();
    };
    return {
      chip: kind === 'bench' ? `評比 · ${models.length} 個模型` : '模型・知識・工具・範圍',
      inCap: '模型收到的任務內容',
      input: [...summaryIn(), section('驗收標準（來自驗收門檻）', null, ro(form.acceptance.filter(Boolean).join('\n')))],
      params: [
        section('模型', '選 2 個以上，這個工作流程就變成評比', picks),
        kind === 'bench' ? section('評審', '雲端模型看程式碼與量測結果評分', judgePicks) : null,
        section('規模', 'S／M／L 決定逾時與預估用量', cx),
        section('工具與重試', '全域設定，這裡只顯示', ro('GPU 沙盒：驗證步驟寫成「sandbox: 指令」就會在沙盒跑；模型自己也能用沙盒試跑（含 ncu）。\n沒過驗收時自動續跑：照排程設定的 max_resumes。')),
      ],
      settings: [section('領域', '評比戰績照這個分類', dom)],
      output: [h('p.sub', null, '開始執行後，每一次嘗試都會列在這裡：花多久、多少 token、自己在沙盒試跑幾次、有沒有用 ncu。')],
    };
  },
  split() {
    return NDV.ai();
  },
  kids() {
    return { input: [], params: [ro('AI 拆解會照需求拆出 2–6 個子任務，串成依序執行的鏈：第一個先排入，上一個結案才放下一個。每個子任務都有自己的驗證。')], output: [] };
  },
  verify() {
    const v = form.verify;
    const dsOn = !!v.dataset;
    const ds = v.dataset || emptyDataset();
    const dsBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, hidden: !dsOn });
    dsBox.append(
      field('輸入圖集（只引用路徑）', textInput(ds.input, (x) => { ds.input = x; touch(false); }, { style: { fontFamily: 'var(--mono)' } })),
      field('期望結果', textInput(ds.golden, (x) => { ds.golden = x; touch(false); }, { style: { fontFamily: 'var(--mono)' } })),
      field('配方', textInput(ds.recipe, (x) => { ds.recipe = x; touch(false); })),
    );
    const dsToggle = h('input', { type: 'checkbox', 'aria-label': '圖集比對' });
    dsToggle.checked = dsOn;
    dsToggle.onchange = () => {
      v.dataset = dsToggle.checked ? ds : null;
      dsBox.hidden = !dsToggle.checked;
      touch();
    };
    return {
      chip: '引擎自己跑',
      inCap: '實作完的程式',
      input: summaryIn(),
      params: [
        section('驗證指令', '一行一條；寫成「sandbox: 指令」會在 GPU 沙盒跑；印出 LOOP_METRICS 一行，驗收門檻就能自動比數字', listEditor(v.commands, (list) => { v.commands = list; touch(); }, { mono: true, placeholder: 'sandbox: bash run_bench.sh', label: '驗證指令' })),
        section('圖集比對', '改影像處理規則時，用整批圖證明沒有退步（需要 GPU）', h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' } }, dsToggle, '這次要跑圖集比對'), dsBox),
      ],
      settings: [section('產出物', '驗證後收集的檔案（repo 內相對路徑或 glob），不會 commit', listEditor(v.artifacts, (list) => { v.artifacts = list; touch(); }, { mono: true, placeholder: 'build/check.log', label: '產出物' }))],
      output: [h('p.sub', null, '開始執行後，每一步的結果、花多久、最後幾行輸出會顯示在這裡。')],
    };
  },
  gate() {
    const v = form.verify;
    const llm = h('input', { type: 'checkbox', 'aria-label': 'AI 評審' });
    llm.checked = !!v.llm;
    llm.onchange = () => {
      v.llm = llm.checked;
      touch();
    };
    const draftBtn = h(
      'button.btn.sm',
      {
        type: 'button',
        onclick: async () => {
          draftBtn.disabled = true;
          draftBtn.textContent = 'AI 寫草稿中…';
          try {
            const r = await api('/api/prd/draft-acceptance', 'POST', { description: form.change.symptom, expected: form.change.expected, method: v.dataset ? 'dataset' : 'cmd', module: form.repo.module });
            for (const it of r.items || []) if (!form.acceptance.includes(it)) form.acceptance.push(it);
            touch();
            openNdv('gate');
          } catch (e) {
            window.Ops.toast(`寫不出來：${e.message}`, 'bad');
          } finally {
            draftBtn.disabled = false;
            draftBtn.textContent = 'AI 幫寫';
          }
        },
      },
      'AI 幫寫',
    );
    return {
      chip: '三個出口：通過／無法判定／未通過',
      inCap: '驗證量到的東西',
      input: [section('驗證指令', null, ro(v.commands.filter(Boolean).join('\n'), true)), h('p.sub', null, '指標取自驗證指令最後印出的 LOOP_METRICS 一行。')],
      params: [
        section('引擎檢查', '引擎自己比，每一條都要過（名稱 運算 目標，例如 max_ms <= 10）', listEditor(v.metrics, (list) => { v.metrics = list; touch(); }, { mono: true, placeholder: 'max_ms <= 10', label: '指標', add: '加一條指標' })),
        section('驗收標準', 'Given／When／Then：給實作的模型看，也給核可的人勾', listEditor(form.acceptance, (list) => { form.acceptance = list; touch(); }, { placeholder: 'Given … When … Then …', label: '驗收標準' }), h('div.row2', null, draftBtn)),
        section('AI 評審', '指標都過了，再請雲端模型依驗收標準看一次程式碼（會用額度；判斷不了就轉人工）', h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' } }, llm, '開啟')),
      ],
      settings: [section('保護路徑', '實作的模型不能改的檔案（量測程式、標準答案）；改了就算沒過', listEditor(form.scope.protected, (list) => { form.scope.protected = list; touch(); }, { mono: true, placeholder: 'bench/**', label: '保護路徑' }))],
      outCap: '判定之後往哪走',
      output: [ro('通過 → 人工核可（有清單時）或直接合併\n無法判定（缺能力、沒量到）→ 人工核可\n未通過 → 退回 AI 實作重做（自動續跑，用完轉到總覽的「需要你處理」）')],
    };
  },
  approve() {
    const rows = form.verify.manual;
    const asText = rows.map((m) => (typeof m === 'string' ? m : [m.given && `Given ${m.given}`, m.when && `When ${m.when}`, m.then && `Then ${m.then}`].filter(Boolean).join(' ') || m.then || ''));
    return {
      chip: '有清單就要有人核可',
      input: [section('會看到什麼', null, h('p.sub', null, '驗證過了以後，任務停在「待核可」；驗收頁會列出這份清單讓你逐條勾。核可就會合併。'))],
      params: [section('人工清單', '每一條是一件要人確認的事；全部刪掉就不需要人工核可', listEditor(asText, (list) => { form.verify.manual = list.map((t) => ({ given: '', when: '', then: t })); touch(); }, { placeholder: '例：在現場機台上看過一次結果畫面', label: '清單' }))],
      output: [],
    };
  },
  merge() {
    return {
      chip: '只快轉，不動你的 checkout',
      input: [section('會做什麼', null, h('p.sub', null, '推上任務分支 → 把最新的 base 併進來並重新驗證 → 開 PR（有設定時）→ 快轉合併進 base。衝突會自動開一張解衝突任務。'))],
      params: [section('合併到', null, ro(`${baseName(form.repo.path)} · ${form.repo.branch || 'main'}`))],
      output: [],
    };
  },
  final() {
    return { params: [ro('全部模型都做完後，引擎用同一套驗證把每一組最後的程式一組一組重新量一次，不和其他組搶 GPU；也會量一次參賽前的原始程式當基準。')], input: [], output: [] };
  },
  judge() {
    return NDV.ai();
  },
};

// =============================== run: what the task did =======================================
let runTask = null;
let hist = null;
let runCanvas = null;
let selected = null;
let runTimer = null;

const OUT_LABEL = { pass: '通過', metrics: '指標未達', functional: '功能沒過', protected: '改了保護路徑', unverified: '沒跑到驗證' };
const OUT_CLS = { pass: 'ok', metrics: 'warn', functional: 'bad', protected: 'bad', unverified: '' };
const STATE_BADGE = { ok: 'ok', active: 'run', fail: 'fail', warn: 'warn' };
const parseSteps = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
};
const missed = (checks) => (checks || []).filter((c) => !c.pass).map((c) => `${c.name} ${c.actual == null ? '沒量到' : fmtNum(c.actual)}（要 ${OP_TEXT[c.op] || c.op} ${c.target}）`).join('、');

function runInfo() {
  const t = runTask;
  const s = hist.stages;
  const atts = hist.iterations.attempts;
  const last = atts[atts.length - 1];
  const steps = parseSteps(t.verification_steps);
  const info = {};
  // the canvas's node keys, read off the history's stage keys (需求 is the trigger stage)
  const put = (k, sub, sk = k) => {
    info[k] = { sub, state: s[sk] || 'idle', badge: STATE_BADGE[s[sk]] ? { kind: STATE_BADGE[s[sk]] } : null };
  };
  put('need', t.status === 'draft' ? '草稿，還沒排入' : `已送出 · ${shortTime(t.created_at)}`, 'trigger');
  // waiting for its turn (usage, time window, an upstream task) is not a problem: a clock, not a "!"
  if ((t.status === 'queued' || t.status === 'ready') && s.trigger === 'warn') info.need = { sub: t.depends_on ? '排隊中 · 等上一步' : '排隊中 · 等派工', state: 'queued', badge: { kind: 'queued' } };
  put('setup', s.setup === 'active' ? '準備中…' : s.setup === 'fail' ? '準備環境失敗' : t.setup_cmd ? '前置指令' : 'worktree');
  const running = hist.active_run;
  const aiSub = running && s.implement === 'active'
    ? `第 ${atts.length} 次 · ${Math.max(0, Math.round((Date.now() - new Date(String(running.started_at).includes('T') ? running.started_at : `${String(running.started_at).replace(' ', 'T')}Z`).getTime()) / 60000))} 分`
    : `${modelName(t.model) || '預設模型'} · ${atts.length} 次嘗試`;
  put('implement', aiSub);
  info.ai = info.implement;
  const vms = last ? (last.steps || []).reduce((sum, x) => sum + (x.ms || 0), 0) : 0;
  put('verify', last && last.steps?.length ? `${last.steps.filter((x) => x.ok).length}/${last.steps.length} 步${vms ? ` · ${dur(vms / 1000)}` : ''}` : `${steps.length} 步`);
  // a running attempt has not been measured yet: say what the one before it found
  const judged = [...atts].reverse().find((a) => a.finished_at && a.outcome !== 'unverified');
  const gateText = (a) => (a.outcome === 'pass' ? '通過' : a.outcome === 'metrics' ? missed(a.checks) || '指標未達' : OUT_LABEL[a.outcome] || '—');
  put('gate', last && last.finished_at ? gateText(last) : judged ? `上次：${gateText(judged)}` : '等驗證');
  put('approve', t.approved_at ? '已核可' : s.approve === 'active' ? '等你核可' : '人工清單');
  // waiting on a person is not work in progress: the review eye, not a spinner
  if (s.approve === 'active') info.approve = { ...info.approve, state: 'review', badge: { kind: 'review' } };
  if (s.done === 'warn') info.done = { ...(info.done || {}), state: 'review', badge: { kind: 'review' } };
  put('merge', t.merge_status === 'merged' ? '已合併' : t.merge_status === 'conflict' ? '合併衝突' : t.merge_status === 'pending' ? '待合併' : t.base_branch || 'main');
  put('done', '');
  info.backHot = s.gate === 'fail' && t.status === 'blocked';
  info.backLabel = hist.retry.used ? `未通過 ${hist.retry.used} 次 → 自動續跑 ${Math.min(hist.retry.used, hist.retry.max)}/${hist.retry.max}` : `未通過：退回重做（自動續跑最多 ${hist.retry.max} 次）`;
  return info;
}

function runSubs() {
  const t = runTask;
  const atts = hist.iterations.attempts;
  const selfRuns = atts.reduce((sum, a) => sum + (a.self_runs || 0), 0);
  const prof = atts.some((a) => a.profiler);
  return [
    { key: 'model', cap: '模型', val: modelName(t.model) || '預設' },
    { key: 'tools', cap: prof ? '工具 · 用過 ncu' : '工具', val: selfRuns ? `沙盒試跑 ${selfRuns} 次` : '沒自己試跑', state: selfRuns ? 'active' : '' },
    { key: 'tok', cap: 'token', val: `${tokens(atts.reduce((s, a) => s + (a.tokens_in || 0), 0))}／${tokens(atts.reduce((s, a) => s + (a.tokens_out || 0), 0))}` },
  ];
}

async function runView(id) {
  show('run');
  try {
    const [{ task }, h2] = await Promise.all([api(`/api/tasks/${encodeURIComponent(id)}`), api(`/api/tasks/${encodeURIComponent(id)}/runs`)]);
    runTask = task;
    hist = h2;
  } catch (e) {
    notice(e.status === 404 ? '找不到這張任務（可能已刪除）。' : `讀不到任務：${e.message}`);
    return;
  }
  if (!runCanvas) runCanvas = createCanvas($('run-canvas'), { onNodeClick: (nodeId) => selectStage(nodeId) });
  paintRun();
  clearInterval(runTimer);
  if (!['closed', 'failed'].includes(runTask.status)) {
    runTimer = setInterval(async () => {
      try {
        const [{ task }, h2] = await Promise.all([api(`/api/tasks/${encodeURIComponent(id)}`), api(`/api/tasks/${encodeURIComponent(id)}/runs`)]);
        runTask = task;
        hist = h2;
        paintRun();
        if (['closed', 'failed'].includes(task.status)) clearInterval(runTimer);
      } catch (e) {
        /* keep the last picture */
      }
    }, 4000);
  }
}

const TASK_WORD = { draft: '草稿', ready: '就緒', queued: '排隊中', blocked: '等續跑', running: '執行中', verifying: '驗證中', review: '待核可', attention: '需要處理', failed: '失敗', closed: '已結案' };
const TASK_CLS = { running: 'ok', verifying: 'ok', review: 'info', attention: 'warn', blocked: 'warn', failed: 'bad', closed: '' };

function paintRun() {
  const t = runTask;
  $('flow-title').textContent = String(t.title).replace(/^\[bench\]\s*/, '');
  fill($('top-chips'), h(`span.chip-s${TASK_CLS[t.status] ? `.${TASK_CLS[t.status]}` : ''}`, null, TASK_WORD[t.status] || t.status), t.repo_path ? h('span.chip-s.mono', null, `${baseName(t.repo_path)} · ${t.base_branch || 'main'}`) : null);
  $('tabs').hidden = true;
  const acts = [];
  const act = async (path, confirmMsg) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      await api(path, 'POST');
      runView(t.id);
    } catch (e) {
      window.Ops.toast(`操作失敗：${e.message}`, 'bad');
    }
  };
  if (t.benchmark_id) acts.push(h('a.btn', { href: `/benchmarks.html#b=${encodeURIComponent(t.benchmark_id)}` }, '看整場評比'));
  if (['running', 'verifying'].includes(t.status)) acts.push(h('button.btn.danger-ghost', { type: 'button', onclick: () => act(`/api/tasks/${t.id}/abort`, `確定中止「${t.title}」？正在跑的會被停掉，任務標成失敗。`) }, '中止'));
  if (t.status === 'attention') {
    acts.push(h('button.btn.primary', { type: 'button', onclick: () => act(`/api/tasks/${t.id}/resume`) }, '續跑'));
    acts.push(h('button.btn', { type: 'button', onclick: () => act(`/api/tasks/${t.id}/restart`, '重來會刪掉現有 worktree／branch，從最新 base 重新開始。要繼續嗎？') }, '重來'));
    acts.push(h('button.btn.danger-ghost', { type: 'button', onclick: () => act(`/api/tasks/${t.id}/abandon`, '放棄這張任務？會標成失敗。') }, '放棄'));
  }
  if (t.status === 'blocked') acts.push(h('button.btn', { type: 'button', onclick: () => act(`/api/tasks/${t.id}/hold`) }, '轉待確認'));
  acts.push(h(`a.btn${t.status === 'review' ? '.primary' : ''}`, { href: `/task.html?id=${encodeURIComponent(t.id)}` }, '驗收頁', icon('ext', { size: 14 })));
  fill($('top-actions'), ...acts);

  const kind = t.coding_tool === 'plan' ? 'epic' : 'task';
  const manual = String(t.verify_mode || '').split(',').map((m) => m.trim()).includes('manual');
  const info = runInfo();
  const scene = stageScene(kind, manual, info, kind === 'epic' ? null : runSubs());
  runCanvas.render({ ...scene, lift: 60 });
  paintTree();
}

/** the attempts, newest first, each with its parts */
function treeItems() {
  const atts = hist.iterations.attempts;
  const items = [];
  for (let i = atts.length - 1; i >= 0; i--) {
    const a = atts[i];
    const live = !a.finished_at;
    items.push({ key: `run:${i}`, run: true, a, label: `第 ${a.attempt} 次嘗試`, chip: live ? ['進行中', 'ok'] : [OUT_LABEL[a.outcome] || a.outcome, OUT_CLS[a.outcome] || ''], aux: `${shortTime(a.started_at)}${a.finished_at ? `–${hhmm(a.finished_at)}` : ' 起'}` });
    const aiSecs = a.duration_s != null ? Math.max(0, a.duration_s - Math.round((a.steps || []).reduce((s, x) => s + (x.ms || 0), 0) / 1000)) : null;
    const aiAux = [aiSecs != null ? dur(aiSecs) : null, a.tokens_out ? `${tokens(a.tokens_in)}／${tokens(a.tokens_out)} token` : null, a.self_runs ? `自己試跑 ${a.self_runs} 次` : '沒自己試跑', a.profiler ? '用過 ncu' : null].filter(Boolean).join(' · ');
    items.push({ key: `ai:${i}`, a, stage: 'implement', label: 'AI 實作', icon: live && !(a.steps || []).length ? 'spin' : 'check', ok: true, aux: aiAux });
    for (const [j, s] of (a.steps || []).entries()) items.push({ key: `step:${i}:${j}`, a, s, stage: 'verify', label: s.step === '保護路徑' ? '保護路徑' : '驗證', mono: s.step, ok: s.ok, aux: s.ms != null ? dur(s.ms / 1000) : '' });
    if (a.outcome !== 'unverified' || a.checks) items.push({ key: `gate:${i}`, a, stage: 'gate', label: '驗收門檻', ok: a.outcome === 'pass', bad: a.outcome !== 'pass', aux: a.outcome === 'pass' ? '通過' : a.outcome === 'metrics' ? missed(a.checks) : OUT_LABEL[a.outcome] });
    else if (!live) items.push({ key: `note:${i}`, a, stage: 'implement', label: '沒跑到驗證', bad: true, aux: a.note || '' });
  }
  return items;
}

function paintTree() {
  const items = treeItems();
  $('log-sub').textContent = `${hist.iterations.attempts.length} 次嘗試${hist.iterations.label ? ` · ${hist.iterations.label}` : ''}`;
  if (!selected || !items.some((i) => i.key === selected)) selected = items.find((i) => i.bad)?.key || items[0]?.key || null;
  fill($('tree'), 
    ...(items.length
      ? items.map((it) => {
          const glyph = it.run ? icon('chevD', { size: 14 }) : it.icon === 'spin' ? icon('spin', { size: 14 }) : icon(it.bad ? 'x' : it.ok ? 'check' : 'clock', { size: 14 });
          if (!it.run) glyph.style.color = it.bad ? 'var(--danger)' : it.icon === 'spin' ? 'var(--st-running)' : 'var(--ok)';
          return h(
            `li.${it.run ? 'run' : 'step'}`,
            { role: 'treeitem', 'aria-selected': String(it.key === selected), onclick: () => { selected = it.key; paintTree(); } },
            glyph,
            h('span', null, it.label),
            it.chip ? h(`span.chip-s${it.chip[1] ? `.${it.chip[1]}` : ''}`, null, it.chip[0]) : null,
            it.mono ? h('span.aux', { style: { fontFamily: 'var(--mono)', fontSize: '12px' } }, it.mono) : null,
            h('span.grow'),
            h('span.aux', null, it.aux || ''),
          );
        })
      : [h('li', null, h('span.aux', null, runTask.status === 'draft' ? '還沒送出。' : '還沒有開始執行。'))]),
  );
  paintDetail(items.find((i) => i.key === selected));
}

function paintDetail(it) {
  const box = $('logdetail');
  if (!it) {
    fill(box, h('p.empty-s', null, '選左邊的一步看細節。'));
    return;
  }
  const a = it.a;
  const out = [];
  if (it.run || it.stage === 'gate') {
    out.push(h('h3', null, `${it.run ? `第 ${a.attempt} 次嘗試` : `驗收門檻 · 第 ${a.attempt} 次`}`));
    if (a.checks?.length) {
      out.push(h('div.checks', null, ...a.checks.map((c) => h(`div${c.pass ? '' : '.bad'}`, null, icon(c.pass ? 'check' : 'x', { size: 16, sw: 2.6 }), h('span.n', null, `${c.name} ${OP_TEXT[c.op] || c.op} ${c.target}`), h('span.v', null, c.actual == null ? '沒量到' : fmtNum(c.actual))))));
    }
    const metrics = a.metrics || {};
    const head = (a.checks || []).find((c) => c.op === '<=' || c.op === '<');
    const suf = head ? (/(_[a-z]+)$/.exec(head.name) || [])[1] : null;
    const fam = suf ? Object.entries(metrics).filter(([k, v]) => k.endsWith(suf) && k !== head.name && !/^(max|min|avg)_/.test(k) && Number.isFinite(Number(v))) : [];
    if (fam.length >= 2) {
      out.push(h('p.sub', { style: { margin: 0 } }, `各項 ${head.name}（門檻 ${head.target}）`));
      out.push(hbars({ label: head.name, rows: fam.map(([k, v]) => ({ label: k.replace(suf, ''), value: Number(v), color: Number(v) > head.target ? 'var(--danger)' : 'var(--ok)' })), threshold: { value: head.target } }));
    } else if (Object.keys(metrics).length) {
      out.push(h('pre', null, Object.entries(metrics).map(([k, v]) => `${k} = ${v}`).join('\n')));
    }
    if (a.note) out.push(h('p', null, a.note));
    if (!a.checks?.length && !Object.keys(metrics).length && !a.note) out.push(h('p.sub', null, a.finished_at ? '這一次沒有量測結果。' : '還在做。'));
  } else if (it.s) {
    out.push(h('h3', null, it.s.step === '保護路徑' ? '保護路徑檢查' : '驗證步驟'), h('pre', null, it.s.step));
    out.push(h('p.sub', { style: { margin: 0 } }, `${it.s.ok ? '成功' : '失敗'}${it.s.exitCode != null ? ` · exit ${it.s.exitCode}` : ''}${it.s.timedOut ? ' · 逾時' : ''}${it.s.ms != null ? ` · ${dur(it.s.ms / 1000)}` : ''}`));
    if (it.s.tail) out.push(h('pre', null, it.s.tail));
  } else {
    out.push(h('h3', null, `AI 實作 · 第 ${a.attempt} 次`));
    out.push(h('div.kv', null, h('span.k', null, '模型'), h('span.v', null, modelName(runTask.model) || '預設模型'), h('span.k', null, '時間'), h('span.v', null, `${shortTime(a.started_at)}${a.finished_at ? ` → ${hhmm(a.finished_at)}（${dur(a.duration_s)}）` : ' 起，還在做'}`), h('span.k', null, 'token'), h('span.v', null, `輸入 ${tokens(a.tokens_in)} · 輸出 ${tokens(a.tokens_out)}`), h('span.k', null, '自己試跑'), h('span.v', null, `${a.self_runs || 0} 次${a.profiler ? '，用過 ncu' : ''}`)));
    const notes = (hist.events || []).filter((e) => e.run_id === a.run_id && e.kind === 'note' && /^沙盒：/.test(e.detail || '')).slice(-12);
    if (notes.length) out.push(h('pre', null, notes.map((e) => `${hhmm(e.created_at)}  ${e.detail.replace(/^沙盒：/, '')}`).join('\n')));
    if (a.note) out.push(h('p', null, a.note));
  }
  fill(box, ...out);
}

/** clicking a stage on the canvas selects that stage of the latest attempt */
function selectStage(nodeId) {
  const items = treeItems();
  const want = nodeId === 'ai' || nodeId.startsWith('sub:') ? 'implement' : nodeId;
  const hit = items.find((i) => i.stage === want) || items.find((i) => i.run);
  if (hit) {
    selected = hit.key;
    paintTree();
  }
}

$('log-collapse').onclick = () => {
  const body = $('logpanel').querySelector('.logpanel-body');
  body.hidden = !body.hidden;
  $('logpanel').style.flexBasis = body.hidden ? '40px' : '';
  $('log-collapse').textContent = body.hidden ? '展開' : '收起';
  $('log-collapse').setAttribute('aria-expanded', String(!body.hidden));
};

document.addEventListener('pointerdown', (e) => {
  const pop = $('issues-pop');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#top-actions')) pop.hidden = true;
});

// =============================== route =======================================================
if (qs.get('task')) runView(qs.get('task'));
else if (qs.get('draft')) editorView(qs.get('draft'));
else startView();
