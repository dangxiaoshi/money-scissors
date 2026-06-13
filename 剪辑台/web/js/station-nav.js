import { apiJson, clearAuth, getLoginUrl, readAuth, saveAuth, scopedPath } from './api.js?v=20260610-reviewflow-1';

export async function initStationNav({ active = 'training', requireDay1 = false, requireDay2 = false } = {}) {
  let auth = readAuth();
  if (!auth) {
    location.href = getLoginUrl(`${location.pathname}${location.search}`);
    return null;
  }

  auth = await refreshAuth(auth);
  const user = auth.user || {};
  const day1Unlocked = user.isAdmin || user.day1Complete;
  const day2Unlocked = user.isAdmin || user.day2Complete;

  if (requireDay1 && !day1Unlocked) {
    renderLockedPage(user, 'day1', active);
    return null;
  }

  if (requireDay2) {
    if (!day1Unlocked) {
      renderLockedPage(user, 'day1', active);
      return null;
    }
    if (!day2Unlocked) {
      renderLockedPage(user, 'day2', active);
      return null;
    }
  }

  injectNav(user, active);
  return auth;
}

export async function markDay1Complete(intro) {
  const options = { method: 'POST' };
  if (intro && typeof intro === 'object') {
    options.body = JSON.stringify(intro);
  }
  const data = await apiJson('/api/auth/complete-day1', options);
  const auth = readAuth();
  if (auth && data.user) {
    saveAuth({ ...auth, user: data.user });
  }
  return data.user;
}

async function refreshAuth(auth) {
  try {
    const data = await apiJson('/api/auth/me');
    if (data.user) {
      const nextAuth = { ...auth, user: data.user };
      saveAuth(nextAuth);
      return nextAuth;
    }
  } catch (error) {
    clearAuth();
    location.href = getLoginUrl(`${location.pathname}${location.search}`);
  }
  return auth;
}

function injectNav(user, active) {
  if (document.querySelector('[data-station-nav]')) return;
  injectStyle();
  const day1Unlocked = user?.isAdmin || user?.day1Complete;
  const day2Unlocked = user?.isAdmin || user?.day2Complete;
  const editLabel = day1Unlocked ? '剪辑台' : '🔒 剪辑台';
  const ordersLabel = day2Unlocked ? '接单台' : '🔒 接单台';

  const nav = document.createElement('nav');
  nav.className = 'station-nav';
  nav.dataset.stationNav = '1';
  nav.innerHTML = `
    <a class="station-brand" href="${scopedPath('/training/path.html')}" aria-label="回到训练台">
      <span class="station-mark">✂</span>
      <span>金钱剪刀</span>
    </a>
    <div class="station-tabs">
      <a class="station-tab ${active === 'training' ? 'active' : ''}" href="${scopedPath('/training/path.html')}">训练台</a>
      <a class="station-tab ${active === 'edit' ? 'active' : ''}" href="${scopedPath('/edit')}">${editLabel}</a>
      <a class="station-tab ${active === 'orders' ? 'active' : ''}" href="${scopedPath('/orders/')}">${ordersLabel}</a>
    </div>
    ${renderUserMenu(user)}
  `;
  document.body.classList.add('has-station-nav');
  document.body.prepend(nav);
  bindUserMenu(nav);
}

function renderLockedPage(user, step = 'day1', active = 'orders') {
  injectStyle();
  document.body.classList.add('has-station-nav');
  const isDay2 = step === 'day2';
  const day1Unlocked = user?.isAdmin || user?.day1Complete;
  const day2Unlocked = user?.isAdmin || user?.day2Complete;
  const editLabel = day1Unlocked ? '剪辑台' : '🔒 剪辑台';
  const ordersLabel = day2Unlocked ? '接单台' : '🔒 接单台';
  const title = isDay2 ? '接单台还没解锁' : '剪辑台还没解锁';
  const message = isDay2
    ? '不是网站坏了。请先在剪辑台完成 D2 开营直播剪辑练习，把开营直播剪到 25-30 分钟，并提交给助教审核。提交成功后，接单台会自动解锁。'
    : '不是网站坏了。请先完成 D1 自我介绍作业，生成打卡卡片后，剪辑台会自动解锁。';
  const primaryHref = isDay2 ? scopedPath('/edit') : scopedPath('/training/intro.html');
  const primaryText = isDay2 ? '去剪辑台做 D2 练习' : '去做 D1 作业';
  const secondaryHref = scopedPath('/training/path.html');
  const secondaryText = '看通关顺序';
  document.body.innerHTML = `
    <nav class="station-nav" data-station-nav="1">
      <a class="station-brand" href="${scopedPath('/training/path.html')}">
        <span class="station-mark">✂</span>
        <span>金钱剪刀</span>
      </a>
      <div class="station-tabs">
        <a class="station-tab ${active === 'training' ? 'active' : ''}" href="${scopedPath('/training/path.html')}">训练台</a>
        <a class="station-tab ${active === 'edit' ? 'active' : ''}" href="${scopedPath('/edit')}">${editLabel}</a>
        <a class="station-tab ${active === 'orders' ? 'active' : ''}" href="${scopedPath('/orders/')}">${ordersLabel}</a>
      </div>
      ${renderUserMenu(user)}
    </nav>
	    <main class="station-lock">
	      <section class="station-lock-card">
	        <div class="station-lock-icon">🔒</div>
	        <h1>${title}</h1>
	        <p>${message}</p>
	        <div class="station-lock-actions">
	          <a class="station-primary" href="${primaryHref}">${primaryText}</a>
	          <a class="station-secondary" href="${secondaryHref}">${secondaryText}</a>
	        </div>
	      </section>
	    </main>
  `;
  bindUserMenu(document.body);
}

function renderUserMenu(user) {
  const name = displayName(user);
  return `
    <details class="station-menu">
      <summary class="station-user" title="${escapeAttr(name)}">
        <span>${escapeHtml(name)}</span>
        <span class="station-caret">⌄</span>
      </summary>
      <div class="station-menu-pop">
        <a href="${scopedPath('/projects')}">我的项目</a>
        ${user?.isAdmin ? `<a href="${scopedPath('/orders-admin.html')}">接单后台</a><a href="${scopedPath('/admin')}">系统后台</a>` : ''}
        <button type="button" data-station-logout>退出登录</button>
      </div>
    </details>
  `;
}

function bindUserMenu(root) {
  const logout = root.querySelector('[data-station-logout]');
  if (!logout) return;
  logout.addEventListener('click', () => {
    clearAuth();
    location.href = getLoginUrl(scopedPath('/training/path.html'));
  });
}

function injectStyle() {
  if (document.getElementById('station-nav-style')) return;
  const style = document.createElement('style');
  style.id = 'station-nav-style';
  style.textContent = `
    body.has-station-nav { padding-top: 56px !important; }
    .station-nav {
      align-items: center;
      background: rgba(255, 252, 240, 0.96);
      border-bottom: 1px solid rgba(200, 149, 42, 0.22);
      box-shadow: 0 1px 8px rgba(80, 56, 10, 0.06);
      display: flex;
      gap: 16px;
      height: 48px;
      justify-content: space-between;
      left: 0;
      padding: 0 18px;
      position: fixed;
      right: 0;
      top: 0;
      z-index: 1000;
    }
    .station-brand,
    .station-tab {
      color: #5a4a2a;
      text-decoration: none;
    }
    .station-brand {
      align-items: center;
      display: flex;
      flex: 0 0 auto;
      font-size: 14px;
      font-weight: 800;
      gap: 8px;
      min-width: 0;
    }
    .station-mark {
      align-items: center;
      background: linear-gradient(135deg, #b8821e, #e8b84b);
      border-radius: 8px;
      color: #fff;
      display: inline-flex;
      height: 28px;
      justify-content: center;
      width: 28px;
    }
    .station-tabs {
      display: flex;
      flex: 1 1 auto;
      gap: 4px;
      justify-content: center;
      min-width: 0;
    }
    .station-tab {
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      padding: 6px 10px;
      white-space: nowrap;
    }
    .station-tab:hover,
    .station-tab.active {
      background: #f5e8c0;
      color: #b8821e;
    }
    .station-menu {
      flex: 0 1 auto;
      position: relative;
    }
    .station-user {
      align-items: center;
      color: #b8821e;
      cursor: pointer;
      display: flex;
      font-size: 13px;
      font-weight: 800;
      gap: 4px;
      max-width: 12em;
      min-height: 32px;
      overflow: hidden;
      padding: 0 4px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .station-user::-webkit-details-marker { display: none; }
    .station-user::marker { content: ""; }
    .station-user span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .station-caret {
      color: #c8952a;
      font-size: 12px;
      line-height: 1;
    }
    .station-menu-pop {
      background: #fffcf0;
      border: 1px solid rgba(200, 149, 42, 0.24);
      border-radius: 10px;
      box-shadow: 0 12px 28px rgba(80, 56, 10, 0.16);
      display: grid;
      min-width: 128px;
      padding: 6px;
      position: absolute;
      right: 0;
      top: calc(100% + 8px);
      z-index: 1002;
    }
    .station-menu-pop a,
    .station-menu-pop button {
      background: transparent;
      border: 0;
      border-radius: 8px;
      color: #5a4a2a;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      padding: 8px 10px;
      text-align: left;
      text-decoration: none;
      white-space: nowrap;
    }
    .station-menu-pop a:hover,
    .station-menu-pop button:hover {
      background: #f5e8c0;
      color: #b8821e;
    }
    .station-lock {
      align-items: center;
      background: #f5f0e8;
      display: flex;
      justify-content: center;
      min-height: calc(100vh - 56px);
      padding: 28px 18px;
    }
    .station-lock-card {
      background: #fffcf0;
      border: 1px solid rgba(200, 149, 42, 0.24);
      border-radius: 16px;
      box-shadow: 0 12px 36px rgba(80, 56, 10, 0.12);
      max-width: 440px;
      padding: 30px 26px;
      text-align: center;
    }
    .station-lock-icon { font-size: 34px; margin-bottom: 12px; }
    .station-lock-card h1 {
      color: #1a1209;
      font-size: 26px;
      margin: 0 0 10px;
    }
    .station-lock-card p {
      color: #5a4a2a;
      font-size: 15px;
      line-height: 1.7;
      margin: 0;
    }
    .station-lock-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 22px;
    }
    .station-primary,
    .station-secondary {
      border-radius: 999px;
      font-size: 15px;
      font-weight: 800;
      padding: 12px 18px;
      text-decoration: none;
    }
    .station-primary {
      background: linear-gradient(135deg, #b8821e, #c8952a, #e8b84b);
      color: #fff;
    }
    .station-secondary {
      border: 1px solid rgba(200, 149, 42, 0.26);
      color: #7a4a10;
    }
    @media (max-width: 700px) {
      .station-nav { gap: 8px; padding: 0 10px; }
      .station-brand span:last-child { display: none; }
      .station-tab { font-size: 12px; padding: 6px 7px; }
      .station-user { max-width: 6em; }
      .station-menu-pop { right: -4px; }
    }
  `;
  document.head.appendChild(style);
}

function displayName(user) {
  return user?.nickname || user?.maskedPhone || '同学';
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
