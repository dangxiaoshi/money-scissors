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
const PRACTICE_TEMPLATES = {
  launch: {
    id: 'launch-live-20260612',
    filePath: path.join(DATA_ROOT, 'practice-templates', 'launch-live-20260612.json'),
    fileName: 'D2 练习项目｜开营直播',
    existingKeyword: '开营直播',
  },
};
const PRIVATE_DATA_ROOT = process.env.PRIVATE_DATA_ROOT || path.join(path.dirname(__dirname), 'money-scissors-private');
const PROJECT_DATA_ROOT = process.env.PROJECT_DATA_ROOT || path.join(PRIVATE_DATA_ROOT, 'projects');
const SNAPSHOT_DATA_ROOT = process.env.SNAPSHOT_DATA_ROOT || path.join(PRIVATE_DATA_ROOT, 'snapshots');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_ROOT, 'users.db');
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 2 * 1024 * 1024);
const MAX_PROJECT_JSON_BYTES = Number(process.env.MAX_PROJECT_JSON_BYTES || 60 * 1024 * 1024);
const SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 60 * 1000);
const JWT_EXPIRE_HOURS = Number(process.env.JWT_EXPIRE_HOURS || 24 * 45);
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
ensureDir(PROJECT_DATA_ROOT);
ensureDir(SNAPSHOT_DATA_ROOT);

// 全局防崩兜底：脱离请求 try/catch 的后台异步（ffmpeg 子进程、转录轮询、
// fire-and-forget 的 Promise）一旦抛错，默认会让整个 Node 进程退出，导致
// 所有在线用户同时断线。这里接住它们：记录日志但不退出，保证“一个人的
// 错误不拖垮所有人”。已知任务级失败仍应由各自 handler 处理并提示用户。
function logCrash(kind, err) {
  const stamp = new Date().toISOString();
  const detail = err && err.stack ? err.stack : String(err);
  const line = `[${stamp}] ${kind}: ${detail}\n`;
  // 进 PM2 日志
  console.error(line);
  // 额外落盘，方便开营期间排查
  try {
    fs.appendFileSync(path.join(LOG_ROOT, 'crash.log'), line);
  } catch (_) {
    // 日志写入失败也不能反过来影响主服务
  }
}

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
  // 故意不 process.exit：宁可带着一个已记录的异常继续服务，也不要让
  // 单点错误把全站打挂。如未来要改成优雅重启，应先 drain 在途请求。
});

process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason);
});

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
    INSERT INTO users (phone, created_at, last_active_at, usage_count, wechat_added, note, is_admin, nickname)
    VALUES (@phone, @created_at, @last_active_at, 0, 0, '', @is_admin, '')
  `),
  updateNickname: db.prepare(`
    UPDATE users SET nickname = @nickname WHERE id = @id
  `),
  completeDay1: db.prepare(`
    UPDATE users SET day1_complete = 1, last_active_at = @last_active_at WHERE id = @id
  `),
  saveDay1Intro: db.prepare(`
    UPDATE users SET day1_complete = 1, day1_intro = @day1_intro, last_active_at = @last_active_at WHERE id = @id
  `),
  completeDay2: db.prepare(`
    UPDATE users SET day2_complete = 1, last_active_at = @last_active_at WHERE id = @id
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
    SELECT id, phone, created_at, last_active_at, usage_count, wechat_added, note, is_admin, nickname, day1_complete, day2_complete, day1_intro,
      (SELECT COUNT(*) FROM review_snapshots s WHERE s.user_id = users.id) AS snapshot_count,
      (SELECT COUNT(*) FROM review_snapshots s WHERE s.user_id = users.id AND s.status = 'pending_review') AS pending_count
    FROM users
    ORDER BY usage_count DESC, last_active_at DESC, created_at DESC
  `),
  listSnapshotsByUser: db.prepare(`
    SELECT s.id, s.project_id, s.user_id, s.file_name, s.audio_url, s.original_duration,
      s.roughcut_duration, s.removed_duration, s.status, s.created_at, s.reviewed_at,
      s.reviewed_by, u.phone
    FROM review_snapshots s
    JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `),
  updateAdminUser: db.prepare(`
    UPDATE users SET
      wechat_added = @wechat_added,
      note = @note,
      last_active_at = @last_active_at
    WHERE id = @id
  `),
  insertProject: db.prepare(`
    INSERT INTO editing_projects (
      id, user_id, file_name, audio_url, status, original_duration, roughcut_duration,
      removed_duration, data_path, created_at, updated_at, exported_at
    )
    VALUES (
      @id, @user_id, @file_name, @audio_url, @status, @original_duration, @roughcut_duration,
      @removed_duration, @data_path, @created_at, @updated_at, @exported_at
    )
  `),
  listProjectsByUser: db.prepare(`
    SELECT id, user_id, file_name, audio_url, status, original_duration, roughcut_duration,
      removed_duration, created_at, updated_at, exported_at
    FROM editing_projects
    WHERE user_id = @user_id
    ORDER BY updated_at DESC, created_at DESC
  `),
  findProjectById: db.prepare('SELECT * FROM editing_projects WHERE id = ?'),
  updateProject: db.prepare(`
    UPDATE editing_projects SET
      file_name = @file_name,
      audio_url = @audio_url,
      status = @status,
      original_duration = @original_duration,
      roughcut_duration = @roughcut_duration,
      removed_duration = @removed_duration,
      updated_at = @updated_at
    WHERE id = @id
  `),
  markProjectSubmitted: db.prepare(`
    UPDATE editing_projects SET
      status = 'pending_review',
      original_duration = @original_duration,
      roughcut_duration = @roughcut_duration,
      removed_duration = @removed_duration,
      updated_at = @updated_at,
      exported_at = @exported_at
    WHERE id = @id
  `),
  updateProjectReviewStatus: db.prepare(`
    UPDATE editing_projects SET
      status = @status,
      updated_at = @updated_at
    WHERE id = @id
  `),
  insertSnapshot: db.prepare(`
    INSERT INTO review_snapshots (
      id, project_id, user_id, file_name, audio_url, original_duration, roughcut_duration,
      removed_duration, data_path, status, created_at, reviewed_at, reviewed_by
    )
    VALUES (
      @id, @project_id, @user_id, @file_name, @audio_url, @original_duration, @roughcut_duration,
      @removed_duration, @data_path, @status, @created_at, @reviewed_at, @reviewed_by
    )
  `),
  listSnapshots: db.prepare(`
    SELECT s.id, s.project_id, s.user_id, s.file_name, s.audio_url, s.original_duration,
      s.roughcut_duration, s.removed_duration, s.status, s.created_at, s.reviewed_at,
      s.reviewed_by, u.phone
    FROM review_snapshots s
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC
  `),
  findSnapshotById: db.prepare('SELECT * FROM review_snapshots WHERE id = ?'),
  updateSnapshotStatus: db.prepare(`
    UPDATE review_snapshots SET
      status = @status,
      reviewed_at = @reviewed_at,
      reviewed_by = @reviewed_by
    WHERE id = @id
  `),

  listDispatchTasks: db.prepare('SELECT * FROM dispatch_tasks ORDER BY sort_order ASC, id DESC'),
  listPublishedDispatchTasks: db.prepare('SELECT * FROM dispatch_tasks WHERE published = 1 ORDER BY sort_order ASC, id DESC'),
  findDispatchTask: db.prepare('SELECT * FROM dispatch_tasks WHERE id = ?'),
  insertDispatchTask: db.prepare(`
    INSERT INTO dispatch_tasks (title, client, budget, demand, delivery, difficulty, material_link, published, sort_order, created_at, updated_at)
    VALUES (@title, @client, @budget, @demand, @delivery, @difficulty, @material_link, @published, @sort_order, @created_at, @updated_at)
  `),
  updateDispatchTask: db.prepare(`
    UPDATE dispatch_tasks
    SET title=@title, client=@client, budget=@budget, demand=@demand, delivery=@delivery,
        difficulty=@difficulty, material_link=@material_link, published=@published, sort_order=@sort_order, updated_at=@updated_at
    WHERE id=@id
  `),
  deleteDispatchTask: db.prepare('DELETE FROM dispatch_tasks WHERE id = ?'),
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

    if (url.pathname === '/api/orders/data') {
      await handleOrdersData(req, res);
      return;
    }

    if (url.pathname === '/api/orders/tasks' || url.pathname.startsWith('/api/orders/admin/')) {
      await handleDispatchTasks(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/api/projects')) {
      await handleProjects(req, res, url);
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

    if (url.pathname.startsWith('/api/cut/')) {
      await handleCut(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/api/audio/concat/')) {
      await handleConcat(req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      // 带 statusCode 的是各 handler 故意抛出的、面向用户的可读提示
      // （例如 413“文件超过 500MB”），可以原样返回。
      sendJson(res, error.statusCode, { error: 'bad_request', message: error.message });
    } else {
      // 未预期的异常：只回通用错误，绝不把 error.message（可能含路径、
      // key、内部细节）暴露给前端。完整堆栈只进服务端日志。
      sendJson(res, 500, { error: 'server_error', message: '服务暂时出错，请稍后重试' });
    }
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
    sendJson(res, 200, { ...auth, needsNickname: !user.nickname });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = requireAuth(req, res);
    if (!user) return;
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/set-nickname') {
    const user = requireAuth(req, res);
    if (!user) return;
    const body = await readJson(req);
    const nickname = String(body.nickname || '').trim();
    if (!nickname) {
      sendJson(res, 400, { error: 'empty_nickname', message: '请填写你的微信名。' });
      return;
    }
    if (nickname.length > 30) {
      sendJson(res, 400, { error: 'nickname_too_long', message: '微信名不能超过 30 个字。' });
      return;
    }
    statements.updateNickname.run({ id: user.id, nickname });
    const updated = statements.findUserById.get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/complete-day1') {
    const user = requireAuth(req, res);
    if (!user) return;
    const body = await readJson(req).catch(() => ({}));
    const intro = normalizeDay1Intro(body);
    if (intro) {
      statements.saveDay1Intro.run({
        id: user.id,
        day1_intro: JSON.stringify(intro),
        last_active_at: new Date().toISOString(),
      });
    } else {
      statements.completeDay1.run({
        id: user.id,
        last_active_at: new Date().toISOString(),
      });
    }
    const updated = statements.findUserById.get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
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
  if (!hasDay1Access(user)) {
    sendJson(res, 403, { error: 'day1_required', message: '请先完成第一天自我介绍作业，再进入剪辑台练习。' });
    return;
  }

  const body = await readJson(req);
  const action = String(body.action || '').trim();
  if (!['upload', 'transcribe', 'pipeline_complete', 'download'].includes(action)) {
    sendJson(res, 400, { error: 'invalid_action', message: '不支持的 usage action。' });
    return;
  }

  recordUsage(user.id, action);
  sendJson(res, 200, { ok: true });
}

async function handleOrdersData(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) return;
  if (!hasDay2Access(user)) {
    sendJson(res, 403, {
      error: 'day2_required',
      message: '请先完成第二天剪辑练习，并提交一次助教审核。',
    });
    return;
  }

  const dataPath = path.join(STATIC_ROOT, 'orders', 'data.json');
  const data = readJsonFile(dataPath, null);
  if (!data) {
    sendJson(res, 404, {
      error: 'orders_data_not_ready',
      message: '数据还没准备好，请稍后刷新。',
    });
    return;
  }
  sendJson(res, 200, data);
}

// ── 接单台后台：钱钱自己增删改/发布练习派单任务 ────────────────────────────────
function publicDispatchTask(row) {
  return {
    id: row.id,
    title: row.title,
    client: row.client,
    budget: row.budget,
    demand: row.demand,
    delivery: row.delivery,
    difficulty: row.difficulty,
    materialLink: row.material_link,
    published: Boolean(row.published),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dispatchRowToBody(row) {
  return {
    title: row.title,
    client: row.client,
    budget: row.budget,
    demand: row.demand,
    delivery: row.delivery,
    difficulty: row.difficulty,
    materialLink: row.material_link,
    published: row.published,
    sortOrder: row.sort_order,
  };
}

function readDispatchInput(body) {
  // 单行清洗，不注入默认值（空标题必须能被校验拦住）
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
  return {
    title: clean(body.title, 120),
    client: clean(body.client, 120),
    budget: clean(body.budget, 60),
    demand: String(body.demand == null ? '' : body.demand).slice(0, 4000),
    delivery: String(body.delivery == null ? '' : body.delivery).slice(0, 2000),
    difficulty: clean(body.difficulty, 40),
    material_link: clean(body.materialLink ?? body.material_link, 1000),
    published: body.published ? 1 : 0,
    sort_order: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
  };
}

async function handleDispatchTasks(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 学员端：只读已发布任务，需登录 + 完成 Day2
  if (url.pathname === '/api/orders/tasks') {
    const user = requireAuth(req, res);
    if (!user) return;
    if (!hasDay2Access(user)) {
      sendJson(res, 403, { error: 'day2_required', message: '请先完成第二天剪辑练习，并提交一次助教审核。' });
      return;
    }
    const tasks = statements.listPublishedDispatchTasks.all().map(publicDispatchTask);
    sendJson(res, 200, { tasks });
    return;
  }

  // 后台：仅管理员
  const admin = requireAdmin(req, res);
  if (!admin) return;

  // 导出备份（误删兜底）
  if (req.method === 'GET' && url.pathname === '/api/orders/admin/tasks.json') {
    const tasks = statements.listDispatchTasks.all().map(publicDispatchTask);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('接单任务备份.json')}`,
    });
    res.end(JSON.stringify({ exportedAt: new Date().toISOString(), tasks }, null, 2));
    return;
  }

  // 列表（含草稿）
  if (req.method === 'GET' && url.pathname === '/api/orders/admin/tasks') {
    const tasks = statements.listDispatchTasks.all().map(publicDispatchTask);
    sendJson(res, 200, { tasks });
    return;
  }

  // 新增
  if (req.method === 'POST' && url.pathname === '/api/orders/admin/tasks') {
    const body = await readJson(req);
    const input = readDispatchInput(body);
    if (!input.title) { sendJson(res, 400, { error: 'missing_title', message: '请填写任务标题。' }); return; }
    const now = new Date().toISOString();
    const info = statements.insertDispatchTask.run({ ...input, created_at: now, updated_at: now });
    const row = statements.findDispatchTask.get(info.lastInsertRowid);
    sendJson(res, 201, { task: publicDispatchTask(row) });
    return;
  }

  // 编辑 / 发布 / 隐藏 / 删除（/api/orders/admin/tasks/:id）
  const matched = url.pathname.match(/^\/api\/orders\/admin\/tasks\/(\d+)$/);
  if (matched) {
    const id = Number(matched[1]);
    const existing = statements.findDispatchTask.get(id);
    if (!existing) { sendJson(res, 404, { error: 'not_found', message: '任务不存在。' }); return; }

    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const input = readDispatchInput({ ...dispatchRowToBody(existing), ...body });
      if (!input.title) { sendJson(res, 400, { error: 'missing_title', message: '请填写任务标题。' }); return; }
      statements.updateDispatchTask.run({ ...input, id, updated_at: new Date().toISOString() });
      sendJson(res, 200, { task: publicDispatchTask(statements.findDispatchTask.get(id)) });
      return;
    }
    if (req.method === 'DELETE') {
      statements.deleteDispatchTask.run(id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function handleProjects(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const user = requireAuth(req, res);
  if (!user) return;
  if (!hasDay1Access(user)) {
    sendDay1Required(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const projects = statements.listProjectsByUser.all({ user_id: user.id }).map(publicProject);
    sendJson(res, 200, { projects });
    return;
  }

  const practiceMatch = url.pathname.match(/^\/api\/projects\/practice\/([A-Za-z0-9_-]+)$/);
  if (practiceMatch && req.method === 'POST') {
    const template = PRACTICE_TEMPLATES[practiceMatch[1]];
    if (!template) {
      sendJson(res, 404, { error: 'practice_not_found', message: '这条练习素材还没有准备好。' });
      return;
    }

    const existing = statements.listProjectsByUser
      .all({ user_id: user.id })
      .find((row) => String(row.file_name || '').includes(template.existingKeyword));
    if (existing) {
      sendJson(res, 200, { project: publicProject(existing), reused: true });
      return;
    }

    const sourcePayload = readJsonFile(template.filePath, null);
    if (!sourcePayload || !Array.isArray(sourcePayload.S)) {
      sendJson(res, 500, { error: 'practice_template_missing', message: '练习母版还没有生成成功，请稍后再试。' });
      return;
    }

    const now = new Date().toISOString();
    const id = buildPublicId('proj');
    const dataPath = path.join(PROJECT_DATA_ROOT, `${id}.json`);
    const payload = JSON.parse(JSON.stringify(sourcePayload));
    payload.projectId = id;
    payload.createdAt = now;
    payload.fileName = template.fileName;
    payload.practiceTemplate = {
      ...(payload.practiceTemplate || {}),
      id: template.id,
      copiedAt: now,
    };

    const metrics = readProjectMetrics(payload, {
      originalDuration: sourcePayload.originalDuration,
    });
    const audioUrl = String(payload.audioUrl || '').trim();

    writeJsonFile(dataPath, {
      id,
      userId: user.id,
      fileName: template.fileName,
      audioUrl,
      payload,
      createdAt: now,
      updatedAt: now,
    });
    statements.insertProject.run({
      id,
      user_id: user.id,
      file_name: template.fileName,
      audio_url: audioUrl,
      status: 'draft',
      original_duration: metrics.originalDuration,
      roughcut_duration: metrics.roughcutDuration,
      removed_duration: metrics.removedDuration,
      data_path: dataPath,
      created_at: now,
      updated_at: now,
      exported_at: null,
    });
    sendJson(res, 201, { project: publicProject(statements.findProjectById.get(id)), reused: false });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    const body = await readJson(req, MAX_PROJECT_JSON_BYTES);
    const payload = normalizeProjectPayload(body.payload);
    const now = new Date().toISOString();
    const id = buildPublicId('proj');
    const dataPath = path.join(PROJECT_DATA_ROOT, `${id}.json`);
    const metrics = readProjectMetrics(payload, body.metrics);
    const fileName = cleanTitle(body.fileName || payload.fileName || '未命名音频', 180);
    const audioUrl = String(body.audioUrl || payload.audioUrl || '').trim();

    writeJsonFile(dataPath, {
      id,
      userId: user.id,
      fileName,
      audioUrl,
      payload,
      createdAt: now,
      updatedAt: now,
    });
    statements.insertProject.run({
      id,
      user_id: user.id,
      file_name: fileName,
      audio_url: audioUrl,
      status: 'draft',
      original_duration: metrics.originalDuration,
      roughcut_duration: metrics.roughcutDuration,
      removed_duration: metrics.removedDuration,
      data_path: dataPath,
      created_at: now,
      updated_at: now,
      exported_at: null,
    });
    sendJson(res, 201, { project: publicProject(statements.findProjectById.get(id)) });
    return;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)$/);
  if (projectMatch && req.method === 'GET') {
    const project = loadAuthorizedProject(projectMatch[1], user, res);
    if (!project) return;
    sendJson(res, 200, { project: publicProject(project.row), payload: project.data.payload });
    return;
  }

  if (projectMatch && (req.method === 'PATCH' || req.method === 'POST')) {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    const project = loadAuthorizedProject(projectMatch[1], user, res);
    if (!project) return;
    const body = await readJson(req, MAX_PROJECT_JSON_BYTES);
    const payload = normalizeProjectPayload(body.payload);
    const now = new Date().toISOString();
    const metrics = readProjectMetrics(payload, body.metrics);
    const fileName = cleanTitle(body.fileName || payload.fileName || project.row.file_name || '未命名音频', 180);
    const audioUrl = String(body.audioUrl || payload.audioUrl || project.row.audio_url || '').trim();
    const currentStatus = String(project.row.status || 'draft');
    const status = isReviewLockedProjectStatus(currentStatus)
      ? currentStatus
      : body.status === 'draft'
        ? 'draft'
        : currentStatus;

    writeJsonFile(project.row.data_path, {
      ...project.data,
      fileName,
      audioUrl,
      payload,
      updatedAt: now,
    });
    statements.updateProject.run({
      id: project.row.id,
      file_name: fileName,
      audio_url: audioUrl,
      status,
      original_duration: metrics.originalDuration,
      roughcut_duration: metrics.roughcutDuration,
      removed_duration: metrics.removedDuration,
      updated_at: now,
    });
    sendJson(res, 200, { project: publicProject(statements.findProjectById.get(project.row.id)) });
    return;
  }

  const snapshotMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/snapshots$/);
  if (snapshotMatch && req.method === 'POST') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    const project = loadAuthorizedProject(snapshotMatch[1], user, res);
    if (!project) return;
    const body = await readJson(req, MAX_PROJECT_JSON_BYTES);
    const payload = normalizeProjectPayload(body.payload || project.data.payload);
    const now = new Date().toISOString();
    const metrics = readProjectMetrics(payload, body.metrics);
    const fileName = cleanTitle(body.fileName || payload.fileName || project.row.file_name || '未命名音频', 180);
    const audioUrl = String(body.audioUrl || payload.audioUrl || project.row.audio_url || '').trim();
    const snapshotId = buildPublicId('snap');
    const dataPath = path.join(SNAPSHOT_DATA_ROOT, `${snapshotId}.json`);

    writeJsonFile(dataPath, {
      id: snapshotId,
      projectId: project.row.id,
      userId: project.row.user_id,
      fileName,
      audioUrl,
      payload,
      cutPayload: body.cutPayload || null,
      metrics,
      status: 'pending_review',
      createdAt: now,
      reviewedAt: null,
      reviewedBy: null,
    });
    statements.insertSnapshot.run({
      id: snapshotId,
      project_id: project.row.id,
      user_id: project.row.user_id,
      file_name: fileName,
      audio_url: audioUrl,
      original_duration: metrics.originalDuration,
      roughcut_duration: metrics.roughcutDuration,
      removed_duration: metrics.removedDuration,
      data_path: dataPath,
      status: 'pending_review',
      created_at: now,
      reviewed_at: null,
      reviewed_by: null,
    });
    statements.markProjectSubmitted.run({
      id: project.row.id,
      original_duration: metrics.originalDuration,
      roughcut_duration: metrics.roughcutDuration,
      removed_duration: metrics.removedDuration,
      updated_at: now,
      exported_at: now,
    });
    statements.completeDay2.run({
      id: project.row.user_id,
      last_active_at: now,
    });
    sendJson(res, 201, { snapshot: publicSnapshot(statements.findSnapshotById.get(snapshotId)) });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
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

  if (req.method === 'GET' && url.pathname === '/api/admin/snapshots') {
    const snapshots = statements.listSnapshots.all().map(publicSnapshot);
    sendJson(res, 200, { snapshots });
    return;
  }

  const userSnapMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/snapshots$/);
  if (req.method === 'GET' && userSnapMatch) {
    const snapshots = statements.listSnapshotsByUser.all(Number(userSnapMatch[1])).map(publicSnapshot);
    sendJson(res, 200, { snapshots });
    return;
  }

  const snapshotMatch = url.pathname.match(/^\/api\/admin\/snapshots\/([A-Za-z0-9_-]+)$/);
  if (snapshotMatch && req.method === 'GET') {
    const row = statements.findSnapshotById.get(snapshotMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: 'snapshot_not_found', message: '没有找到这份审核快照。' });
      return;
    }
    const data = readJsonFile(row.data_path, {});
    sendJson(res, 200, { snapshot: publicSnapshot(row), payload: data.payload, cutPayload: data.cutPayload || null });
    return;
  }

  if (snapshotMatch && req.method === 'PATCH') {
    const row = statements.findSnapshotById.get(snapshotMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: 'snapshot_not_found', message: '没有找到这份审核快照。' });
      return;
    }
    const body = await readJson(req);
    const status = normalizeReviewStatus(body.status);
    if (!status) {
      sendJson(res, 400, { error: 'invalid_status', message: '审核状态只能是待审核、通过或打回。' });
      return;
    }
    const now = new Date().toISOString();
    const reviewedAt = status === 'pending_review' ? null : now;
    const reviewedBy = status === 'pending_review' ? null : user.id;
    statements.updateSnapshotStatus.run({
      id: row.id,
      status,
      reviewed_at: reviewedAt,
      reviewed_by: reviewedBy,
    });
    statements.updateProjectReviewStatus.run({
      id: row.project_id,
      status,
      updated_at: now,
    });
    const data = readJsonFile(row.data_path, {});
    writeJsonFile(row.data_path, {
      ...data,
      status,
      reviewedAt,
      reviewedBy,
    });
    sendJson(res, 200, { snapshot: publicSnapshot(statements.findSnapshotById.get(row.id)) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/users.csv') {
    const rows = statements.listUsers.all();
    const csv = [
      ['手机号', '微信名', '注册时间', '最后活跃', '使用次数', 'D1作业', 'D2作业', '已加微信', '备注', '管理员'].join(','),
      ...rows.map((row) => [
        csvCell(row.phone),
        csvCell(row.nickname || ''),
        csvCell(row.created_at),
        csvCell(row.last_active_at),
        row.usage_count,
        row.day1_complete ? '已完成' : '未完成',
        row.day2_complete ? '已完成' : '未完成',
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
  if (!hasDay1Access(user)) {
    sendJson(res, 403, { error: 'day1_required', message: '请先完成第一天自我介绍作业，再进入剪辑台练习。' });
    return;
  }

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
  if (!hasDay1Access(user)) {
    sendJson(res, 403, { error: 'day1_required', message: '请先完成第一天自我介绍作业，再进入剪辑台练习。' });
    return;
  }

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
  if (!hasDay1Access(user)) {
    sendJson(res, 403, { error: 'day1_required', message: '请先完成第一天自我介绍作业，再进入剪辑台练习。' });
    return;
  }
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
  }, {
    timeoutMs: DEEPSEEK_TIMEOUT_MS,
    timeoutMessage: 'AI 服务等待超时，请稍后重试。',
    errorMessage: 'AI 服务暂时不可用，请稍后重试。',
  });
}

async function serveStatic(req, res, url) {
  const aliasedPath = resolveStaticAlias(url.pathname);
  const pathname = decodeURIComponent(aliasedPath);
  const normalizedPathname = path.posix.normalize(pathname);
  if (normalizedPathname === '/data' || normalizedPathname.startsWith('/data/')) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (normalizedPathname === '/orders/data.json') {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const file = path.normalize(path.join(STATIC_ROOT, normalizedPathname));
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
  const isCutPage = pathname === '/cut.html' || pathname === '/cut';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    ...(isCutPage && {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    }),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

async function proxyJson(res, url, options = {}, settings = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(settings.timeoutMs || 30 * 1000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(url, { ...options, signal: controller.signal });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(text);
  } catch (error) {
    if (error?.name === 'AbortError') {
      sendJson(res, 504, {
        error: 'upstream_timeout',
        message: settings.timeoutMessage || '外部服务等待超时，请稍后重试。',
      });
      return;
    }
    console.error(error);
    sendJson(res, 502, {
      error: 'upstream_error',
      message: settings.errorMessage || '外部服务暂时不可用，请稍后重试。',
    });
  } finally {
    clearTimeout(timer);
  }
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
  if (pathname === '/projects') return '/projects.html';
  if (pathname === '/edit' || pathname === '/edit/') return '/edit.html';
  if (pathname === '/privacy') return '/privacy.html';
  if (pathname === '/hub' || pathname === '/hub.html') return '/hub.html';
  if (pathname === '/training' || pathname === '/training/') return '/training/index.html';
  if (pathname === '/orders' || pathname === '/orders/') return '/orders/index.html';
  if (pathname === '/orders/admin' || pathname === '/orders/admin/') return '/orders-admin.html';
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
      is_admin INTEGER NOT NULL DEFAULT 0,
      nickname TEXT NOT NULL DEFAULT '',
      day1_complete INTEGER NOT NULL DEFAULT 0,
      day2_complete INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS editing_projects (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      audio_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      original_duration INTEGER NOT NULL DEFAULT 0,
      roughcut_duration INTEGER NOT NULL DEFAULT 0,
      removed_duration INTEGER NOT NULL DEFAULT 0,
      data_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exported_at TEXT
    );

    CREATE TABLE IF NOT EXISTS review_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      audio_url TEXT NOT NULL DEFAULT '',
      original_duration INTEGER NOT NULL DEFAULT 0,
      roughcut_duration INTEGER NOT NULL DEFAULT 0,
      removed_duration INTEGER NOT NULL DEFAULT 0,
      data_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_editing_projects_user_updated
      ON editing_projects(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_snapshots_created
      ON review_snapshots(created_at DESC);

    CREATE TABLE IF NOT EXISTS dispatch_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL DEFAULT '',
      budget TEXT NOT NULL DEFAULT '',
      demand TEXT NOT NULL DEFAULT '',
      delivery TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL DEFAULT '',
      material_link TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_pub
      ON dispatch_tasks(published, sort_order, id DESC);
  `);
  try { database.exec(`ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day1_complete INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day2_complete INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day1_intro TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_review'`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN reviewed_at TEXT`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN reviewed_by INTEGER`); } catch {}
  database.exec(`
    UPDATE users
    SET day1_complete = 1,
        day2_complete = 1
    WHERE day2_complete = 0
      AND (
        EXISTS (
          SELECT 1
          FROM review_snapshots
          WHERE review_snapshots.user_id = users.id
        )
        OR EXISTS (
          SELECT 1
          FROM editing_projects
          WHERE editing_projects.user_id = users.id
            AND editing_projects.status IN ('pending_review', 'approved', 'rejected', 'exported')
        )
      );
  `);
}

function requireAuth(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (AUTH_DISABLED && !token) {
    return guestUser();
  }
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

function normalizeDay1Intro(body) {
  if (!body || typeof body !== 'object') return null;
  const cap = (v) => String(v == null ? '' : v).trim().slice(0, 1000);
  const nickname = cap(body.nickname).slice(0, 60);
  const fields = [body.field1, body.field2, body.field3, body.field4].map(cap);
  if (!nickname && fields.every((f) => !f)) return null;
  return { nickname, fields, savedAt: new Date().toISOString() };
}

function parseDay1Intro(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const fields = Array.isArray(obj.fields) ? obj.fields.slice(0, 4).map((f) => String(f || '')) : [];
    const nickname = String(obj.nickname || '');
    if (!nickname && !fields.some(Boolean)) return null;
    return { nickname, fields, savedAt: obj.savedAt || null };
  } catch {
    return null;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    maskedPhone: maskPhone(user.phone),
    nickname: user.nickname || '',
    createdAt: user.created_at,
    lastActiveAt: user.last_active_at,
    usageCount: Number(user.usage_count || 0),
    wechatAdded: Boolean(user.wechat_added),
    note: user.note || '',
    isAdmin: Boolean(user.is_admin),
    day1Complete: Boolean(user.day1_complete),
    day2Complete: Boolean(user.day2_complete),
    day1Intro: parseDay1Intro(user.day1_intro),
    snapshotCount: Number(user.snapshot_count || 0),
    pendingReviewCount: Number(user.pending_count || 0),
  };
}

function hasDay1Access(user) {
  return Boolean(AUTH_DISABLED || user?.is_admin || user?.day1_complete);
}

function hasDay2Access(user) {
  return Boolean(AUTH_DISABLED || user?.is_admin || user?.day2_complete);
}

function sendDay1Required(res) {
  sendJson(res, 403, { error: 'day1_required', message: '请先完成第一天自我介绍作业，再进入剪辑台练习。' });
}

function publicProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: Number(row.user_id || 0),
    fileName: row.file_name || '未命名音频',
    audioUrl: row.audio_url || '',
    status: row.status || 'draft',
    originalDuration: Number(row.original_duration || 0),
    roughcutDuration: Number(row.roughcut_duration || 0),
    removedDuration: Number(row.removed_duration || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    exportedAt: row.exported_at || null,
  };
}

function publicSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    userId: Number(row.user_id || 0),
    editorPhone: row.phone ? maskPhone(row.phone) : '',
    fileName: row.file_name || '未命名音频',
    audioUrl: row.audio_url || '',
    status: row.status || 'pending_review',
    originalDuration: Number(row.original_duration || 0),
    roughcutDuration: Number(row.roughcut_duration || 0),
    removedDuration: Number(row.removed_duration || 0),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
  };
}

function normalizeReviewStatus(value) {
  const status = String(value || '').trim();
  if (['pending_review', 'approved', 'rejected'].includes(status)) return status;
  if (status === '待审核') return 'pending_review';
  if (status === '通过' || status === '已通过') return 'approved';
  if (status === '打回' || status === '已打回') return 'rejected';
  return '';
}

function isReviewLockedProjectStatus(status) {
  return ['pending_review', 'approved', 'rejected', 'exported'].includes(String(status || ''));
}

function loadAuthorizedProject(id, user, res) {
  const row = statements.findProjectById.get(id);
  if (!row) {
    sendJson(res, 404, { error: 'project_not_found', message: '没有找到这个项目。' });
    return null;
  }
  const isOwner = Number(row.user_id) === Number(user.id);
  const isAdmin = Boolean(user.is_admin) || ADMIN_PHONES.has(user.phone);
  if (!isOwner && !isAdmin) {
    sendJson(res, 403, { error: 'forbidden', message: '你不能打开别人的项目。' });
    return null;
  }
  return { row, data: readJsonFile(row.data_path, {}) };
}

function normalizeProjectPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('缺少项目数据。');
    error.statusCode = 400;
    throw error;
  }
  return payload;
}

function readProjectMetrics(payload, metrics = {}) {
  const sentenceDuration = Array.isArray(payload.S) && payload.S.length
    ? Math.round(Number(payload.S[payload.S.length - 1]?.e || 0))
    : 0;
  return {
    originalDuration: Math.max(0, Math.round(Number(metrics.originalDuration ?? metrics.original_duration ?? sentenceDuration) || 0)),
    roughcutDuration: Math.max(0, Math.round(Number(metrics.roughcutDuration ?? metrics.roughcut_duration ?? 0) || 0)),
    removedDuration: Math.max(0, Math.round(Number(metrics.removedDuration ?? metrics.removed_duration ?? 0) || 0)),
  };
}

function buildPublicId(prefix) {
  const random = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `${prefix}_${random.replace(/-/g, '').slice(0, 20)}`;
}

function cleanTitle(value, maxLength) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength) || '未命名音频';
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data)}\n`);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
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
    nickname: '',
    day1_complete: 0,
    day2_complete: 0,
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

// ── Audio Cut ────────────────────────────────────────────────────────────────

const cutJobs = new Map();
const CUT_JOB_TTL = 2 * 60 * 60 * 1000;
const CUT_MAX_ACTIVE_JOBS = Number(process.env.CUT_MAX_ACTIVE_JOBS || 2);
const CUT_MAX_ACTIVE_JOBS_PER_USER = Number(process.env.CUT_MAX_ACTIVE_JOBS_PER_USER || 1);

setInterval(() => cleanupAudioJobs(cutJobs, CUT_JOB_TTL), 20 * 60 * 1000);

async function handleCut(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'POST' && url.pathname === '/api/cut/start') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    if (countActiveCutJobs() >= CUT_MAX_ACTIVE_JOBS) {
      sendJson(res, 429, { error: 'cut_busy', message: '当前剪辑任务较多，请稍后再试。' });
      return;
    }
    if (countActiveCutJobs(user.id) >= CUT_MAX_ACTIVE_JOBS_PER_USER) {
      sendJson(res, 429, { error: 'cut_user_busy', message: '你已有剪辑任务在处理中，请完成后再提交新的音频。' });
      return;
    }

    const body = await readJson(req, MAX_PROJECT_JSON_BYTES);
    const audioUrl = String(body.audioUrl || '').trim();
    const segments = Array.isArray(body.segments) ? body.segments : [];
    if (!audioUrl) {
      sendJson(res, 400, { error: 'missing_audio_url', message: '缺少原始音频 URL，请从审查页重新导出。' });
      return;
    }
    let audioSource;
    try {
      audioSource = resolveTrustedAudioInput(audioUrl, req);
    } catch (error) {
      sendJson(res, 400, { error: 'invalid_audio_url', message: error.message || '原始音频地址无效。' });
      return;
    }

    const jobId = crypto.randomBytes(10).toString('hex');
    const jobsDir = path.join(DATA_ROOT, 'cut-jobs');
    ensureDir(jobsDir);
    const inputPath = path.join(jobsDir, `${jobId}_input${getAudioExt(body.fileName || 'audio.mp3', '')}`);
    const outputPath = path.join(jobsDir, `${jobId}_out.mp3`);
    const job = {
      id: jobId,
      userId: user.id,
      stage: 'queued',
      progress: 0,
      inputPath,
      outputPath,
      filename: cleanTitle(body.fileName || 'podcast.mp3', 180),
      audioUrl,
      audioSource,
      segments,
      originalDuration: Number(body.originalDuration || body.original_duration || 0),
      createdAt: Date.now(),
      error: null,
    };
    cutJobs.set(jobId, job);

    (async () => {
      try {
        await cutDownloadInput(job);
        await cutProcess(job);
        try { fs.unlinkSync(job.inputPath); } catch {}
      } catch (error) {
        job.stage = 'error';
        job.error = error.message || String(error);
        console.error('[cut]', jobId, job.error);
      }
    })();

    sendJson(res, 202, { jobId });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/cut/status/')) {
    const jobId = url.pathname.replace('/api/cut/status/', '');
    const job = cutJobs.get(jobId);
    if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    sendJson(res, 200, {
      jobId,
      status: job.stage === 'error' ? 'failed' : job.stage,
      stage: job.stage,
      progress: job.progress,
      error: job.error || null,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/cut/download/')) {
    const jobId = url.pathname.replace('/api/cut/download/', '');
    const job = cutJobs.get(jobId);
    if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    if (job.stage !== 'done') { sendJson(res, 409, { error: '文件尚未就绪' }); return; }
    if (!fs.existsSync(job.outputPath)) { sendJson(res, 410, { error: '文件已过期' }); return; }

    const basename = path.basename(job.filename, path.extname(job.filename));
    const dlName = encodeURIComponent(`${basename}_精剪版.mp3`);
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

function countActiveCutJobs(userId) {
  let count = 0;
  for (const job of cutJobs.values()) {
    if (userId && job.userId !== userId) continue;
    if (['queued', 'downloading', 'processing'].includes(job.stage)) count += 1;
  }
  return count;
}

async function cutDownloadInput(job) {
  job.stage = 'downloading';
  job.progress = 5;
  if (job.audioSource?.type === 'file') {
    if (!fs.existsSync(job.audioSource.filePath)) throw new Error('原始音频文件不存在，请重新上传。');
    fs.copyFileSync(job.audioSource.filePath, job.inputPath);
    job.progress = 20;
    return;
  }
  if (job.audioUrl.startsWith('data:audio/')) {
    const match = job.audioUrl.match(/^data:audio\/[^;]+;base64,(.+)$/);
    if (!match) throw new Error('音频数据格式不正确。');
    fs.writeFileSync(job.inputPath, Buffer.from(match[1], 'base64'));
    job.progress = 20;
    return;
  }
  throw new Error('请使用剪辑台上传生成的音频地址。');
}

function resolveTrustedAudioInput(audioUrl, req) {
  if (audioUrl.startsWith('data:audio/')) return { type: 'data' };
  let parsed;
  try {
    parsed = new URL(audioUrl, `http://${req.headers.host}`);
  } catch {
    throw new Error('原始音频地址无效。');
  }

  const allowedOrigins = new Set([
    `http://${req.headers.host}`,
    `https://${req.headers.host}`,
  ]);
  if (PUBLIC_BASE_URL) {
    try { allowedOrigins.add(new URL(PUBLIC_BASE_URL).origin); } catch {}
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error('请使用剪辑台上传生成的音频地址。');
  }

  const normalizedPathname = path.posix.normalize(decodeURIComponent(parsed.pathname));
  if (!normalizedPathname.startsWith('/uploads/')) {
    throw new Error('请使用剪辑台上传生成的音频地址。');
  }
  const filePath = path.normalize(path.join(STATIC_ROOT, normalizedPathname));
  if (!filePath.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error('原始音频地址无效。');
  }
  return { type: 'file', filePath };
}

async function writeFetchBody(response, filePath, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('无法读取原始音频。');

  const output = fs.createWriteStream(filePath);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('文件超过 500MB，请压缩或裁剪后上传。');
      if (!output.write(Buffer.from(value))) {
        await new Promise((resolve, reject) => {
          output.once('drain', resolve);
          output.once('error', reject);
        });
      }
    }
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(filePath); } catch {}
    throw error;
  }

  await new Promise((resolve, reject) => {
    output.end(resolve);
    output.once('error', reject);
  });
}

async function cutProcess(job) {
  job.stage = 'processing';
  job.progress = 25;
  const duration = job.originalDuration > 0 ? job.originalDuration : await refineProbe(job.inputPath);
  const keepSegments = invertCutSegments(job.segments, duration);
  if (!keepSegments.length) throw new Error('所有音频都被标记删除了，无法生成成品。');
  const args = buildServerCutArgs(keepSegments);

  await new Promise((resolve, reject) => {
    const pass = spawn('ffmpeg', ['-i', job.inputPath, ...args, '-y', job.outputPath]);
    pass.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      const t = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && duration > 0) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]);
        job.progress = Math.min(95, 25 + Math.round((elapsed / duration) * 70));
      }
    });
    pass.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg 剪辑失败'));
      job.stage = 'done';
      job.progress = 100;
      resolve();
    });
    pass.on('error', reject);
  });
}

function buildServerCutArgs(keepSegments) {
  if (keepSegments.length === 1 && keepSegments[0].start <= 0.001) {
    const args = [];
    if (Number.isFinite(keepSegments[0].end) && keepSegments[0].end > 0) {
      args.push('-t', String(keepSegments[0].end));
    }
    return [...args, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
  }

  const trims = keepSegments
    .map((seg, index) => `[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS[a${index}]`)
    .join(';');
  const concatInputs = keepSegments.map((_, index) => `[a${index}]`).join('');
  const filter = `${trims};${concatInputs}concat=n=${keepSegments.length}:v=0:a=1[out]`;
  return ['-filter_complex', filter, '-map', '[out]', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
}

function invertCutSegments(segments, duration) {
  const total = Number(duration) || 0;
  const sorted = segments
    .map((segment) => ({
      start: clampNumber(Number(segment.start) || 0, 0, total),
      end: clampNumber(Number(segment.end) || 0, 0, total),
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  if (!sorted.length) return [{ start: 0, end: total || Number.POSITIVE_INFINITY }];

  const keep = [];
  let cursor = 0;
  sorted.forEach((segment) => {
    if (segment.start - cursor > 0.04) keep.push({ start: round3(cursor), end: round3(segment.start) });
    cursor = Math.max(cursor, segment.end);
  });
  if (total - cursor > 0.04) keep.push({ start: round3(cursor), end: round3(total) });
  return keep;
}

// ── Multi-audio concat（按用户排好的顺序把多个上传音频拼成一个 MP3） ──────────
const concatJobs = new Map();
const CONCAT_MAX_SOURCES = Number(process.env.CONCAT_MAX_SOURCES || 10);

setInterval(() => cleanupAudioJobRecords(concatJobs, CUT_JOB_TTL), 20 * 60 * 1000);

async function handleConcat(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'POST' && url.pathname === '/api/audio/concat/start') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    if (countActiveConcatJobs(user.id) >= 1) {
      sendJson(res, 429, { error: 'concat_user_busy', message: '你已有一个音频拼接任务在处理，请稍候。' });
      return;
    }
    const body = await readJson(req, MAX_PROJECT_JSON_BYTES);
    const sources = Array.isArray(body.sources) ? body.sources : [];
    if (sources.length < 2) {
      sendJson(res, 400, { error: 'need_two_sources', message: '至少需要两个音频才能拼接。' });
      return;
    }
    if (sources.length > CONCAT_MAX_SOURCES) {
      sendJson(res, 400, { error: 'too_many_sources', message: `一次最多拼接 ${CONCAT_MAX_SOURCES} 个音频，请减少后再试。` });
      return;
    }

    const inputs = [];
    for (let i = 0; i < sources.length; i += 1) {
      const u = String(sources[i]?.url || '').trim();
      let src;
      try {
        src = resolveTrustedAudioInput(u, req);
      } catch (error) {
        sendJson(res, 400, { error: 'invalid_source', message: `第 ${i + 1} 个音频地址无效，请重新上传该文件。` });
        return;
      }
      if (src.type !== 'file' || !fs.existsSync(src.filePath)) {
        sendJson(res, 400, { error: 'source_missing', message: `第 ${i + 1} 个音频文件不存在，请重新上传该文件。` });
        return;
      }
      inputs.push(src.filePath);
    }

    const jobId = crypto.randomBytes(10).toString('hex');
    const date = isoDay();
    const outDir = path.join(UPLOAD_ROOT, date);
    ensureDir(outDir);
    const basename = `${Date.now()}-${jobId}_merged.mp3`;
    const outputPath = path.join(outDir, basename);
    const publicPath = `/uploads/${date}/${basename}`;
    const baseUrl = PUBLIC_BASE_URL || `http://${req.headers.host}`;
    const job = {
      id: jobId,
      userId: user.id,
      stage: 'queued',
      progress: 0,
      inputs,
      outputPath,
      audioUrl: `${baseUrl}${publicPath}`,
      createdAt: Date.now(),
      error: null,
    };
    concatJobs.set(jobId, job);

    (async () => {
      try {
        await concatProcess(job);
      } catch (error) {
        job.stage = 'error';
        job.error = error.message || String(error);
        console.error('[concat]', jobId, job.error);
      }
    })();

    sendJson(res, 202, { jobId });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/audio/concat/status/')) {
    const jobId = url.pathname.replace('/api/audio/concat/status/', '');
    const job = concatJobs.get(jobId);
    if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    sendJson(res, 200, {
      jobId,
      status: job.stage === 'error' ? 'failed' : job.stage,
      stage: job.stage,
      progress: job.progress,
      audioUrl: job.stage === 'done' ? job.audioUrl : null,
      error: job.error || null,
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

function countActiveConcatJobs(userId) {
  let count = 0;
  for (const job of concatJobs.values()) {
    if (userId && job.userId !== userId) continue;
    if (['queued', 'processing'].includes(job.stage)) count += 1;
  }
  return count;
}

async function concatProcess(job) {
  job.stage = 'processing';
  job.progress = 5;

  let totalDur = 0;
  for (const f of job.inputs) totalDur += await refineProbe(f);

  // 统一把每个输入重采样到 44.1k 立体声再 concat，规避不同格式/采样率拼接报错
  const args = [];
  job.inputs.forEach((f) => { args.push('-i', f); });
  const norm = job.inputs
    .map((_, i) => `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`)
    .join(';');
  const concatInputs = job.inputs.map((_, i) => `[a${i}]`).join('');
  const filter = `${norm};${concatInputs}concat=n=${job.inputs.length}:v=0:a=1[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-y', job.outputPath);

  await new Promise((resolve, reject) => {
    const pass = spawn('ffmpeg', args);
    pass.stderr.on('data', (chunk) => {
      const t = chunk.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && totalDur > 0) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]);
        job.progress = Math.min(95, 5 + Math.round((elapsed / totalDur) * 90));
      }
    });
    pass.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg 音频拼接失败'));
      job.stage = 'done';
      job.progress = 100;
      resolve();
    });
    pass.on('error', reject);
  });
}

function cleanupAudioJobs(jobs, ttl) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt <= ttl) continue;
    try { if (job.inputPath && fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath); } catch {}
    try { if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch {}
    jobs.delete(id);
  }
}

function cleanupAudioJobRecords(jobs, ttl) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > ttl) jobs.delete(id);
  }
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
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
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
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
