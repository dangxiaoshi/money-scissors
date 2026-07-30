import { apiFetch, apiJson, ensureLoggedIn, getHomeUrl, setupSessionChrome } from './api.js?v=20260610-reviewflow-1';

/* ===== 功能开关（盖盖子，2026-06-14）=====
   SHOW_AI_REVIEW：后台学员作业行里的「AI批改」按钮。代码不删，想恢复改成 true 即可。 */
const SHOW_AI_REVIEW = false;

const els = {};
let users = [];
let snapshots = [];
let feedbackReports = [];
let downloadHealth = null;
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
    feedbackCopyBtn: document.getElementById('feedback-copy-btn'),
    homeLink: document.getElementById('home-link'),
    usersPanel: document.getElementById('users-panel'),
    snapshotsPanel: document.getElementById('snapshots-panel'),
    feedbackPanel: document.getElementById('feedback-panel'),
    downloadHealthPanel: document.getElementById('download-health-panel'),
    feedbackSummary: document.getElementById('feedback-summary'),
    feedbackDigest: document.getElementById('feedback-digest'),
    feedbackTbody: document.getElementById('feedback-table-body'),
    downloadHealthSummary: document.getElementById('download-health-summary'),
    downloadHealthStrip: document.getElementById('download-health-strip'),
    downloadHealthTbody: document.getElementById('download-health-table-body'),
    downloadHealthRefresh: document.getElementById('download-health-refresh'),
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
  els.feedbackCopyBtn?.addEventListener('click', copyFeedbackDigest);
  els.downloadHealthRefresh?.addEventListener('click', loadDownloadHealth);

  await loadUsers();
  await loadSnapshots();
  await loadFeedbackReports();
  await loadDownloadHealth();
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

async function loadFeedbackReports() {
  try {
    const data = await apiJson('/api/admin/feedback/reports?limit=200');
    feedbackReports = data.reports || [];
    renderFeedbackReports();
  } catch (error) {
    showError(error.message || String(error));
  }
}

async function loadDownloadHealth() {
  try {
    const data = await apiJson('/api/admin/download-health?hours=24&limit=30');
    downloadHealth = data;
    renderDownloadHealth();
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
  const isFeedback = view === 'feedback';
  const isDownloadHealth = view === 'downloadHealth';
  els.usersPanel.hidden = isSnapshots || isFeedback || isDownloadHealth;
  els.snapshotsPanel.hidden = !isSnapshots;
  els.feedbackPanel.hidden = !isFeedback;
  els.downloadHealthPanel.hidden = !isDownloadHealth;
  els.userFilterRow.hidden = isSnapshots || isFeedback || isDownloadHealth;
  els.exportBtn.hidden = isSnapshots || isFeedback || isDownloadHealth;
  if (els.feedbackCopyBtn) els.feedbackCopyBtn.hidden = !isFeedback;
  if (isSnapshots) renderSnapshots();
  else if (isFeedback) renderFeedbackReports();
  else if (isDownloadHealth) renderDownloadHealth();
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
      <td>${pdcaCell(user)}</td>
      <td>${resumeCell(user)}</td>
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
  els.tbody.querySelectorAll('[data-pdca]').forEach((button) => {
    button.addEventListener('click', () => openPdcaModal(Number(button.dataset.pdca)));
  });
  els.tbody.querySelectorAll('[data-resume]').forEach((button) => {
    button.addEventListener('click', () => openResumeModal(Number(button.dataset.resume)));
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

function pdcaCell(user) {
  if (!user.pdcaHomework) return '<span class="cell-muted">未交</span>';
  return `<button class="cell-link" data-pdca="${user.id}" type="button">已提交</button>`;
}

function resumeCell(user) {
  if (!user.resumeHomework) return '<span class="cell-muted">未交</span>';
  return `<button class="cell-link" data-resume="${user.id}" type="button">已提交</button>`;
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
        ${SHOW_AI_REVIEW ? `<button class="secondary-btn mini-btn" data-ai-review data-snapshot-id="${escapeAttr(snapshot.id)}" type="button">AI批改</button>` : ''}
        <button class="secondary-btn mini-btn" data-snapshot-status="approved" data-snapshot-id="${escapeAttr(snapshot.id)}" type="button">通过</button>
        <button class="secondary-btn mini-btn" data-snapshot-status="rejected" data-snapshot-id="${escapeAttr(snapshot.id)}" type="button">打回</button>
      </td>
    </tr>
  `).join('');
  els.snapshotTbody.querySelectorAll('[data-snapshot-status]').forEach((button) => {
    button.addEventListener('click', onReviewSnapshot);
  });
  els.snapshotTbody.querySelectorAll('[data-ai-review]').forEach((button) => {
    button.addEventListener('click', () => onAiReview(button));
  });
}

function renderFeedbackReports() {
  renderFeedbackSummary();
  if (!feedbackReports.length) {
    els.feedbackTbody.innerHTML = '<tr><td colspan="5">还没有学员提交问题反馈。</td></tr>';
    return;
  }
  els.feedbackTbody.innerHTML = feedbackReports.map((report) => {
    const sourceUrl = safeFeedbackSourceUrl(report.pageUrl || report.context?.currentUrl || '');
    const sourceLink = sourceUrl ? `<a class="cell-link" href="${escapeAttr(sourceUrl)}" target="_blank">打开页面</a>` : '<span class="cell-muted">—</span>';
    return `
      <tr data-feedback-id="${escapeAttr(report.id)}">
        <td>
          <div class="feedback-title">${escapeHtml(report.title || '(未写标题)')}</div>
          <div class="feedback-desc">${escapeHtml(report.description || '—')}</div>
          <div class="feedback-meta">${escapeHtml(formatDate(report.createdAt))}${report.severity === 'blocking' ? ' · 卡住了' : ''}</div>
        </td>
        <td>
          <div>${escapeHtml(stationLabel(report.station))} · ${escapeHtml(report.page || '未填写')}</div>
          <div class="feedback-meta">
            ${report.projectId ? `项目 ${escapeHtml(report.projectId)}<br>` : ''}
            ${report.dispatchTaskId ? `订单 #${escapeHtml(report.dispatchTaskId)}<br>` : ''}
            ${sourceLink}
          </div>
        </td>
        <td>
          <div>${escapeHtml(report.userName || report.userPhone || '-')}</div>
          <div class="feedback-meta">${report.userPhone ? escapeHtml(report.userPhone) : ''}</div>
        </td>
        <td><span class="feedback-status ${escapeAttr(report.status)}">${escapeHtml(feedbackStatusLabel(report.status))}</span></td>
        <td>
          <div class="feedback-actions">
            ${feedbackActionButtons(report)}
          </div>
          <input class="table-input feedback-note" data-feedback-note value="${escapeAttr(report.adminNote || '')}" placeholder="处理备注">
        </td>
      </tr>
    `;
  }).join('');
  els.feedbackTbody.querySelectorAll('[data-feedback-status]').forEach((button) => {
    button.addEventListener('click', () => updateFeedbackStatus(button));
  });
}

function renderDownloadHealth() {
  if (!downloadHealth) {
    if (els.downloadHealthSummary) els.downloadHealthSummary.innerHTML = '';
    if (els.downloadHealthStrip) els.downloadHealthStrip.textContent = '导出健康数据还没有加载。';
    if (els.downloadHealthTbody) els.downloadHealthTbody.innerHTML = '<tr><td colspan="6">加载中。</td></tr>';
    return;
  }
  const summary = downloadHealth.summary || {};
  const cutQueue = downloadHealth.cutQueue || {};
  const refineQueue = downloadHealth.refineQueue || {};
  const cards = [
    ['成功任务', summary.readyJobs ?? 0],
    ['失败任务', summary.failedJobs ?? 0],
    ['成功率', summary.successRate == null ? '—' : `${summary.successRate}%`],
    ['粗剪队列', `${cutQueue.activeJobs || 0}/${cutQueue.queuedJobs || 0}`],
    ['精修处理中', refineQueue.activeJobs || 0],
  ];
  els.downloadHealthSummary.innerHTML = cards.map(([label, value]) => `
    <div class="health-card">
      <div class="health-num">${escapeHtml(value)}</div>
      <div class="health-label">${escapeHtml(label)}</div>
    </div>
  `).join('');

  const sentinel = downloadHealth.sentinel;
  const processInfo = downloadHealth.process || {};
  const sentinelText = sentinel
    ? `<span class="${sentinel.status === 'pass' ? 'health-ok' : 'health-warn'}">${escapeHtml(sentinel.status === 'pass' ? '巡检通过' : '巡检失败')}</span> · ${escapeHtml(formatDate(sentinel.finishedAt || sentinel.startedAt))} · ${escapeHtml(sentinel.summary || '')}`
    : '<span class="health-warn">还没有定时巡检结果</span>';
  els.downloadHealthStrip.innerHTML = [
    `窗口：最近 ${escapeHtml(downloadHealth.windowHours || 24)} 小时`,
    `巡检：${sentinelText}`,
    `服务：启动于 ${escapeHtml(formatDate(processInfo.startedAt))}，已运行 ${escapeHtml(formatUptime(processInfo.uptimeSeconds || 0))}，内存 ${escapeHtml(processInfo.memoryMb || 0)} MB`,
    `精修：启动 ${escapeHtml(summary.refineStarted || 0)}，完成 ${escapeHtml(summary.refineDone || 0)}，失败 ${escapeHtml(summary.refineFailed || 0)}，降级粗剪 ${escapeHtml(summary.fallbackCount || 0)}`,
    `参数校验类失败：${escapeHtml(summary.validationFailedJobs || 0)} 个，不计入系统失败率`,
  ].join('<br>');

  const rows = (downloadHealth.recentFailures && downloadHealth.recentFailures.length)
    ? downloadHealth.recentFailures
    : (downloadHealth.recentEvents || []);
  if (!rows.length) {
    els.downloadHealthTbody.innerHTML = '<tr><td colspan="6">最近 24 小时还没有导出事件。</td></tr>';
    return;
  }
  els.downloadHealthTbody.innerHTML = rows.map((event) => `
    <tr>
      <td>${escapeHtml(formatDate(event.createdAt))}</td>
      <td>${escapeHtml(event.userName || event.userPhone || '-')}</td>
      <td>
        <div>${escapeHtml(downloadEventLabel(event.eventType))}</div>
        <div class="mono-small">${escapeHtml(event.jobId || event.refineJobId || '')}</div>
      </td>
      <td>${escapeHtml(event.stage || event.status || '-')}</td>
      <td>${escapeHtml(event.message || '-')}</td>
      <td>${escapeHtml(event.browser || '-')}</td>
    </tr>
  `).join('');
}

function downloadEventLabel(value) {
  return {
    created: '任务创建',
    queued: '进入队列',
    downloading: '读取原音频',
    processing: '生成 MP3',
    uploading: '保存文件',
    ready: '粗剪就绪',
    download_clicked: '点击下载',
    download_redirect: 'OSS 跳转',
    download_started: '开始下载',
    failed: '导出失败',
    refine_started: '精修开始',
    refine_status: '精修状态',
    refine_done: '精修完成',
    refine_failed: '精修失败',
    fallback_to_roughcut: '降级粗剪',
  }[value] || value || '未知事件';
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}天${hours}小时`;
  if (hours) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function renderFeedbackSummary() {
  const today = feedbackReports.filter((report) => isToday(report.createdAt));
  const openToday = today.filter((report) => report.status === 'open');
  const blockingToday = today.filter((report) => report.severity === 'blocking');
  const resolvedToday = today.filter((report) => report.status === 'resolved');
  els.feedbackSummary.innerHTML = [
    ['今日反馈', today.length],
    ['今日待处理', openToday.length],
    ['今日卡住', blockingToday.length],
    ['今日解决', resolvedToday.length],
  ].map(([label, value]) => `
    <div class="feedback-card">
      <div class="feedback-num">${value}</div>
      <div class="feedback-label">${label}</div>
    </div>
  `).join('');
  els.feedbackDigest.innerHTML = `<div class="feedback-title">今日晨报</div>${escapeHtml(buildFeedbackDigestText()).replace(/\n/g, '<br>')}`;
}

function feedbackActionButtons(report) {
  const id = escapeAttr(report.id);
  const buttons = [];
  if (report.status !== 'triaged') buttons.push(`<button class="secondary-btn mini-btn" data-feedback-status="triaged" data-feedback-id="${id}" type="button">处理中</button>`);
  if (report.status !== 'resolved') buttons.push(`<button class="secondary-btn mini-btn" data-feedback-status="resolved" data-feedback-id="${id}" type="button">解决</button>`);
  if (report.status !== 'ignored') buttons.push(`<button class="secondary-btn mini-btn" data-feedback-status="ignored" data-feedback-id="${id}" type="button">忽略</button>`);
  if (report.status !== 'open') buttons.push(`<button class="secondary-btn mini-btn" data-feedback-status="open" data-feedback-id="${id}" type="button">重开</button>`);
  return buttons.join('');
}

async function updateFeedbackStatus(button) {
  const id = button.dataset.feedbackId;
  const status = button.dataset.feedbackStatus;
  const row = button.closest('tr');
  const adminNote = row?.querySelector('[data-feedback-note]')?.value || '';
  if (!id || !status) return;
  try {
    button.disabled = true;
    await apiJson(`/api/admin/feedback/reports/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, adminNote }),
    });
    await loadFeedbackReports();
    hideError();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    button.disabled = false;
  }
}

function buildFeedbackDigestText() {
  const today = feedbackReports.filter((report) => isToday(report.createdAt));
  if (!today.length) return '今天暂时没有新的问题反馈。';
  const blocking = today.filter((report) => report.severity === 'blocking');
  const open = today.filter((report) => report.status === 'open');
  const byStation = topCounts(today.map((report) => stationLabel(report.station))).slice(0, 3);
  const topPages = topCounts(today.map((report) => report.page || '未填页面')).slice(0, 3);
  const lines = [
    `今天新增 ${today.length} 条反馈，其中 ${blocking.length} 条卡住了，${open.length} 条还待处理。`,
    byStation.length ? `集中位置：${byStation.map(([name, count]) => `${name} ${count}条`).join('、')}。` : '',
    topPages.length ? `高频页面/步骤：${topPages.map(([name, count]) => `${name} ${count}条`).join('、')}。` : '',
  ].filter(Boolean);
  const urgent = today
    .filter((report) => report.status === 'open' || report.severity === 'blocking')
    .slice(0, 5);
  if (urgent.length) {
    lines.push('优先看：');
    urgent.forEach((report, index) => {
      const label = report.severity === 'blocking' ? '卡住' : feedbackStatusLabel(report.status);
      lines.push(`${index + 1}. [${label}] ${stationLabel(report.station)} / ${report.page || '未填页面'}：${report.title || report.description || '未写标题'}`);
    });
  }
  return lines.join('\n');
}

function copyFeedbackDigest() {
  const text = buildFeedbackDigestText();
  const copy = navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error('clipboard_unavailable'));
  copy
    .then(() => {
      if (els.feedbackCopyBtn) els.feedbackCopyBtn.textContent = '已复制';
      setTimeout(() => { if (els.feedbackCopyBtn) els.feedbackCopyBtn.textContent = '复制今日晨报'; }, 1200);
    })
    .catch(() => showError('复制失败，请手动选中今日晨报。'));
}

function topCounts(values) {
  const counts = new Map();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

function isToday(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function stationLabel(value) {
  return {
    training: '训练台',
    editor: '剪辑台',
    orders: '接单台',
    login: '登录',
    other: '其他',
  }[value] || '其他';
}

function feedbackStatusLabel(value) {
  return {
    open: '待处理',
    triaged: '处理中',
    resolved: '已解决',
    ignored: '已忽略',
  }[value] || '待处理';
}

function safeFeedbackSourceUrl(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('/') || text.startsWith('//')) return '';
  return text.slice(0, 500);
}

async function onAiReview(button) {
  const id = button.dataset.snapshotId;
  if (!id) return;
  openModal('AI 批改草稿', '<div class="intro-empty">AI 正在批改，请稍候…（约 10-30 秒）</div>');
  try {
    const resp = await apiJson(`/api/admin/snapshots/${encodeURIComponent(id)}/ai-review`, { method: 'POST' });
    const content = resp?.choices?.[0]?.message?.content || '';
    let draft = null;
    try { draft = JSON.parse(content); } catch { draft = null; }
    if (!draft || typeof draft !== 'object') {
      openModal('AI 批改草稿', `<div class="intro-empty">AI 返回内容无法解析，请重试。<br><br>原文片段：${escapeHtml(content).slice(0, 400)}</div>`);
      return;
    }
    renderAiReviewDraft(draft);
  } catch (error) {
    openModal('AI 批改草稿', `<div class="intro-empty">AI 批改失败：${escapeHtml(error.message || String(error))}</div>`);
  }
}

function renderAiReviewDraft(draft) {
  const issues = Array.isArray(draft.issues) ? draft.issues : [];
  const score = draft.score || {};
  const content = Number(score.content) || 0;
  const naming = Number(score.naming) || 0;
  const subtotal = Number(score.visibleSubtotal) || (content + naming);
  const pass = String(draft.verdict || '').includes('通过');
  const assembled = [
    String(draft.comment || '').trim(),
    '',
    '需要改的地方：',
    ...issues.map((item, i) => `${i + 1}. ${item}`),
    '',
    draft.suggestions ? `改稿建议：${draft.suggestions}` : '',
  ].filter((line) => line !== undefined).join('\n');
  const html = `
    <div class="ai-review">
      <div class="ai-pill ${pass ? 'ok' : 'warn'}">AI 初判：${escapeHtml(draft.verdict || '—')}</div>
      <div class="ai-score">
        AI 可见部分评分：内容逻辑 ${content}/40 · 命名交付 ${naming}/10 · 小计 ${subtotal}/50
        <div class="ai-muted">${escapeHtml(score.note || '这是 AI 可见部分（满分50）；听感30+音量20 共50分需助教人工听后补')}</div>
      </div>
      <div class="ai-human">⚠️ 需助教人工听：${escapeHtml(draft.humanCheck || '听感是否流畅、音量是否一致、接缝有没有咔哒声')}</div>
      <label class="ai-label" for="ai-draft-text">给学员的批改草稿（可直接改，确认后自己复制发出）</label>
      <textarea class="ai-textarea" id="ai-draft-text" rows="12">${escapeHtml(assembled)}</textarea>
      <div class="ai-actions">
        <button class="primary-btn mini-btn" type="button" id="ai-copy-btn">复制草稿</button>
        <span class="ai-muted" id="ai-copy-hint"></span>
      </div>
      <p class="ai-muted">这是 AI 草稿，<b>不会自动发给学员</b>。请人工核对（尤其听感/音量/咔哒声）后，再决定通过或打回。</p>
    </div>`;
  openModal('AI 批改草稿', html);
  document.getElementById('ai-copy-btn')?.addEventListener('click', () => {
    const text = document.getElementById('ai-draft-text')?.value || '';
    const hint = document.getElementById('ai-copy-hint');
    const copy = navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('clipboard_unavailable'));
    copy
      .then(() => { if (hint) hint.textContent = '已复制 ✓'; })
      .catch(() => { if (hint) hint.textContent = '复制失败，请手动选中'; });
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
    `<div class="intro-q">AI 反馈</div><div id="day1-feedback-panel" data-user-id="${escapeAttr(userId)}"><div class="intro-empty">正在读取反馈状态...</div></div>`,
  ].join('');
  openModal(title, body);
  loadDay1Feedback(userId);
}

async function loadDay1Feedback(userId) {
  const panel = document.getElementById('day1-feedback-panel');
  if (!panel) return;
  try {
    const data = await apiJson(`/api/admin/users/${encodeURIComponent(userId)}/day1-feedback`);
    renderDay1FeedbackPanel(userId, data.feedback || null);
  } catch (error) {
    panel.innerHTML = `<div class="intro-empty">反馈状态读取失败：${escapeHtml(error.message || String(error))}</div>`;
  }
}

function renderDay1FeedbackPanel(userId, feedback) {
  const panel = document.getElementById('day1-feedback-panel');
  if (!panel) return;
  if (!feedback) {
    panel.innerHTML = `
      <div class="ai-human">还没有为这份 Day1 自我介绍生成 AI 反馈草稿。</div>
      <div class="ai-actions">
        <button class="primary-btn mini-btn" type="button" data-day1-generate="${escapeAttr(userId)}">生成 AI 反馈草稿</button>
        <span class="ai-muted">草稿只给助教看，确认后才会给学员看。</span>
      </div>
    `;
    bindDay1FeedbackActions(panel, userId, null);
    return;
  }
  const statusLabel = {
    draft: '草稿，待助教确认',
    confirmed: '已确认，学员可见',
    needs_manual: '需人工处理',
  }[feedback.status] || '草稿，待助教确认';
  const text = feedback.confirmedText || feedback.aiDraft || '';
  panel.innerHTML = `
    <div class="ai-review" data-day1-feedback-id="${escapeAttr(feedback.id)}">
      <div class="ai-pill ${feedback.status === 'confirmed' ? 'ok' : 'warn'}">${escapeHtml(statusLabel)}</div>
      <label class="ai-label" for="day1-feedback-text">给学员看的反馈（助教可修改）</label>
      <textarea class="ai-textarea" id="day1-feedback-text" rows="10">${escapeHtml(text)}</textarea>
      <div class="ai-actions">
        <button class="primary-btn mini-btn" type="button" data-day1-confirm="${escapeAttr(userId)}">确认反馈</button>
        <button class="secondary-btn mini-btn" type="button" data-day1-save="${escapeAttr(userId)}">保存草稿</button>
        <button class="secondary-btn mini-btn" type="button" data-day1-refresh="${escapeAttr(userId)}">重新生成</button>
        <span class="ai-muted" id="day1-feedback-hint"></span>
      </div>
      <p class="ai-muted">AI 草稿不会自动发给学员。只有点“确认反馈”后，学员才会在训练台看到。</p>
    </div>
  `;
  bindDay1FeedbackActions(panel, userId, feedback);
}

function bindDay1FeedbackActions(panel, userId, feedback) {
  panel.querySelector('[data-day1-generate]')?.addEventListener('click', () => generateDay1Feedback(userId, false));
  panel.querySelector('[data-day1-refresh]')?.addEventListener('click', () => generateDay1Feedback(userId, true));
  panel.querySelector('[data-day1-save]')?.addEventListener('click', () => saveDay1Feedback(userId, feedback?.id, 'draft'));
  panel.querySelector('[data-day1-confirm]')?.addEventListener('click', () => saveDay1Feedback(userId, feedback?.id, 'confirmed'));
}

async function generateDay1Feedback(userId, refresh) {
  const panel = document.getElementById('day1-feedback-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="intro-empty">AI 正在生成 Day1 反馈草稿，请稍候...</div>';
  try {
    const data = await apiJson(`/api/admin/users/${encodeURIComponent(userId)}/day1-feedback/ai-draft`, {
      method: 'POST',
      body: JSON.stringify({ refresh }),
    });
    renderDay1FeedbackPanel(userId, data.feedback || null);
  } catch (error) {
    panel.innerHTML = `<div class="intro-empty">AI 反馈生成失败：${escapeHtml(error.message || String(error))}</div>
      <div class="ai-actions"><button class="secondary-btn mini-btn" type="button" data-day1-generate="${escapeAttr(userId)}">重试</button></div>`;
    bindDay1FeedbackActions(panel, userId, null);
  }
}

async function saveDay1Feedback(userId, feedbackId, status) {
  if (!feedbackId) return;
  const button = document.querySelector(`[data-day1-${status === 'confirmed' ? 'confirm' : 'save'}="${CSS.escape(String(userId))}"]`);
  const hint = document.getElementById('day1-feedback-hint');
  const text = (document.getElementById('day1-feedback-text')?.value || '').trim();
  try {
    if (button) button.disabled = true;
    const data = await apiJson(`/api/admin/users/${encodeURIComponent(userId)}/day1-feedback/${encodeURIComponent(feedbackId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        aiDraft: text,
        confirmedText: text,
      }),
    });
    renderDay1FeedbackPanel(userId, data.feedback || null);
    const nextHint = document.getElementById('day1-feedback-hint');
    if (nextHint) nextHint.textContent = status === 'confirmed' ? '已确认，学员可见。' : '草稿已保存。';
  } catch (error) {
    if (hint) hint.textContent = error.message || String(error);
  } finally {
    if (button) button.disabled = false;
  }
}

function openPdcaModal(userId) {
  const user = users.find((item) => item.id === userId);
  if (!user) return;
  const title = `${escapeHtml(user.nickname || user.maskedPhone)} · PDCA 复盘`;
  const homework = user.pdcaHomework;
  if (!homework) {
    openModal(title, '<div class="intro-empty">这位学员还没有提交 PDCA 复盘作业。</div>');
    return;
  }
  const fields = [
    ['计划', homework.plan],
    ['执行', homework.do],
    ['检查', homework.check],
    ['下一步', homework.act],
  ];
  const body = [
    homework.savedAt ? `<div class="intro-q">提交时间</div><div class="intro-a">${formatDate(homework.savedAt)}</div>` : '',
    ...fields.map(([q, a], i) => `<div class="intro-q">${i + 1}. ${q}</div><div class="intro-a">${a ? escapeHtml(a) : '—'}</div>`),
  ].join('');
  openModal(title, body);
}

function openResumeModal(userId) {
  const user = users.find((item) => item.id === userId);
  if (!user) return;
  const title = `${escapeHtml(user.nickname || user.maskedPhone)} · 剪辑师简历`;
  const homework = user.resumeHomework;
  if (!homework) {
    openModal(title, '<div class="intro-empty">这位学员还没有提交剪辑师简历。</div>');
    return;
  }
  const versionMap = {
    newbie: '新手版',
    practice: '有练习作品版',
    real: '已接真实单版',
  };
  const fields = [
    ['版本', versionMap[homework.version] || '新手版'],
    ['我是谁', homework.who],
    ['我能剪什么', homework.canEdit],
    ['我适合接什么单', homework.fitOrders],
    ['我的交付方式', homework.delivery],
  ];
  const body = [
    homework.savedAt ? `<div class="intro-q">提交时间</div><div class="intro-a">${formatDate(homework.savedAt)}</div>` : '',
    ...fields.map(([q, a]) => `<div class="intro-q">${q}</div><div class="intro-a">${a ? escapeHtml(a) : '—'}</div>`),
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
