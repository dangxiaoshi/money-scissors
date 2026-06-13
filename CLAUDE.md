# 金钱剪刀 · 项目状态（先读我）

> 这是给每个开发窗口 AI 的入口文件，自动加载。**先读完这一页再动手。**
> 这里只放速览和指针，不放全文。需要细节去 Obsidian 翻大文件，别一上来就全读。
> 更新：2026-06-13

---

## 一句话

金钱剪刀是剪辑营的交付工具。主线：学员登录 → 进训练台 → 完成 Day1 自我介绍解锁剪辑台 → 在剪辑台提交一次助教审核解锁接单台 → 用剪辑台上传音频、生成剪辑决策、审稿、导出 MP3 → 去接单台抢真实订单。

**北极星：剪辑台负责生产和审核，训练台负责学习，接单台负责变现。**

---

## 代码在哪

| 模块 | 本地位置 | 说明 |
|---|---|---|
| 总目录 | `/Users/dang/Desktop/金钱剪刀` | 正式源头只保留 `剪辑台/web` 这一套 |
| 剪辑台 | `/Users/dang/Desktop/金钱剪刀/剪辑台/web` | 核心，全栈都在这里 |
| 训练台 | `/Users/dang/Desktop/金钱剪刀/剪辑台/web/training` | 正式训练台：课表、SOP、Day1 自我介绍 |
| 接单台 | `/Users/dang/Desktop/金钱剪刀/剪辑台/web/orders` | 正式接单台：接单大厅、排行榜、派单 |
| 旧资料 | `/Users/dang/Desktop/金钱剪刀_旧资料_待整理_20260610/三台独立旧版_20260612` | 旧独立 `训练台/`、`接单台/` 已移走，别当现状 |

## 服务器和入口

| 项目 | 信息 |
|---|---|
| 服务器 | 8.136.133.196，阿里云 ECS |
| 生产后端 | `/opt/money-scissors-m2`，PM2 `money-scissors-m2`，端口 3002 |
| 测试后端 | `/opt/money-scissors-test`，PM2 `money-scissors-test`，端口 3004 |
| 正式验收入口 | `http://8.136.133.196/` |
| ⚠️ nginx | 2026-06-10 后改过裸 IP / 切到 money-scissors-m2，**开发前必须重新确认当前 nginx 配置**，别信旧地址 |

---

## 当前待收口（按优先级）

| 优先级 | 事项 | 状态 |
|---|---|---|
| A | 剪辑决策恢复旧版脑子 | 未完成，有执行计划，见追溯台账 |
| A | 多音频上传线上复测 | 本地完成，线上待部署/复测 |
| A | 上传重复验证码排查 | 需真机复现 |
| A | 提交快照给助教审核最小闭环 | 部分完成，仍需收口 |
| A | 我的项目为空排查 | 需线上复现 |
| A | 三台顺序解锁 | 已部署测试站和正式站；线上真实登录 API 复测通过：登录进训练台，Day1 解锁剪辑台，Day2 提交助教审核后解锁接单台，后台可见 D1/D2 |
| A | 派单入口和权限 | 本地基本完成，线上待验收 |
| B | Day1 卡片四问和金黄配色 | 本地完成，待用户看样式 |

## 最近完成

| 日期 | 事项 | 结果 |
|---|---|---|
| 2026-06-13 | 训练台 Day1 默认入口恢复 | 已白名单同步正式站 `training/path.html`，未同步其他本地半成品，未重启服务。正式站 `http://8.136.133.196/training/path.html` 不再按现实日期或完成状态自动跳到 D2，所有学员进入 21 天路径默认先看到 D1 开营直播；D1 卡片回到路径列表第一行；未完成 D1 时点击 D2「打开我的项目」会提示先做 D1。线上旧页备份：`/opt/money-scissors-m2.releases/manual-20260613-084513-before-day1-default/path.html`。已用公网地址 + Chrome 模拟未完成 D1 状态验收；Codex 只读复查 No findings。 |
| 2026-06-12 | 开营直播练习母版上线 | 已白名单同步测试站和正式站 `server.cjs`、`projects.html`、`js/projects.js`、`data/practice-templates/launch-live-20260612.json`，只新增练习母版数据，未覆盖数据库/上传文件。学员在「我的项目」点 `D2 练习项目｜开营直播` 会复制一份已转写私人项目并直达审稿页，不再等待 50 分钟音频转录；同一学员二次点击复用原项目。测试站和正式站真实 API 验收通过：84 段逐字稿、7 个章节、练习建议、音频链接正常。已重启 PM2 `money-scissors-test`、`money-scissors-m2`。备份：`/opt/money-scissors-m2.releases/manual-20260612-225219-before-practice-master.tgz`。 |
| 2026-06-12 | 剪辑台“区分发言人”选项上线 | 已白名单同步测试站和正式站 `edit.html`、`js/main.js`，未覆盖 `data/`，未重启服务。原“说话人数”数字框改为四个按钮：暂不体验、单人演讲、2人对话、多人讨论；默认“多人讨论”。底层仍映射到现有人数参数：1/1/2/6。正式公网反查和 `/api/health` 通过。备份：`/opt/money-scissors-m2.releases/manual-20260612-223703-before-speaker-mode.tgz`。 |
| 2026-06-12 | 开营直播练习项目体验调整 | 已白名单同步测试站和正式站 `edit.html`、`projects.html`、`js/projects.js`、`training/path.html`，未覆盖 `data/`，未重启服务。剪辑台首页不再显示练习素材卡；「我的项目」会显示虚拟项目 `D2 练习项目｜开营直播`，点开进入 `edit.html?practice=launch` 自动载入素材；若已有真实开营直播项目则不重复显示；21天首页 D2 主按钮改为“打开我的项目”。正式公网反查、音频链接和 `/api/health` 通过。备份：`/opt/money-scissors-m2.releases/manual-20260612-223306-before-practice-project.tgz`。 |
| 2026-06-12 | 开营直播练习素材上线 | 已把腾讯会议录音 `开营直播.m4a` 放到测试站和正式站 `/uploads/practice/kaiying-live-20260612.m4a`（约 50 分钟，46MB）。已白名单同步 `edit.html`、`js/main.js`、`training/path.html`，未覆盖 `data/`，未重启服务。剪辑台首页显示“D2 练习素材：开营直播”；学员点“使用这条素材”会载入远程素材并走原有转录/AI分析/审稿流程；21天首页 D2 按钮直达 `/edit?practice=launch`。正式公网反查和音频 200 验证通过。备份：`/opt/money-scissors-m2.releases/manual-20260612-222448-before-practice-material.tgz`。 |
| 2026-06-12 | 开营提示优化 | 已白名单同步测试站和正式站，只同步 `training/path.html`、`login.html`、`js/login.js`、`js/station-nav.js`，未覆盖 `data/`，未重启服务。D2/D3 首页说明改为“剪开营直播，剪到25-30分钟，先不用片头片尾音乐”；登录页强化绿色验证码和微信群昵称提示；21天首页/接单台锁住提示改为“不是网站坏了，是 D1/D2 作业没完成”。正式保险包：`/opt/money-scissors-m2.releases/manual-20260612-215317-before-open-tips.tgz`。公网反查和 `/api/health` 通过。 |
| 2026-06-12 | 旧 AI 工具页登录修复 + 小红书工具下架 | 已白名单同步测试站和正式站：`edit.html`、`tools.html`、`js/ai-tool-page.js`、3 个旧 AI 页、声音克隆页、小红书旧页。Show Notes/剪辑决策/旁白生成会带 `jinqian_token` 调 AI；声音克隆要求登录；小红书推广卡片从入口下架，旧直达变为“工具已下架”页且不含 AI 请求。备份：`/root/nginx-backups/money-scissors-tool-auth/*tool-auth-20260612-180139.tgz`。正式测试号 `13655701804` 验证：完成 Day1 后 AI 接口不再报未登录。Codex 复查指出旧小红书页仍含生成器代码，已修。 |
| 2026-06-12 | 我的项目页顶部精简 | 已只同步 `projects.html` 到测试站和正式站，页面顶部从训练台/接单台/上传新音频/后台/手机号/退出收成一个「返回剪辑台」按钮，色调样式不变。服务器旧页面备份：`/root/nginx-backups/money-scissors-projects-page/*projects.html.20260612-172245`。正式公网内容反查通过。 |
| 2026-06-12 | 审稿页左侧决策展开修复 | 已只同步正式站 `review.html`。剪辑决策 4 个主块固定展开，点击标题不再收起；无真实剪辑决策时只显示说明卡，不再渲染空横条；并修复左侧 flex 布局把已展开卡片压扁的问题（`.nav-act-item { flex-shrink: 0; }`）。服务器旧页面备份：`/root/nginx-backups/money-scissors-review-page/review.html.20260612-182030`、`review.html.20260612-183518`。正式公网源码反查通过。 |
| 2026-06-12 | 21天首页新版上线 | 已白名单同步测试站和正式站，只同步 `training/path.html`、`js/station-nav.js`，未覆盖 `data/`。新版路径页接入旧腾讯会议直播链接和现有 `training/sop.html` 课件页；顶部三台显示 D1/D2 锁状态；正式浏览器验收通过，测试号 `13555700131`。正式保险包：`/opt/money-scissors-m2.releases/manual-20260612-171403-before-path21-homepage.tgz`。 |
| 2026-06-12 | 后台学员作业归档 | 已白名单同步测试站 `/opt/money-scissors-test` 和正式站 `/opt/money-scissors-m2`，只同步 `server.cjs`、`js/station-nav.js`、`js/admin.js`、`training/intro.html`、`admin.html`，未覆盖 `data/`。测试站和正式站均按满分100标准验收通过：D1四问可看、D2成品可看、待审核数真实且审完减少、老学员兼容、非管理员被拒。 |

---

## 铁律（验收和部署）

- **不能把"页面能打开""接口 200""本地模拟成功"当完成。** 必须用真实账号、真实音频、真实浏览器、真实下载验收。
- 多文档里有旧地址和旧方案。**一切以代码现状、服务器现状、本文件为准**，不以旧文档为准。
- 正常迭代先进测试环境，确认后再推正式；本轮按白名单部署，避免把无关半成品同步到正式站。

---

## 要更多细节去这里翻（别全读，按需翻）

Obsidian 项目目录：`/Users/dang/Library/Mobile Documents/iCloud~md~obsidian/Documents/dangxiaoshi/项目/金钱剪刀/开发日记/`

| 想知道什么 | 翻哪个文件 |
|---|---|
| 这一步做了什么、为什么这么改、怎么回滚 | `开发日记.md` |
| 本轮上线的完整需求和完成定义 | `2026-06-11_金钱剪刀开营前剪辑台上线需求文档.md` |
| 当时的原始记录、全文搜原话 | `开发日记原文归档.md`（168KB，只在前两个不够时再翻） |
| 当当的规划和思考 | `当当规划和思考口语.md` |

---

> **维护规则**：每次有重要进展（部署了什么、收口了哪项、风险变化），先更新本文件的"当前待收口"和"更新"日期，再去写详细日记。让本文件永远是最新现状的单一入口。
