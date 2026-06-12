import { apiFetch, apiJson, ensureLoggedIn, getHomeUrl, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

const els = {};
let users = [];
let snapshots = [];
let filter = 'all';
let view = 'users';

document.addEventListener('DOMContentLoaded', async () => {
  const auth = ensureLoggedIn();
  if (!auth) return;
  if (!auth.user?.isAdmin) {
    location.href = getHomeUrl();
    return;
  }

  Object.assign(els, {
    tbody: document.getElementById('user-table-body'),
    snapshotTbody: document.getElementById('snapshot-table-body'),
    error: document.getElementById('error'),
    filters: Array.from(document.querySelectorAll('[data-filter]')),
    views: Array.from(document.querySelectorAll('[data-view]')),
    exportBtn: document.getElementById('export-btn'),
    homeLink: document.getElementById('home-link'),
    usersPanel: document.getElementById('users-panel'),
    snapshotsPanel: document.getElementById('snapshots-panel'),
    userFilterRow: document.getElementById('user-filter-row'),
  });

  setupSessionChrome();
  if (els.homeLink) els.homeLink.href = getHomeUrl();
  bindViews();
  bindFilters();
  els.exportBtn.addEventListener('click', exportCsv);

  await loadUsers();
  await loadSnapshots();
});

async function loadUsers() {
  try {
    const data = await apiJson('/api/admin/users');
    users = data.users || [];
    renderRows();
  } catch (error) {
    showError(error.message || String(error));
  }
}

async function loadSnapshots() {
  try {
    const data = await apiJson('/api/admin/snapshots');
    snapshots = data.snapshots || [];
    renderSnapshots();
  } catch (error) {
    showError(error.message || String(error));
  }
}

function bindViews() {
  els.views.forEach((button) => {
    button.addEventListener('click', () => {
      view = button.dataset.view || 'users';
      els.views.forEach((item) => item.classList.toggle('active', item === button));
      renderView();
    });
  });
}

function bindFilters() {
  els.filters.forEach((button) => {
    button.addEventListener('click', () => {
      filter = button.dataset.filter || 'all';
      els.filters.forEach((item) => item.classList.toggle('active', item === button));
      renderRows();
    });
  });
}

function renderView() {
  const isSnapshots = view === 'snapshots';
  els.usersPanel.hidden = isSnapshots;
  els.snapshotsPanel.hidden = !isSnapshots;
  els.userFilterRow.hidden = isSnapshots;
  els.exportBtn.hidden = isSnapshots;
  if (isSnapshots) renderSnapshots();
  else renderRows();
}

function renderRows() {
  const list = users.filter((user) => {
    if (filter === 'wechat_yes') return user.wechatAdded;
    if (filter === 'wechat_no') return !user.wechatAdded;
    if (filter === 'used_3') return Number(user.usageCount || 0) >= 3;
    return true;
  });

  els.tbody.innerHTML = list.map((user) => `
    <tr data-id="${user.id}">
      <td>${user.maskedPhone}</td>
      <td>${escapeHtml(user.nickname || '-')}</td>
      <td>${formatDate(user.createdAt)}</td>
      <td>${formatDate(user.lastActiveAt)}</td>
      <td>${user.usageCount || 0}</td>
      <td>${user.day1Complete ? '已完成' : '未完成'}</td>
      <td>
        <label class="checkbox-cell">
          <input type="checkbox" data-wechat ${user.wechatAdded ? 'checked' : ''}>
          <span>${user.wechatAdded ? '已加' : '未加'}</span>
        </label>
      </td>
      <td>
        <input class="table-input" data-note value="${escapeAttr(user.note || '')}" placeholder="备注">
      </td>
      <td>
        <button class="secondary-btn mini-btn" data-save>保存</button>
      </td>
    </tr>
  `).join('');

  els.tbody.querySelectorAll('[data-save]').forEach((button) => {
    button.addEventListener('click', onSave);
  });
}

function renderSnapshots() {
  if (!snapshots.length) {
    els.snapshotTbody.innerHTML = '<tr><td colspan="8">还没有审核快照。</td></tr>';
    return;
  }
  els.snapshotTbody.innerHTML = snapshots.map((snapshot) => `
    <tr>
      <td>${escapeHtml(snapshot.fileName)}</td>
      <td>${escapeHtml(snapshot.editorPhone || '-')}</td>
      <td>${formatDate(snapshot.createdAt)}</td>
      <td>${reviewStatusLabel(snapshot.status)}</td>
      <td>${formatDuration(snapshot.originalDuration)}</td>
      <td>${formatDuration(snapshot.roughcutDuration)}</td>
      <td>${formatDuration(snapshot.removedDuration)}</td>
      <td>
        <a class="secondary-btn mini-btn" href="review.html?snapshot=${encodeURIComponent(snapshot.id)}">查看</a>
        <button class="secondary-btn mini-btn" data-snapshot-status="approved" data-snapshot-id="${escapeAttr(snapshot.id)}" type="button">通过</button>
        <button class="secondary-btn mini-btn" data-snapshot-status="rejected" data-snapshot-id="${escapeAttr(snapshot.id)}" type="button">打回</button>
      </td>
    </tr>
  `).join('');
  els.snapshotTbody.querySelectorAll('[data-snapshot-status]').forEach((button) => {
    button.addEventListener('click', onReviewSnapshot);
  });
}

async function onReviewSnapshot(event) {
  const button = event.currentTarget;
  const id = button.dataset.snapshotId;
  const status = button.dataset.snapshotStatus;
  if (!id || !status) return;

  try {
    button.disabled = true;
    await apiJson(`/api/admin/snapshots/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadSnapshots();
    hideError();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    button.disabled = false;
  }
}

async function onSave(event) {
  const row = event.currentTarget.closest('tr');
  const id = Number(row?.dataset.id);
  if (!id) return;

  const note = row.querySelector('[data-note]')?.value || '';
  const wechatAdded = row.querySelector('[data-wechat]')?.checked || false;

  try {
    await apiJson(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ note, wechatAdded }),
    });
    const user = users.find((item) => item.id === id);
    if (user) {
      user.note = note;
      user.wechatAdded = wechatAdded;
    }
    hideError();
  } catch (error) {
    showError(error.message || String(error));
  }
}

async function exportCsv() {
  try {
    const response = await apiFetch('/api/admin/users.csv');
    if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'money-scissors-users.csv';
    a.click();
    URL.revokeObjectURL(url);
    hideError();
  } catch (error) {
    showError(error.message || String(error));
  }
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

function reviewStatusLabel(status) {
  const labels = {
    pending_review: '待审核',
    approved: '已通过',
    rejected: '已打回',
    exported: '已导出',
    draft: '剪辑中',
  };
  return labels[status] || labels.pending_review;
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.add('visible');
}

function hideError() {
  els.error.textContent = '';
  els.error.classList.remove('visible');
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
