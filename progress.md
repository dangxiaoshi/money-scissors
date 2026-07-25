# 金钱剪刀 · 进度交接 / 晨报

> 这是给「下一轮 AI / 当当早上验收」看的干净交接，不是流水账日记（日记在 Obsidian）。
> 每轮 agent 收尾必须更新这一页。当当早上看这一页就够，不用翻聊天记录。
> 配套：规则看 CLAUDE.md，任务状态看 feature_list.json，开工前先跑 ./init.sh。

---

## 最后更新

- 时间：2026-07-15 14:55 CST
- 更新人：Codex

## 当前健康状态

- 正式站 https://bokejianji.cn/api/health ：200（`./init.sh` 实测；额外 HTTPS 只读探测 `/api/health`、`/`、`/review.html` 均 200）
- 测试站 8090 ：200（本轮部署后 health、登录和训练台浏览器冒烟均通过）
- OSS：正式站已灰度切 OSS（prod 前缀），观察期仍在进行；本轮未做上传/转写/生成 MP3 写入冒烟，因为夜间围栏禁止写正式站/数据库/上传

## 上一轮做了什么（最近一次有实质进展）

- 本轮（2026-07-15）：完成并上线订单闭环与审稿页/训练台修复。
  - 派单最多 2 人同时领取；领取/打回记录有 5 天期限，超时自动释放名额。
  - 外部工具成品提交落到 `dispatch_claims`；助教采用后订单统一“已完结”，其他抢单记录关闭并收到站内通知；完结后抢单、提交、审核打回均被后端拒绝。
  - `review.html` 本单需求入口、跨句选区保护、粗剪试听只读闸门、决策 AI 超时配置、登录页码模式与训练台去日期卡片已随本轮发布。
  - 本地 integration、61 项审稿回归、页面码模式、接单 UI 回归、release check 全部通过；正式部署脚本 health/smoke 通过。

- 本轮（2026-06-20 16:16）：按 harness 继续唯一 `in_progress` 的夜间任务 `oss-prod-watch`，只读观察正式 OSS 灰度。
  - 产出：`需求讨论/20260620_OSS正式灰度观察记录.md`
  - 已更新：`feature_list.json` 的 `oss-prod-watch.evidence`
  - 结论：公网健康正常；未发现不可用信号；完整上传/转写/生成 MP3/下载链路仍需白天真账号补验。
- 前序实质进展：三个并行窗口（review.html / orders 前端 / 研究）跑完各自队列：
  - review.html：磁吸复查=已收口、删除/气口卡顿做了缓存、新增『本单需求』入口 → **只在 8090，未升正式**
  - orders/index.html：素材试听下载 + 提交成品前端壳 + 任务卡优化 → **只在 8090，未升正式**
  - 研究窗：写了反馈入口/外部成品/Day1 AI 三份后端方案 + 删除段哨兵脚本
- T4/T5 删除段格式归一+后端校验：当当当场拍板，**已升正式**
- 搭好 harness 四件套（CLAUDE.md / init.sh / feature_list.json / progress.md）

## ⚠️ 仍需当当做的业务验收

1. 用真实账号和真实订单走一遍“两个名额 → 提交 → 采用 → 另一条收到本单已结提醒”。
2. 用真实音频看一遍审稿页“本单需求”入口和导出/提交审核不受影响。

代码已推正式；以上仅是业务侧 spot-check，不需要再部署。

## 卡在哪 / 风险

- 登录当前按服务器 `.env` 的 `AUTH_CODE_DELIVERY_MODE=page` 返回页面绿色验证码；恢复真短信时改回 `sms` 并重启，两站均有启动告警。
- T1 正式 cron：等当当看几天磁盘趋势再开
- 公安备案：人工台，等审核结果
- OSS 观察期：盯上传/转写/生成MP3/下载/带宽；RAM key 当前无 delete 权限

## 下一轮从哪继续

- **Hermes 夜间（无人值守）**：feature_list 现在已有唯一 `in_progress`：`oss-prod-watch`。下一轮先继续它，不要另开 `oss-watch-checklist` / `deepen-design-docs`，除非 `oss-prod-watch` 已被明确标为 done 或当当改状态。
- **oss-prod-watch 下一步**：白天真账号补一次“上传 → 转写 → 生成 MP3 → 下载”完整链路；夜间 agent 只做只读 health/页面探测和文档记录，不做上传/回退/SSH。
- **有人看着的代码窗口**：如继续开发，从 `feedback-entry` 或 `day1-ai-feedback` 里挑一个；`external-submission-backend` 已收口。
- **当当**：先做上面两条业务验收；OSS 观察如果白天链路正常且带宽无异常，可把 `oss-prod-watch` 收成 done。

## 2026-07-15 交接

- 已做：本地回归、测试站部署/登录浏览器冒烟、正式站部署与 smoke test；正式站直接 HTTPS IP 的登录发码/验证/`/api/auth/me` 均 200。
- 代码额外补强：畸形 URL/路径现在返回 400，不再污染 PM2 错误日志。
- 未做：没有上传、转写、生成 MP3 或切换 OSS；这些仍需真实音频和白天观察窗口。

## 2026-06-20 16:16 夜间交接

- 做了什么：运行 `./init.sh`，确认正式/测试 health 200、`server.cjs` 语法 OK；继续 `oss-prod-watch`；只读探测正式 HTTPS `/api/health`、`/`、`/review.html` 均 200。
- 产出：`需求讨论/20260620_OSS正式灰度观察记录.md`；`feature_list.json` 已追加本轮 evidence；`progress.md` 已更新。
- 下一轮从哪继续：`oss-prod-watch` 仍 `in_progress`。如果仍是夜间无人值守，只能继续只读观察；完整链路必须等白天真账号/人工窗口。
- 未做/原因：未上传、未转写、未生成 MP3、未查 ECS 带宽；这些都会写正式站/数据库或需要 SSH/控制台，夜间围栏禁止。

---

## 收尾检查表（每轮 agent 收工前自检，照抄打勾）

- [x] 项目处于可恢复状态（没有改一半的代码；本轮未改业务代码）
- [x] 改了代码的：node --check、页面码模式/接单/审稿回归、release check、测试/正式部署 smoke 均通过
- [x] feature_list.json 对应任务状态已更新，且 passing/done 都有 evidence（订单相关 3 项已收口；`oss-prod-watch` 仍 in_progress）
- [x] 本页『上一轮做了什么』『验收债』『下一轮从哪继续』已更新
- [x] 临时文件已清理（未创建临时文件）
- [x] 没有越围栏（本轮为有人授权的代码窗口；未改正式 `.env`，部署前先测试站验收并自动备份）
