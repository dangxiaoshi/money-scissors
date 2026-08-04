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
const SERVER_STARTED_AT = new Date().toISOString();
const DOWNLOAD_WATCH_LATEST_PATH = path.join(LOG_ROOT, 'download-watch-latest.json');
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
const VOICE_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const VOICE_TTS_MODEL = process.env.DASHSCOPE_VOICE_MODEL || 'cosyvoice-v2';
const VOICE_TTS_ID = process.env.DASHSCOPE_VOICE_ID || 'cosyvoice-v2-vd-dxs-404093cf7a6d436cb54212045bb18a65';
const VOICE_TTS_TIMEOUT_MS = Number(process.env.VOICE_TTS_TIMEOUT_MS || 60 * 1000);
const VOICE_MAX_TEXT_CHARS = Number(process.env.VOICE_MAX_TEXT_CHARS || 500);
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 60 * 1000);
const DEEPSEEK_DECISION_TIMEOUT_MS = Number(process.env.DEEPSEEK_DECISION_TIMEOUT_MS || 5 * 60 * 1000);
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 90 * 60 * 1000);
const FFPROBE_TIMEOUT_MS = Number(process.env.FFPROBE_TIMEOUT_MS || 60 * 1000);
const CHILD_KILL_GRACE_MS = Number(process.env.CHILD_KILL_GRACE_MS || 5000);
const MAX_CUT_SEGMENTS = Number(process.env.MAX_CUT_SEGMENTS || 5000);
const CUT_SEGMENT_OVERLAP_TOLERANCE = 0.04;
const CUT_SEGMENT_DURATION_TOLERANCE = 0.5;
const JWT_EXPIRE_HOURS = Number(process.env.JWT_EXPIRE_HOURS || 24 * 45);
const MAX_DAILY_SMS_PER_PHONE = Number(process.env.MAX_DAILY_SMS_PER_PHONE || 5);
const MAX_SMS_SENDS_PER_IP_WINDOW = Number(process.env.MAX_SMS_SENDS_PER_IP_WINDOW || 20);
const SMS_IP_WINDOW_MINUTES = Number(process.env.SMS_IP_WINDOW_MINUTES || 10);
const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS || 5);
const VERIFY_TTL_MINUTES = Number(process.env.VERIFY_CODE_TTL_MINUTES || 5);
const LOCK_MINUTES = Number(process.env.VERIFY_LOCK_MINUTES || 30);
const DISPATCH_DEFAULT_MAX_CLAIMS = 2;
const DISPATCH_CLAIM_TTL_MS = 120 * 60 * 60 * 1000;
// 安全默认：鉴权默认开启，只有显式设置 AUTH_DISABLED=1 才关闭。
// （旧逻辑是 !== '0'，默认关闭鉴权，env 一旦漏配=全站后台裸奔、人人是管理员；
//   2026-06-16 改为安全默认：漏配=锁上而不是大开。要关必须明写 =1。）
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
const DEV_SEND_CODE_FALLBACK = process.env.ALLOW_DEV_SEND_CODE_FALLBACK === '1';
// 登录验证码交付方式：
// - sms（默认）：调用阿里云短信；配置不完整时仅允许开发环境兜底。
// - page：完全跳过短信调用，直接把验证码返回给登录页显示为绿色码。
// page 是显式的经营兜底开关，不会删除或覆盖短信密钥，切回 sms 后即可恢复真短信。
const AUTH_CODE_DELIVERY_MODE = String(process.env.AUTH_CODE_DELIVERY_MODE || 'sms').trim().toLowerCase();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/g, '');
const AUTH_COOKIE_NAME = 'jinqian_token';
const GUEST_REVIEW_COOKIE_NAME = 'jinqian_guest_review';
const GUEST_REVIEW_DEFAULT_DAYS = 7;
const GUEST_REVIEW_MAX_DAYS = 30;
const GUEST_REVIEW_SESSION_SECONDS = 2 * 60 * 60;
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
if (!['sms', 'page'].includes(AUTH_CODE_DELIVERY_MODE)) {
  console.error(`AUTH_CODE_DELIVERY_MODE 只允许 sms 或 page，当前为 ${AUTH_CODE_DELIVERY_MODE || '(空)'}`);
  process.exit(1);
}
if (AUTH_CODE_DELIVERY_MODE === 'page') {
  console.error('\n' + '='.repeat(60));
  console.error('⚠️  警告：登录验证码当前由页面直接显示 (AUTH_CODE_DELIVERY_MODE=page)');
  console.error('⚠️  本模式不会调用短信服务，知道手机号的人可获取登录码。');
  console.error('⚠️  需恢复真短信时，把该值改回 sms 并重启。');
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
const activeVoiceSynthesisUsers = new Set();

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
  savePdcaHomework: db.prepare(`
    UPDATE users SET pdca_homework = @pdca_homework, last_active_at = @last_active_at WHERE id = @id
  `),
  saveResumeHomework: db.prepare(`
    UPDATE users SET resume_homework = @resume_homework, last_active_at = @last_active_at WHERE id = @id
  `),
  findDay1FeedbackByUserHash: db.prepare(`
    SELECT *
    FROM day1_feedbacks
    WHERE user_id = @user_id AND intro_hash = @intro_hash
    ORDER BY updated_at DESC
    LIMIT 1
  `),
  findLatestConfirmedDay1FeedbackByUser: db.prepare(`
    SELECT *
    FROM day1_feedbacks
    WHERE user_id = ? AND status = 'confirmed'
    ORDER BY confirmed_at DESC, updated_at DESC
    LIMIT 1
  `),
  findDay1FeedbackById: db.prepare('SELECT * FROM day1_feedbacks WHERE id = ?'),
  insertDay1Feedback: db.prepare(`
    INSERT INTO day1_feedbacks (
      id, user_id, intro_hash, ai_draft, confirmed_text, status, model,
      prompt_version, created_at, updated_at, confirmed_at, confirmed_by
    )
    VALUES (
      @id, @user_id, @intro_hash, @ai_draft, @confirmed_text, @status, @model,
      @prompt_version, @created_at, @updated_at, @confirmed_at, @confirmed_by
    )
  `),
  updateDay1Feedback: db.prepare(`
    UPDATE day1_feedbacks SET
      ai_draft = @ai_draft,
      confirmed_text = @confirmed_text,
      status = @status,
      model = @model,
      prompt_version = @prompt_version,
      updated_at = @updated_at,
      confirmed_at = @confirmed_at,
      confirmed_by = @confirmed_by
    WHERE id = @id
  `),
  insertFeedbackReport: db.prepare(`
    INSERT INTO feedback_reports (
      id, user_id, project_id, snapshot_id, dispatch_task_id, dispatch_claim_id,
      station, page, page_url, title, description, severity, context_json,
      attachment_json, status, admin_note, created_at, updated_at, resolved_at
    )
    VALUES (
      @id, @user_id, @project_id, @snapshot_id, @dispatch_task_id, @dispatch_claim_id,
      @station, @page, @page_url, @title, @description, @severity, @context_json,
      @attachment_json, @status, @admin_note, @created_at, @updated_at, @resolved_at
    )
  `),
  listFeedbackReports: db.prepare(`
    SELECT f.*, u.phone, u.nickname
    FROM feedback_reports f
    LEFT JOIN users u ON u.id = f.user_id
    WHERE (@status = '' OR f.status = @status)
    ORDER BY
      CASE f.status WHEN 'open' THEN 0 WHEN 'triaged' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
      f.created_at DESC
    LIMIT @limit
  `),
  findFeedbackReport: db.prepare('SELECT * FROM feedback_reports WHERE id = ?'),
  updateFeedbackReportStatus: db.prepare(`
    UPDATE feedback_reports SET
      status = @status,
      admin_note = @admin_note,
      updated_at = @updated_at,
      resolved_at = @resolved_at
    WHERE id = @id
  `),
  insertDownloadEvent: db.prepare(`
    INSERT INTO download_events (
      id, user_id, job_id, refine_job_id, event_type, stage, status, message,
      detail_json, page_url, user_agent, browser, ip, created_at
    )
    VALUES (
      @id, @user_id, @job_id, @refine_job_id, @event_type, @stage, @status, @message,
      @detail_json, @page_url, @user_agent, @browser, @ip, @created_at
    )
  `),
  listDownloadEventsSince: db.prepare(`
    SELECT e.*, u.phone, u.nickname
    FROM download_events e
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.created_at >= @since
    ORDER BY e.created_at DESC
    LIMIT @limit
  `),
  listDownloadFailuresSince: db.prepare(`
    SELECT e.*, u.phone, u.nickname
    FROM download_events e
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.created_at >= @since
      AND e.event_type IN ('failed', 'refine_failed')
    ORDER BY e.created_at DESC
    LIMIT @limit
  `),
  insertVisitEvent: db.prepare(`
    INSERT INTO visit_events (
      session_id, user_id, event_type, path, title, referrer,
      user_agent, ip, duration_seconds, created_at
    )
    VALUES (
      @session_id, @user_id, @event_type, @path, @title, @referrer,
      @user_agent, @ip, @duration_seconds, @created_at
    )
  `),
  listVisitEventsSince: db.prepare(`
    SELECT v.*, u.phone, u.nickname
    FROM visit_events v
    LEFT JOIN users u ON u.id = v.user_id
    WHERE v.created_at >= @since
    ORDER BY v.created_at DESC
    LIMIT @limit
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
    SELECT id, phone, created_at, last_active_at, usage_count, wechat_added, note, is_admin, nickname, day1_complete, day2_complete, day1_intro, pdca_homework, resume_homework,
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
  insertGuestReviewShare: db.prepare(`
    INSERT INTO guest_review_shares (
      id, snapshot_id, token_hash, created_by, created_at, expires_at, revoked_at, last_opened_at
    ) VALUES (
      @id, @snapshot_id, @token_hash, @created_by, @created_at, @expires_at, NULL, NULL
    )
  `),
  revokeGuestReviewSharesForSnapshot: db.prepare(`
    UPDATE guest_review_shares
    SET revoked_at = @revoked_at
    WHERE snapshot_id = @snapshot_id AND revoked_at IS NULL
  `),
  findGuestReviewShareByTokenHash: db.prepare(`
    SELECT
      g.id AS share_id,
      g.snapshot_id,
      g.expires_at,
      g.revoked_at,
      s.file_name,
      s.original_duration,
      s.roughcut_duration,
      s.removed_duration,
      s.created_at AS snapshot_created_at,
      s.data_path AS snapshot_data_path
    FROM guest_review_shares g
    INNER JOIN review_snapshots s ON s.id = g.snapshot_id
    WHERE g.token_hash = ?
  `),
  findGuestReviewShareById: db.prepare(`
    SELECT
      g.id AS share_id,
      g.snapshot_id,
      g.expires_at,
      g.revoked_at,
      s.file_name,
      s.original_duration,
      s.roughcut_duration,
      s.removed_duration,
      s.created_at AS snapshot_created_at,
      s.data_path AS snapshot_data_path
    FROM guest_review_shares g
    INNER JOIN review_snapshots s ON s.id = g.snapshot_id
    WHERE g.id = ?
  `),
  touchGuestReviewShare: db.prepare(`
    UPDATE guest_review_shares
    SET last_opened_at = @last_opened_at
    WHERE id = @id
  `),

  listDispatchTasks: db.prepare('SELECT * FROM dispatch_tasks ORDER BY sort_order ASC, id DESC'),
  listPublishedDispatchTasks: db.prepare(`
    SELECT *
    FROM dispatch_tasks
    WHERE published = 1
    ORDER BY
      CASE
        WHEN status = 'completed' OR completed_claim_id IS NOT NULL OR completed_at IS NOT NULL THEN 1
        ELSE 0
      END ASC,
      id DESC
  `),
  findDispatchTask: db.prepare('SELECT * FROM dispatch_tasks WHERE id = ?'),
  insertDispatchTask: db.prepare(`
    INSERT INTO dispatch_tasks (title, client, budget, demand, delivery, difficulty, material_link, visibility, assignee_refs, published, max_claims, sort_order, created_at, updated_at)
    VALUES (@title, @client, @budget, @demand, @delivery, @difficulty, @material_link, @visibility, @assignee_refs, @published, @max_claims, @sort_order, @created_at, @updated_at)
  `),
  updateDispatchTask: db.prepare(`
    UPDATE dispatch_tasks
    SET title=@title, client=@client, budget=@budget, demand=@demand, delivery=@delivery,
        difficulty=@difficulty, material_link=@material_link, visibility=@visibility, assignee_refs=@assignee_refs,
        published=@published, max_claims=@max_claims, sort_order=@sort_order, updated_at=@updated_at
    WHERE id=@id
  `),
  completeDispatchTask: db.prepare(`
    UPDATE dispatch_tasks
    SET status = 'completed',
        completed_claim_id = @completed_claim_id,
        completed_at = @completed_at,
        completed_by = @completed_by,
        updated_at = @updated_at
    WHERE id = @id
      AND status != 'completed'
  `),
  deleteDispatchTask: db.prepare('DELETE FROM dispatch_tasks WHERE id = ?'),
  countClaimsByTask: db.prepare(`
    SELECT COUNT(*) AS count
    FROM dispatch_claims
    WHERE task_id = ?
      AND status IN ('in_progress', 'returned', 'submitted')
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
  listDispatchClaimsByTask: db.prepare(`
    SELECT *
    FROM dispatch_claims
    WHERE task_id = ?
      AND status != 'abandoned'
    ORDER BY claimed_at ASC, id ASC
  `),
  findDispatchClaimByIdForUser: db.prepare(`
    SELECT *
    FROM dispatch_claims
    WHERE id = @id AND user_id = @user_id
  `),
  findEditableDispatchClaimForSubmit: db.prepare(`
    SELECT *
    FROM dispatch_claims
    WHERE task_id = @task_id
      AND user_id = @user_id
      AND status IN ('in_progress', 'returned', 'submitted')
      AND (@id = 0 OR id = @id)
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
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
      t.visibility, t.assignee_refs, t.published, t.max_claims, t.status AS task_status,
      t.completed_claim_id, t.completed_at AS task_completed_at,
      t.sort_order, t.created_at AS task_created_at, t.updated_at AS task_updated_at
    FROM dispatch_claims c
    JOIN dispatch_tasks t ON t.id = c.task_id
    WHERE c.user_id = ?
      AND c.status != 'abandoned'
    ORDER BY c.updated_at DESC, c.claimed_at DESC
  `),
  listDispatchReviewClaims: db.prepare(`
    SELECT c.*, u.phone, u.nickname,
      t.status AS task_status,
      t.completed_claim_id,
      t.completed_at AS task_completed_at,
      s.file_name AS snapshot_file_name,
      s.original_duration AS snapshot_original_duration,
      s.roughcut_duration AS snapshot_roughcut_duration,
      s.removed_duration AS snapshot_removed_duration,
      s.status AS snapshot_status,
      s.created_at AS snapshot_created_at
    FROM dispatch_claims c
    JOIN dispatch_tasks t ON t.id = c.task_id
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN review_snapshots s ON s.id = c.snapshot_id
    WHERE c.status != 'abandoned'
    ORDER BY c.task_id ASC, c.claimed_at ASC, c.id ASC
  `),
  findDispatchReviewClaimById: db.prepare(`
    SELECT c.*, u.phone, u.nickname,
      t.status AS task_status,
      t.completed_claim_id,
      t.completed_at AS task_completed_at,
      s.file_name AS snapshot_file_name,
      s.original_duration AS snapshot_original_duration,
      s.roughcut_duration AS snapshot_roughcut_duration,
      s.removed_duration AS snapshot_removed_duration,
      s.status AS snapshot_status,
      s.created_at AS snapshot_created_at
    FROM dispatch_claims c
    JOIN dispatch_tasks t ON t.id = c.task_id
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN review_snapshots s ON s.id = c.snapshot_id
    WHERE c.id = ?
  `),
  insertDispatchClaim: db.prepare(`
    INSERT INTO dispatch_claims (task_id, user_id, status, claimed_at, claim_expires_at, updated_at)
    VALUES (@task_id, @user_id, @status, @claimed_at, @claim_expires_at, @updated_at)
  `),
  reactivateDispatchClaim: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'in_progress',
        claimed_at = @claimed_at,
        claim_expires_at = @claim_expires_at,
        updated_at = @updated_at,
        abandoned_at = NULL
    WHERE id = @id AND status IN ('abandoned', 'expired')
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
        claim_expires_at = NULL,
        project_id = @project_id,
        snapshot_id = @snapshot_id
    WHERE id = @id
      AND task_id = @task_id
      AND user_id = @user_id
      AND status IN ('in_progress', 'returned', 'submitted')
  `),
  saveExternalDispatchSubmission: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'submitted',
        submitted_at = @submitted_at,
        updated_at = @updated_at,
        claim_expires_at = NULL,
        external_submitted_at = @external_submitted_at,
        external_submission_url = @external_submission_url,
        external_tool = @external_tool,
        external_submission_json = @external_submission_json
    WHERE id = @id
      AND user_id = @user_id
      AND status IN ('in_progress', 'returned', 'submitted')
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
        claim_expires_at = @claim_expires_at,
        review_note = @review_note
    WHERE id = @id
      AND status != 'abandoned'
  `),
  markDispatchClaimRejected: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'rejected',
        reviewed_at = @reviewed_at,
        updated_at = @updated_at,
        review_note = @review_note
    WHERE id = @id
      AND status != 'abandoned'
  `),
  closeOtherDispatchClaimsForCompletedTask: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'closed_by_task_completed',
        reviewed_at = @reviewed_at,
        completed_at = @completed_at,
        updated_at = @updated_at,
        claim_expires_at = NULL,
        review_note = CASE
          WHEN review_note IS NULL OR review_note = '' THEN @review_note
          ELSE review_note
        END
    WHERE task_id = @task_id
      AND id != @id
      AND status IN ('in_progress', 'returned', 'submitted')
  `),
  expireDispatchClaims: db.prepare(`
    UPDATE dispatch_claims
    SET status = 'expired',
        updated_at = @updated_at,
        abandoned_at = @expired_at,
        review_note = CASE
          WHEN review_note IS NULL OR review_note = '' THEN '领取后 5 天内未提交，制作名额已释放。'
          ELSE review_note
        END
    WHERE status IN ('in_progress', 'returned')
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at <= @now
  `),
  insertDispatchNotification: db.prepare(`
    INSERT INTO dispatch_notifications (
      id, user_id, type, entity_type, entity_id, title, body, read_at, created_at
    ) VALUES (
      @id, @user_id, @type, @entity_type, @entity_id, @title, @body, NULL, @created_at
    )
  `),
  listDispatchNotificationsByUser: db.prepare(`
    SELECT *
    FROM dispatch_notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `),
};

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try {
      // Node 的 IncomingMessage 允许收到形如 `//` 或非法百分号编码的原始路径；
      // 这类请求不应打出 uncaught/stack trace，也不应被当成一次服务器故障。
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'invalid_url', message: '请求地址格式不正确。' });
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'money-scissors',
        time: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/training/')) {
      await handleAuth(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/api/feedback/')) {
      await handleFeedback(req, res, url);
      return;
    }

    if (url.pathname === '/api/visit') {
      await handleVisit(req, res);
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

    if (url.pathname.startsWith('/api/guest-review/')) {
      await handleGuestReview(req, res, url);
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

    if (url.pathname === '/api/voice/synthesize') {
      await handleVoiceSynthesize(req, res);
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

    // 先真正把短信发出去，成功了再落库计次；发送失败不扣次数，
    // 避免网络抖动/供应商偶发失败时学员被误锁 30 分钟（根因卡 003）。
    let sendResult;
    try {
      sendResult = await sendSmsCode(phone, code);
    } catch (error) {
      console.error(`[send-code] 发送失败，不计次数 ${maskPhone(phone)}: ${error && error.message}`);
      sendJson(res, 502, {
        error: 'sms_send_failed',
        message: '验证码发送失败，请稍后重试（本次不计入发送次数）。',
      });
      return;
    }

    const payload = {
      phone,
      code,
      expires_at: expiresAt,
      sent_day: today,
      last_sent_at: now.toISOString(),
    };
    statements.upsertVerificationCode.run(payload);

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

  if (req.method === 'GET' && url.pathname === '/api/training/day1-feedback') {
    const user = requireAuth(req, res);
    if (!user) return;
    const row = statements.findLatestConfirmedDay1FeedbackByUser.get(user.id);
    sendJson(res, 200, { feedback: publicDay1FeedbackForStudent(row) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/training/pdca') {
    const user = requireAuth(req, res);
    if (!user) return;
    const body = await readJson(req).catch(() => ({}));
    const homework = normalizePdcaHomework(body);
    if (!homework) {
      sendJson(res, 400, { error: 'empty_homework', message: '请至少填写一栏复盘内容。' });
      return;
    }
    statements.savePdcaHomework.run({
      id: user.id,
      pdca_homework: JSON.stringify(homework),
      last_active_at: new Date().toISOString(),
    });
    const updated = statements.findUserById.get(user.id);
    sendJson(res, 200, { user: publicUser(updated), homework: parsePdcaHomework(updated.pdca_homework) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/training/resume') {
    const user = requireAuth(req, res);
    if (!user) return;
    const body = await readJson(req).catch(() => ({}));
    const homework = normalizeResumeHomework(body);
    if (!homework) {
      sendJson(res, 400, { error: 'empty_homework', message: '请至少填写一栏简历内容。' });
      return;
    }
    statements.saveResumeHomework.run({
      id: user.id,
      resume_homework: JSON.stringify(homework),
      last_active_at: new Date().toISOString(),
    });
    const updated = statements.findUserById.get(user.id);
    sendJson(res, 200, { user: publicUser(updated), homework: parseResumeHomework(updated.resume_homework) });
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

async function handleVisit(req, res) {
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

  const body = await readJson(req, 16 * 1024).catch(() => ({}));
  const event = normalizeVisitEvent(body, req);
  if (!event) {
    sendJson(res, 400, { error: 'invalid_visit_event' });
    return;
  }
  const user = optionalAuthUser(req);
  statements.insertVisitEvent.run({
    ...event,
    user_id: user?.id || null,
  });
  sendJson(res, 200, { ok: true });
}

async function handleFeedback(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feedback/reports') {
    const user = requireAuth(req, res);
    if (!user) return;
    const body = await readJson(req, MAX_JSON_BYTES).catch(() => ({}));
    let report;
    try {
      report = normalizeFeedbackReport(body);
      validateFeedbackOwnership(report, user);
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.code || 'invalid_feedback_report',
        message: error.message || '反馈内容不完整。',
      });
      return;
    }
    const now = new Date().toISOString();
    const row = {
      id: buildPublicId('fb'),
      user_id: user.id,
      project_id: report.projectId,
      snapshot_id: report.snapshotId,
      dispatch_task_id: report.dispatchTaskId || null,
      dispatch_claim_id: report.dispatchClaimId || null,
      station: report.station,
      page: report.page,
      page_url: report.pageUrl,
      title: report.title,
      description: report.description,
      severity: report.severity,
      context_json: report.contextJson,
      attachment_json: report.attachmentJson,
      status: 'open',
      admin_note: '',
      created_at: now,
      updated_at: now,
      resolved_at: null,
    };
    statements.insertFeedbackReport.run(row);
    sendJson(res, 201, { report: publicFeedbackReport(statements.findFeedbackReport.get(row.id)) });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
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
function dispatchTaskStatus(row = {}) {
  return String(row.status || '').trim() === 'completed' || row.completed_claim_id || row.completed_at
    ? 'completed'
    : 'open';
}

function isDispatchTaskCompleted(row = {}) {
  return dispatchTaskStatus(row) === 'completed';
}

function effectiveDispatchMaxClaims(row = {}) {
  const raw = Number(row.max_claims ?? row.maxClaims ?? DISPATCH_DEFAULT_MAX_CLAIMS);
  if (!Number.isFinite(raw) || raw <= 0) return DISPATCH_DEFAULT_MAX_CLAIMS;
  return Math.min(raw, DISPATCH_DEFAULT_MAX_CLAIMS);
}

function buildDispatchClaimExpiry(nowIso) {
  return new Date(new Date(nowIso).getTime() + DISPATCH_CLAIM_TTL_MS).toISOString();
}

function releaseExpiredDispatchClaims() {
  const now = new Date().toISOString();
  return statements.expireDispatchClaims.run({
    now,
    updated_at: now,
    expired_at: now,
  });
}

function publicDispatchNotification(row) {
  return {
    id: row.id,
    type: row.type || '',
    entityType: row.entity_type || '',
    entityId: row.entity_id || null,
    title: row.title || '',
    body: row.body || '',
    readAt: row.read_at || null,
    createdAt: row.created_at || null,
    unread: !row.read_at,
  };
}

function cleanDispatchMaterialLink(value) {
  const raw = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/[，。；;、）)】\]]+$/g, '')
    .slice(0, 1000);
  if (!raw) return '';
  if (/^https?:\/\/\S+$/i.test(raw)) return raw;
  if (/^\/api\/orders\/material\/\S+$/.test(raw)) return raw;
  if (/^\/uploads\/\S+$/.test(raw)) return raw;
  return '';
}

function extractDispatchMaterialLinkFromDemand(demand) {
  const text = String(demand || '');
  const nearMaterial = text.match(/(?:素材链接|素材地址|网盘|百度网盘|下载对应嘉宾的素材|下载素材|素材)[\s\S]{0,200}?(https?:\/\/[^\s"'<>]+)/i);
  const fallback = /(?:素材|网盘|下载)/.test(text)
    ? text.match(/https?:\/\/[^\s"'<>]+/i)
    : null;
  return cleanDispatchMaterialLink(nearMaterial?.[1] || fallback?.[0] || '');
}

function dispatchMaterialLink(row = {}) {
  return cleanDispatchMaterialLink(row.material_link)
    || cleanDispatchMaterialLink(row.materialLink)
    || extractDispatchMaterialLinkFromDemand(row.demand);
}

function publicDispatchTask(row, viewer = null) {
  const maxClaims = effectiveDispatchMaxClaims(row);
  const claimCount = Number(statements.countClaimsByTask.get(row.id)?.count || 0);
  const reviewingCount = Number(statements.countReviewingClaimsByTask.get(row.id)?.count || 0);
  const completed = isDispatchTaskCompleted(row);
  const materialLink = dispatchMaterialLink(row);
  const canClaim = viewer?.id ? !completed && canUserClaimDispatchTask(row, viewer) : !completed;
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
    materialLink,
    visibility: dispatchTaskVisibility(row),
    assigneeRefs: viewer?.id ? '' : row.assignee_refs || '',
    assigneeLabel: dispatchAssigneeLabel(row),
    canClaim,
    claimBlockedReason: canClaim ? '' : completed ? '这单已经完结，不能再抢单。' : '这是一条指定学员单，仅指定学员可接。',
    published: Boolean(row.published),
    status: dispatchTaskStatus(row),
    completed: completed,
    completedClaimId: row.completed_claim_id || null,
    completedAt: row.completed_at || null,
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
    claimExpiresAt: row.claim_expires_at || null,
    reviewNote: row.review_note || '',
    projectId: row.project_id || '',
    snapshotId: row.snapshot_id || '',
    externalSubmission: publicExternalSubmission(row),
    task: {
      id: Number(row.task_id || task.id || 0),
      title: task.title || '',
      client: task.client || '',
      budget: task.budget || '',
      demand: task.demand || '',
      delivery: task.delivery || '',
      difficulty: task.difficulty || '',
      materialLink: dispatchMaterialLink(task),
      visibility: dispatchTaskVisibility(task),
      assigneeRefs: '',
      assigneeLabel: dispatchAssigneeLabel(task),
      published: Boolean(task.published),
      status: dispatchTaskStatus({
        ...task,
        status: task.task_status || task.status,
        completed_claim_id: task.completed_claim_id,
        completed_at: task.task_completed_at || task.completed_at,
      }),
      completed: isDispatchTaskCompleted({
        ...task,
        status: task.task_status || task.status,
        completed_claim_id: task.completed_claim_id,
        completed_at: task.task_completed_at || task.completed_at,
      }),
      completedClaimId: task.completed_claim_id || null,
      completedAt: task.task_completed_at || task.completed_at || null,
      maxClaims: effectiveDispatchMaxClaims(task),
      sortOrder: Number(task.sort_order || 0),
      createdAt: task.task_created_at || task.created_at || null,
      updatedAt: task.task_updated_at || task.updated_at || null,
    },
  };
}

function publicDispatchReviewClaim(row) {
  const snapshotStatus = row.snapshot_status || '';
  const visibleStatus = row.status === 'submitted'
    ? 'submitted'
    : snapshotStatus === 'rejected'
      ? (row.status === 'rejected' ? 'rejected' : 'returned')
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
    claimExpiresAt: row.claim_expires_at || null,
    reviewNote: row.review_note || '',
    projectId: row.project_id || '',
    snapshotId: row.snapshot_id || '',
    externalSubmission: publicExternalSubmission(row),
    snapshot: row.snapshot_id ? {
      id: row.snapshot_id,
      fileName: row.snapshot_file_name || '未命名音频',
      status: row.snapshot_status || 'pending_review',
      originalDuration: Number(row.snapshot_original_duration || 0),
      roughcutDuration: Number(row.snapshot_roughcut_duration || 0),
      removedDuration: Number(row.snapshot_removed_duration || 0),
      createdAt: row.snapshot_created_at || null,
    } : null,
    taskStatus: dispatchTaskStatus({
      status: row.task_status,
      completed_claim_id: row.completed_claim_id,
      completed_at: row.task_completed_at,
    }),
    taskCompleted: isDispatchTaskCompleted({
      status: row.task_status,
      completed_claim_id: row.completed_claim_id,
      completed_at: row.task_completed_at,
    }),
    taskCompletedClaimId: row.completed_claim_id || null,
    taskCompletedAt: row.task_completed_at || null,
  };
}

function publicExternalSubmission(row) {
  const raw = String(row?.external_submission_json || '').trim();
  let data = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch (_) {}
  }
  const url = String(data.url || row?.external_submission_url || '').trim();
  const tool = String(data.tool || row?.external_tool || '').trim();
  const description = String(data.description || '').trim();
  const submittedAt = data.submittedAt || row?.external_submitted_at || null;
  if (!url && !tool && !description) return null;
  return {
    url,
    tool,
    toolLabel: String(data.toolLabel || tool).trim(),
    description,
    durationText: String(data.durationText || '').trim(),
    fileName: String(data.fileName || '').trim(),
    notes: String(data.notes || '').trim(),
    submittedAt,
  };
}

function readDispatchTaskIdFromPayload(payload) {
  const raw = payload?.dispatchTask?.id;
  const taskId = Number(raw);
  return Number.isFinite(taskId) && taskId > 0 ? taskId : 0;
}

function readDispatchClaimIdFromPayload(payload) {
  const raw = payload?.dispatchTask?.claimId;
  const claimId = Number(raw);
  return Number.isFinite(claimId) && claimId > 0 ? claimId : 0;
}

function dispatchRowToBody(row) {
  return {
    title: row.title,
    client: row.client,
    budget: row.budget,
    demand: row.demand,
    delivery: row.delivery,
    difficulty: row.difficulty,
    materialLink: dispatchMaterialLink(row),
    visibility: dispatchTaskVisibility(row),
    assigneeRefs: row.assignee_refs || '',
    published: row.published,
    maxClaims: effectiveDispatchMaxClaims(row),
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
  const demand = String(body.demand == null ? '' : body.demand).slice(0, 4000);
  const materialLink = cleanDispatchMaterialLink(body.materialLink ?? body.material_link)
    || extractDispatchMaterialLinkFromDemand(demand);
  return {
    title: clean(body.title, 120),
    client: clean(body.client, 120),
    budget: clean(body.budget, 60),
    demand,
    delivery: String(body.delivery == null ? '' : body.delivery).slice(0, 2000),
    difficulty: clean(body.difficulty, 40),
    material_link: clean(materialLink, 1000),
    visibility,
    assignee_refs: visibility === 'assigned' ? assigneeRefs : '',
    published: body.published ? 1 : 0,
    max_claims: effectiveDispatchMaxClaims(body),
    sort_order: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
  };
}

function readExternalSubmissionInput(body) {
  const cleanLine = (value, max) => String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
  const cleanText = (value, max) => String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
  const tool = cleanLine(body.tool, 50);
  const toolLabel = cleanLine(body.toolLabel || body.tool_label || tool, 80);
  const url = normalizeExternalSubmissionUrl(body.url || body.link || body.externalSubmissionUrl);
  const description = cleanText(body.description || body.note || body.notes, 2000);
  return {
    tool,
    toolLabel,
    url,
    description,
    durationText: cleanLine(body.durationText || body.duration_text, 50),
    fileName: cleanLine(body.fileName || body.file_name, 180),
    notes: cleanText(body.extraNotes || body.extra_notes, 1000),
  };
}

function normalizeExternalSubmissionUrl(value) {
  const raw = String(value == null ? '' : value).trim().slice(0, 1000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.href;
  } catch (_) {
    return '';
  }
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

  releaseExpiredDispatchClaims();

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
    const notifications = statements.listDispatchNotificationsByUser.all(user.id).map(publicDispatchNotification);
    sendJson(res, 200, { claims, notifications });
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
    if (isDispatchTaskCompleted(task)) {
      sendJson(res, 409, {
        error: 'task_completed',
        message: '这单已经完结，不能再抢单。请去选择其他未完成订单。',
        task: publicDispatchTask(task, user),
      });
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
    if (existing && ['in_progress', 'returned', 'submitted'].includes(existing.status)) {
      sendJson(res, 200, {
        claim: publicDispatchClaim(existing, task),
        task: publicDispatchTask(task, user),
        reused: true,
      });
      return;
    }
    if (existing && !['abandoned', 'expired'].includes(existing.status)) {
      sendJson(res, 409, {
        error: 'claim_already_closed',
        message: '你在这单的记录已经结束，不能再次提交这单。请去选择其他未完成订单。',
        claim: publicDispatchClaim(existing, task),
        task: publicDispatchTask(task, user),
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

    const maxClaims = effectiveDispatchMaxClaims(task);
    const claimCount = Number(statements.countClaimsByTask.get(taskId)?.count || 0);
    if (claimCount >= maxClaims) {
      sendJson(res, 409, { error: 'claim_full', message: '这单已经满员了，换一单试试。' });
      return;
    }

    const now = new Date().toISOString();
    const claimExpiresAt = buildDispatchClaimExpiry(now);
    let claimId = existing?.id;
    if (existing && ['abandoned', 'expired'].includes(existing.status)) {
      statements.reactivateDispatchClaim.run({
        id: existing.id,
        claimed_at: now,
        claim_expires_at: claimExpiresAt,
        updated_at: now,
      });
      claimId = existing.id;
    } else {
      const info = statements.insertDispatchClaim.run({
        task_id: taskId,
        user_id: user.id,
        status: 'in_progress',
        claimed_at: now,
        claim_expires_at: claimExpiresAt,
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

  const externalSubmissionMatch = url.pathname.match(/^\/api\/orders\/claims\/(\d+)\/external-submission$/);
  if (externalSubmissionMatch && req.method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) return;
    if (!hasDay2Access(user)) {
      sendJson(res, 403, { error: 'day2_required', message: '请先完成第二天剪辑练习，并提交一次助教审核。' });
      return;
    }
    const claimId = Number(externalSubmissionMatch[1]);
    const claim = statements.findDispatchClaimByIdForUser.get({ id: claimId, user_id: user.id });
    if (!claim || claim.status === 'abandoned') {
      sendJson(res, 404, { error: 'claim_not_found', message: '没有找到这条接单记录。' });
      return;
    }
    const task = statements.findDispatchTask.get(claim.task_id);
    if (!task) {
      sendJson(res, 404, { error: 'task_not_found', message: '没有找到这条订单。' });
      return;
    }
    if (isDispatchTaskCompleted(task)) {
      sendJson(res, 409, {
        error: 'task_completed',
        message: '这单已经完结，不能再提交本单作品。请去选择其他未完成订单。',
        claim: publicDispatchClaim(claim, task),
      });
      return;
    }
    if (!['in_progress', 'returned', 'submitted'].includes(claim.status)) {
      sendJson(res, 409, { error: 'claim_not_editable', message: '这单当前不能重复提交。' });
      return;
    }
    const body = await readJson(req);
    const input = readExternalSubmissionInput(body);
    if (!input.tool) {
      sendJson(res, 400, { error: 'missing_tool', message: '请选择这单使用的工具。' });
      return;
    }
    if (!input.url) {
      sendJson(res, 400, { error: 'invalid_submission_url', message: '请粘贴一个能打开的 http 或 https 成品链接。' });
      return;
    }
    if (input.description.length < 8) {
      sendJson(res, 400, { error: 'missing_description', message: '文字说明至少写 8 个字，方便助教知道重点听哪里。' });
      return;
    }
    const now = new Date().toISOString();
    const payload = { ...input, submittedAt: now };
    const info = statements.saveExternalDispatchSubmission.run({
      id: claimId,
      user_id: user.id,
      submitted_at: now,
      updated_at: now,
      external_submitted_at: now,
      external_submission_url: input.url,
      external_tool: input.tool,
      external_submission_json: JSON.stringify(payload),
    });
    if (!info.changes) {
      sendJson(res, 409, { error: 'claim_not_editable', message: '这单当前不能提交，请刷新后再试。' });
      return;
    }
    const updated = statements.listDispatchClaimsByUser.all(user.id)
      .find((item) => Number(item.id) === claimId);
    sendJson(res, 200, {
      ok: true,
      claim: updated ? publicDispatchClaim(updated) : publicDispatchClaim(statements.findDispatchClaimByIdForUser.get({ id: claimId, user_id: user.id })),
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
    const hasSnapshot = Boolean(String(claim.snapshot_id || '').trim());
    const hasExternal = Boolean(publicExternalSubmission(claim));
    if (!hasSnapshot && !hasExternal) {
      sendJson(res, 400, { error: 'snapshot_or_external_required', message: '这条接单还没有提交审核作品。' });
      return;
    }
    const reviewTask = statements.findDispatchTask.get(claim.task_id);
    if (!reviewTask) {
      sendJson(res, 404, { error: 'task_not_found', message: '没有找到这条订单。' });
      return;
    }
    let snapshot = null;
    if (hasSnapshot) {
      snapshot = statements.findSnapshotById.get(claim.snapshot_id);
      if (!snapshot) {
        sendJson(res, 404, { error: 'snapshot_not_found', message: '没有找到这份审核快照。' });
        return;
      }
    }
    const body = await readJson(req);
    const action = String(body.status || body.action || '').trim();
    const approved = action === 'approved' || action === 'completed' || action === 'approve';
    const returned = action === 'returned' || action === 'return';
    const rejected = action === 'rejected' || action === 'reject';
    if (!approved && !returned && !rejected) {
      sendJson(res, 400, { error: 'invalid_status', message: '订单审核状态只能是通过、打回或未采用。' });
      return;
    }
    if (!approved && isDispatchTaskCompleted(reviewTask)) {
      sendJson(res, 409, {
        error: 'task_already_completed',
        message: '这条订单已完结，不能再打回或改成未采用。',
      });
      return;
    }
    const now = new Date().toISOString();
    const snapshotStatus = approved ? 'approved' : 'rejected';
    const note = String(body.note || '').trim().slice(0, 1000);
    const claimReviewStatus = approved ? 'completed' : rejected ? 'rejected' : 'returned';
    if (approved) {
      const approveTask = db.transaction(() => {
        const latestTask = statements.findDispatchTask.get(claim.task_id);
        if (!latestTask || isDispatchTaskCompleted(latestTask)) {
          const error = new Error('这条订单已被采用，请刷新查看最新状态。');
          error.code = 'task_already_completed';
          throw error;
        }
        const otherClaims = statements.listDispatchClaimsByTask.all(claim.task_id)
          .filter((item) => Number(item.id) !== claimId && ['in_progress', 'returned', 'submitted'].includes(item.status));
        const completed = statements.completeDispatchTask.run({
          id: claim.task_id,
          completed_claim_id: claimId,
          completed_at: now,
          completed_by: admin.id,
          updated_at: now,
        });
        if (!completed.changes) {
          const error = new Error('这条订单已被采用，请刷新查看最新状态。');
          error.code = 'task_already_completed';
          throw error;
        }
        if (snapshot) {
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
        }
        statements.markDispatchClaimApproved.run({
          id: claimId,
          reviewed_at: now,
          completed_at: now,
          updated_at: now,
          review_note: note,
        });
        statements.closeOtherDispatchClaimsForCompletedTask.run({
          task_id: claim.task_id,
          id: claimId,
          reviewed_at: now,
          completed_at: now,
          updated_at: now,
          review_note: '本单已采用其他作品，订单已完结。',
        });
        otherClaims.forEach((item) => {
          statements.insertDispatchNotification.run({
            id: buildPublicId('dn'),
            user_id: item.user_id,
            type: 'dispatch_task_completed',
            entity_type: 'dispatch_task',
            entity_id: claim.task_id,
            title: '本单已完结',
            body: `你领取的订单《${reviewTask.title || '未命名订单'}》已有学员完成并被采用，本单已完结，不能再提交这单。如想接单赚钱，请选择其他未完成订单。`,
            created_at: now,
          });
        });
      });
      try {
        approveTask();
      } catch (error) {
        if (error?.code === 'task_already_completed') {
          sendJson(res, 409, { error: 'task_already_completed', message: error.message });
          return;
        }
        throw error;
      }
    } else if (returned) {
      if (snapshot) {
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
      }
      statements.markDispatchClaimReturned.run({
        id: claimId,
        reviewed_at: now,
        updated_at: now,
        claim_expires_at: buildDispatchClaimExpiry(now),
        review_note: note,
      });
    } else {
      if (snapshot) {
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
      }
      statements.markDispatchClaimRejected.run({
        id: claimId,
        reviewed_at: now,
        updated_at: now,
        review_note: note,
      });
    }
    if (snapshot) {
      const data = readJsonFile(snapshot.data_path, {});
      writeJsonFile(snapshot.data_path, {
        ...data,
        status: snapshotStatus,
        reviewedAt: now,
        reviewedBy: admin.id,
        reviewNote: note,
        dispatchReview: {
          claimId,
          status: claimReviewStatus,
          reviewedAt: now,
          reviewedBy: admin.id,
          note,
        },
      });
    }
    sendJson(res, 200, {
      claim: publicDispatchReviewClaim(statements.findDispatchReviewClaimById.get(claimId)),
      snapshot: snapshot ? publicSnapshot(statements.findSnapshotById.get(snapshot.id)) : null,
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
    const dispatchTaskId = readDispatchTaskIdFromPayload(payload);
    let dispatchClaim = null;
    if (dispatchTaskId) {
      releaseExpiredDispatchClaims();
      const dispatchTask = statements.findDispatchTask.get(dispatchTaskId);
      if (!dispatchTask || isDispatchTaskCompleted(dispatchTask)) {
        sendJson(res, 409, {
          error: 'dispatch_task_completed',
          message: '这单已经完结，不能再提交本单作品。请去接单台选择其他未完成订单。',
        });
        return;
      }
      dispatchClaim = statements.findEditableDispatchClaimForSubmit.get({
        id: readDispatchClaimIdFromPayload(payload),
        task_id: dispatchTaskId,
        user_id: project.row.user_id,
      });
      if (!dispatchClaim) {
        sendJson(res, 409, {
          error: 'dispatch_claim_not_editable',
          message: '这单当前不能重复提交或已经结束，请回接单台查看状态。',
        });
        return;
      }
    }
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
    if (dispatchTaskId && dispatchClaim) {
      statements.markDispatchClaimSubmitted.run({
        id: dispatchClaim.id,
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

async function handleGuestReview(req, res, url) {
  setCors(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/api/guest-review/audio') {
    handleGuestReviewAudio(req, res);
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/api/guest-review/open') {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const body = await readJson(req, 16 * 1024);
  const token = String(body.token || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    sendJson(res, 404, { error: 'share_not_found', message: '这个审核链接无效。' });
    return;
  }
  const share = statements.findGuestReviewShareByTokenHash.get(hashGuestReviewToken(token));
  if (!share) {
    sendJson(res, 404, { error: 'share_not_found', message: '这个审核链接无效。' });
    return;
  }
  const expiresAt = Date.parse(share.expires_at || '');
  if (share.revoked_at || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    sendJson(res, 410, { error: 'share_expired', message: '这个审核链接已过期或已停用。' });
    return;
  }

  const data = readJsonFile(share.snapshot_data_path, null);
  if (!data || typeof data !== 'object') {
    sendJson(res, 404, { error: 'snapshot_not_found', message: '这份审核内容暂时无法读取。' });
    return;
  }
  const review = buildGuestReviewPayload(share, data);
  statements.touchGuestReviewShare.run({
    id: share.share_id,
    last_opened_at: new Date().toISOString(),
  });
  setGuestReviewCookie(res, share);
  sendJson(res, 200, { review });
}

function handleGuestReviewAudio(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const sessionToken = readCookie(req.headers.cookie, GUEST_REVIEW_COOKIE_NAME);
  let session;
  try {
    session = jwt.verify(sessionToken, JWT_SECRET);
  } catch {
    sendJson(res, 401, { error: 'guest_review_unauthorized', message: '请从完整的嘉宾审核链接重新打开。' });
    return;
  }
  if (session?.kind !== 'guest_review' || !session.shareId || !session.snapshotId) {
    sendJson(res, 401, { error: 'guest_review_unauthorized', message: '请从完整的嘉宾审核链接重新打开。' });
    return;
  }
  const share = statements.findGuestReviewShareById.get(String(session.shareId));
  const expiresAt = Date.parse(share?.expires_at || '');
  if (
    !share
    || share.revoked_at
    || String(share.snapshot_id) !== String(session.snapshotId)
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) {
    sendJson(res, 410, { error: 'share_expired', message: '这个审核链接已过期或已停用。' });
    return;
  }
  const data = readJsonFile(share.snapshot_data_path, null);
  const audioUrl = guestReviewSourceAudioUrl(data);
  if (!audioUrl) {
    sendJson(res, 404, { error: 'audio_not_found', message: '这份初剪暂时没有可试听的音频。' });
    return;
  }
  let redirectUrl = audioUrl;
  if (audioUrl.startsWith('/api/orders/material/')) {
    if (!oss.isOssEnabled()) {
      sendJson(res, 404, { error: 'audio_not_found', message: '试听音频暂时不可用。' });
      return;
    }
    try {
      redirectUrl = oss.signPublicUrl(readOrderMaterialObjectKeyFromPath(new URL(audioUrl, 'http://local').pathname));
    } catch (error) {
      console.error('[guest-review] 试听音频签名失败', error && error.message);
      sendJson(res, 404, { error: 'audio_not_found', message: '试听音频暂时不可用。' });
      return;
    }
  }
  res.writeHead(302, {
    Location: redirectUrl,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end();
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

  if (req.method === 'GET' && url.pathname === '/api/admin/visit-stats') {
    const days = clampNumber(Number(url.searchParams.get('days') || 7), 1, 30);
    const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
    since.setHours(0, 0, 0, 0);
    const events = statements.listVisitEventsSince.all({
      since: since.toISOString(),
      limit: 50000,
    });
    sendJson(res, 200, buildVisitStats(events, days));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/download-health') {
    const hours = clampNumber(Number(url.searchParams.get('hours') || 24), 1, 168);
    const limit = clampNumber(Number(url.searchParams.get('limit') || 20), 1, 100);
    sendJson(res, 200, buildDownloadHealth({ hours, limit }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/feedback/reports') {
    const status = normalizeFeedbackStatus(url.searchParams.get('status') || '') || '';
    const limit = clampNumber(Number(url.searchParams.get('limit') || 100), 1, 200);
    const reports = statements.listFeedbackReports.all({ status, limit }).map(publicFeedbackReport);
    sendJson(res, 200, { reports });
    return;
  }

  const feedbackAdminMatch = url.pathname.match(/^\/api\/admin\/feedback\/reports\/([A-Za-z0-9_-]+)$/);
  if (feedbackAdminMatch && req.method === 'PATCH') {
    const row = statements.findFeedbackReport.get(feedbackAdminMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: 'feedback_not_found', message: '没有找到这条反馈。' });
      return;
    }
    const body = await readJson(req).catch(() => ({}));
    const status = normalizeFeedbackStatus(body.status);
    if (!status) {
      sendJson(res, 400, { error: 'invalid_feedback_status', message: '反馈状态只能是 open、triaged、resolved 或 ignored。' });
      return;
    }
    const now = new Date().toISOString();
    statements.updateFeedbackReportStatus.run({
      id: row.id,
      status,
      admin_note: String(body.adminNote ?? row.admin_note ?? '').trim().slice(0, 1000),
      updated_at: now,
      resolved_at: status === 'resolved' ? now : null,
    });
    sendJson(res, 200, { report: publicFeedbackReport(statements.findFeedbackReport.get(row.id)) });
    return;
  }

  const userSnapMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/snapshots$/);
  if (req.method === 'GET' && userSnapMatch) {
    const snapshots = statements.listSnapshotsByUser.all(Number(userSnapMatch[1])).map(publicSnapshot);
    sendJson(res, 200, { snapshots });
    return;
  }

  const day1FeedbackBaseMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/day1-feedback$/);
  if (day1FeedbackBaseMatch && req.method === 'GET') {
    const target = statements.findUserById.get(Number(day1FeedbackBaseMatch[1]));
    if (!target) {
      sendJson(res, 404, { error: 'user_not_found', message: '没有找到这位学员。' });
      return;
    }
    const intro = parseDay1Intro(target.day1_intro);
    if (!intro) {
      sendJson(res, 200, { feedback: null, message: '这位学员还没有可反馈的 Day1 自我介绍。' });
      return;
    }
    const introHash = hashDay1Intro(target.day1_intro);
    const row = statements.findDay1FeedbackByUserHash.get({ user_id: target.id, intro_hash: introHash });
    sendJson(res, 200, { feedback: publicDay1FeedbackForAdmin(row), introHash });
    return;
  }

  const day1AiDraftMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/day1-feedback\/ai-draft$/);
  if (day1AiDraftMatch && req.method === 'POST') {
    if (!DEEPSEEK_KEY) {
      sendJson(res, 500, { error: 'missing_deepseek_key', message: '服务端未配置 DEEPSEEK_KEY。' });
      return;
    }
    const target = statements.findUserById.get(Number(day1AiDraftMatch[1]));
    if (!target) {
      sendJson(res, 404, { error: 'user_not_found', message: '没有找到这位学员。' });
      return;
    }
    const intro = parseDay1Intro(target.day1_intro);
    if (!intro) {
      sendJson(res, 400, { error: 'day1_intro_required', message: '这位学员还没有提交 Day1 自我介绍。' });
      return;
    }
    const body = await readJson(req).catch(() => ({}));
    const refresh = Boolean(body.refresh || url.searchParams.get('refresh') === '1');
    const introHash = hashDay1Intro(target.day1_intro);
    const existing = statements.findDay1FeedbackByUserHash.get({ user_id: target.id, intro_hash: introHash });
    if (existing && !refresh) {
      sendJson(res, 200, { feedback: publicDay1FeedbackForAdmin(existing), reused: true });
      return;
    }
    const messages = buildDay1FeedbackMessages(target, intro);
    let draftText = '';
    try {
      const ai = await fetchDeepseekChatJson({
        model: DEEPSEEK_MODEL,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
        messages,
      }, {
        timeoutMs: DEEPSEEK_TIMEOUT_MS,
        timeoutMessage: 'Day1 AI 反馈等待超时，请稍后重试。',
        errorMessage: 'AI 服务暂时不可用，请稍后重试。',
      });
      draftText = normalizeDay1FeedbackAiContent(ai.content);
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        error: error.code || 'day1_ai_failed',
        message: error.message || 'Day1 AI 反馈生成失败，请稍后重试。',
      });
      return;
    }
    const now = new Date().toISOString();
    const row = {
      id: existing?.id || buildPublicId('d1fb'),
      user_id: target.id,
      intro_hash: introHash,
      ai_draft: draftText,
      confirmed_text: existing?.confirmed_text || '',
      status: 'draft',
      model: DEEPSEEK_MODEL,
      prompt_version: 'day1_intro_feedback_v1',
      created_at: existing?.created_at || now,
      updated_at: now,
      confirmed_at: null,
      confirmed_by: null,
    };
    if (existing) statements.updateDay1Feedback.run(row);
    else statements.insertDay1Feedback.run(row);
    const saved = statements.findDay1FeedbackById.get(row.id);
    sendJson(res, existing ? 200 : 201, { feedback: publicDay1FeedbackForAdmin(saved), reused: false });
    return;
  }

  const day1FeedbackPatchMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/day1-feedback\/([A-Za-z0-9_-]+)$/);
  if (day1FeedbackPatchMatch && req.method === 'PATCH') {
    const targetUserId = Number(day1FeedbackPatchMatch[1]);
    const row = statements.findDay1FeedbackById.get(day1FeedbackPatchMatch[2]);
    if (!row || Number(row.user_id) !== targetUserId) {
      sendJson(res, 404, { error: 'day1_feedback_not_found', message: '没有找到这条 Day1 反馈。' });
      return;
    }
    const body = await readJson(req).catch(() => ({}));
    const status = normalizeDay1FeedbackStatus(body.status || row.status);
    if (!status) {
      sendJson(res, 400, { error: 'invalid_day1_feedback_status', message: '反馈状态只能是草稿、已确认或需人工处理。' });
      return;
    }
    const aiDraft = String(body.aiDraft ?? row.ai_draft ?? '').trim().slice(0, 3000);
    const confirmedText = String(body.confirmedText ?? row.confirmed_text ?? '').trim().slice(0, 3000);
    if (status === 'confirmed' && !confirmedText) {
      sendJson(res, 400, { error: 'confirmed_text_required', message: '确认反馈前，请先填写最终要给学员看的内容。' });
      return;
    }
    const now = new Date().toISOString();
    statements.updateDay1Feedback.run({
      id: row.id,
      ai_draft: aiDraft,
      confirmed_text: confirmedText,
      status,
      model: row.model || '',
      prompt_version: row.prompt_version || 'day1_intro_feedback_v1',
      updated_at: now,
      confirmed_at: status === 'confirmed' ? now : null,
      confirmed_by: status === 'confirmed' ? user.id : null,
    });
    sendJson(res, 200, { feedback: publicDay1FeedbackForAdmin(statements.findDay1FeedbackById.get(row.id)) });
    return;
  }

  const guestShareMatch = url.pathname.match(/^\/api\/admin\/snapshots\/([A-Za-z0-9_-]+)\/guest-share$/);
  if (guestShareMatch && req.method === 'POST') {
    const snapshot = statements.findSnapshotById.get(guestShareMatch[1]);
    if (!snapshot) {
      sendJson(res, 404, { error: 'snapshot_not_found', message: '没有找到这份审核快照。' });
      return;
    }
    const body = await readJson(req).catch(() => ({}));
    const requestedDays = Number(body.expiresInDays);
    const expiresInDays = Number.isFinite(requestedDays)
      ? clampNumber(Math.round(requestedDays), 1, GUEST_REVIEW_MAX_DAYS)
      : GUEST_REVIEW_DEFAULT_DAYS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const shareId = buildPublicId('share');
    const createShare = db.transaction(() => {
      statements.revokeGuestReviewSharesForSnapshot.run({
        snapshot_id: snapshot.id,
        revoked_at: now.toISOString(),
      });
      statements.insertGuestReviewShare.run({
        id: shareId,
        snapshot_id: snapshot.id,
        token_hash: hashGuestReviewToken(token),
        created_by: user.id,
        created_at: now.toISOString(),
        expires_at: expiresAt,
      });
    });
    createShare();
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 201, {
      share: {
        id: shareId,
        path: `/guest-review.html#${token}`,
        expiresAt,
      },
    });
    return;
  }

  if (guestShareMatch && req.method === 'DELETE') {
    const snapshot = statements.findSnapshotById.get(guestShareMatch[1]);
    if (!snapshot) {
      sendJson(res, 404, { error: 'snapshot_not_found', message: '没有找到这份审核快照。' });
      return;
    }
    const result = statements.revokeGuestReviewSharesForSnapshot.run({
      snapshot_id: snapshot.id,
      revoked_at: new Date().toISOString(),
    });
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { ok: true, revoked: Number(result.changes || 0) });
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
        model: DEEPSEEK_MODEL,
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
      ['手机号', '微信名', '注册时间', '最后活跃', '使用次数', 'D1作业', 'D2作业', 'PDCA复盘', '剪辑师简历', '已加微信', '备注', '管理员'].join(','),
      ...rows.map((row) => [
        csvCell(row.phone),
        csvCell(row.nickname || ''),
        csvCell(row.created_at),
        csvCell(row.last_active_at),
        row.usage_count,
        row.day1_complete ? '已完成' : '未完成',
        row.day2_complete ? '已完成' : '未完成',
        row.pdca_homework ? '已提交' : '未提交',
        row.resume_homework ? '已提交' : '未提交',
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
    try {
      fileUrl = normalizeDashScopeAudioUrl(fileUrl, req);
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: 'invalid_audio_url',
        message: error.message || '音频地址无效，请下载音频后重新上传。',
      });
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

function normalizeDashScopeAudioUrl(value, req) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\/uploads\/\S+/i.test(raw)) {
    const baseUrl = requestPublicBaseUrl(req);
    if (!baseUrl) {
      const error = new Error('音频地址缺少公网域名，请下载音频后重新上传。');
      error.statusCode = 400;
      throw error;
    }
    return new URL(raw, baseUrl).toString();
  }
  if (/^\//.test(raw)) {
    const error = new Error('音频地址无效，请下载音频后重新上传。');
    error.statusCode = 400;
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error('音频地址无效，请下载音频后重新上传。');
    error.statusCode = 400;
    throw error;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    const error = new Error('音频地址无效，请下载音频后重新上传。');
    error.statusCode = 400;
    throw error;
  }
  return parsed.toString();
}

function requestPublicBaseUrl(req) {
  const configuredBaseUrl = normalizeHttpBaseUrl(PUBLIC_BASE_URL);
  if (configuredBaseUrl) return configuredBaseUrl;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.host || '').split(',')[0].trim();
  if (host) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const proto = forwardedProto || (/^(www\.)?bokejianji\.cn(?::\d+)?$/i.test(host) ? 'https' : 'http');
    return normalizeHttpBaseUrl(`${proto}://${host}`);
  }
  return '';
}

function normalizeHttpBaseUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.origin.replace(/\/+$/g, '');
  } catch {
    return '';
  }
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
  const timeoutMs = body.purpose === 'decision_bundle' ? DEEPSEEK_DECISION_TIMEOUT_MS : DEEPSEEK_TIMEOUT_MS;

  await proxyJson(res, DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: body.model || DEEPSEEK_MODEL,
      max_tokens: Number(body.max_tokens || body.maxTokens || 8192),
      response_format: body.response_format || { type: 'json_object' },
      messages,
    }),
  }, {
    timeoutMs,
    timeoutMessage: 'AI 服务等待超时，请稍后重试。',
    errorMessage: 'AI 服务暂时不可用，请稍后重试。',
  });
}

async function handleVoiceSynthesize(req, res) {
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
  if (!API_KEY || !VOICE_TTS_ID) {
    sendJson(res, 503, { error: 'voice_service_unconfigured', message: '声音服务暂未配置，请联系助教。' });
    return;
  }

  const body = await readJson(req, 32 * 1024);
  const text = String(body.text || '').trim();
  if (!text) {
    sendJson(res, 400, { error: 'missing_text', message: '请先输入旁白文字。' });
    return;
  }
  if (text.length > VOICE_MAX_TEXT_CHARS) {
    sendJson(res, 400, {
      error: 'text_too_long',
      message: `单段最多 ${VOICE_MAX_TEXT_CHARS} 字，请分段生成。`,
    });
    return;
  }
  if (activeVoiceSynthesisUsers.has(user.id)) {
    sendJson(res, 429, { error: 'voice_generation_in_progress', message: '上一段声音还在生成，请稍候。' });
    return;
  }

  activeVoiceSynthesisUsers.add(user.id);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VOICE_TTS_TIMEOUT_MS);
    let upstream;
    let payload;
    try {
      upstream = await fetch(VOICE_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: VOICE_TTS_MODEL,
          input: { text },
          parameters: {
            text_type: 'PlainText',
            voice: VOICE_TTS_ID,
            format: 'mp3',
            sample_rate: 22050,
          },
        }),
        signal: controller.signal,
      });
      const raw = await upstream.text();
      try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      console.error('[voice] synthesis provider error', upstream.status, payload?.code || payload?.error?.code || 'unknown');
      sendJson(res, upstream.status === 429 ? 429 : 502, {
        error: upstream.status === 429 ? 'voice_rate_limited' : 'voice_provider_error',
        message: upstream.status === 429 ? '声音生成请求太多，请稍后重试。' : '声音服务暂时不可用，请稍后重试。',
      });
      return;
    }

    const audioUrl = String(payload?.output?.audio?.url || '').trim();
    let parsedAudioUrl;
    try { parsedAudioUrl = new URL(audioUrl); } catch { parsedAudioUrl = null; }
    const isAliyunAudioUrl = parsedAudioUrl
      && ['http:', 'https:'].includes(parsedAudioUrl.protocol)
      && (/(^|\.)aliyuncs\.com$/i.test(parsedAudioUrl.hostname)
        || /(^|\.)aliyun\.com$/i.test(parsedAudioUrl.hostname));
    if (!isAliyunAudioUrl) {
      console.error('[voice] synthesis provider returned no audio url');
      sendJson(res, 502, { error: 'voice_result_missing', message: '声音生成没有返回音频，请稍后重试。' });
      return;
    }

    const audioController = new AbortController();
    const audioTimer = setTimeout(() => audioController.abort(), VOICE_TTS_TIMEOUT_MS);
    let audioResponse;
    try {
      audioResponse = await fetch(audioUrl, { signal: audioController.signal });
    } finally {
      clearTimeout(audioTimer);
    }
    if (!audioResponse.ok) {
      console.error('[voice] audio download error', audioResponse.status);
      sendJson(res, 502, { error: 'voice_download_failed', message: '生成的音频暂时无法下载，请重试。' });
      return;
    }
    const audioBytes = Buffer.from(await audioResponse.arrayBuffer());
    if (!audioBytes.length) {
      sendJson(res, 502, { error: 'voice_empty_audio', message: '生成的音频为空，请重试。' });
      return;
    }

    recordUsage(user.id, 'voice_synthesis');
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBytes.length,
      'Content-Disposition': "inline; filename*=UTF-8''dangxiaoshi-voice.mp3",
      'Cache-Control': 'no-store',
    });
    res.end(audioBytes);
  } catch (error) {
    if (error?.name === 'AbortError') {
      sendJson(res, 504, { error: 'voice_timeout', message: '声音生成等待超时，请稍后重试。' });
      return;
    }
    console.error('[voice] synthesis failed', error?.message || error);
    sendJson(res, 502, { error: 'voice_unavailable', message: '声音服务暂时不可用，请稍后重试。' });
  } finally {
    activeVoiceSynthesisUsers.delete(user.id);
  }
}

async function serveStatic(req, res, url) {
  const aliasedPath = resolveStaticAlias(url.pathname);
  let pathname;
  try {
    pathname = decodeURIComponent(aliasedPath);
  } catch {
    sendJson(res, 400, { error: 'invalid_path', message: '请求路径格式不正确。' });
    return;
  }
  const normalizedPathname = path.posix.normalize(pathname);
  if (normalizedPathname === '/data' || normalizedPathname.startsWith('/data/')) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (normalizedPathname.split('/').some((part) => part.startsWith('.') && part !== '.well-known')) {
    sendJson(res, 404, { error: 'not_found' });
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

async function fetchDeepseekChatJson(payload, settings = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(settings.timeoutMs || 30 * 1000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!upstream.ok) {
      const error = new Error(data?.error?.message || data?.message || settings.errorMessage || 'AI 服务暂时不可用，请稍后重试。');
      error.statusCode = upstream.status || 502;
      error.code = data?.error?.type || data?.error || 'upstream_error';
      throw error;
    }
    const content = data?.choices?.[0]?.message?.content || '';
    return { data, content };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error(settings.timeoutMessage || '外部服务等待超时，请稍后重试。');
      timeout.statusCode = 504;
      timeout.code = 'upstream_timeout';
      throw timeout;
    }
    if (!error.statusCode) {
      error.statusCode = 502;
      error.code = error.code || 'upstream_error';
      error.message = settings.errorMessage || error.message || 'AI 服务暂时不可用，请稍后重试。';
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function setCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-proxy-check, x-money-scissors-silent-trouble');
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
      day2_complete INTEGER NOT NULL DEFAULT 0,
      day1_intro TEXT NOT NULL DEFAULT '',
      pdca_homework TEXT NOT NULL DEFAULT '',
      resume_homework TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS day1_feedbacks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      intro_hash TEXT NOT NULL DEFAULT '',
      ai_draft TEXT NOT NULL DEFAULT '',
      confirmed_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      model TEXT NOT NULL DEFAULT '',
      prompt_version TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confirmed_at TEXT,
      confirmed_by INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_day1_feedbacks_user_intro
      ON day1_feedbacks(user_id, intro_hash);
    CREATE INDEX IF NOT EXISTS idx_day1_feedbacks_status
      ON day1_feedbacks(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS feedback_reports (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      snapshot_id TEXT NOT NULL DEFAULT '',
      dispatch_task_id INTEGER,
      dispatch_claim_id INTEGER,
      station TEXT NOT NULL DEFAULT 'other',
      page TEXT NOT NULL DEFAULT '',
      page_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'normal',
      context_json TEXT NOT NULL DEFAULT '{}',
      attachment_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_reports_created
      ON feedback_reports(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_reports_user
      ON feedback_reports(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS download_events (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      job_id TEXT NOT NULL DEFAULT '',
      refine_job_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      page_url TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      browser TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_download_events_created
      ON download_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_download_events_job
      ON download_events(job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_download_events_user
      ON download_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_download_events_type
      ON download_events(event_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS visit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      event_type TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      referrer TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visit_events_created
      ON visit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visit_events_session_created
      ON visit_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visit_events_user_created
      ON visit_events(user_id, created_at DESC);

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

    CREATE TABLE IF NOT EXISTS guest_review_shares (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_opened_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_guest_review_shares_snapshot
      ON guest_review_shares(snapshot_id, created_at DESC);

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
      max_claims INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'open',
      completed_claim_id INTEGER,
      completed_at TEXT,
      completed_by INTEGER,
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
      claim_expires_at TEXT,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      reviewed_at TEXT,
      completed_at TEXT,
      abandoned_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      snapshot_id TEXT NOT NULL DEFAULT '',
      external_submission_json TEXT NOT NULL DEFAULT '',
      external_submission_url TEXT NOT NULL DEFAULT '',
      external_tool TEXT NOT NULL DEFAULT '',
      external_submitted_at TEXT,
      UNIQUE(task_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_claims_task
      ON dispatch_claims(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_claims_user
      ON dispatch_claims(user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS dispatch_notifications (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_notifications_user
      ON dispatch_notifications(user_id, read_at, created_at DESC);
  `);
  try { database.exec(`ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day1_complete INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day2_complete INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN day1_intro TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN pdca_homework TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE users ADD COLUMN resume_homework TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_review'`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN reviewed_at TEXT`); } catch {}
  try { database.exec(`ALTER TABLE review_snapshots ADD COLUMN reviewed_by INTEGER`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN max_claims INTEGER NOT NULL DEFAULT 2`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN assignee_refs TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN completed_claim_id INTEGER`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN completed_at TEXT`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_tasks ADD COLUMN completed_by INTEGER`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_claims ADD COLUMN claim_expires_at TEXT`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_claims ADD COLUMN external_submission_json TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_claims ADD COLUMN external_submission_url TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_claims ADD COLUMN external_tool TEXT NOT NULL DEFAULT ''`); } catch {}
  try { database.exec(`ALTER TABLE dispatch_claims ADD COLUMN external_submitted_at TEXT`); } catch {}
  database.exec(`
    UPDATE dispatch_claims
    SET claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+120 hours')
    WHERE status IN ('in_progress', 'returned')
      AND (claim_expires_at IS NULL OR claim_expires_at = '');

    UPDATE dispatch_tasks
    SET max_claims = 2
    WHERE max_claims IS NULL OR max_claims <= 0 OR max_claims > 2;

    UPDATE dispatch_tasks
    SET status = 'completed',
        completed_claim_id = (
          SELECT c.id
          FROM dispatch_claims c
          WHERE c.task_id = dispatch_tasks.id
            AND c.status = 'completed'
          ORDER BY c.completed_at DESC, c.id DESC
          LIMIT 1
        ),
        completed_at = (
          SELECT COALESCE(c.completed_at, c.reviewed_at, c.updated_at)
          FROM dispatch_claims c
          WHERE c.task_id = dispatch_tasks.id
            AND c.status = 'completed'
          ORDER BY c.completed_at DESC, c.id DESC
          LIMIT 1
        )
    WHERE status != 'completed'
      AND EXISTS (
        SELECT 1
        FROM dispatch_claims c
        WHERE c.task_id = dispatch_tasks.id
          AND c.status = 'completed'
      );

    UPDATE dispatch_claims
    SET status = 'closed_by_task_completed',
        reviewed_at = COALESCE(reviewed_at, (
          SELECT completed_at
          FROM dispatch_tasks t
          WHERE t.id = dispatch_claims.task_id
        )),
        completed_at = COALESCE(completed_at, (
          SELECT completed_at
          FROM dispatch_tasks t
          WHERE t.id = dispatch_claims.task_id
        )),
        updated_at = COALESCE((
          SELECT completed_at
          FROM dispatch_tasks t
          WHERE t.id = dispatch_claims.task_id
        ), updated_at),
        claim_expires_at = NULL,
        review_note = CASE
          WHEN review_note IS NULL OR review_note = '' THEN '本单已采用其他作品，订单已完结。'
          ELSE review_note
        END
    WHERE status IN ('in_progress', 'returned', 'submitted')
      AND EXISTS (
        SELECT 1
        FROM dispatch_tasks t
        WHERE t.id = dispatch_claims.task_id
          AND t.status = 'completed'
          AND COALESCE(t.completed_claim_id, 0) != dispatch_claims.id
      );
  `);
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

function optionalAuthUser(req) {
  const auth = req.headers.authorization || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = headerToken || readCookie(req.headers.cookie, AUTH_COOKIE_NAME);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return statements.findUserById.get(payload.userId) || null;
  } catch {
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

function setGuestReviewCookie(res, share) {
  if (!res || res.headersSent || !share?.share_id || !share?.snapshot_id || !JWT_SECRET) return;
  const secondsUntilShareExpires = Math.floor((Date.parse(share.expires_at || '') - Date.now()) / 1000);
  const maxAge = Math.max(1, Math.min(GUEST_REVIEW_SESSION_SECONDS, secondsUntilShareExpires));
  const token = jwt.sign({
    kind: 'guest_review',
    shareId: share.share_id,
    snapshotId: share.snapshot_id,
  }, JWT_SECRET, { expiresIn: maxAge });
  const secure = /^https:\/\//i.test(PUBLIC_BASE_URL) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${GUEST_REVIEW_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/api/guest-review/audio; HttpOnly; SameSite=Strict${secure}`,
  );
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

function hashDay1Intro(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function normalizeDay1FeedbackStatus(value) {
  const status = String(value || '').trim();
  if (['draft', 'confirmed', 'needs_manual'].includes(status)) return status;
  if (status === '草稿') return 'draft';
  if (status === '已确认') return 'confirmed';
  if (status === '需人工处理') return 'needs_manual';
  return '';
}

function normalizePdcaHomework(body) {
  if (!body || typeof body !== 'object') return null;
  const cap = (v) => String(v == null ? '' : v).trim().slice(0, 1800);
  const data = {
    plan: cap(body.plan),
    do: cap(body.do),
    check: cap(body.check),
    act: cap(body.act),
    savedAt: new Date().toISOString(),
  };
  if (![data.plan, data.do, data.check, data.act].some(Boolean)) return null;
  return data;
}

function parsePdcaHomework(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const data = {
      plan: String(obj.plan || ''),
      do: String(obj.do || ''),
      check: String(obj.check || ''),
      act: String(obj.act || ''),
      savedAt: obj.savedAt || null,
    };
    if (![data.plan, data.do, data.check, data.act].some(Boolean)) return null;
    return data;
  } catch {
    return null;
  }
}

function normalizeResumeHomework(body) {
  if (!body || typeof body !== 'object') return null;
  const cap = (v) => String(v == null ? '' : v).trim().slice(0, 1800);
  const version = ['newbie', 'practice', 'real'].includes(String(body.version || '')) ? String(body.version) : 'newbie';
  const data = {
    version,
    who: cap(body.who),
    canEdit: cap(body.canEdit),
    fitOrders: cap(body.fitOrders),
    delivery: cap(body.delivery),
    savedAt: new Date().toISOString(),
  };
  if (![data.who, data.canEdit, data.fitOrders, data.delivery].some(Boolean)) return null;
  return data;
}

function parseResumeHomework(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const version = ['newbie', 'practice', 'real'].includes(String(obj.version || '')) ? String(obj.version) : 'newbie';
    const data = {
      version,
      who: String(obj.who || ''),
      canEdit: String(obj.canEdit || ''),
      fitOrders: String(obj.fitOrders || ''),
      delivery: String(obj.delivery || ''),
      savedAt: obj.savedAt || null,
    };
    if (![data.who, data.canEdit, data.fitOrders, data.delivery].some(Boolean)) return null;
    return data;
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
    pdcaHomework: parsePdcaHomework(user.pdca_homework),
    resumeHomework: parseResumeHomework(user.resume_homework),
    snapshotCount: Number(user.snapshot_count || 0),
    pendingReviewCount: Number(user.pending_count || 0),
  };
}

function recordDownloadEvent(req, user, event = {}) {
  try {
    const detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    const userAgent = String(event.userAgent || req?.headers?.['user-agent'] || '').slice(0, 400);
    statements.insertDownloadEvent.run({
      id: crypto.randomBytes(10).toString('hex'),
      user_id: user?.id ? Number(user.id) : null,
      job_id: sanitizeEventId(event.jobId || event.job_id),
      refine_job_id: sanitizeEventId(event.refineJobId || event.refine_job_id),
      event_type: sanitizeEventType(event.eventType || event.event_type),
      stage: String(event.stage || '').trim().slice(0, 80),
      status: String(event.status || '').trim().slice(0, 80),
      message: String(event.message || '').trim().slice(0, 1000),
      detail_json: stringifyEventDetail(detail),
      page_url: sanitizeVisitPath(event.pageUrl || event.page_url || ''),
      user_agent: userAgent,
      browser: String(event.browser || detectBrowser(userAgent)).trim().slice(0, 80),
      ip: String(event.ip || (req ? getClientIp(req) : '')).slice(0, 80),
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[download-event] 写入失败', error.message || error);
  }
}

function recordCutJobEvent(job, eventType, message = '', detail = {}) {
  if (!job?.id) return;
  recordDownloadEvent(null, { id: job.userId }, {
    jobId: job.id,
    eventType,
    stage: job.stage || '',
    status: job.stage === 'error' ? 'failed' : job.stage || '',
    message,
    detail: {
      progress: Number(job.progress || 0),
      outputObjectKey: job.outputObjectKey ? 'present' : '',
      ...detail,
    },
  });
}

function publicDownloadEvent(row) {
  return {
    id: row.id,
    userId: row.user_id ? Number(row.user_id) : null,
    userPhone: row.phone ? maskPhone(row.phone) : '',
    userName: row.nickname || '',
    jobId: row.job_id || '',
    refineJobId: row.refine_job_id || '',
    eventType: row.event_type || '',
    stage: row.stage || '',
    status: row.status || '',
    message: row.message || '',
    detail: parseJsonObject(row.detail_json),
    pageUrl: row.page_url || '',
    browser: row.browser || '',
    userAgent: row.user_agent || '',
    createdAt: row.created_at || null,
  };
}

function sanitizeEventId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function sanitizeEventType(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80) || 'unknown';
}

function stringifyEventDetail(value) {
  try {
    return JSON.stringify(value || {}).slice(0, 4000);
  } catch {
    return '{}';
  }
}

function parseJsonObject(value) {
  try {
    const data = JSON.parse(value || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function detectBrowser(userAgent) {
  const ua = String(userAgent || '');
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome|CriOS/i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Android/i.test(ua)) return 'Safari';
  if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
  if (/node/i.test(ua)) return 'Node';
  return ua ? 'Other' : '';
}

function normalizeVisitEvent(body, req) {
  if (!body || typeof body !== 'object') return null;
  const sessionId = String(body.sessionId || body.session_id || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 80);
  if (!sessionId) return null;
  const eventType = String(body.eventType || body.event_type || '').trim();
  if (!['pageview', 'heartbeat'].includes(eventType)) return null;
  const rawDuration = Number(body.durationSeconds || body.duration_seconds || 0);
  const durationSeconds = eventType === 'heartbeat'
    ? Math.round(clampNumber(Number.isFinite(rawDuration) ? rawDuration : 0, 1, 30))
    : 0;
  return {
    session_id: sessionId,
    event_type: eventType,
    path: sanitizeVisitPath(body.path || body.pageUrl || body.page_url),
    title: String(body.title || '').trim().slice(0, 120),
    referrer: sanitizeVisitPath(body.referrer || ''),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    ip: getClientIp(req).slice(0, 80),
    duration_seconds: durationSeconds,
    created_at: new Date().toISOString(),
  };
}

function sanitizeVisitPath(value) {
  const raw = String(value || '').trim().slice(0, 600);
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://local.invalid');
    parsed.searchParams.delete('token');
    parsed.searchParams.delete('jinqian_token');
    parsed.searchParams.delete('code');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`.slice(0, 500);
  } catch {
    return raw
      .replace(/(token|jinqian_token|code)=[^&]+/gi, '$1=')
      .slice(0, 500);
  }
}

function buildVisitStats(events, days) {
  const dayKeys = recentChinaDayKeys(days);
  const byDay = new Map(dayKeys.map((day) => [day, {
    day,
    visitors: new Set(),
    loggedInUsers: new Set(),
    pageviews: 0,
    heartbeats: 0,
    onlineSeconds: 0,
  }]));
  const topPages = new Map();
  const recentUsers = new Map();
  const onlineSessions = new Set();
  const onlineCutoff = Date.now() - 90 * 1000;

  events.forEach((event) => {
    const day = chinaDayKey(event.created_at);
    const row = byDay.get(day);
    if (!row) return;
    const sessionId = String(event.session_id || '');
    if (sessionId) row.visitors.add(sessionId);
    if (event.user_id) {
      row.loggedInUsers.add(Number(event.user_id));
      if (!recentUsers.has(event.user_id)) {
        recentUsers.set(event.user_id, {
          id: Number(event.user_id),
          name: event.nickname || maskPhone(event.phone || ''),
          lastSeenAt: event.created_at,
          path: event.path || '',
        });
      }
    }
    if (event.event_type === 'pageview') {
      row.pageviews += 1;
      const pathKey = event.path || '/';
      topPages.set(pathKey, (topPages.get(pathKey) || 0) + 1);
    }
    if (event.event_type === 'heartbeat') {
      row.heartbeats += 1;
      row.onlineSeconds += clampNumber(Number(event.duration_seconds || 0), 0, 30);
      if (Date.parse(event.created_at) >= onlineCutoff && sessionId) onlineSessions.add(sessionId);
    }
  });

  const summary = dayKeys.map((day) => {
    const row = byDay.get(day);
    return {
      day,
      visitors: row.visitors.size,
      loggedInUsers: row.loggedInUsers.size,
      pageviews: row.pageviews,
      heartbeats: row.heartbeats,
      onlineSeconds: Math.round(row.onlineSeconds),
      avgOnlineSeconds: row.visitors.size ? Math.round(row.onlineSeconds / row.visitors.size) : 0,
    };
  });

  const totals = summary.reduce((acc, row) => ({
    visitors: acc.visitors + row.visitors,
    loggedInUsers: acc.loggedInUsers + row.loggedInUsers,
    pageviews: acc.pageviews + row.pageviews,
    onlineSeconds: acc.onlineSeconds + row.onlineSeconds,
  }), { visitors: 0, loggedInUsers: 0, pageviews: 0, onlineSeconds: 0 });

  return {
    summary,
    totals,
    onlineNow: onlineSessions.size,
    topPages: Array.from(topPages.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, count]) => ({ path, count })),
    recentUsers: Array.from(recentUsers.values()).slice(0, 12),
  };
}

function buildDownloadHealth(options = {}) {
  const hours = clampNumber(Number(options.hours || 24), 1, 168);
  const limit = clampNumber(Number(options.limit || 20), 1, 100);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const events = statements.listDownloadEventsSince.all({ since, limit: 5000 });
  const failures = statements.listDownloadFailuresSince.all({ since, limit });
  const readyJobs = new Set();
  const failedJobs = new Set();
  const validationFailedJobs = new Set();
  const refineStartedJobs = new Set();
  const refineDoneJobs = new Set();
  const refineFailedJobs = new Set();
  let downloadClicks = 0;
  let downloadRedirects = 0;
  let fallbackCount = 0;

  events.forEach((event) => {
    const jobKey = event.job_id || event.refine_job_id || event.id;
    if (event.event_type === 'ready') readyJobs.add(jobKey);
    if (event.event_type === 'failed') {
      if (isExpectedInputFailure(event)) validationFailedJobs.add(jobKey);
      else failedJobs.add(jobKey);
    }
    if (event.event_type === 'download_clicked') downloadClicks += 1;
    if (event.event_type === 'download_redirect' || event.event_type === 'download_started') downloadRedirects += 1;
    if (event.event_type === 'refine_started') refineStartedJobs.add(event.refine_job_id || event.id);
    if (event.event_type === 'refine_done') refineDoneJobs.add(event.refine_job_id || event.id);
    if (event.event_type === 'refine_failed') refineFailedJobs.add(event.refine_job_id || event.id);
    if (event.event_type === 'fallback_to_roughcut') fallbackCount += 1;
  });

  const completed = readyJobs.size + failedJobs.size;
  const successRate = completed ? Math.round((readyJobs.size / completed) * 1000) / 10 : null;
  return {
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    summary: {
      events: events.length,
      readyJobs: readyJobs.size,
      failedJobs: failedJobs.size,
      validationFailedJobs: validationFailedJobs.size,
      successRate,
      downloadClicks,
      downloadRedirects,
      refineStarted: refineStartedJobs.size,
      refineDone: refineDoneJobs.size,
      refineFailed: refineFailedJobs.size,
      fallbackCount,
    },
    cutQueue: {
      activeJobs: countRunningCutJobs(),
      queuedJobs: countQueuedCutJobs(),
      pendingJobs: countPendingCutJobs(),
      maxActiveJobs: CUT_MAX_ACTIVE_JOBS,
      maxQueuedJobs: CUT_MAX_QUEUED_JOBS,
      perUserLimit: CUT_MAX_ACTIVE_JOBS_PER_USER,
    },
    refineQueue: {
      activeJobs: countActiveRefineJobs(),
      maxActiveJobs: REFINE_MAX_ACTIVE_JOBS,
      perUserLimit: REFINE_MAX_ACTIVE_JOBS_PER_USER,
    },
    process: {
      startedAt: SERVER_STARTED_AT,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    sentinel: readDownloadWatchLatest(),
    recentFailures: failures.map(publicDownloadEvent),
    recentEvents: events.slice(0, limit).map(publicDownloadEvent),
  };
}

function isExpectedInputFailure(event) {
  const status = String(event.status || '');
  const message = String(event.message || '');
  return status === 'invalid_cut_segments'
    || status === 'missing_audio_url'
    || status === 'invalid_audio_url'
    || status === 'forbidden_oss_object'
    || /删除段第 \d+ 段|所有音频都被标记删除|格式不正确|超过原音频时长/.test(message);
}

function readDownloadWatchLatest() {
  try {
    if (!fs.existsSync(DOWNLOAD_WATCH_LATEST_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(DOWNLOAD_WATCH_LATEST_PATH, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return {
      status: data.status || '',
      mode: data.mode || '',
      startedAt: data.startedAt || null,
      finishedAt: data.finishedAt || null,
      durationSeconds: Number(data.durationSeconds || 0),
      summary: String(data.summary || '').slice(0, 1000),
    };
  } catch {
    return null;
  }
}

function recentChinaDayKeys(days) {
  const now = Date.now();
  const result = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    result.push(chinaDayKey(new Date(now - i * 24 * 60 * 60 * 1000).toISOString()));
  }
  return result;
}

function chinaDayKey(value) {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

function buildGuestReviewPayload(share, data) {
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const cutPayload = data.cutPayload && typeof data.cutPayload === 'object' ? data.cutPayload : {};
  const editState = payload.editState && typeof payload.editState === 'object' ? payload.editState : {};
  const deletedIds = new Set(
    (Array.isArray(editState.d) ? editState.d : [])
      .map((value) => Number(value))
      .filter(Number.isFinite),
  );
  const partialState = editState.p && typeof editState.p === 'object' && !Array.isArray(editState.p)
    ? editState.p
    : {};
  const sentences = (Array.isArray(payload.S) ? payload.S : []).map((sentence, position) => {
    const idValue = Number(sentence?.idx);
    const id = Number.isFinite(idValue) ? idValue : position;
    const wordText = Array.isArray(sentence?.w)
      ? sentence.w.map((word) => String(word?.t || '')).join('')
      : '';
    const text = String(wordText || sentence?.t || '').slice(0, 20000);
    const rawPartials = partialState[id] || partialState[String(id)] || [];
    const partialCuts = (Array.isArray(rawPartials) ? rawPartials : [])
      .map((range) => ({
        startChar: Math.max(0, Math.round(Number(range?.cs) || 0)),
        endChar: Math.max(0, Math.round(Number(range?.ce) || 0)),
      }))
      .filter((range) => range.endChar > range.startChar && range.startChar < text.length)
      .map((range) => ({ ...range, endChar: Math.min(text.length, range.endChar) }));
    return {
      id,
      speaker: String(sentence?.sp || '嘉宾').trim().slice(0, 80) || '嘉宾',
      text,
      start: round3(Math.max(0, Number(sentence?.s) || 0)),
      end: round3(Math.max(0, Number(sentence?.e) || 0)),
      deleted: deletedIds.has(id),
      partialCuts,
    };
  });
  const duration = Math.max(
    0,
    Number(share.original_duration) || Number(cutPayload.original_duration) || Number(sentences.at(-1)?.end) || 0,
  );
  let cuts = [];
  try {
    cuts = normalizeCutSegments(cutPayload.segments || [], {
      duration,
      label: '审核删减段',
      allowEmpty: true,
    });
  } catch (error) {
    console.warn('[guest-review] 审核删减段读取失败', error && error.message);
  }
  const sourceAudioUrl = guestReviewSourceAudioUrl(data);
  const rawChapters = Array.isArray(payload.CHAPS)
    ? payload.CHAPS
    : Array.isArray(payload.chapters)
      ? payload.chapters
      : [];
  const chapters = rawChapters.slice(0, 200).map((chapter) => ({
    startId: Math.max(0, Math.round(Number(chapter?.startIdx ?? chapter?.startId) || 0)),
    title: String(chapter?.title || '').trim().slice(0, 300),
    description: String(chapter?.desc || chapter?.description || '').trim().slice(0, 500),
  })).filter((chapter) => chapter.title);

  return {
    title: String(share.file_name || '播客初剪').trim().slice(0, 180) || '播客初剪',
    createdAt: share.snapshot_created_at || null,
    expiresAt: share.expires_at,
    originalDuration: Math.round(duration),
    roughcutDuration: Math.max(0, Math.round(Number(share.roughcut_duration) || 0)),
    removedDuration: Math.max(0, Math.round(Number(share.removed_duration) || 0)),
    audioUrl: sourceAudioUrl ? '/api/guest-review/audio' : '',
    cuts,
    chapters,
    sentences,
  };
}

function guestReviewSourceAudioUrl(data) {
  if (!data || typeof data !== 'object') return '';
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const cutPayload = data.cutPayload && typeof data.cutPayload === 'object' ? data.cutPayload : {};
  const audioSource = projectPayloadForResponse({
    storage: cutPayload.storage || payload.storage || '',
    objectKey: cutPayload.objectKey || payload.objectKey || '',
    audioUrl: cutPayload.audioUrl || payload.audioUrl || '',
    bucket: cutPayload.bucket || payload.bucket || '',
    region: cutPayload.region || payload.region || '',
  }) || {};
  return safeGuestMediaUrl(audioSource.audioUrl);
}

function safeGuestMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const parsed = new URL(raw);
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function publicDay1FeedbackForAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: Number(row.user_id || 0),
    introHash: row.intro_hash || '',
    aiDraft: row.ai_draft || '',
    confirmedText: row.confirmed_text || '',
    status: row.status || 'draft',
    model: row.model || '',
    promptVersion: row.prompt_version || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    confirmedAt: row.confirmed_at || null,
    confirmedBy: row.confirmed_by ? Number(row.confirmed_by) : null,
  };
}

function publicDay1FeedbackForStudent(row) {
  if (!row || row.status !== 'confirmed' || !String(row.confirmed_text || '').trim()) return null;
  return {
    status: 'confirmed',
    text: row.confirmed_text || '',
    confirmedAt: row.confirmed_at || null,
  };
}

function normalizeFeedbackReport(body) {
  if (!body || typeof body !== 'object') {
    const error = new Error('请填写反馈内容。');
    error.code = 'empty_feedback';
    throw error;
  }
  const cap = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const title = cap(body.title, 120);
  const description = cap(body.description, 2000);
  if (!title && !description) {
    const error = new Error('请至少写一句你遇到的问题。');
    error.code = 'empty_feedback';
    throw error;
  }
  const contextJson = safeLimitedJson(body.context || {}, 20 * 1024, '问题上下文太大，请少填一点。');
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : [];
  const attachmentJson = safeLimitedJson(attachments, 8 * 1024, '附件信息太多，请最多保留 3 条链接。');
  return {
    projectId: cap(body.projectId || body.project_id, 80),
    snapshotId: cap(body.snapshotId || body.snapshot_id, 80),
    dispatchTaskId: readOptionalInteger(body.dispatchTaskId ?? body.dispatch_task_id),
    dispatchClaimId: readOptionalInteger(body.dispatchClaimId ?? body.dispatch_claim_id),
    station: normalizeFeedbackStation(body.station),
    page: cap(body.page, 80) || 'other',
    pageUrl: sanitizePageUrl(body.pageUrl || body.page_url),
    title,
    description,
    severity: normalizeFeedbackSeverity(body.severity),
    contextJson,
    attachmentJson,
  };
}

function validateFeedbackOwnership(report, user) {
  const isAdmin = Boolean(user.is_admin) || ADMIN_PHONES.has(user.phone);
  if (report.projectId) {
    const project = statements.findProjectById.get(report.projectId);
    if (!project) throw feedbackError(404, 'project_not_found', '没有找到这个项目。');
    if (!isAdmin && Number(project.user_id) !== Number(user.id)) {
      throw feedbackError(403, 'forbidden_project', '你不能给别人的项目提交反馈。');
    }
  }
  if (report.snapshotId) {
    const snapshot = statements.findSnapshotById.get(report.snapshotId);
    if (!snapshot) throw feedbackError(404, 'snapshot_not_found', '没有找到这份审核记录。');
    if (!isAdmin && Number(snapshot.user_id) !== Number(user.id)) {
      throw feedbackError(403, 'forbidden_snapshot', '你不能给别人的审核记录提交反馈。');
    }
  }
  if (report.dispatchClaimId && !isAdmin) {
    const claim = statements.findDispatchClaimByIdForUser.get({ id: report.dispatchClaimId, user_id: user.id });
    if (!claim) throw feedbackError(403, 'forbidden_claim', '你不能给别人的接单记录提交反馈。');
  }
}

function feedbackError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function publicFeedbackReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: Number(row.user_id || 0),
    userName: row.nickname || '',
    userPhone: row.phone ? maskPhone(row.phone) : '',
    projectId: row.project_id || '',
    snapshotId: row.snapshot_id || '',
    dispatchTaskId: row.dispatch_task_id ? Number(row.dispatch_task_id) : null,
    dispatchClaimId: row.dispatch_claim_id ? Number(row.dispatch_claim_id) : null,
    station: row.station || 'other',
    page: row.page || '',
    pageUrl: row.page_url || '',
    title: row.title || '',
    description: row.description || '',
    severity: row.severity || 'normal',
    context: parseJsonObject(row.context_json, {}),
    attachments: parseJsonObject(row.attachment_json, []),
    status: row.status || 'open',
    adminNote: row.admin_note || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    resolvedAt: row.resolved_at || null,
  };
}

function normalizeFeedbackStation(value) {
  const station = String(value || '').trim();
  return ['training', 'editor', 'orders', 'login', 'other'].includes(station) ? station : 'other';
}

function normalizeFeedbackSeverity(value) {
  const severity = String(value || '').trim();
  return severity === 'blocking' ? 'blocking' : 'normal';
}

function normalizeFeedbackStatus(value) {
  const status = String(value || '').trim();
  return ['open', 'triaged', 'resolved', 'ignored'].includes(status) ? status : '';
}

function readOptionalInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function safeLimitedJson(value, maxBytes, message) {
  const json = JSON.stringify(value == null ? {} : value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    const error = new Error(message);
    error.code = 'payload_too_large';
    throw error;
  }
  return json;
}

function sanitizePageUrl(value) {
  const raw = String(value || '').trim().slice(0, 500);
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'http://local');
    parsed.searchParams.delete('token');
    parsed.searchParams.delete('jinqian_token');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`.slice(0, 500);
  } catch {
    return raw.replace(/(token|jinqian_token)=[^&]+/gi, '$1=').slice(0, 500);
  }
}

function parseJsonObject(raw, fallback) {
  try {
    const data = JSON.parse(String(raw || ''));
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
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

function buildDay1FeedbackMessages(user, intro) {
  const fields = Array.isArray(intro.fields) ? intro.fields : [];
  const questions = ['你是谁', '为什么加入剪辑营', '第一天最触动你的一点', '你 21 天的目标'];
  const answers = questions
    .map((question, index) => `${index + 1}. ${question}\n${String(fields[index] || '').trim() || '（未填写）'}`)
    .join('\n\n');
  const nickname = intro.nickname || user.nickname || maskPhone(user.phone);
  const system = [
    '你是金钱剪刀剪辑营的温暖但有判断力的助教。',
    '你要根据学员 Day1 自我介绍，生成一份给主助教看的反馈草稿。',
    '这份反馈不会自动发给学员，主助教会先看、修改、确认。',
    '',
    '反馈目标：让学员感到被看见，同时知道接下来 24 小时最该做什么。',
    '',
    '硬规则：',
    '- 不打分，不排名，不诊断人格。',
    '- 不说“你适合/不适合赚钱”这类终局判断。',
    '- 不要空泛鸡汤，要引用学员自己的表达。',
    '- 先肯定一个真实优势，再指出一个可能卡点，最后给一个小行动。',
    '- 语气像当当和助教私下认真回复，不要像客服。',
    '',
    '只输出 JSON，结构如下：',
    '{',
    '  "summary": "一句话看见这个学员的优势",',
    '  "strengths": ["真实优势1", "真实优势2"],',
    '  "risk": "最可能卡住他的地方，语气温和",',
    '  "nextStep": "接下来24小时最该做的一步",',
    '  "messageToStudent": "可直接发给学员的300到600字反馈"',
    '}',
  ].join('\n');
  const userMsg = [
    `学员昵称：${nickname}`,
    '',
    'Day1 自我介绍内容：',
    answers,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: userMsg },
  ];
}

function normalizeDay1FeedbackAiContent(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('AI 没有返回反馈内容。');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!parsed || typeof parsed !== 'object') return text.slice(0, 3000);
  const message = String(parsed.messageToStudent || '').trim();
  if (message) return message.slice(0, 3000);
  const lines = [
    parsed.summary ? `我先说一个很明显的优点：${parsed.summary}` : '',
    Array.isArray(parsed.strengths) && parsed.strengths.length ? `我看到你的积累：${parsed.strengths.join('；')}` : '',
    parsed.risk ? `接下来最容易卡住你的地方可能是：${parsed.risk}` : '',
    parsed.nextStep ? `所以接下来 24 小时，先做这一件事：${parsed.nextStep}` : '',
  ].filter(Boolean);
  if (!lines.length) throw new Error('AI 返回内容缺少可用反馈。');
  return lines.join('\n\n').slice(0, 3000);
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

function hashGuestReviewToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
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

  if (req.method === 'GET' && url.pathname.startsWith('/api/cut/download/')) {
    await sendCutDownload(req, res, url, optionalAuthUser(req), { allowAnonymousTicket: true });
    return;
  }

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

  if (req.method === 'POST' && url.pathname === '/api/cut/events') {
    const body = await readJson(req).catch(() => ({}));
    recordDownloadEvent(req, user, {
      jobId: body.jobId,
      refineJobId: body.refineJobId,
      eventType: body.eventType,
      stage: body.stage,
      status: body.status,
      message: body.message,
      detail: body.detail,
      pageUrl: body.pageUrl,
      browser: body.browser,
      userAgent: body.userAgent,
    });
    sendJson(res, 202, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/cut/start') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    const body = await readJson(req, MAX_PROJECT_JSON_BYTES);
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
    const originalDuration = Number(body.originalDuration || body.original_duration || 0);
    let segments;
    let goldenSegments;
    try {
      segments = normalizeCutSegments(body.segments, {
        label: '删除段',
        allowEmpty: true,
      });
      // 金句前置：从同一条原始音频里提取的金句时间段（仍保留在正文里，这里只是另存一份拼到开头）。
      goldenSegments = normalizeCutSegments(body.goldenSegments, {
        label: '金句段',
        allowEmpty: true,
      });
    } catch (error) {
      sendJson(res, 400, {
        error: 'invalid_cut_segments',
        message: error.message || '删除段格式不正确，请回到审稿页重新生成备用 MP3。',
      });
      recordDownloadEvent(req, user, {
        eventType: 'failed',
        stage: 'created',
        status: 'invalid_cut_segments',
        message: error.message || '删除段格式不正确',
        detail: { reason: 'invalid_cut_segments' },
      });
      return;
    }
    if (!useOss && !audioUrl) {
      sendJson(res, 400, { error: 'missing_audio_url', message: '缺少原始音频 URL，请从审查页重新导出。' });
      recordDownloadEvent(req, user, {
        eventType: 'failed',
        stage: 'created',
        status: 'missing_audio_url',
        message: '缺少原始音频 URL',
      });
      return;
    }
    const payloadSignature = buildCutPayloadSignature({ ...body, segments, goldenSegments });
    const existingUserJob = findPendingCutJob(user.id);
    const activeUserJobCount = countPendingCutJobs(user.id);
    if (existingUserJob?.payloadSignature && existingUserJob.payloadSignature === payloadSignature) {
      recordDownloadEvent(req, user, {
        jobId: existingUserJob.id,
        eventType: 'queued',
        stage: existingUserJob.stage,
        status: 'resumed_existing',
        message: '继续等待已有导出任务',
      });
      sendJson(res, 202, cutJobStatusPayload(existingUserJob));
      return;
    }
    if (activeUserJobCount >= CUT_MAX_ACTIVE_JOBS_PER_USER) {
      sendJson(res, 429, {
        error: 'cut_user_busy',
        message: '你已有另一份备用 MP3 正在排队或生成中，请等它完成后再生成新的。',
        retryAfterSeconds: 30,
      });
      recordDownloadEvent(req, user, {
        eventType: 'failed',
        stage: 'created',
        status: 'cut_user_busy',
        message: '账号已有另一份备用 MP3 正在排队或生成中',
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
      recordDownloadEvent(req, user, {
        eventType: 'failed',
        stage: 'created',
        status: 'cut_queue_full',
        message: '生成备用 MP3 队列已满',
        detail: {
          activeJobs: countRunningCutJobs(),
          queuedJobs: countQueuedCutJobs(),
        },
      });
      return;
    }
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
      recordDownloadEvent(req, user, {
        eventType: 'failed',
        stage: 'created',
        status: error.statusCode === 403 ? 'forbidden_oss_object' : 'invalid_audio_url',
        message: error.message || '原始音频地址无效',
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
      originalDuration,
      createdAt: Date.now(),
      queuedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      updatedAt: Date.now(),
      error: null,
    };
    cutJobs.set(jobId, job);
    persistCutJob(job, { force: true });
    recordDownloadEvent(req, user, {
      jobId,
      eventType: 'created',
      stage: 'queued',
      status: 'accepted',
      message: '导出任务已创建',
      detail: {
        fileName: job.filename,
        segmentCount: job.segments.length,
        goldenSegmentCount: job.goldenSegments.length,
        storage: useOss ? 'oss' : 'local',
      },
    });
    scheduleCutJobs();

    sendJson(res, 202, cutJobStatusPayload(job));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/cut/status/')) {
    const jobId = url.pathname.replace('/api/cut/status/', '');
    const job = cutJobs.get(jobId);
    if (!job) {
      recordDownloadEvent(req, user, {
        jobId,
        eventType: 'failed',
        stage: 'status',
        status: 'not_found',
        message: '导出任务不存在',
      });
      sendJson(res, 404, { error: '任务不存在' });
      return;
    }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    sendJson(res, 200, cutJobStatusPayload(job));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/cut/download/')) {
    await sendCutDownload(req, res, url, user);
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function sendCutDownload(req, res, url, user, options = {}) {
  const jobId = url.pathname.replace('/api/cut/download/', '');
  const job = cutJobs.get(jobId);
  const eventUser = user || (job?.userId ? { id: job.userId } : null);
  const viaTicket = !user && Boolean(options.allowAnonymousTicket);

  if (!job) {
    if (!viaTicket) {
      recordDownloadEvent(req, eventUser, {
        jobId,
        eventType: 'failed',
        stage: 'download',
        status: 'not_found',
        message: '导出任务不存在',
      });
    }
    sendJson(res, 404, { error: '任务不存在' });
    return;
  }
  if (user && job.userId !== user.id) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (!user && !options.allowAnonymousTicket) {
    sendJson(res, 401, { error: 'unauthorized', message: '请先登录。' });
    return;
  }
  if (viaTicket && job.stage === 'done') {
    const finishedAt = Number(job.completedAt || job.updatedAt || job.createdAt || 0);
    if (!finishedAt || Date.now() - finishedAt > CUT_JOB_TTL) {
      recordDownloadEvent(req, eventUser, {
        jobId,
        eventType: 'failed',
        stage: 'download',
        status: 'ticket_expired',
        message: '导出下载票据已过期',
        detail: { auth: 'ticket' },
      });
      sendJson(res, 410, { error: '文件已过期' });
      return;
    }
  }
  if (job.stage !== 'done') {
    recordDownloadEvent(req, eventUser, {
      jobId,
      eventType: 'failed',
      stage: 'download',
      status: 'not_ready',
      message: '下载文件尚未就绪',
      detail: viaTicket ? { auth: 'ticket' } : {},
    });
    sendJson(res, 409, { error: '文件尚未就绪' });
    return;
  }

  const basename = path.basename(job.filename, path.extname(job.filename));
  const dlName = encodeURIComponent(`${basename}_精剪版.mp3`);

  if (oss.isOssEnabled() && job.outputObjectKey) {
    // 微信下载器可能不带登录 Cookie；导出 jobId 本身是 2 小时临时票据，OSS 链接再限 10 分钟。
    try {
      const signed = oss.signPublicUrl(job.outputObjectKey, 600, { filename: `${basename}_精剪版.mp3` });
      recordDownloadEvent(req, eventUser, {
        jobId,
        eventType: 'download_redirect',
        stage: 'download',
        status: '302',
        message: '已生成 OSS 下载跳转',
        detail: { outputObjectKey: 'present', auth: viaTicket ? 'ticket' : 'session' },
      });
      res.writeHead(302, { Location: signed, 'Access-Control-Allow-Origin': '*' });
      res.end();
    } catch (error) {
      console.error('[cut] OSS 下载签名失败', error && error.message);
      recordDownloadEvent(req, eventUser, {
        jobId,
        eventType: 'failed',
        stage: 'download',
        status: 'sign_failed',
        message: error.message || '下载链接生成失败',
        detail: viaTicket ? { auth: 'ticket' } : {},
      });
      sendJson(res, 500, { error: '下载链接生成失败' });
    }
    return;
  }

  if (!fs.existsSync(job.outputPath)) {
    recordDownloadEvent(req, eventUser, {
      jobId,
      eventType: 'failed',
      stage: 'download',
      status: 'expired',
      message: '导出文件已过期',
      detail: viaTicket ? { auth: 'ticket' } : {},
    });
    sendJson(res, 410, { error: '文件已过期' });
    return;
  }
  const stat = fs.statSync(job.outputPath);
  recordDownloadEvent(req, eventUser, {
    jobId,
    eventType: 'download_started',
    stage: 'download',
    status: '200',
    message: '已开始本地文件下载',
    detail: { bytes: stat.size, auth: viaTicket ? 'ticket' : 'session' },
  });
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
}

function countPendingCutJobs(userId) {
  let count = 0;
  for (const job of cutJobs.values()) {
    if (userId && job.userId !== userId) continue;
    if (['queued', 'downloading', 'processing', 'uploading'].includes(job.stage)) count += 1;
  }
  return count;
}

function countRunningCutJobs() {
  let count = 0;
  for (const job of cutJobs.values()) {
    if (['downloading', 'processing', 'uploading'].includes(job.stage) || job.running) count += 1;
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
    .filter((job) => job.userId === userId && ['queued', 'downloading', 'processing', 'uploading'].includes(job.stage))
    .sort((a, b) => (Number(a.queuedAt || a.createdAt) - Number(b.queuedAt || b.createdAt)) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function normalizeCutSegments(segments, options = {}) {
  const label = options.label || '删除段';
  if (segments == null) return [];
  if (!Array.isArray(segments)) throw new Error(`${label}必须是数组。`);
  if (segments.length > MAX_CUT_SEGMENTS) throw new Error(`${label}数量过多，请分批处理。`);

  const rawDuration = Number(options.duration || 0);
  const hasDuration = Number.isFinite(rawDuration) && rawDuration > 0;
  const duration = hasDuration ? rawDuration : 0;

  const normalized = segments
    .map((segment, index) => {
      let start;
      let end;
      if (Array.isArray(segment)) {
        start = Number(segment[0]);
        end = Number(segment[1]);
      } else if (segment && typeof segment === 'object') {
        start = Number(segment.start != null ? segment.start : segment.s);
        end = Number(segment.end != null ? segment.end : segment.e);
      } else {
        throw new Error(`${label}第 ${index + 1} 段格式不正确。`);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`${label}第 ${index + 1} 段时间不是有效数字。`);
      }
      if (start < -CUT_SEGMENT_DURATION_TOLERANCE || end < -CUT_SEGMENT_DURATION_TOLERANCE) {
        throw new Error(`${label}第 ${index + 1} 段不能小于 0 秒。`);
      }
      if (hasDuration && (start > duration + CUT_SEGMENT_DURATION_TOLERANCE || end > duration + CUT_SEGMENT_DURATION_TOLERANCE)) {
        throw new Error(`${label}第 ${index + 1} 段超过原音频时长。`);
      }
      const safeStart = hasDuration ? clampNumber(start, 0, duration) : Math.max(0, start);
      const safeEnd = hasDuration ? clampNumber(end, 0, duration) : Math.max(0, end);
      if (safeEnd <= safeStart) {
        throw new Error(`${label}第 ${index + 1} 段结束时间必须大于开始时间。`);
      }
      return { start: round3(safeStart), end: round3(safeEnd) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  normalized.forEach((segment) => {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end + CUT_SEGMENT_OVERLAP_TOLERANCE) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  });

  return merged.filter((segment) => segment.end - segment.start > 0.04);
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
        setCutJobStage(job, 'uploading', 96);
        await cutUploadOutput(job);
        try { fs.unlinkSync(job.outputPath); } catch {}
      }
      job.completedAt = Date.now();
      setCutJobStage(job, 'done', 100);
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
      if (job.nonResumable && ['queued', 'downloading', 'processing', 'uploading'].includes(job.stage)) {
        cleanupCutJobTempFiles(job, { keepOutput: false });
        failCutJob(job, '这个临时音频任务无法在服务器重启后继续，请重新生成备用 MP3。');
        cutJobs.set(job.id, job);
        continue;
      }
      if (['queued', 'downloading', 'processing', 'uploading'].includes(job.stage)) {
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

    if (['downloading', 'processing', 'uploading'].includes(job.stage) || job.running) {
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
  const previousStage = job.stage;
  job.stage = stage;
  if (Number.isFinite(progress)) job.progress = progress;
  persistCutJob(job, { force: true });
  if (previousStage !== stage) {
    const eventType = {
      queued: 'queued',
      downloading: 'downloading',
      processing: 'processing',
      uploading: 'uploading',
      done: 'ready',
      error: 'failed',
    }[stage] || stage;
    recordCutJobEvent(job, eventType, stage === 'done' ? '粗剪 MP3 已生成' : `导出阶段：${stage}`);
  }
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
  recordCutJobEvent(job, 'failed', job.error);
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
  const duration = await resolveCutDuration(job);
  job.segments = normalizeCutSegments(job.segments, { duration, label: '删除段', allowEmpty: true });
  job.goldenSegments = normalizeCutSegments(job.goldenSegments, { duration, label: '金句段', allowEmpty: true });
  const keepSegments = invertCutSegments(job.segments, duration);
  if (!keepSegments.length) throw new Error('所有音频都被标记删除了，无法生成成品。');

  // 有金句时走"金句前置"拼接：金句 → (过渡音乐) → 正文；否则走原来的纯删减拼接。
  const golden = job.goldenSegments;
  const hasMusic = Boolean(job.musicPath);
  const inputs = ['-i', job.inputPath];
  let args;
  if (golden.length) {
    if (hasMusic) inputs.push('-i', job.musicPath);
    args = buildGoldCutArgs(keepSegments, golden, hasMusic);
  } else {
    args = buildServerCutArgs(keepSegments);
  }

  const pass = spawn('nice', ['-n', '19', 'ffmpeg', '-threads', '1', ...inputs, ...args, '-y', job.outputPath]);
  job.childProcess = pass;
  try {
    const code = await waitForTimedProcess(pass, {
      timeoutMs: FFMPEG_TIMEOUT_MS,
      timeoutMessage: '备用 MP3 生成超时，请重新生成。',
      onStderr: (chunk) => {
        const line = chunk.toString();
        const t = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (t && duration > 0) {
          const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]);
          setCutJobProgress(job, Math.min(95, 25 + Math.round((elapsed / duration) * 70)));
        }
      },
    });
    if (code !== 0) throw new Error('ffmpeg 剪辑失败');
    setCutJobProgress(job, 95);
  } finally {
    job.childProcess = null;
  }
}

async function resolveCutDuration(job) {
  const probedDuration = await refineProbe(job.inputPath);
  if (Number.isFinite(probedDuration) && probedDuration > 0) return probedDuration;

  const fallbackDuration = Number(job.originalDuration || 0);
  if (Number.isFinite(fallbackDuration) && fallbackDuration > 0) {
    console.warn('[cut]', job.id, 'ffprobe returned no duration, using originalDuration fallback:', fallbackDuration);
    return fallbackDuration;
  }

  throw new Error('无法读取原音频时长，请重新上传音频。');
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
  const sorted = normalizeCutSegments(segments, {
    duration: total,
    label: '删除段',
    allowEmpty: true,
  });

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
    if (!job) {
      sendJson(res, 410, {
        error: 'job_interrupted',
        message: '音频拼接任务已中断，可能是服务器刚重启或页面停留太久。请重新选择音频并重新开始。',
      });
      return;
    }
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

  const pass = spawn('nice', ['-n', '19', 'ffmpeg', '-threads', '1', ...args]);
  const code = await waitForTimedProcess(pass, {
    timeoutMs: FFMPEG_TIMEOUT_MS,
    timeoutMessage: '音频拼接超时，请减少音频数量后重试。',
    onStderr: (chunk) => {
      const t = chunk.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && totalDur > 0) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]);
        job.progress = Math.min(95, 5 + Math.round((elapsed / totalDur) * 90));
      }
    },
  });
  if (code !== 0) throw new Error('ffmpeg 音频拼接失败');
  job.stage = 'done';
  job.progress = 100;
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

function waitForTimedProcess(child, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const timeoutMessage = options.timeoutMessage || '音频处理超时，请稍后重试。';
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timeoutTimer = null;
    let killTimer = null;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    if (typeof options.onStderr === 'function' && child.stderr) {
      child.stderr.on('data', options.onStderr);
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, CHILD_KILL_GRACE_MS);
      }, timeoutMs);
    }

    child.on('close', (code) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(timeoutMessage));
        return;
      }
      resolve(code);
    });
    child.on('error', (error) => {
      clearTimers();
      reject(error);
    });
  });
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

  // POST /api/refine/start-from-cut — server-side roughcut -> refine
  if (req.method === 'POST' && url.pathname === '/api/refine/start-from-cut') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    if (!ensureRefineCapacity(user, res)) return;

    const body = await readJson(req).catch(() => ({}));
    const cutJobId = sanitizeEventId(body.cutJobId || body.jobId);
    const cutJob = cutJobs.get(cutJobId);
    if (!cutJob) {
      recordDownloadEvent(req, user, {
        jobId: cutJobId,
        eventType: 'refine_failed',
        stage: 'refine',
        status: 'cut_job_not_found',
        message: '粗剪任务不存在，无法精修',
      });
      sendJson(res, 404, { error: 'cut_job_not_found', message: '粗剪任务不存在，请重新生成 MP3。' });
      return;
    }
    if (cutJob.userId !== user.id) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (cutJob.stage !== 'done') {
      recordDownloadEvent(req, user, {
        jobId: cutJob.id,
        eventType: 'refine_failed',
        stage: 'refine',
        status: 'cut_not_ready',
        message: '粗剪 MP3 尚未生成，无法精修',
      });
      sendJson(res, 409, { error: 'cut_not_ready', message: '粗剪 MP3 还没生成完成，请稍后再试。' });
      return;
    }

    let options;
    try {
      options = normalizeRefineOptions(body);
    } catch (error) {
      recordDownloadEvent(req, user, {
        jobId: cutJob.id,
        eventType: 'refine_failed',
        stage: 'refine',
        status: 'invalid_refine_options',
        message: error.message || '精修参数不正确',
      });
      sendJson(res, 400, { error: 'invalid_refine_options', message: error.message || '精修参数不正确。' });
      return;
    }

    const refineJob = createRefineJob(user, {
      ...options,
      filename: cutJob.filename || 'podcast.mp3',
      cutJobId: cutJob.id,
      sourceType: cutJob.outputObjectKey ? 'cut_oss' : 'cut_file',
      prepareInput: async (targetPath) => {
        if (cutJob.outputObjectKey) {
          await oss.pullToFile(cutJob.outputObjectKey, targetPath);
          return;
        }
        if (!cutJob.outputPath || !fs.existsSync(cutJob.outputPath)) {
          throw new Error('粗剪 MP3 文件已过期，请重新生成。');
        }
        fs.copyFileSync(cutJob.outputPath, targetPath);
      },
    });
    recordDownloadEvent(req, user, {
      jobId: cutJob.id,
      refineJobId: refineJob.id,
      eventType: 'refine_started',
      stage: 'refine',
      status: 'accepted',
      message: '已从粗剪 MP3 启动后端精修',
      detail: { sourceType: refineJob.sourceType },
    });
    sendJson(res, 202, { jobId: refineJob.id });
    return;
  }

  // POST /api/refine/start  — upload + kick off
  if (req.method === 'POST' && url.pathname === '/api/refine/start') {
    if (!hasDay1Access(user)) {
      sendDay1Required(res);
      return;
    }
    if (!ensureRefineCapacity(user, res)) return;

    let parsed;
    try { parsed = await parseRefineUpload(req); }
    catch (e) { sendJson(res, 400, { error: e.message }); return; }

    const job = createRefineJob(user, {
      ...parsed,
      sourceType: 'upload',
    });
    recordDownloadEvent(req, user, {
      refineJobId: job.id,
      eventType: 'refine_started',
      stage: 'refine',
      status: 'accepted',
      message: '已从上传文件启动精修',
      detail: { sourceType: 'upload' },
    });

    sendJson(res, 202, { jobId: job.id });
    return;
  }

  // GET /api/refine/status/:jobId
  if (req.method === 'GET' && url.pathname.startsWith('/api/refine/status/')) {
    const jobId = url.pathname.replace('/api/refine/status/', '');
    const job = refineJobs.get(jobId);
    if (!job) {
      sendJson(res, 410, {
        error: 'job_interrupted',
        message: '音频精修任务已中断，可能是服务器刚重启或页面停留太久。请重新上传音频处理。',
      });
      return;
    }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    sendJson(res, 200, {
      jobId,
      status: job.stage === 'error' ? 'failed' : job.stage,
      stage: job.stage,
      step: job.stage === 'done' ? 'done' : 'processing',
      progress: job.progress,
      log: job.log,
      error: job.error || null,
      cutJobId: job.cutJobId || '',
      sourceType: job.sourceType || 'upload',
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
    if (!job) {
      recordDownloadEvent(req, user, {
        refineJobId: jobId,
        eventType: 'failed',
        stage: 'refine_download',
        status: 'job_interrupted',
        message: '精修文件已过期或任务已中断',
      });
      sendJson(res, 410, {
        error: 'job_interrupted',
        message: '音频精修文件已过期或任务已中断，请重新上传音频处理。',
      });
      return;
    }
    if (job.userId !== user.id) { sendJson(res, 403, { error: 'forbidden' }); return; }
    if (job.stage !== 'done') {
      recordDownloadEvent(req, user, {
        jobId: job.cutJobId,
        refineJobId: job.id,
        eventType: 'failed',
        stage: 'refine_download',
        status: 'not_ready',
        message: '精修文件尚未就绪',
      });
      sendJson(res, 409, { error: '文件尚未就绪' });
      return;
    }
    if (!fs.existsSync(job.outputPath)) {
      recordDownloadEvent(req, user, {
        jobId: job.cutJobId,
        refineJobId: job.id,
        eventType: 'failed',
        stage: 'refine_download',
        status: 'expired',
        message: '精修文件已过期',
      });
      sendJson(res, 410, { error: '文件已过期' });
      return;
    }

    const basename = path.basename(job.filename, path.extname(job.filename));
    const dlName = encodeURIComponent(basename + '_精修版.mp3');
    const stat = fs.statSync(job.outputPath);
    recordDownloadEvent(req, user, {
      jobId: job.cutJobId,
      refineJobId: job.id,
      eventType: 'download_started',
      stage: 'refine_download',
      status: '200',
      message: '已开始精修文件下载',
      detail: { bytes: stat.size },
    });
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

function ensureRefineCapacity(user, res) {
  if (countActiveRefineJobs() >= REFINE_MAX_ACTIVE_JOBS) {
    sendJson(res, 429, { error: 'refine_busy', message: '当前精修任务较多，请稍后再试。' });
    return false;
  }
  if (countActiveRefineJobs(user.id) >= REFINE_MAX_ACTIVE_JOBS_PER_USER) {
    sendJson(res, 429, { error: 'refine_user_busy', message: '你已有精修任务在处理中，请完成后再提交新的音频。' });
    return false;
  }
  return true;
}

function normalizeRefineOptions(body = {}) {
  const normalizeLoudness = parseRefineBoolean(body.normalizeLoudness);
  const denoise = parseRefineBoolean(body.denoise);
  const voiceEnhance = parseRefineBoolean(body.voiceEnhance);
  const targetLufs = Number(body.targetLufs || -16);
  if (![-14, -16, -18].includes(targetLufs)) throw new Error('targetLufs 只允许 -14、-16、-18');
  if (!normalizeLoudness && !denoise && !voiceEnhance) throw new Error('至少选择一个音频精修选项');
  return { normalizeLoudness, denoise, voiceEnhance, targetLufs };
}

function createRefineJob(user, input = {}) {
  const jobId = crypto.randomBytes(10).toString('hex');
  const jobsDir = path.join(__dirname, 'data', 'refine-jobs');
  ensureDir(jobsDir);
  const filename = cleanTitle(input.filename || 'audio.mp3', 180);
  const inputPath = input.filePath || path.join(jobsDir, `${jobId}_input${getAudioExt(filename, '')}`);
  const outPath = path.join(jobsDir, `${jobId}_out.mp3`);
  const job = {
    id: jobId,
    userId: user.id,
    cutJobId: input.cutJobId || '',
    sourceType: input.sourceType || 'upload',
    stage: 'queued',
    progress: 0,
    log: [],
    inputPath,
    outputPath: outPath,
    filename,
    normalizeLoudness: Boolean(input.normalizeLoudness),
    denoise: Boolean(input.denoise),
    voiceEnhance: Boolean(input.voiceEnhance),
    targetLufs: Number(input.targetLufs || -16),
    durationSec: 0,
    createdAt: Date.now(),
    error: null,
  };
  refineJobs.set(jobId, job);
  runRefineJob(job, input.prepareInput);
  return job;
}

function runRefineJob(job, prepareInput) {
  (async () => {
    try {
      if (typeof prepareInput === 'function') await prepareInput(job.inputPath);
      job.durationSec = await refineProbe(job.inputPath);
      await refineProcess(job);
      recordDownloadEvent(null, { id: job.userId }, {
        jobId: job.cutJobId,
        refineJobId: job.id,
        eventType: 'refine_done',
        stage: 'refine',
        status: 'done',
        message: '精修版 MP3 已生成',
        detail: { sourceType: job.sourceType },
      });
      try { fs.unlinkSync(job.inputPath); } catch {}
    } catch (e) {
      job.stage = 'error';
      job.error = e.message;
      recordDownloadEvent(null, { id: job.userId }, {
        jobId: job.cutJobId,
        refineJobId: job.id,
        eventType: 'refine_failed',
        stage: 'refine',
        status: 'failed',
        message: e.message || '精修处理失败',
        detail: { sourceType: job.sourceType },
      });
      console.error('[refine]', job.id, e.message);
    }
  })();
}

function countActiveRefineJobs(userId) {
  let count = 0;
  for (const job of refineJobs.values()) {
    if (userId && job.userId !== userId) continue;
    if (['queued', 'measuring', 'normalizing', 'processing'].includes(job.stage)) count += 1;
  }
  return count;
}

async function refineProbe(filePath) {
  const p = spawn('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', filePath]);
  let out = '';
  p.stdout.on('data', d => { out += d; });
  try {
    const code = await waitForTimedProcess(p, {
      timeoutMs: FFPROBE_TIMEOUT_MS,
      timeoutMessage: 'ffprobe 读取音频时长超时',
    });
    if (code !== 0) return 0;
    return parseFloat(out.trim()) || 0;
  } catch (error) {
    console.error('[audio] ffprobe 失败', error.message || error);
    return 0;
  }
}

async function refineProcess(job) {
  const filters = [];
  if (job.denoise) filters.push('afftdn=nf=-25');
  if (job.voiceEnhance) filters.push('acompressor=threshold=-18dB:ratio=2:attack=20:release=200');
  if (job.normalizeLoudness) filters.push(`loudnorm=I=${job.targetLufs}:TP=-1.5:LRA=11`);

  const audioFilter = filters.join(',');
  if (!audioFilter) throw new Error('未选择任何精修处理');

  job.stage = 'processing';
  job.progress = 10;
  job.log.push(`正在处理: ${describeRefineJob(job).join('、')}`);

  const pass = spawn('nice', ['-n', '19', 'ffmpeg', '-threads', '1', '-i', job.inputPath, '-af', audioFilter, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', job.outputPath]);
  const code = await waitForTimedProcess(pass, {
    timeoutMs: FFMPEG_TIMEOUT_MS,
    timeoutMessage: '音频精修超时，请稍后重试。',
    onStderr: d => {
      const line = d.toString();
      const t = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && job.durationSec > 0) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]);
        job.progress = Math.min(95, 10 + Math.round((elapsed / job.durationSec) * 85));
      }
    },
  });
  if (code !== 0) throw new Error('ffmpeg 处理失败');
  job.stage = 'done';
  job.progress = 100;
  job.log.push('处理完成');
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
  if (AUTH_CODE_DELIVERY_MODE === 'page') {
    console.warn(`[page-code] skipped SMS delivery for ${maskPhone(phone)}`);
    return {
      message: '请使用页面下方的绿色验证码登录。',
      devCode: code,
    };
  }

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
