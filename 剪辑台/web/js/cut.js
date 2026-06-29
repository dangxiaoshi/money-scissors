import { apiFetch, ensureLoggedIn, postUsage, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

const els = {};
let outputUrl = '';
let outputName = '';
const CUT_POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const LONG_WAIT_HINT_MS = 30 * 60 * 1000;
const PENDING_CUT_KEY = 'jinqian_pending_cut_job';
const SILENT_TROUBLE_HEADERS = { 'X-Money-Scissors-Silent-Trouble': '1' };
let currentCutJobId = '';
let currentRefineJobId = '';

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
      showError('MP3 还没生成好，请等页面显示“MP3 已生成”后再点下载。');
      return;
    }
    const label = els.download.textContent;
    clearError();
    els.download.disabled = true;
    els.download.textContent = '准备下载…';
    try {
      postUsage('download').catch(() => {});
      trackDownloadEvent('download_clicked', {
        jobId: currentCutJobId,
        refineJobId: currentRefineJobId,
        stage: currentRefineJobId ? 'refine_download' : 'download',
        status: 'clicked',
        message: currentRefineJobId ? '点击下载精修版 MP3' : '点击下载粗剪 MP3',
      });
      await triggerDownload(outputUrl, outputName || buildOutputName(false), ({ received, total }) => {
        const percent = total ? Math.floor((received / total) * 100) : 0;
        els.download.textContent = total ? `正在下载 ${percent}%` : '正在下载…';
        const detail = total
          ? `已准备 ${formatBytes(received)} / ${formatBytes(total)}，请不要关闭页面。`
          : `已准备 ${formatBytes(received)}，请不要关闭页面。`;
        setStatus('正在下载 MP3', detail, total ? Math.max(92, Math.min(99, percent)) : 98);
      });
      setStatus('下载已开始', '如果没有看到文件，请看一下浏览器右上角下载记录或下载文件夹。', 100);
    } catch (error) {
      trackDownloadEvent('failed', {
        jobId: currentCutJobId,
        refineJobId: currentRefineJobId,
        stage: currentRefineJobId ? 'refine_download' : 'download',
        status: 'client_error',
        message: error.message || String(error),
      });
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
    currentCutJobId = cutJob.jobId || '';
    trackDownloadEvent('queued', {
      jobId: currentCutJobId,
      stage: 'queued',
      status: 'resumed_pending',
      message: '页面找回本地保存的导出任务',
    });
    setStatus('继续等待 MP3 导出', '已找回刚才的导出任务，继续等待生成。', 5);
  } else {
    setStatus('提交 MP3 导出任务', '服务器会按当前删减方案重新生成 MP3，完成后可下载到外部软件继续剪/精修。', 5);
    cutJob = await startServerCut(data);
    currentCutJobId = cutJob.jobId || '';
    if (cutJob.resumedFromBusy) {
      setStatus('继续等待已有 MP3 导出', '系统检测到你账号里已有一个 MP3 正在生成，先继续等待它完成；如果超过 30 分钟，请截图给助教。', 5);
    } else {
      savePendingCutJob(data, cutJob.jobId);
    }
  }
  if (cutJob.stage === 'queued') showCutQueueStatus(cutJob);

  let cutResult;
  try {
    cutResult = await pollServerCut(cutJob.jobId);
  } catch (error) {
    if (isTerminalCutError(error)) clearPendingCutJob(cutJob.jobId);
    trackDownloadEvent('failed', {
      jobId: cutJob.jobId,
      stage: 'cut',
      status: 'poll_failed',
      message: error.message || String(error),
    });
    throw error;
  }
  if (!cutResult) throw new Error('MP3 导出任务未完成');
  clearPendingCutJob(cutJob.jobId);

  setStatus('生成下载链接', '正在准备 MP3 下载。', 92);
  const roughcutUrl = `/api/cut/download/${encodeURIComponent(cutJob.jobId)}`;

  const refineSettings = data.refineSettings || {};
  if (shouldRefine(refineSettings)) {
    try {
      setStatus('准备应用音频精修', '粗剪 MP3 已生成，正在尝试应用音频精修。', 93);
      await runRefineFromCut(cutJob.jobId, refineSettings);
      return;
    } catch (error) {
      console.warn('音频精修未应用，已降级为粗剪 MP3 下载', error);
      trackDownloadEvent('fallback_to_roughcut', {
        jobId: cutJob.jobId,
        refineJobId: currentRefineJobId,
        stage: 'refine',
        status: 'fallback',
        message: error.message || String(error),
      });
      currentRefineJobId = '';
      setRoughcutDownloadReady(
        roughcutUrl,
        '粗剪 MP3 已生成；音频精修这次没有应用，你可以先下载去外部软件继续剪。'
      );
      return;
    }
  }

  setRoughcutDownloadReady(roughcutUrl, '可以下载到电脑，再去剪映 / AU / Logic / Audacity 等外部软件继续剪或精修。');
}

function setRoughcutDownloadReady(roughcutUrl, detail) {
  outputUrl = roughcutUrl;
  outputName = buildOutputName(false);
  els.download.textContent = '下载 MP3（去外部软件）';
  els.download.disabled = false;
  els.download.classList.add('ready');
  setStatus('粗剪 MP3 已生成', detail, 100);
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
    if (resp.status === 429 && payload.error === 'cut_user_busy') {
      const currentResp = await apiFetch('/api/cut/current');
      const current = await currentResp.json().catch(() => ({}));
      if (currentResp.ok && current.jobId) {
        return { ...current, resumedFromBusy: true };
      }
    }
    throw new Error(payload.message || payload.error || `MP3 导出提交失败：HTTP ${resp.status}`);
  }
  if (!payload.jobId) throw new Error('MP3 导出任务缺少 jobId');
  return payload;
}

async function pollServerCut(jobId) {
  const startedAt = Date.now();
  let lastStage = '';
  while (Date.now() - startedAt < CUT_POLL_TIMEOUT_MS) {
    await wait(1800);
    const resp = await apiFetch(`/api/cut/status/${encodeURIComponent(jobId)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `MP3 导出状态读取失败：HTTP ${resp.status}`);

    const progress = Number(data.progress);
    const waitHint = buildLongWaitHint(startedAt);
    const stage = data.stage || data.status || '';
    if (stage && stage !== lastStage) {
      lastStage = stage;
      trackDownloadEvent(stage === 'done' ? 'ready' : stage, {
        jobId,
        stage,
        status: data.status || stage,
        message: stage === 'done' ? '前端确认粗剪 MP3 已生成' : `前端轮询到导出阶段：${stage}`,
        detail: {
          progress: Number.isFinite(progress) ? progress : null,
          queueAhead: Number(data.queueAhead || 0),
        },
      });
    }
    if (Number.isFinite(progress)) setProgress(Math.max(5, Math.min(99, progress)));
    if (data.status === 'done' || data.stage === 'done') return true;
    if (data.status === 'failed' || data.stage === 'error') throw new Error(data.error || 'MP3 导出失败');
    if (data.stage === 'queued') showCutQueueStatus(data, startedAt);
    else if (data.stage === 'downloading') setStatus('读取原始音频', `服务器正在读取原始音频，准备导出 MP3。${waitHint}`, Math.max(10, Math.min(30, progress || 10)));
    else if (data.stage === 'uploading') setStatus('准备下载文件', `服务器正在保存 MP3 下载文件，请保持页面打开。${waitHint}`, Math.max(92, Math.min(98, progress || 96)));
    else setStatus('正在生成 MP3', `服务器正在按你的删减方案重新剪辑并编码，请保持页面打开。${waitHint}`, Math.max(30, Math.min(95, progress || 30)));
  }
  throw new Error('MP3 导出等待超时，请截图给助教，带上项目名和手机号后四位。');
}

function showCutQueueStatus(data, startedAt = Date.now()) {
  const ahead = Number(data.queueAhead || 0);
  const waitHint = buildLongWaitHint(startedAt);
  const detail = ahead > 0
    ? `已进入导出队列，前面还有 ${ahead} 个任务；请不要反复点生成。${waitHint}`
    : `已进入导出队列，马上轮到你；请保持页面打开。${waitHint}`;
  setStatus('正在排队导出 MP3', detail, 5);
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

async function runRefineFromCut(cutJobId, refineSettings) {
  setStatus('正在提交音频精修', '粗剪 MP3 已生成，服务器会直接接着处理，不需要浏览器中转文件。', 94);

  const startResp = await apiFetch('/api/refine/start-from-cut', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...SILENT_TROUBLE_HEADERS },
    body: JSON.stringify({
      cutJobId,
      normalizeLoudness: refineSettings.normalizeLoudness ? '1' : '0',
      denoise: refineSettings.denoise ? '1' : '0',
      voiceEnhance: refineSettings.voiceEnhance ? '1' : '0',
      targetLufs: String(refineSettings.targetLufs || -16),
    }),
  });
  const startData = await startResp.json().catch(() => ({}));
  if (!startResp.ok) {
    throw new Error(startData.message || startData.error || `精修提交失败：HTTP ${startResp.status}`);
  }
  if (!startData.jobId) throw new Error('精修任务缺少 jobId');
  currentRefineJobId = startData.jobId;
  trackDownloadEvent('refine_started', {
    jobId: cutJobId,
    refineJobId: startData.jobId,
    stage: 'refine',
    status: 'accepted',
    message: '前端已提交后端精修任务',
  });

  const optionText = describeRefineOptions(refineSettings);
  setStatus(`正在应用：${optionText}`, '服务器正在处理音频，请保持页面打开。', 96);

  const done = await pollRefine(startData.jobId, optionText, cutJobId);
  if (!done) throw new Error('精修任务未完成');

  outputUrl = `/api/refine/download/${encodeURIComponent(startData.jobId)}`;
  outputName = buildOutputName(true);
  els.download.textContent = '下载精修版 MP3';
  els.download.disabled = false;
  els.download.classList.add('ready');
  setStatus('精修版 MP3 已生成', '可以下载到电脑，再去剪映 / AU / Logic / Audacity 等外部软件继续剪或交付。', 100);
}

async function pollRefine(jobId, optionText, cutJobId = '') {
  const startedAt = Date.now();
  let lastStage = '';
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    await wait(1800);
    const resp = await apiFetch(`/api/refine/status/${encodeURIComponent(jobId)}`, { headers: SILENT_TROUBLE_HEADERS });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `精修状态读取失败：HTTP ${resp.status}`);

    const status = data.status || data.stage;
    const progress = Number(data.progress);
    if (status && status !== lastStage) {
      lastStage = status;
      trackDownloadEvent(status === 'done' ? 'refine_done' : 'refine_status', {
        jobId: cutJobId,
        refineJobId: jobId,
        stage: 'refine',
        status,
        message: status === 'done' ? '前端确认精修版 MP3 已生成' : `前端轮询到精修阶段：${status}`,
        detail: { progress: Number.isFinite(progress) ? progress : null },
      });
    }
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

function buildLongWaitHint(startedAt) {
  if (Date.now() - Number(startedAt || 0) < LONG_WAIT_HINT_MS) return '';
  return ' 已经超过 30 分钟，请不要反复点；截图给助教，带项目名和手机号后四位。';
}

function trackDownloadEvent(eventType, event = {}) {
  try {
    const body = {
      eventType,
      jobId: event.jobId || currentCutJobId || '',
      refineJobId: event.refineJobId || currentRefineJobId || '',
      stage: event.stage || '',
      status: event.status || '',
      message: event.message || '',
      pageUrl: `${location.pathname}${location.search}`,
      browser: detectClientBrowser(),
      userAgent: navigator.userAgent || '',
      detail: event.detail || {},
    };
    apiFetch('/api/cut/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

function detectClientBrowser() {
  const ua = navigator.userAgent || '';
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome|CriOS/i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Android/i.test(ua)) return 'Safari';
  if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
  return ua ? 'Other' : '';
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
