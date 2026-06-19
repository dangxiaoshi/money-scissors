#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const WEB_DIR = path.resolve(__dirname, '..');
const DEFAULT_FIXTURE = path.join(WEB_DIR, 'data', 'practice-templates', 'launch-live-20260612.json');
const DEFAULT_BASELINE = path.join(__dirname, 'sentinel_baseline.json');
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_THRESHOLD_SECONDS = 0.5;

const FIXED_DELETE_SEGMENTS = [
  { start: 0, end: 10 },
  { start: 20, end: 120 },
  { start: 132, end: 2810 },
  { start: 2820, end: 3008 },
];

main().catch((error) => {
  console.error(`[sentinel] FAIL ${error.message || error}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv(path.join(WEB_DIR, '.env'));
  loadEnv(path.join(process.cwd(), '.env'));

  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js 18+ with global fetch.');
  }

  const explicitBaseUrl = args.baseUrl || process.env.SENTINEL_BASE_URL || '';
  if (!explicitBaseUrl) {
    throw new Error('Pass --base-url or SENTINEL_BASE_URL explicitly, for example --base-url http://127.0.0.1:3004.');
  }
  const baseUrl = trimTrailingSlash(explicitBaseUrl);
  assertAllowedBaseUrl(baseUrl, args.allowProduction || process.env.SENTINEL_ALLOW_PRODUCTION === '1');
  const baselinePath = path.resolve(args.baseline || process.env.SENTINEL_BASELINE || DEFAULT_BASELINE);
  const fixturePath = path.resolve(args.fixture || process.env.SENTINEL_FIXTURE || DEFAULT_FIXTURE);
  const thresholdSeconds = Number(args.thresholdSeconds || process.env.SENTINEL_THRESHOLD_SECONDS || DEFAULT_THRESHOLD_SECONDS);
  const timeoutMs = Number(args.timeoutMs || process.env.SENTINEL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const pollMs = Number(args.pollMs || process.env.SENTINEL_POLL_MS || DEFAULT_POLL_MS);
  const token = args.token || process.env.SENTINEL_TOKEN || createSentinelToken(args.phone || process.env.SENTINEL_USER_PHONE);

  const fixture = readJson(fixturePath);
  const audioUrl = buildLocalAudioUrl(baseUrl, fixture.audioUrl);
  const originalDuration = Number(fixture.originalDuration || fixture.original_duration || 0);
  if (!originalDuration) throw new Error(`Fixture is missing originalDuration: ${fixturePath}`);

  const payload = {
    version: 'sentinel_v1',
    audioUrl,
    storage: '',
    objectKey: '',
    fileName: fixture.fileName || 'sentinel-launch-live.mp3',
    originalDuration,
    roughcut_duration: Math.round(expectedKeepDuration(FIXED_DELETE_SEGMENTS, originalDuration)),
    removed_duration: Math.round(sumDuration(FIXED_DELETE_SEGMENTS)),
    segments: FIXED_DELETE_SEGMENTS,
    goldenSegments: [],
    introMusic: null,
  };

  console.log(`[sentinel] base=${baseUrl}`);
  console.log(`[sentinel] fixture=${path.relative(WEB_DIR, fixturePath)}`);
  console.log(`[sentinel] expectedKeep=${expectedKeepDuration(FIXED_DELETE_SEGMENTS, originalDuration).toFixed(3)}s`);

  const started = await startCut(baseUrl, token, payload);
  const jobId = started.jobId;
  if (!jobId) throw new Error(`Cut start did not return jobId: ${JSON.stringify(started)}`);
  console.log(`[sentinel] job=${jobId}`);

  await waitForCut(baseUrl, token, jobId, { timeoutMs, pollMs });
  let mp3Path = '';
  let metrics;
  try {
    mp3Path = await downloadCut(baseUrl, token, jobId);
    metrics = inspectMp3(mp3Path);
  } finally {
    cleanupTempFile(mp3Path);
  }
  const result = {
    name: 'launch-live-fixed-export',
    fixture: path.relative(WEB_DIR, fixturePath),
    audioPath: new URL(audioUrl).pathname,
    segmentCount: FIXED_DELETE_SEGMENTS.length,
    keepSegmentCount: countKeepSegments(FIXED_DELETE_SEGMENTS, originalDuration),
    expectedKeepSeconds: round3(expectedKeepDuration(FIXED_DELETE_SEGMENTS, originalDuration)),
    durationSeconds: metrics.durationSeconds,
    bytes: metrics.bytes,
    sha256: metrics.sha256,
    checkedAt: new Date().toISOString(),
  };

  if (args.updateBaseline) {
    writeJson(baselinePath, {
      ...result,
      thresholdSeconds: round3(thresholdSeconds),
      segments: FIXED_DELETE_SEGMENTS,
    });
    console.log(`[sentinel] baseline updated ${baselinePath}`);
    console.log(formatResult(result));
    return;
  }

  const baseline = readJson(baselinePath);
  compareBaseline(result, baseline, thresholdSeconds);
  console.log(formatResult(result));
  console.log('[sentinel] PASS export matches baseline');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--update-baseline') {
      args.updateBaseline = true;
    } else if (item === '--base-url') {
      args.baseUrl = argv[++i];
    } else if (item === '--baseline') {
      args.baseline = argv[++i];
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
  node scripts/sentinel_export_check.cjs --base-url http://127.0.0.1:3004 --update-baseline
  node scripts/sentinel_export_check.cjs --base-url http://127.0.0.1:3004

Options:
  --base-url URL           App base URL. Required unless SENTINEL_BASE_URL is set.
  --update-baseline        Write current export metrics to scripts/sentinel_baseline.json.
  --baseline FILE          Baseline JSON path.
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

function createSentinelToken(phone) {
  if (process.env.AUTH_DISABLED === '1') return '';
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing JWT_SECRET. Provide SENTINEL_TOKEN or run on the app server.');

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
    if (!user) throw new Error('No existing Day1/admin user found for sentinel auth.');
    if (!user.is_admin && !user.day1_complete) {
      throw new Error(`Selected user ${maskPhone(user.phone)} has not unlocked the editor.`);
    }
    console.log(`[sentinel] authUser=${maskPhone(user.phone)} admin=${Boolean(user.is_admin)}`);
    return jwt.sign(
      { userId: user.id, phone: user.phone, isAdmin: Boolean(user.is_admin) },
      secret,
      { expiresIn: '2h' },
    );
  } finally {
    db.close();
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
    const data = await readApiResponse(response, 'poll cut');
    const status = data.status || data.stage || '';
    const progress = Number(data.progress || 0);
    const line = `${status}:${progress}`;
    if (line !== lastStatus) {
      console.log(`[sentinel] status=${status} progress=${progress}`);
      lastStatus = line;
    }
    if (status === 'done') return data;
    if (status === 'failed' || status === 'error') {
      throw new Error(`Cut failed: ${data.error || data.message || 'unknown error'}`);
    }
    await sleep(options.pollMs);
  }
  throw new Error(`Timed out waiting for cut job ${jobId}`);
}

async function downloadCut(baseUrl, token, jobId) {
  const response = await fetch(`${baseUrl}/api/cut/download/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(token),
    redirect: 'follow',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`download cut failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`Downloaded MP3 is too small: ${buffer.length} bytes`);
  const file = path.join(os.tmpdir(), `money-scissors-sentinel-${jobId}.mp3`);
  fs.writeFileSync(file, buffer);
  console.log(`[sentinel] downloaded=${file} bytes=${buffer.length}`);
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

function compareBaseline(result, baseline, thresholdSeconds) {
  const expectedDuration = Number(baseline.durationSeconds);
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) {
    throw new Error('Baseline is missing durationSeconds.');
  }
  if (baseline.segmentCount !== result.segmentCount) {
    throw new Error(`Segment count drift: baseline=${baseline.segmentCount} current=${result.segmentCount}`);
  }
  if (baseline.keepSegmentCount !== result.keepSegmentCount) {
    throw new Error(`Keep segment count drift: baseline=${baseline.keepSegmentCount} current=${result.keepSegmentCount}`);
  }
  if (baseline.sha256 && baseline.sha256 !== result.sha256) {
    throw new Error(`MP3 hash drift: baseline=${baseline.sha256} current=${result.sha256}`);
  }
  const threshold = Number(baseline.thresholdSeconds || thresholdSeconds || DEFAULT_THRESHOLD_SECONDS);
  const diff = Math.abs(result.durationSeconds - expectedDuration);
  if (diff > threshold) {
    throw new Error(`Duration drift ${diff.toFixed(3)}s exceeds ${threshold}s (baseline=${expectedDuration}s current=${result.durationSeconds}s)`);
  }
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

function jsonHeaders(token) {
  return {
    ...authHeaders(token),
    'Content-Type': 'application/json',
  };
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function buildLocalAudioUrl(baseUrl, audioUrl) {
  const pathname = new URL(audioUrl).pathname;
  return `${baseUrl}${pathname}`;
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

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
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

function countKeepSegments(segments, duration) {
  const total = Number(duration) || 0;
  const sorted = segments
    .map((segment) => ({ start: clamp(Number(segment.start) || 0, 0, total), end: clamp(Number(segment.end) || 0, 0, total) }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return 1;
  let count = 0;
  let cursor = 0;
  sorted.forEach((segment) => {
    if (segment.start - cursor > 0.04) count += 1;
    cursor = Math.max(cursor, segment.end);
  });
  if (total - cursor > 0.04) count += 1;
  return count;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
    console.log(`[sentinel] removedTemp=${file}`);
  } catch (error) {
    console.warn(`[sentinel] temp cleanup failed: ${error.message || error}`);
  }
}

function formatResult(result) {
  return [
    `[sentinel] duration=${result.durationSeconds}s`,
    `[sentinel] bytes=${result.bytes}`,
    `[sentinel] sha256=${result.sha256}`,
  ].join('\n');
}
