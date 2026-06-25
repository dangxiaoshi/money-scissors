# 金钱剪刀上线清单

## 1. 上线前必须做

- 吊销并重建已经出现在前端的 DeepSeek Key 和 OSS AccessKey。
- 在服务器 `.env` 写入 `DASHSCOPE_API_KEY`、`DEEPSEEK_KEY`、`PUBLIC_BASE_URL`，并设置 `AUTH_DISABLED=1`。
- 确认 `PUBLIC_BASE_URL` 是公网可访问的 HTTPS 域名，不能长期使用裸 IP。
- 确认服务器 `.env` 权限是 `600` 或 `400`，避免真实密钥被其他用户读取。
- 确认本机安装了 `ssh`、`rsync`，服务器安装了 `node`、`npm`、`pm2`、`curl`、`python3`、`ffmpeg`、`ffprobe`、`nginx`、`systemctl`。
- 确认 `data/`、`logs/`、`public/uploads/` 可写。

## 2. 本地验证

```bash
cd /Users/dang/Desktop/金钱剪刀/html/web
npm install
npm run check
PORT=40123 DASHSCOPE_API_KEY=test DEEPSEEK_KEY=test AUTH_DISABLED=1 npm start
```

另开终端验证：

```bash
curl -i http://127.0.0.1:40123/api/health
curl -i http://127.0.0.1:40123/login
curl -i http://127.0.0.1:40123/api/refine/status/test
curl -i -X POST http://127.0.0.1:40123/api/deepseek/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"test"}]}'
```

预期：

- `/api/health` 返回 `200`。
- `/login` 返回 `200`。
- 免登录模式下 `/api/auth/me` 返回 guest 用户。
- 免登录模式下 `/api/refine/status/test` 返回 `404`，表示已通过鉴权但任务不存在。
- `/api/deepseek/chat` 空消息返回 `400`。

## 3. 部署步骤

补齐远端 `.env` 后，可以用总控脚本执行发布链路：

```bash
cd /Users/dang/Desktop/金钱剪刀/html/web
MONEY_SCISSORS_CUTOVER=1 \
MONEY_SCISSORS_BASE_URL=https://chuanjiabao.vip \
sh scripts/launch_production.sh
```

`MONEY_SCISSORS_CUTOVER=1` 会把 `chuanjiabao.vip` 切到金钱剪刀。去掉这个变量时，脚本只执行发布和远端路由检查，不改 Nginx 站点。

也可以逐步执行：

```bash
cd /Users/dang/Desktop/金钱剪刀/html/web
sh scripts/check_release.sh
sh scripts/preflight_ecs.sh
sh scripts/deploy_ecs.sh
```

默认部署到 `/opt/money-scissors-m2`，重启 PM2 进程 `money-scissors-m2`，并验证远端本机 `http://127.0.0.1:3002/api/health`。如果以后改路径、进程名或端口，用环境变量覆盖：

```bash
MONEY_SCISSORS_REMOTE_DIR=/opt/money-scissors-m2 \
MONEY_SCISSORS_PM2_NAME=money-scissors-m2 \
MONEY_SCISSORS_REMOTE_PORT=3002 \
sh scripts/deploy_ecs.sh
```

部署脚本会先在服务器生成备份：`/opt/money-scissors-m2.releases/backup-时间.tgz`。

如果预检失败，先补服务器 `/opt/money-scissors-m2/.env`。当前免登录生产预检要求 `PUBLIC_BASE_URL` 使用 HTTPS，`DASHSCOPE_API_KEY`、`DEEPSEEK_KEY` 齐全，且不能是空值或占位符，并且禁止 `ALLOW_DEV_SEND_CODE_FALLBACK=1`。

如果只想看远端 `.env` 还缺什么，不打印任何密钥值：

```bash
sh scripts/check_remote_env_status.sh
```

设置远端必需环境变量示例：

```bash
PUBLIC_BASE_URL='https://your-domain.example' \
DEEPSEEK_KEY='新生成的 DeepSeek Key' \
AUTH_DISABLED='1' \
ALLOW_DEV_SEND_CODE_FALLBACK='0' \
sh scripts/set_remote_env.sh \
  PUBLIC_BASE_URL \
  DEEPSEEK_KEY \
  AUTH_DISABLED \
  ALLOW_DEV_SEND_CODE_FALLBACK
```

脚本会更新服务器 `/opt/money-scissors-m2/.env` 中对应键，不会打印密钥值，并会把 `.env` 权限设置为 `600`。

开发环境临时预检可用：

```bash
MONEY_SCISSORS_PREFLIGHT_MODE=dev sh scripts/preflight_ecs.sh
```

正式上线不要使用 dev 预检。

注意：`/Users/dang/Desktop/金钱剪刀/html` 根目录下还有若干原型 HTML，旧前端密钥已清理，但它们不是生产应用。不要同步整个 `html/` 目录；只能从 `html/web/` 作为发布根目录部署。

部署成功并确认 `3002` 本地服务正常后，如果要把 `chuanjiabao.vip` 正式切到金钱剪刀：

```bash
sh scripts/switch_nginx_to_money_scissors.sh
sh scripts/check_remote_routing.sh
sh scripts/smoke_test.sh https://chuanjiabao.vip
```

这个脚本会备份 `/etc/nginx/sites-available/chuanjiabao`，把 `proxy_pass` 改到 `127.0.0.1:3002`，把 `client_max_body_size` 改为 `500m`，然后执行 `nginx -t` 和 reload。

回滚：

```bash
sh scripts/rollback_ecs.sh /opt/money-scissors-m2.releases/backup-YYYYmmdd-HHMMSS.tgz
```

如果只需要回滚域名路由，可以把脚本输出的 Nginx 备份文件复制回 `/etc/nginx/sites-available/chuanjiabao`，然后执行 `nginx -t && systemctl reload nginx`。

## 4. Nginx 要求

Nginx 必须把这些路径转发给 Node 服务，而不是只读静态文件：

- `/api/`
- `/dashscope/`
- `/login`
- `/admin`
- `/refine/`

配置示例见 [deploy/nginx-money-scissors.conf.example](deploy/nginx-money-scissors.conf.example)。

当前服务器只读检查结果：

- 裸 IP 默认站点转发到 `127.0.0.1:3002`，对应 PM2 `money-scissors-m2`。
- `chuanjiabao.vip` 当前转发到 `127.0.0.1:3001`，不是金钱剪刀。
- `chuanjiabao.vip` 的 `client_max_body_size` 是 `50m`，若作为金钱剪刀域名使用，需要改到 `500m`。
- `money-scissors-m2` 当前线上还没有 `/api/health`，部署本地新版本后应返回 `200`。
- 当前线上已切到 `127.0.0.1:3002`，`client_max_body_size` 已是 `500m`。

部署后检查：

```bash
curl -i https://your-domain.example/api/health
curl -i https://your-domain.example/login
curl -i https://your-domain.example/api/auth/me
sh scripts/check_remote_routing.sh
sh scripts/smoke_test.sh https://your-domain.example
```

## 5. 人工验收

- 手机打开域名，首页能显示。
- 免登录进入首页后能上传音频。
- 上传后能进入转录、说话人命名、AI 分析、审查页。
- 审查页导出后能进入剪辑页并下载 MP3。
- `/refine/` 免登录能上传、处理、下载。
- 后台 CSV 当前未开放；如需要后台管理，后续应恢复登录或增加单独后台口令。

## 6. 上线后监控

- 每天确认磁盘空间，重点看 `public/uploads/` 和 `data/refine-jobs/`。
- 每天备份 `data/users.db`。
- 观察 DeepSeek 和 DashScope 调用成本。
- 观察 DeepSeek、DashScope 错误和上传失败日志。

建议在服务器加 cron：

```bash
crontab -e
```

加入：

```cron
0 3 * * * /bin/sh /opt/money-scissors-m2/scripts/backup_db.sh >> /opt/money-scissors-m2/logs/backup.log 2>&1
30 * * * * /bin/sh /opt/money-scissors-m2/scripts/cleanup_runtime_files.sh >> /opt/money-scissors-m2/logs/cleanup.log 2>&1
```

默认行为：

- 数据库备份到 `/opt/money-scissors-m2/data/backups/`，保留最近 7 份。
- 上传音频保留 3 天。
- 精修临时文件保留 180 分钟。
