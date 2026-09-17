/**
 * Form → PRD Markdown. Pure: no DOM, no fetch — vitest imports this file and runs the output
 * through the server's lintPrd, so the wizard can never produce a PRD the gate rejects for
 * structural reasons. The server never composes; it only parses (src/prd/compose.ts).
 *
 * Section order and headings are exactly what src/prd/lint.ts matches. Never emits `<…>`, TODO
 * or TBD: those are the gate's "still a template" markers.
 */

export const KIND_LABEL = { algo: '演算法修正', feature: '功能新增', bugfix: '錯誤修復', perf: '效能' };

/** Referenced by path only — the wizard, the PRD text and the docs all say this sentence. */
export const DATASET_NOTICE = '圖集只以路徑引用，禁止複製進 Loop、worktree 或知識庫；基準結果亦只可引用路徑。';

export function emptyForm() {
  return {
    kind: null,
    repo: { path: '', branch: 'main', module: null },
    change: { title: '', symptom: '', expected: '', files: [], extra: [] },
    verify: { commands: [], dataset: null, manual: [], llm: false },
    scope: { non_goals: [], constraints: [], domain: 'other', complexity: 'M', setup: [] },
    acceptance: [],
    markdown_override: null,
  };
}

export function emptyDataset() {
  return { input: '', golden: '', recipe: 'DEFAULT', fp_rate: 1, miss: 0, tol: 0.5, commands: [], requires: ['gpu'] };
}

const clean = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
const oneLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ');
const bullet = (s) => `- ${oneLine(s)}`;
const nonEmpty = (list) => (list || []).map(oneLine).filter(Boolean);

/**
 * One shell line for the whole image-set run: src/orchestrator/verify.ts runs every
 * verification step in its own shell, so a server started on one line is gone on the next.
 * Uses the cf-aoi tooling that exists today (cfaoi_ip offline-tcp, control_test.py,
 * compare_results.py); it is a template the engineer edits.
 */
export function datasetCommand(ds) {
  const input = clean(ds.input) || '/path/to/images';
  const golden = clean(ds.golden) || '/path/to/golden';
  const recipe = clean(ds.recipe) || 'DEFAULT';
  const tol = ds.tol == null || ds.tol === '' ? 0.5 : Number(ds.tol);
  return (
    `bash -c 'set -e; OUT=$(mktemp -d); ./ip/build/cfaoi_ip --mode offline-tcp --control-port 8200 --output "$OUT" & IP=$!; trap "kill $IP" EXIT; sleep 5; ` +
    `for f in "${input}"/*.png; do python3 scripts/control_test.py --image "$f" --recipe ${recipe} --port 8200; done; rc=0; ` +
    `for g in "${golden}"/*_ResultInfo.json; do python3 scripts/compare_results.py "$g" "$OUT/$(basename "$g")" --glmean-tol ${tol} || rc=1; done; exit $rc'`
  );
}

function thresholdsLine(ds) {
  const parts = [];
  if (ds.fp_rate != null && ds.fp_rate !== '') parts.push(`誤判率 ≤ ${ds.fp_rate}%`);
  if (ds.miss != null && ds.miss !== '') parts.push(`漏檢 = ${ds.miss}`);
  if (ds.tol != null && ds.tol !== '') parts.push(`GL_Mean 容差 ${ds.tol}`);
  return parts.join('；');
}

const gwt = (row) => {
  if (typeof row === 'string') return oneLine(row);
  const g = oneLine(row.given);
  const w = oneLine(row.when);
  const t = oneLine(row.then);
  if (!g && !w) return t;
  return `Given ${g || '…'} When ${w || '…'} Then ${t || '…'}`;
};

export function composePrd(form) {
  if (form.markdown_override != null && form.markdown_override !== '') return form.markdown_override;
  const f = { ...emptyForm(), ...form };
  const repo = { ...emptyForm().repo, ...(f.repo || {}) };
  const change = { ...emptyForm().change, ...(f.change || {}) };
  const verify = { ...emptyForm().verify, ...(f.verify || {}) };
  const scope = { ...emptyForm().scope, ...(f.scope || {}) };
  const ds = verify.dataset ? { ...emptyDataset(), ...verify.dataset } : null;
  const out = [];

  out.push(`# ${oneLine(change.title) || '（未命名）'}`, '');

  out.push('## 目標 (Goal)');
  const head = [f.kind && KIND_LABEL[f.kind] ? `改動類型：${KIND_LABEL[f.kind]}` : null, repo.module ? `影響模組：${oneLine(repo.module)}` : null]
    .filter(Boolean)
    .join('｜');
  if (head) out.push(head);
  if (clean(change.symptom)) out.push(`現況／症狀：${oneLine(change.symptom)}`);
  if (clean(change.expected)) out.push(`期望行為：${oneLine(change.expected)}`);
  out.push('');

  out.push('## 範圍 (Scope)');
  for (const file of change.files || []) {
    const p = oneLine(file.path);
    if (!p) continue;
    out.push(`- \`${p}\`${oneLine(file.why) ? `：${oneLine(file.why)}` : ''}`);
  }
  for (const b of nonEmpty(change.extra)) out.push(bullet(b));
  out.push('');

  out.push('## 非範圍 (Non-goals)');
  for (const b of nonEmpty(scope.non_goals)) out.push(bullet(b));
  out.push('');

  out.push('## 驗收標準 (Acceptance)');
  for (const a of nonEmpty(f.acceptance)) out.push(`- [ ] ${a}`);
  if (ds) {
    const th = thresholdsLine(ds);
    if (th) out.push(`- [ ] Given 圖集 ${oneLine(ds.input) || '（未填）'} When 跑 offline-tcp 並與期望結果比對 Then ${th}`);
  }
  out.push('');

  out.push('## 驗證指令 (Verify)', '```bash');
  const cmds = nonEmpty(verify.commands);
  if (cmds.length) {
    out.push('# ---- 測試指令 ----');
    out.push(...cmds);
  }
  if (ds) {
    out.push('# ---- 圖集比對 ----');
    const dsCmds = nonEmpty(ds.commands);
    out.push(...(dsCmds.length ? dsCmds : [datasetCommand(ds)]));
  }
  out.push('```', '');

  if (ds) {
    out.push('## 圖集比對 (Dataset)');
    out.push(`- 輸入圖集: ${oneLine(ds.input) || '（未填）'}（僅引用路徑，禁止複製）`);
    if (clean(ds.golden)) out.push(`- 期望結果: ${oneLine(ds.golden)}`);
    out.push(`- 配方: ${oneLine(ds.recipe) || 'DEFAULT'}`);
    const th = thresholdsLine(ds);
    if (th) out.push(`- 門檻: ${th}`);
    out.push('');
  }

  const manual = (verify.manual || []).map(gwt).filter(Boolean);
  if (manual.length) {
    out.push('## 人工驗收 (Manual checks)');
    for (const m of manual) out.push(`- ${m}`);
    out.push('');
  }

  const modes = [];
  if (cmds.length || ds) modes.push('command');
  if (verify.llm) modes.push('llm');
  if (manual.length) modes.push('manual');
  if (modes.length) out.push('## 驗證方式 (Verify mode)', modes.join(', '), '');

  const requires = nonEmpty(ds ? ds.requires : []);
  if (requires.length) out.push('## 需求能力 (Requires)', requires.join(', '), '');

  const setup = nonEmpty(scope.setup);
  if (setup.length) out.push('## 前置指令 (Setup)', '```bash', ...setup, '```', '');

  out.push('## Repo', `- path: ${oneLine(repo.path)}`, `- branch: ${oneLine(repo.branch) || 'main'}`, '');
  out.push('## 領域 (Domain)', oneLine(scope.domain) || 'other', '');
  out.push('## 複雜度 (Complexity)', ['S', 'M', 'L'].includes(scope.complexity) ? scope.complexity : 'M', '');

  out.push('## 限制 (Constraints)');
  const constraints = nonEmpty(scope.constraints);
  if (ds) constraints.push(DATASET_NOTICE);
  if (constraints.length) for (const c of constraints) out.push(bullet(c));
  else out.push('- （無）');
  out.push('');

  return out.join('\n');
}

/** Which verify_mode tokens the composed PRD will carry — shown live in step ③. */
export function verifyModes(form) {
  const v = form.verify || {};
  const modes = [];
  if ((v.commands || []).some((c) => clean(c)) || v.dataset) modes.push('command');
  if (v.llm) modes.push('llm');
  if ((v.manual || []).map(gwt).some(Boolean)) modes.push('manual');
  return modes;
}
