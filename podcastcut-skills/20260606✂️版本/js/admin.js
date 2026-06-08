import { apiFetch, apiJson, ensureLoggedIn, getHomeUrl, setupSessionChrome } from './api.js?v=20260606-1';

const els = {};
let users = [];
let filter = 'all';

document.addEventListener('DOMContentLoaded', async () => {
  const auth = ensureLoggedIn();
  if (!auth) return;
  if (!auth.user?.isAdmin) {
    location.href = getHomeUrl();
    return;
  }

  Object.assign(els, {
    tbody: document.getElementById('user-table-body'),
    error: document.getElementById('error'),
    filters: Array.from(document.querySelectorAll('[data-filter]')),
    exportBtn: document.getElementById('export-btn'),
    homeLink: document.getElementById('home-link'),
  });

  setupSessionChrome();
  if (els.homeLink) els.homeLink.href = getHomeUrl();
  bindFilters();
  els.exportBtn.addEventListener('click', exportCsv);

  await loadUsers();
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

function bindFilters() {
  els.filters.forEach((button) => {
    button.addEventListener('click', () => {
      filter = button.dataset.filter || 'all';
      els.filters.forEach((item) => item.classList.toggle('active', item === button));
      renderRows();
    });
  });
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
      <td>${formatDate(user.createdAt)}</td>
      <td>${formatDate(user.lastActiveAt)}</td>
      <td>${user.usageCount || 0}</td>
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
