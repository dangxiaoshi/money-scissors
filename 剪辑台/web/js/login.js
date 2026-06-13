import { apiJson, getHomeUrl, parseNextFromQuery, readAuth, saveAuth } from './api.js?v=20260610-reviewflow-1';

const PHONE_RE = /^1\d{10}$/;
const els = {};
let countdownTimer = 0;
let cooldown = 0;
let pendingAuth = null;

document.addEventListener('DOMContentLoaded', () => {
  if (readAuth()) {
    location.href = parseNextFromQuery() || getHomeUrl();
    return;
  }

  Object.assign(els, {
    phone: document.getElementById('phone'),
    code: document.getElementById('code'),
    sendBtn: document.getElementById('send-code-btn'),
    submitBtn: document.getElementById('login-btn'),
    error: document.getElementById('error'),
    hint: document.getElementById('hint'),
    loginSection: document.getElementById('login-section'),
    nicknameSection: document.getElementById('nickname-section'),
    nicknameInput: document.getElementById('nickname'),
    nicknameBtn: document.getElementById('nickname-btn'),
    nicknameError: document.getElementById('nickname-error'),
  });

  els.sendBtn.addEventListener('click', sendCode);
  els.submitBtn.addEventListener('click', verifyCode);
  els.nicknameBtn.addEventListener('click', submitNickname);
});

async function sendCode() {
  try {
    clearMessage();
    const phone = els.phone.value.trim();
    if (!PHONE_RE.test(phone)) throw new Error('请输入 11 位中国大陆手机号。');
    setSending(true);
    const data = await apiJson('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
    showHint(data.message || '验证码已发送。');
    startCooldown(Number(data.cooldownSeconds || 60));
    if (data.devCode) showHint(`请复制这个绿色验证码：${data.devCode}`);
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setSending(false);
  }
}

async function verifyCode() {
  try {
    clearMessage();
    const phone = els.phone.value.trim();
    const code = els.code.value.trim();
    if (!PHONE_RE.test(phone)) throw new Error('请输入 11 位中国大陆手机号。');
    if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位验证码。');

    els.submitBtn.disabled = true;
    const auth = await apiJson('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
    if (auth.needsNickname) {
      pendingAuth = auth;
      els.loginSection.style.display = 'none';
      els.nicknameSection.style.display = '';
      els.nicknameInput.focus();
    } else {
      saveAuth(auth);
      location.href = parseNextFromQuery() || getHomeUrl();
    }
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    els.submitBtn.disabled = false;
  }
}

async function submitNickname() {
  try {
    els.nicknameError.textContent = '';
    const nickname = els.nicknameInput.value.trim();
    if (!nickname) {
      els.nicknameError.textContent = '请填写你在训练营微信群里显示的微信名，后续作业和发钱都按这个名字对应。';
      return;
    }
    els.nicknameBtn.disabled = true;
    const auth = pendingAuth || readAuth();
    if (!auth?.token) throw new Error('登录状态已过期，请重新获取验证码。');
    const data = await apiJson('/api/auth/set-nickname', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ nickname }),
    });
    if (data.user) saveAuth({ ...auth, needsNickname: false, user: data.user });
    location.href = parseNextFromQuery() || getHomeUrl();
  } catch (error) {
    els.nicknameError.textContent = error.message || String(error);
  } finally {
    els.nicknameBtn.disabled = false;
  }
}

function setSending(sending) {
  if (cooldown > 0) return;
  els.sendBtn.disabled = sending;
  els.sendBtn.textContent = sending ? '发送中…' : '发送验证码';
}

function startCooldown(seconds) {
  window.clearInterval(countdownTimer);
  cooldown = seconds;
  renderCooldown();
  countdownTimer = window.setInterval(() => {
    cooldown -= 1;
    renderCooldown();
    if (cooldown <= 0) {
      window.clearInterval(countdownTimer);
      els.sendBtn.disabled = false;
      els.sendBtn.textContent = '发送验证码';
    }
  }, 1000);
}

function renderCooldown() {
  els.sendBtn.disabled = true;
  els.sendBtn.textContent = cooldown > 0 ? `${cooldown}s 后重发` : '发送验证码';
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.add('visible');
}

function showHint(message) {
  els.hint.textContent = message;
  els.hint.classList.add('visible');
}

function clearMessage() {
  els.error.textContent = '';
  els.error.classList.remove('visible');
  els.hint.textContent = '';
  els.hint.classList.remove('visible');
}
