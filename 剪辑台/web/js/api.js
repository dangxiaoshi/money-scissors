const STORAGE_KEY = 'jinqian_token';
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
  const base = isFileProtocol() ? 'login.html' : '/login';
  return next ? `${base}?next=${encodeURIComponent(next)}` : base;
}

export function getHomeUrl() {
  return isFileProtocol() ? 'index.html' : '/';
}

export function getAdminUrl() {
  return isFileProtocol() ? 'admin.html' : '/admin';
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
    clearAuth();
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
    throw new Error(data.message || data.error || `请求失败：HTTP ${response.status}`);
  }
  return data;
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

  if (phoneEl) phoneEl.textContent = auth?.user?.maskedPhone || GUEST_AUTH.user.maskedPhone;
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
  return next;
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
