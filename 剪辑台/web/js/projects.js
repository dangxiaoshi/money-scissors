import { apiJson, ensureLoggedIn, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

const PRACTICE_PROJECT = {
  fileName: 'D2 练习项目｜开营直播',
  status: 'draft',
  originalDuration: 3008,
  practiceKey: 'launch',
  meta: '练习目标：剪到 25-30 分钟',
};

const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  const auth = ensureLoggedIn();
  if (!auth) return;

  Object.assign(els, {
    list: document.getElementById('project-list'),
    error: document.getElementById('error'),
  });

  setupSessionChrome();
  await loadProjects();
});

async function loadProjects() {
  try {
    const data = await apiJson('/api/projects');
    renderProjects(data.projects || []);
  } catch (error) {
    showError(error.message || String(error));
  }
}

function renderProjects(projects) {
  const visibleProjects = Array.isArray(projects) ? projects : [];
  const hasPractice = visibleProjects.some((project) => String(project.fileName || '').includes('开营直播'));
  const rows = hasPractice ? visibleProjects : [PRACTICE_PROJECT, ...visibleProjects];

  if (!rows.length) {
    els.list.innerHTML = '<div class="empty-state">还没有项目。上传音频并进入审查页后，这里会自动出现。</div>';
    return;
  }

  els.list.innerHTML = rows.map((project) => `
    <article class="project-card">
      <div>
        <div class="project-title">${escapeHtml(project.fileName)}</div>
        <div class="project-meta">
          ${project.meta ? `<span>${escapeHtml(project.meta)}</span>` : `<span>更新 ${formatDate(project.updatedAt)}</span>`}
          <span>原始 ${formatDuration(project.originalDuration)}</span>
          ${project.exportedAt ? `<span>导出 ${formatDate(project.exportedAt)}</span>` : ''}
        </div>
      </div>
      <div>
        <span class="status-pill ${escapeAttr(project.status || 'draft')}">${projectStatusLabel(project.status)}</span>
        ${project.practiceKey
          ? `<button class="primary-btn inline-btn" type="button" data-practice-key="${escapeAttr(project.practiceKey)}">打开</button>`
          : `<a class="primary-btn inline-btn" href="${escapeAttr(`review.html?project=${encodeURIComponent(project.id)}`)}">打开</a>`}
      </div>
    </article>
  `).join('');

  els.list.querySelectorAll('[data-practice-key]').forEach((button) => {
    button.addEventListener('click', () => launchPracticeProject(button));
  });
}

async function launchPracticeProject(button) {
  const key = button.dataset.practiceKey || 'launch';
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '正在打开…';
  hideError();

  try {
    const data = await apiJson(`/api/projects/practice/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: '{}',
    });
    const projectId = data?.project?.id;
    if (!projectId) throw new Error('练习项目没有打开成功，请刷新后再试。');
    location.href = `review.html?project=${encodeURIComponent(projectId)}`;
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    showError(error.message || String(error));
  }
}

function projectStatusLabel(status) {
  const labels = {
    draft: '剪辑中',
    pending_review: '待助教审核',
    approved: '助教已通过',
    rejected: '助教已打回',
    exported: '已导出',
  };
  return labels[status] || labels.draft;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.add('visible');
}

function hideError() {
  els.error.textContent = '';
  els.error.classList.remove('visible');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
