import { apiFetch, apiJson, ensureLoggedIn, getHomeUrl, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

const els = {};
let users = [];
let snapshots = [];
let filter = 'all';
let view = 'users';
let modalUserId = null;

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
    modalMask: document.getElementById('modal-mask'),
    modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'),
    modalClose: document.getElementById('modal-close'),
  });

  setupSessionChrome();
  if (els.homeLink) els.homeLink.href = getHomeUrl();
  bindViews();
  bindFilters();
  bindModal();
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
    if (filter === 'pending') return Number(user.pendingReviewCount || 0) > 0;
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
      <td>${day1Cell(user)}</td>
      <td>${day2Cell(user)}</td>
      <td>${pendingCell(user)}</td>
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
  els.tbody.querySelectorAll('[data-intro]').forEach((button) => {
    button.addEventListener('click', () => openIntroModal(Number(button.dataset.intro)));
  });
  els.tbody.querySelectorAll('[data-snaps]').forEach((button) => {
    button.addEventListener('click', () => openSnapshotsModal(Number(button.dataset.snaps)));
  });
}

function day1Cell(user) {
  if (!user.day1Complete) return '<span class="cell-muted">未完成</span>';
  return `<button class="cell-link" data-intro="${user.id}" type="button">已完成</button>`;
}

function day2Cell(user) {
  const has = user.day2Complete || Number(user.snapshotCount || 0) > 0;
  if (!has) return '<span class="cell-muted">未完成</span>';
  return `<button class="cell-link" data-snaps="${user.id}" type="button">已完成</button>`;
}

function pendingCell(user) {
  const n = Number(user.pendingReviewCount || 0);
  if (n <= 0) return '<span class="pending-zero">—</span>';
  return `<button class="cell-link" data-snaps="${user.id}" type="button"><span class="pending-pill">${n}</span></button>`;
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
  const existing = users.find((item) => item.id === id);
  // 微信列已从界面移除，但数据库字段保留：保存备注时沿用原有微信值，避免被清零
  const wechatAdded = existing ? Boolean(existing.wechatAdded) : false;

  try {
    await apiJson(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ note, wechatAdded }),
    });
    if (existing) {
      existing.note = note;
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

function bindModal() {
  els.modalClose?.addEventListener('click', closeModal);
  els.modalMask?.addEventListener('click', (event) => {
    if (event.target === els.modalMask) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

function openModal(title, html) {
  if (!els.modalMask) return;
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = html;
  els.modalMask.classList.add('open');
}

function closeModal() {
  els.modalMask?.classList.remove('open');
}

function openIntroModal(userId) {
  const user = users.find((item) => item.id === userId);
  if (!user) return;
  const title = `${escapeHtml(user.nickname || user.maskedPhone)} · 自我介绍`;
  const intro = user.day1Intro;
  if (!intro) {
    openModal(title, '<div class="intro-empty">这位学员在新增"留存内容"功能之前完成的作业，系统没有保存当时填写的内容。</div>');
    return;
  }
  const questions = ['你是谁', '为什么加入剪辑营', '第一天最触动你的一点', '你 21 天的目标'];
  const fields = Array.isArray(intro.fields) ? intro.fields : [];
  const body = [
    intro.nickname ? `<div class="intro-q">昵称</div><div class="intro-a">${escapeHtml(intro.nickname)}</div>` : '',
    ...questions.map((q, i) => {
      const a = (fields[i] || '').trim();
      return `<div class="intro-q">${i + 1}. ${q}</div><div class="intro-a">${a ? escapeHtml(a) : '—'}</div>`;
    }),
  ].join('');
  openModal(title, body);
}

async function openSnapshotsModal(userId) {
  modalUserId = userId;
  const user = users.find((item) => item.id === userId);
  const title = `${escapeHtml(user?.nickname || user?.maskedPhone || '学员')} · 剪辑作业`;
  openModal(title, '<div class="intro-empty">加载中…</div>');
  try {
    const data = await apiJson(`/api/admin/users/${userId}/snapshots`);
    renderSnapshotModal(title, data.snapshots || []);
  } catch (error) {
    openModal(title, `<div class="intro-empty">加载失败：${escapeHtml(error.message || String(error))}</div>`);
  }
}

function renderSnapshotModal(title, list) {
  if (!list.length) {
    openModal(title, '<div class="intro-empty">这位学员还没有提交剪辑作业。</div>');
    return;
  }
  const html = list.map((snapshot) => `
    <div class="snap-item">
      <div class="snap-meta">
        ${escapeHtml(snapshot.fileName)} · ${formatDate(snapshot.createdAt)} · ${reviewStatusLabel(snapshot.status)}
        <br>原始 ${formatDuration(snapshot.originalDuration)} / 粗剪 ${formatDuration(snapshot.roughcutDuration)} / 删减 ${formatDuration(snapshot.removedDuration)}
      </div>
      <div class="snap-actions">
        <a class="secondary-btn mini-btn" href="review.html?snapshot=${encodeURIComponent(snapshot.id)}" target="_blank">查看成品</a>
        <button class="secondary-btn mini-btn" data-modal-status="approved" data-modal-id="${escapeAttr(snapshot.id)}" type="button">通过</button>
        <button class="secondary-btn mini-btn" data-modal-status="rejected" data-modal-id="${escapeAttr(snapshot.id)}" type="button">打回</button>
      </div>
    </div>
  `).join('');
  openModal(title, html);
  els.modalBody.querySelectorAll('[data-modal-status]').forEach((button) => {
    button.addEventListener('click', () => onModalReview(button, title));
  });
}

async function onModalReview(button, title) {
  const id = button.dataset.modalId;
  const status = button.dataset.modalStatus;
  if (!id || !status) return;
  try {
    button.disabled = true;
    await apiJson(`/api/admin/snapshots/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadUsers();
    await loadSnapshots();
    // 刷新弹窗里这位学员的快照列表
    if (modalUserId) {
      const data = await apiJson(`/api/admin/users/${modalUserId}/snapshots`).catch(() => null);
      if (data) renderSnapshotModal(title, data.snapshots || []);
    }
    hideError();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    button.disabled = false;
  }
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
