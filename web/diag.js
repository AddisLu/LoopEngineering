// 機況診斷 (知識 page tab): paste or drop what a production machine produced — the flight recorder's
// _diag/*.jsonl and incident_*.json, the machine's .ini, application logs, OCR text of a screenshot —
// and Loop parses it, maps every event / parameter to code through the repo's 參數與告警 index,
// matches past 機況案例 and learned 陷阱, and the local model sorts the cause into 參數 / 環境・硬體 /
// 程式 / 圖資 with evidence. Next steps: 開問題單 (code), parameter suggestions (never written to a
// machine), 記成案例. textContent-only.
import { $, h, fill, api, toast, tsMs } from './frame.js';
import { openTicket, takeDiagHandoff } from './fix-handoff.js';

const enc = encodeURIComponent;
const MAX_FILE = 5 * 1024 * 1024;
let repos = [];
let files = []; // {name, text}
let current = null;
let poll = null;
let booted = false;

const CAT = { param: '參數設定', environment: '環境／硬體', code: '程式 bug', data: '資料（圖資）', unknown: '還不確定' };
const ago = (s) => {
  const t = tsMs(s);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : m < 48 * 60 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 天前`;
};

function paintForm(repoId) {
  const repoSel = h('select.kp-kind', { id: 'dg-repo', 'aria-label': 'Repo' }, repos.map((r) => h('option', { value: r.id }, r.name)), h('option', { value: '' }, '（不指定 repo）'));
  repoSel.value = repoId && repos.some((r) => r.id === repoId) ? repoId : repos[0] ? repos[0].id : '';
  const text = h('textarea.dg-text', { id: 'dg-text', rows: 8, placeholder: '貼上機台的 log、_diag/*.jsonl、incident_*.json、.ini 內容，或截圖辨識出的文字。也可以把檔案拖進來。' });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, accept: '.json,.jsonl,.ini,.log,.txt,.csv,.xml,.cfg' });
  const list = h('div.dg-files', { id: 'dg-files' });
  const note = h('input.kp-search', { id: 'dg-note', type: 'text', maxlength: 400, placeholder: '現象（選填）：例如「IP01 每隔幾分鐘就判一次 bad_json」「左側邊緣過殺」' });
  const paintFiles = () =>
    fill(
      list,
      files.map((f, i) =>
        h('span.chip-s', null, `${f.name}（${Math.max(1, Math.round(f.text.length / 1024))} KB）`, h('button.dg-x', { type: 'button', 'aria-label': `移除 ${f.name}`, onclick: () => (files.splice(i, 1), paintFiles()) }, '×')),
      ),
    );
  const addFiles = async (list) => {
    for (const f of list) {
      if (f.size > MAX_FILE) {
        toast(`${f.name} 太大（上限 5 MB）`, 'bad');
        continue;
      }
      if (/^image\//.test(f.type)) {
        toast('截圖請先在對話裡貼上取得文字，再貼到這裡', 'warn');
        continue;
      }
      files.push({ name: f.name, text: await f.text() });
    }
    paintFiles();
  };
  fileIn.addEventListener('change', () => addFiles([...fileIn.files]));
  const drop = h(
    'div.dg-drop',
    {
      ondragover: (e) => (e.preventDefault(), drop.classList.add('over')),
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => (e.preventDefault(), drop.classList.remove('over'), addFiles([...e.dataTransfer.files])),
    },
    text,
    h('div.kp-row', null, h('button.btn.sm', { type: 'button', onclick: () => fileIn.click() }, '加入檔案'), list, fileIn),
  );
  const go = h('button.btn.primary', { type: 'button', id: 'dg-go', onclick: () => submit() }, '分析');
  paintFiles();
  return h(
    'section.kp-card',
    null,
    h('div.kp-hd', null, h('h2', null, '機況診斷'), h('span.kp-sub', null, '把機台的 log／incident／參數對到程式碼、過去的案例與學到的陷阱；只給建議，不會寫入機台')),
    h('div.kp-row', null, h('label.kp-repo-l', null, 'Repo ', repoSel)),
    drop,
    note,
    h('div.kp-row', null, go, h('span.kp-muted', null, '解析與對程式碼不用模型；歸因用本地模型（約 30 秒）')),
  );
}

async function submit() {
  const pasted = $('dg-text').value.trim();
  const inputs = [...files];
  if (pasted) inputs.unshift({ name: '貼上的內容', text: pasted });
  if (!inputs.length) return toast('先貼上內容或加入檔案', 'warn');
  $('dg-go').disabled = true;
  try {
    const r = await api('/api/diag', 'POST', { repo_id: $('dg-repo').value || null, note: $('dg-note').value.trim() || null, inputs });
    current = r.report;
    files = [];
    $('dg-text').value = '';
    paintResult();
    watch();
  } catch (err) {
    toast(`分析不了：${err.message}`, 'bad');
  } finally {
    $('dg-go').disabled = false;
  }
}

function watch() {
  clearTimeout(poll);
  if (!current || !['pending', 'running'].includes(current.status)) return loadHistory();
  poll = setTimeout(async () => {
    try {
      current = (await api(`/api/diag/${enc(current.id)}`)).report;
      paintResult();
    } catch {
      /* try again */
    }
    watch();
  }, 2000);
}

function paintResult() {
  const box = $('dg-result');
  const r = current;
  if (!r) return fill(box);
  const p = r.parsed || {};
  const res = r.result || null;
  const s = p.summary || {};
  const head = h(
    'div.kp-hd',
    null,
    h('h2', null, '診斷'),
    h('span.kp-sub', null, `${ago(r.created_at)} · ${(r.inputs || []).map((i) => i.name).join('、')}`),
    r.status === 'running' || r.status === 'pending' ? h('span.chip-s.info', null, '分析中…') : r.status === 'failed' ? h('span.chip-s.bad', null, '沒有完成') : null,
  );
  const facts = h(
    'div.kp-facts',
    null,
    fact('時間', s.first_ts ? `${s.first_ts} → ${s.last_ts || s.first_ts}` : null),
    fact('機台', (p.sessions || []).map((x) => [x.ip_name, x.mode, x.gpu && x.gpu.name].filter(Boolean).join(' · ')).filter(Boolean).slice(0, 3).join('\n') || null),
    fact('incident', Object.entries(s.incidents_by_kind || {}).map(([k, n]) => `${k} × ${n}`).join('、') || null),
    fact('錯誤碼', Object.entries(s.codes || {}).map(([k, n]) => `${k} × ${n}`).slice(0, 8).join('、') || null),
    fact('參數檔', (p.ini || []).map((i) => i.name).join('、') || null),
  );
  const parts = [head, facts];
  if (res) {
    parts.push(
      h('div.dg-verdict', { dataset: { cat: res.category || 'unknown' } }, h('b', null, CAT[res.category] || CAT.unknown), res.confidence ? h('span.kp-muted', null, `（把握：${{ high: '高', medium: '中', low: '低' }[res.confidence] || res.confidence}）`) : null, h('p', null, res.summary || '')),
    );
    if (res.causes && res.causes.length) {
      parts.push(h('h3', null, '可能原因'), h('ol.dg-causes', null, res.causes.map((c) => h('li', null, h('b', null, `${CAT[c.category] || c.category}：${c.title}`), h('div', null, c.why || ''), c.evidence && c.evidence.length ? h('div.kp-muted', null, c.evidence.slice(0, 4).join('；')) : null))));
    }
    if (res.code_refs && res.code_refs.length) {
      parts.push(
        h('h3', null, '對到的程式碼'),
        h('table.kp-table', null, h('tbody', null, res.code_refs.slice(0, 20).map((c) => h('tr', null, h('td', null, c.from), h('td.mono', null, `${c.file}${c.line ? `:${c.line}` : ''}`, c.text ? h('div.kp-muted', null, c.text) : null))))),
      );
    }
    if (res.params && res.params.length) {
      parts.push(
        h('h3', null, '和預設不同的參數'),
        h('table.kp-table', null, h('tbody', null, res.params.slice(0, 20).map((x) => h('tr', null, h('td.mono', null, `[${x.section}] ${x.key}`), h('td.nowrap', null, `${x.baseline ?? '（無）'} → ${x.current ?? '（刪除）'}`), h('td', null, x.meaning || '', x.where && x.where.length ? h('div.kp-muted.mono', null, x.where.slice(0, 2).join('、')) : null))))),
      );
    }
    if (res.suggestions && res.suggestions.length) {
      parts.push(
        h('h3', null, '參數建議（尚未套用，由工程師決定）'),
        h('table.kp-table', null, h('tbody', null, res.suggestions.map((x) => h('tr', null, h('td.mono', null, `${x.file ? `${x.file} ` : ''}${x.param}`), h('td.nowrap', null, `${x.current ?? '?'} → ${x.proposed}`), h('td', null, x.why, x.verify ? h('div.kp-muted', null, `驗證：${x.verify}`) : null))))),
      );
    }
    const learned = [...(res.similar_cases || []).map((c) => ['案例', c]), ...(res.pitfalls || []).map((c) => ['陷阱', c])];
    if (learned.length) parts.push(h('h3', null, '以前見過'), h('ul.dg-seen', null, learned.map(([k, c]) => h('li', null, h('span.chip-s', null, k), ' ', h('b', null, c.title), `：${c.body}`))));
    parts.push(
      h(
        'div.kp-acts',
        null,
        h('button.btn.primary', { type: 'button', onclick: () => toTicket() }, '開問題單'),
        r.case_id ? h('span.chip-s.ok', null, '已記成案例') : h('button.btn', { type: 'button', onclick: () => recordCase() }, '記成案例'),
      ),
    );
  } else if (r.status === 'failed') {
    parts.push(h('p.err-line', null, r.error || '分析沒有完成'));
  }
  fill(box, h('section.kp-card', null, parts));
}

function fact(k, v) {
  return v ? [h('span.k', null, k), h('span.v', null, v)] : null;
}

function toTicket() {
  const r = current;
  const res = r.result || {};
  const lines = [res.summary || '機況異常', ''];
  if (r.note) lines.push(`現象：${r.note}`);
  for (const c of (res.causes || []).slice(0, 3)) lines.push(`- 可能原因（${CAT[c.category] || c.category}）：${c.title}。${c.why || ''}`);
  if (res.code_refs && res.code_refs.length) lines.push('', '對到的程式碼：', ...res.code_refs.slice(0, 8).map((c) => `- ${c.from} → ${c.file}${c.line ? `:${c.line}` : ''}`));
  const s = (r.parsed && r.parsed.summary) || {};
  if (s.incidents_by_kind) lines.push('', `incident：${Object.entries(s.incidents_by_kind).map(([k, n]) => `${k} × ${n}`).join('、')}`);
  lines.push('', `（機況診斷 ${r.id}）`);
  const repo = repos.find((x) => x.id === r.repo_id);
  openTicket({ description: lines.join('\n'), repoHint: repo ? repo.local_path || repo.name : '', kind: res.category === 'code' ? 'bugfix' : 'algo' });
}

async function recordCase() {
  const cause = prompt('確認的原因（一句話）：', current.result && current.result.summary ? current.result.summary : '');
  if (cause === null || !cause.trim()) return;
  const fix = prompt('怎麼處理的（一句話）：', '');
  if (fix === null) return;
  try {
    current = (await api(`/api/diag/${enc(current.id)}/case`, 'POST', { cause: cause.trim(), resolution: fix.trim() })).report;
    toast('已記成案例：之後相同特徵的機況會先找到它');
    paintResult();
  } catch (err) {
    toast(`記不了：${err.message}`, 'bad');
  }
}

async function loadHistory() {
  const box = $('dg-history');
  try {
    const r = await api('/api/diag?limit=15');
    fill(
      box,
      r.reports.length
        ? h(
            'section.kp-card',
            null,
            h('div.kp-hd', null, h('h2', null, '最近的診斷')),
            h(
              'table.kp-table',
              null,
              h(
                'tbody',
                null,
                r.reports.map((x) =>
                  h(
                    'tr.dg-hist',
                    { onclick: async () => ((current = (await api(`/api/diag/${enc(x.id)}`)).report), paintResult(), watch()) },
                    h('td.nowrap', null, ago(x.created_at)),
                    h('td', null, (x.result && x.result.summary) || (x.inputs || []).map((i) => i.name).join('、')),
                    h('td.nowrap', null, x.result ? CAT[x.result.category] || '' : x.status),
                    h('td.nowrap', null, x.case_id ? '案例' : ''),
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  } catch {
    fill(box);
  }
}

async function boot(repoId) {
  if (!booted) {
    booted = true;
    try {
      repos = (await api('/api/repos')).repos || [];
    } catch {
      repos = [];
    }
    fill($('diag-body'), paintForm(repoId), h('div', { id: 'dg-result' }), h('div', { id: 'dg-history' }));
    // from the chat's 機況分析 chip
    const handed = takeDiagHandoff();
    if (handed) {
      $('dg-text').value = handed;
      toast('已帶入對話的內容；確認 repo 後按「分析」');
    }
  }
  loadHistory();
}

window.addEventListener('loop:diag-show', (e) => void boot(e.detail && e.detail.repoId));
// opened straight on #diag: the tab was shown before this module loaded
if (document.body.dataset.ktab === 'diag') void boot(new URLSearchParams(location.hash.replace(/^#[^&]*&?/, '')).get('repo'));
