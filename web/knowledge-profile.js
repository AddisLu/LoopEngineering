// 知識 page tabs: Repo 檔案 (default) · 待核可 · 機況診斷 · 全覽 (the star graph, brain.js — started
// only when first opened). Repo 檔案 is what a local model is told about a repo: what it needs to
// build and run (and which machine has it), how it is written, its modules, how it is verified, its
// parameter / log / incident index, the hot files, and what Loop learned — 陷阱 and 解法 — each
// marked 偵測 / 推論 / 學到 with 核可 / 拒絕. textContent-only (frame.js h()).
import { $, h, fill, api, toast, tsMs } from './frame.js';

const enc = encodeURIComponent;
const TABS = ['profile', 'drafts', 'diag', 'graph'];
let repos = [];
let repoId = null;
let view = null;
let poll = null;

// ---- tabs -------------------------------------------------------------------------------------

function tabFromHash() {
  const t = location.hash.replace(/^#/, '').split('&')[0];
  return TABS.includes(t) ? t : 'profile';
}

export function showTab(tab) {
  for (const t of TABS) {
    const btn = document.querySelector(`[data-ktab="${t}"]`);
    if (btn) btn.setAttribute('aria-selected', String(t === tab));
  }
  $('profile-stage').hidden = tab !== 'profile';
  $('drafts-stage').hidden = tab !== 'drafts';
  $('diag-stage').hidden = tab !== 'diag';
  $('graph-stage').hidden = tab !== 'graph';
  for (const el of document.querySelectorAll('.graph-only')) el.hidden = tab !== 'graph';
  document.body.dataset.ktab = tab;
  if (location.hash.replace(/^#/, '').split('&')[0] !== tab) history.replaceState(null, '', `#${tab}${repoId ? `&repo=${enc(repoId)}` : ''}`);
  if (tab === 'graph') window.dispatchEvent(new CustomEvent('loop:graph-show'));
  if (tab === 'drafts') loadDrafts();
  if (tab === 'diag') window.dispatchEvent(new CustomEvent('loop:diag-show', { detail: { repoId } }));
}

const ago = (s) => {
  const t = tsMs(s);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : m < 48 * 60 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 天前`;
};

// ---- Repo 檔案 --------------------------------------------------------------------------------

async function loadRepos() {
  try {
    repos = (await api('/api/repos')).repos || [];
  } catch {
    repos = [];
  }
  const want = new URLSearchParams(location.hash.replace(/^#[^&]*&?/, '')).get('repo');
  repoId = repos.some((r) => r.id === want) ? want : repos[0] ? repos[0].id : null;
  const sel = $('kp-repo');
  fill(sel, repos.length ? repos.map((r) => h('option', { value: r.id }, r.name)) : h('option', { value: '' }, '（還沒有 repo）'));
  sel.value = repoId || '';
}

async function loadProfile() {
  clearTimeout(poll);
  if (!repoId) {
    fill($('kp-body'), h('div.kp-empty', null, h('p', null, '還沒有匯入 repo。'), h('a.btn.primary', { href: '/repos.html' }, '到 Repo 頁匯入')));
    fill($('kp-status'));
    return;
  }
  try {
    view = await api(`/api/repos/${enc(repoId)}/profile`);
  } catch (err) {
    fill($('kp-body'), h('p.err-line', null, `讀不到：${err.message}`));
    return;
  }
  paintStatus();
  paintProfile();
  if (view.status === 'running') poll = setTimeout(loadProfile, 2000);
}

function paintStatus() {
  const v = view;
  const fp = v.first_pass;
  const running = v.status === 'running';
  fill(
    $('kp-status'),
    running
      ? h('span.chip-s.info', null, v.stage === 'b' ? '本地模型整理中…' : '分析中…')
      : v.status === 'failed'
        ? h('span.chip-s.bad', { title: v.error || '' }, '分析失敗')
        : v.built_at
          ? h('span.kp-muted', null, `偵測於 ${ago(v.built_at)}${v.sha ? ` @ ${String(v.sha).slice(0, 7)}` : ''}`)
          : h('span.kp-muted', null, '還沒分析過'),
    fp && fp.n ? h('span.chip-s', { title: `${fp.first} / ${fp.n} 張第一次就全綠且沒被退回` }, `一次改對率 ${Math.round(fp.rate * 100)}%（${fp.n} 張）`) : null,
  );
  $('kp-run').disabled = running;
  $('kp-infer').disabled = running || !v.facets;
}

const card = (title, sub, ...body) => h('section.kp-card', null, h('div.kp-hd', null, h('h2', null, title), sub ? h('span.kp-sub', null, sub) : null), ...body);
const ev = (e) => (e && e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : '');
const evList = (arr) => (arr && arr.length ? h('span.kp-ev', { title: arr.map(ev).join('\n') }, ev(arr[0]) + (arr.length > 1 ? ` 等 ${arr.length} 處` : '')) : null);
const KIND_ZH = { os: '作業系統', arch: '架構', toolchain: '工具鏈', sdk: 'SDK', library: '函式庫', runtime: '執行環境', hardware: '硬體', license: '授權', gpu: 'GPU' };
const SOURCE_ZH = { detected: '偵測', inferred: '推論', learned: '學到', manual: '手動', seed: '種子', distilled: '蒸餾', mcp: 'MCP' };

function paintProfile() {
  const v = view;
  const f = v.facets;
  if (!f) {
    fill(
      $('kp-body'),
      h(
        'div.kp-empty',
        null,
        h('p', null, v.status === 'running' ? '正在分析這個 repo（不用模型，通常幾秒）…' : '這個 repo 還沒分析過。'),
        v.status === 'running' ? null : h('button.btn.primary', { type: 'button', onclick: () => rebuild(false) }, '分析這個 repo'),
      ),
    );
    return;
  }
  fill(
    $('kp-body'),
    h(
      'div.kp-grid',
      null,
      requirementsCard(f, v.fit),
      styleCard(f.style || [], v.nodes.style || []),
      modulesCard(f.modules || [], v.nodes.module || []),
      verifyCard(f.verify),
      learnedCard('陷阱', '本地模型最常卡住的地方；派工、分析、驗證失敗時會先提醒它', v.nodes.pitfall || [], '還沒學到。任務沒有一次過（檢查失敗、換模型、被退回）時，Loop 會在結案時整理成草稿。'),
      learnedCard('解法', '這類問題在這個 repo 怎麼解', v.nodes.playbook || [], '還沒有。'),
      indexCard(v.index_counts || {}),
      hotspotsCard(f.hotspots || []),
      learnedCard('機況案例', '確認過原因的機況；相同特徵的下一次直接命中', v.nodes.case || [], '還沒有。機況診斷後按「記成案例」。'),
    ),
  );
}

function requirementsCard(f, fit) {
  const reqs = f.requirements || [];
  const row = (r) =>
    h('tr', null, h('td.nowrap', null, KIND_ZH[r.kind] || r.kind), h('td', null, h('b', null, r.name), r.version ? ` ${r.version}` : '', r.note ? h('div.kp-note', null, r.note) : null), h('td', null, evList(r.evidence)));
  // grouped by module (one build), each folded except the first two
  const groups = new Map();
  for (const r of reqs) groups.set(r.module || '整個 repo', [...(groups.get(r.module || '整個 repo') || []), r]);
  const blocks = [...groups].map(([mod, list], i) =>
    h('details.kp-group', { open: i < 2 }, h('summary', null, h('b', null, mod), h('span.kp-muted', null, ` · ${list.length} 項：${[...new Set(list.map((r) => r.name))].slice(0, 5).join('、')}${list.length > 5 ? '…' : ''}`)), h('table.kp-table', null, h('tbody', null, list.map(row)))),
  );
  const fitRows = (fit || []).map((m) => {
    const bad = m.items.filter((i) => i.state === 'bad');
    const unk = m.items.filter((i) => i.state === 'unknown');
    return h(
      'details.kp-fit',
      null,
      h('summary', null, h('span', { dataset: { fit: bad.length ? 'bad' : unk.length ? 'unknown' : 'ok' } }, bad.length ? '✗' : unk.length ? '？' : '✓'), h('b', null, m.name), h('span.kp-muted', null, ` 符合 ${m.ok}/${m.items.length}${bad.length ? `，不符 ${bad.length}` : ''}${unk.length ? `，不確定 ${unk.length}` : ''}`)),
      h('ul', null, m.items.map((i) => h('li', { dataset: { fit: i.state } }, `${i.state === 'ok' ? '✓' : i.state === 'bad' ? '✗' : '？'} ${i.requirement}：${i.why}`))),
    );
  });
  return card(
    '環境需求',
    `${reqs.length} 項；挑機台用，「不確定」通常是機台頁的「其他軟體」還沒寫`,
    h('h3', null, '哪台機台適合'),
    fitRows.length ? fitRows : h('p.kp-muted', null, '還沒有機台；到機台頁新增並按「檢查」。'),
    h('h3', null, '各模組需要'),
    reqs.length ? blocks : h('p.kp-muted', null, '沒有偵測到需求。'),
  );
}

function styleCard(styles, rules) {
  const one = (s, i) =>
    h(
      'details.kp-style',
      { open: i === 0 },
      h('summary', null, h('b', null, s.module || '整個 repo'), h('span.kp-muted', null, ` · 抽樣 ${s.files_sampled} 檔${s.languages && s.languages.length ? ` · ${s.languages.join('、')}` : ''}${s.encoding && s.encoding.dominant && s.encoding.dominant !== 'utf8' ? ` · ${s.encoding.dominant === 'big5' ? 'Big5' : s.encoding.dominant === 'utf8_bom' ? 'UTF-8 BOM' : '編碼混用'}` : ''}`)),
      h(
        'div.kp-facts',
        null,
        fact('編碼', s.encoding && s.encoding.dominant ? `${{ utf8: 'UTF-8', utf8_bom: 'UTF-8（BOM）', big5: 'Big5', mixed: '混用' }[s.encoding.dominant] || s.encoding.dominant}${s.encoding.big5 ? `（Big5 ${s.encoding.big5} 檔）` : ''}` : null, s.encoding && (s.encoding.dominant === 'big5' || s.encoding.dominant === 'mixed')),
        fact('換行', s.eol ? { crlf: 'CRLF', lf: 'LF', mixed: '混用' }[s.eol] : null),
        fact('縮排', s.indent ? { tab: 'Tab', 2: '2 格', 4: '4 格', mixed: '混用' }[s.indent] : null),
        fact('大括號', s.brace ? { same_line: '同一行', next_line: '換行', mixed: '混用' }[s.brace] : null),
        fact('命名', (s.naming || []).join('；') || null),
        fact('標頭', s.header_guard ? { pragma_once: '#pragma once', ifndef: '#ifndef 守衛', mixed: '混用' }[s.header_guard] : null),
        fact('註解', s.comment_lang ? { zh: '中文', en: '英文', mixed: '中英混用' }[s.comment_lang] : null),
        fact('錯誤處理', (s.error_handling || []).join('、') || null),
        fact('log', (s.logging || []).join('、') || null),
        fact('字串', (s.strings || []).join('、') || null),
        fact('設定檔', (s.configs || []).map(ev).join('、') || null),
      ),
    );
  return card('寫法', '交給模型時要它照這個寫；編碼寫錯最容易整檔壞掉', styles.length ? styles.map(one) : h('p.kp-muted', null, '沒有可抽樣的程式檔。'), rules.length ? [h('h3', null, '寫法規則'), nodeList(rules)] : null);
}

function fact(k, v, warn) {
  if (!v) return null;
  return [h('span.k', null, k), h(`span.v${warn ? '.kp-warn' : ''}`, null, v)];
}

function modulesCard(mods, notes) {
  const out = { exe: '執行檔', gui_exe: 'GUI 程式', lib: '函式庫', dll: 'DLL', script: '腳本' };
  return card(
    '架構',
    `${mods.length} 個模組`,
    mods.length
      ? h(
          'table.kp-table',
          null,
          h('thead', null, h('tr', null, ['模組', '種類', '依賴', '進入點'].map((t) => h('th', null, t)))),
          h(
            'tbody',
            null,
            mods.map((m) => {
              const summary = notes.find((n) => n.title === m.name || n.title.startsWith(`${m.name}`));
              return h(
                'tr',
                null,
                h('td', null, h('b', null, m.name), h('div.kp-muted', null, `${m.path || '.'} · ${m.files} 檔`), summary ? h('div.kp-note', null, summary.body) : null),
                h('td.nowrap', null, [m.language, out[m.output] || m.output].filter(Boolean).join(' · ')),
                h('td', null, (m.depends_on || []).join('、') || '—'),
                h('td.mono', null, (m.entry_points || []).slice(0, 3).join('\n') || '—'),
              );
            }),
          ),
        )
      : h('p.kp-muted', null, '沒有偵測到模組。'),
  );
}

function verifyCard(v) {
  if (!v) return card('驗證方式', null, h('p.kp-muted', null, '—'));
  return card(
    '驗證方式',
    '修完怎麼證明是好的',
    h(
      'div.kp-facts',
      null,
      fact('測試框架', (v.frameworks || []).map((f) => `${f.name}${f.module ? `（${f.module}）` : ''}`).join('、') || '沒有偵測到'),
      fact('指令', (v.commands || []).map((c) => `${c.label}：${c.command}`).join('\n') || null),
      fact('命令列入口', (v.headless || []).map((x) => `${x.module}：${x.how}`).join('\n') || null),
      fact('只有 GUI', (v.gui_only || []).join('、') || null, (v.gui_only || []).length > 0),
      fact('評估腳本', (v.eval_scripts || []).join('、') || null),
      fact('答案檔', (v.answer_files || []).join('、') || null),
      fact('建議保護', (v.protected_suggestions || []).join('、') || null),
    ),
    h('a.kp-link', { href: `/repos.html?id=${enc(repoId)}#checks` }, '到 Repo 頁設定檢查'),
  );
}

function hotspotsCard(spots) {
  return card(
    '熱點',
    '常被修的檔案：改到時多一分小心',
    spots.length
      ? h('table.kp-table', null, h('tbody', null, spots.slice(0, 12).map((s) => h('tr', null, h('td.mono', null, s.file), h('td.nowrap', null, `修 ${s.fix_commits} 次`), h('td.nowrap.kp-muted', null, `共 ${s.commits} 次`)))))
      : h('p.kp-muted', null, '沒有足夠的歷史。'),
  );
}

function indexCard(counts) {
  const q = h('input.kp-search', { type: 'search', placeholder: '找參數、log 字串、incident、錯誤碼（例：pitch_x、bad_json、timeout）', 'aria-label': '搜尋參數與告警' });
  const kindSel = h('select.kp-kind', { 'aria-label': '種類' }, [['', '全部'], ['param', '參數（設定檔）'], ['param_use', '參數（程式讀取處）'], ['log', 'log 字串'], ['incident', 'incident'], ['error_code', '錯誤碼']].map(([v, t]) => h('option', { value: v }, t)));
  const out = h('div.kp-results');
  let timer = null;
  const run = async () => {
    try {
      const r = await api(`/api/repos/${enc(repoId)}/index?q=${enc(q.value.trim())}&kind=${enc(kindSel.value)}&limit=40`);
      const KZ = { param: '參數', param_use: '讀取', log: 'log', incident: 'incident', error_code: '錯誤碼' };
      fill(
        out,
        r.entries.length
          ? h(
              'table.kp-table',
              null,
              h(
                'tbody',
                null,
                r.entries.map((e) =>
                  h(
                    'tr',
                    null,
                    h('td.nowrap', null, KZ[e.kind] || e.kind),
                    h('td', null, h('b.mono', null, e.section ? `[${e.section}] ${e.key}` : e.key), e.value != null ? h('span.kp-muted', null, ` = ${e.value}`) : null, e.meaning ? h('div.kp-note', null, e.meaning) : null),
                    h('td.mono', null, `${e.file}:${e.line}`, h('div.kp-muted', null, e.text)),
                  ),
                ),
              ),
            )
          : h('p.kp-muted', null, '找不到。'),
      );
    } catch (err) {
      fill(out, h('p.err-line', null, err.message));
    }
  };
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  kindSel.addEventListener('change', run);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sub = total ? `參數 ${counts.param || 0} · 讀取處 ${counts.param_use || 0} · log ${counts.log || 0} · incident ${counts.incident || 0} · 錯誤碼 ${counts.error_code || 0}` : '還沒有索引';
  setTimeout(run, 0);
  return card('參數與告警', sub, h('p.kp-muted', null, '機況診斷用它把 log、參數、incident 對到程式碼。'), h('div.kp-row', null, q, kindSel), out);
}

function nodeList(nodes) {
  return h(
    'div.kp-nodes',
    null,
    nodes.map((n) =>
      h(
        `article.kp-node${n.status === 'draft' ? '.draft' : ''}`,
        null,
        h(
          'div.kp-node-hd',
          null,
          h('b', null, n.title),
          h('span.chip-s', null, SOURCE_ZH[n.source] || n.source),
          n.status === 'draft' ? h('span.chip-s.warn', null, '草稿') : h('span.chip-s.ok', null, '已核可'),
          n.hits && n.hits.shown ? h('span.kp-muted', { title: '提示過幾次、之後過了幾次' }, ` 用過 ${n.hits.shown} 次，之後過 ${n.hits.passed} 次`) : null,
        ),
        h('p', null, n.body),
        n.trigger && (n.trigger.words.length || n.trigger.files.length) ? h('div.kp-muted', null, `辨認：${[...n.trigger.words, ...n.trigger.files].slice(0, 8).join('、')}`) : null,
        n.evidence && n.evidence.length ? h('div.kp-muted', null, '來自：', n.evidence.slice(0, 4).map((e, i) => [i ? '、' : '', e.task ? h('a', { href: `/task.html?id=${enc(e.task)}` }, e.task) : ev(e)])) : null,
        h(
          'div.kp-acts',
          null,
          n.status === 'draft' ? h('button.btn.sm.primary', { type: 'button', onclick: () => decide(n.id, 'approve') }, '核可') : null,
          h('button.btn.sm', { type: 'button', onclick: () => decide(n.id, 'reject') }, n.status === 'draft' ? '拒絕' : '不再使用'),
        ),
      ),
    ),
  );
}

function learnedCard(title, sub, nodes, empty) {
  const drafts = nodes.filter((n) => n.status === 'draft').length;
  return card(title, `${sub}${drafts ? `（${drafts} 個草稿待核可）` : ''}`, nodes.length ? nodeList(nodes) : h('p.kp-muted', null, empty));
}

async function decide(id, what) {
  try {
    await api(`/api/knowledge/${enc(id)}/${what}`, 'POST', {});
    toast(what === 'approve' ? '已核可：之後的任務會用到' : '已拒絕');
    if (document.body.dataset.ktab === 'drafts') loadDrafts();
    else loadProfile();
  } catch (err) {
    toast(`做不到：${err.message}`, 'bad');
  }
}

async function rebuild(infer) {
  try {
    await api(`/api/repos/${enc(repoId)}/profile`, 'POST', { infer });
    toast(infer ? '本地模型開始整理（草稿會出現在各卡片）' : '開始分析');
    setTimeout(loadProfile, 500);
  } catch (err) {
    toast(`開始不了：${err.message}`, 'bad');
  }
}

// ---- 待核可 ------------------------------------------------------------------------------------

async function loadDrafts() {
  const box = $('drafts-body');
  let r;
  try {
    r = await api('/api/knowledge/facet-drafts');
  } catch (err) {
    fill(box, h('p.err-line', null, err.message));
    return;
  }
  const groups = new Map();
  for (const n of r.nodes) {
    const k = n.repo ? n.repo.name : n.scope;
    groups.set(k, [...(groups.get(k) || []), n]);
  }
  const all = r.nodes.map((n) => n.id);
  fill(
    box,
    r.nodes.length
      ? [
          h('div.kp-row', null, h('span', null, `${r.nodes.length} 個草稿`), h('span.grow'), h('button.btn.primary', { type: 'button', onclick: () => approveMany(all) }, '全部核可')),
          [...groups].map(([name, nodes]) => h('section.kp-card', null, h('div.kp-hd', null, h('h2', null, name), h('span.kp-sub', null, `${nodes.length} 個`)), nodeList(nodes))),
        ]
      : h('div.kp-empty', null, h('p', null, '沒有待核可的知識。')),
  );
}

async function approveMany(ids) {
  if (!confirm(`核可 ${ids.length} 個草稿？核可後派工、分析與續跑都會用到它們。`)) return;
  try {
    await api('/api/knowledge/approve-many', 'POST', { ids });
    toast('已核可');
    loadDrafts();
  } catch (err) {
    toast(`做不到：${err.message}`, 'bad');
  }
}

// ---- wiring -----------------------------------------------------------------------------------

function wire() {
  for (const t of TABS) {
    const btn = document.querySelector(`[data-ktab="${t}"]`);
    if (btn) btn.addEventListener('click', () => showTab(t));
  }
  $('kp-repo').addEventListener('change', (e) => {
    repoId = e.target.value || null;
    history.replaceState(null, '', `#profile${repoId ? `&repo=${enc(repoId)}` : ''}`);
    loadProfile();
  });
  $('kp-run').addEventListener('click', () => rebuild(false));
  $('kp-infer').addEventListener('click', () => rebuild(true));
}

wire();
showTab(tabFromHash());
await loadRepos();
loadProfile();
