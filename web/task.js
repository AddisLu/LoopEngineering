(() => {
  'use strict';
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
    const meta = $('meta');
    meta.replaceChildren();
    const parts = [
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
    const kind = { passed: 'ok', failed: 'bad', manual: 'manual', in_progress: 'progress' }[b.verdict];
    v.className = `verdict ${kind}`;
    v.replaceChildren();
    v.appendChild(icon({ passed: 'circleCheck', failed: 'alert', manual: 'hand', in_progress: 'clock' }[b.verdict]));
    const txt = el('div', 'stack');
    txt.style.gap = '2px';
    txt.appendChild(el('div', 'v-title', b.headline));
    const unchecked = b.checklist.filter((c) => !c.checked).length;
    const sub =
      b.verdict === 'in_progress' ? (b.reason || '完成後這一頁會自動更新')
      : b.verdict === 'failed' ? (b.reason || '')
      : [
          t.approved_at ? `已由 ${t.approved_by} 核可` : unchecked ? `還差：人工驗收 ${unchecked} 項` : '人工驗收都勾完了，可以核可',
          b.hosts.length ? `量測機台：${b.hosts.map((h) => (h === 'local' ? '這台 Spark' : h)).join('、')}` : null,
        ].filter(Boolean).join('。');
    if (sub) txt.appendChild(el('div', 'v-sub', sub.length > 400 ? `${sub.slice(0, 400)}…` : sub));
    v.appendChild(txt);
    v.hidden = false;

    $('tab-code').textContent = b.changed_files ? `程式碼（${b.changed_files.length} 個檔案）` : '程式碼';
    renderMetrics(b);
    renderSteps(b);
    renderLog(b);
    renderArtifacts(b);
    renderChecks(b);
    renderDeliver(b);
    renderTrialControls(b);
    renderAsk(b);
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
      box.appendChild(el('div', 'hint', b.can.approve ? '核可後原始碼進 Gitea 的分支，才能發佈或下載交付包。' : b.can.approve_reason || ''));
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

  async function approve() {
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(id)}/approve`, 'POST', {});
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

  const hash = (location.hash || '').replace('#', '');
  showTab(TABS.includes(hash) ? hash : 'result');
  load();
})();
