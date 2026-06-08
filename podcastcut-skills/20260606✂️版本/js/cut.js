import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm';
import { apiFetch, ensureLoggedIn, postUsage, setupSessionChrome } from './api.js?v=20260606-1';

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
    if (!outputUrl) return;
    try {
      postUsage('download').catch(() => {});
      await triggerDownload(outputUrl, outputName || buildOutputName(false));
    } catch (error) {
      showError(error.message || String(error));
    }
  });

  runCut().catch((error) => showError(error.message || String(error)));
});

async function runCut() {
  const data = readCutData();
  if (!data.audioUrl) throw new Error('缺少原始音频 URL，请从审查页重新导出。');
  if (!Array.isArray(data.segments)) throw new Error('缺少删除段数据，请从审查页重新导出。');

  setStatus('加载剪辑引擎', '首次加载约 30MB，请保持页面打开。', 5);
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    const pct = 45 + Math.round((progress || 0) * 45);
    setProgress(pct);
  });
  await loadFFmpeg(ffmpeg);

  setStatus('读取原始音频', '正在下载原始音频。', 20);
  await ffmpeg.writeFile('input', await fetchFile(data.audioUrl));

  const duration = Number(data.original_duration) || await readDuration(data.audioUrl);
  const keepSegments = invertDeleteSegments(data.segments, duration);
  if (!keepSegments.length) throw new Error('所有音频都被标记删除了，无法生成成品。');

  setStatus('正在生成粗剪 MP3', `保留 ${keepSegments.length} 段，正在编码 MP3。`, 45);
  await ffmpeg.exec(buildFfmpegArgs(keepSegments));

  setStatus('生成下载链接', '正在写出 MP3 文件。', 92);
  const output = await ffmpeg.readFile('output.mp3');
  const blob = new Blob([output.buffer], { type: 'audio/mpeg' });

  const refineSettings = data.refineSettings || {};
  if (shouldRefine(refineSettings)) {
    await runRefine(blob, data.fileName || buildOutputName(false), refineSettings);
    return;
  }

  setDownload(blob, buildOutputName(false), '下载粗剪 MP3');
  setStatus('剪辑完成', '这份 MP3 已完成粗剪，可直接下载。', 100);
  els.download.disabled = false;
  els.download.classList.add('ready');
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
  setStatus('精修完成', '精修版 MP3 已生成，可以下载。', 100);
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

async function loadFFmpeg(ffmpeg) {
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });
}

function buildFfmpegArgs(keepSegments) {
  if (keepSegments.length === 1 && keepSegments[0].start <= 0.001) {
    return [
      '-i', 'input',
      '-t', String(keepSegments[0].end),
      '-vn',
      '-b:a', '192k',
      'output.mp3',
    ];
  }

  const trims = keepSegments
    .map((seg, index) => `[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS[a${index}]`)
    .join(';');
  const concatInputs = keepSegments.map((_, index) => `[a${index}]`).join('');
  const filter = `${trims};${concatInputs}concat=n=${keepSegments.length}:v=0:a=1[out]`;

  return [
    '-i', 'input',
    '-filter_complex', filter,
    '-map', '[out]',
    '-vn',
    '-b:a', '192k',
    'output.mp3',
  ];
}

function invertDeleteSegments(segments, duration) {
  const sorted = segments
    .map((segment) => ({
      start: clamp(Number(segment.start) || 0, 0, duration),
      end: clamp(Number(segment.end) || 0, 0, duration),
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  const keep = [];
  let cursor = 0;
  sorted.forEach((segment) => {
    if (segment.start - cursor > 0.04) keep.push({ start: round3(cursor), end: round3(segment.start) });
    cursor = Math.max(cursor, segment.end);
  });
  if (duration - cursor > 0.04) keep.push({ start: round3(cursor), end: round3(duration) });
  return keep;
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
    href = URL.createObjectURL(await resp.blob());
    revoke = true;
  }

  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 30000);
}

function buildOutputName(refined) {
  const data = readCutData();
  const base = (data.fileName || 'podcast')
    .replace(/\.[a-z0-9]{2,8}$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_');
  return `${base}_${refined ? '精修版' : '精剪版'}.mp3`;
}

function readDuration(url) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    audio.onloadedmetadata = () => resolve(audio.duration || 0);
    audio.onerror = () => reject(new Error('无法读取音频时长'));
  });
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
