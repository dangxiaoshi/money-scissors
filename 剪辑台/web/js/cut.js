import { apiFetch, ensureLoggedIn, postUsage, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

const els = {};
let outputUrl = '';
let outputName = '';
const CUT_POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const PENDING_CUT_KEY = 'jinqian_pending_cut_job';

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
    els.download.textContent = '准备下载…';
    try {
      postUsage('download').catch(() => {});
      await triggerDownload(outputUrl, outputName || buildOutputName(false), ({ received, total }) => {
        const percent = total ? Math.floor((received / total) * 100) : 0;
        els.download.textContent = total ? `正在下载 ${percent}%` : '正在下载…';
        const detail = total
          ? `已准备 ${formatBytes(received)} / ${formatBytes(total)}，请不要关闭页面。`
          : `已准备 ${formatBytes(received)}，请不要关闭页面。`;
        setStatus('正在下载备用 MP3', detail, total ? Math.max(92, Math.min(99, percent)) : 98);
      });
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

  let cutJob = readPendingCutJob(data);
  if (cutJob) {
    setStatus('继续等待备用 MP3', '已找回刚才排队的任务，继续等待生成。', 5);
  } else {
    setStatus('提交剪辑任务', '这是备用 MP3，不影响提交给助教；请保持页面打开。', 5);
    cutJob = await startServerCut(data);
    savePendingCutJob(data, cutJob.jobId);
  }
  if (cutJob.stage === 'queued') showCutQueueStatus(cutJob);

  let cutResult;
  try {
    cutResult = await pollServerCut(cutJob.jobId);
  } catch (error) {
    if (isTerminalCutError(error)) clearPendingCutJob(cutJob.jobId);
    throw error;
  }
  if (!cutResult) throw new Error('剪辑任务未完成');
  clearPendingCutJob(cutJob.jobId);

  setStatus('生成下载链接', '正在准备备用 MP3 下载。', 92);
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
  setStatus('备用 MP3 已生成', '可以下载自己先听；如果已经点过提交审核，助教后台已经能看到。', 100);
  els.download.disabled = false;
  els.download.classList.add('ready');
}

async function startServerCut(data) {
  const resp = await apiFetch('/api/cut/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioUrl: data.audioUrl,
      storage: data.storage || '',
      objectKey: data.objectKey || '',
      bucket: data.bucket || '',
      region: data.region || '',
      segments: data.segments,
      originalDuration: data.original_duration || data.originalDuration || 0,
      fileName: data.fileName || 'podcast.mp3',
      goldenSegments: Array.isArray(data.goldenSegments) ? data.goldenSegments : [],
      introMusic: data.introMusic || null,
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(payload.message || payload.error || `剪辑提交失败：HTTP ${resp.status}`);
  }
  if (!payload.jobId) throw new Error('剪辑任务缺少 jobId');
  return payload;
}

async function pollServerCut(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CUT_POLL_TIMEOUT_MS) {
    await wait(1800);
    const resp = await apiFetch(`/api/cut/status/${encodeURIComponent(jobId)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `剪辑状态读取失败：HTTP ${resp.status}`);

    const progress = Number(data.progress);
    if (Number.isFinite(progress)) setProgress(Math.max(5, Math.min(99, progress)));
    if (data.status === 'done' || data.stage === 'done') return true;
    if (data.status === 'failed' || data.stage === 'error') throw new Error(data.error || '剪辑处理失败');
    if (data.stage === 'queued') showCutQueueStatus(data);
    else if (data.stage === 'downloading') setStatus('读取原始音频', '服务器正在读取原始音频；这是备用 MP3，不用重复提交。', Math.max(10, Math.min(30, progress || 10)));
    else setStatus('正在生成粗剪 MP3', '服务器正在剪辑并编码 MP3；请保持页面打开。', Math.max(30, Math.min(95, progress || 30)));
  }
  throw new Error('备用 MP3 排队等待超时，请稍后重新生成。');
}

function showCutQueueStatus(data) {
  const ahead = Number(data.queueAhead || 0);
  const detail = ahead > 0
    ? `已进入队列，前面还有 ${ahead} 个任务；这只是备用 MP3，不影响提交审核。`
    : '已进入队列，马上轮到你；请保持页面打开。';
  setStatus('正在排队生成备用 MP3', detail, 5);
}

function readPendingCutJob(data) {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_CUT_KEY) || '{}');
    if (!saved.jobId || saved.signature !== buildPendingCutSignature(data)) return null;
    if (Date.now() - Number(saved.createdAt || 0) > CUT_POLL_TIMEOUT_MS) {
      localStorage.removeItem(PENDING_CUT_KEY);
      return null;
    }
    return { jobId: saved.jobId, stage: 'queued' };
  } catch {
    return null;
  }
}

function savePendingCutJob(data, jobId) {
  try {
    localStorage.setItem(PENDING_CUT_KEY, JSON.stringify({
      jobId,
      signature: buildPendingCutSignature(data),
      createdAt: Date.now(),
    }));
  } catch {}
}

function clearPendingCutJob(jobId) {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_CUT_KEY) || '{}');
    if (!jobId || saved.jobId === jobId) localStorage.removeItem(PENDING_CUT_KEY);
  } catch {
    localStorage.removeItem(PENDING_CUT_KEY);
  }
}

function buildPendingCutSignature(data) {
  const storage = data.storage || '';
  const objectKey = data.objectKey || '';
  const audioRef = storage === 'oss' && objectKey ? `oss:${objectKey}` : `url:${data.audioUrl || ''}`;
  return JSON.stringify({
    audioRef,
    storage,
    objectKey,
    fileName: data.fileName || '',
    segments: Array.isArray(data.segments) ? data.segments : [],
    goldenSegments: Array.isArray(data.goldenSegments) ? data.goldenSegments : [],
    introMusic: data.introMusic || null,
  });
}

function isTerminalCutError(error) {
  const message = error?.message || String(error || '');
  return /任务不存在|已过期|已自动取消|处理失败|等待超时|剪辑处理失败/.test(message);
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
  setStatus('备用精修 MP3 已生成', '可以下载自己先听；如果已经点过提交审核，助教后台已经能看到。', 100);
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

async function triggerDownload(url, filename, onProgress) {
  let href = url;
  let revoke = false;
  if (!url.startsWith('blob:')) {
    // 这里必须让浏览器直接导航到同源下载接口：OSS 产物会 302 到签名链接。
    // 如果用 fetch 读 blob，浏览器会把重定向后的 OSS 当跨域请求，可能被 CORS 拦住。
    if (typeof onProgress === 'function') onProgress({ received: 1, total: 1 });
    clickDownloadLink(href, filename, false);
    return;
  } else if (typeof onProgress === 'function') {
    onProgress({ received: 1, total: 1 });
  }

  clickDownloadLink(href, filename, revoke);
}

function clickDownloadLink(href, filename, revoke) {
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

async function readBlobWithProgress(resp, onProgress) {
  const total = Number(resp.headers.get('content-length') || 0);
  const type = resp.headers.get('content-type') || 'audio/mpeg';

  if (!resp.body || !resp.body.getReader) {
    const blob = await resp.blob();
    if (typeof onProgress === 'function') onProgress({ received: blob.size, total: blob.size || total });
    return blob;
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (typeof onProgress === 'function') onProgress({ received, total });
  }

  return new Blob(chunks, { type });
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

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
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
