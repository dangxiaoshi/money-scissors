#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3030);
const STATIC_DIR = path.join(__dirname, 'public');
const JOBS_DIR = path.join(__dirname, 'jobs');
const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB
const JOB_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.wav':  'audio/wav',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// In-memory job store
const jobs = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────

function makeId() {
  return crypto.randomBytes(10).toString('hex');
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function err(res, status, msg) {
  json(res, status, { error: msg });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  for (const p of [job.inputPath, job.outputPath]) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
  jobs.delete(jobId);
}

// Auto-cleanup expired jobs
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) cleanupJob(id);
  }
}, 10 * 60 * 1000);

// ── audio processing ─────────────────────────────────────────────────────────

/**
 * Runs the two-pass loudnorm via ffmpeg.
 *
 * Pass 1: measure current loudness stats (JSON output to stderr).
 * Pass 2: apply linear + true-peak normalization to -16 LUFS / -1.5 TP.
 *
 * Returns a Promise that resolves when the output file is ready.
 * Emits progress lines to job.log[].
 */
function processAudio(job) {
  return new Promise((resolve, reject) => {
    job.stage = 'measuring';
    job.progress = 10;
    pushLog(job, '正在分析响度...');

    // Pass 1 — measure
    const pass1 = spawn('ffmpeg', [
      '-i', job.inputPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-',
    ]);

    let stderrBuf = '';
    pass1.stderr.on('data', d => { stderrBuf += d.toString(); });

    pass1.on('close', code => {
      if (code !== 0 && !stderrBuf.includes('"input_i"')) {
        return reject(new Error('ffmpeg pass1 失败'));
      }

      // Extract the JSON block from stderr
      const match = stderrBuf.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
      if (!match) return reject(new Error('未能读取响度数据'));

      let stats;
      try { stats = JSON.parse(match[0]); }
      catch { return reject(new Error('响度数据解析失败')); }

      const measuredI   = stats.input_i   || '-70.0';
      const measuredLra = stats.input_lra || '0.0';
      const measuredTp  = stats.input_tp  || '-0.5';
      const measuredTh  = stats.input_thresh || '-80.0';
      const offset      = stats.target_offset || '0.0';

      job.stage = 'normalizing';
      job.progress = 40;
      pushLog(job, `当前响度: ${parseFloat(measuredI).toFixed(1)} LUFS → 目标: -16 LUFS`);

      // Pass 2 — apply normalization
      const loudnormFilter = [
        `loudnorm=I=-16:TP=-1.5:LRA=11`,
        `measured_I=${measuredI}`,
        `measured_LRA=${measuredLra}`,
        `measured_TP=${measuredTp}`,
        `measured_thresh=${measuredTh}`,
        `offset=${offset}`,
        `linear=true`,
        `print_format=none`,
      ].join(':');

      // Optional light noise reduction via afftdn
      const audioFilter = job.options.denoise
        ? `${loudnormFilter},afftdn=nf=-25`
        : loudnormFilter;

      const pass2 = spawn('ffmpeg', [
        '-i', job.inputPath,
        '-af', audioFilter,
        '-c:a', 'libmp3lame',
        '-b:a', job.options.bitrate || '192k',
        '-y', job.outputPath,
      ]);

      pass2.stderr.on('data', d => {
        const line = d.toString();
        const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (timeMatch && job.durationSec > 0) {
          const elapsed = hmsToSec(timeMatch[1]);
          job.progress = Math.min(95, 40 + Math.round((elapsed / job.durationSec) * 55));
        }
      });

      pass2.on('close', code2 => {
        if (code2 !== 0) return reject(new Error('ffmpeg pass2 失败'));
        job.stage = 'done';
        job.progress = 100;
        pushLog(job, '处理完成');
        resolve();
      });

      pass2.on('error', reject);
    });

    pass1.on('error', reject);
  });
}

function pushLog(job, msg) {
  job.log.push(msg);
  console.log(`[${job.id}] ${msg}`);
}

function hmsToSec(hms) {
  const parts = hms.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Probe audio duration using ffprobe.
 * Returns duration in seconds, or 0 on failure.
 */
function probeDuration(filePath) {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('close', () => resolve(parseFloat(out.trim()) || 0));
    proc.on('error', () => resolve(0));
  });
}

// ── multipart upload parser ───────────────────────────────────────────────────

/**
 * Reads a multipart/form-data request and writes the first `file` field
 * to a temp path.  Returns { filePath, filename, options } or throws.
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('missing boundary'));
    const boundary = '--' + boundaryMatch[1].trim();

    const chunks = [];
    let totalBytes = 0;

    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_FILE_BYTES) {
        req.destroy();
        return reject(new Error('文件超过 500MB 限制'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('\r\n' + boundary);

      // Find the audio file part
      let pos = buf.indexOf(boundary);
      if (pos < 0) return reject(new Error('无效的 multipart 数据'));
      pos += boundary.length + 2; // skip boundary + CRLF

      // Parse headers of this part
      const headerEnd = buf.indexOf('\r\n\r\n', pos);
      if (headerEnd < 0) return reject(new Error('无法解析 part header'));
      const headerStr = buf.slice(pos, headerEnd).toString();

      const nameMatch = headerStr.match(/name="([^"]+)"/);
      const filenameMatch = headerStr.match(/filename="([^"]+)"/);

      // Find the file part (skip over form fields)
      let filePart = null;
      let filename = 'audio.mp3';
      let options = {};

      // Parse all parts to find the file
      let searchPos = 0;
      const bndBuf = Buffer.from(boundary);

      while (true) {
        const bndIdx = buf.indexOf(bndBuf, searchPos);
        if (bndIdx < 0) break;
        const partStart = bndIdx + bndBuf.length + 2;
        const hEnd = buf.indexOf('\r\n\r\n', partStart);
        if (hEnd < 0) break;
        const pHeader = buf.slice(partStart, hEnd).toString();
        const nextBnd = buf.indexOf(boundaryBuf, hEnd);
        const bodyEnd = nextBnd >= 0 ? nextBnd : buf.length;
        const body = buf.slice(hEnd + 4, bodyEnd);

        if (pHeader.includes('filename=')) {
          const fn = pHeader.match(/filename="([^"]+)"/);
          if (fn) filename = fn[1];
          filePart = body;
        } else {
          const nm = pHeader.match(/name="([^"]+)"/);
          if (nm) {
            const val = body.toString().trim();
            if (nm[1] === 'denoise') options.denoise = val === 'true' || val === '1';
            if (nm[1] === 'bitrate') options.bitrate = val || '192k';
          }
        }

        searchPos = bndIdx + bndBuf.length;
      }

      if (!filePart || filePart.length === 0) {
        return reject(new Error('未收到音频文件'));
      }

      const ext = path.extname(filename).toLowerCase() || '.mp3';
      const tmpPath = path.join(os.tmpdir(), makeId() + ext);
      fs.writeFile(tmpPath, filePart, err => {
        if (err) return reject(err);
        resolve({ filePath: tmpPath, filename, options });
      });
    });

    req.on('error', reject);
  });
}

// ── routing ───────────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function router(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url = new URL(req.url, `http://localhost`);

  // POST /api/start — upload + kick off processing
  if (req.method === 'POST' && url.pathname === '/api/start') {
    let parsed;
    try { parsed = await parseMultipart(req); }
    catch (e) { return err(res, 400, e.message); }

    const jobId = makeId();
    const outPath = path.join(JOBS_DIR, jobId + '_out.mp3');
    ensureDir(JOBS_DIR);

    const job = {
      id: jobId,
      stage: 'queued',
      progress: 0,
      log: [],
      inputPath: parsed.filePath,
      outputPath: outPath,
      filename: parsed.filename,
      options: parsed.options,
      durationSec: 0,
      createdAt: Date.now(),
      error: null,
    };
    jobs.set(jobId, job);

    // Kick off async — don't await
    (async () => {
      try {
        job.durationSec = await probeDuration(parsed.filePath);
        await processAudio(job);
        // Clean up input
        try { fs.unlinkSync(parsed.filePath); } catch {}
      } catch (e) {
        job.stage = 'error';
        job.error = e.message;
        console.error(`[${jobId}] error:`, e.message);
      }
    })();

    return json(res, 202, { jobId });
  }

  // GET /api/status/:jobId
  if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) {
    const jobId = url.pathname.slice('/api/status/'.length);
    const job = jobs.get(jobId);
    if (!job) return err(res, 404, '任务不存在');

    return json(res, 200, {
      stage: job.stage,
      progress: job.progress,
      log: job.log,
      error: job.error || null,
    });
  }

  // GET /api/download/:jobId
  if (req.method === 'GET' && url.pathname.startsWith('/api/download/')) {
    const jobId = url.pathname.slice('/api/download/'.length);
    const job = jobs.get(jobId);
    if (!job) return err(res, 404, '任务不存在');
    if (job.stage !== 'done') return err(res, 409, '文件尚未就绪');
    if (!fs.existsSync(job.outputPath)) return err(res, 410, '文件已过期');

    const basename = path.basename(job.filename, path.extname(job.filename));
    const dlName = encodeURIComponent(basename + '_精修版.mp3');

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': `attachment; filename*=UTF-8''${dlName}`,
      'Content-Length': fs.statSync(job.outputPath).size,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(job.outputPath).pipe(res);
    return;
  }

  // Static files
  if (req.method === 'GET') {
    let filePath = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(STATIC_DIR)) {
      return err(res, 403, 'Forbidden');
    }
    if (!fs.existsSync(filePath)) return err(res, 404, 'Not Found');

    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  err(res, 405, 'Method Not Allowed');
}

// ── main ──────────────────────────────────────────────────────────────────────

ensureDir(JOBS_DIR);
const server = http.createServer((req, res) => {
  router(req, res).catch(e => {
    console.error('Unhandled error:', e);
    try { err(res, 500, '服务器内部错误'); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`audio-engine running on http://localhost:${PORT}`);
});
