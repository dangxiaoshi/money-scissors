import { apiJson, getLoginUrl, readAuth } from './api.js?v=20260611-tool-pages-1';

const TOOL_LINKS = [
  { id: 'shownotes', name: 'Show Notes 助手', href: '剪辑台shownote.html' },
  { id: 'clip-decision', name: '剪辑决策助手', href: '剪辑台剪辑决策.html' },
  { id: 'narration', name: '旁白生成', href: '剪辑台旁白生成.html' },
  { id: 'voice-clone', name: '当小时声音克隆', href: '剪辑台当小时声音克隆.html', tag: '实验·内部授权' },
];

const config = readConfig();
const state = {
  running: false,
};

boot();

function boot() {
  const auth = readAuth();
  if (!auth) {
    location.href = getScopedLoginUrl();
    return;
  }

  setText('page-label', config.label || 'AI 工具箱');
  setText('page-title', config.title || 'AI 工具');
  setText('page-desc', config.description || '');
  setText('tool-kicker', config.kicker || '金钱剪刀');
  setText('input-label', config.inputLabel || '输入内容');
  setText('output-label', config.outputLabel || '生成结果');
  setText('generate-btn', config.buttonLabel || '生成');

  const textarea = document.getElementById('tool-input');
  if (textarea) {
    textarea.placeholder = config.placeholder || '把素材粘贴到这里。';
    textarea.value = config.example || '';
  }

  renderTabs();
  renderTips();
  setupActions();

  if (config.mode === 'notice') {
    document.body.classList.add('notice-only');
    setText('notice-title', config.noticeTitle || config.title || '暂未开放');
    setText('notice-body', config.noticeBody || '这个工具暂时只对授权账号开放。');
    setText('tool-output', config.noticeOutput || '当前没有可生成内容。');
  } else {
    document.body.classList.remove('notice-only');
  }
}

function readConfig() {
  const node = document.getElementById('tool-config');
  if (!node) return {};
  try {
    return JSON.parse(node.textContent || '{}');
  } catch (error) {
    console.error(error);
    return {};
  }
}

function renderTabs() {
  const tabs = document.getElementById('tool-tabs');
  if (!tabs) return;
  tabs.innerHTML = TOOL_LINKS.map((tool) => {
    const isActive = tool.id === config.id;
    const tag = tool.tag ? `<span>${escapeHtml(tool.tag)}</span>` : '';
    return `<a class="tool-tab ${isActive ? 'active' : ''}" href="${tool.href}">${escapeHtml(tool.name)}${tag}</a>`;
  }).join('');
}

function renderTips() {
  const list = document.getElementById('tool-tips');
  if (!list) return;
  const tips = Array.isArray(config.tips) ? config.tips : [];
  list.innerHTML = tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join('');
  list.hidden = tips.length === 0;
}

function setupActions() {
  const generateBtn = document.getElementById('generate-btn');
  const copyBtn = document.getElementById('copy-btn');
  const textarea = document.getElementById('tool-input');

  if (generateBtn) generateBtn.addEventListener('click', generate);
  if (copyBtn) copyBtn.addEventListener('click', copyOutput);
  if (textarea) {
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') generate();
    });
  }
}

async function generate() {
  if (state.running || config.mode === 'notice') return;

  const input = document.getElementById('tool-input')?.value.trim() || '';
  if (!input) {
    showError(config.emptyMessage || '请先粘贴内容。');
    return;
  }

  const output = document.getElementById('tool-output');
  const button = document.getElementById('generate-btn');
  const controller = new AbortController();
  const timeoutMs = Number(config.timeoutMs || 70000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  state.running = true;
  clearError();
  if (output) output.textContent = config.loadingText || '正在生成...';
  if (button) button.disabled = true;

  try {
    const data = await apiJson('/api/deepseek/chat', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: [
              config.systemPrompt || '你是金钱剪刀的播客剪辑助手。',
              '只输出 JSON，格式必须是 {"result":"完整中文结果"}。',
              'result 里可以使用清晰的小标题和换行，但不要输出代码块。',
            ].join('\n\n'),
          },
          { role: 'user', content: input },
        ],
        response_format: { type: 'json_object' },
        max_tokens: Number(config.maxTokens || 4096),
      }),
    });

    const content = data?.choices?.[0]?.message?.content || '';
    const result = readModelResult(content);
    if (output) output.textContent = result || '没有生成结果，请重试。';
  } catch (error) {
    if (output) output.textContent = '';
    showError(readFriendlyError(error));
  } finally {
    clearTimeout(timer);
    state.running = false;
    if (button) button.disabled = false;
  }
}

function readModelResult(content) {
  const text = String(content || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.result === 'string') return parsed.result.trim();
  } catch (_) {
    return text;
  }
  return text;
}

async function copyOutput() {
  const copyBtn = document.getElementById('copy-btn');
  const value = document.getElementById('tool-output')?.textContent || '';
  if (!value.trim()) {
    showError('还没有可复制的结果。');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    if (copyBtn) {
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制结果'; }, 1200);
    }
  } catch {
    showError('复制失败，可以手动选中结果复制。');
  }
}

function readFriendlyError(error) {
  if (error?.name === 'AbortError') return 'AI 服务等待超时，请稍后重试。你输入的内容还在，可以直接再点一次生成。';
  const message = String(error?.message || error || '').trim();
  if (/timeout|超时|504/i.test(message)) return 'AI 服务等待超时，请稍后重试。';
  if (/missing_deepseek_key|未配置/i.test(message)) return 'AI 服务还没有配置好，请联系助教。';
  return message || 'AI 服务繁忙，请稍后重试。';
}

function showError(message) {
  const error = document.getElementById('error');
  if (!error) return;
  error.textContent = message;
  error.classList.add('visible');
}

function clearError() {
  const error = document.getElementById('error');
  if (!error) return;
  error.textContent = '';
  error.classList.remove('visible');
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value || '';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function getScopedLoginUrl() {
  const next = `${location.pathname}${location.search}`;
  if (location.pathname.startsWith('/web-test/')) {
    return `login.html?next=${encodeURIComponent(next)}`;
  }
  return getLoginUrl(next);
}
