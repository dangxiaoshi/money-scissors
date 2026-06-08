#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';

loadEnv(path.resolve(__dirname, '..', '.env'));
const API_KEY = process.env.DASHSCOPE_API_KEY;

if (!API_KEY) {
  console.error('Missing DASHSCOPE_API_KEY in .env or environment');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} origin=${req.headers.origin || '-'}`);
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST' && url.pathname === '/dashscope/transcription') {
      await handleSubmit(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/dashscope/tasks/')) {
      const taskId = decodeURIComponent(url.pathname.split('/').pop());
      await proxyJson(res, `${TASK_URL}/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/dashscope/result') {
      const resultUrl = url.searchParams.get('url');
      if (!resultUrl || !/^https:\/\/.+/i.test(resultUrl)) {
        sendJson(res, 400, { error: 'invalid_result_url' });
        return;
      }
      await proxyJson(res, resultUrl);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    sendJson(res, 500, { error: 'proxy_error', message: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`DashScope dev proxy: http://127.0.0.1:${PORT}/dashscope`);
});

async function handleSubmit(req, res) {
  const body = await readJson(req);
  const audioUrl = body.audioUrl;
  const speakerCount = Number(body.speakerCount || 2);
  if (!audioUrl) {
    sendJson(res, 400, { error: 'missing_audioUrl' });
    return;
  }

  await proxyJson(res, SUBMIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'fun-asr',
      input: { file_urls: [audioUrl] },
      parameters: {
        diarization_enabled: true,
        speaker_count: speakerCount,
        channel_id: [0],
      },
    }),
  });
}

async function proxyJson(res, url, options = {}) {
  const upstream = await fetch(url, options);
  const text = await upstream.text();
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  });
  res.end(text);
}

function setCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-proxy-check');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) return;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  });
}
