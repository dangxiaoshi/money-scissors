const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '..', 'orders', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'orders-review-admin.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.cjs'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}`;
  const start = html.indexOf(marker);
  assert(start >= 0, `orders/index.html 缺少函数 ${name}`);
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = html.indexOf('(', start); index < html.length; index += 1) {
    const char = html[index];
    if (char === '(') parenDepth += 1;
    if (char === ')') parenDepth -= 1;
    if (char === '{' && parenDepth === 0) { braceStart = index; break; }
  }
  assert(braceStart >= 0, `函数 ${name} 没有函数体`);
  let depth = 0;
  for (let index = braceStart; index < html.length; index += 1) {
    const char = html[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`函数 ${name} 的花括号没有闭合`);
}

const functionNames = [
  'safeExternalUrl',
  'normalizeExternalSubmission',
  'safeMaterialLink',
  'normalizeClaim',
  'isAutoAudioMaterial',
  'claimPrimaryAction',
  'noLinkMaterialInfo',
  'buildEditHref',
  'escapeHtml',
  'escapeAttr',
  'renderClaimPrimaryActions',
];

const source = `${functionNames.map(extractFunction).join('\n\n')}\n\nglobalThis.__ordersUi = { ${functionNames.join(', ')} };`;
const context = { URL, URLSearchParams };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'orders-ui-functions.js' });

const ui = context.__ordersUi;

const submittedProjectClaim = ui.normalizeClaim({
  id: 88,
  taskId: 10,
  status: 'submitted',
  projectId: 'proj_submitted_10',
  snapshotId: 'snap_submitted_10',
  updatedAt: '2026-06-20T09:27:00.000Z',
  task: {
    id: 10,
    title: '熊豆芽咨询公开单｜销售+咨询合成素材',
    budget: '40元',
    demand: '提交重点：剪成顺畅成品。',
    materialLink: '/api/orders/material/task-10.m4a',
  },
});

assert.strictEqual(
  submittedProjectClaim.projectId,
  'proj_submitted_10',
  'normalizeClaim 必须保留后端返回的 projectId，否则待审核卡片无法回到已提交项目',
);
assert.strictEqual(
  submittedProjectClaim.snapshotId,
  'snap_submitted_10',
  'normalizeClaim 必须保留后端返回的 snapshotId，方便后续查看提交状态',
);

assert.strictEqual(
  ui.buildEditHref(submittedProjectClaim.task, submittedProjectClaim),
  '/review.html?project=proj_submitted_10',
  '已有 projectId 的接单记录应打开已保存的审稿/提交项目，而不是回到 /edit 重新上传',
);

const submittedHtml = ui.renderClaimPrimaryActions(submittedProjectClaim);
assert(
  submittedHtml.includes('href="/review.html?project=proj_submitted_10"'),
  `待审核站内成品应有查看已提交项目入口，实际 HTML：${submittedHtml}`,
);
assert(
  submittedHtml.includes('查看已提交成品'),
  `待审核入口文案要说明这是已提交成品，避免误以为没有提交入口，实际 HTML：${submittedHtml}`,
);

const externalSubmittedClaim = ui.normalizeClaim({
  id: 89,
  taskId: 10,
  status: 'submitted',
  externalSubmission: {
    url: 'https://example.com/result.mp3',
    tool: 'other',
    description: '这里是外部工具导出的成品。',
  },
  task: {
    id: 10,
    title: '熊豆芽咨询公开单｜销售+咨询合成素材',
    budget: '40元',
    demand: '提交重点：剪成顺畅成品。',
    materialLink: 'https://example.com/material.mp3',
  },
});
const externalHtml = ui.renderClaimPrimaryActions(externalSubmittedClaim);
assert(
  externalHtml.includes('href="https://example.com/result.mp3"') && externalHtml.includes('查看提交'),
  `外部工具提交仍应优先打开外部成品链接，实际 HTML：${externalHtml}`,
);

assert(
  adminHtml.includes('data-kick-claim=')
    && adminHtml.includes('名额会立即释放')
    && adminHtml.includes('/api/orders/admin/claims/${encodeURIComponent(claimId)}/kick'),
  '助教订单审核页必须提供手动踢出入口、确认提示和后台接口调用',
);
assert(
  serverSource.includes('kickDispatchClaimByAdmin')
    && serverSource.includes("status IN ('in_progress', 'returned', 'submitted')")
    && serverSource.includes("SET status = 'abandoned'")
    && serverSource.includes("error: 'claim_not_active'"),
  '后端必须只释放仍占位的接单记录，并阻止重复踢出',
);
const adminGateIndex = serverSource.indexOf('const admin = requireAdmin(req, res);');
const kickRouteIndex = serverSource.indexOf('const kickClaimMatch = url.pathname.match');
assert(
  adminGateIndex >= 0 && kickRouteIndex > adminGateIndex,
  '踢出接口必须位于管理员权限校验之后，普通学员不能调用',
);

console.log('orders UI regression checks passed');
