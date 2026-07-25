#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (output.stdout.includes('money-scissors listening')) return;
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${output.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start\n${output.stderr}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'money-scissors-page-code-'));
  const port = await reservePort();
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      SQLITE_PATH: path.join(tempRoot, 'users.db'),
      PRIVATE_DATA_ROOT: path.join(tempRoot, 'private'),
      PROJECT_DATA_ROOT: path.join(tempRoot, 'private', 'projects'),
      SNAPSHOT_DATA_ROOT: path.join(tempRoot, 'private', 'snapshots'),
      AUTH_DISABLED: '0',
      JWT_SECRET: 'page-code-test-jwt-secret-32-bytes',
      DASHSCOPE_API_KEY: 'test-dashscope-key',
      DEEPSEEK_KEY: 'test-deepseek-key',
      AUTH_CODE_DELIVERY_MODE: 'page',
      ALLOW_DEV_SEND_CODE_FALLBACK: '0',
      // 故意提供完整但无效的短信配置：若 page 模式误调短信，测试会失败。
      ALIYUN_ACCESS_KEY_ID: 'invalid-test-ak',
      ALIYUN_ACCESS_KEY_SECRET: 'invalid-test-secret',
      ALIYUN_SMS_SIGN: 'test-sign',
      ALIYUN_SMS_TEMPLATE: 'SMS_TEST_TEMPLATE',
      STORAGE_BACKEND: 'local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });

  try {
    await waitForServer(child, output);
    const phone = '19900000001';
    const sent = await postJson(`http://127.0.0.1:${port}/api/auth/send-code`, { phone });
    assert.equal(sent.status, 200);
    assert.match(sent.body.devCode, /^\d{6}$/);
    assert.match(sent.body.message, /绿色验证码/);
    assert.match(output.stderr, /skipped SMS delivery/);

    const verified = await postJson(`http://127.0.0.1:${port}/api/auth/verify`, {
      phone,
      code: sent.body.devCode,
    });
    assert.equal(verified.status, 200);
    assert.ok(verified.body.token);
    assert.equal(verified.body.user.phone, phone);
    console.log('PASS page code mode: SMS skipped, green code returned, login verified');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
