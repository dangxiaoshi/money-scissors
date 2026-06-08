'use strict';

const API_BASE = (() => {
  // When served from the Node server, use same origin.
  // When opened as file://, point to localhost:3030.
  return location.protocol === 'file:' ? 'http://localhost:3030' : '';
})();

const POLL_INTERVAL = 1500; // ms

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const fileNameEl   = document.getElementById('file-name');
const optDenoise   = document.getElementById('opt-denoise');
const btnStart     = document.getElementById('btn-start');
const errorMsg     = document.getElementById('error-msg');

const uploadCard   = document.getElementById('upload-card');
const progressCard = document.getElementById('progress-card');
const resultCard   = document.getElementById('result-card');

const progressBar  = document.getElementById('progress-bar');
const logArea      = document.getElementById('log-area');
const btnDownload  = document.getElementById('btn-download');
const btnAgain     = document.getElementById('btn-again');

// ── state ─────────────────────────────────────────────────────────────────────
let selectedFile = null;
let pollTimer    = null;

// ── file selection ────────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

function setFile(f) {
  if (!f.type.startsWith('audio/')) {
    showError('请选择音频文件（mp3 / m4a / wav）');
    return;
  }
  if (f.size > 500 * 1024 * 1024) {
    showError('文件超过 500MB，请压缩后再上传');
    return;
  }
  selectedFile = f;
  fileNameEl.textContent = f.name;
  fileNameEl.hidden = false;
  btnStart.disabled = false;
  hideError();
}

// ── start processing ──────────────────────────────────────────────────────────
btnStart.addEventListener('click', startProcessing);

async function startProcessing() {
  if (!selectedFile) return;

  hideError();
  btnStart.disabled = true;

  // Show progress card
  uploadCard.style.display = 'none';
  progressCard.classList.add('visible');
  resultCard.classList.remove('visible');
  setStepState('upload', 'active');
  setProgress(5);
  setLog('正在上传音频...');

  // Build form data
  const form = new FormData();
  form.append('file', selectedFile, selectedFile.name);
  form.append('denoise', optDenoise.checked ? '1' : '0');
  form.append('bitrate', '192k');

  let jobId;
  try {
    const res = await fetch(`${API_BASE}/api/start`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
    jobId = data.jobId;
  } catch (e) {
    showUploadError(e.message);
    return;
  }

  setStepState('upload', 'done');
  setStepState('measure', 'active');
  setProgress(15);

  // Poll
  pollTimer = setInterval(() => pollStatus(jobId), POLL_INTERVAL);
}

async function pollStatus(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/status/${jobId}`);
    const data = await res.json();

    if (data.log && data.log.length > 0) {
      setLog(data.log[data.log.length - 1]);
    }
    setProgress(data.progress || 0);

    switch (data.stage) {
      case 'measuring':
        setStepState('measure', 'active');
        break;
      case 'normalizing':
        setStepState('measure', 'done');
        setStepState('normalize', 'active');
        break;
      case 'done':
        clearInterval(pollTimer);
        setStepState('normalize', 'done');
        setStepState('done', 'done');
        setProgress(100);
        showResult(jobId);
        break;
      case 'error':
        clearInterval(pollTimer);
        showUploadError(data.error || '处理出错，请重试');
        break;
    }
  } catch {
    // network hiccup — keep polling
  }
}

function showResult(jobId) {
  progressCard.classList.remove('visible');
  resultCard.classList.add('visible');
  const basename = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : 'audio';
  btnDownload.href = `${API_BASE}/api/download/${jobId}`;
  btnDownload.download = basename + '_精修版.mp3';
}

// ── helpers ───────────────────────────────────────────────────────────────────
function setProgress(pct) {
  progressBar.style.width = `${Math.min(100, pct)}%`;
}

function setLog(msg) {
  logArea.textContent = msg;
}

const stepOrder = ['upload', 'measure', 'normalize', 'done'];

function setStepState(stepKey, state) {
  const el = document.getElementById('step-' + stepKey);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (state === 'active') el.classList.add('active');
  if (state === 'done') {
    el.classList.add('done');
    el.querySelector('.step-icon').textContent = '✓';
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}
function hideError() {
  errorMsg.classList.remove('visible');
}

function showUploadError(msg) {
  clearInterval(pollTimer);
  progressCard.classList.remove('visible');
  uploadCard.style.display = '';
  btnStart.disabled = false;
  showError(msg);
}

// ── again button ──────────────────────────────────────────────────────────────
btnAgain.addEventListener('click', () => {
  clearInterval(pollTimer);
  selectedFile = null;
  fileInput.value = '';
  fileNameEl.hidden = true;
  btnStart.disabled = true;
  setProgress(0);
  setLog('');
  stepOrder.forEach(k => {
    const el = document.getElementById('step-' + k);
    if (!el) return;
    el.classList.remove('active', 'done');
    el.querySelector('.step-icon').textContent = stepOrder.indexOf(k) + 1;
  });
  resultCard.classList.remove('visible');
  progressCard.classList.remove('visible');
  uploadCard.style.display = '';
  hideError();
});
