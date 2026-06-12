const STORAGE_KEY = 'jinqian_token';
const TEST_PREFIX = '/web-test';
const GUEST_AUTH = {
  token: '',
  expiresAt: '2999-12-31T00:00:00.000Z',
  user: {
    id: 0,
    phone: 'guest',
    maskedPhone: '免登录',
    isAdmin: false,
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
