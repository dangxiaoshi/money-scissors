const STORAGE_KEY = 'jinqian_token';
const TEST_PREFIX = '/web-test';
const SERVER_TROUBLE_IMAGE = '/assets/server-trouble.jpg';
const GUEST_AUTH = {
  token: '',
  expiresAt: '2999-12-31T00:00:00.000Z',
  user: {
    id: 0,
    phone: 'guest',
    maskedPhone: '免登录',
    isAdmin: false,
    day1Complete: false,
    day2Complete: false,
  },
};

export function readAuth() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const auth = JSON.parse(value);
    if (!auth?.token || !auth?.expiresAt || !auth?.user) return null;
    if (isExpired(auth)) {
      clearAuth();
      return null;
    }
    return auth;
  } catch {
    return null;
  }
}

export function saveAuth(auth) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
  try {
    fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

export function isExpired(auth) {
  const expiresAt = Date.parse(auth?.expiresAt || '');
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30 * 1000;
}

export function getToken() {
  return readAuth()?.token || '';
}

export function getAuthHeaders(headers = {}) {
  const token = getToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

export function getLoginUrl(next = defaultNext()) {
  const base = isFileProtocol() ? 'login.html' : scopedPath('/login');
  const scopedNext = next ? scopedPath(next) : '';
  return scopedNext ? `${base}?next=${encodeURIComponent(scopedNext)}` : base;
}

export function getHomeUrl() {
  return isFileProtocol() ? 'training/path.html' : scopedPath('/training/path.html');
}

export function getAdminUrl() {
  return isFileProtocol() ? 'admin.html' : scopedPath('/admin');
}

export function redirectToLogin(next = defaultNext()) {
  location.href = getLoginUrl(next);
}

export function ensureLoggedIn() {
  const auth = readAuth();
  return auth || GUEST_AUTH;
}

export async function apiFetch(input, init = {}) {
  const auth = readAuth();
  const headers = new Headers(init.headers || {});
  if (auth?.token) headers.set('Authorization', `Bearer ${auth.token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    const data = await response.clone().json().catch(() => ({}));
    const message = String(data?.message || data?.error || '');
    if (!auth?.token || /失效|expired|invalid/i.test(message)) clearAuth();
  }
  return response;
}

export function showServerTrouble({
  title = '服务器累趴了',
  message = '刚才这一步没有正常连上金钱剪刀。先别重复上传或连续点按钮；如果你正在剪辑，先关掉弹窗确认内容还在，再截图发给助教。',
  detail = '',
} = {}) {
  if (typeof document === 'undefined') return;
  const overlay = ensureServerTroubleOverlay();
  overlay.querySelector('[data-trouble-title]').textContent = title;
  overlay.querySelector('[data-trouble-message]').textContent = message;
  const detailEl = overlay.querySelector('[data-trouble-detail]');
  detailEl.textContent = detail;
  detailEl.hidden = !detail;
  overlay.hidden = false;
  overlay.classList.add('visible');
  document.body?.classList.add('money-trouble-open');
}

export function hideServerTrouble() {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('money-server-trouble');
  if (!overlay) return;
  overlay.classList.remove('visible');
  overlay.hidden = true;
  document.body?.classList.remove('money-trouble-open');
}

export async function apiJson(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const response = await apiFetch(input, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(readApiErrorMessage(data, response.status));
  }
  return data;
}

function readApiErrorMessage(data, status) {
  if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  if (typeof data?.error?.message === 'string' && data.error.message.trim()) return data.error.message;
  if (typeof data?.error?.type === 'string' && data.error.type.trim()) return data.error.type;
  return `请求失败：HTTP ${status}`;
}

export function setupSessionChrome({
  phoneId = 'user-phone',
  logoutId = 'logout-btn',
  adminLinkId = 'admin-link',
} = {}) {
  const auth = readAuth();
  const phoneEl = document.getElementById(phoneId);
  const logoutEl = document.getElementById(logoutId);
  const adminLinkEl = document.getElementById(adminLinkId);

  if (phoneEl) phoneEl.textContent = auth?.user?.nickname || auth?.user?.maskedPhone || GUEST_AUTH.user.maskedPhone;
  if (adminLinkEl) {
    adminLinkEl.href = getAdminUrl();
    adminLinkEl.hidden = !auth?.user?.isAdmin;
  }
  if (logoutEl) {
    logoutEl.addEventListener('click', () => {
      clearAuth();
      location.href = getHomeUrl();
    });
  }
}

export function parseNextFromQuery() {
  const next = new URLSearchParams(location.search).get('next') || '';
  if (!next.startsWith('/') && !next.endsWith('.html')) return getHomeUrl();
  return scopedPath(next);
}

export function maskPhone(phone) {
  return String(phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

export async function postUsage(action) {
  return apiJson('/api/usage', {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

function defaultNext() {
  return isFileProtocol() ? location.pathname.split('/').pop() || 'index.html' : `${location.pathname}${location.search}`;
}

function isFileProtocol() {
  return location.protocol === 'file:';
}

export function isTestScope() {
  return location.pathname === TEST_PREFIX || location.pathname.startsWith(`${TEST_PREFIX}/`);
}

export function scopedPath(pathname = '/') {
  if (isFileProtocol() || !isTestScope()) return pathname;
  const value = String(pathname || '/');
  if (!value.startsWith('/')) return value;
  if (value === TEST_PREFIX || value.startsWith(`${TEST_PREFIX}/`)) return value;
  if (value.startsWith('/api/') || value.startsWith('/uploads/') || value.startsWith('/refine/')) return value;
  const [rawPath, rawQuery = ''] = value.split('?');
  const query = rawQuery ? `?${rawQuery}` : '';
  const aliases = {
    '/': '/index.html',
    '/login': '/login.html',
    '/admin': '/admin.html',
    '/projects': '/projects.html',
    '/edit': '/edit.html',
    '/edit/': '/edit.html',
    '/privacy': '/privacy.html',
    '/hub': '/hub.html',
    '/training': '/training/index.html',
    '/training/': '/training/index.html',
    '/orders': '/orders/index.html',
    '/orders/': '/orders/index.html',
    '/orders/admin': '/orders-admin.html',
    '/orders/admin/': '/orders-admin.html',
  };
  return `${TEST_PREFIX}${aliases[rawPath] || rawPath}${query}`;
}

function installTestScopeGuard() {
  if (!isTestScope() || window.__moneyScissorsTestScopeGuard) return;
  window.__moneyScissorsTestScopeGuard = true;

  const rewrite = (root = document) => {
    installTestBadge();
    root.querySelectorAll?.('a[href^="/"]').forEach((link) => {
      const href = link.getAttribute('href');
      const next = scopedPath(href);
      if (next !== href) link.setAttribute('href', next);
    });
    root.querySelectorAll?.('form[action^="/"]').forEach((form) => {
      const action = form.getAttribute('action');
      const next = scopedPath(action);
      if (next !== action) form.setAttribute('action', next);
    });
  };

  const ready = () => {
    installTestBadge();
    rewrite();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) rewrite(node);
        });
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
}

installServerTroubleGuard();
installTestScopeGuard();

function installTestBadge() {
  if (document.getElementById('test-scope-badge')) return;
  const badge = document.createElement('div');
  badge.id = 'test-scope-badge';
  badge.textContent = '测试站';
  badge.style.cssText = [
    'position:fixed',
    'right:14px',
    'bottom:14px',
    'z-index:99999',
    'background:#111827',
    'color:#fff',
    'border:1px solid rgba(255,255,255,.35)',
    'border-radius:999px',
    'box-shadow:0 10px 30px rgba(0,0,0,.18)',
    'font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'letter-spacing:0',
    'padding:9px 13px',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(badge);
}

function installServerTroubleGuard() {
  if (typeof window === 'undefined' || window.__moneyScissorsServerTroubleGuard) return;
  window.__moneyScissorsServerTroubleGuard = true;
  preloadServerTroubleImage();
  patchFetchForServerTrouble();
  patchXhrForServerTrouble();

  window.addEventListener('offline', () => {
    showServerTrouble({
      title: '网络断了一下',
      message: '网页还在，但刚才这一步没有连上服务器。先别重复上传，等网络恢复后再刷新重试。',
      detail: '浏览器提示：已离线',
    });
  });

  window.addEventListener('error', (event) => {
    if (shouldIgnoreWindowError(event)) return;
    showServerTrouble({
      title: '页面这一步卡住了',
      message: '页面运行时遇到一个小故障。先截图发给助教，再点刷新重试。',
      detail: trimDetail(event.message || '页面脚本出错'),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason?.message || reason?.error || String(reason || '');
    if (!message || shouldIgnoreErrorMessage(message) || !isLikelyServerTroubleMessage(message)) return;
    showServerTrouble({
      title: '服务器暂时连不上',
      message: '网页还在，但刚才这一步没有连上服务器。先别重复上传，等十几秒后刷新重试。',
      detail: trimDetail(message),
    });
  });
}

function preloadServerTroubleImage() {
  if (typeof Image === 'undefined' || window.__moneyScissorsTroubleImage) return;
  const image = new Image();
  image.decoding = 'async';
  image.src = resolveServerTroubleImage();
  window.__moneyScissorsTroubleImage = image;
}

function patchFetchForServerTrouble() {
  if (typeof window.fetch !== 'function' || window.__moneyScissorsFetchTroublePatched) return;
  window.__moneyScissorsFetchTroublePatched = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const watched = shouldReportServerTrouble(input, init);
    try {
      const response = await nativeFetch(input, init);
      if (watched && shouldShowTroubleForStatus(response.status)) {
        showServerTrouble(buildStatusTrouble(response.status, input));
      }
      return response;
    } catch (error) {
      if (watched) showServerTrouble(buildNetworkTrouble(error, input));
      throw error;
    }
  };
}

function patchXhrForServerTrouble() {
  const proto = window.XMLHttpRequest?.prototype;
  if (!proto || window.__moneyScissorsXhrTroublePatched) return;
  window.__moneyScissorsXhrTroublePatched = true;
  const nativeOpen = proto.open;
  const nativeSend = proto.send;

  proto.open = function openWithTroubleWatch(method, url, ...rest) {
    this.__moneyScissorsTroubleUrl = url;
    this.__moneyScissorsTroubleMethod = method;
    return nativeOpen.call(this, method, url, ...rest);
  };

  proto.send = function sendWithTroubleWatch(...args) {
    this.__moneyScissorsTroubleWatched = shouldReportServerTrouble(this.__moneyScissorsTroubleUrl);
    if (!this.__moneyScissorsTroubleBound) {
      this.__moneyScissorsTroubleBound = true;
      this.addEventListener('load', () => {
        if (this.__moneyScissorsTroubleWatched && shouldShowTroubleForStatus(this.status)) {
          showServerTrouble(buildStatusTrouble(this.status, this.__moneyScissorsTroubleUrl));
        }
      });
      this.addEventListener('error', () => {
        if (this.__moneyScissorsTroubleWatched) {
          showServerTrouble(buildNetworkTrouble(null, this.__moneyScissorsTroubleUrl));
        }
      });
      this.addEventListener('timeout', () => {
        if (this.__moneyScissorsTroubleWatched) {
          showServerTrouble({
            title: '服务器响应太慢了',
            message: '这一步等太久没有返回。先别重复上传，等十几秒后刷新重试。',
            detail: requestDetail('请求超时', this.__moneyScissorsTroubleUrl),
          });
        }
      });
    }
    return nativeSend.apply(this, args);
  };
}

function buildStatusTrouble(status, input) {
  const overloaded = Number(status) === 429;
  return {
    title: overloaded ? '服务器排队太挤了' : '服务器累趴了',
    message: overloaded
      ? '现在同时处理的人有点多。先别连续点按钮，等十几秒再刷新重试。'
      : '刚才这一步服务器没有正常返回。先别重复上传或连续点按钮；如果你正在剪辑，先关掉弹窗确认内容还在，再截图发给助教。',
    detail: requestDetail(`错误码：${status}`, input),
  };
}

function buildNetworkTrouble(error, input) {
  return {
    title: '服务器暂时连不上',
    message: '网页还在，但刚才这一步没有连上服务器。先别重复上传，等十几秒后刷新重试。',
    detail: requestDetail(trimDetail(error?.message || '网络请求失败'), input),
  };
}

function shouldShowTroubleForStatus(status) {
  const value = Number(status);
  return value === 408 || value === 429 || value >= 500;
}

function shouldReportServerTrouble(input, init = {}) {
  return isWatchedServerRequest(input) && !isSilentServerRequest(input, init);
}

function isSilentServerRequest(input, init = {}) {
  if (init?.keepalive) return true;
  if (hasSilentTroubleHeader(input, init)) return true;
  const method = requestMethod(input, init);
  const path = requestPath(input).split('?')[0];
  if (method === 'POST' && path === '/api/projects') return true;
  return method === 'PATCH' && /^\/api\/projects\/[^/]+$/.test(path);
}

function hasSilentTroubleHeader(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (typeof Request !== 'undefined' && input instanceof Request) {
    input.headers.forEach((value, key) => {
      if (!headers.has(key)) headers.set(key, value);
    });
  }
  return headers.get('X-Money-Scissors-Silent-Trouble') === '1';
}

function requestMethod(input, init = {}) {
  return String(init.method || input?.method || 'GET').toUpperCase();
}

function isWatchedServerRequest(input) {
  const raw = readRequestUrl(input);
  if (!raw || typeof location === 'undefined') return false;
  try {
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return false;
    return url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/uploads/')
      || url.pathname.startsWith('/refine/');
  } catch {
    return false;
  }
}

function readRequestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return input?.url || '';
}

function requestDetail(prefix, input) {
  const path = requestPath(input);
  return trimDetail(path ? `${prefix} · ${path}` : prefix);
}

function requestPath(input) {
  const raw = readRequestUrl(input);
  if (!raw || typeof location === 'undefined') return '';
  try {
    const url = new URL(raw, location.href);
    return `${url.pathname}${url.search}`.slice(0, 96);
  } catch {
    return String(raw).slice(0, 96);
  }
}

function shouldIgnoreWindowError(event) {
  const message = event?.message || '';
  if (shouldIgnoreErrorMessage(message)) return true;
  const filename = event?.filename || '';
  if (!filename || typeof location === 'undefined') return false;
  try {
    const url = new URL(filename, location.href);
    return url.origin !== location.origin;
  } catch {
    return false;
  }
}

function shouldIgnoreErrorMessage(message) {
  const text = String(message || '');
  return !text
    || /ResizeObserver loop/i.test(text)
    || /^Script error\.?$/i.test(text)
    || /AbortError|NotAllowedError|NotFoundError/i.test(text)
    || /play\(\) request was interrupted|user aborted|cancelled|canceled/i.test(text);
}

function isLikelyServerTroubleMessage(message) {
  const text = String(message || '');
  return /Failed to fetch|NetworkError|Load failed/i.test(text)
    || /HTTP\s*(408|429|5\d\d)/i.test(text)
    || /请求失败：HTTP\s*(408|429|5\d\d)/i.test(text)
    || /服务器.*(失败|错误|超时|连不上)/.test(text)
    || /(网络请求失败|请求超时)/.test(text);
}

function trimDetail(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function resolveServerTroubleImage() {
  if (isFileProtocol()) return 'assets/server-trouble.jpg';
  return scopedPath(SERVER_TROUBLE_IMAGE);
}

function ensureServerTroubleOverlay() {
  let overlay = document.getElementById('money-server-trouble');
  if (overlay) return overlay;
  ensureServerTroubleStyle();
  overlay = document.createElement('div');
  overlay.id = 'money-server-trouble';
  overlay.className = 'money-trouble-mask';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'money-trouble-title');
  overlay.innerHTML = `
    <section class="money-trouble-card">
      <img class="money-trouble-image" src="${resolveServerTroubleImage()}" alt="服务器累趴框">
      <h2 id="money-trouble-title" data-trouble-title>服务器累趴了</h2>
      <p data-trouble-message></p>
      <p class="money-trouble-detail" data-trouble-detail hidden></p>
      <div class="money-trouble-actions">
        <button type="button" class="money-trouble-primary" data-trouble-refresh>刷新页面</button>
        <button type="button" class="money-trouble-secondary" data-trouble-close>先关掉</button>
      </div>
    </section>
  `;
  overlay.querySelector('[data-trouble-refresh]').addEventListener('click', () => location.reload());
  overlay.querySelector('[data-trouble-close]').addEventListener('click', hideServerTrouble);
  (document.body || document.documentElement).appendChild(overlay);
  return overlay;
}

function ensureServerTroubleStyle() {
  if (document.getElementById('money-server-trouble-style')) return;
  const style = document.createElement('style');
  style.id = 'money-server-trouble-style';
  style.textContent = `
    body.money-trouble-open { overflow: hidden; }
    .money-trouble-mask {
      align-items: center;
      background: rgba(31, 25, 18, .68);
      bottom: 0;
      display: none;
      justify-content: center;
      left: 0;
      padding: 18px;
      position: fixed;
      right: 0;
      top: 0;
      z-index: 2147483000;
    }
    .money-trouble-mask.visible { display: flex; }
    .money-trouble-card {
      background: #fffaf1;
      border: 1px solid rgba(180, 126, 34, .3);
      border-radius: 8px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .34);
      color: #3a2b14;
      max-height: calc(100vh - 36px);
      overflow: auto;
      padding: 14px 14px 16px;
      text-align: center;
      width: min(420px, 94vw);
    }
    .money-trouble-image {
      border-radius: 8px;
      display: block;
      margin: 0 auto 10px;
      max-height: 54vh;
      object-fit: contain;
      width: min(300px, 76vw);
    }
    .money-trouble-card h2 {
      font-size: 22px;
      letter-spacing: 0;
      line-height: 1.25;
      margin: 4px 0 8px;
    }
    .money-trouble-card p {
      color: #6a5330;
      font-size: 14px;
      line-height: 1.65;
      margin: 0 auto 10px;
      max-width: 340px;
    }
    .money-trouble-detail {
      background: rgba(255, 255, 255, .68);
      border: 1px solid rgba(180, 126, 34, .18);
      border-radius: 8px;
      color: #8a6a39 !important;
      font-size: 12px !important;
      padding: 7px 9px;
      word-break: break-word;
    }
    .money-trouble-actions {
      display: flex;
      gap: 8px;
      justify-content: center;
      margin-top: 12px;
    }
    .money-trouble-actions button {
      border-radius: 8px;
      cursor: pointer;
      font: 800 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      min-height: 40px;
      padding: 0 15px;
    }
    .money-trouble-primary {
      background: #d88720;
      border: 1px solid #c17414;
      color: #fff;
    }
    .money-trouble-secondary {
      background: #fff6e7;
      border: 1px solid rgba(180, 126, 34, .3);
      color: #6a5330;
    }
    @media (max-width: 520px) {
      .money-trouble-card { padding: 12px; }
      .money-trouble-card h2 { font-size: 20px; }
      .money-trouble-actions { flex-direction: column; }
      .money-trouble-actions button { width: 100%; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}
