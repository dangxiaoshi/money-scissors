import { uploadAudioToOSS } from './upload.js?v=20260606-1';
import { transcribeWithFunASR } from './transcribe.js?v=20260606-2';
import { analyzeEditing, applyAnalysisToReviewPayload } from './analyze.js?v=20260606-1';
import { ensureLoggedIn, postUsage, setupSessionChrome } from './api.js?v=20260606-1';
import {
  buildReviewPayload,
  buildSpeakerGroups,
  generateSentences,
  generateSubtitlesWords,
} from './transcript.js?v=20260606-1';

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const state = {
  file: null,
  startedAt: null,
  stepStartedAt: null,
  timer: null,
};

const steps = [
  { id: 'upload', label: '上传音频' },
  { id: 'transcribe', label: 'AI 语音转录' },
  { id: 'speakers', label: '识别说话人' },
  { id: 'analyze', label: 'AI 分析剪辑决策' },
  { id: 'prepare', label: '生成审查数据' },
  { id: 'review', label: '进入审查页面' },
];

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  const auth = ensureLoggedIn();
  if (!auth) return;
  bindEls();
  setupSessionChrome();
  renderSteps();
  bindUpload();
  bindActions();
});

function bindEls() {
  Object.assign(els, {
    fileInput: document.getElementById('audio-file'),
    uploadZone: document.getElementById('upload-zone'),
    filePill: document.getElementById('file-pill'),
    fileName: document.getElementById('file-name'),
    fileSize: document.getElementById('file-size'),
    speakerCount: document.getElementById('speaker-count'),
    startBtn: document.getElementById('start-btn'),
    error: document.getElementById('error'),
    progressCard: document.getElementById('progress-card'),
    stepList: document.getElementById('step-list'),
    progressElapsed: document.getElementById('progress-elapsed'),
    barFill: document.getElementById('bar-fill'),
    speakerModal: document.getElementById('speaker-modal'),
    speakerForm: document.getElementById('speaker-form'),
    speakerConfirm: document.getElementById('speaker-confirm'),
  });
}

function bindUpload() {
  els.uploadZone.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) setFile(file);
  });

  ['dragenter', 'dragover'].forEach((name) => {
    els.uploadZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.uploadZone.classList.add('dragging');
    });
  });

  ['dragleave', 'drop'].forEach((name) => {
    els.uploadZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.uploadZone.classList.remove('dragging');
    });
  });

  els.uploadZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) setFile(file);
  });
}

function bindActions() {
  els.startBtn.addEventListener('click', runPipeline);
}

function setFile(file) {
  clearError();
  const error = validateFile(file);
  if (error) {
    showError(error);
    return;
  }

  state.file = file;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatBytes(file.size);
  els.filePill.classList.add('visible');
}

function validateFile(file) {
  if (!file) return '请先选择音频文件。';
  const typeOk = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac)$/i.test(file.name);
  if (!typeOk) return '文件类型不对：请上传 mp3 / wav / m4a 等音频文件。';
  if (file.size > MAX_FILE_SIZE) return '文件超过 500MB，请压缩或裁剪后上传。';
  return '';
}

function validateSpeakerCount() {
  const value = Number(els.speakerCount.value);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('说话人数必须是 1-10 的整数。');
  }
  return value;
}

async function runPipeline() {
  try {
    clearError();
    const fileError = validateFile(state.file);
    if (fileError) throw new Error(fileError);
    const speakerCount = validateSpeakerCount();

    els.startBtn.disabled = true;
    els.startBtn.innerHTML = '<span class="spinner"></span>&nbsp;处理中…';
    els.progressCard.classList.add('visible');
    state.startedAt = Date.now();
    startTimer();

    setStep('upload', 'active', '准备上传');
    const uploadResult = await uploadAudioToOSS(state.file, {
      onProgress: (percentage) => {
        setStep('upload', 'active', `上传中 ${percentage}%`);
        setProgress(percentage * 0.22);
      },
    });
    setStep('upload', 'done', '上传完成');
    setProgress(25);

    setStep('transcribe', 'active', '提交转录任务');
    const transcription = await transcribeWithFunASR(uploadResult.audioUrl, speakerCount, {
      onStatus: (detail) => setStep('transcribe', 'active', detail),
    });
    setStep('transcribe', 'done', '转录完成');
    setProgress(65);

    setStep('speakers', 'active', '等待你填写说话人姓名');
    const speakerMapping = await requestSpeakerNames(transcription);
    setStep('speakers', 'done', '说话人已确认');
    setProgress(78);

    setStep('analyze', 'active', '准备分批分析');
    const subtitlesWords = generateSubtitlesWords(transcription, speakerMapping);
    const sentences = generateSentences(transcription, speakerMapping);
    const analysis = await analyzeEditing(sentences, {
      onProgress: (detail) => setStep('analyze', 'active', detail),
    });
    setStep('analyze', 'done', 'AI 分析完成');
    setProgress(86);

    setStep('prepare', 'active', '生成逐字稿和审查页数据');
    let payload = buildReviewPayload(sentences, {
      audioUrl: uploadResult.audioUrl,
      fileName: state.file.name,
      subtitlesWords,
    });
    payload = applyAnalysisToReviewPayload(payload, analysis);
    persistJson('jinqian_data', payload);
    await postUsage('pipeline_complete').catch(() => {});
    setStep('prepare', 'done', `${sentences.length} 句已准备`);
    setProgress(92);

    setStep('review', 'active', '正在打开审查页');
    await sleep(350);
    setStep('review', 'done', '完成');
    setProgress(100);
    location.href = 'review.html';
  } catch (error) {
    showError(error.message || String(error));
    stopTimer();
    els.startBtn.disabled = false;
    els.startBtn.textContent = '开始处理';
  }
}

function requestSpeakerNames(transcription) {
  const groups = buildSpeakerGroups(transcription);
  els.speakerForm.innerHTML = groups.map((group) => (
    `<div class="speaker-group">
      <div class="speaker-head">
        <label>Speaker ${escapeHtml(group.speakerId)}</label>
        <input data-speaker-id="${escapeHtml(group.speakerId)}" value="Speaker ${escapeHtml(group.speakerId)}" autocomplete="off">
      </div>
      <div class="speaker-examples">
        ${group.examples.map((example) => `<div>${formatTime(example.time)}：${escapeHtml(example.text)}</div>`).join('')}
      </div>
    </div>`
  )).join('');

  els.speakerModal.classList.add('visible');
  const firstInput = els.speakerForm.querySelector('input');
  firstInput?.focus();
  firstInput?.select();

  return new Promise((resolve) => {
    const onConfirm = () => {
      const mapping = {};
      els.speakerForm.querySelectorAll('input[data-speaker-id]').forEach((input) => {
        const id = input.dataset.speakerId;
        mapping[id] = input.value.trim() || `Speaker ${id}`;
      });
      els.speakerModal.classList.remove('visible');
      els.speakerConfirm.removeEventListener('click', onConfirm);
      resolve(mapping);
    };
    els.speakerConfirm.addEventListener('click', onConfirm);
  });
}

function renderSteps() {
  els.stepList.innerHTML = steps.map((step, index) => (
    `<div class="step" id="step-${step.id}">
      <div class="step-dot">${index + 1}</div>
      <div>
        <div class="step-title">${step.label}</div>
        <div class="step-detail" id="step-detail-${step.id}">等待开始</div>
      </div>
      <div class="step-time mono" id="step-time-${step.id}"></div>
    </div>`
  )).join('');
}

function setStep(id, status, detail) {
  const el = document.getElementById(`step-${id}`);
  const detailEl = document.getElementById(`step-detail-${id}`);
  const timeEl = document.getElementById(`step-time-${id}`);
  if (!el || !detailEl || !timeEl) return;

  el.classList.remove('active', 'done');
  if (status) el.classList.add(status);
  detailEl.textContent = detail || '';

  if (status === 'active') {
    state.stepStartedAt = Date.now();
    timeEl.textContent = '处理中…';
  } else if (status === 'done' && state.stepStartedAt) {
    timeEl.textContent = `${Math.max(1, Math.round((Date.now() - state.stepStartedAt) / 1000))}s`;
  }
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    els.progressElapsed.textContent = `已用 ${formatDuration(elapsed)}`;
  }, 1000);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function setProgress(value) {
  els.barFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.add('visible');
}

function clearError() {
  els.error.textContent = '';
  els.error.classList.remove('visible');
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(seconds) {
  const m = Math.floor((seconds || 0) / 60);
  const s = Math.floor((seconds || 0) % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function persistJson(key, value) {
  const serialized = JSON.stringify(value);
  sessionStorage.setItem(key, serialized);
  try {
    localStorage.setItem(key, serialized);
  } catch (error) {
    // sessionStorage is enough for the current flow; localStorage is a recovery cache.
  }
}
