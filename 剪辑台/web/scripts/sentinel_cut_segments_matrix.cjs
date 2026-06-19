#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const WEB_DIR = path.resolve(__dirname, '..');
const DEFAULT_FIXTURE = path.join(WEB_DIR, 'data', 'practice-templates', 'launch-live-20260612.json');
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_THRESHOLD_SECONDS = 0.5;

const CANONICAL_SEGMENTS = [
  { start: 0, end: 10 },
  { start: 20, end: 120 },
  { start: 132, end: 2810 },
  { start: 2820, end: 3008 },
];

const EXPORT_CASES = [
  {
    name: 'object_segments',
    segments: [
      { start: 0, end: 10 },
      { start: 2, end: 6 },
      { start: 20, end: 120 },
      { start: 119.99, end: 120 },
      { start: 132, end: 2810 },
      { start: 2820, end: 3008 },
    ],
  },
  {
    name: 'array_segments',
    segments: [
      [0, 10],
      [2, 6],
      [20, 120],
      [119.99, 120],
      [132, 2810],
      [2820, 3008],
    ],
  },
  {
    name: 'legacy_s_e_segments',
    segments: [
      { s: 0, e: 10 },
      { s: 2, e: 6 },
      { s: 20, e: 120 },
      { s: 119.99, e: 120 },
      { s: 132, e: 2810 },
      { s: 2820, e: 3008 },
    ],
  },
];

main().catch((error) => {
  console.error(`[cut-matrix] FAIL ${error.message || error}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv(path.join(WEB_DIR, '.env'));
  loadEnv(path.join(process.cwd(), '.env'));

  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js 18+ with global fetch.');
  }

  const explicitBaseUrl = args.baseUrl || process.env.CUT_MATRIX_BASE_URL || '';
  if (!explicitBaseUrl) {
    throw new Error('Pass --base-url or CUT_MATRIX_BASE_URL explicitly, for example --base-url http://127.0.0.1:3004.');
  }
  const baseUrl = trimTrailingSlash(explicitBaseUrl);
  assertAllowedBaseUrl(baseUrl, args.allowProduction || process.env.CUT_MATRIX_ALLOW_PRODUCTION === '1');

  const fixturePath = path.resolve(args.fixture || process.env.CUT_MATRIX_FIXTURE || DEFAULT_FIXTURE);
  const thresholdSeconds = Number(args.thresholdSeconds || process.env.CUT_MATRIX_THRESHOLD_SECONDS || DEFAULT_THRESHOLD_SECONDS);
  const timeoutMs = Number(args.timeoutMs || process.env.CUT_MATRIX_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const pollMs = Number(args.pollMs || process.env.CUT_MATRIX_POLL_MS || DEFAULT_POLL_MS);
  const token = args.token || process.env.CUT_MATRIX_TOKEN || createSentinelToken(args.phone || process.env.CUT_MATRIX_USER_PHONE);

  const fixture = readJson(fixturePath);
  const audioUrl = buildLocalAudioUrl(baseUrl, fixture.audioUrl);
  const originalDuration = Number(fixture.originalDuration || fixture.original_duration || 0);
  if (!originalDuration) throw new Error(`Fixture is missing originalDuration: ${fixturePath}`);

  const expectedDuration = expectedKeepDuration(CANONICAL_SEGMENTS, originalDuration);

  console.log(`[cut-matrix] base=${baseUrl}`);
  console.log(`[cut-matrix] fixture=${path.relative(WEB_DIR, fixturePath)}`);
  console.log(`[cut-matrix] expectedKeep=${expectedDuration.toFixed(3)}s`);

  const results = [];
  for (const testCase of EXPORT_CASES) {
    results.push(await runExportCase({
      baseUrl,
      token,
      fixture,
      audioUrl,
      originalDuration,
      expectedDuration,
      thresholdSeconds,
      timeoutMs,
      pollMs,
      testCase,
    }));
  }
  compareEquivalentExports(results, thresholdSeconds);

  await expectInvalidStart({
    baseUrl,
    token,
    fixture,
    audioUrl,
    originalDuration,
    segments: [{ start: 0, end: 'not-a-number' }],
    expectedError: 'invalid_cut_segments',
    label: 'reject_non_numeric_segment',
  });

  await expectFailedJob({
    baseUrl,
    token,
    fixture,
    audioUrl,
    originalDuration,
    segments: [{ start: 0, end: originalDuration + 10 }],
    expectedText: '超过原音频时长',
    timeoutMs,
    pollMs,
    label: 'fail_out_of_bounds_segment',
  });

  console.log('[cut-matrix] PASS cut segment matrix checks passed');
}

async function runExportCase(options) {
  const payload = buildPayload({
    fixture: options.fixture,
    audioUrl: options.audioUrl,
    originalDuration: options.originalDuration,
    segments: options.testCase.segments,
    version: `cut_matrix_${options.testCase.name}`,
  });
  const started = await startCut(options.baseUrl, options.token, payload);
  const jobId = started.jobId;
  if (!jobId) throw new Error(`${options.testCase.name}: cut start did not return jobId`);
  console.log(`[cut-matrix] ${options.testCase.name} job=${jobId}`);
  await waitForCut(options.baseUrl, options.token, jobId, {
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    label: options.testCase.name,
  });

  let mp3Path = '';
  let metrics;
  try {
    mp3Path = await downloadCut(options.baseUrl, options.token, jobId, options.testCase.name);
    metrics = inspectMp3(mp3Path);
  } finally {
    cleanupTempFile(mp3Path);
  }

  const durationDiff = Math.abs(metrics.durationSeconds - options.expectedDuration);
  if (durationDiff > options.thresholdSeconds) {
    throw new Error(`${options.testCase.name}: duration ${metrics.durationSeconds}s differs from expected ${options.expectedDuration.toFixed(3)}s by ${durationDiff.toFixed(3)}s`);
  }

  const result = {
    name: options.testCase.name,
    jobId,
    durationSeconds: metrics.durationSeconds,
    bytes: metrics.bytes,
    sha256: metrics.sha256,
  };
  console.log(`[cut-matrix] ${result.name} duration=${result.durationSeconds}s bytes=${result.bytes} sha256=${result.sha256}`);
  return result;
}

function buildPayload({ fixture, audioUrl, originalDuration, segments, version }) {
  return {
    version,
    audioUrl,
    storage: '',
    objectKey: '',
    fileName: fixture.fileName || 'sentinel-launch-live.mp3',
    originalDuration,
    roughcut_duration: Math.round(expectedKeepDuration(CANONICAL_SEGMENTS, originalDuration)),
    removed_duration: Math.round(sumDuration(CANONICAL_SEGMENTS)),
    segments,
    goldenSegments: [],
    introMusic: null,
  };
}

async function expectInvalidStart(options) {
  const payload = buildPayload({
    fixture: options.fixture,
    audioUrl: options.audioUrl,
    originalDuration: options.originalDuration,
    segments: options.segments,
    version: `cut_matrix_${options.label}`,
  });
  const response = await fetch(`${options.baseUrl}/api/cut/start`, {
    method: 'POST',
    headers: jsonHeaders(options.token),
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (response.ok) {
    throw new Error(`${options.label}: expected cut start to fail, got HTTP ${response.status}`);
  }
  if (options.expectedError && data.error !== options.expectedError) {
    throw new Error(`${options.label}: expected error=${options.expectedError}, got ${data.error || text}`);
  }
  console.log(`[cut-matrix] ${options.label} rejected HTTP ${response.status} ${data.error || ''}`);
}

async function expectFailedJob(options) {
  const payload = buildPayload({
    fixture: options.fixture,
    audioUrl: options.audioUrl,
    originalDuration: options.originalDuration,
    segments: options.segments,
    version: `cut_matrix_${options.label}`,
  });
  const started = await startCut(options.baseUrl, options.token, payload);
  const jobId = started.jobId;
  if (!jobId) throw new Error(`${options.label}: cut start did not return jobId`);
  console.log(`[cut-matrix] ${options.label} job=${jobId}`);
  const result = await waitForCut(options.baseUrl, options.token, jobId, {
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    label: options.label,
    allowFailure: true,
  });
  const message = `${result.error || ''} ${result.message || ''}`;
  if (!message.includes(options.expectedText)) {
    throw new Error(`${options.label}: expected failure text to include "${options.expectedText}", got "${message.trim()}"`);
  }
  console.log(`[cut-matrix] ${options.label} failed as expected: ${message.trim()}`);
}

function compareEquivalentExports(results, thresholdSeconds) {
  const first = results[0];
  for (const result of results.slice(1)) {
    const durationDiff = Math.abs(result.durationSeconds - first.durationSeconds);
    if (durationDiff > thresholdSeconds) {
      throw new Error(`Equivalent exports duration drift: ${first.name}=${first.durationSeconds}s ${result.name}=${result.durationSeconds}s`);
    }
    if (result.sha256 !== first.sha256) {
      throw new Error(`Equivalent exports hash drift: ${first.name}=${first.sha256} ${result.name}=${result.sha256}`);
    }
  }
}

async function startCut(baseUrl, token, payload) {
  const response = await fetch(`${baseUrl}/api/cut/start`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(payload),
  });
  return readApiResponse(response, 'start cut');
}

async function waitForCut(baseUrl, token, jobId, options) {
  const startedAt = Date.now();
  let lastStatus = '';
  while (Date.now() - startedAt < options.timeoutMs) {
    const response = await fetch(`${baseUrl}/api/cut/status/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(token),
    });
    const data = await readApiResponse(response, `${options.label || jobId} poll cut`);
    const status = data.status || data.stage || '';
    const progress = Number(data.progress || 0);
    const line = `${status}:${progress}`;
    if (line !== lastStatus) {
      console.log(`[cut-matrix] ${options.label || jobId} status=${status} progress=${progress}`);
      lastStatus = line;
    }
    if (status === 'done') return data;
    if (status === 'failed' || status === 'error') {
      if (options.allowFailure) return data;
      throw new Error(`${options.label || jobId}: cut failed: ${data.error || data.message || 'unknown error'}`);
    }
    await sleep(options.pollMs);
  }
  throw new Error(`${options.label || jobId}: timed out waiting for cut job`);
}

async function downloadCut(baseUrl, token, jobId, label) {
  const response = await fetch(`${baseUrl}/api/cut/download/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(token),
    redirect: 'follow',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${label}: download cut failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`${label}: downloaded MP3 is too small: ${buffer.length} bytes`);
  const file = path.join(os.tmpdir(), `money-scissors-cut-matrix-${label}-${jobId}.mp3`);
  fs.writeFileSync(file, buffer);
  return file;
}

function inspectMp3(file) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`ffprobe failed: ${probe.stderr || probe.stdout}`);
  }
  const durationSeconds = Number(probe.stdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Invalid MP3 duration: ${probe.stdout.trim()}`);
  }
  const bytes = fs.statSync(file).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { durationSeconds: round3(durationSeconds), bytes, sha256 };
}

async function readApiResponse(response, label) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status} ${data?.message || data?.error || text.slice(0, 300)}`);
  }
  return data || {};
}

function createSentinelToken(phone) {
  if (process.env.AUTH_DISABLED === '1') return '';
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing JWT_SECRET. Provide CUT_MATRIX_TOKEN or run on the app server.');

  let jwt;
  let Database;
  try {
    jwt = require('jsonwebtoken');
    Database = require('better-sqlite3');
  } catch (error) {
    throw new Error(`Missing auth dependencies: ${error.message}`);
  }

  const dbPath = process.env.SQLITE_PATH || path.join(WEB_DIR, 'data', 'users.db');
  if (!fs.existsSync(dbPath)) throw new Error(`User DB not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const user = phone
      ? db.prepare('SELECT * FROM users WHERE phone = ?').get(normalizePhone(phone))
      : db.prepare(`
          SELECT *
          FROM users
          WHERE is_admin = 1 OR day2_complete = 1 OR day1_complete = 1
          ORDER BY is_admin DESC, day2_complete DESC, day1_complete DESC, last_active_at DESC, id DESC
          LIMIT 1
        `).get();
    if (!user) throw new Error('No existing Day1/admin user found for cut matrix auth.');
    if (!user.is_admin && !user.day1_complete) {
      throw new Error(`Selected user ${maskPhone(user.phone)} has not unlocked the editor.`);
    }
    console.log(`[cut-matrix] authUser=${maskPhone(user.phone)} admin=${Boolean(user.is_admin)}`);
    return jwt.sign(
      { userId: user.id, phone: user.phone, isAdmin: Boolean(user.is_admin) },
      secret,
      { expiresIn: '2h' },
    );
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--base-url') {
      args.baseUrl = argv[++i];
    } else if (item === '--fixture') {
      args.fixture = argv[++i];
    } else if (item === '--token') {
      args.token = argv[++i];
    } else if (item === '--phone') {
      args.phone = argv[++i];
    } else if (item === '--threshold-seconds') {
      args.thresholdSeconds = argv[++i];
    } else if (item === '--timeout-ms') {
      args.timeoutMs = argv[++i];
    } else if (item === '--poll-ms') {
      args.pollMs = argv[++i];
    } else if (item === '--allow-production') {
      args.allowProduction = true;
    } else if (item === '--help' || item === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/sentinel_cut_segments_matrix.cjs --base-url http://127.0.0.1:3004

What it checks:
  1. Equivalent object, array, and legacy {s,e} delete segments export the same MP3.
  2. Non-numeric segment values are rejected at /api/cut/start.
  3. Out-of-bounds segments fail clearly after server-side duration probing.

Options:
  --base-url URL           App base URL. Required unless CUT_MATRIX_BASE_URL is set.
  --fixture FILE           Practice template fixture path.
  --token JWT              Use an existing auth token instead of reading local DB.
  --phone PHONE            Pick a specific existing user from the local DB.
  --threshold-seconds N    Allowed duration drift. Default: 0.5.
  --timeout-ms N           Overall wait timeout. Default: 900000.
  --poll-ms N              Poll interval. Default: 2000.
  --allow-production       Allow prod-like base URLs such as localhost:3002 or bokejianji.cn.
`);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) return;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  });
}

function assertAllowedBaseUrl(baseUrl, allowProduction) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid --base-url: ${baseUrl}`);
  }
  if (allowProduction) return;
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const prodLike =
    host === 'bokejianji.cn' ||
    host === 'www.bokejianji.cn' ||
    port === '3002' ||
    (host === '8.136.133.196' && port !== '8090');
  if (prodLike) {
    throw new Error(`Refusing prod-like base URL without --allow-production: ${baseUrl}`);
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildLocalAudioUrl(baseUrl, audioUrl) {
  const pathname = new URL(audioUrl).pathname;
  return `${baseUrl}${pathname}`;
}

function expectedKeepDuration(segments, duration) {
  return Math.max(0, Number(duration || 0) - sumDuration(segments));
}

function sumDuration(segments) {
  return segments.reduce((sum, segment) => {
    const start = Number(segment.start);
    const end = Number(segment.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? sum + (end - start)
      : sum;
  }, 0);
}

function jsonHeaders(token) {
  return {
    ...authHeaders(token),
    'Content-Type': 'application/json',
  };
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/g, '');
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskPhone(phone) {
  return String(phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupTempFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
    console.log(`[cut-matrix] removedTemp=${file}`);
  } catch (error) {
    console.warn(`[cut-matrix] temp cleanup failed: ${error.message || error}`);
  }
}
