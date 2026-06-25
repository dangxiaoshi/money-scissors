import { DASHSCOPE_PROXY_URL } from './config.js?v=20260606-2';
import { getAuthHeaders } from './api.js?v=20260606-1';

export async function transcribeWithFunASR(audioUrl, speakerCount, { onStatus } = {}) {
  if (!DASHSCOPE_PROXY_URL) {
    throw new Error('DashScope 代理未配置，请联系管理员。');
  }

  onStatus?.('正在提交转录任务');
  const submitData = await submitTask(audioUrl, speakerCount);
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
      throw new Error(`阿里云转录失败：${JSON.stringify(data)}`);
    }
  }

  throw new Error('阿里云转录超时：已等待 25 分钟');
}

async function submitTask(audioUrl, speakerCount) {
  if (DASHSCOPE_PROXY_URL) {
    const resp = await fetchProxy(`${DASHSCOPE_PROXY_URL.replace(/\/+$/g, '')}/transcription`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json', 'x-proxy-check': 'money-scissors' }),
      body: JSON.stringify({ audioUrl, speakerCount }),
    }, '提交阿里云转录');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(`代理提交阿里云转录失败：HTTP ${resp.status} ${JSON.stringify(data)}`);
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
      throw new Error(`代理查询阿里云转录任务失败：HTTP ${resp.status} ${JSON.stringify(data)}`);
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
      throw new Error(`代理下载转录结果失败：HTTP ${resp.status} ${JSON.stringify(data)}`);
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
