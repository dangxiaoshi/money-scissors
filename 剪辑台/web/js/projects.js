import { apiJson, ensureLoggedIn, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

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
  if (!projects.length) {
    els.list.innerHTML = '<div class="empty-state">还没有项目。上传音频并进入审查页后，这里会自动出现。</div>';
    return;
  }

  els.list.innerHTML = projects.map((project) => `
    <article class="project-card">
      <div>
        <div class="project-title">${escapeHtml(project.fileName)}</div>
        <div class="project-meta">
          <span>更新 ${formatDate(project.updatedAt)}</span>
          <span>原始 ${formatDuration(project.originalDuration)}</span>
          ${project.exportedAt ? `<span>导出 ${formatDate(project.exportedAt)}</span>` : ''}
        </div>
      </div>
      <div>
        <span class="status-pill ${escapeAttr(project.status || 'draft')}">${projectStatusLabel(project.status)}</span>
        <a class="primary-btn inline-btn" href="review.html?project=${encodeURIComponent(project.id)}">打开</a>
      </div>
    </article>
  `).join('');
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
