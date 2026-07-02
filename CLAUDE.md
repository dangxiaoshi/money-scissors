# 金钱剪刀 · 项目状态（先读我）

> 这是给每个开发窗口 AI 的入口文件，自动加载。**先读完这一页再动手。**
> 这里只放速览和指针，不放全文。需要细节去 Obsidian 翻大文件，别一上来就全读。
> 更新：2026-07-02 下午

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
| 旧资料 | `/Users/dang/Desktop/金钱剪刀/金钱剪刀_旧资料_待整理_20260610/` | 旧独立 `训练台/`、`接单台/` 与历史剪辑音频留档，别当现状 |

## 服务器和入口

| 项目 | 信息 |
|---|---|
| 服务器 | 8.136.133.196，阿里云 ECS |
| 生产后端 | `/opt/money-scissors-m2`，PM2 `money-scissors-m2`，端口 3002 |
| 测试后端 | `/opt/money-scissors-test`，PM2 `money-scissors-test`，端口 3004 |
| 正式验收入口 | `https://bokejianji.cn/`（正式域名；http 会跳 https） |
| 裸 IP 入口 | `http://8.136.133.196/`（同一个正式站，优先用域名给用户） |
| 测试验收入口 | `http://8.136.133.196:8090/` |
| ⚠️ nginx | 2026-06-17 已给 `bokejianji.cn` 配 HTTPS；部署前仍必须确认当前 nginx 配置，别信旧地址 |

---

## 当前待收口（按优先级）

> ✅ 2026-06-19 下午现状：正式域名、ICP备案、HTTPS、服务器稳定性、P0 导出/删除修复、H1 鉴权安全、接单台 P0 闭环、PDCA/简历/训练素材包、OSS 正式灰度、故障弹窗、技术债 T1/T2/T3/T6 均已上线。下面只剩真正未收口项。完整状态见 Obsidian `需求讨论/20260619开发执行单.md`、`需求讨论/20260619任务地图.md`。

| 优先级 | 事项 | 状态 |
|---|---|---|
| A | 🔴 H2 真短信 + 删除验证码后门 | **仍阻塞，等阿里云短信 Secret/运营商报备最终可用。** 2026-06-30 晚正式站登录 500 根因是 `.env` 里阿里云短信 key/签名/模板不完整，同时绿色验证码兜底为 0；已临时把正式站 `ALLOW_DEV_SEND_CODE_FALLBACK=1` 恢复，登录可用。后续拿到完整短信 Secret 后，先配测试站真机收码，再推正式并删 `devCode` 明文后门。 |
| A | 🟡 OSS 正式灰度·观察期 | 6/19 正式站已切 OSS（`STORAGE_BACKEND=oss / OSS_PREFIX=prod`），上传 storage=oss、签名下载 200、ffmpeg 可解码。**观察 1-2 天**：盯上传/转写/生成MP3/下载/ECS 带宽。注意 RAM key 当前**无 delete 权限**，测试对象暂留 `prod/uploads`。观察期是运维盯防，不是开发任务。 |
| A | 🔴 派单需求在剪辑页常驻可见 | 学员从接单任务进剪辑页后容易忘甲方需求。要做：剪辑页一键打开当前订单需求（目标时长/必须保留/必须删除/开头结尾/交付格式）。属剪辑台 `review.html`（+ 可能 `server.cjs` 读订单需求）。**只剩的真 P0。** |
| B | 🔴 磁吸复查 | 学员仍报"字删了、听起来还在"。先纯调查出结论：已收口 / 部分收口 / 未收口，要修只动 `review.html`。 |
| B | 🔴 问题反馈入口 | 审稿页加反馈入口，自动带项目名/页面名/用户信息+可上传截图。`review.html` + `server.cjs` 端点。 |
| B | ✅ 外部工具成品提交入口 | 2026-06-22 已修复粗剪后补交链路：接单提交粗剪进入待审核后，仍可补交/修改外部工具成品链接；粗剪快照和外部成品链接可同时保留，助教后台可同时看。Codex 复查发现“粗剪被打回后再补交外部成品，后台可能仍显示打回”的状态坑，已补修。 |
| B | 🟡 技术债剩余闸门 | T1 自动清理正式 cron（观察磁盘几天后再开，半夜别直接开）；T4/T5 删除段格式归一+后端校验**测试站小闸门已就绪，正式上线需真机双项目试听验收 + 当当拍板**。 |
| B | 🔴 公安备案盯防 | 金钱剪刀、传家宝、主体已提交锦江区网安大队待审。风险：公安主体个人 vs ICP 公司，可能退回重报。号下来后页脚加川公网安备号。属人工/控制台，非开发窗口。 |
| B | GitHub 恢复点 | day7 已推。后续每个大收口继续留恢复点。 |
| B | 浏览器侧操作卡顿 | 服务器侧导出卡死已根治；剪辑页点删除/气口缩短前端卡顿只缓解一部分，后续深优化。 |
| P2 | Day1 作业 AI 反馈 + 助教确认 | 训练体验增强，非交付阻断，最后做。 |

## 版本备份（改坏了退回哪）

| 备份点 | 位置 | 时间 |
|---|---|---|
| GitHub 分支 `day1`（开营第一晚全量） | `dangxiaoshi/money-scissors` 提交 `816432b` | 2026-06-13 |
| GitHub 标签 `开营前定稿版` | 提交 `47c3499` | 2026-06-12 |
| 服务器保险包 | `/opt/money-scissors-m2.releases/manual-*.tgz`（代码）；学员数据 `data/users.db` 不在包里，单独保护 | 每次上线前 |

**规则**：每收口一件事，存一个命名 GitHub 恢复点再继续；所有改动只走 本地→服务器 一条路，禁止直接改服务器文件。部署前后跑 `sh 剪辑台/web/scripts/check_sync.sh` 对账，确认本地/测试/正式三边一致。

## 最近完成

| 日期 | 事项 | 结果 |
|---|---|---|
| 2026-07-02 | 剪辑台搜索 + 新手引导正式上线，高亮改黄色 | 按当当要求把新手引导的蓝色视觉统一改为金黄色系：引导高亮框、卡片边框、步骤提示文字、按钮 hover、主按钮背景都改用现有 `--accent / --accent-deep / --accent-hover`，不改搜索命中黄色底逻辑和任何剪辑数据。已白名单单文件同步测试站和正式站 `review.html`，测试备份 `/root/nginx-backups/money-scissors-test-onboarding-yellow-20260702-172351/`，正式备份 `/root/nginx-backups/money-scissors-prod-onboarding-yellow-20260702-172634/`；正式站 sha256=`e00279164936ab47ffa6f7a41c05da088219a1326917afa5682392c88e89a62e`，`https://bokejianji.cn/api/health` 200。正式域名浏览器验收：新手引导高亮边框和下一步按钮为 `rgb(245, 166, 35)`，步骤文字为 `rgb(196, 125, 14)`；搜索框可见，搜索“剪辑”命中 `2/5`、共 5 条。 |
| 2026-06-30 | 剪辑台新手引导测试站完成（7/2 已推正式） | 基于搜索框定稿版 `review.html`，新增首次进入已转写审稿页自动弹出的 6 步新手引导，并在齿轮工具菜单增加“新手引导”手动入口：先看左侧大纲/剪辑决策，再按右侧逐字稿删减，第一遍整句整段粗剪，再处理口癖和气口，随后回听前后衔接，最后优先提交审核、MP3 只作备用留底或外部精修。引导只写浏览器本地 `moneyScissors.reviewOnboarding.v1.seen`，不改删除段、半句删除、金句、气口、导出/提交 payload 或项目保存内容；打开时搜索框仍可输入，搜索黄色命中和引导高亮区分。已白名单单文件同步测试站 `/opt/money-scissors-test/review.html`，备份 `/root/nginx-backups/money-scissors-test-onboarding-20260630-235301/`，测试站 sha256=`1f117f7e397ea2b38c46165b442a2a7585935afcecd93bc74c1c0462e39c3819`，health 200。本地验收：内联脚本语法 OK、`npm run check` OK、Chrome/Playwright 覆盖自动弹、跳过/完成后不再自动弹、齿轮菜单可重开、无剪辑决策和无口癖/气口兜底、桌面/窄屏/手机不遮挡搜索框和播放器，并重新跑搜索定位原清单通过。测试站冒烟：首次弹引导、搜索命中 `2/5 → 3/5` 且音频定位、完成后刷新不再自动弹、齿轮菜单可重开。Codex 窄审长时间未给结论已中止，未收到 P1/P2 发现。 |
| 2026-06-30 | 搜索定位句子测试站完成（7/2 已推正式） | 按当当拍板的“正文工具行右侧小输入框”方案，在剪辑页“剪辑模式/粗剪试听”同一工具行右侧新增 `输入关键词 + 放大镜` 搜索框；输入后显示命中序号、上一条/下一条、清空；命中句子高亮并定位音频到句首，搜索不写入项目状态、不影响删除/恢复/金句/导出。验证：内联脚本语法 OK、`npm run check` OK；本地 Chrome 桌面输入“剪辑”显示 `1/5`，下一条变 `2/5`，清空后高亮消失；搜不存在词显示“没有找到”且下一条禁用；粗剪试听不命中已删隐藏句；边搜边删后结果刷新，撤销后恢复；侧栏拉宽时按正文区域换行；手机宽度不挡播放器；Codex 复查无 P1/P2。2026-06-30 晚已随新手引导一起单文件同步测试站 `review.html`；2026-07-02 已随黄色高亮同步正式站，正式域名冒烟通过搜索命中。 |
| 2026-06-30 | 登录验证码 500 热修 | 学员和当当本人反馈登录不进去，页面报 `500 · /api/auth/send-code`。确认服务器健康、磁盘正常，根因是正式站 `.env` 短信配置不完整且绿色验证码兜底关闭，`sendSmsCode` 抛“短信配置不完整”。已备份正式 `.env` 到 `/root/nginx-backups/money-scissors-prod-login-devcode-restore-20260630-211729/.env.before`，临时恢复 `ALLOW_DEV_SEND_CODE_FALLBACK=1` 并重启 `money-scissors-m2`；同时备份 `users.db` 到 `/root/nginx-backups/money-scissors-prod-login-code-count-reset-20260630-211925/users.db.before`，清零 2026-06-30 的 3 条失败发送计数，避免已失败用户继续 429。内网和正式域名真实链路均验证：发送验证码 200、返回绿色码、用绿色码登录 200；今日 blockedPhones=0。真短信仍未收口，等完整阿里云短信 Secret 后再切换并删除绿色码后门。 |
| 2026-06-23 | 接单台转录失败全量回归收口 | 在 6/22 修复基础上，补测所有已知风险入口并确认正式站可用：老本地素材任务 2/6/7/11 全部转录 `SUCCEEDED`，阿里云收到的地址均已从 `/uploads/...` 变成 `https://bokejianji.cn/uploads/2026-06-21/...`；OSS 素材任务 12/13 也转录 `SUCCEEDED`，确认 `/api/orders/material/prod...` 仍走 OSS 签名，没有被相对路径修复误伤。回归 task_id：2=`7739f95c-71f1-4c3c-9694-705d99b029eb`，6=`bfa08db8-264b-4b87-8ded-c0eb6ba9a043`，7=`de12c24d-5f21-4fb9-a17b-f3ef7dbe6bfb`，11=`dc2be318-fdf1-4692-bb59-3f66b649495b`，12=`e66075b2-26b8-4230-8bd4-d7f6c2f3a329`，13=`0a9455d1-e587-4e67-858b-c94557ccaf1a`。经验沉淀已写入 Obsidian `项目/金钱剪刀/需求讨论/反馈与错误沉淀台账.md`，完成标准：代码上线、配置生效、测试/正式健康检查、老本地素材与 OSS 素材真转录成功、文档与日记留证。 |
| 2026-06-22 | 接单台老本地素材阿里云转录失败修复 | 学员反馈接单台任务音频导入逐字稿失败，截图显示 DashScope `subtask_status: FAILED` 且 `file_url` 是 `/uploads/2026-06-21/dispatch-order-live-20260615.m4a` 相对路径。确认根因：任务 2/6/7/11 是 6/21 挂上的老本地素材，前端从接单台带入剪辑台时传 `/uploads/...`，后端提交给阿里云前未补公网域名；阿里云无法拉取音频。已白名单同步测试站和正式站 `server.cjs`、`js/transcribe.js`，并把测试 `.env PUBLIC_BASE_URL` 改为 `http://8.136.133.196:8090`、正式改为 `https://bokejianji.cn`。修复：后端统一规范化 DashScope 音频地址，`/uploads/...` 自动补公网 URL，`/api/orders/material/...` 继续走 OSS 签名；前端失败提示不再裸露阿里云 JSON。验证：本地语法检查通过；Codex 复查指出 PUBLIC_BASE_URL 优先级问题，已补修；正式站小音频转录 `SUCCEEDED`，任务 6 大音频转录 `SUCCEEDED`，阿里云看到的 `file_url=https://bokejianji.cn/uploads/2026-06-21/dispatch-order-live-20260615.m4a`；测试/正式 health 200。最终 sha256：`server.cjs`=`a28f63135e0ab02d716bf62f9121d526c7324bc63cd6c2da679af7f7755edd47`，`js/transcribe.js`=`6865779b88a52dcd8fe04c2a1e6a375cede1790f87e7f9849b204c8657d17037`。备份：测试 `/root/nginx-backups/money-scissors-test-transcribe-url-fix-20260622-235220/`、`/root/nginx-backups/money-scissors-test-transcribe-url-fix2-20260623-000142/`；正式 `/root/nginx-backups/money-scissors-prod-transcribe-url-fix-20260622-235417/`、`/root/nginx-backups/money-scissors-prod-transcribe-url-fix2-20260623-000203/`。沉淀文档：Obsidian `项目/金钱剪刀/需求讨论/反馈与错误沉淀台账.md`。 |
| 2026-06-22 | 说话人身份纠正上线 | 学员反馈“瑶瑶是嘉宾”，截图显示播客主/嘉宾默认身份可能标反。确认根因：旧规则容易按说话人顺序默认命名，遇到“某某你好/欢迎某某”等开场会把打招呼者和被问候者弄反。已白名单同步测试站和正式站 `js/main.js`、`review.html`：新上传项目会优先根据开场问候线索判断播客主/嘉宾；无法判断时显示“说话人1/2”而不是硬猜；已生成的老项目首次打开时也会在用户未手动改名的前提下按开场问候矫正显示名；剪辑分析提示词禁止按顺序猜身份；审稿页左侧说话人列表新增“点名字改名”入口，顶部和左侧改名共用保存逻辑。验证：本地 `node --check js/main.js`、`npm run check`、审稿页内联脚本解析通过；模拟“瑶瑶你好”映射为打招呼的人=播客主、回应者=瑶瑶；测试/正式 health 200，本地/服务器/公网两文件 sha256 一致。最终 sha256：`main.js`=`939c735492df5da62bf1df3f6d9dc420410503348bdafcc8e87950c5adf7914e`，`review.html`=`c4af81f7aec2c0a8d42a8ac436ed3799d28c4d54c265e8a02c16e24079728f2e`。备份：测试 `/root/nginx-backups/money-scissors-test-speaker-role-20260622-204933/`；正式 `/root/nginx-backups/money-scissors-prod-speaker-role-20260622-205011/`。 |
| 2026-06-22 | 接单台粗剪后补交外部成品入口修复 | 学员反馈“只提交粗剪后没有提交成品入口”。确认根因：接单状态进入 `submitted/待审核` 后，旧规则隐藏外部成品入口，且粗剪快照与外部成品链接会互相覆盖。已白名单同步测试站和正式站 `server.cjs`、`orders/index.html`，重启 `money-scissors-test` / `money-scissors-m2`；现在待审核订单仍显示“补交成品/修改成品提交”，保存时不再清掉粗剪或外部链接。Codex 复查后补修：粗剪被打回后再补交外部成品，助教后台按接单新状态显示待审核，不再被旧粗剪快照的打回状态压回去。测试/正式 health 200；本地/测试/正式两文件 sha256 一致。备份：测试 `/root/nginx-backups/money-scissors-test-order-final-submit-20260622-173053/`、`/root/nginx-backups/money-scissors-test-order-final-submit-reviewfix-20260622-175525/`；正式 `/root/nginx-backups/money-scissors-prod-order-final-submit-20260622-173135/`、`/root/nginx-backups/money-scissors-prod-order-final-submit-reviewfix-20260622-175544/`。 |
| 2026-06-21 | 四场直播课派单素材补齐 | 正式站只更新数据和素材，未改代码、未重启服务。已上传开营直播、派单直播、复盘直播、对接直播 4 个 m4a 到 `/uploads/2026-06-21/`，sha256 与本地一致；派单页 #2 开营直播、#6 派单直播、#7 复盘直播均改为直连音频，新增 #11 对接直播订单｜播客主剪辑手对接。四个下载链接均 HTTP 200，学员端 `/api/orders/tasks` 用真实 Day2 账号口径读到 4 条；正式 health 200。数据库备份：`/root/nginx-backups/money-scissors-prod-live-audio-links-20260621-181736/`。 |
| 2026-06-19 | 训练台作业 + OSS 灰度 + 故障弹窗 + 技术债 T1/T2/T3/T6 一批上线 | PDCA 复盘作业卡、剪辑师简历模板（均可填写提交，助教后台多 `PDCA`/`简历` 列）、训练素材包（FAQ/视频转 MP3）推正式；复盘直播改 B 站回放。OSS 正式站灰度切换（`STORAGE_BACKEND=oss/OSS_PREFIX=prod`，上传 storage=oss、签名下载 200，观察 1-2 天，RAM key 无 delete 权限）。服务器故障弹窗推正式（`js/api.js`+`server-trouble.jpg`，断网才弹）。审核后台序号乱+打回跳转 bug 修复推正式。技术债：T1 自动清理脚本（上两站，手动真清理正式回收 1.65GB，仅测试站配 dry-run cron）、T2 ffmpeg/ffprobe 硬超时、T3 任务中断 410 提示、T6 自动哨兵脚本（均上两站）；T4/T5 删除段归一+后端校验仅测试站小闸门。备份见各日记条目。 |
| 2026-06-19 | 接单台五条派单 + 订单审核 P0 推正式站 | 已将 8090 验收通过的接单台 P0 推正式站，只同步 `server.cjs`、`orders/index.html`、`orders-admin.html`、`orders-review-admin.html`、`lib/oss.cjs`，并备份正式代码与 `users.db` 到 `/root/nginx-backups/money-scissors-prod-dispatch-p0-20260619-085725/`。正式库原本只有 #1-#5，新五条显式落为 #6 第二课、#7 第三课、#8 墨十三私密单、#9 Elainmmm 私密单、#10 熊豆芽公开单；第三课与熊豆芽素材已放正式站 `/uploads/2026-06-19/`，第二课挂腾讯会议链接。正式 health 200，PM2 `money-scissors-m2` online，unstable restarts=0；本地/正式 5 文件 sha256 一致。 |
| 2026-06-18 | OSS 下载阻断方案推测试站（正式站未动） | 接手另一窗口 token 中断后的 OSS 迁移，补齐前端最小 `storage/objectKey` 传递并修复 `/codex review` 指出的问题：不同 cut 任务不再错接、`money-scissors-private/` 和 `web/data/cut-jobs/` 已 gitignore、旧 OSS 项目重开会重新签播放链接、OSS 上传流边传边限 500MB、本地多音频不再被误判成 OSS、接单任务 OSS 素材改为稳定入口。测试站备份：`/root/nginx-backups/money-scissors-test-oss-frontend-20260618-203001`、`/root/nginx-backups/money-scissors-test-oss-fix-20260618-204812`、`/root/nginx-backups/money-scissors-test-oss-order-material-20260618-212324`。真接口回归通过：上传 objectKey=`test/uploads/...`，转写 `SUCCEEDED`，旧项目重开返回新 OSS 签名链接，重复 cut 续接同 job，不同 cut 返回 `cut_user_busy`，下载 302 到 `test/cut/...` 且 OSS HTTP 200；接单任务材料入口 `/api/orders/material/...` 可 302 到 OSS、DashScope 转写成功、备用 MP3 生成后下载 302 到 `test/cut/...`。测试/正式 health 均 200；正式 `.env` 无 `STORAGE_BACKEND/OSS_PREFIX`。 |
| 2026-06-16 | H1 鉴权默认安全修复推正式站 | 已把 `server.cjs` 的鉴权开关从旧逻辑 `AUTH_DISABLED !== '0'` 改为安全默认 `AUTH_DISABLED === '1'` 并推正式站：漏配环境变量时默认锁上，只有显式写 `AUTH_DISABLED=1` 才关闭鉴权；同时加启动红字警告，避免无声裸奔。正式站 `.env` 本来就是 `AUTH_DISABLED=0`，所以线上行为不变。只动正式站 `server.cjs`，未碰接单台、未动数据库。备份：`/root/nginx-backups/money-scissors-prod-auth-default-fix-20260616/server.cjs.before-auth-default`。验证：正式站文件 hash=`3b582c7bd9a4c1e82ae0f50640cbb9aa3c7cfba13d2aec21aee3aed9bc56a16e`，内网/公网 health 200，未登录 `/api/admin/users` 和 `/api/projects` 均 401；错误日志无新增异常（旧 `ERR_INVALID_URL` 日志停在 08:28）。Codex 窄审 H1 diff：未发现安全/鉴权回归。 |
| 2026-06-16 | 🔴 服务器卡死根治 + 「删了还播放」修复全部上线 | 今日两次服务器卡死(早上Day4集中导出、下午正式站旧代码又被拖死)。**根因**:ECS仅2核1.6G无swap;导出/精修用ffmpeg满核裸跑,无nice降优先级、无线程限制,且两套队列(CUT导出/REFINE精修)并发各默认2 → CPU100%被吃满,sshd/nginx全饿死=全员卡死只能硬重启。**根治(server.cjs)**:三处ffmpeg(2552单文件导出/2801拼接导出/**3017音频精修**)全部加 `nice -n 19 -threads 1`;`CUT_MAX_ACTIVE_JOBS`和`REFINE_MAX_ACTIVE_JOBS`默认值都从2改1(写进代码默认值随部署走);服务器加2G swap写进fstab。**实测**:50分钟开营直播导出全程ffmpeg NI=19吃94%CPU,网页health一路200/0.003s,满载不卡死。**「删了还播放」根因**:`mergeDeletionRanges`返回对象`{start,end}`,第一次合并后整句/半句删除成对象数组,第二次合并旧版只认数组下标→全丢只剩气口;修法是让merge兼容数组+对象两种格式(review.html约2864行)。**端到端验收**:真导出3008s→2957.436s,算法口径2957.5s,差0.06s。本地/测试/正式48文件全量对账完全一致。备份:server.cjs正式 `/root/nginx-backups/money-scissors-prod-ffmpeg-nice-20260616/`、review.html正式 `/root/nginx-backups/money-scissors-prod-deletefmt-fix-20260616/`。⚠️SSH必须带钥匙:`ssh -i ~/.ssh/money_scissors_ecs root@8.136.133.196`。阶段四(数据入口归一化两种格式的债+自动哨兵)留待以后。 |
| 2026-06-16 | 剪辑台左侧剪后时长偏短修复上线 | 学员截图反馈左侧显示 `50:00 → 17:25`，但实际剪辑下来超过 25 分钟。查正式站真实项目 `开营直播(7).m4a`（`proj_bbd213d8b5934a12977d`）确认：服务器保存的真实粗剪时长是 `2047s / 34:07`，旧左侧显示算法按删除句/半句/气口简单累加会算成 `1046s / 17:26`，与截图吻合。根因是左侧预估仍用旧的简单累加口径，而导出/保存指标已用真正导出切段口径，两个算法分叉。已只改 `review.html`：左侧剪后时长、删减时长、粗剪试听总时长、试听进度条、播放跳过逻辑统一使用 `currentExportDeleteSegments()`；试听拖动时按粗剪时间映射回原音频位置；左侧摘要从“共删除”改为“删减内容主要包括”，避免粗略分类被误读成精确总时长。未跑整包同步、未重启服务、未动数据库。语法检查通过。验证：本地/测试服务器/正式服务器/测试公网/正式公网 `review.html` sha256 均为 `cb9bda69e6808a84e3bdecf6c38095df0f626cc54dc39c485e960cdd37e5c00b`，测试和正式 health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-review-duration-sync-20260616-115821/review.html.before-duration-sync`；正式备份：`/root/nginx-backups/money-scissors-prod-review-duration-sync-20260616-115821/review.html.before-duration-sync`。 |
| 2026-06-16 | 剪辑台恢复文字后音频仍跳过修复上线 | 学员补充录屏并强调声音问题：AI 默认删掉的内容手动恢复后，文字显示恢复，但试听时音频仍会自己跳过去。听录屏确认她说的是“文字恢复了，但听音频没有恢复”。根因判断：先执行 `气口缩短/缩短全部` 时，如果中间句子当时仍处于删除状态，旧气口切段可能跨过这些句子；之后恢复文字时，旧气口切段仍留在 `editState.breath.items`，预览播放遇到该切段继续跳过。已只改 `review.html`：每次重绘/载入旧项目时自动检查气口切段，只要切段覆盖当前保留的词音频，就移除该失效气口切段，确保“文字恢复=声音恢复”。只同步测试站和正式站 `review.html`，未跑整包同步、未重启服务、未动数据库。脚本语法检查通过。验证：本地/测试服务器/正式服务器/测试公网/正式公网 `review.html` sha256 均为 `f1e6df5f0b1b04686238f108743bbc1c6a7fdbd68c045fc47ff12346e5324181`，测试和正式 health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-breath-restore-sync-20260616-093823/review.html.before-breath-restore-sync`；正式备份：`/root/nginx-backups/money-scissors-prod-breath-restore-sync-20260616-093823/review.html.before-breath-restore-sync`。 |
| 2026-06-16 | 剪辑台延迟与恢复试听修复上线 | 学员反馈 `删除选中`、`气口缩短` 有 2-3 秒延迟，以及 AI 预删灰色内容恢复后不知道音频是否同步。已只改 `review.html`：气口候选由逐句重复计算改成每次页面刷新只算一次；预览播放中的删减统计和删除段复用缓存，避免播放时反复重算；半句/整句恢复后自动把播放器位置拉回恢复段前 0.3 秒，方便立刻试听；半句恢复也接入撤销栈。只同步测试站和正式站 `review.html`，未跑整包同步、未重启服务、未动数据库。Codex 复查未发现回归；脚本语法检查通过。验证：本地/测试服务器/正式服务器/测试公网/正式公网 `review.html` sha256 均为 `74b377988497535180a2ab87a94c28bb613ab68ce05fcff68c005447bd0c0558`，测试和正式 health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-review-lagfix-20260616-093038/review.html.before-lagfix`；正式备份：`/root/nginx-backups/money-scissors-prod-review-lagfix-20260616-093038/review.html.before-lagfix`。 |
| 2026-06-15 | 气口单个缩短/恢复推测试站+正式站 | 当当对标播记/喜马拉雅后指出气口需要支持单个处理和恢复。已补齐：正文灰色 `气口 1.8s` 标签点一下单个缩短，变成浅绿色 `气口 已缩短`；再点一下恢复；右上角撤销/前进可回退；左侧上下箭头可在已缩短和未缩短气口之间定位；「缩短全部」仍只处理未缩短的气口。只同步 `review.html` 到测试站和正式站，未跑整包同步、未重启服务、未动数据库。验证：本地/测试服务器/正式服务器/测试公网/正式公网 `review.html` sha256 均为 `a312e729abcf27055b5ef1cd3e92283495a9928276f70b27a5e651e9cbc74138`，测试和正式 health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-breath-toggle-20260615-220145/review.html.before-breath-toggle`；正式备份：`/root/nginx-backups/money-scissors-prod-breath-toggle-20260615-220145/review.html.before-breath-toggle`。 |
| 2026-06-15 | 气口缩短功能推测试站+正式站 | 当当确认“加气口”先不做，本窗口先上线已完成的缩短气口。已只同步 `review.html` 到测试站 `/opt/money-scissors-test/review.html` 和正式站 `/opt/money-scissors-m2/review.html`，未跑整包同步、未重启服务、未动数据库。功能口径：气口放在「口癖」面板下方，默认检测 `＞1.5s`，支持 `＞2s/＞3s`、上下定位和「缩短全部」；每个长气口保留 `0.3s`，保存到 `editState.breath`，导出/提交审核时并入删除段。验证：本地/测试服务器/正式服务器/测试公网/正式公网 `review.html` sha256 均为 `1624384fd0e0f5a5f599f50abae4993c83b0f0194dfb3270f40ab9e363dabe99`，测试和正式 health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-breath-20260615-215526/review.html.before-breath`；正式备份：`/root/nginx-backups/money-scissors-prod-breath-20260615-215526/review.html.before-breath`。 |
| 2026-06-15 | D4 派单直播回放链接上线 | 当当确认 D4 派单直播和 D1 开营直播一样，只作为训练台课程回放入口，不当剪辑素材上传。已将 `training/path.html` 的 D4 按钮从“进入直播”改为“看直播回放”，链接指向腾讯会议录制 `https://meeting.tencent.com/crm/2YAgx09372`。按白名单单文件同步测试站和正式站，未跑整包同步、未重启服务、未动数据。测试/正式服务器与公网 `training/path.html` md5 均为 `f729d12c32acd32da22dab609110d18d`，health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-d4-replay-20260615-202203/`；正式备份：`/root/nginx-backups/money-scissors-prod-d4-replay-20260615-202230/`。 |
| 2026-06-15 | 学员接单台首页推 8090 测试站 | 按当当拍板的训练台首页风格，先改学员端 `orders/index.html`：顶部“今天先接 1 单”、两排“今日可抢 / 我的任务”、轻规则文案“先抢资格，采用才发钱”。本轮只做前端表达，未动助教后台、未改后端抢单状态机、未推正式站。已白名单单文件同步测试站 `/opt/money-scissors-test/orders/index.html`，本地/服务器/公网 `/orders/` sha256 一致，测试 health 200。测试站旧页备份：`/root/nginx-backups/money-scissors-test-orders-student-20260615-184531/index.html.before-student-orders`。 |
| 2026-06-15 | 口癖功能推 8090 测试站 | `feat-koupi` 的 `review.html` 已白名单单文件同步到测试站 `/opt/money-scissors-test/review.html`，未动正式站、未跑整包同步。公网 `http://8.136.133.196:8090/review.html` 与本地 sha256 一致，测试后端 health 200。测试站旧页备份：`/root/nginx-backups/money-scissors-test-koupi-20260615-145037/review.html.before-koupi`。待当当真账号真项目验收：左栏 Tab、口癖标记/跳转/单删/全删、⌘Z 撤销、⌘⇧Z 前进、导出与提交审核不受影响。 |
| 2026-06-15 | 口癖检测“看得到但数成 0”修复推 8090 | 学员在测试站看到正文已有灰虚线口癖词，但左栏计数是 0，点跳转/一键全标删还弹“没有检测到口癖”。已在 `review.html` 增加 DOM 兜底：数据态若临时为空，就直接从页面已渲染的 `.kp` 标记回捞口癖列表，保证“看得到就数得到、跳得到、删得到”。本地语法检查通过，并做了模拟验证：当数据返回 0、页面有两个 `.kp` 时，能正确回捞去重。已白名单覆盖测试站，三边 sha256 一致；备份：`/root/nginx-backups/money-scissors-test-koupi-fix-20260615-145555/review.html.before-dom-fallback`。正式站未动。 |
| 2026-06-15 | 口癖检测根因修复推 8090 | 真根因不是缓存，而是练习项目逐字稿的 `w[]` 不是“一词一项”，很多是一整大段文本；旧算法只会在整段文本“完全等于 口癖词”时命中，所以像 `就是我们明天和后天的内容就是` 这种肉眼两处“就是”会被算成 0。已改成“块内子串扫描 + 按字符比例插值时间”：在每个 `w[i].t` 内查找多个口癖词出现位置，换算成句内字符区间和近似时间，半句删仍可复用。用开营直播母版实测，截图所在句能命中 2 个“就是”，整份素材共命中 270 个。已白名单覆盖测试站，三边 sha256 一致；备份：`/root/nginx-backups/money-scissors-test-koupi-fix2-20260615-150301/review.html.before-substring-scan`。正式站未动。 |
| 2026-06-15 | 口癖点击误删整块修复推 8090 | 当当验收发现：点击大段里的“就是”时，系统把它所在的整块文字（如“下周一的话就是会给大家讲解...”）都划掉，而不是只删“就是”两字。根因：渲染已能标出块内子串，但点击仍只传 `idx + wi`，删除函数按整个 `w[i]` 块写入 `pdel`。已给每个 `.kp` span 带上精确 `cs/ce/s/e`，点击、逐个跳转、一键全标删都改用命中自身边界。用开营直播母版验证：一个 13 字长 chunk 内的“就是”只生成 2 字删除区间。已白名单覆盖测试站，三边 sha256 一致；备份：`/root/nginx-backups/money-scissors-test-koupi-fix3-20260615-150949/review.html.before-precise-koupi-delete`。正式站未动。 |
| 2026-06-15 | 口癖功能推正式站 | 当当验收 8090 后确认其他没问题，只要求词库设置默认展开。已把 `kp-lib` 初始状态改为 `display:block`、箭头改为 `▾`，并将同一份 `review.html` 白名单同步测试站和正式站。未跑整包同步，未重启服务。测试站/正式站/公网 `review.html` sha256 全一致，health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-koupi-final-20260615-151323/review.html.before-koupi-final`；正式备份：`/root/nginx-backups/money-scissors-prod-koupi-final-20260615-151323/review.html.before-koupi-final`。 |
| 2026-06-15 | 片头制作/金句 MVP 推 8090 测试站 | 在口癖正式收口后的 `feat-koupi` 基线上，新增 `opening.html`，并改 `review.html`：框选正文后浮层提供“删除选中 / 加入片头”；加入片头按选区精确 `cs/ce/s/e` 保存到 `editState.intro`，正文金黄底标记，顶栏显示“片头制作 N”。片头页支持金句列表、拖动排序、移出、超过 5 条软提醒，并导出到现有 `cut.html` MP3 流程（`goldenSegments + 当前删除段`，音乐/开场白仍为第二步占位）。只同步测试站 8090，未动正式站；公网 `review.html`、`opening.html` 与本地 sha256 一致，测试 health 200。测试备份：`/root/nginx-backups/money-scissors-test-opening-20260615-153426/review.html.before-opening`。 |
| 2026-06-15 | 片头浮层样式修正推 8090 | 当当指出选区浮层里“删除选中”和“加入片头”不能同时高亮。根因是从单按钮扩展为双按钮后，保留了 `#selbtn:hover` 容器整体橙色 hover，导致两个动作一起亮。已改为容器保持深色，删除按钮仅白字/轻 hover，加入片头按钮单独金色。只同步测试站 8090，正式站未动；公网 `review.html` 与本地 sha256 一致，测试 health 200。备份：`/root/nginx-backups/money-scissors-test-opening-popover-20260615-154051/review.html.before-popover-style`。 |
| 2026-06-15 | 片头页轻流程推 8090 | 当当拍板金句/片头生成流程减重：片头页只做金句排序和移出，点“完成，返回剪辑”回主审稿页；MP3 统一在主页面点“生成 MP3”，避免片头页堆太多功能。已改 `opening.html` 去掉独立导出按钮和 `cut.html` 跳转；`review.html` 的主导出读取 `editState.intro` 作为前置金句段，且新片头页暂不自动加音乐（音乐/开场白仍第二步）。同时修正双按钮浮层按真实宽度居中，并移除选区计算里多余的撤销入栈。只同步测试站 8090，正式站未动；公网 `review.html`、`opening.html` 与本地 sha256 一致，测试 health 200。备份：`/root/nginx-backups/money-scissors-test-opening-return-20260615-155248/`。 |
| 2026-06-15 | 片头页轻流程推正式站 | 当当验收 8090 后确认可以上线。已白名单同步正式站 `/opt/money-scissors-m2/review.html` 和 `/opt/money-scissors-m2/opening.html`，未跑整包同步，未重启服务，未动数据库。正式站 `review.html` 本地/服务器/公网 sha256 一致；`opening.html` 本地/服务器一致，公网重试后 sha256 一致（首次 curl 偶发 5s 连接超时）；正式 health 连续 200。正式备份：`/root/nginx-backups/money-scissors-prod-opening-return-20260615-162720/`。 |
| 2026-06-15 | 审稿页右上角极简顶栏推 8090 | 当当拍板右上角改成极简：外部只留 `↶` 撤销、`↷` 前进、`⚙` 工具、橙色 `提交审核`。齿轮菜单内收纳 `片头金句`、`保存`、`生成 MP3`、`提交说明`，下方保留音频精修选项；保存按钮不再占顶栏状态小字，点击后只用按钮短状态 + toast 反馈。撤销/前进接现有 `kpUndo/kpRedo/kpCanUndo/kpCanRedo`，无历史时置灰；生成 MP3 与提交审核仍独立。只同步测试站 8090，正式站未动；本地/服务器/公网 `review.html` sha256 一致，测试 health 200；浏览器检查确认顶栏与齿轮菜单内容正确。备份：`/root/nginx-backups/money-scissors-test-topbar-tools-20260615-165439/`。 |
| 2026-06-15 | 顶栏撤销前进 emoji 微调推 8090 | 当当希望撤销/前进用 emoji 风格表达。已将顶栏图标从 `↶/↷` 换成 `↩️/↪️`，仅改显示字符，逻辑不变。只同步测试站 8090，正式站未动；本地/服务器/公网 `review.html` sha256 一致，测试 health 200。备份：`/root/nginx-backups/money-scissors-test-topbar-emoji-20260615-170118/`。 |
| 2026-06-15 | 审稿页右上角 emoji 顶栏推正式站 | 当当确认齿轮也用 emoji，并要求上线。已将顶栏改为 `↩️`、`↪️`、`⚙️`、`提交审核`，齿轮菜单和所有逻辑不变。先同步测试站 8090 并对账，再白名单同步正式站 `/opt/money-scissors-m2/review.html`；未跑整包同步、未重启服务、未动数据库。测试站和正式站本地/服务器/公网 `review.html` sha256 均一致，health 均 200。测试备份：`/root/nginx-backups/money-scissors-test-topbar-gear-emoji-20260615-170523/`；正式备份：`/root/nginx-backups/money-scissors-prod-topbar-emoji-20260615-170556/`。 |
| 2026-06-14 | 🔴 修复「导出误删保留内容」P0（学员报中间大段消失/文字音频对不上） | 根因：审稿页 `doExport` 把「间隙<1.5s」相邻删除合并，吞掉学员保留内容，密集删口癖时连成大段。修法：合并阈值 `1.5→0.08`(`MERGE_GAP`)。**确认是老bug非今天引入**（6/12旧版同一行一致，最早受影响6/11，今天D2/D3密集精剪才暴露）。真实数据双验：受影响学员旧导1259s→新1307s找回47.8s；删得少学员旧=新=2893.968s零回归。review.html 推测试站+正式站三边一致，静态页未重启。备份 `/root/nginx-backups/money-scissors-mergegap-fix-20260614/`。对比音频在测试站 `/uploads/verify-fix/`。受影响26人/30.9分钟，名单待通知。 |
| 2026-06-14 | 盖盖子（藏功能不删码）+ 3修复推正式站 | `SHOW_GOLDEN=false`(星标★/AI推荐金句/导出片头音乐一条链)、`SHOW_AI_REVIEW=false`(后台AI批改)；「重新提交审核」保留。#7点字只定位/#12看稿不自动上跳/咔哒声淡变 推正式站(白名单5文件:review/server/cut.js/admin.html/admin.js)，重启m2，三边一致，真机验收。备份 `manual-20260614-1530-before-3fixes-coverlid.tgz`。想恢复藏起来的功能：对应 `false→true`。 |
| 2026-06-14 | 审稿页"页面自动往上跳"修复（学员反馈#12） | 已只同步测试站 8090 `review.html`。把"逐字稿跟随播放"从 12 秒定时宽限改成布尔开关 `autoFollowTranscript`：用户手动滚动（滚轮/触摸/滚动条/方向键）即停止跟随，只有主动点句子/切段落/点定位/按播放才恢复跟随，阅读时不再被拉回正在播放的句子。点文字不强制播放（#7）本地源 `goTo` 早已是只定位不续播，无需再改。语法检查通过；`/codex review` 聚焦审查跟随状态机=无 P1/P2；测试站 8090 `review.html` 与本地 md5 一致、HTTP 200、体积 124444 字节一致。测试站旧页备份：`/root/nginx-backups/money-scissors-test-followscroll/review.html.20260614-084749`。**正式站未动**，待当当在 http://8.136.133.196:8090/ 试听验收后再决定是否推正式。静态页，未重启服务。 |
| 2026-06-13 | 三边对账 + 测试站补齐 | 本地/正式站 27 个改动文件指纹全部一致；测试站落后的 `review.html`、`training/path.html` 已补同步（备份在 `/root/nginx-backups/money-scissors-test-catchup/`）。新增对账命令 `scripts/check_sync.sh`。 |
| 2026-06-13 | 剪辑台批次0/4/5推测试站 | 8090 测试站已部署：咔哒声 v2 淡变、后台 AI 批改、金句星标/AI推荐/导出前置、重新提交文案、审稿页点文字不自动播放、过渡音乐 `/assets/music/intro-default.mp3`。正式站未动。测试站备份：`/root/nginx-backups/test-goldcut-20260613-212015/`；Codex 复查后补丁备份：`/root/nginx-backups/test-goldcut-followup-20260613-2146/`。已修复 Codex 指出的金句删除残留、音乐素材忽略、金句半句删减、提交时长、AI批改半删提示、HTTP 复制兜底。本地和测试站语法检查通过；服务器导出验证：金句+音乐+正文 58.84s，无金句旧流程 42s；页面验证：星标持久化、暂停点文字不自动播放、删除金句会清星标。待当当本人在 8090 试听/验收后再决定是否推正式。 |
| 2026-06-12 | 三台顺序解锁上线 | 登录进训练台，Day1 解锁剪辑台，Day2 提交助教审核解锁接单台；测试站和正式站真实登录 API 复测通过，后台可见 D1/D2。 |
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

Obsidian 项目入口：`/Users/dang/Library/Mobile Documents/iCloud~md~obsidian/Documents/dangxiaoshi/项目/金钱剪刀/00_金钱剪刀文档入口.md`

| 想知道什么 | 翻哪个文件 |
|---|---|
| 文档导航、每类文档该看哪里 | `00_金钱剪刀文档入口.md` |
| 当前需求、反馈、bug 状态 | `需求讨论/需求与反馈总台账.md` |
| 这一步做了什么、为什么这么改、怎么回滚 | `开发日记/开发日记.md` |
| 旧需求文档和旧执行清单 | `需求讨论/归档/2026-06/` |
| 当时的原始记录、全文搜原话 | `开发日记/开发日记原文归档.md`（168KB，只在前几个不够时再翻） |
| 当当的规划和思考 | `开发日记/当当规划和思考口语.md` |

---

> **维护规则**：每次有重要进展（部署了什么、收口了哪项、风险变化），先更新本文件的"当前待收口"和"更新"日期，再去写详细日记。让本文件永远是最新现状的单一入口。
