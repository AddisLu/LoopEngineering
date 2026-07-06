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
  const micStatus = $('mic-status');
  const transcriptCard = $('transcript-card');
  const transcriptText = $('transcript-text');
  const taskForm = $('task-form');
  const submitStatus = $('submit-status');

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

  function setStatus(text, cls) {
    micStatus.textContent = text || '';
    micStatus.className = 'mic-status' + (cls ? ' ' + cls : '');
  }

  async function startRecording() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMimeType();
    chunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onStop;
    recorder.start();
    micBtn.classList.add('recording');
    micBtn.textContent = '⏹';
    setStatus('錄音中…再按一次停止');
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎤';
  }

  async function onStop() {
    const mimeType = (recorder && recorder.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) { setStatus('沒有錄到聲音，請再試一次', 'err'); return; }
    micBtn.disabled = true;
    setStatus('上傳並轉錄中…（GPU 上跑 faster-whisper，可能要幾秒到一分鐘）');
    try {
      const fd = new FormData();
      fd.append('audio', blob, `voice.${extFromMime(mimeType)}`);
      const r = await fetch('/api/voice/intake', { method: 'POST', headers: authHeaders, body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText);
      applyResult(body.transcript, body.fields);
      setStatus('✓ 已轉錄，請確認下方欄位後送出', 'ok');
    } catch (err) {
      setStatus('語音處理失敗：' + err.message, 'err');
    } finally {
      micBtn.disabled = false;
    }
  }

  function applyResult(transcript, fields) {
    transcriptCard.hidden = !transcript;
    transcriptText.textContent = transcript || '';

    taskForm.hidden = false;
    submitStatus.textContent = '';
    const set = (name, value) => {
      const input = taskForm.elements.namedItem(name);
      if (input && value != null && value !== '') input.value = value;
    };
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
  }

  micBtn.onclick = () => {
    if (recorder && recorder.state === 'recording') { stopRecording(); return; }
    startRecording().catch((err) => setStatus('無法使用麥克風：' + err.message, 'err'));
  };

  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
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
