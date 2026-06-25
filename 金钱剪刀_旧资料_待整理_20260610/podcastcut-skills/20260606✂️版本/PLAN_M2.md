# 金钱剪刀 M2 计划 — 给 codex 执行的工单

> 上一阶段（M1）：上传 → 转录 → AI 分析 → 审查 → 剪辑 已经跑通在 http://8.136.133.196/
>
> 这一阶段（M2）按顺序干三件事：
>
> - **第 1-2 周：登录系统 + 私域漏斗**（开课前刚需，方案已定）
> - **第 3 周：Key 后端化**（安全加固，登录系统做完后立刻跟上）
> - **第 4 周以后：第三步精修**（降噪 + 响度 + 减口屁，可选功能）
>
> 用户是技术小白。每个改动先本地跑通 → 再 rsync 到 ECS → 再让用户用手机实测。
> 汇报格式：做了什么 / 怎么测 / 出问题怎么回滚。

---

## 现状速读（给 codex）

代码位置：`/Users/dang/Documents/podcastcut-skills/web/`

- `index.html`、`review.html`、`cut.html`：三个静态 HTML
- `js/config.js`：⚠️ DeepSeek Key 和 OSS AK/SK 明文（第 3 周迁走）
- `server.cjs`：272 行，已有 `/dashscope/*` 代理、`/api/upload` 兜底
- `.env`：当前只有 `DASHSCOPE_API_KEY`
- ECS：`8.136.133.196`，PM2 进程 `money-scissors`，路径 `/opt/money-scissors/`
- SSH：`ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196`

部署套路（已验证）：

```bash
rsync -av --delete -e "ssh -i ~/.ssh/money_scissors_ecs" \
  web/index.html web/review.html web/cut.html web/css web/js \
  root@8.136.133.196:/opt/money-scissors/public/

scp -i ~/.ssh/money_scissors_ecs web/server.cjs root@8.136.133.196:/opt/money-scissors/server.cjs

ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'cd /opt/money-scissors && pm2 restart money-scissors --update-env'
```

---

# 第 1-2 周：登录系统 + 私域漏斗

**方案已定，完整规划在 Obsidian：**
`/Users/dang/Library/Mobile Documents/iCloud~md~obsidian/Documents/dangxiaoshi/项目/剪辑营/金钱剪刀 登录系统与私域漏斗 规划.md`

codex 去读那份文档，按里面的时间表执行。这里只列技术上的关键点和补充信息。

## 技术关键点

### 装依赖

```bash
# 本地
cd /Users/dang/Documents/podcastcut-skills
npm install better-sqlite3 jsonwebtoken @alicloud/dysmsapi20170525

# 部署后在 ECS 也装一次
ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'cd /opt/money-scissors && npm install better-sqlite3 jsonwebtoken @alicloud/dysmsapi20170525'
```

### .env 新增字段

```
# 短信
ALIYUN_ACCESS_KEY_ID=（从 macOS 钥匙串 service: money-scissors-oss 读 AccessKeyId）
ALIYUN_ACCESS_KEY_SECRET=（同上 AccessKeySecret）
ALIYUN_SMS_SIGN=（阿里云短信签名，待用户申请后填）
ALIYUN_SMS_TEMPLATE=（模板 ID，待用户申请后填）

# JWT
JWT_SECRET=（用 openssl rand -hex 32 生成，不要写死）
JWT_EXPIRE_HOURS=168

# 管理员
ADMIN_PHONES=（用户的手机号，多个用逗号分隔）
```

### SQLite 路径

```
/opt/money-scissors/data/users.db
```

首次启动 server.cjs 时自动创建，不需要手动建库。三张表见规划文档第三节。

### 每天自动备份到 OSS

```bash
# ECS 上加 cron（crontab -e）
0 3 * * * /opt/money-scissors/scripts/backup_db.sh >> /opt/money-scissors/logs/backup.log 2>&1
```

`backup_db.sh` 用 ossutil 把 `users.db` 上传到 `money-scissors` bucket 的 `backups/` 目录，保留最近 7 份。

### JWT 校验中间件

在 server.cjs 新增 `requireAuth(req, res)` 函数：

```js
function requireAuth(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload; // { userId, phone }
  } catch {
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }
}
```

加到 `/dashscope/*`、`/api/upload`、`/api/oss/*`（第 3 周用）这些路由的开头。

### 前端 JWT 存储

存 `localStorage.jinqian_token`（不用 sessionStorage，浏览器关了还在），24 小时过期后自动跳登录页。

所有 fetch 请求通过 `js/api.js` 统一封装，自动带 `Authorization: Bearer <token>` 头，收到 401 自动跳 `/login`。

---

## 第 1-2 周验收

用户用手机能验证的事（见规划文档第八节上线前必过清单）。

---

# 第 3 周：Key 后端化（安全加固）

等登录系统稳定运行一周后做这件事。

## 为什么等到这时候

先有登录系统 → API 路由已经有 JWT 校验 → 这时候加后端代理是顺手的事，不需要重搭架子。

## 要做什么

用一句话说：把 `js/config.js` 里剩下的两个密码（DeepSeek Key 和 OSS AK/SK）从前端删掉，藏到服务器里。

---

## K1. DeepSeek 代理

**改动 server.cjs**：

新增路由 `POST /api/deepseek/chat`：

- 入参（来自前端 body）：`{ messages, model?, max_tokens?, response_format? }`
- 服务端读 `process.env.DEEPSEEK_KEY`
- 转发到 `https://api.deepseek.com/v1/chat/completions`
- 默认 `model: 'deepseek-chat'`、`max_tokens: 8192`
- 开头调 `requireAuth`（只有登录用户才能用）
- 透传 status code + body

**改动 .env**：

```
DEEPSEEK_KEY=（从现有部署环境迁入 .env，不要写进仓库）
```

（从 `js/config.js` 搬过来，然后把 config.js 里的真实值删掉）

**改动 js/analyze.js**：

- 把直连 `https://api.deepseek.com/...` 改成 `POST /api/deepseek/chat`
- 删掉 Authorization header（后端加）
- 删掉对 `DEEPSEEK_KEY` 的 import

---

## K2. OSS 签名代理

**为什么不直接让前端带 AK/SK**：有了 AK/SK，谁拿到都能往你的 OSS 上传任何东西、产生费用。

**做法**：前端不持有 AK/SK，上传时先找服务器要一个"临时通行证"（签名 URL），用这个通行证直接传给 OSS。通行证 30 分钟过期，只能上传到指定的路径。

**装依赖**：

```bash
npm install ali-oss
# ECS 同步装
```

**改动 server.cjs**：

新增路由 `POST /api/oss/sign`：

- 入参：`{ filename, contentType }`
- 校验：filename 只允许字母数字+横线+点+下划线，长度 ≤ 200；contentType 必须 `audio/*`
- 生成 ossKey：`podcastcut/uploads/YYYY-MM-DD/<timestamp>-<uuid>.<ext>`
- 用 ali-oss SDK 生成 PUT 签名 URL，30 分钟过期
- 返回：`{ signedPutUrl, ossKey }`
- 开头调 `requireAuth`

新增路由 `POST /api/oss/sign-get`（DashScope 要拉音频用）：

- 入参：`{ ossKey }`
- 返回：`{ signedGetUrl }`，30 分钟过期

**改动 .env**：

```
OSS_ACCESS_KEY_ID=（从 macOS 钥匙串 service: money-scissors-oss 读取）
OSS_ACCESS_KEY_SECRET=（从 macOS 钥匙串 service: money-scissors-oss 读取）
OSS_REGION=oss-cn-beijing
OSS_BUCKET=money-scissors
```

（AK/SK 从 macOS 钥匙串 service `money-scissors-oss` 读）

**改动 js/upload.js**：

- 删掉前端的 `new OSS(...)` 初始化
- 改成两步：
  1. `POST /api/oss/sign` 拿 signedPutUrl 和 ossKey
  2. `fetch(signedPutUrl, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } })`
- 上传成功后调 `/api/oss/sign-get` 拿 GET URL，传给 DashScope
- 失败仍 fallback 到 `/api/upload`（保留现有逻辑）

**改动 js/config.js**：

- 删掉整个 `OSS_CONFIG` 常量
- 删掉 `ALIYUN_DASHSCOPE_KEY` 和 `DEEPSEEK_KEY`
- 只留 `DASHSCOPE_PROXY_URL` 那一行（已经是指向 ECS 代理的，没问题）

---

## 第 3 周验收

用户用浏览器能验证的事：

- [ ] 完整走一遍流程：上传 → 转录 → 分析 → 审查 → 剪辑 → 下载 MP3
- [ ] 浏览器 devtools → Sources → 打开 `js/config.js`：里面没有任何 `sk-` 或 `LTAI5t9` 字样
- [ ] 浏览器 devtools → Network：找不到任何含密钥的请求
- [ ] 没登录直接调 `/api/deepseek/chat` 返回 401

**回滚预案**：

```bash
# 部署前备份
ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'cp -r /opt/money-scissors /opt/money-scissors.bak-$(date +%Y%m%d)'

# 出问题回滚
ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'pm2 stop money-scissors && rm -rf /opt/money-scissors && mv /opt/money-scissors.bak-XXXXXXXX /opt/money-scissors && pm2 start money-scissors'
```

---

# 第 4 周以后：第三步精修（可选）

> ⚠️ 前置：登录系统 + Key 后端化都上线稳定后再动这个。

## 是什么

审查页导出粗剪 MP3 之后，加一个"继续精修"按钮。点了：

1. MP3 上传到 ECS
2. ECS 后台用 Python 处理：响度分析 → 减口屁 → 降噪 → 音量统一
3. 处理完下载精修版 MP3

现成脚本在 `/Users/dang/Documents/podcastcut-skills/音质处理/scripts/`，搬过去改一下就能用。

## 上这个之前先做一件事（B0 性能测试）

在 ECS 上用一段真实 30 分钟播客跑一次，量化：

1. 处理耗时（目标 < 5 分钟）
2. 峰值内存（ECS 只有 2-4G，装 DeepFilterNet 模型可能 OOM）

如果 DeepFilterNet 跑不动，降级用 FFmpeg 自带的 `afftdn`，轻量很多，效果差一点但不崩。

**这件事测完把结果告诉用户，由用户拍板要不要上 DeepFilterNet。**

## 粗略结构（通过 B0 后再细化）

**ECS 端**：

- 新增 `POST /api/process/start`：接收 MP3，放进队列，返回 jobId
- 新增 `GET /api/process/status/:jobId`：返回进度（哪一步/百分比/排队第几）
- 新增 `GET /api/process/download/:jobId`：返回成品文件
- Python pipeline 脚本：响度分析 → 减口屁（pedalboard）→ 降噪 → 响度标准化 -16 LUFS
- 简单内存队列：同时只跑一个 job，多的排队

**前端**：

- `review.html` 下载区加"继续精修"按钮
- 新建 `process.html`：进度页，每 3 秒轮询一次，完成后出下载按钮
- jobId 存 sessionStorage，刷新页面能续上

## 精修完成页面文案

> 这份 MP3 已经做了降噪、调音量、去口屁。
> 如需加片头片尾音乐、做高光片段，推荐用剪映或 Audition。

---

# 给 codex 的几个硬规矩

1. 每个改动先本地跑通再部署 ECS。
2. 每个改动写"怎么测"，让用户用手机/浏览器能自己验证。
3. 涉及密码/密钥的代码不要 `console.log`。
4. 不要把 `.env` 提交 git。`.env.example` 用占位符 `__FILL_BEFORE_DEPLOY__`。
5. 不要动 `剪播客/templates/` 和 `剪播客/scripts/`。
6. 破坏性操作（删文件、重启服务）先告知用户，等确认再执行。
7. commit message 用中文。
8. 遇到取舍拿不定主意 → 选简单方案 + 列已知限制，别过度工程。

---

# 用户在执行前要准备的事

**第 1-2 周开始前**（登录系统）：

- [ ] 阿里云短信模板申请（要审核，越早越好）—— 申请完把模板 ID 给 codex
- [ ] 把你的手机号告诉 codex（写进 .env 的 ADMIN_PHONES）
- [ ] 阿里云短信账号充 50 块

**第 3 周开始前**（Key 后端化）：无需额外准备，登录系统做完直接开始。

**第 4 周**（精修）：等 B0 测试结果出来后拍板。
