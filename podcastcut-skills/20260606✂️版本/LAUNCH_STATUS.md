# 金钱剪刀上线状态

## 当前结论

`web/` 已部署到服务器 `money-scissors-m2`，`chuanjiabao.vip` 已切到 `127.0.0.1:3002`，当前可开放给学员试用。当前版本为免登录模式，短信签名/模板不参与学生使用链路。

## 已完成

- 前端真实 DeepSeek Key 和 OSS AK/SK 已移除。
- DeepSeek 改为后端代理 `/api/deepseek/chat`。
- 上传改为登录后走 `/api/upload`，并增加服务端音频类型校验。
- `/api/refine/*` 已加登录鉴权、任务归属校验和并发限制。
- 新增 `/api/health`。
- 新增隐私说明页 `/privacy`。
- 新增 `package.json`、`package-lock.json`、`.env.example`。
- 新增部署、预检、回滚、冒烟测试、备份、清理脚本。
- 根目录原型 HTML 中的旧前端 key 已替换为占位符。
- 审查页和剪辑页数据已增加 `localStorage` 恢复兜底，降低刷新或跳转异常造成的数据丢失。
- 短信验证码接口已增加 IP 级限流，响应已增加基础安全头。

## 线上现状

- `chuanjiabao.vip` 当前代理到 `127.0.0.1:3002`，对应 PM2 `money-scissors-m2`。
- `client_max_body_size` 已改为 `500m`。
- `/api/health`、`/login`、`/api/auth/me` 线上冒烟通过。
- 线上上传接口、DashScope 转录提交代理、DeepSeek 代理均已用轻量请求验证通过。
- 服务器具备 Node.js、npm、pm2、curl、python3、ffmpeg、ffprobe、nginx、systemctl，磁盘空间足够。
- 线上 M2 `.env` 已设置 `AUTH_DISABLED=1`、`PUBLIC_BASE_URL=https://chuanjiabao.vip`、`DEEPSEEK_KEY`、DashScope Key、阿里云 AK/SK，且已关闭开发短信 fallback。

## 复查命令

```bash
sh scripts/check_remote_env_status.sh
sh scripts/preflight_ecs.sh
sh scripts/check_remote_routing.sh
sh scripts/smoke_test.sh https://chuanjiabao.vip
```

## 下一步人工验收

- 学员视角：打开 `https://chuanjiabao.vip`，上传一段真实音频，完成转录、说话人命名、AI 分析、审查页导出、剪辑页下载。
- 精修页：打开 `https://chuanjiabao.vip/refine/`，上传一段真实音频，处理并下载。
- 后台 CSV：当前免登录模式下后台接口未开放；如需要后台管理，后续应恢复登录或增加单独后台口令。

## 当前远端阻塞清单

- 无学生使用链路硬阻塞。
- 短信登录链路未启用；如后续恢复登录，仍需配置 `ADMIN_PHONES`、`ALIYUN_SMS_SIGN`、`ALIYUN_SMS_TEMPLATE`。
- `chuanjiabao.vip` 仍代理到 `127.0.0.1:3001`，不是金钱剪刀。
- `chuanjiabao.vip` 的 `client_max_body_size` 仍是 `50m`，开放上传前要改到 `500m`。
- `127.0.0.1:3002/api/health` 当前返回 `404`，说明本地新版尚未部署到 M2。

## 不要做

- 不要同步整个 `/Users/dang/Desktop/金钱剪刀/html/`。
- 不要把任何真实 key 写回前端 HTML 或 `js/config.js`。
- 不要在没有备份的情况下覆盖 `/opt/money-scissors-m2`。
