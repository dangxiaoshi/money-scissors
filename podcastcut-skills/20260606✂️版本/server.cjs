#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const OpenApi = require('@alicloud/openapi-client');
const Dysmsapi = require('@alicloud/dysmsapi20170525');
const Util = require('@alicloud/tea-util');
const { Transform, PassThrough } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(process.cwd(), '.env'));

const PORT = Number(process.env.PORT || 80);
const STATIC_ROOT = resolveStaticRoot();
const DATA_ROOT = path.join(__dirname, 'data');
const LOG_ROOT = path.join(__dirname, 'logs');
const UPLOAD_ROOT = path.join(STATIC_ROOT, 'uploads');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_ROOT, 'users.db');
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 2 * 1024 * 1024);
const SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const JWT_EXPIRE_HOURS = Number(process.env.JWT_EXPIRE_HOURS || 168);
const MAX_DAILY_SMS_PER_PHONE = Number(process.env.MAX_DAILY_SMS_PER_PHONE || 5);
const MAX_SMS_SENDS_PER_IP_WINDOW = Number(process.env.MAX_SMS_SENDS_PER_IP_WINDOW || 20);
const SMS_IP_WINDOW_MINUTES = Number(process.env.SMS_IP_WINDOW_MINUTES || 10);
const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS || 5);
const VERIFY_TTL_MINUTES = Number(process.env.VERIFY_CODE_TTL_MINUTES || 5);
const LOCK_MINUTES = Number(process.env.VERIFY_LOCK_MINUTES || 30);
const AUTH_DISABLED = process.env.AUTH_DISABLED !== '0';
const DEV_SEND_CODE_FALLBACK = process.env.ALLOW_DEV_SEND_CODE_FALLBACK === '1';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/g, '');
const ADMIN_PHONES = new Set(
  String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map((value) => normalizePhone(value))
    .filter(Boolean),
);

ensureDir(DATA_ROOT);
ensureDir(LOG_ROOT);
ensureDir(UPLOAD_ROOT);

const db = new Database(DB_PATH);
initializeDatabase(db);

const API_KEY = process.env.DASHSCOPE_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
if (!API_KEY) {
  console.error('Missing DASHSCOPE_API_KEY');
  process.exit(1);
}
if (!AUTH_DISABLED && !JWT_SECRET) {
  console.error('Missing JWT_SECRET');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

const smsClient = createSmsClient();
const smsIpBuckets = new Map();

const statements = {
  findUserByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (phone, created_at, last_active_at, usage_count, wechat_added, note, is_admin)
    VALUES (@phone, @created_at, @last_active_at, 0, 0, '', @is_admin)
  `),
  updateUserActivity: db.prepare(`
    UPDATE users
    SET last_active_at = @last_active_at, is_admin = @is_admin
    WHERE id = @id
  `),
  upsertVerificationCode: db.prepare(`
    INSERT INTO verification_codes (phone, code, expires_at, attempts, locked_until, sent_count, sent_day, last_sent_at)
    VALUES (@phone, @code, @expires_at, 0, NULL, 1, @sent_day, @last_sent_at)
    ON CONFLICT(phone) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at,
      attempts = 0,
      locked_until = NULL,
      sent_count = CASE
        WHEN verification_codes.sent_day = excluded.sent_day THEN verification_codes.sent_count + 1
        ELSE 1
      END,
      sent_day = excluded.sent_day,
      last_sent_at = excluded.last_sent_at
  `),
  getVerificationCode: db.prepare('SELECT * FROM verification_codes WHERE phone = ?'),
  incrementVerifyAttempts: db.prepare(`
    UPDATE verification_codes
    SET attempts = attempts + 1,
        locked_until = CASE
          WHEN attempts + 1 >= @max_attempts THEN @locked_until
          ELSE locked_until
        END
    WHERE phone = @phone
  `),
  clearVerificationCode: db.prepare('DELETE FROM verification_codes WHERE phone = ?'),
  insertUsageLog: db.prepare(`
    INSERT INTO usage_logs (user_id, action, created_at)
    VALUES (@user_id, @action, @created_at)
  `),
  incrementUsageCount: db.prepare(`
    UPDATE users SET usage_count = usage_count + 1, last_active_at = @last_active_at WHERE id = @id
  `),
  listUsers: db.prepare(`
    SELECT id, phone, created_at, last_active_at, usage_count, wechat_added, note, is_admin
    FROM users
    ORDER BY usage_count DESC, last_active_at DESC, created_at DESC
  `),
  updateAdminUser: db.prepare(`
    UPDATE users SET
      wechat_added = @wechat_added,
      note = @note,
      last_active_at = @last_active_at
    WHERE id = @id
  `),
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'money-scissors',
        time: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname.startsWith('/api/auth/')) {
      await handleAuth(req, res, url);
      return;
    }

    if (url.pathname === '/api/usage') {
      await handleUsage(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/admin/')) {
      await handleAdmin(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/dashscope/')) {
      await handleDashScope(req, res, url);
      return;
    }

    if (url.pathname === '/api/upload') {
      await handleUpload(req, res, url);
      return;
    }

    if (url.pathname === '/api/deepseek/chat') {
      await handleDeepSeek(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/refine/')) {
      await handleRefine(req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? 'bad_request' : 'server_error', message: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`money-scissors listening on :${PORT}`);
});

async function handleAuth(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/send-code') {
    if (!consumeRateLimit(smsIpBuckets, getClientIp(req), MAX_SMS_SENDS_PER_IP_WINDOW, SMS_IP_WINDOW_MINUTES * 60 * 1000)) {
      sendJson(res, 429, { error: 'sms_ip_limit', message: '验证码请求过于频繁，请稍后再试。' });
      return;
    }

    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    if (!isValidChinaPhone(phone)) {
      sendJson(res, 400, { error: 'invalid_phone', message: '请输入 11 位中国大陆手机号。' });
      return;
    }

    const record = statements.getVerificationCode.get(phone);
    const today = isoDay();
    if (record && record.sent_day === today && Number(record.sent_count || 0) >= MAX_DAILY_SMS_PER_PHONE) {
      sendJson(res, 429, {
        error: 'sms_daily_limit',
        message: `同一手机号每天最多发送 ${MAX_DAILY_SMS_PER_PHONE} 条验证码。`,
      });
      return;
    }

    const code = buildVerificationCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VERIFY_TTL_MINUTES * 60 * 1000).toISOString();
    const payload = {
      phone,
      code,
      expires_at: expiresAt,
      sent_day: today,
      last_sent_at: now.toISOString(),
    };

    statements.upsertVerificationCode.run(payload);

    const sendResult = await sendSmsCode(phone, code);
    sendJson(res, 200, {
      ok: true,
      cooldownSeconds: 60,
      expiresAt,
      message: sendResult.message,
      ...(sendResult.devCode ? { devCode: sendResult.devCode } : {}),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    const code = String(body.code || '').trim();
    if (!isValidChinaPhone(phone) || !/^\d{6}$/.test(code)) {
      sendJson(res, 400, { error: 'invalid_params', message: '请输入正确的手机号和 6 位验证码。' });
      return;
    }

    const record = statements.getVerificationCode.get(phone);
    if (!record) {
      sendJson(res, 400, { error: 'code_not_found', message: '请先发送验证码。' });
      return;
    }

    const now = new Date();
    if (record.locked_until && new Date(record.locked_until).getTime() > now.getTime()) {
      sendJson(res, 429, { error: 'code_locked', message: '验证码尝试过多，请 30 分钟后再试。' });
      return;
    }
    if (new Date(record.expires_at).getTime() < now.getTime()) {
      sendJson(res, 400, { error: 'code_expired', message: '验证码已过期，请重新发送。' });
      return;
    }
    if (record.code !== code) {
      statements.incrementVerifyAttempts.run({
        phone,
        max_attempts: MAX_VERIFY_ATTEMPTS,
        locked_until: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000).toISOString(),
      });
      sendJson(res, 400, { error: 'code_invalid', message: '验证码不对，请重试。' });
      return;
    }

    statements.clearVerificationCode.run(phone);
    const user = upsertUser(phone);
    const auth = buildAuthPayload(user);
    sendJson(res, 200, auth);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = requireAuth(req, res);
    if (!user) return;
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function handleUsage(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) return;

  const body = await readJson(req);
  const action = String(body.action || '').trim();
  if (!['upload', 'transcribe', 'pipeline_complete', 'download'].includes(action)) {
    sendJson(res, 400, { error: 'invalid_action', message: '不支持的 usage action。' });
    return;
  }

  recordUsage(user.id, action);
  sendJson(res, 200, { ok: true });
}

async function handleAdmin(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const user = requireAdmin(req, res);
  if (!user) return;

  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    const users = statements.listUsers.all().map((row) => ({
      ...publicUser(row),
      maskedPhone: maskPhone(row.phone),
      note: row.note || '',
      wechatAdded: Boolean(row.wechat_added),
    }));
    sendJson(res, 200, { users });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/users.csv') {
    const rows = statements.listUsers.all();
    const csv = [
      ['手机号', '注册时间', '最后活跃', '使用次数', '已加微信', '备注', '管理员'].join(','),
      ...rows.map((row) => [
        csvCell(row.phone),
        csvCell(row.created_at),
        csvCell(row.last_active_at),
        row.usage_count,
        row.wechat_added ? '是' : '否',
        csvCell(row.note || ''),
        row.is_admin ? '是' : '否',
      ].join(',')),
    ].join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="money-scissors-users.csv"',
    });
    res.end(`\uFEFF${csv}`);
    return;
  }

  const match = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (req.method === 'PATCH' && match) {
    const body = await readJson(req);
    statements.updateAdminUser.run({
      id: Number(match[1]),
      wechat_added: body.wechatAdded ? 1 : 0,
      note: String(body.note || '').slice(0, 300),
      last_active_at: new Date().toISOString(),
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function handleDashScope(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'POST' && url.pathname === '/dashscope/transcription') {
    const body = await readJson(req);
    const audioUrl = body.audioUrl;
    const speakerCount = Number(body.speakerCount || 2);
    if (!audioUrl) {
      sendJson(res, 400, { error: 'missing_audioUrl' });
      return;
    }

    recordUsage(user.id, 'transcribe');
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
          diarization_enabled: speakerCount > 1,
          speaker_count: speakerCount,
          channel_id: [0],
        },
      }),
    });
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
}

async function handleUpload(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) return;

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { error: 'file_too_large' });
    return;
  }

  const filename = url.searchParams.get('filename') || 'audio';
  if (!isAllowedAudioUpload(filename, req.headers['content-type'])) {
    sendJson(res, 400, { error: 'invalid_audio_file', message: '请上传 mp3 / wav / m4a / aac / flac 音频文件。' });
    return;
  }
  const ext = getAudioExt(filename, req.headers['content-type']);
  const date = isoDay();
  const uploadDir = path.join(UPLOAD_ROOT, date);
  ensureDir(uploadDir);

  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const basename = `${Date.now()}-${id}${ext}`;
  const filePath = path.join(uploadDir, basename);
  const publicPath = `/uploads/${date}/${basename}`;

  try {
    const bytes = await writeRequestBody(req, filePath, MAX_UPLOAD_BYTES);
    const baseUrl = PUBLIC_BASE_URL || `http://${req.headers.host}`;
    recordUsage(user.id, 'upload');
    sendJson(res, 201, {
      audioUrl: `${baseUrl}${publicPath}`,
      objectKey: publicPath.slice(1),
      bucket: 'ecs-local',
      region: 'ecs',
      size: bytes,
    });
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    sendJson(res, error.statusCode || 500, {
      error: error.statusCode === 413 ? 'file_too_large' : 'upload_failed',
      message: error.message,
    });
  }
}

async function handleDeepSeek(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) return;
  if (!DEEPSEEK_KEY) {
    sendJson(res, 500, { error: 'missing_deepseek_key', message: '服务端未配置 DEEPSEEK_KEY。' });
    return;
  }

  const body = await readJson(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    sendJson(res, 400, { error: 'missing_messages', message: '缺少 DeepSeek messages。' });
    return;
  }

  await proxyJson(res, DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: body.model || 'deepseek-chat',
      max_tokens: Number(body.max_tokens || body.maxTokens || 8192),
      response_format: body.response_format || { type: 'json_object' },
      messages,
    }),
  });
}

async function serveStatic(req, res, url) {
  const aliasedPath = resolveStaticAlias(url.pathname);
  const pathname = decodeURIComponent(aliasedPath);
  const file = path.normalize(path.join(STATIC_ROOT, pathname));
  if (!file.startsWith(STATIC_ROOT + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  if (stat.isDirectory()) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-proxy-check');
  res.setHeader('Vary', 'Origin');
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res, status, data) {
  setSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function writeRequestBody(req, filePath, maxBytes) {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error('文件超过 500MB，请压缩或裁剪后上传。');
        error.statusCode = 413;
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });

  await pipeline(req, limiter, fs.createWriteStream(filePath));
  return bytes;
}

function getAudioExt(filename, type = '') {
  const ext = (filename.match(/\.[a-z0-9]{2,8}$/i) || [])[0]?.toLowerCase();
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) return ext;
  if (/wav/i.test(type)) return '.wav';
  if (/mp4|m4a|aac/i.test(type)) return '.m4a';
  if (/flac/i.test(type)) return '.flac';
  return '.mp3';
}

function isAllowedAudioUpload(filename, type = '') {
  const ext = (filename.match(/\.[a-z0-9]{2,8}$/i) || [])[0]?.toLowerCase();
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) return true;
  return /^audio\//i.test(type);
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function consumeRateLimit(bucket, key, limit, windowMs) {
  const now = Date.now();
  const record = bucket.get(key);
  if (!record || record.resetAt <= now) {
    bucket.set(key, { count: 1, resetAt: now + windowMs });
    cleanupRateLimitBucket(bucket, now);
    return true;
  }
  if (record.count >= limit) return false;
  record.count += 1;
  return true;
}

function cleanupRateLimitBucket(bucket, now) {
  if (bucket.size < 1000) return;
  for (const [key, record] of bucket) {
    if (record.resetAt <= now) bucket.delete(key);
  }
}

function readJson(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error('请求体过大。');
        error.statusCode = 413;
        req.destroy(error);
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        const wrapped = new Error(`invalid_json: ${error.message}`);
        wrapped.statusCode = 400;
        reject(wrapped);
      }
    });
    req.on('error', reject);
  });
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) return;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveStaticRoot() {
  const publicRoot = path.join(__dirname, 'public');
  if (fs.existsSync(path.join(publicRoot, 'index.html'))) return publicRoot;
  return __dirname;
}

function resolveStaticAlias(pathname) {
  if (pathname === '/') return '/index.html';
  if (pathname === '/login') return '/login.html';
  if (pathname === '/admin') return '/admin.html';
  if (pathname === '/privacy') return '/privacy.html';
  if (pathname === '/refine' || pathname === '/refine/') return '/public/refine/index.html';
  if (pathname.startsWith('/refine/')) return `/public${pathname}`;
  return pathname;
}

function initializeDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      wechat_added INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      sent_day TEXT,
      last_sent_at TEXT
    );
  `);
}

function requireAuth(req, res) {
  if (AUTH_DISABLED) {
    return guestUser();
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    sendJson(res, 401, { error: 'unauthorized', message: '请先登录。' });
    return null;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = statements.findUserById.get(payload.userId);
    if (!user) throw new Error('user_not_found');
    if (ADMIN_PHONES.has(user.phone) && !user.is_admin) {
      statements.updateUserActivity.run({
        id: user.id,
        last_active_at: new Date().toISOString(),
        is_admin: 1,
      });
      user.is_admin = 1;
    }
    return user;
  } catch {
    sendJson(res, 401, { error: 'unauthorized', message: '登录已失效，请重新登录。' });
    return null;
  }
}

function requireAdmin(req, res) {
  if (AUTH_DISABLED) {
    sendJson(res, 403, { error: 'forbidden', message: '免登录模式下后台接口未开放。' });
    return null;
  }
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.is_admin && !ADMIN_PHONES.has(user.phone)) {
    sendJson(res, 403, { error: 'forbidden', message: '只有管理员能访问后台。' });
    return null;
  }
  return user;
}

function buildVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidChinaPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

function isoDay() {
  return new Date().toISOString().slice(0, 10);
}

function maskPhone(phone) {
  return String(phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

function upsertUser(phone) {
  const now = new Date().toISOString();
  const isAdmin = ADMIN_PHONES.has(phone) ? 1 : 0;
  let user = statements.findUserByPhone.get(phone);
  if (!user) {
    statements.insertUser.run({
      phone,
      created_at: now,
      last_active_at: now,
      is_admin: isAdmin,
    });
    user = statements.findUserByPhone.get(phone);
  } else {
    statements.updateUserActivity.run({
      id: user.id,
      last_active_at: now,
      is_admin: isAdmin || user.is_admin ? 1 : 0,
    });
    user = statements.findUserByPhone.get(phone);
  }
  return user;
}

function buildAuthPayload(user) {
  const expiresAt = new Date(Date.now() + JWT_EXPIRE_HOURS * 60 * 60 * 1000).toISOString();
  const token = jwt.sign(
    {
      userId: user.id,
      phone: user.phone,
      isAdmin: Boolean(user.is_admin),
    },
    JWT_SECRET,
    { expiresIn: `${JWT_EXPIRE_HOURS}h` },
  );
  return {
    token,
    expiresAt,
    user: publicUser(user),
  };
}

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    maskedPhone: maskPhone(user.phone),
    createdAt: user.created_at,
    lastActiveAt: user.last_active_at,
    usageCount: Number(user.usage_count || 0),
    wechatAdded: Boolean(user.wechat_added),
    note: user.note || '',
    isAdmin: Boolean(user.is_admin),
  };
}

function guestUser() {
  const now = new Date().toISOString();
  return {
    id: 0,
    phone: 'guest',
    created_at: now,
    last_active_at: now,
    usage_count: 0,
    wechat_added: 0,
    note: '',
    is_admin: 0,
  };
}

function recordUsage(userId, action) {
  const now = new Date().toISOString();
  statements.insertUsageLog.run({
    user_id: userId,
    action,
    created_at: now,
  });
  if (action === 'pipeline_complete') {
    statements.incrementUsageCount.run({ id: userId, last_active_at: now });
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function createSmsClient() {
  if (!process.env.ALIYUN_ACCESS_KEY_ID || !process.env.ALIYUN_ACCESS_KEY_SECRET) {
    return null;
  }
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
  });
  config.endpoint = 'dysmsapi.aliyuncs.com';
  return new Dysmsapi.default(config);
}

// ── Audio Refine ─────────────────────────────────────────────────────────────
// In-memory job store for audio processing jobs.

const refineJobs = new Map();
const REFINE_JOB_TTL = 2 * 60 * 60 * 1000; // 2 hours
const REFINE_MAX_BYTES = 500 * 1024 * 1024;
const REFINE_MAX_ACTIVE_JOBS = Number(process.env.REFINE_MAX_ACTIVE_JOBS || 2);
const REFINE_MAX_ACTIVE_JOBS_PER_USER = Number(process.env.REFINE_MAX_ACTIVE_JOBS_PER_USER || 1);

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of refineJobs) {
    if (now - job.createdAt > REFINE_JOB_TTL) {
      try { if (job.inputPath && fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath); } catch {}
      try { if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch {}
      refineJobs.delete(id);
    }
  }
}, 20 * 60 * 1000);

async function handleRefine(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const user = requireAuth(req, res);
  if (!user) return;

  // POST /api/refine/start  — upload + kick off
  if (req.method === 'POST' && url.pathname === '/api/refine/start') {
    if (countActiveRefineJobs() >= REFINE_MAX_ACTIVE_JOBS) {
      sendJson(res, 429, { error: 'refine_busy', message: '当前精修任务较多，请稍后再试。' });
      return;
    }
    if (countActiveRefineJobs(user.id) >= REFINE_MAX_ACTIVE_JOBS_PER_USER) {
      sendJson(res, 429, { error: 'refine_user_busy', message: '你已有精修任务在处理中，请完成后再提交新的音频。' });
      return;
    }

    let parsed;
    try { parsed = await parseRefineUpload(req); }
    catch (e) { sendJson(res, 400, { error: e.message }); return; }

    const jobId = crypto.randomBytes(10).toString('hex');
    const jobsDir = path.join(__dirname, 'data', 'refine-jobs');
    ensureDir(jobsDir);
    const outPath = path.join(jobsDir, jobId + '_out.mp3');

    const job = {
      id: jobId,
      userId: user.id,
      stage: 'queued',
      progress: 0,
      log: [],
      inputPath: parsed.filePath,
      outputPath: outPath,
      filename: parsed.filename,
      normalizeLoudness: parsed.normalizeLoudness,
      denoise: parsed.denoise,
      voiceEnhance: parsed.voiceEnhance,
      targetLufs: parsed.targetLufs,
      durationSec: 0,
      createdAt: Date.now(),
      error: null,
    };
    refineJobs.set(jobId, job);

    // Run async
    (async () => {
      try {
        job.durationSec = await refineProbe(job.inputPath);
        await refineProcess(job);
        try { fs.unlinkSync(job.inputPath); } catch {}
      } catch (e) {
        job.stage = 'error';
        job.error = e.message;
        console.error('[refine]', jobId, e.message);
      }
    })();

    sendJson(res, 202, { jobId });
    return;
  }

  // GET /api/refine/status/:jobId
  if (req.method === 'GET' && url.pathname.startsWith('/api/refine/status/')) {
    const jobId = url.pathname.replace('/api/refine/status/', '');
    const job = refineJobs.get(jobId);
    if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    sendJson(res, 200, {
      jobId,
      status: job.stage === 'error' ? 'failed' : job.stage,
      stage: job.stage,
      step: job.stage === 'done' ? 'done' : 'processing',
      progress: job.progress,
      log: job.log,
      error: job.error || null,
      options: {
        normalizeLoudness: job.normalizeLoudness,
        denoise: job.denoise,
        voiceEnhance: job.voiceEnhance,
        targetLufs: job.targetLufs,
      },
    });
    return;
  }

  // GET /api/refine/download/:jobId
  if (req.method === 'GET' && url.pathname.startsWith('/api/refine/download/')) {
    const jobId = url.pathname.replace('/api/refine/download/', '');
    const job = refineJobs.get(jobId);
    if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    if (job.stage !== 'done') { sendJson(res, 409, { error: '文件尚未就绪' }); return; }
    if (!fs.existsSync(job.outputPath)) { sendJson(res, 410, { error: '文件已过期' }); return; }

    const basename = path.basename(job.filename, path.extname(job.filename));
    const dlName = encodeURIComponent(basename + '_精修版.mp3');
    const stat = fs.statSync(job.outputPath);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': `attachment; filename*=UTF-8''${dlName}`,
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    fs.createReadStream(job.outputPath).pipe(res);
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

function countActiveRefineJobs(userId) {
  let count = 0;
  for (const job of refineJobs.values()) {
    if (userId && job.userId !== userId) continue;
    if (['queued', 'measuring', 'normalizing', 'processing'].includes(job.stage)) count += 1;
  }
  return count;
}

function refineProbe(filePath) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', filePath]);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => resolve(parseFloat(out.trim()) || 0));
    p.on('error', () => resolve(0));
  });
}

function refineProcess(job) {
  return new Promise((resolve, reject) => {
    const filters = [];
    if (job.denoise) filters.push('afftdn=nf=-25');
    if (job.voiceEnhance) filters.push('acompressor=threshold=-18dB:ratio=2:attack=20:release=200');
    if (job.normalizeLoudness) filters.push(`loudnorm=I=${job.targetLufs}:TP=-1.5:LRA=11`);

    const audioFilter = filters.join(',');
    if (!audioFilter) return reject(new Error('未选择任何精修处理'));

    job.stage = 'processing';
    job.progress = 10;
    job.log.push(`正在处理: ${describeRefineJob(job).join('、')}`);

    const pass = spawn('ffmpeg', ['-i', job.inputPath, '-af', audioFilter, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', job.outputPath]);
    pass.stderr.on('data', d => {
      const line = d.toString();
      const t = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && job.durationSec > 0) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]);
        job.progress = Math.min(95, 10 + Math.round((elapsed / job.durationSec) * 85));
      }
    });
    pass.on('close', c => {
      if (c !== 0) return reject(new Error('ffmpeg 处理失败'));
      job.stage = 'done';
      job.progress = 100;
      job.log.push('处理完成');
      resolve();
    });
    pass.on('error', reject);
  });
}

function describeRefineJob(job) {
  const names = [];
  if (job.denoise) names.push('轻度降噪');
  if (job.voiceEnhance) names.push('人声增强');
  if (job.normalizeLoudness) names.push(`响度统一 ${job.targetLufs} LUFS`);
  return names;
}

function parseRefineUpload(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) return reject(new Error('缺少 boundary'));
    const boundary = '--' + bm[1].trim();
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > REFINE_MAX_BYTES) { req.destroy(); return reject(new Error('文件超过 500MB 限制')); }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const bndBuf = Buffer.from(boundary);
      let filePart = null, filename = 'audio.mp3';
      const fields = {
        normalizeLoudness: '1',
        denoise: '0',
        voiceEnhance: '0',
        targetLufs: '-16',
      };
      let pos = 0;
      while (true) {
        const bi = buf.indexOf(bndBuf, pos);
        if (bi < 0) break;
        const ps = bi + bndBuf.length + 2;
        const he = buf.indexOf('\r\n\r\n', ps);
        if (he < 0) break;
        const hdr = buf.slice(ps, he).toString();
        const nextBnd = buf.indexOf('\r\n' + boundary, he);
        const body = buf.slice(he + 4, nextBnd >= 0 ? nextBnd : buf.length);
        if (hdr.includes('filename=')) {
          const fn = hdr.match(/filename="([^"]+)"/);
          if (fn) filename = fn[1];
          filePart = body;
        } else {
          const nm = hdr.match(/name="([^"]+)"/);
          if (nm && Object.prototype.hasOwnProperty.call(fields, nm[1])) {
            fields[nm[1]] = body.toString().trim();
          }
        }
        pos = bi + bndBuf.length;
      }
      if (!filePart || filePart.length === 0) return reject(new Error('未收到音频文件'));
      const normalizeLoudness = parseRefineBoolean(fields.normalizeLoudness);
      const denoise = parseRefineBoolean(fields.denoise);
      const voiceEnhance = parseRefineBoolean(fields.voiceEnhance);
      const targetLufs = Number(fields.targetLufs);
      if (![-14, -16, -18].includes(targetLufs)) return reject(new Error('targetLufs 只允许 -14、-16、-18'));
      if (!normalizeLoudness && !denoise && !voiceEnhance) return reject(new Error('至少选择一个音频精修选项'));
      const ext = path.extname(filename).toLowerCase() || '.mp3';
      const tmpPath = path.join(os.tmpdir(), crypto.randomBytes(8).toString('hex') + ext);
      fs.writeFile(tmpPath, filePart, err => {
        if (err) return reject(err);
        resolve({ filePath: tmpPath, filename, normalizeLoudness, denoise, voiceEnhance, targetLufs });
      });
    });
    req.on('error', reject);
  });
}

function parseRefineBoolean(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

// ── End Audio Refine ──────────────────────────────────────────────────────────

async function sendSmsCode(phone, code) {
  if (!smsClient || !process.env.ALIYUN_SMS_SIGN || !process.env.ALIYUN_SMS_TEMPLATE) {
    if (!DEV_SEND_CODE_FALLBACK) {
      throw new Error('短信配置不完整：请先设置阿里云 AK/SK、短信签名和模板 ID。');
    }
    console.log(`[dev-sms] ${phone} => ${code}`);
    return {
      message: '开发模式：验证码已写入服务端日志。',
      devCode: code,
    };
  }

  const request = new Dysmsapi.SendSmsRequest({
    phoneNumbers: phone,
    signName: process.env.ALIYUN_SMS_SIGN,
    templateCode: process.env.ALIYUN_SMS_TEMPLATE,
    templateParam: JSON.stringify({ code }),
  });
  const runtime = new Util.RuntimeOptions({});
  const response = await smsClient.sendSmsWithOptions(request, runtime);
  const body = response.body || {};
  if (body.code !== 'OK') {
    throw new Error(`阿里云短信发送失败：${body.code || 'UNKNOWN'} ${body.message || ''}`.trim());
  }
  return { message: '验证码已发送。' };
}
