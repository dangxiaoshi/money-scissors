import { uploadAudioToOSS } from './upload.js?v=20260610-reviewflow-1';
import { transcribeWithFunASR } from './transcribe.js?v=20260610-fix2';
import { analyzeEditing, applyAnalysisToReviewPayload } from './analyze.js?v=20260609-1';
import { apiJson, ensureLoggedIn, postUsage, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';
import {
  buildReviewPayload,
  buildSpeakerGroups,
  generateSentences,
  generateSubtitlesWords,
} from './transcript.js?v=20260606-1';

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const MAX_FILES = 10;

const state = {
  files: [],
  remoteTask: null,
  startedAt: null,
  timer: null,
};

let fileSeq = 0;

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  const auth = ensureLoggedIn();
  if (!auth) return;
  bindEls();
  setupSessionChrome();
  loadTaskFromQuery();
  bindUpload();
  bindActions();
});

function bindEls() {
  Object.assign(els, {
    fileInput: document.getElementById('audio-file'),
    uploadZone: document.getElementById('upload-zone'),
    fileList: document.getElementById('file-list'),
    fileItems: document.getElementById('file-items'),
    fileListCount: document.getElementById('file-list-count'),
    addMoreBtn: document.getElementById('add-more-btn'),
    clearFilesBtn: document.getElementById('clear-files-btn'),
    speakerCount: document.getElementById('speaker-count'),
    startBtn: document.getElementById('start-btn'),
    error: document.getElementById('error'),
    progressCard: document.getElementById('progress-card'),
    progressElapsed: document.getElementById('progress-elapsed'),
    barFill: document.getElementById('bar-fill'),
    processTitle: document.getElementById('process-title'),
    processSub: document.getElementById('process-sub'),
    taskBanner: document.getElementById('task-banner'),
    taskTitle: document.getElementById('task-title'),
    taskDemand: document.getElementById('task-demand'),
    taskAudioLink: document.getElementById('task-audio-link'),
    uploadLabel: document.getElementById('upload-label'),
  });
}

async function loadTaskFromQuery() {
  const taskId = new URLSearchParams(location.search).get('task');
  if (!taskId) return;
  try {
    const data = await apiJson('/api/orders/tasks');
    const task = (Array.isArray(data.tasks) ? data.tasks : []).find((item) => String(item.id) === String(taskId));
    if (!task) throw new Error('这条接单任务不存在，或还没有发布。');
    if (!task.materialLink) throw new Error('这条接单任务还没有上传音频素材。');
    state.remoteTask = {
      id: task.id,
      title: task.title || `接单任务 ${task.id}`,
      demand: task.demand || '',
      audioUrl: task.materialLink,
    };
    renderRemoteTask();
  } catch (error) {
    showError(formatErrorMessage(error));
  }
}

function renderRemoteTask() {
  if (!state.remoteTask || !els.taskBanner) return;
  els.taskBanner.classList.add('visible');
  if (els.taskTitle) els.taskTitle.textContent = `已载入：${state.remoteTask.title}`;
  if (els.taskDemand) {
    els.taskDemand.textContent = state.remoteTask.demand
      ? `任务需求：${state.remoteTask.demand}`
      : '任务需求：后台暂时没有填写，按音频内容先完成基础剪辑。';
  }
  if (els.taskAudioLink) els.taskAudioLink.href = state.remoteTask.audioUrl;
  if (els.uploadLabel) els.uploadLabel.textContent = '任务音频';
  if (els.uploadZone) {
    els.uploadZone.classList.add('is-hidden');
  }
}

function bindUpload() {
  els.uploadZone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openFilePicker();
  });
  els.addMoreBtn.addEventListener('click', openFilePicker);
  els.clearFilesBtn.addEventListener('click', clearFiles);
  els.fileInput.addEventListener('change', handleFileInput);

  function handleFileInput() {
    const picked = Array.from(els.fileInput.files || []);
    if (picked.length) addFiles(picked);
    // 清空 input，方便再次选择同一个文件
    els.fileInput.value = '';
  }

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
    const dropped = Array.from(event.dataTransfer?.files || []);
    if (dropped.length) addFiles(dropped);
  });

  els.fileItems.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.file-item')?.dataset.id;
    if (!id) return;
    const act = btn.dataset.act;
    if (act === 'up') moveFile(id, -1);
    else if (act === 'down') moveFile(id, 1);
    else if (act === 'del') removeFile(id);
  });
}

function openFilePicker() {
  if (typeof els.fileInput.showPicker === 'function') {
    els.fileInput.showPicker();
    return;
  }
  els.fileInput.click();
}

function bindActions() {
  els.startBtn.addEventListener('click', runPipeline);
}

function addFiles(fileArr) {
  clearError();
  const room = MAX_FILES - state.files.length;
  if (room <= 0) {
    showError(`最多 ${MAX_FILES} 个音频，已达上限。如需更多，请先删除一些。`);
    return;
  }
  const incoming = fileArr.slice(0, room);
  const rejected = [];
  for (const file of incoming) {
    const error = validateFile(file);
    if (error) { rejected.push(`${file.name}：${error}`); continue; }
    state.files.push({ id: `f${++fileSeq}`, file });
  }
  if (fileArr.length > room) {
    rejected.push(`一次最多 ${MAX_FILES} 个，多出的 ${fileArr.length - room} 个已忽略。`);
  }
  renderFileList();
  if (rejected.length) showError(rejected.join('\n'));
}

function removeFile(id) {
  state.files = state.files.filter((item) => item.id !== id);
  renderFileList();
}

function clearFiles() {
  state.files = [];
  clearError();
  renderFileList();
}

function moveFile(id, delta) {
  const index = state.files.findIndex((item) => item.id === id);
  if (index < 0) return;
  const target = index + delta;
  if (target < 0 || target >= state.files.length) return;
  const [item] = state.files.splice(index, 1);
  state.files.splice(target, 0, item);
  renderFileList();
}

function renderFileList() {
  const count = state.files.length;
  els.fileList.hidden = count === 0;
  els.uploadZone.classList.toggle('is-hidden', count >= MAX_FILES);
  els.fileListCount.textContent = count > 1
    ? `已选 ${count} 个音频 · 按下面顺序拼接`
    : `已选 ${count} 个音频`;
  els.fileItems.innerHTML = '';
  state.files.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.id = item.id;

    const idx = document.createElement('span');
    idx.className = 'file-item-idx';
    idx.textContent = String(index + 1);

    const name = document.createElement('span');
    name.className = 'file-item-name';
    name.textContent = item.file.name;
    name.title = item.file.name;

    const size = document.createElement('span');
    size.className = 'file-item-size';
    size.textContent = formatBytes(item.file.size);

    const ctrls = document.createElement('span');
    ctrls.className = 'file-item-ctrls';
    ctrls.innerHTML = `
      <button type="button" data-act="up" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" data-act="down" title="下移" ${index === count - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="del" data-act="del" title="删除">✕</button>`;

    li.append(idx, name, size, ctrls);
    els.fileItems.appendChild(li);
  });
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
    const usingRemoteTask = Boolean(state.remoteTask?.audioUrl && !state.files.length);
    if (!state.files.length && !usingRemoteTask) throw new Error('请先选择至少一个音频文件。');
    if (!usingRemoteTask) {
      for (const item of state.files) {
        const fileError = validateFile(item.file);
        if (fileError) throw new Error(`${item.file.name}：${fileError}`);
      }
      if (state.files.length > MAX_FILES) throw new Error(`一次最多处理 ${MAX_FILES} 个音频。`);
    }
    const speakerCount = validateSpeakerCount();

    els.startBtn.disabled = true;
    els.startBtn.innerHTML = '<span class="spinner"></span>&nbsp;正在处理…';
    els.progressCard.classList.add('visible');
    state.startedAt = Date.now();
    startTimer();
    els.progressCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    let total = state.files.length;
    let sources = [];
    let workingAudioUrl = '';
    let projectName = '';

    if (usingRemoteTask) {
      updateProcess('已载入接单任务音频，准备转录…');
      sources = [{ name: state.remoteTask.title, url: state.remoteTask.audioUrl, order: 0 }];
      workingAudioUrl = state.remoteTask.audioUrl;
      projectName = state.remoteTask.title;
      total = 1;
      setProgress(20);
    } else {
      // 按用户排好的顺序逐个上传，记录每个文件的来源信息
      for (let i = 0; i < total; i += 1) {
        const item = state.files[i];
        const label = total > 1 ? `（${i + 1}/${total}）${item.file.name}` : item.file.name;
        updateProcess(`正在上传音频 ${label}…`);
        let uploaded;
        try {
          uploaded = await uploadAudioToOSS(item.file, {
            onProgress: (percentage) => {
              updateProcess(`正在上传音频 ${label}… ${percentage}%`);
              setProgress((i / total) * 18 + (percentage / 100) * (18 / total));
            },
          });
        } catch (error) {
          throw new Error(`第 ${i + 1} 个音频「${item.file.name}」上传失败：${formatErrorMessage(error)}`);
        }
        sources.push({ name: item.file.name, url: uploaded.audioUrl, order: i });
      }
      setProgress(20);

      // 多个音频先按顺序拼成一个 MP3，再走原有单音频流程
      workingAudioUrl = sources[0].url;
      projectName = sources[0].name;
      if (total > 1) {
        projectName = `多音频项目（${total} 个）`;
        updateProcess('正在按顺序拼接音频…');
        workingAudioUrl = await concatAudios(sources, {
          onStatus: (detail, progress) => {
            updateProcess(detail || '正在按顺序拼接音频…');
            if (typeof progress === 'number') setProgress(20 + (progress / 100) * 5);
          },
        });
      }
    }
    setProgress(25);

    updateProcess('正在转录中…');
    const transcription = await transcribeWithFunASR(workingAudioUrl, speakerCount, {
      onStatus: (detail) => updateProcess(detail || '正在转录中…'),
    });
    setProgress(65);

    updateProcess('正在整理说话人…');
    const speakerMapping = buildDefaultSpeakerMapping(transcription);
    setProgress(78);

    updateProcess('正在生成剪辑建议…');
    const subtitlesWords = generateSubtitlesWords(transcription, speakerMapping);
    const sentences = generateSentences(transcription, speakerMapping);
    let analysis = { blocks: [], sentenceDecisions: [], fineEdits: [] };
    try {
      analysis = await analyzeEditing(sentences, {
        onProgress: (detail) => updateProcess(detail || '正在生成剪辑建议…'),
      });
    } catch (error) {
      console.warn('AI 粗剪分析失败，继续生成逐字稿：', error);
      updateProcess('剪辑建议暂时失败，正在先准备逐字稿…');
    }
    setProgress(86);

    updateProcess('正在准备逐字稿剪辑页…');
    let payload = buildReviewPayload(sentences, {
      audioUrl: workingAudioUrl,
      fileName: projectName,
      subtitlesWords,
    });
    payload = applyAnalysisToReviewPayload(payload, analysis);
    if (usingRemoteTask) {
      payload.dispatchTask = {
        id: state.remoteTask.id,
        title: state.remoteTask.title,
        demand: state.remoteTask.demand,
      };
    }
    // 记录多音频来源与排序，刷新/重开项目后顺序不丢
    if (total > 1) {
      payload.sources = sources.map((s) => ({ name: s.name, order: s.order }));
    }
    persistJson('jinqian_data', payload);

    updateProcess('正在保存项目…');
    try {
      const saved = await saveProjectPayload({
        projectId: payload.projectId,
        fileName: projectName,
        audioUrl: workingAudioUrl,
        payload,
      });
      if (saved?.project?.id) {
        payload.projectId = saved.project.id;
        persistJson('jinqian_data', payload);
      }
    } catch (error) {
      console.warn('服务器项目预保存失败，继续处理：', error);
      updateProcess('项目云端保存暂时失败，继续准备剪辑页…');
    }

    await postUsage('pipeline_complete').catch(() => {});
    setProgress(92);

    updateProcess('正在生成剪辑决策…');
    setProgress(94);
    let openLocalReviewOnly = false;
    try {
      const decisionBundle = await generateDecisionBundle(sentences, { timeoutMs: 25000 });
      if (decisionBundle.decisionReport) {
        payload.decisionReport = decisionBundle.decisionReport;
        payload.CHAPS = decisionBundle.chapters;
        delete payload.decisionError;
        delete payload.decisionSaveError;
        persistJson('jinqian_data', payload);
        if (payload.projectId) {
          try {
            await saveProjectPayload({
              projectId: payload.projectId,
              fileName: projectName,
              audioUrl: workingAudioUrl,
              payload,
            });
          } catch (error) {
            payload.decisionSaveError = `剪辑决策已经在本机生成，但暂时没有保存到云端项目：${formatErrorMessage(error)}`;
            persistJson('jinqian_data', payload);
            openLocalReviewOnly = true;
            console.warn('剪辑决策回写项目失败，先打开本机剪辑页：', error);
          }
        }
      }
    } catch (error) {
      delete payload.decisionReport;
      delete payload.CHAPS;
      delete payload.decisionSaveError;
      payload.decisionError = `剪辑决策没有生成成功：${formatErrorMessage(error)}`;
      persistJson('jinqian_data', payload);
      if (payload.projectId) {
        await saveProjectPayload({
          projectId: payload.projectId,
          fileName: projectName,
          audioUrl: workingAudioUrl,
          payload,
        }).catch((saveError) => {
          openLocalReviewOnly = true;
          console.warn('剪辑决策失败状态保存失败，先打开本机剪辑页：', saveError);
        });
      }
      updateProcess('剪辑决策暂时没有生成成功…');
      console.warn('剪辑决策生成失败，进入逐字稿剪辑页并显示失败状态：', error);
    }
    if (!payload.projectId) {
      updateProcess('正在保存项目…');
      try {
        const saved = await saveProjectPayload({
          fileName: projectName,
          audioUrl: workingAudioUrl,
          payload,
        });
        if (saved?.project?.id) {
          payload.projectId = saved.project.id;
          persistJson('jinqian_data', payload);
        }
      } catch (error) {
        console.warn('服务器项目保存失败，使用浏览器兜底：', error);
        updateProcess('项目云端保存暂时失败，先进入本机剪辑页…');
      }
    }

    updateProcess('处理完成，正在跳转…');
    setProgress(100);
    stopTimer();
    location.href = payload.projectId && !openLocalReviewOnly ? `review.html?project=${encodeURIComponent(payload.projectId)}` : 'review.html';
  } catch (error) {
    showError(formatErrorMessage(error));
    stopTimer();
    els.startBtn.disabled = false;
    els.startBtn.textContent = '开始处理';
  }
}

async function concatAudios(sources, { onStatus } = {}) {
  const start = await apiJson('/api/audio/concat/start', {
    method: 'POST',
    body: JSON.stringify({ sources: sources.map((s) => ({ url: s.url, name: s.name })) }),
  });
  const jobId = start?.jobId;
  if (!jobId) throw new Error('音频拼接任务创建失败，请重试。');

  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const status = await apiJson(`/api/audio/concat/status/${encodeURIComponent(jobId)}`);
    if (onStatus) {
      const pct = typeof status.progress === 'number' ? status.progress : null;
      onStatus(`正在按顺序拼接音频…${pct != null ? ' ' + pct + '%' : ''}`, pct);
    }
    if (status.status === 'done' && status.audioUrl) return status.audioUrl;
    if (status.status === 'failed') throw new Error(status.error || '音频拼接失败，请重试。');
  }
  throw new Error('音频拼接超时，请减少音频数量后重试。');
}

async function saveProjectPayload({ projectId, fileName, audioUrl, payload }) {
  const endpoint = projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/projects';
  return apiJson(endpoint, {
    method: projectId ? 'PATCH' : 'POST',
    body: JSON.stringify({
      fileName,
      audioUrl,
      payload,
      metrics: buildProjectMetrics(payload),
    }),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDefaultSpeakerMapping(transcription) {
  const groups = buildSpeakerGroups(transcription);
  const defaultNames = buildDefaultSpeakerNames(groups);
  return groups.reduce((mapping, group, index) => {
    mapping[group.speakerId] = defaultNames[index] || `说话人${index + 1}`;
    return mapping;
  }, {});
}

function buildDefaultSpeakerNames(groups) {
  if (groups.length <= 1) return ['播客主'];
  return groups.map((_, index) => (index === 0 ? '播客主' : `嘉宾${index}`));
}

function updateProcess(title) {
  if (els.processTitle) els.processTitle.textContent = title;
  if (els.processSub) els.processSub.textContent = inferProcessHint(title);
}

function inferProcessHint(title) {
  const text = String(title || '');
  if (/上传/.test(text)) return '正在把音频传到云端。文件越大越慢，请保持页面打开。';
  if (/拼接/.test(text)) return '多个音频会先按你排好的顺序合成一条，再进入转录。';
  if (/转录|已等待|下载转录结果|提交转录任务/.test(text)) {
    return '正在把音频转成文字稿。通常需要几分钟，长音频可能更久；最长等待 25 分钟。请保持页面打开，完成后会自动进入剪辑页。';
  }
  if (/整理说话人/.test(text)) return '转录已完成，正在把不同说话人的内容分清楚。';
  if (/剪辑建议/.test(text)) return '正在先做逐字稿删减建议；如果这一步失败，也会继续准备剪辑页。';
  if (/准备逐字稿|保存项目/.test(text)) return '正在保存当前项目，避免上传完成后找不到记录。';
  if (/剪辑决策/.test(text)) return '正在生成前情总览和三幕剪辑方案；这里不会用演示内容冒充真实结果。';
  if (/处理完成|跳转/.test(text)) return '已经处理完成，马上进入逐字稿剪辑页。';
  if (/失败|超时|错误/.test(text)) return '这一步没有正常完成。请按页面提示重试，或换一个更短的音频再试。';
  return '处理时请保持页面打开。转录通常需要几分钟，完成后会自动进入剪辑页。';
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

function persistJson(key, value) {
  const serialized = JSON.stringify(value);
  sessionStorage.setItem(key, serialized);
  try {
    localStorage.setItem(key, serialized);
  } catch (error) {
    // sessionStorage is enough for the current flow; localStorage is a recovery cache.
  }
}

function buildProjectMetrics(payload) {
  const total = Array.isArray(payload?.S) && payload.S.length ? Number(payload.S[payload.S.length - 1]?.e || 0) : 0;
  return {
    originalDuration: Math.round(total || 0),
    roughcutDuration: 0,
    removedDuration: 0,
  };
}

const DECISION_ACTIONS = new Set(['保留', '删除', '压缩']);

const ANALYSIS_PROMPT = `你是一个做了十年内容营销的播客剪辑顾问。你帮人决定一期播客哪些该留、哪些该删，以及这期节目应该按什么主线剪。

你判断内容好不好，不看讲得对不对，看的是：
1. 听众听到这段会不会有感觉，会笑、会难过、会觉得说到心坎里了，这种留
2. 两个人聊到观点不一样、或者说了大家没想到的话，这种留
3. 讲了一个真实的事，有画面感的，比干巴巴讲道理好，留
4. 没什么情绪、在重复前面说过的、或者跑题了的，删

语气要求：说人话，别用书面语，别用AI味的词，不要用书名号，不要用「」这种括号，写出来要像跟朋友聊天一样。

用户会给你带句子编号的播客逐字稿。你直接分析，别问东问西，有什么就分析什么。

你必须把整期内容拆成 4 个折叠块：
1. 前情总览
2. 第一幕
3. 第二幕
4. 第三幕

只输出 JSON，不要解释，不要代码块。body 字段里允许使用 markdown 小标题和短横线列表。

JSON 格式必须是：
{
  "sections": [
    {
      "key": "overview",
      "title": "前情总览",
      "action": "保留",
      "startIdx": 0,
      "body": "### 节目概要\\n- 播客主：如果听不出就写不明确\\n- 嘉宾：如果听不出就写不明确\\n- 这期聊了什么：用一句话说清楚，要让人一看就想听\\n- 适合谁听 / 能带走什么：\\n- 内容侧重：干货 / 故事 / 情绪，大概各占多少\\n- 高光时刻：全篇最值得传播的一个地方，说清楚为什么\\n- 最不能删的部分：全篇最有价值的一个地方，说清楚为什么\\n- 下次优化：站在老播客主的角度，指出一个地方其实可以追问得更深\\n- 建议保留比例：xx%\\n\\n### 剪辑方案\\n- 核心主线：一句话，写得像一个让人想点进来的标题\\n- 为什么这么剪：两句话说清楚\\n- 金句开场：从原文里挑3-5句最能打动人的话"
    },
    {
      "key": "act1",
      "title": "第一幕：这里写你生成的幕标题",
      "action": "保留",
      "startIdx": 12,
      "body": "- 这段要做到什么：让听众 ___\\n- 听完的感觉：___\\n- 保留内容：写具体保留哪些内容和原因\\n- 可压缩/删掉：写具体删哪些重复、跑题、寒暄"
    },
    {
      "key": "act2",
      "title": "第二幕：这里写你生成的幕标题",
      "action": "压缩",
      "startIdx": 45,
      "body": "- 这段要做到什么：让听众 ___\\n- 听完的感觉：___\\n- 保留内容：写具体保留哪些内容和原因\\n- 可压缩/删掉：写具体删哪些重复、跑题、寒暄"
    },
    {
      "key": "act3",
      "title": "第三幕：这里写你生成的幕标题",
      "action": "保留",
      "startIdx": 78,
      "body": "- 这段要做到什么：让听众 ___\\n- 听完的感觉：___\\n- 保留内容：写具体保留哪些内容和原因\\n- 可压缩/删掉：写具体删哪些重复、跑题、寒暄"
    }
  ]
}

硬性规则：
- sections 必须正好 4 条，顺序不能变
- key 必须分别是 overview / act1 / act2 / act3
- action 只能是 保留、删除、压缩 三个词之一，不要加别的字
- startIdx 必须是这一段开始的句子编号，来自逐字稿开头的 [idx]
- 前情总览 startIdx 必须是 0
- act1 / act2 / act3 的 startIdx 要递增
- title 不要超过 18 个汉字
- 前情总览必须包含：播客主、嘉宾、这期聊了什么、适合谁听/能带走什么、内容侧重、高光时刻、最不能删的部分、下次优化、建议保留比例、核心主线、为什么这么剪、金句开场
- 三幕必须各自包含：这段要做到什么、听完的感觉、保留内容、可压缩/删掉
- startIdx 要尽量选这一幕真正开始的句子编号，不要全都写 0
- body 要具体，不能只写空话；引用原文金句时可以摘短句，但不要大段复制`;

async function generateDecisionBundle(sentences, { timeoutMs = 25000 } = {}) {
  try {
    const transcriptText = formatIndexedTranscript(sentences);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch('https://chuanjiabao.vip/ai/', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 6500,
        stream: true,
        messages: [{ role: 'user', content: ANALYSIS_PROMPT + '\n\n以下是播客逐字稿：\n\n' + transcriptText }],
      }),
    }).finally(() => clearTimeout(timeoutId));

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(readAiProxyError(err, res.status));
    }

    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') continue;
        try {
          const event = JSON.parse(jsonStr);
          if (event.choices?.[0]?.delta?.content) {
            fullText += event.choices[0].delta.content;
          }
        } catch (_) {}
      }
    }

    if (!fullText) throw new Error('未收到分析内容');
    const parsed = parseJsonFromAi(fullText);
    const sections = normalizeDecisionSections(parsed?.sections, sentences);
    return buildDecisionBundleFromSections(sections, sentences);
  } catch (e) {
    throw new Error(`AI 剪辑决策没有正常返回：${formatErrorMessage(e)}`);
  }
}

function formatIndexedTranscript(sentences) {
  return sentences.map((s) => {
    const min = Math.floor(s.startTime / 60);
    const sec = String(Math.floor(s.startTime % 60)).padStart(2, '0');
    return `[${s.idx}] ${s.speaker} ${min}:${sec}：${s.text}`;
  }).join('\n');
}

function parseJsonFromAi(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('AI 未返回剪辑决策 JSON');
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI 返回内容不是 JSON');
    return JSON.parse(match[0]);
  }
}

function normalizeDecisionSections(inputSections, sentences) {
  if (!Array.isArray(inputSections)) throw new Error('剪辑决策 JSON 缺少 sections 数组');
  const keys = ['overview', 'act1', 'act2', 'act3'];
  const fallback = fallbackDecisionSections(sentences);
  let lastIdx = -1;
  return keys.map((key, index) => {
    const incoming = inputSections.find((section) => section?.key === key) || inputSections[index] || {};
    const incomingBody = String(incoming.body || '').trim();
    if (!incomingBody) throw new Error(`剪辑决策缺少「${key}」的详细内容`);
    const fallbackSection = fallback[index];
    const incomingAction = String(incoming.action || '').trim();
    const action = DECISION_ACTIONS.has(incomingAction) ? incomingAction : fallbackSection.action;
    const minStartIdx = index === 0 ? 0 : Math.max(lastIdx + 1, fallbackSection.startIdx);
    const startIdx = index === 0
      ? 0
      : clampStartIdx(Number(incoming.startIdx), sentences, minStartIdx);
    lastIdx = startIdx;
    return {
      key,
      title: normalizeDecisionTitle(key, incoming.title || fallbackSection.title),
      action,
      startIdx,
      body: incomingBody,
    };
  });
}

function normalizeDecisionTitle(key, title) {
  const clean = String(title || '').replace(/^#+\s*/, '').replace(/[\[\]]/g, '').trim();
  if (key === 'overview') return '前情总览';
  const prefix = { act1: '第一幕', act2: '第二幕', act3: '第三幕' }[key];
  const withoutPrefix = clean.replace(new RegExp(`^${prefix}[:：\\s]*`), '').trim();
  return withoutPrefix ? `${prefix}：${withoutPrefix.slice(0, 18)}` : prefix;
}

function clampStartIdx(value, sentences, fallback) {
  const valid = new Set(sentences.map((sentence) => sentence.idx));
  if (valid.has(value) && value >= fallback) return value;
  const sorted = sentences.map((sentence) => sentence.idx).sort((a, b) => a - b);
  return sorted.find((idx) => idx >= fallback) ?? sorted[sorted.length - 1] ?? 0;
}

function buildDecisionBundleFromSections(sections, sentences) {
  return {
    decisionReport: sections.map((section) => [
      `## ${section.title}`,
      `- 建议：${section.action}`,
      section.body,
    ].filter(Boolean).join('\n')).join('\n\n'),
    chapters: sections.map((section) => {
      const sentence = sentences.find((item) => item.idx === section.startIdx) || sentences[0];
      return {
        startIdx: sentence?.idx ?? 0,
        time: formatDuration(Math.floor(sentence?.startTime || 0)),
        title: section.title,
        desc: '',
      };
    }),
  };
}

function buildFallbackDecisionBundle(sentences) {
  return buildDecisionBundleFromSections(fallbackDecisionSections(sentences), sentences);
}

function fallbackDecisionSections(sentences) {
  const length = sentences.length;
  const idxAt = (minOrder, ratio) => {
    const order = Math.min(length - 1, Math.max(minOrder, Math.floor(length * ratio)));
    return sentences[order]?.idx ?? 0;
  };
  const first = sentences[0]?.text || '这期录音已经完成转写';
  return [
    {
      key: 'overview',
      title: '前情总览',
      action: '保留',
      startIdx: 0,
      body: [
        '### 节目概要',
        '- 播客主：暂不明确',
        '- 嘉宾：暂不明确',
        `- 这期聊了什么：这期录音从“${first.slice(0, 36)}”开始，需要先保留整体脉络。`,
        '- 适合谁听 / 能带走什么：适合想先看清节目结构，再进入逐字稿细修的人。',
        '- 内容侧重：需要结合逐字稿继续判断。',
        '- 高光时刻：进入审查页后，优先找真实故事、情绪变化和观点冲突。',
        '- 最不能删的部分：先保留交代背景、核心矛盾和结论的内容。',
        '- 下次优化：如果某个地方只点到为止，可以追问更具体的故事或例子。',
        '- 建议保留比例：60%-75%',
        '',
        '### 剪辑方案',
        '- 核心主线：先保住这期节目的问题和答案，再删掉重复解释。',
        '- 为什么这么剪：当前 AI 分析没有正常返回，先用稳妥框架兜底，避免用户卡在上传后无法继续。',
        '- 金句开场：进入逐字稿后，从有情绪、有画面感的原话里挑。',
      ].join('\n'),
    },
    {
      key: 'act1',
      title: '第一幕：开场和问题',
      action: '保留',
      startIdx: idxAt(1, 0.08),
      body: [
        '- 这段要做到什么：让听众知道这期为什么值得继续听。',
        '- 听完的感觉：明白背景，也知道接下来会解决什么问题。',
        '- 保留内容：保留能交代背景、抛出问题和建立关系的内容。',
        '- 可压缩/删掉：重复寒暄、没有推进主题的铺垫可以压缩。',
      ].join('\n'),
    },
    {
      key: 'act2',
      title: '第二幕：核心讨论',
      action: '压缩',
      startIdx: idxAt(2, 0.33),
      body: [
        '- 这段要做到什么：让听众听到真正有价值的观点、故事和判断。',
        '- 听完的感觉：觉得这一段有信息量，也有情绪或画面。',
        '- 保留内容：优先保留观点冲突、真实故事和有画面感的细节。',
        '- 可压缩/删掉：重复解释、绕远的铺垫和没有新信息的附和可以压缩。',
      ].join('\n'),
    },
    {
      key: 'act3',
      title: '第三幕：收束和行动',
      action: '保留',
      startIdx: idxAt(3, 0.67),
      body: [
        '- 这段要做到什么：把结论落下来，让听众知道最后该怎么理解或行动。',
        '- 听完的感觉：有收束感，不是突然结束。',
        '- 保留内容：保留最后的判断、行动建议或情绪收束。',
        '- 可压缩/删掉：拖尾闲聊、重复确认和无关补充可以再删。',
      ].join('\n'),
    },
  ];
}

function readAiProxyError(data, status) {
  if (typeof data?.error?.message === 'string' && data.error.message.trim()) return data.error.message;
  if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  return `AI 服务暂时没有正常返回（HTTP ${status}）`;
}

function formatErrorMessage(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message.trim() && error.message !== '[object Object]') return error.message;
  if (typeof error.message === 'object') return formatErrorMessage(error.message);
  if (typeof error.error === 'object') return formatErrorMessage(error.error);
  if (typeof error.error === 'string' && error.error.trim()) return error.error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch (_) {}
  return String(error);
}
