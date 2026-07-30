#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const server = read('server.cjs');
const main = read('js/main.js');
const analyze = read('js/analyze.js');
const shownote = read('剪辑台shownote.html');
const decision = read('剪辑台剪辑决策.html');
const narration = read('剪辑台旁白生成.html');

assert.match(server, /const DEEPSEEK_MODEL = 'deepseek-v4-flash';/);
assert.match(server, /model: body\.model \|\| DEEPSEEK_MODEL/);
assert.doesNotMatch(server, /model:\s*['"]deepseek-chat['"]/);
assert.doesNotMatch(main, /model:\s*['"]deepseek-chat['"]/);
assert.doesNotMatch(analyze, /model:\s*['"]deepseek-chat['"]/);

for (const [name, source] of [
  ['Shownote', shownote],
  ['剪辑决策', decision],
  ['旁白生成', narration],
]) {
  const functionSource = source.match(
    /function getAIErrorMessage\(data\) \{[\s\S]*?\n(?:        )?\}/,
  );
  assert.ok(functionSource, `${name} must define getAIErrorMessage`);
  assert.match(source, /if \(!res\.ok\) throw new Error\(getAIErrorMessage\(data\)\)/);
  const getAIErrorMessage = vm.runInNewContext(`(${functionSource[0]})`);
  assert.equal(getAIErrorMessage({ message: '可读错误' }), '可读错误');
  assert.equal(getAIErrorMessage({ error: { message: '供应商模型不支持' } }), '供应商模型不支持');
  assert.equal(getAIErrorMessage({ error: { code: 'invalid_model' } }), 'AI 服务繁忙，请稍后重试');
  assert.notEqual(getAIErrorMessage({ error: { code: 'invalid_model' } }), '[object Object]');
}

console.log('deepseek regression: 23 assertions passed');
