(() => {
  'use strict';
  // ---- auth / token ----
  const params = new URLSearchParams(location.search);
  if (params.get('token')) localStorage.setItem('loop_token', params.get('token'));
  const TOKEN = localStorage.getItem('loop_token') || '';
  const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const $ = (id) => document.getElementById(id);

  // ---- theme ----
  const themeBtn = $('theme-btn');
  const curMode = () => (document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light');
  const paint = () => { themeBtn.textContent = curMode() === 'dark' ? '☀' : '☾'; };
  themeBtn.onclick = () => {
    const next = curMode() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-mode', next);
    try { localStorage.setItem('loop_mode', next); } catch (e) {}
    paint();
  };
  paint();

  // ---- recording: MediaRecorder, negotiate a mimeType supported by iOS Safari / Android Chrome ----
  const micBtn = $('mic-btn');
  const micIcon = $('mic-icon');
  const micLabel = $('mic-label');
  const micTimer = $('mic-timer');
  const micStatus = $('mic-status');
  const transcriptCard = $('transcript-card');
  const transcriptText = $('transcript-text');
  const glossaryTerm = $('glossary-term');
  const glossaryAddBtn = $('glossary-add-btn');
  const glossaryStatus = $('glossary-status');
  const taskForm = $('task-form');
  const submitStatus = $('submit-status');
  const typeBanner = $('type-banner');
  const clarifyList = $('clarify-list');
  const chipsRow = $('chips-row');
  const missingBanner = $('missing-banner');
  const confirmRow = $('confirm-row');
  const confirmCheckbox = $('confirm-checkbox');

  function pickMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/ogg'];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }
  function extFromMime(mime) {
    if (!mime) return 'webm';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('ogg')) return 'ogg';
    return 'webm';
  }

  let recorder = null;
  let stream = null;
  let chunks = [];
  let timerHandle = null;
  let recordStart = 0;

  function setStatus(text, cls) {
    micStatus.textContent = text || '';
    micStatus.className = 'mic-status' + (cls ? ' ' + cls : '');
  }

  function fmtElapsed(ms) {
    const total = Math.floor(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function startTimer() {
    recordStart = Date.now();
    micTimer.hidden = false;
    micTimer.textContent = '00:00';
    timerHandle = setInterval(() => { micTimer.textContent = fmtElapsed(Date.now() - recordStart); }, 250);
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }

  async function startRecording() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMimeType();
    chunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onStop;
    recorder.start();
    micBtn.classList.remove('busy');
    micBtn.classList.add('recording');
    micIcon.textContent = '⏹';
    micLabel.textContent = '錄音中…再按一次停止';
    startTimer();
    setStatus('');
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    micBtn.classList.remove('recording');
    stopTimer();
  }

  async function onStop() {
    const mimeType = (recorder && recorder.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, { type: mimeType });
    micTimer.hidden = true;
    if (!blob.size) {
      micIcon.textContent = '🎤';
      micLabel.textContent = '按一下開始錄音';
      setStatus('沒有錄到聲音，請再試一次', 'err');
      return;
    }
    micBtn.disabled = true;
    micBtn.classList.add('busy');
    micIcon.textContent = '⏳';
    micLabel.textContent = '上傳中…';
    setStatus('處理中…（上傳 → 轉錄 → 整理，GPU 上跑 faster-whisper）');
    try {
      const fd = new FormData();
      fd.append('audio', blob, `voice.${extFromMime(mimeType)}`);
      micLabel.textContent = '轉錄中…';
      const r = await fetch('/api/voice/intake', { method: 'POST', headers: authHeaders, body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText);
      micLabel.textContent = '整理欄位中…';
      applyResult(body.transcript, body.fields);
      micIcon.textContent = '✓';
      micLabel.textContent = '完成 — 再按一次可重新錄音';
      setStatus('✓ 已轉錄，請確認下方欄位後送出', 'ok');
    } catch (err) {
      micIcon.textContent = '🎤';
      micLabel.textContent = '按一下開始錄音';
      setStatus('語音處理失敗：' + err.message, 'err');
    } finally {
      micBtn.disabled = false;
      micBtn.classList.remove('busy', 'recording');
    }
  }

  // ---- guided confirmation: task_type banner, clarify Q&A, quick chips, missing check ----
  const FIELD_NAME_MAP = { verify_steps: 'verification_steps' };

  const TYPE_MESSAGES = {
    scheduled: '⏰ 這聽起來是提醒／排程類事項，不是要改 code 的 repo 任務；Loop 主要跑 coding，請確認是否仍要建立。',
    generic: '📄 這聽起來不是 repo coding 任務；確定要建立嗎？可考慮把 Tool 改成 generic。',
    unknown: '❓ 看不出這是不是要改 code 的任務，請確認下方欄位再送出。',
  };

  const CHIP_GROUPS = [
    { field: 'complexity', label: 'Complexity', options: ['S', 'M', 'L'] },
    { field: 'coding_tool', label: 'Tool', options: ['claude-code', 'generic', 'plan', 'deploy'] },
    { field: 'environment', label: 'Environment', options: ['home', 'company'] },
  ];

  let taskType = 'unknown';

  function setFieldValue(field, value) {
    const name = FIELD_NAME_MAP[field] || field;
    const input = taskForm.elements.namedItem(name);
    if (input) input.value = value;
  }

  function fieldValue(name) {
    const input = taskForm.elements.namedItem(name);
    return input ? String(input.value || '').trim() : '';
  }

  function renderTypeBanner(type) {
    const msg = TYPE_MESSAGES[type];
    if (msg) {
      typeBanner.textContent = msg;
      typeBanner.hidden = false;
    } else {
      typeBanner.textContent = '';
      typeBanner.hidden = true;
    }
  }

  function renderClarify(clarify) {
    clarifyList.textContent = '';
    if (!Array.isArray(clarify)) return;
    for (const item of clarify) {
      if (!item || !item.field || !item.question) continue;
      const wrap = document.createElement('div');
      wrap.className = 'clarify-item';
      const q = document.createElement('span');
      q.className = 'q';
      q.textContent = item.question;
      wrap.appendChild(q);

      if (Array.isArray(item.options) && item.options.length) {
        const opts = document.createElement('div');
        opts.className = 'clarify-opts';
        for (const opt of item.options) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'opt-btn';
          btn.textContent = opt;
          btn.addEventListener('click', () => {
            opts.querySelectorAll('.opt-btn').forEach((b) => b.classList.remove('chosen'));
            btn.classList.add('chosen');
            setFieldValue(item.field, opt);
            recheckMissing();
          });
          opts.appendChild(btn);
        }
        wrap.appendChild(opts);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '輸入答案…';
        input.autocomplete = 'off';
        input.addEventListener('change', () => { setFieldValue(item.field, input.value); recheckMissing(); });
        wrap.appendChild(input);
      }
      clarifyList.appendChild(wrap);
    }
  }

  function renderChips() {
    chipsRow.textContent = '';
    for (const group of CHIP_GROUPS) {
      const g = document.createElement('div');
      g.className = 'chip-group';
      const label = document.createElement('span');
      label.className = 'g-label';
      label.textContent = group.label;
      g.appendChild(label);

      const opts = document.createElement('div');
      opts.className = 'chip-opts';
      opts.dataset.chipGroup = group.field;
      for (const opt of group.options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt-btn';
        btn.textContent = opt;
        btn.addEventListener('click', () => {
          opts.querySelectorAll('.opt-btn').forEach((b) => b.classList.remove('chosen'));
          btn.classList.add('chosen');
          setFieldValue(group.field, opt);
          recheckMissing();
        });
        opts.appendChild(btn);
      }
      g.appendChild(opts);
      chipsRow.appendChild(g);
    }
  }

  function syncChipSelection() {
    for (const group of CHIP_GROUPS) {
      const value = fieldValue(group.field);
      const opts = chipsRow.querySelector(`[data-chip-group="${group.field}"]`);
      if (!opts) continue;
      opts.querySelectorAll('.opt-btn').forEach((b) => b.classList.toggle('chosen', b.textContent === value));
    }
  }

  function computeMissing() {
    const missing = [];
    if (!fieldValue('goal')) missing.push('goal');
    if (taskType === 'coding') {
      if (!fieldValue('repo_path')) missing.push('repo_path');
      if (!fieldValue('verification_steps')) missing.push('verify_steps');
    }
    return missing;
  }

  function recheckMissing() {
    const missing = computeMissing();
    if (missing.length) {
      missingBanner.textContent = `⚠ 缺少關鍵資訊：${missing.join('、')}（請補齊，或勾選下方確認方塊後送出）`;
      missingBanner.hidden = false;
      confirmRow.hidden = false;
    } else {
      missingBanner.textContent = '';
      missingBanner.hidden = true;
      confirmRow.hidden = true;
      confirmCheckbox.checked = false;
    }
    return missing;
  }

  renderChips();
  taskForm.addEventListener('input', recheckMissing);
  taskForm.addEventListener('change', () => { syncChipSelection(); recheckMissing(); });

  function applyResult(transcript, fields) {
    transcriptCard.hidden = !transcript;
    transcriptText.textContent = transcript || '';
    glossaryStatus.textContent = '';

    taskForm.hidden = false;
    submitStatus.textContent = '';
    const set = (name, value) => {
      const input = taskForm.elements.namedItem(name);
      if (input && value != null && value !== '') input.value = value;
    };
    taskType = (fields && fields.task_type) || 'unknown';
    renderTypeBanner(taskType);
    renderClarify(fields ? fields.clarify : []);
    if (fields) {
      set('title', fields.title);
      set('goal', fields.goal);
      if (Array.isArray(fields.verify_steps) && fields.verify_steps.length) {
        set('verification_steps', fields.verify_steps.join(', '));
      }
      set('repo_path', fields.repo_path);
      set('environment', fields.environment);
      if (fields.coding_tool) set('coding_tool', fields.coding_tool);
      if (fields.complexity) set('complexity', fields.complexity);
    } else {
      // LLM structuring unavailable — fall back to dumping the raw transcript into goal.
      set('title', (transcript || '').slice(0, 60) || '語音建立的任務');
      set('goal', transcript);
    }
    syncChipSelection();
    recheckMissing();
  }

  micBtn.onclick = () => {
    if (recorder && recorder.state === 'recording') { stopRecording(); return; }
    startRecording().catch((err) => setStatus('無法使用麥克風：' + err.message, 'err'));
  };

  // ---- learn a mis-heard term into the knowledge-base glossary ----
  glossaryAddBtn.onclick = async () => {
    const term = glossaryTerm.value.trim();
    if (!term) { glossaryStatus.className = 'mic-status err'; glossaryStatus.textContent = '請先輸入詞'; return; }
    glossaryAddBtn.disabled = true;
    glossaryStatus.className = 'mic-status';
    glossaryStatus.textContent = '加入中…';
    try {
      const r = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ title: term, kind: 'tech', tags: ['glossary'], scope: 'global', status: 'approved' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      glossaryStatus.className = 'mic-status ok';
      glossaryStatus.textContent = `✓ 已加入詞表：${term}（下次轉錄開始生效）`;
      glossaryTerm.value = '';
    } catch (err) {
      glossaryStatus.className = 'mic-status err';
      glossaryStatus.textContent = '加入失敗：' + err.message;
    } finally {
      glossaryAddBtn.disabled = false;
    }
  };

  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const missing = recheckMissing();
    if (missing.length && !confirmCheckbox.checked) {
      submitStatus.className = 'mic-status err';
      submitStatus.textContent = '⚠ 請先補齊缺少的欄位，或勾選上方確認方塊再送出';
      return;
    }
    const fd = new FormData(taskForm);
    const body = Object.fromEntries(fd.entries());
    const submitBtn = $('submit-btn');
    submitBtn.disabled = true;
    submitStatus.className = 'mic-status';
    submitStatus.textContent = '建立中…';
    try {
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      submitStatus.className = 'mic-status ok';
      submitStatus.textContent = '✓ 已建立，回看板查看';
    } catch (err) {
      submitStatus.className = 'mic-status err';
      submitStatus.textContent = '建立失敗：' + err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
