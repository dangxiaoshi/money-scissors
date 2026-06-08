const APP_HOST = globalThis.location?.hostname || '';
export const DASHSCOPE_PROXY_URL = APP_HOST === '127.0.0.1' || APP_HOST === 'localhost'
  ? 'http://127.0.0.1:8787/dashscope'
  : '/dashscope';
