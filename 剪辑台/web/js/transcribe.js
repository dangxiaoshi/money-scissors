import { DASHSCOPE_PROXY_URL } from './config.js?v=20260606-2';
import { getAuthHeaders } from './api.js?v=20260610-reviewflow-1';

export async function transcribeWithFunASR(audioSource, speakerCount, { onStatus } = {}) {
  if (!DASHSCOPE_PROXY_URL) {
    throw new Error('DashScope 代理未配置，请联系管理员。');
  }

  const source = normalizeAudioSource(audioSource);
  onStatus?.('正在提交转录任务');
  const submitData = await submitTask(source, speakerCount);
  const taskId = submitData.output?.task_id;
  if (!taskId) {
    throw new Error(`阿里云未返回 task_id：${JSON.stringify(submitData)}`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 25 * 60 * 1000) {
    await sleep(5000);
    const data = await queryTask(taskId);
    const status = data.output?.task_status;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    onStatus?.(`转录中，已等待 ${formatElapsed(elapsed)}`);

    if (status === 'SUCCEEDED') {
      const url = data.output?.results?.[0]?.transcription_url;
      if (!url) throw new Error(`转录成功但缺少 transcription_url：${JSON.stringify(data)}`);
      onStatus?.('正在下载转录结果');
      return fetchTranscriptionResult(url);
    }

    if (status === 'FAILED') {
      console.error('[transcribe] DashScope task failed', data);
      throw new Error(formatTranscriptionFailure(data));
    }
  }

  throw new Error('阿里云转录超时：已等待 25 分钟。你可以重新开始；如果这段音频很长，建议先拆短一点再上传。');
}

function normalizeAudioSource(source) {
  if (source && typeof source === 'object') {
    return {
      audioUrl: source.audioUrl || source.url || '',
      storage: source.storage || '',
      objectKey: source.objectKey || '',
    };
  }
  return { audioUrl: String(source || ''), storage: '', objectKey: '' };
}

function formatTranscriptionFailure(data) {
  const taskId = data?.output?.task_id || data?.request_id || '';
  const suffix = taskId ? `（错误编号：${taskId}）` : '';
  if (isAccountStatusError(data)) {
    return `音频导入服务暂时不可用，是平台转录服务账户状态异常，不是你的电脑或素材问题。请联系助教处理，稍后再试。${suffix}`;
  }
  return `音频导入失败，可能是素材地址临时不可用或阿里云没有拉到音频。请先重试一次；如果还失败，先下载音频后手动上传。${suffix}`;
}

function formatProxyFailure(action, status, data) {
  const requestId = data?.request_id || data?.requestId || data?.output?.task_id || '';
  const suffix = requestId ? `（错误编号：${requestId}）` : '';
  if (isAccountStatusError(data)) {
    return `音频导入服务暂时不可用，是平台转录服务账户状态异常，不是你的电脑或素材问题。请联系助教处理，稍后再试。${suffix}`;
  }
  if (status === 401 || status === 403) {
    return `音频导入服务权限暂时异常，请联系助教处理。${suffix}`;
  }
  if (status === 429) {
    return `音频导入服务当前请求太多，请等 1 分钟后再试。${suffix}`;
  }
  return `${action}失败，请先重试一次；如果还失败，把这条错误编号发给助教。${suffix}`;
}

function isAccountStatusError(data) {
  const code = String(data?.code || data?.type || data?.error || '').toLowerCase();
  const message = String(data?.message || data?.error_message || '').toLowerCase();
  return code.includes('arrearage')
    || message.includes('arrearage')
    || message.includes('good standing')
    || message.includes('overdue-payment');
}

async function submitTask(source, speakerCount) {
  if (DASHSCOPE_PROXY_URL) {
    const body = {
      audioUrl: source.audioUrl,
      speakerCount,
    };
    if (source.storage) body.storage = source.storage;
    if (source.objectKey) body.objectKey = source.objectKey;
    const resp = await fetchProxy(`${DASHSCOPE_PROXY_URL.replace(/\/+$/g, '')}/transcription`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json', 'x-proxy-check': 'money-scissors' }),
      body: JSON.stringify(body),
    }, '提交阿里云转录');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[transcribe] DashScope submit failed', { status: resp.status, data });
      throw new Error(formatProxyFailure('提交音频导入任务', resp.status, data));
    }
    return data;
  }

  throw new Error('浏览器直连 DashScope 已关闭，请使用服务器代理。');
}

async function queryTask(taskId) {
  if (DASHSCOPE_PROXY_URL) {
    const resp = await fetchProxy(`${DASHSCOPE_PROXY_URL.replace(/\/+$/g, '')}/tasks/${encodeURIComponent(taskId)}`, {
      headers: getAuthHeaders({ 'x-proxy-check': 'money-scissors' }),
    }, '查询阿里云转录任务');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[transcribe] DashScope query failed', { status: resp.status, data });
      throw new Error(formatProxyFailure('查询音频导入进度', resp.status, data));
    }
    return data;
  }

  throw new Error('浏览器直连 DashScope 已关闭，请使用服务器代理。');
}

async function fetchTranscriptionResult(url) {
  if (DASHSCOPE_PROXY_URL) {
    const resp = await fetchProxy(`${DASHSCOPE_PROXY_URL.replace(/\/+$/g, '')}/result?url=${encodeURIComponent(url)}`, {
      headers: getAuthHeaders({ 'x-proxy-check': 'money-scissors' }),
    }, '下载转录结果');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[transcribe] DashScope result download failed', { status: resp.status, data });
      throw new Error(formatProxyFailure('读取音频导入结果', resp.status, data));
    }
    return data;
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载转录结果失败：HTTP ${resp.status}`);
  return resp.json();
}

async function fetchProxy(url, options, label) {
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new Error(`${label}失败：浏览器连不上本地 DashScope 代理 ${url}。请确认 node web/dev-dashscope-proxy.cjs 正在运行后刷新重试。原始错误：${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
