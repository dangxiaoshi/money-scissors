import { apiFetch, ensureLoggedIn, postUsage, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

const els = {};
let outputUrl = '';
let outputName = '';

document.addEventListener('DOMContentLoaded', () => {
  const auth = ensureLoggedIn();
  if (!auth) return;

  Object.assign(els, {
    status: document.getElementById('status'),
    detail: document.getElementById('detail'),
    progress: document.getElementById('bar-fill'),
    download: document.getElementById('download-btn'),
    error: document.getElementById('error'),
  });
  setupSessionChrome();

  els.download.addEventListener('click', async () => {
    if (!outputUrl) {
      showError('MP3 还没准备好，请等页面显示“备用 MP3 已生成”后再点下载。');
      return;
    }
    const label = els.download.textContent;
    clearError();
    els.download.disabled = true;
    els.download.textContent = '正在下载…';
    try {
      postUsage('download').catch(() => {});
      await triggerDownload(outputUrl, outputName || buildOutputName(false));
      setStatus('下载已开始', '如果没有看到文件，请看一下浏览器右上角下载记录或下载文件夹。', 100);
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      els.download.disabled = false;
      els.download.textContent = label;
    }
  });

  runCut().catch((error) => showError(error.message || String(error)));
});

async function runCut() {
  const data = readCutData();
  if (!data.audioUrl) throw new Error('缺少原始音频 URL，请从审查页重新导出。');
  if (!Array.isArray(data.segments)) throw new Error('缺少删除段数据，请从审查页重新导出。');

  setStatus('提交剪辑任务', '服务器正在准备生成 MP3，请保持页面打开。', 5);
  const cutJob = await startServerCut(data);
  const cutResult = await pollServerCut(cutJob.jobId);
  if (!cutResult) throw new Error('剪辑任务未完成');

  setStatus('生成下载链接', '正在准备 MP3 下载。', 92);
  const roughcutUrl = `/api/cut/download/${encodeURIComponent(cutJob.jobId)}`;

  const refineSettings = data.refineSettings || {};
  if (shouldRefine(refineSettings)) {
    const roughcutResp = await apiFetch(roughcutUrl);
    if (!roughcutResp.ok) {
      const errorData = await roughcutResp.json().catch(() => ({}));
      throw new Error(errorData.message || errorData.error || `粗剪文件读取失败：HTTP ${roughcutResp.status}`);
    }
    const blob = await roughcutResp.blob();
    await runRefine(blob, data.fileName || buildOutputName(false), refineSettings);
    return;
  }

  outputUrl = roughcutUrl;
  outputName = buildOutputName(false);
  els.download.textContent = '下载粗剪 MP3';
  setStatus('备用 MP3 已生成', '可以下载自己先听；正式作业状态请回我的项目查看。', 100);
  els.download.disabled = false;
  els.download.classList.add('ready');
}

async function startServerCut(data) {
  const resp = await apiFetch('/api/cut/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioUrl: data.audioUrl,
      segments: data.segments,
      originalDuration: data.original_duration || data.originalDuration || 0,
      fileName: data.fileName || 'podcast.mp3',
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(payload.message || payload.error || `剪辑提交失败：HTTP ${resp.status}`);
  if (!payload.jobId) throw new Error('剪辑任务缺少 jobId');
  return payload;
}

async function pollServerCut(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    await wait(1800);
    const resp = await apiFetch(`/api/cut/status/${encodeURIComponent(jobId)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `剪辑状态读取失败：HTTP ${resp.status}`);

    const progress = Number(data.progress);
    if (Number.isFinite(progress)) setProgress(Math.max(5, Math.min(99, progress)));
    if (data.status === 'done' || data.stage === 'done') return true;
    if (data.status === 'failed' || data.stage === 'error') throw new Error(data.error || '剪辑处理失败');
    if (data.stage === 'downloading') setStatus('读取原始音频', '服务器正在读取原始音频。', Math.max(10, Math.min(30, progress || 10)));
    else setStatus('正在生成粗剪 MP3', '服务器正在剪辑并编码 MP3。', Math.max(30, Math.min(95, progress || 30)));
  }
  throw new Error('剪辑等待超时，请稍后重试。');
}

async function runRefine(blob, filename, refineSettings) {
  setStatus('正在上传粗剪音频', '准备交给服务器应用音频精修。', 94);

  const form = new FormData();
  form.append('audio', blob, filename);
  form.append('normalizeLoudness', refineSettings.normalizeLoudness ? '1' : '0');
  form.append('denoise', refineSettings.denoise ? '1' : '0');
  form.append('voiceEnhance', refineSettings.voiceEnhance ? '1' : '0');
  form.append('targetLufs', String(refineSettings.targetLufs || -16));

  const startResp = await apiFetch('/api/refine/start', {
    method: 'POST',
    body: form,
  });
  const startData = await startResp.json().catch(() => ({}));
  if (!startResp.ok) {
    throw new Error(startData.message || startData.error || `精修提交失败：HTTP ${startResp.status}`);
  }
  if (!startData.jobId) throw new Error('精修任务缺少 jobId');

  const optionText = describeRefineOptions(refineSettings);
  setStatus(`正在应用：${optionText}`, '服务器正在处理音频，请保持页面打开。', 96);

  const done = await pollRefine(startData.jobId, optionText);
  if (!done) throw new Error('精修任务未完成');

  outputUrl = `/api/refine/download/${encodeURIComponent(startData.jobId)}`;
  outputName = buildOutputName(true);
  els.download.textContent = '下载精修版 MP3';
  els.download.disabled = false;
  els.download.classList.add('ready');
  setStatus('备用精修 MP3 已生成', '可以下载自己先听；正式作业状态请回我的项目查看。', 100);
}

async function pollRefine(jobId, optionText) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    await wait(1800);
    const resp = await apiFetch(`/api/refine/status/${encodeURIComponent(jobId)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `精修状态读取失败：HTTP ${resp.status}`);

    const status = data.status || data.stage;
    const progress = Number(data.progress);
    if (Number.isFinite(progress)) setProgress(Math.max(96, Math.min(99, progress)));
    if (status === 'done') return true;
    if (status === 'failed' || status === 'error') throw new Error(data.error || '精修处理失败');
    setStatus(`正在应用：${optionText}`, '服务器正在处理音频，请保持页面打开。', Math.max(96, Math.min(99, progress || 96)));
  }
  throw new Error('精修等待超时，请稍后重试。');
}

function readCutData() {
  try {
    return JSON.parse(sessionStorage.getItem('jinqian_cut_data') || localStorage.getItem('jinqian_cut_data') || '{}');
  } catch (error) {
    return {};
  }
}

function shouldRefine(refineSettings) {
  return !!(
    refineSettings?.normalizeLoudness ||
    refineSettings?.denoise ||
    refineSettings?.voiceEnhance
  );
}

function describeRefineOptions(refineSettings) {
  const names = [];
  if (refineSettings.normalizeLoudness) names.push('响度统一');
  if (refineSettings.denoise) names.push('轻度降噪');
  if (refineSettings.voiceEnhance) names.push('人声增强');
  return names.join('、') || '音频精修';
}

function setDownload(blob, filename, label) {
  if (outputUrl && outputUrl.startsWith('blob:')) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob);
  outputName = filename;
  els.download.textContent = label;
}

async function triggerDownload(url, filename) {
  let href = url;
  let revoke = false;
  if (!url.startsWith('blob:')) {
    const resp = await apiFetch(url);
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.message || data.error || `下载失败：HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    if (!blob.size) throw new Error('下载文件为空，请重新生成 MP3。');
    href = URL.createObjectURL(blob);
    revoke = true;
  }

  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    if (revoke) URL.revokeObjectURL(href);
  }, 30000);
}

function buildOutputName(refined) {
  const data = readCutData();
  const base = (data.fileName || 'podcast')
    .replace(/\.[a-z0-9]{2,8}$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_');
  return `${base}_${refined ? '精修版' : '精剪版'}.mp3`;
}

function setStatus(status, detail, progress) {
  els.status.textContent = status;
  els.detail.textContent = detail;
  setProgress(progress);
}

function setProgress(progress) {
  els.progress.style.width = `${clamp(progress, 0, 100)}%`;
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.add('visible');
}

function clearError() {
  els.error.textContent = '';
  els.error.classList.remove('visible');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
