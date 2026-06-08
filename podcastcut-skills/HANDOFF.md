# 金钱剪刀 Web 上线交接文档

更新时间：2026-05-27 17:19 CST

## 当前可用状态（2026-05-27 17:19）

公网地址：

```text
http://8.136.133.196/
```

当前结论：

- 公网首页已经能访问，`curl -I http://8.136.133.196/` 返回过 `HTTP/1.1 200 OK`。
- ECS 上 PM2 进程 `money-scissors` 在线，服务目录仍是 `/opt/money-scissors`。
- 阿里云 OSS 之前因为欠费/停服返回 `403 UserDisable`，用户充值后已恢复。
- OSS multipart 上传、OSS CORS、OSS V4 签名 URL、DashScope FunASR 代理链路均已复测成功。
- 当前公网前端上传策略：优先 OSS multipart 上传；如果公网环境下 OSS 上传失败，自动 fallback 到 ECS `/api/upload`。
- 用户反馈一位测试者曾短暂遇到 `/dashscope/tasks/...` 查询失败，错误文案提示“本地 DashScope 代理”，但随后恢复正常。公网环境实际走的是 ECS `/dashscope` 代理，不是本地 `dev-dashscope-proxy.cjs`。

最新部署状态：

- 前端脚本版本：`js/main.js?v=20260527-1`
- `web/js/upload.js`：
  - 优先 `client.multipartUpload(...)`
  - 上传成功后优先 `signatureUrlV4('GET', ...)`
  - 上传失败时公网环境 fallback 到 `/api/upload`
- `web/server.cjs`：
  - 静态文件服务
  - DashScope 代理：`/dashscope/transcription`、`/dashscope/tasks/:id`、`/dashscope/result`
  - ECS 兜底上传：`PUT /api/upload?filename=...`
- ECS 兜底上传文件目录：`/opt/money-scissors/public/uploads/YYYY-MM-DD/`

已验证过的关键链路：

- OSS multipart CORS 预检：`200 OK`
- OSS SDK `PutObject`：`200 OK`
- OSS SDK `multipartUpload`：成功
- OSS 签名 URL -> 公网 `/dashscope/transcription` -> FunASR 转录：成功
- ECS `/api/upload` 兜底上传：`201 Created`
- DeepSeek 最小 API 调用和 CORS 预检：之前验证通过

当前仍需注意的风险：

- M1 版本为了快速小范围测试，前端仍暴露 OSS/DeepSeek 相关配置。正式公开前应改成服务端代理或访问密码。
- ECS `/api/upload` 是兜底方案，上传文件会堆在服务器本地；如果长期使用，需要定期清理 `/opt/money-scissors/public/uploads/`。
- 如果 `/dashscope/tasks/...` 偶发 `Failed to fetch`，优先看 PM2 日志和网络抖动；如果稳定复现，应给前端轮询加 2-3 次自动重试，并把错误文案改成“公网代理暂时不可用”。

常用检查命令：

```bash
curl -I http://8.136.133.196/

curl -i -X OPTIONS http://8.136.133.196/dashscope/transcription \
  -H 'Origin: http://8.136.133.196' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-proxy-check'

ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'pm2 status && pm2 logs money-scissors --lines 100 --nostream'
```

重新部署命令：

```bash
cd /Users/dang/Documents/podcastcut-skills

rsync -av --delete -e "ssh -i ~/.ssh/money_scissors_ecs -o StrictHostKeyChecking=no" \
  web/index.html web/review.html web/cut.html web/css web/js \
  root@8.136.133.196:/opt/money-scissors/public/

scp -i ~/.ssh/money_scissors_ecs -o StrictHostKeyChecking=no \
  web/server.cjs root@8.136.133.196:/opt/money-scissors/server.cjs

ssh -i ~/.ssh/money_scissors_ecs -o StrictHostKeyChecking=no root@8.136.133.196 \
  'cd /opt/money-scissors && pm2 restart money-scissors --update-env'
```

## 2026-05-26 22:30 追加进展

本轮继续排查后确认：

- ECS 内部服务仍正常：`curl -I http://127.0.0.1/` 返回 `HTTP/1.1 200 OK`。
- PM2 `money-scissors` 在线，Node 监听 `0.0.0.0:80`，`ufw`/`firewalld` 均未阻断。
- 从本机访问 `http://8.136.133.196/` 仍是 `curl: (52) Empty reply from server`。
- 对照抓包已确认抓包方法有效：公网访问 22 端口时，ECS `tcpdump` 能看到入站包；访问 80 端口时，`nc` 显示 TCP 连接成功，但 ECS `tcpdump` 看不到目的为实例内网 IP `172.27.193.226:80` 的入站包。
- 临时在 ECS 起 `PORT=8080 node server.cjs` 后，公网访问 `8080` 也是 TCP 连接成功但 HTTP empty reply，且实例侧抓不到 `172.27.193.226:8080` 入站包。
- 结论更新：问题仍在阿里云公网入口层，不在 Node/PM2/系统防火墙。优先检查安全组是否真正绑定到实例、是否存在云安全中心/基础防护策略，另外大陆地域 80/网站访问也要检查备案/接入限制。
- 本机没有 `aliyun` CLI，安全组需要在阿里云控制台处理。

已完成的接口验证：

- OSS Bucket CORS 已更新并验证通过：
  - `http://127.0.0.1:8174`
  - `http://8.136.133.196`
  - Methods：`GET`、`PUT`、`POST`、`HEAD`
  - Headers：`*`
  - Expose Headers：`ETag`、`x-oss-request-id`
- ECS 内部 DashScope 代理预检通过：`OPTIONS http://127.0.0.1/dashscope/transcription` 返回 `204` 和正确 CORS 头。
- 通过测试音频验证了完整后端链路：上传到 OSS -> 生成签名 URL -> ECS 内部 `/dashscope/transcription` 提交 -> 轮询任务 -> 拉取转录结果，结果成功返回 `sentences=1`。
- DeepSeek 预检和最小 API 调用验证通过，`api.deepseek.com` 对本地和公网 Origin 都返回了允许的 CORS 头。

当前唯一硬阻塞：

- 公网 HTTP 请求没有进入 ECS 实例。修复公网入口后，再用浏览器访问 `http://8.136.133.196/` 做端到端 UI 流程。

## 2026-05-27 09:50 追加进展

用户已修通公网访问，测试者访问 `http://8.136.133.196/` 后在上传阶段遇到：

```text
XHR error, POST https://money-scissors.oss-cn-beijing.aliyuncs.com/... ?uploads=
```

继续排查后确认：

- 直接对 OSS 做 multipart 预检时返回 `403 UserDisable`，错误码 `0003-00000801`。
- 本地用 OSS SDK 读取 Bucket CORS 仍能成功，但 `PutObject` 返回 `UserDisable`。
- 这不是普通 CORS 配置错误，也不是 DashScope/DeepSeek 问题；当前 OSS 数据写入侧不可用。需要在阿里云控制台检查 OSS/RAM 用户/AccessKey/账号欠费或冻结状态。

为了让小范围测试继续跑，已经新增 ECS 本地上传兜底：

- 新增 `PUT /api/upload?filename=...`
- 服务端把音频保存到 `/opt/money-scissors/public/uploads/YYYY-MM-DD/`
- 返回 `http://8.136.133.196/uploads/...` 作为音频 URL
- 公网页面现在优先走 ECS 同源上传；本地 `127.0.0.1` / `localhost` 仍保留 OSS 上传逻辑。

已部署并验证：

- `curl -I http://8.136.133.196/` 返回 `HTTP/1.1 200 OK`
- `PUT http://8.136.133.196/api/upload?filename=smoke.m4a` 返回 `201 Created`
- 首页已加载 `js/main.js?v=20260527-1`
- 用测试音频跑通：ECS 上传 -> 公网音频 URL -> `/dashscope/transcription` -> 轮询 -> 拉取转录结果，返回 `sentences=1`

后续仍建议修复 OSS `UserDisable`，但当前发给 1 个测试者使用可以先走 ECS 上传。

## 2026-05-27 09:55 追加进展

用户确认原因是阿里云欠费，已经充值。复测后：

- OSS multipart CORS 预检恢复为 `200 OK`
- OSS SDK `PutObject` 恢复为 `200 OK`
- OSS SDK `multipartUpload` 恢复正常
- OSS 签名 URL -> 公网 `/dashscope/transcription` -> FunASR 转录链路已验证成功

公网代码已调整为：

- 优先走 OSS multipart 上传
- 生成音频 URL 时优先用 OSS V4 签名 URL
- 如果公网环境下 OSS 上传再次失败，自动 fallback 到 ECS `/api/upload`

已重新部署到 ECS，PM2 `money-scissors` 在线。

## 目标

把 `podcastcut-skills/web` 里的「金钱剪刀」Web 版部署出来，让别人可以通过浏览器使用：

- 上传音频到阿里云 OSS
- 调阿里云 DashScope FunASR 转录
- 让用户确认说话人
- 调 DeepSeek 做剪辑决策
- 进入 `review.html` 审查
- 通过 `cut.html` 用 ffmpeg.wasm 导出 MP3

## 本地项目位置

项目根目录：

```bash
/Users/dang/Documents/podcastcut-skills
```

用户原始需求文档：

```bash
/Users/dang/Documents/podcastcut-skills/web/SPEC.md
```

关键页面：

```bash
/Users/dang/Documents/podcastcut-skills/web/index.html
/Users/dang/Documents/podcastcut-skills/web/review.html
/Users/dang/Documents/podcastcut-skills/web/cut.html
```

## 已经做过的代码

新增或重写了这些 Web 文件：

- `web/index.html`：上传入口页
- `web/css/shared.css`：共享样式
- `web/js/config.js`：OSS、DashScope 代理、DeepSeek 配置
- `web/js/upload.js`：浏览器上传音频到 OSS
- `web/js/transcribe.js`：调用 DashScope 代理提交转录、轮询、拉取结果
- `web/js/transcript.js`：把阿里云转录结果转成审查页数据
- `web/js/analyze.js`：DeepSeek 粗剪/精剪分批分析
- `web/review.html`：支持从 `sessionStorage` 注入审查数据和音频 URL
- `web/cut.html`、`web/js/cut.js`：用 ffmpeg.wasm 根据审查结果导出 MP3
- `web/dev-dashscope-proxy.cjs`：本地开发用 DashScope 代理
- `web/server.cjs`：ECS 生产用静态文件服务器 + DashScope 代理
- `README.md`：补充了 Web M1 使用说明

注意：`.gitignore` 已经有修改，不确定是否全部由本次工作产生。不要随手回滚。

## 密钥和安全状态

不要在聊天窗口或文档里明文粘贴密钥。

当前密钥大致位置：

- OSS AccessKey：macOS 钥匙串服务名 `money-scissors-oss`
- DashScope API Key：本地 `.env` 里有；ECS 上已放到 `/opt/money-scissors/.env`
- DeepSeek API Key：之前用户提供过，已用于本地配置
- ECS SSH 私钥：`~/.ssh/money_scissors_ecs`

重要安全提醒：

当前 M1 方案为了快速跑通，浏览器前端里仍会暴露部分前端配置，尤其是 OSS/DeepSeek 相关配置。短期给少量可信朋友测试可以，正式公开前应该做至少一项：

- 把 OSS 上传签名、DeepSeek 调用都搬到 ECS 后端代理
- 或者给站点加简单访问密码
- 或者只在非常小范围临时分享

DashScope Key 已经通过 ECS 后端代理隐藏，不直接暴露给浏览器。

## 已验证过的事情

1. Uguu 上传服务 CORS 不适合浏览器直连，已经放弃。
2. DashScope 提交转录接口 CORS 基本可行，但任务轮询接口浏览器 CORS 会失败，所以必须走代理。
3. 本地 DashScope 代理 `127.0.0.1:8787` 曾经验证可用。
4. DeepSeek Key 曾经用接口测过，返回状态正常。
5. OSS 本地 CORS 已配置过 `http://127.0.0.1:8174`，本地上传可用。
6. 本地页面已经能跑到「上传完成 -> AI 语音转录」阶段。

## ECS 信息

阿里云 ECS：

- 公网 IP：`8.136.133.196`
- 实例 ID：`i-bp16vokbpxi51iqggn4q`
- 系统：Ubuntu 22.04
- 登录用户：`root`
- 站点部署目录：`/opt/money-scissors`
- 静态文件目录：`/opt/money-scissors/public`
- Node 服务文件：`/opt/money-scissors/server.cjs`
- 环境变量文件：`/opt/money-scissors/.env`
- PM2 进程名：`money-scissors`

SSH 已经配置好，下一窗口可直接连：

```bash
ssh -i ~/.ssh/money_scissors_ecs -o StrictHostKeyChecking=no root@8.136.133.196
```

服务器上 Node 和 PM2 已经存在：

- Node：v18.20.8
- PM2：已能启动服务

## ECS 当前部署状态

已经把本地 Web 文件同步到 ECS：

```bash
/opt/money-scissors/public/
```

已经启动 PM2：

```bash
cd /opt/money-scissors
PORT=80 pm2 start server.cjs --name money-scissors --time
pm2 save
```

PM2 状态曾经显示：

```text
money-scissors online
```

ECS 内部访问正常：

```bash
curl -I http://127.0.0.1/
```

返回过：

```text
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
```

Node 确认监听 `0.0.0.0:80`：

```bash
ss -ltnp | grep ':80'
```

返回过类似：

```text
LISTEN 0 511 0.0.0.0:80 users:(("node /opt/money",pid=2270,...))
```

系统防火墙状态：

```bash
ufw status
```

返回过：

```text
Status: inactive
```

## 当前阻塞点

从外部访问：

```bash
curl -I http://8.136.133.196/
```

结果不是正常 200，而是：

```text
curl: (52) Empty reply from server
```

进一步验证：

```bash
nc -vz -w 5 8.136.133.196 80
```

显示 TCP 80 能连接。

但在 ECS 上抓包：

```bash
timeout 8 tcpdump -i eth0 -nn -A "host <本机公网IP> and tcp port 80" -c 12
```

结果是：

```text
0 packets captured
```

结论：Node 服务本身没问题，请求没有真正进到 ECS 网卡。问题大概率在阿里云公网入口/安全组/安全产品，而不是代码。

## 下一步优先级

### 1. 先修公网 80 访问

在阿里云控制台检查 ECS 安全组，给实例所在安全组添加入方向规则：

- 协议类型：自定义 TCP
- 端口范围：`80/80`
- 授权对象：`0.0.0.0/0`
- 策略：允许
- 优先级：1 或默认

如果已经有 80，还要检查：

- 规则是不是加在这台 ECS 实例绑定的安全组上
- 是否只允许了某个来源 IP
- 是否有云安全中心/防护策略拦截 HTTP
- 是否有其他负载均衡、NAT、EIP 配置影响

修完后在本机测：

```bash
curl -I http://8.136.133.196/
```

期望：

```text
HTTP/1.1 200 OK
```

### 2. 测 ECS 上的 DashScope 代理

公网首页能访问后，测代理预检：

```bash
curl -i -X OPTIONS http://8.136.133.196/dashscope/transcription \
  -H 'Origin: http://8.136.133.196' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-proxy-check'
```

期望状态：

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://8.136.133.196
```

如失败，看 PM2 日志：

```bash
ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'pm2 logs money-scissors --lines 100 --nostream'
```

### 3. 给 OSS 增加公网 Origin CORS

OSS 之前只确认过本地 Origin：

```text
http://127.0.0.1:8174
```

部署到 ECS 后，浏览器 Origin 会变成：

```text
http://8.136.133.196
```

需要在 OSS Bucket `money-scissors` 的 CORS 规则里加这个来源：

- 来源：`http://8.136.133.196`
- Methods：`GET`、`PUT`、`POST`、`HEAD`
- Headers：`*`
- Expose Headers：`ETag`、`x-oss-request-id`
- 缓存时间：`0`

可以用这个命令验证：

```bash
curl -i -X OPTIONS 'https://money-scissors.oss-cn-beijing.aliyuncs.com/podcastcut/uploads/cors-check.txt' \
  -H 'Origin: http://8.136.133.196' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type,x-oss-date,authorization,x-oss-content-sha256'
```

期望看到：

```text
Access-Control-Allow-Origin: http://8.136.133.196
```

### 4. 浏览器实测完整流程

打开：

```text
http://8.136.133.196/
```

上传一个小音频测试：

- Step 1 上传到 OSS
- Step 2 FunASR 转录
- Step 3 必须停下来让用户填写说话人姓名
- Step 4 DeepSeek 分批分析
- Step 5 生成审查数据
- Step 6 跳转 `review.html`
- 最后到 `cut.html` 导出 MP3

如果页面仍然报 `Failed to fetch`，先看浏览器开发者工具 Network：

- 如果失败 URL 是 OSS：优先查 OSS CORS
- 如果失败 URL 是 `/dashscope/...`：优先查 ECS 代理和 PM2 日志
- 如果失败 URL 是 `api.deepseek.com`：可能是 DeepSeek CORS 或 Key 问题，正式方案最好也改成 ECS 代理

## 重新部署命令

本地改完后，同步到 ECS：

```bash
cd /Users/dang/Documents/podcastcut-skills

ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'mkdir -p /opt/money-scissors/public'

rsync -av --delete \
  web/index.html web/review.html web/cut.html web/css web/js \
  root@8.136.133.196:/opt/money-scissors/public/

scp web/server.cjs root@8.136.133.196:/opt/money-scissors/server.cjs

ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196 \
  'cd /opt/money-scissors && pm2 restart money-scissors'
```

如果 `rsync/scp` 没自动用私钥，可改成：

```bash
rsync -av --delete -e "ssh -i ~/.ssh/money_scissors_ecs" \
  web/index.html web/review.html web/cut.html web/css web/js \
  root@8.136.133.196:/opt/money-scissors/public/

scp -i ~/.ssh/money_scissors_ecs \
  web/server.cjs root@8.136.133.196:/opt/money-scissors/server.cjs
```

## 下个窗口建议开场白

可以直接复制这段给新窗口：

```text
请继续帮我部署 /Users/dang/Documents/podcastcut-skills 的金钱剪刀 Web 版。先读 /Users/dang/Documents/podcastcut-skills/HANDOFF.md。当前状态是 ECS 内部 http://127.0.0.1/ 返回 200，PM2 money-scissors 在线，但公网 http://8.136.133.196/ 访问 Empty reply，tcpdump 没抓到外部 HTTP 包。请先帮我定位/指导阿里云安全组 80 端口，然后继续验证 OSS CORS 和完整上传转录流程。不要在回复里暴露任何密钥。
```
