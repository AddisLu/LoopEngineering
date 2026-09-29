// 評比 page: every benchmark as a card, one benchmark as a chart dashboard (the design canvas
// "Loop 介面改版" ⑦–⑨), and 戰績 — which model fits which kind of work. textContent-only.
import { $, h, icon, api, withToken, mountRail, dur, tokens, tsMs, shortTime } from './frame.js';
import { groupedBars, lineChart, dotPlot, scatter, swimlane, outcomeDots, bullet, heatColor, fmtNum, hbars } from './charts.js';

mountRail('bench');

const fmt = (n, d = 1) => (n == null || isNaN(n) ? '–' : Number(n).toFixed(d));
const pct = (n) => (n == null || isNaN(n) ? '–' : `${Math.round(n * 100)}%`);
const gb = (b) => (b == null ? '' : `${(b / 1024 ** 3).toFixed(b >= 100 * 1024 ** 3 ? 0 : 1)} GB`);
const STATUS = { running: '進行中', judging: '評分中', judged: '已評分', judge_failed: '評分失敗', cancelled: '已取消' };
const DOMAIN = { cuda: 'CUDA／GPU', cv: '影像處理', cpp: 'C++', csharp: 'C#', typescript: 'TypeScript', python: 'Python', other: '其他' };
const domainLabel = (d) => DOMAIN[d] || d || '其他';
// SQLite writes UTC; show it in the operator's own clock
const localTime = (s) => window.Ops.localTime(s);
const VERIFY = { pass: '通過', manual: '待人工', fail: '沒過' };
const CONSENSUS = { unanimous: '評審一致', split: '評審分歧', single: '單一評審' };
// the same wording the dock uses for a task's state
const TASK_LABEL = { draft: '草稿', ready: '就緒', queued: '排隊中', blocked: '等續跑', running: '執行中', verifying: '驗證中', review: '待結案', attention: '要你處理', failed: '失敗', closed: '已結案' };
const taskLabel = (s) => TASK_LABEL[s] || s || '未知';
const SOURCE = { builtin: '內建題庫', task: '看板任務', draft: '工作流程草稿', manual: '自己出題' };
const CRITERIA = [
  ['correctness', '正確性'],
  ['completeness', '完整性'],
  ['code_quality', '程式品質'],
  ['adherence', '遵循度'],
];
// id -> human name, filled from the local catalog; the page never shows a raw id if it can help it
const MODEL_NAMES = new Map([
  ['sonnet', 'sonnet'],
  ['opus', 'opus'],
  ['haiku', 'haiku'],
]);
const modelName = (id) => MODEL_NAMES.get(id) || String(id || '').replace(/^local:/, '');
const isLocalId = (id) => String(id || '').startsWith('local:');
const CLOUD = [
  ['sonnet', 'sonnet', '雲端 · 快、便宜'],
  ['opus', 'opus', '雲端 · 最強，最貴'],
  ['haiku', 'haiku', '雲端 · 最便宜'],
];
const JUDGES = [
  ['opus', 'opus', '預設評審，判斷最穩'],
  ['sonnet', 'sonnet', '較快、較省'],
  ['fable', 'fable', '另一種風格的第二意見'],
  ['fable-5', 'fable 5', '同上，較新'],
];

// one colour per model: cloud in blues, local in oranges (told apart by lightness too), baseline grey
const CLOUD_COLORS = ['#3f6fa8', '#274a78', '#7a9cc9'];
const LOCAL_COLORS = ['#d9893a', '#9a5418', '#e8b27a', '#6e3a0f'];
const BASE_COLOR = '#c9c1b2';
function colorMap(models) {
  const m = new Map();
  let c = 0;
  let l = 0;
  for (const id of models) m.set(id, isLocalId(id) ? LOCAL_COLORS[l++ % LOCAL_COLORS.length] : CLOUD_COLORS[c++ % CLOUD_COLORS.length]);
  return m;
}

const parseJson = (s) => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
};

/** "correct == 1; max_ms <= 10" → [{ name, op, target }] */
function parseSpecs(spec) {
  return String(spec || '')
    .split(/[;\n]/)
    .map((s) => /^\s*([A-Za-z_][\w.-]*)\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s))
    .filter(Boolean)
    .map((m) => ({ name: m[1], op: m[2], target: Number(m[3]) }));
}
/** the number people read a benchmark by: the first "lower is better" threshold, else "higher is better" */
function headline(specs) {
  return specs.find((s) => s.op === '<=' || s.op === '<') || specs.find((s) => s.op === '>=' || s.op === '>') || null;
}
const lowerBetter = (spec) => spec && (spec.op === '<=' || spec.op === '<');
/** "<=" → "≤" for reading */
const opText = (op) => ({ '<=': '≤', '>=': '≥', '==': '=', '!=': '≠' })[op] || op;
const specText = (s) => `${s.name} ${opText(s.op)} ${s.target}`;
function unitOf(name) {
  if (/_ms$/.test(name)) return 'ms';
  if (/_us$/.test(name)) return 'µs';
  if (/_s$/.test(name)) return 's';
  if (/gbs$|bandwidth/i.test(name)) return 'GB/s';
  if (/_pct$|rate$/.test(name)) return '%';
  return '';
}
const suffixOf = (name) => (/(_[a-z]+)$/.exec(name) || [])[1] || null;

// the list and detail views have no error slot of their own; #form-err lives inside 新評比
function pageError(msg) {
  const box = $('page-err');
  box.hidden = !msg;
  box.textContent = msg || '';
}

function fillTable(table, headers, rows) {
  table.replaceChildren();
  const thead = h('thead', null, h('tr', null, headers.map((x) => h('th', null, x))));
  const tbody = h('tbody', null, rows);
  table.append(thead, tbody);
}
function row(cells, onClick) {
  const tr = h('tr', onClick ? { style: { cursor: 'pointer' }, onclick: onClick } : null);
  for (const c of cells) tr.appendChild(h('td', null, c instanceof Node ? c : c == null ? '–' : String(c)));
  return tr;
}
const chip = (text, cls) => h(`span.chip-s${cls ? `.${cls}` : ''}`, null, text);

// ================= list view =================
let summary = { running: null, recent: [], models: [] };
let allBenchmarks = [];
let statusFilter = '';

async function loadList() {
  summary = await api('/api/benchmarks/summary');
  allBenchmarks = (await api('/api/benchmarks')).benchmarks;
  paintRunning();
  paintBenchList();
}

async function paintRunning() {
  const run = summary.running;
  $('running-box').hidden = !run;
  if (!run) return;
  $('running-line').replaceChildren(
    h('b', null, run.title),
    h('span.hint', null, `${STATUS[run.status] || run.status} · ${run.arms_done}/${run.arm_count} 組完成 · ${run.models.map(modelName).join('、')}`),
  );
  $('running-box').onclick = () => go(`#b=${run.id}`);
  $('running-flow').replaceChildren(...progressFlow(run, null));
}

/** 題目 → 實作 n/N → 最終量測 → 評審, each step coloured by where the benchmark stands */
function progressFlow(b, arms) {
  const done = arms ? arms.filter((a) => ['review', 'attention', 'failed', 'closed', null, undefined].includes(a.task_status)).length : b.arms_done;
  const total = arms ? arms.length : b.arm_count;
  const judging = b.status === 'judging';
  const judged = b.status === 'judged';
  const steps = [
    ['題目', 'ok'],
    [`實作 ${done}/${total}`, judged || judging || done === total ? 'ok' : 'active'],
    [b.acceptance_metrics ? '最終量測（一次一組）' : '收集結果', judged ? 'ok' : judging ? 'active' : 'idle'],
    ['評審', judged ? 'ok' : b.status === 'judge_failed' ? 'fail' : judging ? 'active' : 'idle'],
  ];
  const out = [];
  steps.forEach(([label, s], i) => {
    if (i) out.push(icon('chevR', { sw: 2 }));
    out.push(h('span.st', { dataset: { s } }, h('span.dot', { dataset: { st: s === 'ok' ? 'closed' : s === 'active' ? 'running' : s === 'fail' ? 'failed' : 'draft' }, style: s === 'ok' ? { background: 'var(--ok)' } : null }), label));
  });
  return out;
}

function paintBenchList() {
  const rows = allBenchmarks.filter((b) => !statusFilter || b.status === statusFilter || (statusFilter === 'running' && b.status === 'judging'));
  $('list-empty').hidden = rows.length > 0;
  $('list-count').textContent = `${rows.length} / ${allBenchmarks.length} 場`;
  $('bench-list').replaceChildren(
    ...rows.map((b) => {
      const st = b.status === 'judged' ? 'ok' : b.status === 'judge_failed' ? 'bad' : b.status === 'cancelled' ? '' : 'info';
      const card = h(
        'button.bcard',
        { type: 'button', onclick: () => go(`#b=${b.id}`) },
        h('div.row-s', null, chip(STATUS[b.status] || b.status, st), chip(domainLabel(b.domain)), b.consensus && b.status === 'judged' ? chip(CONSENSUS[b.consensus] || b.consensus) : null),
        h('div.t', null, b.title),
        h('div.row-s', null, b.winner_label ? h('span', null, '勝出 ', h('b', null, modelName(b.winner) || b.winner_label)) : h('span', null, b.status === 'judged' ? '沒有組別過關' : `${b.arms_done}/${b.arm_count} 組完成`)),
        h('div.row-s', null, ...b.models.map((m) => chip(modelName(m), isLocalId(m) ? 'local' : 'cloud'))),
        h('div.row-s', null, `${SOURCE[b.source_kind] || '題目'} · 評審 ${b.judges.map(modelName).join('、')} · ${localTime(b.created_at)}`),
      );
      return card;
    }),
  );
}
for (const b of $('filter-status').querySelectorAll('button')) {
  b.onclick = () => {
    statusFilter = b.dataset.status;
    for (const x of $('filter-status').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    paintBenchList();
  };
}

// ================= standings =================
const stFilter = { domain: '', kind: '', n: 1 };

async function loadStandings() {
  const q = new URLSearchParams();
  if (stFilter.domain) q.set('domain', stFilter.domain);
  if (stFilter.kind) q.set('kind', stFilter.kind);
  if (stFilter.n > 1) q.set('min_n', String(stFilter.n));
  const [{ matrix }, { recommendations }, h2h, sum] = await Promise.all([
    api(`/api/benchmarks/matrix${q.toString() ? `?${q}` : ''}`),
    api(`/api/benchmarks/recommend${stFilter.n > 1 ? `?min_n=${stFilter.n}` : ''}`),
    api(`/api/benchmarks/h2h${stFilter.domain ? `?domain=${encodeURIComponent(stFilter.domain)}` : ''}`),
    api('/api/benchmarks/summary'),
  ]);
  paintDomains(matrix);
  paintRecommend(recommendations);
  paintHeatmap(matrix);
  paintFirstTry(matrix);
  paintStScatter(matrix);
  paintH2H(h2h);
  paintMatrixTable(matrix);
  fillTable(
    $('records'),
    ['模型', '參賽', '勝場', '平均分', '驗證通過率'],
    sum.models.map((m) => row([modelName(m.model) || m.label, m.n, m.wins, fmt(m.avg_score), pct(m.verify_pass_rate)])),
  );
}

let seenDomains = new Set();
function paintDomains(matrix) {
  for (const m of matrix) seenDomains.add(m.domain);
  const box = $('st-domains');
  const mk = (d, label) =>
    h('button.fchip', {
      type: 'button',
      'aria-pressed': String(stFilter.domain === d),
      onclick: () => {
        stFilter.domain = d;
        loadStandings().catch((e) => pageError(e.message));
      },
    }, label);
  box.replaceChildren(mk('', '全部'), ...[...seenDomains].sort().map((d) => mk(d, domainLabel(d))));
}
for (const b of $('st-filters').querySelectorAll('[data-kind]')) {
  b.onclick = () => {
    stFilter.kind = b.dataset.kind;
    for (const x of $('st-filters').querySelectorAll('[data-kind]')) x.setAttribute('aria-pressed', String(x === b));
    loadStandings().catch((e) => pageError(e.message));
  };
}
for (const b of $('st-filters').querySelectorAll('[data-n]')) {
  b.onclick = () => {
    stFilter.n = Number(b.dataset.n);
    for (const x of $('st-filters').querySelectorAll('[data-n]')) x.setAttribute('aria-pressed', String(x === b));
    loadStandings().catch((e) => pageError(e.message));
  };
}

// which local model to hand each kind of software to, next to the best cloud model
const RECO_PILL = { cannot: ['本地模型還做不來', 'bad'], can: ['可以交給本地', 'ok'], weaker: ['做得到，但不如雲端', 'warn'], none: ['還沒有本地模型比過', ''] };
function paintRecommend(recommendations) {
  const recs = stFilter.domain ? recommendations.filter((r) => r.domain === stFilter.domain) : recommendations;
  $('recommend-empty').hidden = recs.length > 0;
  $('recommend').replaceChildren(
    ...recs.map((r) => {
      const [pill, cls] = RECO_PILL[r.kind] || RECO_PILL.none;
      const who = (m) => (m ? `${modelName(m.model)}（${m.n} 場 · 通過 ${pct(m.verify_pass_rate)}${m.first_try_rate != null ? ` · 一次就過 ${pct(m.first_try_rate)}` : ''}）` : '—');
      return h(
        'article.reco',
        { dataset: { kind: r.thin && r.kind !== 'none' ? `${r.kind}` : r.kind } },
        h('div.hd', null, h('b', null, domainLabel(r.domain)), r.thin ? chip('僅供參考', 'dashed') : null),
        chip(pill, cls),
        h('span', null, r.verdict),
        h('span.hint', null, `本地：${who(r.local)}`),
        h('span.hint', null, `雲端：${who(r.cloud)}`),
      );
    }),
  );
}

function paintHeatmap(matrix) {
  const box = $('heatmap');
  const models = [...new Set(matrix.map((m) => m.model))].sort((a, b) => Number(isLocalId(a)) - Number(isLocalId(b)) || a.localeCompare(b));
  const domains = [...new Set(matrix.map((m) => m.domain))].sort();
  if (!models.length) {
    box.replaceChildren(h('p.empty-s', null, '還沒有評分完成的評比。'));
    return;
  }
  const grid = h('div.hm', { style: { gridTemplateColumns: `150px repeat(${domains.length}, minmax(64px, 1fr))` } });
  grid.appendChild(h('span'));
  for (const d of domains) grid.appendChild(h('span.hdr', null, domainLabel(d)));
  for (const mdl of models) {
    grid.appendChild(h('span.rowh', null, modelName(mdl), chip(isLocalId(mdl) ? '本地' : '雲端', isLocalId(mdl) ? 'local' : 'cloud')));
    for (const d of domains) {
      const cell = matrix.find((m) => m.model === mdl && m.domain === d);
      if (!cell) {
        grid.appendChild(h('span.cell.none', { title: '還沒比過' }, '—'));
        continue;
      }
      const passed = Math.round(cell.verify_pass_rate * cell.n);
      grid.appendChild(
        h('span.cell', { style: { background: heatColor(cell.verify_pass_rate) }, title: `${modelName(mdl)} · ${domainLabel(d)}：${passed}/${cell.n} 通過` }, h('b', null, pct(cell.verify_pass_rate)), h('small', null, `${passed}/${cell.n}`)),
      );
    }
  }
  box.replaceChildren(grid, h('div.legend', null, h('span', null, '0%'), h('i', { style: { width: '160px', background: `linear-gradient(90deg, ${heatColor(0)}, ${heatColor(0.5)}, ${heatColor(1)})` } }), h('span', null, '100%'), h('span', null, '虛線格＝還沒比過')));
}

/** per model across the selected domains: first try / after being sent back / not passed */
function modelTotals(matrix) {
  const by = new Map();
  for (const m of matrix) {
    const t = by.get(m.model) || { model: m.model, n: 0, pass: 0, first: 0, tracked: 0, secs: 0, secN: 0 };
    t.n += m.n;
    t.pass += m.verify_pass_rate * m.n;
    if (m.first_try_rate != null && m.tracked) {
      t.first += m.first_try_rate * m.tracked;
      t.tracked += m.tracked;
    }
    if (m.avg_duration_s != null) {
      t.secs += m.avg_duration_s * m.n;
      t.secN += m.n;
    }
    by.set(m.model, t);
  }
  return [...by.values()].map((t) => ({
    ...t,
    passRate: t.n ? t.pass / t.n : 0,
    firstRate: t.tracked ? t.first / t.tracked : null,
    avgMin: t.secN ? t.secs / t.secN / 60 : null,
  }));
}

function paintFirstTry(matrix) {
  const rows = modelTotals(matrix).sort((a, b) => b.passRate - a.passRate);
  const box = $('first-try');
  if (!rows.length) {
    box.replaceChildren(h('p.empty-s', null, '還沒有資料。'));
    return;
  }
  box.replaceChildren(
    ...rows.map((t) => {
      const first = t.firstRate == null ? null : Math.min(t.passRate, t.firstRate);
      const later = first == null ? t.passRate : Math.max(0, t.passRate - first);
      const fail = Math.max(0, 1 - t.passRate);
      const seg = (cls, v, label, prefix = '') => (v > 0.001 ? h(`span.${cls}`, { style: { width: `${v * 100}%` }, title: label }, v >= 0.12 ? `${prefix}${pct(v)}` : '') : null);
      return h(
        'div.model-row',
        null,
        h('span.nm', null, modelName(t.model)),
        h('div.stack-bar', null, seg('s1', first ?? 0, `第 1 次就過 ${pct(first)}`), seg('s2', later, first == null ? `通過 ${pct(later)}（沒有嘗試紀錄）` : `被退回後才過 ${pct(later)}`), seg('s3', fail, `沒過 ${pct(fail)}`, '沒過 ')),
        h('span.n', null, `n=${t.n}`),
      );
    }),
  );
}

function paintStScatter(matrix) {
  const rows = modelTotals(matrix).filter((t) => t.avgMin != null);
  const box = $('st-scatter');
  if (!rows.length) {
    box.replaceChildren(h('p.empty-s', null, '還沒有資料。'));
    return;
  }
  const colors = colorMap(rows.map((r) => r.model));
  const xMax = Math.max(10, ...rows.map((r) => r.avgMin)) * 1.2;
  box.replaceChildren(
    scatter({
      label: '通過率 vs 平均花費時間',
      points: rows.map((r) => ({ label: modelName(r.model), x: r.avgMin, y: r.passRate * 100, r: 7 + Math.min(8, r.n), color: colors.get(r.model) })),
      xMax,
      yMax: 100,
      xFmt: (v) => `${Math.round(v)} 分`,
      yFmt: (v) => `${Math.round(v)}%`,
      good: { xBelow: xMax / 2, yAbove: 70, label: '快又穩' },
    }),
  );
}

function paintH2H(data) {
  const box = $('h2h');
  const models = data.models.filter((m) => !stFilter.kind || (stFilter.kind === 'local') === m.local);
  if (models.length < 2) {
    box.replaceChildren(h('p.empty-s', null, '至少要有兩個模型在同一場比過。'));
    return;
  }
  const grid = h('div.hm', { style: { gridTemplateColumns: `140px repeat(${models.length}, minmax(56px, 1fr))` } });
  grid.appendChild(h('span'));
  for (const m of models) grid.appendChild(h('span.hdr', null, modelName(m.model)));
  for (const a of models) {
    grid.appendChild(h('span.rowh', null, modelName(a.model)));
    for (const b of models) {
      if (a.model === b.model) {
        grid.appendChild(h('span.cell.self'));
        continue;
      }
      const p = data.pairs.find((x) => x.a === a.model && x.b === b.model);
      grid.appendChild(
        p
          ? h('span.cell', { style: { background: heatColor(p.rate) }, title: `${modelName(a.model)} 排在 ${modelName(b.model)} 前面：${p.wins}/${p.n} 場` }, h('b', null, pct(p.rate)), h('small', null, `${p.wins}/${p.n}`))
          : h('span.cell.none', null, '—'),
      );
    }
  }
  box.replaceChildren(grid);
}

function paintMatrixTable(matrix) {
  $('matrix-empty').hidden = matrix.length > 0;
  fillTable(
    $('matrix'),
    ['領域', '模型', '類型', '場數', '通過率', '一次就過', '第幾次過', '用 ncu', '平均分數', '勝率', '平均輸出 token', '平均耗時'],
    matrix.map((m) =>
      row([domainLabel(m.domain), modelName(m.model) || m.model_label, m.local ? '本地' : '雲端', m.n, pct(m.verify_pass_rate), pct(m.first_try_rate), fmt(m.avg_passed_at), pct(m.profiler_rate), fmt(m.avg_score), pct(m.win_rate), tokens(m.avg_tokens_out), dur(m.avg_duration_s)]),
    ),
  );
}

// ================= detail view: the dashboard =================
let detailId = null;
let logScale = false;
let lastDetail = null;

async function loadDetail(id) {
  detailId = id;
  const detail = await api(`/api/benchmarks/${encodeURIComponent(id)}`);
  // attempts of arms still running are not stored on the benchmark yet: read each arm's history
  const live = detail.benchmark.status === 'running' || detail.benchmark.status === 'judging';
  const histories = await Promise.all(
    detail.arms.map((a) => (a.task_status && (live || !a.attempts_json) ? api(`/api/tasks/${encodeURIComponent(a.task_id)}/runs`).catch(() => null) : Promise.resolve(null))),
  );
  lastDetail = { ...detail, histories };
  paintDetail(lastDetail);
}

function paintDetail({ benchmark: b, arms, judgements, histories }) {
  const live = b.status === 'running' || b.status === 'judging';
  $('detail-title').textContent = b.title;
  $('page-title').textContent = '評比';
  const chips = [chip(STATUS[b.status] || b.status, b.status === 'judged' ? 'ok' : b.status === 'judge_failed' ? 'bad' : live ? 'info' : '')];
  if (b.consensus && b.status === 'judged') chips.push(chip(CONSENSUS[b.consensus] || b.consensus));
  chips.push(chip(domainLabel(b.domain)), chip(`${arms.length} 組`), chip(`評審 ${(b.judge_models || b.judge_model || '').split(',').map(modelName).join('、')}`), chip(localTime(b.created_at)));
  $('detail-chips').replaceChildren(...chips);
  const src = [SOURCE[b.source_kind] || '–', b.source_ref, b.repo_path].filter(Boolean).join(' · ');
  $('detail-source').textContent = `題目來源：${src}`;
  $('detail-error').hidden = !b.error;
  $('detail-error').textContent = b.error || '';
  // re-judging a finished benchmark is exactly what the button is for; only a live run blocks it
  $('rejudge-btn').hidden = live || b.status === 'cancelled';
  $('cancel-bench-btn').hidden = !live;
  $('delete-bench-btn').hidden = live;
  $('report-link').hidden = false;
  $('report-link').href = withToken(`/api/benchmarks/${encodeURIComponent(b.id)}/report.md`);
  $('baseline-btn').hidden = live || !b.acceptance_metrics || b.status === 'cancelled';
  $('baseline-btn').textContent = b.baseline_json ? '重量基準' : '量基準';

  const specs = parseSpecs(b.acceptance_metrics);
  const head = headline(specs);
  const baseline = parseJson(b.baseline_json);
  const ranked = [...arms].sort((x, y) => (x.judge_rank ?? 99) - (y.judge_rank ?? 99) || x.model.localeCompare(y.model));
  const colors = colorMap(ranked.map((a) => a.model));
  const views = ranked.map((a) => armView(a, histories[arms.indexOf(a)], head, specs));

  paintHead(b, views, head, baseline, live);
  paintCards(views, head, baseline, colors, live);
  paintMasks(views, head, baseline, colors, specs);
  paintSwimlane(views, colors, b);
  paintConvergence(views, head, colors);
  paintDots(views, colors, b);
  paintQuality(views, colors);
  paintNotes(b, judgements, views);
  paintArmTable(ranked, views, b);
  $('measure-note').textContent = b.acceptance_metrics
    ? `每一組做完後都用同一套驗證（${parseSteps(b.verification_steps).join('、') || '驗證步驟'}）量；評分前再把每組最後的程式一組一組重新量一次（不和其他組搶 GPU），排名先看有沒有過門檻（${b.acceptance_metrics}），同樣過了才比評審分數。${baseline ? `基準是參賽前的原始程式（${String(baseline.base_sha || '').slice(0, 8)}），用同一套驗證量出來的。` : '這一場還沒有基準；按「量基準」會把參賽前的原始程式量一次。'}`
    : '這一場沒有機器量測的門檻：排名先看驗證有沒有過，再比評審分數。';
}

const parseSteps = (s) => {
  const v = parseJson(s);
  return Array.isArray(v) ? v : [];
};

/** one arm, read the same way whether it was judged (stored) or is still running (its history) */
function armView(a, history, head, specs) {
  const it = parseJson(a.attempts_json) || history?.iterations || null;
  const final = parseJson(a.final_json);
  const attempts = it?.attempts || [];
  const lastMeasured = [...attempts].reverse().find((x) => x.metrics);
  const metrics = final?.metrics || lastMeasured?.metrics || null;
  const scores = parseJson(a.scores_json);
  const mean = scores ? scores.mean || (scores.correctness != null ? scores : null) : null;
  const outcome = final ? final.outcome : a.verify_outcome === 'pass' ? 'pass' : a.verify_outcome === 'fail' ? 'fail' : null;
  const value = head && metrics && Number.isFinite(Number(metrics[head.name])) ? Number(metrics[head.name]) : null;
  return { a, it, final, attempts, metrics, mean, scores, outcome, value, provisional: !final && !!lastMeasured, history, specs };
}

function paintHead(b, views, head, baseline, live) {
  const box = $('detail-head');
  const top = views.find((v) => v.a.model === b.winner);
  const kids = [];
  if (b.status === 'judged' && top) {
    kids.push(h('span.crown', null, icon('crown')));
    const speed = head && baseline?.metrics && top.value ? speedup(head, Number(baseline.metrics[head.name]), top.value) : null;
    kids.push(
      h('div', { style: { display: 'flex', flexDirection: 'column' } }, h('span.hint', null, '勝出'), h('span.big', null, [modelName(top.a.model), top.value != null ? ` · ${fmtNum(top.value)} ${unitOf(head.name)}` : '', speed ? ` · ${speed.text}` : ''].join(''))),
    );
  } else if (b.status === 'judged') {
    kids.push(h('span.crown', null, icon('x')), h('div', null, h('span.big', null, '沒有組別過門檻'), h('span.hint', { style: { display: 'block' } }, '排名仍照評審分數，但勝出要先過機器量測的門檻。')));
  } else {
    kids.push(h('span.crown', null, icon(live ? 'spin' : 'clock')), h('div', null, h('span.big', null, live ? '評比進行中' : STATUS[b.status] || b.status), h('span.hint', { style: { display: 'block' } }, live ? '每組做完會重新量測，全部完成才評分。畫面每 10 秒更新。' : '')));
  }
  kids.push(h('span.vsep'), h('div.progress-flow', null, ...progressFlow(b, views.map((v) => v.a))));
  if (b.acceptance_metrics) kids.push(h('span.grow', { style: { flex: '1 1 auto' } }), h('span.hint', null, `門檻：${parseSpecs(b.acceptance_metrics).map(specText).join('、') || b.acceptance_metrics}`));
  box.replaceChildren(...kids);
}

/** how the arm compares with where it started */
function speedup(head, base, value) {
  if (!Number.isFinite(base) || !Number.isFinite(value) || base <= 0 || value <= 0) return null;
  const r = lowerBetter(head) ? base / value : value / base;
  if (Math.abs(r - 1) < 0.05) return { text: '和基準差不多', good: false, same: true };
  return r > 1 ? { text: `比基準${lowerBetter(head) ? '快' : '好'} ${r.toFixed(1)}×`, good: true } : { text: `比基準${lowerBetter(head) ? '慢' : '差'} ${(1 / r).toFixed(1)}×`, good: false };
}

const OUTCOME_PILL = { pass: ['通過', 'ok'], metrics: ['指標未達', 'warn'], functional: ['功能沒過', 'bad'], protected: ['改了保護路徑', 'bad'], fail: ['沒過', 'bad'] };

function paintCards(views, head, baseline, colors, live) {
  const baseVal = head && baseline?.metrics ? Number(baseline.metrics[head.name]) : null;
  $('detail-cards').replaceChildren(
    ...views.map((v) => {
      const a = v.a;
      const running = a.task_status && !['review', 'attention', 'failed', 'closed'].includes(a.task_status);
      const [pillText, pillCls] = running
        ? [taskLabel(a.task_status), 'info']
        : OUTCOME_PILL[v.outcome] || (a.task_status ? [taskLabel(a.task_status), a.task_status === 'failed' ? 'bad' : ''] : ['任務已刪除', '']);
      const rank = a.judge_rank ? ` · 第 ${a.judge_rank} 名` : '';
      const unit = head ? unitOf(head.name) : '';
      const sp = head && v.value != null ? speedup(head, baseVal, v.value) : null;
      const passHead = head && v.value != null && v.final ? (v.final.checks || []).find((c) => c.name === head.name)?.pass : null;
      const card = h(
        `article.scorecard${a.judge_rank === 1 && !live ? '.top' : ''}`,
        null,
        h('div.hd', null, h('span.sw', { style: { background: colors.get(a.model) } }), h('span.nm', null, modelName(a.model)), chip(isLocalId(a.model) ? '本地' : '雲端', isLocalId(a.model) ? 'local' : 'cloud'), h('span', { style: { flex: '1 1 auto' } }), chip(`${pillText}${rank}`, pillCls)),
      );
      if (head) {
        const d = sp ? h(`span.d${sp.good ? '.good' : sp.same ? '' : '.bad'}`, null, sp.text) : head && v.value != null ? h('span.d', null, `門檻 ${opText(head.op)} ${head.target}`) : null;
        card.appendChild(h('div.val', null, h('span.n', null, v.value != null ? fmtNum(v.value) : '–', unit ? h('small', null, ` ${unit}`) : null), d, v.provisional ? h('span.hint', null, running ? '（最近一次嘗試）' : '（本身的驗證）') : null));
        if (v.value != null) card.appendChild(bullet({ value: v.value, threshold: head.target, baseline: baseVal, pass: passHead ?? (lowerBetter(head) ? v.value <= head.target : v.value >= head.target), label: `${head.name} ${v.value}` }));
      }
      const outcomes = v.attempts.map((x) => x.outcome);
      card.appendChild(h('div.iter', null, outcomes.length ? outcomeDots(outcomes) : null, h('span', null, v.it?.label || (running ? '還在做第 1 次' : '沒有嘗試紀錄'))));
      const time = a.duration_s ?? v.attempts.reduce((s, x) => s + (x.duration_s || 0), 0);
      const outTok = a.tokens_out ?? v.attempts.reduce((s, x) => s + (x.tokens_out || 0), 0);
      card.appendChild(h('div.foot', null, h('span', null, '評分 ', h('b', null, v.mean ? fmt(v.mean.total) : '–')), h('span', null, dur(time)), h('span', null, `輸出 ${tokens(outTok)} token`), a.task_id ? h('a', { href: `/flow.html?task=${encodeURIComponent(a.task_id)}` }, '看流程') : null));
      return card;
    }),
  );
}

/** the metric family the headline belongs to (sparse_ms, flood_ms, … next to max_ms) as grouped bars */
function paintMasks(views, head, baseline, colors, specs) {
  const card = $('mask-card');
  const sources = [...views.map((v) => v.metrics), baseline?.metrics].filter(Boolean);
  if (!head || !sources.length) {
    card.hidden = true;
    return;
  }
  const suf = suffixOf(head.name);
  const keys = new Set();
  for (const m of sources) for (const k of Object.keys(m)) if (suf && k.endsWith(suf) && k !== head.name && !/^(max|min|avg|mean|total)_/.test(k) && Number.isFinite(Number(m[k]))) keys.add(k);
  let cats = [...keys];
  let title = '各項量測';
  if (cats.length < 2) {
    cats = [head.name];
    title = head.name;
  } else title = `各項 ${head.name.replace(/^max_/, '').replace(suf, '') || '量測'}（${unitOf(head.name) || suf}）`;
  const series = [];
  if (baseline?.metrics) series.push({ label: '基準', color: BASE_COLOR, base: true, values: cats.map((k) => Number(baseline.metrics[k])) });
  for (const v of views) if (v.metrics) series.push({ label: modelName(v.a.model), color: colors.get(v.a.model), hi: v.a.judge_rank === 1, values: cats.map((k) => Number(v.metrics[k])) });
  card.hidden = false;
  $('mask-title').textContent = cats.length > 1 ? '各遮罩／各項的量測' : `${head.name} 各組比較`;
  $('mask-sub').textContent = `${title}，${lowerBetter(head) ? '越低越好' : '越高越好'}${views.some((v) => v.provisional) ? '；還沒最終量測的組別用最近一次嘗試' : ''}`;
  $('mask-legend').replaceChildren(...series.map((s) => h('span', null, h('i', { style: { background: s.color } }), s.label)));
  const draw = () =>
    $('mask-chart').replaceChildren(
      groupedBars({
        label: title,
        categories: cats.map((k) => (cats.length > 1 ? k.replace(suf, '') : k)),
        series,
        threshold: specs.some((s) => s.name === head.name) ? { value: head.target, label: `門檻 ${head.target}${unitOf(head.name) ? ` ${unitOf(head.name)}` : ''}` } : null,
        unit: unitOf(head.name),
        log: logScale,
      }),
    );
  draw();
  for (const btn of $('mask-scale').querySelectorAll('button')) {
    btn.onclick = () => {
      logScale = btn.dataset.log === '1';
      for (const x of $('mask-scale').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === btn));
      draw();
    };
  }
}

function paintSwimlane(views, colors, b) {
  const box = $('swimlane');
  const starts = views.flatMap((v) => v.attempts.map((x) => tsMs(x.started_at))).filter(Number.isFinite);
  if (!starts.length) {
    box.replaceChildren(h('p.empty-s', null, '還沒有任何一組開始。'));
    return;
  }
  const t0 = Math.min(tsMs(b.created_at) || Infinity, ...starts);
  const now = Date.now();
  const mins = (t) => Math.max(0, (t - t0) / 60000);
  let max = 1;
  const rows = views.map((v) => {
    const segs = [];
    const marks = [];
    let cursor = 0;
    for (const x of v.attempts) {
      const s = tsMs(x.started_at);
      if (!Number.isFinite(s)) continue;
      const e = Number.isFinite(tsMs(x.finished_at)) ? tsMs(x.finished_at) : now;
      const from = mins(s);
      const to = mins(e);
      if (from - cursor > 1) segs.push({ from: cursor, to: from, kind: 'wait', text: cursor === 0 ? '等本地 GPU／額度' : '等下一輪' });
      const running = !x.finished_at;
      const outcome = running ? null : x.outcome;
      const headVal = x.metrics ? Object.entries(x.metrics).find(([k]) => /^max_/.test(k)) : null;
      segs.push({
        from,
        to,
        kind: 'run',
        color: colors.get(v.a.model),
        outcome,
        text: running ? '進行中' : outcome === 'pass' && headVal ? `${fmtNum(Number(headVal[1]))}` : outcome === 'metrics' && headVal ? `${fmtNum(Number(headVal[1]))}` : null,
        title: `第 ${x.attempt} 次：${dur((e - s) / 1000)}`,
      });
      const runs = x.self_runs || 0;
      if (runs > 10) marks.push({ at: (from + to) / 2, kind: 'count', text: `自己試跑 ${runs} 次` });
      else for (let k = 0; k < runs; k++) marks.push({ at: from + ((to - from) * (k + 1)) / (runs + 1) });
      if (x.profiler) marks.push({ at: from + (to - from) * 0.8, kind: 'ncu' });
      cursor = to;
      max = Math.max(max, to);
    }
    return { label: modelName(v.a.model), segs, marks };
  });
  $('swim-sub').textContent = `從 ${shortTime(new Date(t0).toISOString())} 開始，每一次嘗試的起訖（分鐘）`;
  box.replaceChildren(swimlane({ label: '迭代路徑', rows, max: Math.ceil(max * 1.08) }));
}

function paintConvergence(views, head, colors) {
  const box = $('convergence');
  if (!head) {
    $('conv-title').textContent = '每次嘗試的結果';
    const rows = views.map((v) => ({ label: modelName(v.a.model), value: v.attempts.length, color: colors.get(v.a.model) }));
    box.replaceChildren(hbars({ label: '嘗試次數', rows, unit: '次' }));
    return;
  }
  $('conv-title').textContent = `每次嘗試的 ${head.name}`;
  const n = Math.max(1, ...views.map((v) => v.attempts.length));
  const series = views.map((v) => ({
    label: modelName(v.a.model),
    color: colors.get(v.a.model),
    points: Array.from({ length: n }, (_, i) => {
      const x = v.attempts[i];
      const val = x?.metrics ? Number(x.metrics[head.name]) : NaN;
      return Number.isFinite(val) ? val : null;
    }),
    fails: v.attempts.map((x, i) => (x.outcome === 'functional' || x.outcome === 'protected' ? i : -1)).filter((i) => i >= 0),
  }));
  box.replaceChildren(
    lineChart({
      label: `每次嘗試的 ${head.name}`,
      xLabels: Array.from({ length: n }, (_, i) => `第 ${i + 1} 次`),
      series,
      band: lowerBetter(head) ? { below: head.target, label: `過關 ${opText(head.op)} ${head.target}` } : null,
    }),
  );
}

function paintDots(views, colors, b) {
  const box = $('dotplot');
  const withScores = views.filter((v) => v.mean);
  if (!withScores.length) {
    box.replaceChildren(h('p.empty-s', null, b.status === 'judged' ? '這一場沒有分項分數。' : '評完才有分數。'));
    $('dots-legend').replaceChildren();
    return;
  }
  $('dots-sub').textContent = `${(b.judge_models || b.judge_model || '').split(',').map(modelName).join('、')} 看程式碼與量測結果，0–10`;
  const rows = CRITERIA.map(([k, label]) => ({ label, values: withScores.map((v) => ({ label: modelName(v.a.model), color: colors.get(v.a.model), v: Number(v.mean[k]) })) }));
  rows.push({ label: '平均', strong: true, values: withScores.map((v) => ({ label: modelName(v.a.model), color: colors.get(v.a.model), v: Number(v.mean.total ?? v.a.judge_score) })) });
  box.replaceChildren(dotPlot({ label: '評審分數', rows, min: 0, max: 10 }));
  $('dots-legend').replaceChildren(...withScores.map((v) => h('span', null, h('i', { style: { background: colors.get(v.a.model), borderRadius: '50%' } }), `${modelName(v.a.model)} ${fmt(v.mean.total ?? v.a.judge_score)}`)));
}

function paintQuality(views, colors) {
  const box = $('quality');
  const pts = views
    .map((v) => {
      const secs = v.a.duration_s ?? v.attempts.reduce((s, x) => s + (x.duration_s || 0), 0);
      const score = v.mean?.total ?? v.a.judge_score;
      const tok = v.a.tokens_out ?? v.attempts.reduce((s, x) => s + (x.tokens_out || 0), 0);
      return secs && score != null ? { label: modelName(v.a.model), x: secs / 60, y: Number(score), tok, color: colors.get(v.a.model) } : null;
    })
    .filter(Boolean);
  if (!pts.length) {
    box.replaceChildren(h('p.empty-s', null, '評完才有這張圖。'));
    return;
  }
  const maxTok = Math.max(1, ...pts.map((p) => p.tok || 0));
  const xMax = Math.max(10, ...pts.map((p) => p.x)) * 1.2;
  box.replaceChildren(
    scatter({
      label: '品質 vs 花費時間',
      points: pts.map((p) => ({ ...p, r: 8 + 10 * Math.sqrt((p.tok || 0) / maxTok) })),
      xMax,
      yMax: 10,
      xFmt: (v) => `${Math.round(v)} 分`,
      good: { xBelow: xMax / 2, yAbove: 7.5, label: '又快又好' },
    }),
  );
}

function paintNotes(b, judgements, views) {
  $('detail-summary').textContent = b.summary || (b.status === 'judged' ? '' : '還沒有評分結果。');
  const items = [];
  for (const j of judgements) {
    items.push(h('div', null, h('div.who', null, j.error ? `${modelName(j.judge_model)}（失敗）` : `${modelName(j.judge_model)}${j.winner ? ` · 選了 ${modelName(j.winner)}` : ''}`), h('div', { class: j.error ? 'err-line' : '' }, j.error || j.summary || '（沒有摘要）')));
  }
  for (const v of views) {
    if (v.a.notes) items.push(h('div', null, h('div.who', null, `對 ${modelName(v.a.model)} 的評語`), h('div', { style: { whiteSpace: 'pre-wrap' } }, v.a.notes)));
  }
  $('detail-judges').replaceChildren(...items);
}

function paintArmTable(ranked, views, b) {
  const judges = (b.judge_models || b.judge_model || '').split(',').filter(Boolean);
  fillTable(
    $('detail-arms'),
    ['名次', '模型', '最終量測', '迭代', '平均分', ...judges.map(modelName), '輸出 token', '耗時', '變更', '任務'],
    ranked.map((a, i) => {
      const v = views[i];
      const per = v.scores || {};
      const perJudge = judges.map((j) => (per[j] ? fmt(per[j].total) : '–'));
      const final = v.final ? `${(OUTCOME_PILL[v.final.outcome] || ['–'])[0]}：${(v.final.checks || []).map((c) => `${c.name} ${c.actual == null ? '—' : fmtNum(c.actual)}${c.pass ? '' : `（要 ${c.op} ${c.target}）`}`).join('、')}` : VERIFY[a.verify_outcome] || '–';
      const task = h('a', { href: `/flow.html?task=${encodeURIComponent(a.task_id)}` }, a.task_status ? taskLabel(a.task_status) : '任務已刪除');
      return row([a.judge_rank ?? '–', modelName(a.model), final, v.it?.label || '–', fmt(a.judge_score), ...perJudge, tokens(a.tokens_out), dur(a.duration_s), a.diff_stat || '–', task]);
    }),
  );
}

$('back-btn').onclick = () => go('#list');
$('rejudge-btn').onclick = async () => {
  if (!detailId) return;
  if (!window.confirm('重新評分會再花一次雲端額度（每位評審一次），也會把每組最後的程式重新量一次。要繼續嗎？')) return;
  const btn = $('rejudge-btn');
  btn.disabled = true;
  btn.textContent = '評分中…（雲端模型，可能要幾分鐘）';
  try {
    await api(`/api/benchmarks/${encodeURIComponent(detailId)}/judge`, 'POST', {});
    await loadDetail(detailId);
  } catch (e) {
    $('detail-error').hidden = false;
    $('detail-error').textContent = `重新評分失敗：${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '重新評分';
  }
};
$('baseline-btn').onclick = async () => {
  if (!detailId) return;
  const btn = $('baseline-btn');
  btn.disabled = true;
  btn.textContent = '量測中…';
  try {
    await api(`/api/benchmarks/${encodeURIComponent(detailId)}/baseline`, 'POST', {});
    await loadDetail(detailId);
  } catch (e) {
    pageError(`量不到基準：${e.message}`);
  } finally {
    btn.disabled = false;
  }
};

$('cancel-bench-btn').onclick = async () => {
  if (!detailId) return;
  if (!window.confirm('取消這次評比？還沒跑完的組別會標成失敗，機器讓出來給下一個評比。')) return;
  const btn = $('cancel-bench-btn');
  btn.disabled = true;
  try {
    await api(`/api/benchmarks/${encodeURIComponent(detailId)}/cancel`, 'POST', {});
    await loadDetail(detailId);
  } catch (e) {
    pageError(`取消失敗：${e.message}`);
  } finally {
    btn.disabled = false;
  }
};

$('delete-bench-btn').onclick = async () => {
  if (!detailId) return;
  if (!window.confirm('刪除這次評比的比較結果？每個模型跑出來的任務會留在總覽上。')) return;
  const btn = $('delete-bench-btn');
  btn.disabled = true;
  try {
    await api(`/api/benchmarks/${encodeURIComponent(detailId)}`, 'DELETE');
    go('#list');
  } catch (e) {
    pageError(`刪不掉：${e.message}`);
    btn.disabled = false;
  }
};

// ================= new view =================
const draftState = { source: 'task', ref: null, models: new Set(), judges: new Set(['opus']), switchMin: 6 };
let usage = null; // { session, weekly } percent of the subscription window, from /api/board
let runningNow = null; // a benchmark already owns the machine: only one at a time

function setSource(kind) {
  draftState.source = kind;
  draftState.ref = null;
  for (const t of $('source-tabs').querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.src === kind);
  for (const k of ['task', 'draft', 'manual', 'builtin']) $(`src-${k}`).hidden = k !== kind;
  paintEstimate();
}
for (const t of $('source-tabs').querySelectorAll('.tab')) t.onclick = () => setSource(t.dataset.src);

function pickCard(opts) {
  const { id, title, sub, checked, disabled, onToggle } = opts;
  const label = h(`label.pick${checked ? '.on' : ''}${disabled ? '.off' : ''}`);
  const cb = h('input', { type: opts.radio ? 'radio' : 'checkbox', name: opts.radio || null, value: id });
  cb.checked = Boolean(checked);
  cb.disabled = Boolean(disabled);
  label.append(cb, h('span', null, h('span.b', null, title), h('span.s', null, sub || '')));
  cb.onchange = () => {
    onToggle(cb.checked);
    label.classList.toggle('on', cb.checked);
    if (opts.radio) for (const other of label.parentElement.querySelectorAll('.pick')) other.classList.toggle('on', other.querySelector('input').checked);
    paintEstimate();
  };
  return label;
}

async function loadBuiltin() {
  const box = $('builtin-list');
  try {
    const { questions } = await api('/api/benchmarks/builtin');
    box.replaceChildren(
      ...questions.map((q) =>
        pickCard({
          id: q.key,
          radio: 'builtin',
          title: q.title,
          sub: `${domainLabel(q.domain)} · ${q.complexity} · ${q.verification_steps[0]}`,
          checked: false,
          onToggle: (on) => {
            draftState.ref = on ? q.key : null;
          },
        }),
      ),
    );
  } catch (e) {
    box.replaceChildren(h('p.err', null, e.message));
  }
}

const taskGate = new Map(); // task id -> passes the PRD gate (can be used as a question)
// the gate speaks in column names; this page is Chinese all the way through
const GATE_FIELD = { plan_ref: '計畫檔', repo_path: 'repo 路徑', base_branch: '分支', verification_steps: '驗證指令', goal: '目標', verify_rubric: '驗收標準', setup_cmd: '前置指令', requires: '執行環境' };
const gateLabel = (m) => GATE_FIELD[String(m).split(/[ (]/)[0]] || String(m).split(/[ (]/)[0];

async function loadTasks() {
  const sel = $('task-select');
  sel.replaceChildren(h('option', null, '（選一張任務）'));
  try {
    // the board snapshot is the task list this deployment already serves — show all of it, so
    // "what is on my board" and "what can I benchmark" are the same list
    const board = await api('/api/board');
    const { cards } = board;
    usage = board.usage || null;
    runningNow = board.benchmark || null;
    taskGate.clear();
    for (const t of cards.slice(0, 200)) {
      const arm = !!t.benchmark_id || t.title.startsWith('[bench]');
      const ok = !t.gate || t.gate.ok !== false;
      taskGate.set(t.id, ok);
      const why = ok ? '' : ` · 缺 ${(t.gate.missing || []).map(gateLabel).join('、') || '必填欄位'}`;
      const o = h('option', { value: t.id }, `${t.title}（${taskLabel(t.status)}${arm ? ' · 評比用' : ''}${why}）`);
      sel.appendChild(o);
    }
    if (!cards.length) sel.appendChild(h('option', null, '總覽上還沒有任務'));
  } catch (e) {
    sel.replaceChildren(h('option', null, `讀不到總覽：${e.message}`));
  }
  sel.onchange = () => {
    draftState.ref = sel.value || null;
    paintEstimate();
  };
}

async function loadDrafts() {
  const sel = $('draft-select');
  sel.replaceChildren(h('option', null, '（選一份草稿）'));
  try {
    const { drafts } = await api('/api/prd/drafts?limit=50');
    for (const d of drafts) {
      // a draft never composed has no markdown, so the gate has nothing to read
      const ready = d.has_markdown !== 0;
      const o = h('option', { value: d.id }, `${d.title}（${localTime(d.updated_at)}${ready ? '' : ' · 還沒檢查過，不能當題目'}）`);
      o.disabled = !ready;
      sel.appendChild(o);
    }
    if (!drafts.length) sel.appendChild(h('option', null, '還沒有草稿'));
  } catch (e) {
    sel.replaceChildren(h('option', null, '工作流程（PRD）未啟用'));
  }
  sel.onchange = () => {
    draftState.ref = sel.value || null;
    paintEstimate();
  };
}

// 驗證方案 for a typed-in question: the same measured bar for every arm
let plans = [];
async function loadPlans() {
  const sel = $('m-plan');
  sel.replaceChildren(h('option', { value: '' }, '不用方案'));
  try {
    ({ plans } = await api('/api/verify-plans'));
    for (const p of plans) {
      const o = h('option', { value: p.id }, `${p.name}${p.metrics ? `（門檻：${p.metrics}）` : ''}`);
      o.dataset.repo = p.repo_path || '';
      o.dataset.domain = p.domain || '';
      sel.appendChild(o);
    }
  } catch (e) {
    /* the question can still be typed in full */
  }
  sel.onchange = () => {
    const o = sel.selectedOptions[0];
    const p = plans.find((x) => x.id === sel.value);
    if (o && o.value) {
      if (!$('m-repo').value.trim() && o.dataset.repo) $('m-repo').value = o.dataset.repo;
      if (o.dataset.domain) $('m-domain').value = o.dataset.domain;
      if (!$('m-title').value.trim() && p) $('m-title').value = p.name;
    }
    const chipsBox = $('m-plan-chips');
    chipsBox.replaceChildren();
    if (p) {
      if (p.domain) chipsBox.appendChild(chip(domainLabel(p.domain)));
      for (const s of p.steps || []) chipsBox.appendChild(chip(s, 'mono'));
      for (const m of parseSpecs(p.metrics)) chipsBox.appendChild(chip(specText(m), 'mono'));
      const prot = String(p.protected_paths || '').split(',').filter((x) => x.trim()).length;
      if (prot) chipsBox.appendChild(chip(`保護 ${prot} 條`));
    }
    paintEstimate();
  };
}

// cloud models and judges paint at once; the local catalog (a few seconds: it asks vLLM and the
// disk) is added when it arrives, so the form never sits empty
let localPicks = [];
function paintPicks() {
  const toggle = (id) => (on) => (on ? draftState.models.add(id) : draftState.models.delete(id));
  const cards = localPicks.map((p) => pickCard({ ...p, checked: draftState.models.has(p.id), onToggle: toggle(p.id) }));
  for (const [id, name, sub] of CLOUD) cards.push(pickCard({ id, title: name, sub, checked: draftState.models.has(id), onToggle: toggle(id) }));
  $('model-picks').replaceChildren(...cards);
  $('judge-picks').replaceChildren(
    ...JUDGES.map(([id, name, sub]) =>
      pickCard({ id, title: name, sub, checked: draftState.judges.has(id), onToggle: (on) => (on ? draftState.judges.add(id) : draftState.judges.delete(id)) }),
    ),
  );
}

async function loadModelPicks() {
  let entries = null;
  const picks = [];
  try {
    const cat = await api('/api/local/catalog');
    entries = cat.entries.filter((e) => e.registered_id || e.action === 'switch');
    for (const e of cat.entries) if (e.registered_id) MODEL_NAMES.set(`local:${e.registered_id}`, e.name);
    draftState.switchMin = 6;
  } catch (e) {
    /* local models disabled — fall back to the registered list */
  }
  if (entries) {
    for (const e of entries) {
      const ready = e.action === 'switch';
      picks.push({
        id: `local:${e.registered_id || e.recipe}`,
        title: `${e.name}${e.loaded ? '（使用中）' : ''}`,
        sub: ready ? `本地 · ${gb(e.disk_bytes || e.size_bytes)}` : `不能參賽：${e.blocked_by || '未就緒'}`,
        disabled: !ready || !e.registered_id,
      });
    }
  } else {
    try {
      const { models } = await api('/api/local/models');
      for (const m of models) picks.push({ id: `local:${m.id}`, title: m.display_name, sub: m.runnable ? '本地' : `不能參賽：${m.blocked_by || '未就緒'}`, disabled: !m.runnable });
    } catch (e) {
      /* no local models at all */
    }
  }
  localPicks = picks;
  paintPicks();
  paintEstimate();
}

function sourceLabel() {
  if (draftState.source === 'manual') return $('m-title').value.trim() || ($('m-plan').value ? $('m-plan').selectedOptions[0]?.textContent : null) || '（自己出題）';
  if (!draftState.ref) return null;
  if (draftState.source === 'builtin') return `內建題：${draftState.ref}`;
  if (draftState.source === 'task') return $('task-select').selectedOptions[0]?.textContent || draftState.ref;
  return $('draft-select').selectedOptions[0]?.textContent || draftState.ref;
}

function paintEstimate() {
  const box = $('estimate');
  const models = [...draftState.models];
  const locals = models.filter((m) => m.startsWith('local:'));
  const problems = [];
  const label = sourceLabel();
  if (!label) problems.push('還沒選題目');
  if (draftState.source === 'manual' && !$('m-goal').value.trim()) problems.push('要寫題目說明');
  if (draftState.source === 'manual' && !$('m-repo').value.trim() && !$('m-plan').value) problems.push('自己出題要填 Repo 路徑（或選一個有 repo 的驗證方案）');
  if (draftState.source === 'manual' && !$('m-plan').value && !$('m-verify').value.trim()) problems.push('自己出題要填驗證指令（或選一個驗證方案）');
  if (draftState.source === 'task' && taskGate.get(draftState.ref) === false) problems.push('這張任務還缺 repo 或計畫，先在總覽補齊才能當題目');
  if (models.length < 2) problems.push('至少選 2 個參賽模型');
  if (!draftState.judges.size) problems.push('至少選 1 位評審');
  $('pick-count').textContent = models.length ? `已選 ${models.length} 個` : '至少 2 個';

  const cloud = models.filter((m) => !m.startsWith('local:'));
  if (runningNow) problems.push(`已經有一個評比在跑：「${runningNow.title}」，先讓它跑完或取消`);

  const switches = Math.max(0, locals.length);
  const minutes = switches * draftState.switchMin + models.length * 12 + draftState.judges.size * 3;
  box.replaceChildren();
  box.append(h('div', null, `題目：${label || '—'}`));
  box.append(h('div', null, `參賽：${models.length ? models.map(modelName).join('、') : '—'}`));
  box.append(h('div', null, `評審：${[...draftState.judges].map(modelName).join('、') || '—'}`));
  if (!problems.length) {
    box.append(h('div', null, `預計 ${minutes} 分鐘上下：切換本地模型 ${switches} 次（每次約 ${draftState.switchMin} 分鐘）＋ 每組實作時間 ＋ 評分。`));
    // the only thing that spends the subscription is cloud arms and the judges
    const spend = cloud.length + draftState.judges.size;
    const now = usage ? `目前用量 5 小時 ${usage.session}%、本週 ${usage.weekly}%` : '用量讀不到';
    box.append(h('div.hint', null, `會花訂閱額度的有 ${spend} 次雲端呼叫：參賽 ${cloud.length} 組＋評審 ${draftState.judges.size} 位。${now}。`));
    if (usage && (usage.session >= 70 || usage.weekly >= 80) && spend > 0) {
      box.append(h('div.err', null, `用量偏高（5 小時 ${usage.session}%、本週 ${usage.weekly}%），雲端組別可能會被排到額度回補之後才跑。`));
    }
    if (locals.length) box.append(h('div.hint', null, '評比期間對話頁會顯示「評比使用中」，模型切換鈕會鎖住；結束後自動切回原本的模型。'));
  } else {
    box.append(h('div.err', null, problems.join('；')));
  }
  $('bench-submit').disabled = problems.length > 0;
}
for (const id of ['m-title', 'm-goal', 'm-repo', 'm-verify']) $(id).oninput = paintEstimate;

$('bench-submit').onclick = async () => {
  const btn = $('bench-submit');
  const err = $('form-err');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = '建立中…';
  const body = {
    source: { kind: draftState.source, ref: draftState.ref },
    models: [...draftState.models],
    judge_models: [...draftState.judges],
  };
  if (draftState.source === 'manual') {
    body.overrides = {
      title: $('m-title').value.trim(),
      goal: $('m-goal').value.trim(),
      repo_path: $('m-repo').value.trim(),
      base_branch: $('m-branch').value.trim() || 'main',
      verification_steps: $('m-verify').value.split('\n').map((s) => s.trim()).filter(Boolean),
      domain: $('m-domain').value,
      ...($('m-plan').value ? { verify_plan_id: $('m-plan').value } : {}),
    };
  }
  try {
    const { benchmark } = await api('/api/benchmarks', 'POST', body);
    go(`#b=${benchmark.id}`);
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '開始評比';
    paintEstimate();
  }
};
$('cancel-new').onclick = () => go('#list');
$('nav-new').onclick = () => go('#new');
for (const b of $('view-tabs').querySelectorAll('button')) b.onclick = () => go(b.dataset.view === 'standings' ? '#standings' : '#list');

// ================= routing =================
let timer = null;
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  const hash = location.hash || '#list';
  const detail = /^#b=(.+)$/.exec(hash);
  const view = detail ? 'detail' : hash === '#new' ? 'new' : hash === '#standings' ? 'standings' : 'list';
  for (const v of ['list', 'standings', 'detail', 'new']) $(`view-${v}`).hidden = v !== view;
  for (const b of $('view-tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String((b.dataset.view === 'standings') === (view === 'standings') && view !== 'detail' && view !== 'new'));
  $('nav-new').hidden = view === 'new';
  if (timer) clearInterval(timer);
  timer = null;
  try {
    pageError('');
    if (view === 'detail') {
      await loadDetail(decodeURIComponent(detail[1]));
      timer = setInterval(() => loadDetail(detailId).catch((e) => pageError(`更新不了這頁：${e.message}`)), 10000);
    } else if (view === 'new') {
      setSource(draftState.source);
      paintPicks();
      await Promise.all([loadBuiltin(), loadTasks(), loadDrafts(), loadPlans(), loadModelPicks()]);
      paintEstimate();
    } else if (view === 'standings') {
      await loadStandings();
    } else {
      await loadList();
      timer = setInterval(() => loadList().catch((e) => pageError(`更新不了列表：${e.message}`)), 15000);
    }
    $('disabled-note').hidden = true;
  } catch (e) {
    if (e.status === 404) {
      $('disabled-note').hidden = false;
      for (const v of ['list', 'standings', 'detail', 'new']) $(`view-${v}`).hidden = true;
    } else if (view === 'new') {
      $('form-err').hidden = false;
      $('form-err').textContent = e.message;
    } else {
      pageError(e.message);
    }
  }
}

document.addEventListener('frame:theme', () => lastDetail && paintDetail(lastDetail));
window.addEventListener('hashchange', render);
render();
