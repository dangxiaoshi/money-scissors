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
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const oss = require('./lib/oss.cjs');

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
// 安全默认：鉴权默认开启，只有显式设置 AUTH_DISABLED=1 才关闭。
// （旧逻辑是 !== '0'，默认关闭鉴权，env 一旦漏配=全站后台裸奔、人人是管理员；
//   2026-06-16 改为安全默认：漏配=锁上而不是大开。要关必须明写 =1。）
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
const DEV_SEND_CODE_FALLBACK = process.env.ALLOW_DEV_SEND_CODE_FALLBACK === '1';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/g, '');
const AUTH_COOKIE_NAME = 'jinqian_token';
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
if (oss.isOssEnabled()) {
  try {
    oss.validateConfig();
  } catch (error) {
    console.error(`OSS 配置自检失败：${error.message || error}`);
    process.exit(1);
  }
}
// 启动自检：鉴权一旦处于关闭状态，打一条非常醒目的告警，避免“悄无声息地裸奔”。
if (AUTH_DISABLED) {
  console.error('\n' + '='.repeat(60));
  console.error('⚠️  警告：鉴权已关闭 (AUTH_DISABLED=1)！全站接口无需登录，');
  console.error('⚠️  后台数据对任何人开放。正式环境严禁如此运行。');
  console.error('⚠️  如果这不是你的本意，请把 .env 里的 AUTH_DISABLED 改回 0 并重启。');
  console.error('='.repeat(60) + '\n');
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
  insertOssUpload: db.prepare(`
    INSERT OR REPLACE INTO oss_uploads (object_key, user_id, created_at)
    VALUES (@object_key, @user_id, @created_at)
  `),
  findOssUploadByUser: db.prepare(`
    SELECT object_key
    FROM oss_uploads
    WHERE object_key = @object_key AND user_id = @user_id
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
  listProjectDataPathsByUser: db.prepare(`
    SELECT id, data_path
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
    INSERT INTO dispatch_tasks (title, client, budget, demand, delivery, difficulty, material_link, visibility, assignee_refs, published, sort_order, created_at, updated_at)
    VALUES (@title, @client, @budget, @demand, @delivery, @difficulty, @material_link, @visibility, @assignee_refs, @published, @sort_order, @created_at, @updated_at)
  `),
  updateDispatchTask: db.prepare(`
    UPDATE dispatch_tasks
    SET title=@title, client=@client, budget=@budget, demand=@demand, delivery=@delivery,
        difficulty=@difficulty, material_link=@material_link, visibility=@visibility, assignee_refs=@assignee_refs,
        published=@published, sort_order=@sort_order, updated_at=@updated_at
    WHERE id=@id
  `),
  deleteDispatchTask: db.prepare('DELETE FROM dispatch_tasks WHERE id = ?'),
  countClaimsByTask: db.prepare(`
    SELECT COUNT(*) AS count
    FROM dispatch_claims
    WHERE task_id = ?
      AND status != 'abandoned'
  `),
  countReviewingClaimsByTask: db.prepare(`
    SELECT COUNT(*) AS count
    FROM dispatch_claims
    WHERE task_id = ?
      AND status = 'submitted'
  `),
  findDispatchClaimByTaskUser: db.prepare(`
    SELECT * FROM dispatch_claims
    WHERE task_id = @task_id AND user_id = @user_id
  `),
  findActiveDispatchClaimByUser: db.prepare(`
    SELECT c.*, t.title AS task_title
    FROM dispatch_claims c
    JOIN dispatch_tasks t ON t.id = c.task_id
    WHERE c.user_id = @user_id
      AND c.status IN ('in_progress', 'returned')
    ORDER BY c.updated_at DESC
    LIMIT 1
  `),
  listDispatchClaimsByUser: db.prepare(`
    SELECT c.*, t.title, t.client, t.budget, t.demand, t.delivery, t.difficulty, t.material_link,
      t.visibility, t.assignee_refs, t.published, t.sort_order, t.created_at AS task_created_at, t.updated_at AS task_updated_at
    FROM dispatch_claims c
    JOIN dispatch_tasks t ON t.id = c.task_id
    WHERE c.user_id = ?
      AND c.status != 'abandoned'
    ORDER BY c.updated_at DESC, c.claimed_at DESC
  `),
  listDispatchReviewClaims: db.prepare(`
    SELECT c.*, u.phone, u.nickname,
      s.file_name AS snapshot_file_name,
      s.original_duration AS snapshot_original_duration,
      s.roughcut_duration AS snapshot_roughcut_duration,
      s.removed_duration AS snapshot_removed_duration,
      s.status AS snapshot_status,
      s.created_at AS snapshot_created_at
    FROM dispatch_claims c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN review_snapshots s ON s.id = c.snapshot_id
    WHERE c.status != 'abandoned'
    ORDER BY c.task_id ASC, c.claimed_at ASC, c.id ASC
  `),
  findDispatchReviewClaimById: db.prepare(`
    SELECT c.*, u.phone, u.nickname,
      s.file_name AS snapshot_file_name,
      s.original_duration AS snapshot_original_duration,
      s.roughcut_duration AS snapshot_roughcut_duration,
      s.removed_duration AS snapshot_removed_duration,
      s.status AS snapshot_status,
      s.created_at AS snapshot_created_at
    FROM dispatch_claims c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN review_snapshots s ON s.id = c.snapshot_id
    WHERE c.id = ?
  `),
  insertDispatchClaim: db.prepare(`
    INSERT INTO dispatch_claims (task_id, user_id, status, claimed_at, updated_at)
    VALUES (@task_id, @user_id, @status, @claimed_at, @updated_at)
  `),
  reactivateDispatchClaim: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'in_progress',
        claimed_at = @claimed_at,
        updated_at = @updated_at,
        abandoned_at = NULL
    WHERE id = @id
  `),
  abandonDispatchClaim: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'abandoned',
        abandoned_at = @abandoned_at,
        updated_at = @updated_at
    WHERE id = @id AND user_id = @user_id AND status IN ('in_progress', 'returned')
  `),
  markDispatchClaimSubmitted: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'submitted',
        submitted_at = @submitted_at,
        updated_at = @updated_at,
        project_id = @project_id,
        snapshot_id = @snapshot_id
    WHERE task_id = @task_id
      AND user_id = @user_id
      AND status != 'abandoned'
  `),
  markDispatchClaimApproved: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'completed',
        reviewed_at = @reviewed_at,
        completed_at = @completed_at,
        updated_at = @updated_at,
        review_note = @review_note
    WHERE id = @id
      AND status != 'abandoned'
  `),
  markDispatchClaimReturned: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'returned',
        reviewed_at = @reviewed_at,
        updated_at = @updated_at,
        review_note = @review_note
    WHERE id = @id
      AND status != 'abandoned'
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

    if (url.pathname === '/api/orders/data') {
      await handleOrdersData(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/orders/')) {
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
    setAuthCookie(res, auth.token, Math.floor(Date.parse(auth.expiresAt) / 1000));
    sendJson(res, 200, { ...auth, needsNickname: !user.nickname });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    clearAuthCookie(res);
    sendJson(res, 200, { ok: true });
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
function publicDispatchTask(row, viewer = null) {
  const maxClaims = Number(row.max_claims || 5);
  const claimCount = Number(statements.countClaimsByTask.get(row.id)?.count || 0);
  const reviewingCount = Number(statements.countReviewingClaimsByTask.get(row.id)?.count || 0);
  const canClaim = viewer?.id ? canUserClaimDispatchTask(row, viewer) : true;
  const myClaim = viewer?.id
    ? statements.findDispatchClaimByTaskUser.get({ task_id: row.id, user_id: viewer.id })
    : null;
  return {
    id: row.id,
    title: row.title,
    client: row.client,
    budget: row.budget,
    demand: row.demand,
    delivery: row.delivery,
    difficulty: row.difficulty,
    materialLink: row.material_link,
    visibility: dispatchTaskVisibility(row),
    assigneeRefs: viewer?.id ? '' : row.assignee_refs || '',
    assigneeLabel: dispatchAssigneeLabel(row),
    canClaim,
    claimBlockedReason: canClaim ? '' : '这是一条指定学员单，仅指定学员可接。',
    published: Boolean(row.published),
    sortOrder: row.sort_order,
    maxClaims,
    claimCount,
    reviewingCount,
    myClaim: myClaim && myClaim.status !== 'abandoned' ? publicDispatchClaim(myClaim, row) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicDispatchClaim(row, taskRow = null) {
  const task = taskRow || row;
  return {
    id: Number(row.id || 0),
    taskId: Number(row.task_id || task.id || 0),
    status: row.status || 'in_progress',
    claimedAt: row.claimed_at || null,
    updatedAt: row.updated_at || null,
    submittedAt: row.submitted_at || null,
    reviewedAt: row.reviewed_at || null,
    completedAt: row.completed_at || null,
    abandonedAt: row.abandoned_at || null,
    reviewNote: row.review_note || '',
    projectId: row.project_id || '',
    snapshotId: row.snapshot_id || '',
    task: {
      id: Number(row.task_id || task.id || 0),
      title: task.title || '',
      client: task.client || '',
      budget: task.budget || '',
      demand: task.demand || '',
      delivery: task.delivery || '',
      difficulty: task.difficulty || '',
      materialLink: task.material_link || '',
      visibility: dispatchTaskVisibility(task),
      assigneeRefs: '',
      assigneeLabel: dispatchAssigneeLabel(task),
      published: Boolean(task.published),
      sortOrder: Number(task.sort_order || 0),
      createdAt: task.task_created_at || task.created_at || null,
      updatedAt: task.task_updated_at || task.updated_at || null,
    },
  };
}

function publicDispatchReviewClaim(row) {
  const snapshotStatus = row.snapshot_status || '';
  const visibleStatus = snapshotStatus === 'rejected'
    ? 'returned'
    : snapshotStatus === 'approved'
      ? 'completed'
      : row.status || 'in_progress';
  return {
    id: Number(row.id || 0),
    taskId: Number(row.task_id || 0),
    userId: Number(row.user_id || 0),
    editorPhone: row.phone ? maskPhone(row.phone) : '',
    editorName: (row.nickname || row.phone) ? (row.nickname || maskPhone(row.phone)) : `学员${row.user_id || ''}`,
    status: visibleStatus,
    claimedAt: row.claimed_at || null,
    updatedAt: row.updated_at || null,
    submittedAt: row.submitted_at || null,
    reviewedAt: row.reviewed_at || null,
    completedAt: row.completed_at || null,
    reviewNote: row.review_note || '',
    projectId: row.project_id || '',
    snapshotId: row.snapshot_id || '',
    snapshot: row.snapshot_id ? {
      id: row.snapshot_id,
      fileName: row.snapshot_file_name || '未命名音频',
      status: row.snapshot_status || 'pending_review',
      originalDuration: Number(row.snapshot_original_duration || 0),
      roughcutDuration: Number(row.snapshot_roughcut_duration || 0),
      removedDuration: Number(row.snapshot_removed_duration || 0),
      createdAt: row.snapshot_created_at || null,
    } : null,
  };
}

function readDispatchTaskIdFromPayload(payload) {
  const raw = payload?.dispatchTask?.id;
  const taskId = Number(raw);
  return Number.isFinite(taskId) && taskId > 0 ? taskId : 0;
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
    visibility: dispatchTaskVisibility(row),
    assigneeRefs: row.assignee_refs || '',
    published: row.published,
    sortOrder: row.sort_order,
  };
}

function readDispatchInput(body) {
  // 单行清洗，不注入默认值（空标题必须能被校验拦住）
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
  const visibility = ['assigned', 'private'].includes(String(body.visibility || '').trim()) ? 'assigned' : 'public';
  const assigneeRefs = String(body.assigneeRefs ?? body.assignee_refs ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join('\n')
    .slice(0, 1000);
  return {
    title: clean(body.title, 120),
    client: clean(body.client, 120),
    budget: clean(body.budget, 60),
    demand: String(body.demand == null ? '' : body.demand).slice(0, 4000),
    delivery: String(body.delivery == null ? '' : body.delivery).slice(0, 2000),
    difficulty: clean(body.difficulty, 40),
    material_link: clean(body.materialLink ?? body.material_link, 1000),
    visibility,
    assignee_refs: visibility === 'assigned' ? assigneeRefs : '',
    published: body.published ? 1 : 0,
    sort_order: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
  };
}

function dispatchTaskVisibility(row) {
  const value = String(row?.visibility || 'public').trim();
  return value === 'assigned' || value === 'private' ? 'assigned' : 'public';
}

function dispatchAssigneeLabel(row) {
  return parseDispatchAssigneeRefs(row?.assignee_refs).join('、');
}

function parseDispatchAssigneeRefs(value) {
  return String(value || '')
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDispatchRef(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function canUserClaimDispatchTask(row, user) {
  if (dispatchTaskVisibility(row) !== 'assigned') return true;
  if (!user?.id) return false;
  const refs = parseDispatchAssigneeRefs(row.assignee_refs).map(normalizeDispatchRef).filter(Boolean);
  if (!refs.length) return false;
  const candidates = [
    String(user.id),
    `#${user.id}`,
    `id:${user.id}`,
    user.phone,
    user.nickname,
  ].map(normalizeDispatchRef).filter(Boolean);
  return refs.some((ref) => candidates.includes(ref));
}

function handleOrderMaterial(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
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
  if (!oss.isOssEnabled()) {
    sendJson(res, 404, { error: 'material_not_found' });
    return;
  }
  try {
    const objectKey = assertUserCanUseOssObjectKey(
      readOrderMaterialObjectKeyFromPath(url.pathname),
      user,
      { allowDispatchMaterial: true },
    );
    const signed = oss.signPublicUrl(objectKey);
    res.writeHead(302, {
      Location: signed,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end();
  } catch (error) {
    console.error('[orders] 素材签名失败', error && error.message);
    if (error.statusCode) {
      sendJson(res, error.statusCode, { error: 'forbidden', message: error.message || '没有权限访问这段音频。' });
      return;
    }
    sendJson(res, 404, { error: 'material_not_found', message: '音频素材暂时不可用。' });
  }
}

function readOrderMaterialObjectKeyFromPath(pathname) {
  const prefix = '/api/orders/material/';
  if (!String(pathname || '').startsWith(prefix)) return '';
  const raw = String(pathname).slice(prefix.length);
  if (!raw) return '';
  return oss.assertOwnedKey(decodeURIComponent(raw));
}

function objectKeyFromOrderMaterialUrl(value, req) {
  if (!value || !oss.isOssEnabled()) return '';
  try {
    const parsed = new URL(String(value), `http://${req.headers.host}`);
    return readOrderMaterialObjectKeyFromPath(parsed.pathname);
  } catch {
    return '';
  }
}

async function handleDispatchTasks(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname.startsWith('/api/orders/material/')) {
    handleOrderMaterial(req, res, url);
    return;
  }

  // 学员端：只读已发布任务，需登录 + 完成 Day2
  if (url.pathname === '/api/orders/tasks') {
    const user = requireAuth(req, res);
    if (!user) return;
    if (!hasDay2Access(user)) {
      sendJson(res, 403, { error: 'day2_required', message: '请先完成第二天剪辑练习，并提交一次助教审核。' });
      return;
    }
    const tasks = statements.listPublishedDispatchTasks.all().map((row) => publicDispatchTask(row, user));
    sendJson(res, 200, { tasks });
    return;
  }

  if (url.pathname === '/api/orders/my-claims') {
    const user = requireAuth(req, res);
    if (!user) return;
    if (!hasDay2Access(user)) {
      sendJson(res, 403, { error: 'day2_required', message: '请先完成第二天剪辑练习，并提交一次助教审核。' });
      return;
    }
    const claims = statements.listDispatchClaimsByUser.all(user.id).map((row) => publicDispatchClaim(row));
    sendJson(res, 200, { claims });
    return;
  }

  const claimTaskMatch = url.pathname.match(/^\/api\/orders\/tasks\/(\d+)\/claim$/);
  if (claimTaskMatch && req.method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) return;
    if (!hasDay2Access(user)) {
      sendJson(res, 403, { error: 'day2_required', message: '请先完成第二天剪辑练习，并提交一次助教审核。' });
      return;
    }
    const taskId = Number(claimTaskMatch[1]);
    const task = statements.findDispatchTask.get(taskId);
    if (!task || !task.published) {
      sendJson(res, 404, { error: 'task_not_found', message: '这单暂时不可抢。' });
      return;
    }
    if (!canUserClaimDispatchTask(task, user)) {
      sendJson(res, 403, {
        error: 'task_assigned_to_other',
        message: '这是一条指定学员单，仅指定学员可接。',
        task: publicDispatchTask(task, user),
      });
      return;
    }

    const existing = statements.findDispatchClaimByTaskUser.get({ task_id: taskId, user_id: user.id });
    if (existing && existing.status !== 'abandoned') {
      sendJson(res, 200, {
        claim: publicDispatchClaim(existing, task),
        task: publicDispatchTask(task, user),
        reused: true,
      });
      return;
    }

    const active = statements.findActiveDispatchClaimByUser.get({ user_id: user.id });
    if (active && Number(active.task_id) !== taskId) {
      sendJson(res, 409, {
        error: 'active_claim_exists',
        message: `你还有一单「${active.task_title || '未命名任务'}」在制作中，请先提交或放弃后再抢下一单。`,
        activeClaim: publicDispatchClaim(active),
      });
      return;
    }

    const maxClaims = Number(task.max_claims || 5);
    const claimCount = Number(statements.countClaimsByTask.get(taskId)?.count || 0);
    if (claimCount >= maxClaims) {
      sendJson(res, 409, { error: 'claim_full', message: '这单已经满员了，换一单试试。' });
      return;
    }

    const now = new Date().toISOString();
    let claimId = existing?.id;
    if (existing && existing.status === 'abandoned') {
      statements.reactivateDispatchClaim.run({ id: existing.id, claimed_at: now, updated_at: now });
      claimId = existing.id;
    } else {
      const info = statements.insertDispatchClaim.run({
        task_id: taskId,
        user_id: user.id,
        status: 'in_progress',
        claimed_at: now,
        updated_at: now,
      });
      claimId = info.lastInsertRowid;
    }
    const claim = statements.findDispatchClaimByTaskUser.get({ task_id: taskId, user_id: user.id });
    sendJson(res, 201, {
      claim: publicDispatchClaim(claim, task),
      task: publicDispatchTask(task, user),
      claimId,
      reused: false,
    });
    return;
  }

  const abandonClaimMatch = url.pathname.match(/^\/api\/orders\/claims\/(\d+)\/abandon$/);
  if (abandonClaimMatch && req.method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) return;
    const id = Number(abandonClaimMatch[1]);
    const now = new Date().toISOString();
    const info = statements.abandonDispatchClaim.run({
      id,
      user_id: user.id,
      abandoned_at: now,
      updated_at: now,
    });
    if (!info.changes) {
      sendJson(res, 404, { error: 'claim_not_found', message: '这条接单记录不能放弃。' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // 后台：仅管理员
  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET' && url.pathname === '/api/orders/admin/review') {
    const tasks = statements.listDispatchTasks.all().map(publicDispatchTask);
    const claims = statements.listDispatchReviewClaims.all().map(publicDispatchReviewClaim);
    sendJson(res, 200, { tasks, claims });
    return;
  }

  const reviewClaimMatch = url.pathname.match(/^\/api\/orders\/admin\/claims\/(\d+)\/review$/);
  if (reviewClaimMatch && req.method === 'PATCH') {
    const claimId = Number(reviewClaimMatch[1]);
    const claim = statements.findDispatchReviewClaimById.get(claimId);
    if (!claim || claim.status === 'abandoned') {
      sendJson(res, 404, { error: 'claim_not_found', message: '没有找到这条接单记录。' });
      return;
    }
    if (!claim.snapshot_id) {
      sendJson(res, 400, { error: 'snapshot_required', message: '这条接单还没有提交审核作品。' });
      return;
    }
    const snapshot = statements.findSnapshotById.get(claim.snapshot_id);
    if (!snapshot) {
      sendJson(res, 404, { error: 'snapshot_not_found', message: '没有找到这份审核快照。' });
      return;
    }
    const body = await readJson(req);
    const action = String(body.status || body.action || '').trim();
    const approved = action === 'approved' || action === 'completed' || action === 'approve';
    const returned = action === 'rejected' || action === 'returned' || action === 'reject';
    if (!approved && !returned) {
      sendJson(res, 400, { error: 'invalid_status', message: '订单审核状态只能是通过或打回。' });
      return;
    }
    const now = new Date().toISOString();
    const snapshotStatus = approved ? 'approved' : 'rejected';
    const note = String(body.note || '').trim().slice(0, 1000);
    statements.updateSnapshotStatus.run({
      id: snapshot.id,
      status: snapshotStatus,
      reviewed_at: now,
      reviewed_by: admin.id,
    });
    statements.updateProjectReviewStatus.run({
      id: snapshot.project_id,
      status: snapshotStatus,
      updated_at: now,
    });
    if (approved) {
      statements.markDispatchClaimApproved.run({
        id: claimId,
        reviewed_at: now,
        completed_at: now,
        updated_at: now,
        review_note: note,
      });
    } else {
      statements.markDispatchClaimReturned.run({
        id: claimId,
        reviewed_at: now,
        updated_at: now,
        review_note: note,
      });
    }
    const data = readJsonFile(snapshot.data_path, {});
    writeJsonFile(snapshot.data_path, {
      ...data,
      status: snapshotStatus,
      reviewedAt: now,
      reviewedBy: admin.id,
      reviewNote: note,
      dispatchReview: {
        claimId,
        status: approved ? 'completed' : 'returned',
        reviewedAt: now,
        reviewedBy: admin.id,
        note,
      },
    });
    sendJson(res, 200, {
      claim: publicDispatchReviewClaim(statements.findDispatchReviewClaimById.get(claimId)),
      snapshot: publicSnapshot(statements.findSnapshotById.get(snapshot.id)),
    });
    return;
  }

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
    if (input.published && input.visibility === 'assigned' && !input.assignee_refs) {
      sendJson(res, 400, { error: 'missing_assignee_refs', message: '指定学员单请先填写可接单学员。' });
      return;
    }
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
      if (input.published && input.visibility === 'assigned' && !input.assignee_refs) {
        sendJson(res, 400, { error: 'missing_assignee_refs', message: '指定学员单请先填写可接单学员。' });
        return;
      }
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
    validateProjectOssReferences(payload, user);
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
    sendJson(res, 200, {
      project: publicProject(project.row),
      payload: projectPayloadForResponse(project.data.payload),
    });
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
    validateProjectOssReferences(payload, user);
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
    validateProjectOssReferences(payload, user);
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
    const dispatchTaskId = readDispatchTaskIdFromPayload(payload);
    if (dispatchTaskId) {
      statements.markDispatchClaimSubmitted.run({
        task_id: dispatchTaskId,
        user_id: project.row.user_id,
        submitted_at: now,
        updated_at: now,
        project_id: project.row.id,
        snapshot_id: snapshotId,
      });
    }
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
    sendJson(res, 200, {
      snapshot: publicSnapshot(row),
      payload: projectPayloadForResponse(data.payload),
      cutPayload: projectPayloadForResponse(data.cutPayload || null),
    });
    return;
  }

  // AI 批改草稿：基于现有审核快照生成草稿，助教先看再发，不自动发给学员。
  const aiReviewMatch = url.pathname.match(/^\/api\/admin\/snapshots\/([A-Za-z0-9_-]+)\/ai-review$/);
  if (aiReviewMatch && req.method === 'POST') {
    if (!DEEPSEEK_KEY) {
      sendJson(res, 500, { error: 'missing_deepseek_key', message: '服务端未配置 DEEPSEEK_KEY。' });
      return;
    }
    const row = statements.findSnapshotById.get(aiReviewMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: 'snapshot_not_found', message: '没有找到这份审核快照。' });
      return;
    }
    const data = readJsonFile(row.data_path, {});
    const messages = buildAiReviewMessages(data, row);
    await proxyJson(res, DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages,
      }),
    }, {
      timeoutMs: DEEPSEEK_TIMEOUT_MS,
      timeoutMessage: 'AI 批改等待超时，请稍后重试。',
      errorMessage: 'AI 服务暂时不可用，请稍后重试。',
    });
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
    const speakerCount = Number(body.speakerCount || 2);
    let fileUrl = body.audioUrl;
    // OSS：前端只存 objectKey，转写时服务器现签公网链接（DashScope 必须公网可达，TTL 默认 2h）
    const objectKey = String(body.objectKey || '').trim();
    const materialObjectKey = objectKeyFromOrderMaterialUrl(fileUrl, req);
    if (materialObjectKey && !hasDay2Access(user)) {
      sendJson(res, 403, {
        error: 'day2_required',
        message: '请先完成第二天剪辑练习，并提交一次助教审核。',
      });
      return;
    }
    const signedObjectKey = objectKey || materialObjectKey;
    if (body.storage === 'oss' || isOwnedOssObjectKey(objectKey) || materialObjectKey) {
      if (!signedObjectKey) {
        sendJson(res, 400, { error: 'missing_objectKey' });
        return;
      }
      try {
        const allowedObjectKey = assertUserCanUseOssObjectKey(signedObjectKey, user, {
          allowDispatchMaterial: Boolean(materialObjectKey),
        });
        fileUrl = oss.signPublicUrl(allowedObjectKey);
      } catch (error) {
        console.error('[transcription] OSS 签名失败', error && error.message);
        sendJson(res, error.statusCode || 400, {
          error: error.statusCode === 403 ? 'forbidden_oss_object' : 'sign_failed',
          message: error.message || '音频地址签名失败。',
        });
        return;
      }
    }
    if (!fileUrl) {
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
        input: { file_urls: [fileUrl] },
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
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const basename = `${Date.now()}-${id}${ext}`;

  if (oss.isOssEnabled()) {
    // OSS：浏览器→服务器→OSS（内网流式写），原音频不再落 ECS 本地盘
    const objectKey = oss.withPrefix(`uploads/${date}/${basename}`);
    try {
      const putOpts = { mime: req.headers['content-type'] };
      if (declaredLength > 0) putOpts.contentLength = declaredLength;
      const limitedBody = streamRequestBodyWithLimit(req, MAX_UPLOAD_BYTES);
      await oss.putStream(objectKey, limitedBody.stream, putOpts);
      recordOssUpload(objectKey, user);
      recordUsage(user.id, 'upload');
      sendJson(res, 201, {
        storage: 'oss',
        objectKey,
        // 即时播放用的公网签名链接；前端只持久化 objectKey+storage，签名链接用时再要
        audioUrl: oss.signPublicUrl(objectKey),
        bucket: process.env.OSS_BUCKET,
        region: process.env.OSS_REGION,
        size: declaredLength || limitedBody.getBytes(),
      });
    } catch (error) {
      console.error('[upload] OSS 写入失败', error && error.message);
      sendJson(res, error.statusCode || 500, {
        error: 'upload_failed',
        message: 'OSS 上传失败，请重试。',
      });
    }
    return;
  }

  // 本地盘（默认 STORAGE_BACKEND!=oss）
  const uploadDir = path.join(UPLOAD_ROOT, date);
  ensureDir(uploadDir);
  const filePath = path.join(uploadDir, basename);
  const publicPath = `/uploads/${date}/${basename}`;

  try {
    const bytes = await writeRequestBody(req, filePath, MAX_UPLOAD_BYTES);
    const baseUrl = PUBLIC_BASE_URL || `http://${req.headers.host}`;
    recordUsage(user.id, 'upload');
    sendJson(res, 201, {
      storage: 'local',
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
  const limitedBody = createByteLimitTransform(maxBytes);
  await pipeline(req, limitedBody.stream, fs.createWriteStream(filePath));
  return limitedBody.getBytes();
}

function streamRequestBodyWithLimit(req, maxBytes) {
  const limitedBody = createByteLimitTransform(maxBytes);
  req.on('error', (error) => limitedBody.stream.destroy(error));
  limitedBody.stream.on('error', () => {
    try { req.destroy(); } catch {}
  });
  req.pipe(limitedBody.stream);
  return limitedBody;
}

function createByteLimitTransform(maxBytes) {
  let bytes = 0;
  const stream = new Transform({
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
  return { stream, getBytes: () => bytes };
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

    CREATE TABLE IF NOT EXISTS oss_uploads (
      object_key TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oss_uploads_user
      ON oss_uploads(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS dispatch_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL DEFAULT '',
      budget TEXT NOT NULL DEFAULT '',
      demand TEXT NOT NULL DEFAULT '',
      delivery TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL DEFAULT '',
      material_link TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public',
      assignee_refs TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 0,
      max_claims INTEGER NOT NULL DEFAULT 5,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_pub
      ON dispatch_tasks(published, sort_order, id DESC);

    CREATE TABLE IF NOT EXISTS dispatch_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      reviewed_at TEXT,
      completed_at TEXT,
      abandoned_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      snapshot_id TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_claims_task
      ON dispatch_claims(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_claims_user
      ON dispatch_claims(user_id, status, updated_at DESC);
  `);
  try { database.exec(`ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day1_complete INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day2_complete INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day1_intro TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_review'`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN reviewed_at TEXT`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN reviewed_by INTEGER`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN max_claims INTEGER NOT NULL DEFAULT 5`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN assignee_refs TEXT NOT NULL DEFAULT ''`); } catch {}
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
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = headerToken || readCookie(req.headers.cookie, AUTH_COOKIE_NAME);
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
    if (headerToken) setAuthCookie(res, headerToken, payload.exp);
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

function readCookie(header, name) {
  const target = `${name}=`;
  const parts = String(header || '').split(';');
  for (const part of parts) {
    const item = part.trim();
    if (!item.startsWith(target)) continue;
    try {
      return decodeURIComponent(item.slice(target.length));
    } catch {
      return item.slice(target.length);
    }
  }
  return '';
}

function setAuthCookie(res, token, expiresAtSeconds) {
  if (!res || res.headersSent || !token) return;
  const maxAge = Math.max(0, Number(expiresAtSeconds || 0) - Math.floor(Date.now() / 1000));
  if (!maxAge) return;
  const secure = /^https:\/\//i.test(PUBLIC_BASE_URL) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearAuthCookie(res) {
  if (!res || res.headersSent) return;
  const secure = /^https:\/\//i.test(PUBLIC_BASE_URL) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`);
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

function projectPayloadForResponse(payload) {
  if (!payload || typeof payload !== 'object') return payload || null;
  const copy = JSON.parse(JSON.stringify(payload));
  refreshOssAudioUrl(copy);
  return copy;
}

function refreshOssAudioUrl(payload) {
  if (!payload || typeof payload !== 'object' || !oss.isOssEnabled()) return payload;
  const objectKey = String(payload.objectKey || '').trim();
  const storage = String(payload.storage || '').trim();
  if (!objectKey || (storage && storage !== 'oss') || !isOwnedOssObjectKey(objectKey)) return payload;
  try {
    const ownedKey = oss.assertOwnedKey(objectKey);
    payload.storage = 'oss';
    payload.objectKey = ownedKey;
    payload.audioUrl = oss.signPublicUrl(ownedKey);
    payload.bucket = process.env.OSS_BUCKET || payload.bucket || '';
    payload.region = process.env.OSS_REGION || payload.region || '';
  } catch (error) {
    console.warn('[oss] 项目音频签名刷新失败', error && error.message);
  }
  return payload;
}

function isOwnedOssObjectKey(objectKey) {
  if (!objectKey || !oss.isOssEnabled()) return false;
  try {
    oss.assertOwnedKey(objectKey);
    return true;
  } catch {
    return false;
  }
}

function recordOssUpload(objectKey, user) {
  if (!objectKey || !user?.id) return;
  try {
    statements.insertOssUpload.run({
      object_key: oss.assertOwnedKey(objectKey),
      user_id: user.id,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[oss] 上传归属记录失败', error && error.message);
  }
}

function assertUserCanUseOssObjectKey(objectKey, user, options = {}) {
  const ownedKey = oss.assertOwnedKey(objectKey);
  if (user?.is_admin) return ownedKey;
  if (user?.id && statements.findOssUploadByUser.get({ object_key: ownedKey, user_id: user.id })) return ownedKey;
  if (user?.id && userProjectReferencesObjectKey(user.id, ownedKey)) return ownedKey;
  if (options.allowDispatchMaterial && hasDay2Access(user) && dispatchMaterialReferencesObjectKey(ownedKey, user)) return ownedKey;
  const error = new Error('这段音频不属于当前账号。');
  error.statusCode = 403;
  throw error;
}

function dispatchMaterialReferencesObjectKey(objectKey, user = null) {
  if (!objectKey || !oss.isOssEnabled()) return false;
  return statements.listPublishedDispatchTasks.all().some((row) => {
    try {
      return objectKeyFromMaterialLink(row.material_link) === objectKey && canUserClaimDispatchTask(row, user);
    } catch {
      return false;
    }
  });
}

function objectKeyFromMaterialLink(value) {
  if (!value) return '';
  const parsed = new URL(String(value), 'http://local.invalid');
  return readOrderMaterialObjectKeyFromPath(parsed.pathname);
}

function userProjectReferencesObjectKey(userId, objectKey) {
  if (!userId || !objectKey) return false;
  const rows = statements.listProjectDataPathsByUser.all({ user_id: userId });
  return rows.some((row) => {
    const data = readJsonFile(row.data_path, null);
    return payloadReferencesObjectKey(data?.payload, objectKey) || payloadReferencesObjectKey(data, objectKey);
  });
}

function payloadReferencesObjectKey(value, objectKey, depth = 0) {
  if (!value || depth > 8) return false;
  if (Array.isArray(value)) {
    return value.some((item) => payloadReferencesObjectKey(item, objectKey, depth + 1));
  }
  if (typeof value !== 'object') return false;
  if (String(value.objectKey || '').trim() === objectKey) return true;
  return Object.values(value).some((item) => payloadReferencesObjectKey(item, objectKey, depth + 1));
}

function validateProjectOssReferences(payload, user) {
  if (!payload || !oss.isOssEnabled()) return;
  for (const objectKey of collectPayloadOssObjectKeys(payload)) {
    assertUserCanUseOssObjectKey(objectKey, user);
  }
}

function collectPayloadOssObjectKeys(value, out = new Set(), depth = 0) {
  if (!value || depth > 8) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPayloadOssObjectKeys(item, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;
  const objectKey = String(value.objectKey || '').trim();
  if (isOwnedOssObjectKey(objectKey)) out.add(oss.assertOwnedKey(objectKey));
  Object.values(value).forEach((item) => collectPayloadOssObjectKeys(item, out, depth + 1));
  return out;
}

// 把审核快照整理成 AI 批改的 prompt。只喂 AI 看得到的：逐字稿删/留、时长、文件名。
// 听感流畅 / 音量一致 / 咔哒声这类"必须用耳朵听"的维度，明确要求 AI 标"需助教人工听"，不让它瞎评。
function buildAiReviewMessages(data, row) {
  const payload = data.payload || {};
  const sentences = Array.isArray(payload.S) ? payload.S : [];
  const cuts = Array.isArray(data.cutPayload && data.cutPayload.segments) ? data.cutPayload.segments : [];
  const editState = payload.editState && typeof payload.editState === 'object' ? payload.editState : {};
  const deletedSentenceIds = new Set(
    Array.isArray(editState.d)
      ? editState.d.map((value) => Number(value)).filter(Number.isFinite)
      : []
  );
  const partialCutsBySentence = editState.p && typeof editState.p === 'object' ? editState.p : {};
  const cutOverlapDuration = (sentence) => {
    const ss = Number(sentence.s) || 0;
    const se = Number(sentence.e) || 0;
    if (!(se > ss)) return 0;
    let overlap = 0;
    for (const cut of cuts) {
      const cs = Number(cut.start != null ? cut.start : cut.s) || 0;
      const ce = Number(cut.end != null ? cut.end : cut.e) || 0;
      overlap += Math.max(0, Math.min(se, ce) - Math.max(ss, cs));
    }
    return overlap;
  };
  const isDeleted = (sentence, index) => {
    const sentenceId = Number.isFinite(Number(sentence.idx)) ? Number(sentence.idx) : index;
    if (deletedSentenceIds.has(sentenceId)) return true;
    const ss = Number(sentence.s) || 0;
    const se = Number(sentence.e) || 0;
    if (!(se > ss)) return false;
    const overlap = cutOverlapDuration(sentence);
    return overlap > (se - ss) * 0.5;
  };
  const mergeCharRanges = (ranges) => {
    const sorted = ranges
      .map((range) => ({
        start: Math.max(0, Math.floor(Number(range.cs))),
        end: Math.max(0, Math.ceil(Number(range.ce))),
      }))
      .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    return merged;
  };
  const renderPartialText = (sentence, index) => {
    const sentenceId = Number.isFinite(Number(sentence.idx)) ? Number(sentence.idx) : index;
    const baseText = Array.isArray(sentence.w) && sentence.w.length
      ? sentence.w.map((word) => String(word.t || '')).join('')
      : String(sentence.t || '').trim();
    const ranges = mergeCharRanges(Array.isArray(partialCutsBySentence[sentenceId]) ? partialCutsBySentence[sentenceId] : []);
    if (!ranges.length) {
      return {
        text: baseText,
        partial: cutOverlapDuration(sentence) > 0.04,
      };
    }
    let cursor = 0;
    const pieces = [];
    for (const range of ranges) {
      const start = Math.min(baseText.length, Math.max(cursor, range.start));
      const end = Math.min(baseText.length, Math.max(start, range.end));
      if (start > cursor) pieces.push(baseText.slice(cursor, start));
      const removed = baseText.slice(start, end);
      if (removed) pieces.push(`〔已删：${removed}〕`);
      cursor = end;
    }
    if (cursor < baseText.length) pieces.push(baseText.slice(cursor));
    return {
      text: pieces.join('') || baseText,
      partial: true,
    };
  };
  const transcript = sentences
    .map((sentence, index) => {
      const rendered = renderPartialText(sentence, index);
      const speaker = sentence.sp ? `${sentence.sp}：` : '';
      const marker = isDeleted(sentence, index) ? '【删】' : rendered.partial ? '【半删】' : '【留】';
      const suffix = rendered.partial && !rendered.text.includes('〔已删：') ? '（本句有局部删减，旧数据未记录具体文字）' : '';
      return `[${index}] ${marker} ${speaker}${rendered.text}${suffix}`;
    })
    .join('\n');

  const fileName = row.file_name || payload.fileName || '未命名音频';
  const orig = Number(row.original_duration || 0);
  const rough = Number(row.roughcut_duration || 0);
  const removed = Number(row.removed_duration || 0);
  const fmt = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
  };

  const system = [
    '你是播客剪辑营的资深助教，帮主助教快速生成一份"批改草稿"。',
    '这只是草稿，主助教会先看、改完再发给学员，所以你只管把能判断的写清楚。',
    '',
    '满分 100 的评分标准：内容完整与逻辑 40 / 听感流畅 30 / 音量一致 20 / 命名与交付 10，60 分及格。',
    '',
    '【非常重要的边界】你只能看到逐字稿（标了【删】【留】【半删】）、时长和文件名。',
    '- 【半删】表示这句话保留，但括号里的〔已删：...〕文字没有进入成品；评价时不要把已删文字当作保留内容。',
    '- 你能评：内容完整与逻辑（40）、删减是否合理、成品时长是否合适、命名与交付完整度（10）。',
    '- 你绝对不能评：听感流畅（30）、音量一致（20）、有没有咔哒声/爆音——这些必须助教用耳朵听。',
    '  对这两项，分数一律不要猜，统一在 humanCheck 里提醒助教人工听。',
    '- 不要假装你听过音频。',
    '',
    '只输出 JSON，结构如下，全部用中文：',
    '{',
    '  "comment": "给学员看的鼓励式评论，先肯定做得好的地方，语气温暖具体",',
    '  "issues": ["3到5条具体问题，每条指出在哪、为什么、怎么改，针对内容/删减/时长/命名"],',
    '  "suggestions": "整体改稿建议，1到3句",',
    '  "score": { "content": 0到40的整数, "naming": 0到10的整数, "visibleSubtotal": content加naming, "note": "这是AI可见部分(满分50)；听感30+音量20共50分需助教人工听后补" },',
    '  "humanCheck": "提醒助教必须人工听的点：听感是否流畅、音量是否一致、接缝有没有咔哒声",',
    '  "verdict": "建议通过 或 建议打回（只基于你能看到的维度，给出一句理由）"',
    '}',
  ].join('\n');

  const userMsg = [
    `音频文件名：${fileName}`,
    `原始时长：${fmt(orig)}；粗剪后时长：${fmt(rough)}；删减时长：${fmt(removed)}`,
    '',
    '下面是带删/留/半删标记的逐字稿（【删】=整句删掉，【留】=保留进成品，【半删】=只删掉句子里一部分）：',
    '',
    transcript || '（没有逐字稿数据）',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: userMsg },
  ];
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
const CUT_MAX_QUEUED_JOBS = Number(process.env.CUT_MAX_QUEUED_JOBS || 20);
const CUT_JOB_STATE_DIR = path.join(DATA_ROOT, 'cut-jobs', 'state');
const CUT_PROGRESS_SAVE_MS = Number(process.env.CUT_PROGRESS_SAVE_MS || 5000);
const CUT_PENDING_TTL = Number(process.env.CUT_PENDING_TTL || 6 * 60 * 60 * 1000);
const CUT_RUNNING_STALE_MS = Number(process.env.CUT_RUNNING_STALE_MS || 90 * 60 * 1000);

loadCutJobsFromDisk();
setImmediate(scheduleCutJobs);
setInterval(() => {
  cleanupCutJobs();
  scheduleCutJobs();
}, 20 * 60 * 1000);

async function handleCut(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET' && url.pathname === '/api/cut/current') {
    const job = findPendingCutJob(user.id);
    if (!job) {
      sendJson(res, 404, { error: 'no_pending_cut', message: '当前没有排队或生成中的备用 MP3。' });
      return;
    }
    sendJson(res, 200, cutJobStatusPayload(job));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/cut/start') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    const body = await readJson(req, MAX_PROJECT_JSON_BYTES);
    const payloadSignature = buildCutPayloadSignature(body);
    const existingUserJob = findPendingCutJob(user.id);
    const activeUserJobCount = countPendingCutJobs(user.id);
    if (existingUserJob?.payloadSignature && existingUserJob.payloadSignature === payloadSignature) {
      sendJson(res, 202, cutJobStatusPayload(existingUserJob));
      return;
    }
    if (activeUserJobCount >= CUT_MAX_ACTIVE_JOBS_PER_USER) {
      sendJson(res, 429, {
        error: 'cut_user_busy',
        message: '你已有另一份备用 MP3 正在排队或生成中，请等它完成后再生成新的。',
        retryAfterSeconds: 30,
      });
      return;
    }
    if (countPendingCutJobs() >= CUT_MAX_ACTIVE_JOBS + CUT_MAX_QUEUED_JOBS) {
      sendJson(res, 429, {
        error: 'cut_queue_full',
        message: '现在生成备用 MP3 的队列已经满了，请先提交审核，稍后再回来下载备用 MP3。',
        retryAfterSeconds: 120,
        activeJobs: countRunningCutJobs(),
        queuedJobs: countQueuedCutJobs(),
        maxActiveJobs: CUT_MAX_ACTIVE_JOBS,
        maxQueuedJobs: CUT_MAX_QUEUED_JOBS,
      });
      return;
    }
    const audioUrl = String(body.audioUrl || '').trim();
    const objectKey = String(body.objectKey || '').trim();
    const materialObjectKey = objectKeyFromOrderMaterialUrl(audioUrl, req);
    if (materialObjectKey && !hasDay2Access(user)) {
      sendJson(res, 403, {
        error: 'day2_required',
        message: '请先完成第二天剪辑练习，并提交一次助教审核。',
      });
      return;
    }
    const signedObjectKey = objectKey || materialObjectKey;
    const useOss = String(body.storage || '') === 'oss' || isOwnedOssObjectKey(objectKey) || Boolean(materialObjectKey);
    const segments = Array.isArray(body.segments) ? body.segments : [];
    if (!useOss && !audioUrl) {
      sendJson(res, 400, { error: 'missing_audio_url', message: '缺少原始音频 URL，请从审查页重新导出。' });
      return;
    }
    // 金句前置：从同一条原始音频里提取的金句时间段（仍保留在正文里，这里只是另存一份拼到开头）。
    const goldenSegments = Array.isArray(body.goldenSegments)
      ? body.goldenSegments
          .map((seg) => ({ start: Number(seg.start) || 0, end: Number(seg.end) || 0 }))
          .filter((seg) => seg.end > seg.start)
      : [];
    // 过渡音乐：只允许 /assets/music/ 下的素材，做路径归一防穿越；找不到就忽略（降级为无音乐）。
    const musicPath = resolveIntroMusicPath(body.introMusic);
    let audioSource;
    try {
      if (useOss) {
        // OSS：前端只传 objectKey，导出时服务器从 OSS 内网拉原音频，不走 URL 白名单校验
        audioSource = {
          type: 'oss',
          objectKey: assertUserCanUseOssObjectKey(signedObjectKey, user, {
            allowDispatchMaterial: Boolean(materialObjectKey),
          }),
        };
      } else {
        audioSource = resolveTrustedAudioInput(audioUrl, req);
      }
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.statusCode === 403 ? 'forbidden_oss_object' : 'invalid_audio_url',
        message: error.message || '原始音频地址无效。',
      });
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
      nonResumable: audioSource?.type === 'data',
      payloadSignature,
      segments,
      goldenSegments,
      musicPath,
      originalDuration: Number(body.originalDuration || body.original_duration || 0),
      createdAt: Date.now(),
      queuedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      updatedAt: Date.now(),
      error: null,
    };
    cutJobs.set(jobId, job);
    persistCutJob(job, { force: true });
    scheduleCutJobs();

    sendJson(res, 202, cutJobStatusPayload(job));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/cut/status/')) {
    const jobId = url.pathname.replace('/api/cut/status/', '');
    const job = cutJobs.get(jobId);
    if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    sendJson(res, 200, cutJobStatusPayload(job));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/cut/download/')) {
    const jobId = url.pathname.replace('/api/cut/download/', '');
    const job = cutJobs.get(jobId);
    if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    if (job.stage !== 'done') { sendJson(res, 409, { error: '文件尚未就绪' }); return; }

    const basename = path.basename(job.filename, path.extname(job.filename));
    const dlName = encodeURIComponent(`${basename}_精剪版.mp3`);

    if (oss.isOssEnabled() && job.outputObjectKey) {
      // 产物在 OSS：302 重定向到公网签名下载链接，下载流量绕开 ECS
      try {
        const signed = oss.signPublicUrl(job.outputObjectKey, 600, { filename: `${basename}_精剪版.mp3` });
        res.writeHead(302, { Location: signed, 'Access-Control-Allow-Origin': '*' });
        res.end();
      } catch (error) {
        console.error('[cut] OSS 下载签名失败', error && error.message);
        sendJson(res, 500, { error: '下载链接生成失败' });
      }
      return;
    }

    if (!fs.existsSync(job.outputPath)) { sendJson(res, 410, { error: '文件已过期' }); return; }
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

function countPendingCutJobs(userId) {
  let count = 0;
  for (const job of cutJobs.values()) {
    if (userId && job.userId !== userId) continue;
    if (['queued', 'downloading', 'processing'].includes(job.stage)) count += 1;
  }
  return count;
}

function countRunningCutJobs() {
  let count = 0;
  for (const job of cutJobs.values()) {
    if (['downloading', 'processing'].includes(job.stage) || job.running) count += 1;
  }
  return count;
}

function countQueuedCutJobs() {
  let count = 0;
  for (const job of cutJobs.values()) {
    if (job.stage === 'queued' && !job.running) count += 1;
  }
  return count;
}

function getQueuedCutJobs() {
  return [...cutJobs.values()]
    .filter((job) => job.stage === 'queued' && !job.running)
    .sort((a, b) => (Number(a.queuedAt || a.createdAt) - Number(b.queuedAt || b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

function findPendingCutJob(userId) {
  return [...cutJobs.values()]
    .filter((job) => job.userId === userId && ['queued', 'downloading', 'processing'].includes(job.stage))
    .sort((a, b) => (Number(a.queuedAt || a.createdAt) - Number(b.queuedAt || b.createdAt)) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function buildCutPayloadSignature(data = {}) {
  const storage = String(data.storage || '').trim();
  const objectKey = String(data.objectKey || '').trim();
  const audioUrl = String(data.audioUrl || '').trim();
  const audioRef = (storage === 'oss' || isOwnedOssObjectKey(objectKey)) && objectKey
    ? `oss:${objectKey}`
    : `url:${audioUrl}`;
  const signatureBody = {
    audioRef,
    storage,
    objectKey,
    fileName: String(data.fileName || '').trim(),
    segments: Array.isArray(data.segments) ? data.segments : [],
    goldenSegments: Array.isArray(data.goldenSegments) ? data.goldenSegments : [],
    introMusic: data.introMusic || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(signatureBody)).digest('hex');
}

function getCutQueueAhead(jobId) {
  const job = cutJobs.get(jobId);
  if (!job || job.stage !== 'queued') return 0;
  const running = countRunningCutJobs();
  const queued = getQueuedCutJobs();
  const index = queued.findIndex((item) => item.id === jobId);
  return running + Math.max(0, index);
}

function cutJobStatusPayload(job) {
  const queueAhead = getCutQueueAhead(job.id);
  return {
    jobId: job.id,
    status: job.stage === 'error' ? 'failed' : job.stage,
    stage: job.stage,
    progress: Number(job.progress || 0),
    queueAhead,
    queuePosition: job.stage === 'queued' ? queueAhead + 1 : 0,
    activeJobs: countRunningCutJobs(),
    queuedJobs: countQueuedCutJobs(),
    maxActiveJobs: CUT_MAX_ACTIVE_JOBS,
    maxQueuedJobs: CUT_MAX_QUEUED_JOBS,
    error: job.error || null,
  };
}

function scheduleCutJobs() {
  while (countRunningCutJobs() < CUT_MAX_ACTIVE_JOBS) {
    const job = getQueuedCutJobs()[0];
    if (!job) return;
    startCutJob(job);
  }
}

function startCutJob(job) {
  if (!job || job.running || job.stage !== 'queued') return;
  job.running = true;
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  persistCutJob(job, { force: true });

  (async () => {
    try {
      cleanupCutJobTempFiles(job, { keepOutput: false });
      await cutDownloadInput(job);
      await cutProcess(job);
      try { fs.unlinkSync(job.inputPath); } catch {}
      if (oss.isOssEnabled()) {
        // 产物 MP3 传到 OSS（cut/ 前缀，7 天生命周期自动清），本地产物删掉，下载走 OSS 签名链接
        await cutUploadOutput(job);
        try { fs.unlinkSync(job.outputPath); } catch {}
      }
      job.completedAt = Date.now();
      persistCutJob(job, { force: true });
    } catch (error) {
      failCutJob(job, error.message || String(error));
      console.error('[cut]', job.id, job.error);
    } finally {
      job.running = false;
      persistCutJob(job, { force: true });
      scheduleCutJobs();
    }
  })();
}

function cutJobStatePath(jobId) {
  return path.join(CUT_JOB_STATE_DIR, `${jobId}.json`);
}

function serializeCutJob(job) {
  const dataAudio = isDataAudioUrl(job.audioUrl);
  return {
    id: job.id,
    userId: job.userId,
    stage: job.stage,
    progress: Number(job.progress || 0),
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    filename: job.filename,
    audioUrl: dataAudio ? '' : job.audioUrl,
    audioSource: job.audioSource || null,
    nonResumable: Boolean(job.nonResumable || dataAudio),
    payloadSignature: job.payloadSignature || null,
    outputObjectKey: job.outputObjectKey || null,
    segments: Array.isArray(job.segments) ? job.segments : [],
    goldenSegments: Array.isArray(job.goldenSegments) ? job.goldenSegments : [],
    musicPath: job.musicPath || null,
    originalDuration: Number(job.originalDuration || 0),
    createdAt: Number(job.createdAt || Date.now()),
    queuedAt: Number(job.queuedAt || job.createdAt || Date.now()),
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    updatedAt: Number(job.updatedAt || Date.now()),
    error: job.error || null,
  };
}

function persistCutJob(job, options = {}) {
  if (!job?.id) return;
  const now = Date.now();
  if (!options.force && job.lastPersistedAt && now - job.lastPersistedAt < CUT_PROGRESS_SAVE_MS) return;
  job.updatedAt = now;
  job.lastPersistedAt = now;
  try {
    ensureDir(CUT_JOB_STATE_DIR);
    const target = cutJobStatePath(job.id);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(serializeCutJob(job)));
    fs.renameSync(temp, target);
  } catch (error) {
    console.error('[cut] 任务状态保存失败', job.id, error.message || error);
  }
}

function loadCutJobsFromDisk() {
  try {
    ensureDir(CUT_JOB_STATE_DIR);
  } catch (error) {
    console.error('[cut] 任务状态目录不可用', error.message || error);
    return;
  }

  const now = Date.now();
  for (const file of fs.readdirSync(CUT_JOB_STATE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(CUT_JOB_STATE_DIR, file);
    try {
      const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!job?.id) {
        try { fs.unlinkSync(filePath); } catch {}
        continue;
      }
      job.running = false;
      if (job.nonResumable && ['queued', 'downloading', 'processing'].includes(job.stage)) {
        cleanupCutJobTempFiles(job, { keepOutput: false });
        failCutJob(job, '这个临时音频任务无法在服务器重启后继续，请重新生成备用 MP3。');
        cutJobs.set(job.id, job);
        continue;
      }
      if (['queued', 'downloading', 'processing'].includes(job.stage)) {
        const queuedAt = Number(job.queuedAt || job.createdAt || now);
        const updatedAt = Number(job.updatedAt || job.startedAt || queuedAt);
        const isStale = job.stage === 'queued'
          ? now - queuedAt > CUT_PENDING_TTL
          : now - updatedAt > CUT_RUNNING_STALE_MS;
        if (isStale) {
          cleanupCutJobTempFiles(job, { keepOutput: false });
          failCutJob(job, '任务等待或处理时间过长，已自动取消。请重新生成备用 MP3。');
        } else {
          cleanupCutJobTempFiles(job, { keepOutput: false });
          job.stage = 'queued';
          job.progress = 0;
          job.error = null;
          job.queuedAt = queuedAt;
          job.startedAt = null;
          persistCutJob(job, { force: true });
        }
      } else {
        const finishedAt = Number(job.completedAt || job.updatedAt || job.createdAt || now);
        if (now - finishedAt > CUT_JOB_TTL) {
          cleanupCutJobTempFiles(job, { keepOutput: false });
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }
      }
      cutJobs.set(job.id, job);
    } catch (error) {
      console.error('[cut] 任务状态读取失败', file, error.message || error);
    }
  }
}

function cleanupCutJobTempFiles(job, options = {}) {
  try { if (job.inputPath && fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath); } catch {}
  if (!options.keepOutput) {
    try { if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch {}
  }
}

function cleanupCutJobs() {
  const now = Date.now();
  for (const [id, job] of cutJobs) {
    if (job.stage === 'queued') {
      const queuedAt = Number(job.queuedAt || job.createdAt || now);
      if (now - queuedAt > CUT_PENDING_TTL) {
        failCutJob(job, '排队等待时间过长，已自动取消。请重新生成备用 MP3。');
      }
      continue;
    }

    if (['downloading', 'processing'].includes(job.stage) || job.running) {
      const touchedAt = Number(job.updatedAt || job.startedAt || job.createdAt || now);
      if (now - touchedAt > CUT_RUNNING_STALE_MS) {
        try { if (job.childProcess) job.childProcess.kill('SIGTERM'); } catch {}
        failCutJob(job, '处理时间过长，已自动取消。请重新生成备用 MP3。');
      }
      continue;
    }

    const finishedAt = Number(job.completedAt || job.updatedAt || job.createdAt || now);
    if (now - finishedAt <= CUT_JOB_TTL) continue;
    cleanupCutJobTempFiles(job, { keepOutput: false });
    try { fs.unlinkSync(cutJobStatePath(id)); } catch {}
    cutJobs.delete(id);
  }
  scheduleCutJobs();
}

function setCutJobStage(job, stage, progress) {
  job.stage = stage;
  if (Number.isFinite(progress)) job.progress = progress;
  persistCutJob(job, { force: true });
}

function setCutJobProgress(job, progress) {
  job.progress = progress;
  persistCutJob(job);
}

function failCutJob(job, message) {
  job.stage = 'error';
  job.running = false;
  job.error = message || '任务处理失败';
  job.completedAt = Date.now();
  persistCutJob(job, { force: true });
}

async function cutDownloadInput(job) {
  setCutJobStage(job, 'downloading', 5);
  if (job.audioSource?.type === 'oss') {
    // OSS：从内网把原音频直接拉到 ffmpeg 输入文件
    await oss.pullToFile(job.audioSource.objectKey, job.inputPath);
    setCutJobStage(job, 'downloading', 20);
    return;
  }
  if (job.audioSource?.type === 'file') {
    if (!fs.existsSync(job.audioSource.filePath)) throw new Error('原始音频文件不存在，请重新上传。');
    fs.copyFileSync(job.audioSource.filePath, job.inputPath);
    setCutJobStage(job, 'downloading', 20);
    return;
  }
  if (isDataAudioUrl(job.audioUrl)) {
    const match = job.audioUrl.match(/^data:audio\/[^;]+;base64,(.+)$/);
    if (!match) throw new Error('音频数据格式不正确。');
    fs.writeFileSync(job.inputPath, Buffer.from(match[1], 'base64'));
    setCutJobStage(job, 'downloading', 20);
    return;
  }
  throw new Error('请使用剪辑台上传生成的音频地址。');
}

// 把生成好的产物 MP3 传到 OSS（cut/ 前缀），记录 outputObjectKey 供下载签名
async function cutUploadOutput(job) {
  const date = isoDay();
  const outKey = oss.withPrefix(`cut/${date}/${job.id}.mp3`);
  await oss.putFile(outKey, job.outputPath, { mime: 'audio/mpeg' });
  job.outputObjectKey = outKey;
  persistCutJob(job, { force: true });
}

function resolveTrustedAudioInput(audioUrl, req) {
  if (isDataAudioUrl(audioUrl)) return { type: 'data' };
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

function isDataAudioUrl(value) {
  return /^data:audio\/[^;]+;base64,/i.test(String(value || ''));
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
  setCutJobStage(job, 'processing', 25);
  const duration = job.originalDuration > 0 ? job.originalDuration : await refineProbe(job.inputPath);
  const keepSegments = invertCutSegments(job.segments, duration);
  if (!keepSegments.length) throw new Error('所有音频都被标记删除了，无法生成成品。');

  // 有金句时走"金句前置"拼接：金句 → (过渡音乐) → 正文；否则走原来的纯删减拼接。
  const golden = Array.isArray(job.goldenSegments)
    ? job.goldenSegments.filter((seg) => Number(seg.end) > Number(seg.start))
    : [];
  const hasMusic = Boolean(job.musicPath);
  const inputs = ['-i', job.inputPath];
  let args;
  if (golden.length) {
    if (hasMusic) inputs.push('-i', job.musicPath);
    args = buildGoldCutArgs(keepSegments, golden, hasMusic);
  } else {
    args = buildServerCutArgs(keepSegments);
  }

  await new Promise((resolve, reject) => {
    const pass = spawn('nice', ['-n', '19', 'ffmpeg', '-threads', '1', ...inputs, ...args, '-y', job.outputPath]);
    job.childProcess = pass;
    pass.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      const t = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && duration > 0) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]);
        setCutJobProgress(job, Math.min(95, 25 + Math.round((elapsed / duration) * 70)));
      }
    });
    pass.on('close', (code) => {
      job.childProcess = null;
      if (code !== 0) return reject(new Error('ffmpeg 剪辑失败'));
      setCutJobStage(job, 'done', 100);
      resolve();
    });
    pass.on('error', (error) => {
      job.childProcess = null;
      reject(error);
    });
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

  // 每个保留段两端各加一个短淡变，消除剪断点接缝处的爆音/咔哒声。
  // 淡变在段内进行，不改变段长度，成品总时长不变；删整句、删半句的接缝同样处理。
  // 定稿口径（当当 2026-06-13 试听拍板 = 版本2）：淡入 3ms（字头干脆、不"咕噜"），淡出 8ms（句尾收得干净）。
  // 段太短时按段长缩短淡变，避免淡入淡出重叠。
  const FADE_IN = 0.003;
  const FADE_OUT = 0.008;
  const trims = keepSegments
    .map((seg, index) => {
      let chain = `[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS`;
      const segDur = Number(seg.end) - Number(seg.start);
      if (Number.isFinite(segDur) && segDur > 0) {
        const fadeIn = Math.min(FADE_IN, segDur / 4);
        const fadeOut = Math.min(FADE_OUT, segDur / 4);
        const fadeOutStart = Math.max(0, segDur - fadeOut);
        chain += `,afade=t=in:st=0:d=${round3(fadeIn)},afade=t=out:st=${round3(fadeOutStart)}:d=${round3(fadeOut)}`;
      }
      return `${chain}[a${index}]`;
    })
    .join(';');
  const concatInputs = keepSegments.map((_, index) => `[a${index}]`).join('');
  const filter = `${trims};${concatInputs}concat=n=${keepSegments.length}:v=0:a=1[out]`;
  return ['-filter_complex', filter, '-map', '[out]', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
}

// 把 /assets/music/xxx.mp3 安全解析成本机真实文件路径；非法/不存在返回 null（降级为无音乐）。
function resolveIntroMusicPath(introMusic) {
  const raw = String(introMusic || '').trim();
  if (!raw.startsWith('/assets/music/')) return null;
  const rel = path.posix.normalize(decodeURIComponent(raw));
  if (!rel.startsWith('/assets/music/') || rel.includes('..')) return null;
  const file = path.normalize(path.join(STATIC_ROOT, rel));
  if (!file.startsWith(path.join(STATIC_ROOT, 'assets', 'music') + path.sep)) return null;
  try {
    if (fs.statSync(file).isFile()) return file;
  } catch {}
  return null;
}

// 金句前置拼接：金句段 → (过渡音乐) → 正文段。
// 金句/正文每段都加同款短淡变（消咔哒），所有流统一重采样到 44.1k 立体声再 concat，规避不同来源/采样率拼接报错。
function buildGoldCutArgs(keepSegments, goldenSegments, hasMusic) {
  const FMT = 'aformat=sample_rates=44100:channel_layouts=stereo';
  const FADE_IN = 0.003;
  const FADE_OUT = 0.008;
  const segChain = (srcLabel, seg, outLabel) => {
    let chain = `[${srcLabel}]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS`;
    const segDur = Number(seg.end) - Number(seg.start);
    if (Number.isFinite(segDur) && segDur > 0) {
      const fi = Math.min(FADE_IN, segDur / 4);
      const fo = Math.min(FADE_OUT, segDur / 4);
      chain += `,afade=t=in:st=0:d=${round3(fi)},afade=t=out:st=${round3(Math.max(0, segDur - fo))}:d=${round3(fo)}`;
    }
    return `${chain},${FMT}[${outLabel}]`;
  };

  const chains = [];
  const order = [];
  goldenSegments.forEach((seg, i) => { chains.push(segChain('0:a', seg, `g${i}`)); order.push(`[g${i}]`); });
  if (hasMusic) {
    // 音乐来自第二个输入；轻微 50ms 淡入，避免接金句尾巴时突起。
    chains.push(`[1:a]${FMT},afade=t=in:st=0:d=0.05[mus]`);
    order.push('[mus]');
  }
  keepSegments.forEach((seg, i) => { chains.push(segChain('0:a', seg, `b${i}`)); order.push(`[b${i}]`); });
  const filter = `${chains.join(';')};${order.join('')}concat=n=${order.length}:v=0:a=1[out]`;
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
    const pass = spawn('nice', ['-n', '19', 'ffmpeg', '-threads', '1', ...args]);
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
const REFINE_MAX_ACTIVE_JOBS = Number(process.env.REFINE_MAX_ACTIVE_JOBS || 1);
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

    const pass = spawn('nice', ['-n', '19', 'ffmpeg', '-threads', '1', '-i', job.inputPath, '-af', audioFilter, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', job.outputPath]);
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
