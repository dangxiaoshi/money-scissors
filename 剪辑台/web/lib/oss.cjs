'use strict';

// 阿里云 OSS 工具模块（金钱剪刀原音频/产物迁移用）
//
// 设计要点：
// 1. 懒加载——server.cjs 在顶部 require 之后才 loadEnv，所以这里不能在 require 时读 env，
//    必须等第一次真正用到时再读 process.env、建 client。
// 2. 前缀护栏——测试站只能写/读 test/，正式站只能写/读 prod/。OSS_PREFIX 缺失直接 fail-fast，
//    绝不靠人肉记；每次写/签名/拉取前都校验 key 必须以本环境前缀开头。
// 3. 内外网双 client——ECS 写/拉走内网 endpoint（免流量费、快），浏览器/DashScope 用公网签名。
//    本地开发不在阿里云内网，可设 OSS_INTERNAL=0 让内网操作也走公网。

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _cache = null;

function isOssEnabled() {
  return String(process.env.STORAGE_BACKEND || 'local').toLowerCase() === 'oss';
}

// 当前环境前缀（test / prod）。开启 OSS 但没配前缀时直接抛错，宁可启动失败也不许裸奔。
function currentPrefix() {
  const p = String(process.env.OSS_PREFIX || '').trim().replace(/\/+$/, '');
  if (!p) {
    throw new Error('OSS_PREFIX 未配置：测试站必须 test、正式站必须 prod，缺失拒绝运行。');
  }
  if (!['test', 'prod'].includes(p)) {
    throw new Error(`OSS_PREFIX=${p} 不合法：只能是 test 或 prod。`);
  }
  const expected = expectedDeploymentPrefix();
  if (!expected) {
    throw new Error('无法判断当前部署环境：OSS 模式必须配置 OSS_DEPLOY_ENV=test/prod，或设置可识别的 PUBLIC_BASE_URL/PORT。');
  }
  if (p !== expected) {
    throw new Error(`OSS_PREFIX=${p} 与当前部署环境 ${expected} 不一致，拒绝启动。`);
  }
  return p;
}

function expectedDeploymentPrefix() {
  const explicit = String(process.env.OSS_DEPLOY_ENV || process.env.OSS_ENV || '').trim().toLowerCase();
  if (explicit) return explicit;
  const publicBase = String(process.env.PUBLIC_BASE_URL || '').trim().toLowerCase();
  const port = String(process.env.PORT || '').trim();
  if (port === '8090' || /:8090(?:\/|$)/.test(publicBase) || publicBase.includes('/web-test')) return 'test';
  if (publicBase) return 'prod';
  return '';
}

function normalizeRegion(region) {
  const r = String(region || '').trim();
  if (!r) throw new Error('OSS_REGION 未配置');
  return r.startsWith('oss-') ? r : `oss-${r}`;
}

function getClients() {
  if (_cache) return _cache;
  const OSS = require('ali-oss');
  const region = normalizeRegion(process.env.OSS_REGION);
  const bucket = process.env.OSS_BUCKET;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  if (!bucket || !accessKeyId || !accessKeySecret) {
    throw new Error('OSS 配置不完整：需要 OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET。');
  }
  // 内网操作默认走 internal endpoint；本地开发可 OSS_INTERNAL=0 改走公网。
  const useInternal = String(process.env.OSS_INTERNAL || '1') !== '0';
  const base = { region, bucket, accessKeyId, accessKeySecret, secure: true };
  _cache = {
    bucket,
    region,
    // 公网 client：只用于给浏览器/DashScope 生成签名链接
    publicClient: new OSS({ ...base, internal: false }),
    // 内网 client：ECS 写入、拉取原音频、上传产物
    ioClient: new OSS({ ...base, internal: useInternal }),
    defaultTtl: Number(process.env.OSS_SIGN_TTL || 7200), // DashScope 长音频转写留足 2h
  };
  return _cache;
}

function validateConfig() {
  currentPrefix();
  getClients();
  return true;
}

// 把相对路径（如 uploads/2026-06-18/xxx.mp3）拼上本环境前缀
function withPrefix(relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  return `${currentPrefix()}/${rel}`;
}

// 护栏：key 必须属于本环境前缀，否则拒绝（防止正式进程误碰 test/、反之亦然）
function assertOwnedKey(key) {
  const k = String(key || '');
  const expect = `${currentPrefix()}/`;
  if (!k.startsWith(expect)) {
    throw new Error(`OSS key 越界：当前前缀 ${currentPrefix()}，不允许操作 "${k}"。`);
  }
  return k;
}

// 流式写入 OSS（ECS→OSS 内网）。stream 为可读流（如 http req）。
async function putStream(key, stream, opts = {}) {
  assertOwnedKey(key);
  const { ioClient } = getClients();
  const options = {};
  if (opts.mime) options.mime = opts.mime;
  if (opts.contentLength != null) options.contentLength = opts.contentLength;
  return ioClient.putStream(key, stream, options);
}

// 把本地文件传到 OSS（用于生成好的产物 MP3）
async function putFile(key, localPath, opts = {}) {
  assertOwnedKey(key);
  const { ioClient } = getClients();
  const options = {};
  if (opts.mime) options.mime = opts.mime;
  return ioClient.put(key, localPath, options);
}

// 生成公网签名 GET 链接（浏览器播放/下载、DashScope 转写用）
// opts.filename：设置后浏览器下载时用该文件名（response-content-disposition）
function signPublicUrl(key, ttlSeconds, opts = {}) {
  assertOwnedKey(key);
  const { publicClient, defaultTtl } = getClients();
  const params = {
    expires: Number(ttlSeconds || defaultTtl),
    method: 'GET',
  };
  if (opts.filename) {
    const dlName = encodeURIComponent(opts.filename);
    params.response = { 'content-disposition': `attachment; filename*=UTF-8''${dlName}` };
  }
  return publicClient.signatureUrl(key, params);
}

// 把 OSS 对象拉到本地临时文件（ECS 内网），返回临时路径。用完务必 removeTemp。
async function pullToTemp(key, opts = {}) {
  assertOwnedKey(key);
  const { ioClient } = getClients();
  const ext = opts.ext || path.extname(key) || '';
  const tmp = path.join(
    os.tmpdir(),
    `oss-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`,
  );
  await ioClient.get(key, tmp);
  return tmp;
}

// 把 OSS 对象直接拉到指定本地文件（ECS 内网），用于导出前准备 ffmpeg 输入
async function pullToFile(key, destPath) {
  assertOwnedKey(key);
  const { ioClient } = getClients();
  await ioClient.get(key, destPath);
  return destPath;
}

function removeTemp(p) {
  if (!p) return;
  try { fs.rmSync(p, { force: true }); } catch {}
}

// 判断对象是否存在（导出前校验原音频还在）
async function objectExists(key) {
  assertOwnedKey(key);
  const { ioClient } = getClients();
  try {
    await ioClient.head(key);
    return true;
  } catch (e) {
    if (e && (e.code === 'NoSuchKey' || e.status === 404)) return false;
    throw e;
  }
}

module.exports = {
  isOssEnabled,
  currentPrefix,
  withPrefix,
  assertOwnedKey,
  putStream,
  putFile,
  signPublicUrl,
  pullToTemp,
  pullToFile,
  removeTemp,
  objectExists,
  validateConfig,
};
