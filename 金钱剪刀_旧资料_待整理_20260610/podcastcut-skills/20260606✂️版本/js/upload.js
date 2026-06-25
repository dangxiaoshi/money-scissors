import { getAuthHeaders } from './api.js?v=20260606-1';

export async function uploadAudioToOSS(file, { onProgress } = {}) {
  return uploadAudioToServer(file, { onProgress });
}

function uploadAudioToServer(file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/upload?filename=${encodeURIComponent(file.name || 'audio')}`;

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    const authHeaders = getAuthHeaders();
    Object.entries(authHeaders).forEach(([key, value]) => xhr.setRequestHeader(key, value));

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100), file.name);
    };

    xhr.onload = () => {
      const data = parseJson(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`服务器上传失败：HTTP ${xhr.status} ${data?.message || data?.error || ''}`.trim()));
        return;
      }
      if (!data?.audioUrl) {
        reject(new Error('服务器上传失败：响应中缺少 audioUrl'));
        return;
      }
      resolve({
        audioUrl: data.audioUrl,
        objectKey: data.objectKey,
        bucket: data.bucket,
        region: data.region,
        raw: data,
      });
    };

    xhr.onerror = () => reject(new Error('服务器上传失败：网络错误'));
    xhr.ontimeout = () => reject(new Error('服务器上传失败：请求超时'));
    xhr.timeout = 30 * 60 * 1000;
    xhr.send(file);
  });
}

function shouldUseServerUpload() {
  const host = globalThis.location?.hostname || '';
  return host && host !== '127.0.0.1' && host !== 'localhost';
}

function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    return {};
  }
}
