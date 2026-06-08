'use strict';

// Same-origin: works both when served from file:// (dev) and from the Node server
const API_BASE = location.protocol === 'file:' ? 'http://localhost:3002' : '';
const POLL_INTERVAL = 1500;
const STORAGE_KEY = 'jinqian_token';

const dropZone    = document.getElementById('drop-zone');
const fileInput   = document.getElementById('file-input');
const fileNameEl  = document.getElementById('file-name');
const optDenoise  = document.getElementById('opt-denoise');
const btnStart    = document.getElementById('btn-start');
const errorMsg    = document.getElementById('error-msg');
const uploadCard  = document.getElementById('upload-card');
const progressCard = document.getElementById('progress-card');
const resultCard  = document.getElementById('result-card');
const progressBar = document.getElementById('progress-bar');
const logArea     = document.getElementById('log-area');
const btnDownload = document.getElementById('btn-download');
const btnAgain    = document.getElementById('btn-again');

let selectedFile = null;
let pollTimer    = null;

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

function setFile(f) {
  if (!f.type.startsWith('audio/')) { showError('请选择音频文件（mp3 / m4a / wav）'); return; }
  if (f.size > 500 * 1024 * 1024) { showError('文件超过 500MB，请压缩后再上传'); return; }
  selectedFile = f;
  fileNameEl.textContent = f.name;
  fileNameEl.hidden = false;
  btnStart.disabled = false;
  hideError();
}

btnStart.addEventListener('click', startProcessing);

async function startProcessing() {
  if (!selectedFile) return;
  hideError();
  btnStart.disabled = true;
  uploadCard.style.display = 'none';
  progressCard.classList.add('visible');
  resultCard.classList.remove('visible');
  setStepState('upload', 'active');
  setProgress(5);
  setLog('正在上传音频...');

  const form = new FormData();
  form.append('file', selectedFile, selectedFile.name);
  form.append('denoise', optDenoise.checked ? '1' : '0');

  let jobId;
  try {
    const res = await authFetch(`${API_BASE}/api/refine/start`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
    jobId = data.jobId;
  } catch (e) { showUploadError(e.message); return; }

  setStepState('upload', 'done');
  setStepState('measure', 'active');
  setProgress(15);
  pollTimer = setInterval(() => pollStatus(jobId), POLL_INTERVAL);
}

async function pollStatus(jobId) {
  try {
    const res = await authFetch(`${API_BASE}/api/refine/status/${jobId}`);
    const data = await res.json();
    if (data.log && data.log.length > 0) setLog(data.log[data.log.length - 1]);
    setProgress(data.progress || 0);
    switch (data.stage) {
      case 'measuring':   setStepState('measure', 'active'); break;
      case 'normalizing': setStepState('measure', 'done'); setStepState('normalize', 'active'); break;
      case 'done':
        clearInterval(pollTimer);
        setStepState('normalize', 'done'); setStepState('done', 'done');
        setProgress(100);
        showResult(jobId); break;
      case 'error':
        clearInterval(pollTimer);
        showUploadError(data.error || '处理出错，请重试'); break;
    }
  } catch { /* 网络抖动，继续轮询 */ }
}

function showResult(jobId) {
  progressCard.classList.remove('visible');
  resultCard.classList.add('visible');
  btnDownload.href = '#';
  btnDownload.onclick = (event) => {
    event.preventDefault();
    downloadResult(jobId).catch((error) => showUploadError(error.message || String(error)));
  };
}

function setProgress(pct) { progressBar.style.width = `${Math.min(100, pct)}%`; }
function setLog(msg) { logArea.textContent = msg; }

function setStepState(key, state) {
  const el = document.getElementById('step-' + key);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (state === 'active') el.classList.add('active');
  if (state === 'done') { el.classList.add('done'); el.querySelector('.step-icon').textContent = '✓'; }
}

function showError(msg) { errorMsg.textContent = msg; errorMsg.classList.add('visible'); }
function hideError() { errorMsg.classList.remove('visible'); }

async function downloadResult(jobId) {
  const res = await authFetch(`${API_BASE}/api/refine/download/${jobId}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.message || `下载失败 (${res.status})`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const basename = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : 'audio';
  const a = document.createElement('a');
  a.href = url;
  a.download = basename + '_精修版.mp3';
  a.click();
  URL.revokeObjectURL(url);
}

function authFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  const token = readToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

function readToken() {
  try {
    const auth = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!auth.token || Date.parse(auth.expiresAt || '') <= Date.now() + 30 * 1000) return '';
    return auth.token;
  } catch {
    return '';
  }
}

function showUploadError(msg) {
  clearInterval(pollTimer);
  progressCard.classList.remove('visible');
  uploadCard.style.display = '';
  btnStart.disabled = false;
  showError(msg);
}

const stepOrder = ['upload', 'measure', 'normalize', 'done'];
btnAgain.addEventListener('click', () => {
  clearInterval(pollTimer);
  selectedFile = null; fileInput.value = '';
  fileNameEl.hidden = true; btnStart.disabled = true;
  setProgress(0); setLog('');
  stepOrder.forEach((k, i) => {
    const el = document.getElementById('step-' + k);
    if (!el) return;
    el.classList.remove('active', 'done');
    el.querySelector('.step-icon').textContent = i + 1;
  });
  resultCard.classList.remove('visible');
  progressCard.classList.remove('visible');
  uploadCard.style.display = '';
  hideError();
});
