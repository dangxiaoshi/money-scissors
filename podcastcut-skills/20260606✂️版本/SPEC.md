# 金钱剪刀 💰✂️ — 网页版需求文档（M1）

> 给 Codex / 任何独立开发者执行的完整规范。读完这一份就能开始写代码。

---

## 0. 一句话目标

把现有的本地 Claude Code 工具 `podcastcut-skills` 砍出前 4 个阶段（转录 → AI 分析 → 审查 → 剪辑成品 MP3），做成一个纯静态网页，部署到 GitHub Pages，给 50-200 名付费学员使用。

后续阶段（音质处理、降噪、片头片尾、高光提取）**不做**，让学员下载成品 MP3 后用 Audition / 剪映 / Logic 自行处理。

---

## 1. 项目背景

### 当前工具
- 路径：`/Users/dang/Documents/podcastcut-skills/`
- 形态：Claude Code Skills（`/podcastcut-剪播客` 等命令）
- 依赖：Node.js + Python + ffmpeg + 阿里云 FunASR + Claude
- 完整流程：`剪播客/SKILL.md`（必读）

### 网页版定位
- **纯前端、零服务器、零构建步骤**（参考 `https://dangxiaoshi.github.io/jianji/`，整站就一个 HTML 文件）
- 部署到 `https://dangxiaoshi.github.io/<repo>/`
- API Key **M1 写前端**（开营前再迁 Cloudflare Workers，不在本次范围）

### 目标用户
- 50-200 名付费学员（已有微信群）
- 桌面浏览器为主（Chrome / Safari / Edge），手机不强求
- 上传 30 分钟 - 2 小时的播客音频，10-20 分钟内拿到剪辑成品 MP3

---

## 2. 已有资产

| 文件 | 状态 | 用途 |
|---|---|---|
| `web/index.html` | ⚠️ 旧稿，与方案不符，**需重写** | 入口页（之前误做成 jianji 复刻文本决策版，要废掉重做成"上传音频"形态） |
| `web/review.html` | ✅ 视觉已完成（jianji 风格） | 审查页，CSS 1-545 行已重写，HTML 结构和 JS 全部保留。**数据通过 JS 变量 `S` `BLK` `CHAPS` 注入**（见 `review.html:684-690`） |
| `剪播客/SKILL.md` | ✅ 流程权威文档 | 必读，理解完整业务逻辑 |
| `剪播客/scripts/aliyun_funasr_transcribe.sh` | ✅ 阿里云 API 调用参考 | 提供完整的提交+轮询代码，**重写为浏览器 fetch 即可** |
| `剪播客/scripts/generate_subtitles_from_aliyun.js` | ✅ Node 脚本，可移植 | 把阿里云原始转录 JSON 转成 `subtitles_words.json`，逻辑可直接搬到浏览器 |
| `剪播客/scripts/identify_speakers.js` | ✅ Node 脚本，可移植 | 列出前 20 句让用户标说话人姓名 |
| `剪播客/scripts/generate_sentences.js` | ✅ Node 脚本，可移植 | 从词级转录生成句子级 `sentences.txt` |
| `剪播客/scripts/run_fine_analysis.js` | ✅ Node 脚本，可移植 | 精剪规则层（填充词/卡顿/重复等纯算法） |
| `剪播客/基础剪辑规则/*.md` | ✅ AI prompt 来源 | 粗剪/精剪的检测方法论，DeepSeek 调用时作为 system prompt |
| `剪播客/基础剪辑规则/LLM精剪prompt模板.md` | ✅ AI prompt 来源 | 精剪 LLM 层的完整 prompt |
| `剪播客/templates/review_roughcut.html` | ❌ 不要改 | 原版审查页模板（旧风格），保持原样不动 |

### 关键发现
- `web/review.html` 第 684 行 `const S = [...]` 就是数据注入点；BLK、CHAPS 紧随其后。**Codex 不需要重写审查页，只需要在跳转前把分析结果序列化进这三个变量**。
- 阿里云 FunASR 已经在 bash 脚本里跑通，端点和参数照搬即可。
- 字幕生成、句子分割、规则层精剪都是纯 JS（无 Node 特有 API），可直接复制粘贴到浏览器。

---

## 3. 完整流程图

```
┌──────────────────────────────────────────────────────────────────┐
│  index.html （入口页）                                            │
│  ─ 上传 mp3/wav/m4a                                              │
│  ─ 填写：说话人数（2-10）                                         │
│                                                                  │
│  「开始」                                                         │
└──────────────────────┬───────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────────┐
│  progress.html / 同页 step view （处理页）                        │
│                                                                  │
│  Step 1  上传到 uguu.se → 拿公网 URL              ~10s          │
│  Step 2  阿里云 FunASR 提交转录任务 → 轮询         3-15min      │
│  Step 3  让用户标说话人姓名（前 20 句弹窗）        用户输入      │
│  Step 4  生成 subtitles_words.json + sentences    瞬时          │
│  Step 5  DeepSeek 粗剪分析（5a）                  1-3min        │
│  Step 6  DeepSeek 精剪分析（5b，分批）            2-5min        │
│  Step 7  规则层精剪合并                            瞬时          │
│  Step 8  数据注入 review.html 并跳转                              │
└──────────────────────┬───────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────────┐
│  review.html （审查页，已完成）                                   │
│  ─ 编辑/恢复删除、调整说话人、试听                                │
│  ─ 「导出」→ 触发剪辑                                             │
└──────────────────────┬───────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────────┐
│  cut.html / 同页 modal （剪辑页）                                │
│  ─ 加载 ffmpeg.wasm（首次 ~30MB）                                │
│  ─ 读取原始音频 + delete_segments_edited.json                    │
│  ─ 浏览器内剪辑 → 生成成品 MP3                    3-8min         │
│  ─ 自动下载 / 提供下载链接                                        │
│  ─ 提示："后期降噪、加片头片尾请用 Audition / 剪映 / Logic"      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. 详细功能规范

### 4.1 入口页（`web/index.html`，重写）

**视觉风格**：完全对齐 `web/review.html` 的 jianji 风格（#fafafa 底 / #ffffff 卡片 / #F5A623 橙 / SF Pro / 16px 圆角 / 柔和阴影）。可复用 `web/review.html` CSS 变量。

**UI 结构**（参考 jianji 但适配播客剪辑）：

```
┌─────────────────────────────────────────────┐
│  金钱剪刀 💰✂️                              │
│  AI 帮你剪播客，10 分钟出粗剪               │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ 上传音频 ─────────────────────────┐    │
│  │  🎙️                                │    │
│  │  点击或拖拽 mp3 / wav / m4a       │    │
│  │  最大 500MB                       │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  说话人数  [  2  ]                          │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │       开始处理（橙色按钮）          │    │
│  └─────────────────────────────────────┘    │
│                                             │
└─────────────────────────────────────────────┘
```

**字段验证**：
- 文件类型：仅 `audio/*`
- 文件大小：< 500MB（超过提示"请压缩或裁剪后上传"）
- 说话人数：2-10 整数

**点击「开始处理」后**：
- 把文件、说话人数存到内存（File 对象 + state）
- 跳转或切换到处理视图（推荐**单页应用，用 div 切换**，避免页面跳转丢状态）

---

### 4.2 处理页（同页 step view）

**视觉**：白色大卡片，居中。包含一个进度步骤列表 + 当前步骤的详细信息。复用 `web/index.html` 旧稿里写过的 `.progress-card` 样式（虽然旧稿要废，但这个组件可保留）。

**步骤列表**：

```
✓ 1. 上传音频到云端          12s
◐ 2. AI 语音转录              3:42  [处理中…]
○ 3. 识别说话人
○ 4. AI 分析剪辑决策
○ 5. 生成审查页面
```

**每步行为**：

#### Step 1: 上传到 uguu.se
```js
// 把 File 对象 multipart 上传
const fd = new FormData();
fd.append('files[]', audioFile);
const resp = await fetch('https://uguu.se/upload?output=text', { method:'POST', body: fd });
const audioUrl = (await resp.text()).trim();
// audioUrl 形如 https://a.uguu.se/xxxxx.mp3，24 小时有效
```

**异常处理**：上传失败重试 1 次，再失败提示用户检查网络。

#### Step 2: 阿里云 FunASR 转录

参考 `剪播客/scripts/aliyun_funasr_transcribe.sh` 第 50-145 行的完整逻辑。

**提交任务**：
```js
const submitResp = await fetch(
  'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ALIYUN_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'fun-asr',
      input: { file_urls: [audioUrl] },
      parameters: {
        diarization_enabled: true,
        speaker_count: userSpeakerCount,
        channel_id: [0],
      },
    }),
  }
);
const { output: { task_id } } = await submitResp.json();
```

**轮询**（每 5 秒一次，最多 25 分钟）：
```js
while (true) {
  await sleep(5000);
  const r = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${task_id}`, {
    headers: { 'Authorization': `Bearer ${ALIYUN_KEY}` },
  });
  const data = await r.json();
  const status = data.output?.task_status;
  if (status === 'SUCCEEDED') {
    const transcriptionUrl = data.output.results[0].transcription_url;
    const transcription = await fetch(transcriptionUrl).then(r => r.json());
    return transcription;  // 这是阿里云原始转录 JSON
  }
  if (status === 'FAILED') throw new Error(JSON.stringify(data));
  // 更新 UI 进度（已等待 N 秒）
}
```

**CORS 注意**：浏览器直连阿里云 dashscope endpoint 可能遇到 CORS 错误。**Codex 必须先在本地测试一次**，如果浏览器拒绝跨域，M1 fallback 方案是用 `https://cors.proxy.example.com/` 之类的公共 CORS 代理（临时方案）或简单的 Cloudflare Workers 代理（10 行代码）。这一点必须验证后告知用户。

#### Step 3: 识别说话人

参考 `剪播客/scripts/identify_speakers.js`。

**UI**：弹一个 modal，展示前 20 个不同说话人切换点的句子（每个 speaker_id 至少出 3 句）：

```
请给说话人起名字（AI 识别到 3 位）：

Speaker 0 → [____________]
  「大家好，欢迎来到今天的五点一刻」
  「我是麦雅」
  「我们今天聊聊 INFJ」

Speaker 1 → [____________]
  「Hello 大家好，我是十一」
  「对，我前段时间也在想这个」
  ...

Speaker 2 → [____________]
  ...

[确认]
```

**用户填完姓名后**，生成 `speakerMapping = {"0":"麦雅","1":"十一","2":"响歌歌"}`。

#### Step 4: 生成 subtitles_words.json + sentences

把 `剪播客/scripts/generate_subtitles_from_aliyun.js` 和 `generate_sentences.js` **翻译成浏览器 JS**（这两个脚本是纯逻辑无 Node API，几乎照搬）。

输出：
- `subtitlesWords` — 数组，每项是一个词 `{t, s, e, sp, isGap}`（核心数据结构，对应原项目的 `subtitles_words.json`）
- `sentences` — 数组，每项 `{idx, speaker, text, startTime, endTime, words[]}`

#### Step 5-6: DeepSeek AI 分析

**两次调用**：

**5a 粗剪分析（段落级）**
- System prompt: 整合 `基础剪辑规则/10-内容分析方法论.md` + `01-核心原则.md`
- User input: 完整 `sentences` 数组（如果太长，分批，每批 200-300 句）
- 输出 JSON: `{ blocks: [...], sentences: [{sentenceIdx, action:"keep"|"delete", type, blockId}] }`
- 对应原项目 `semantic_deep_analysis.json` 格式（见 `剪播客/SKILL.md:387-417`）

**5b 精剪分析（词/句级）**
- System prompt: `基础剪辑规则/LLM精剪prompt模板.md`（直接读这个文件作为 prompt）
- 分批 50-80 句，串行调用
- 输出 JSON: `{ edits: [{sentenceIdx, type, deleteText, reason, ...}] }`
- 对应原项目 `fine_analysis.json` 格式（见 `剪播客/SKILL.md:531-568`）

**DeepSeek 调用模板**（参考 jianji `https://dangxiaoshi.github.io/jianji/`）：
```js
const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${DEEPSEEK_KEY}`,
  },
  body: JSON.stringify({
    model: 'deepseek-chat',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userInput },
    ],
    response_format: { type: 'json_object' },  // 强制 JSON
  }),
});
```

**M1 简化**：先把 5a + 5b 实现，5c（自审查）跳过。后续迭代再加。

#### Step 7: 规则层精剪合并

把 `剪播客/scripts/run_fine_analysis.js` 翻译成浏览器 JS（纯算法，无 Node 特有 API）。它检测：
- 句首填充词（"嗯，"/"对，"/"啊，"）
- 长静音（>0.8s）
- 连续相同词卡顿（"我我"）
- 短语级句内重复（"可以去可以去"）

输出合并到 5b 的 fine_analysis 里。

#### Step 8: 数据注入 + 跳转 review

把以下数据序列化成 JS 字符串，**注入到 `review.html` 的 `<script>` 标签内**（替换 `S`、`BLK`、`CHAPS`、音频 src）：

```js
const S = [/* sentences 数组，格式见 review.html:684 */];
const BLK = [/* 删除段标记，格式见 review.html:685 */];
const CHAPS = [/* 章节导航，格式见 review.html:690 */];
// <audio id="au" src="<原始音频的 blob URL 或 uguu.se URL>"></audio>
```

**两种实现方式，Codex 选一**：

**A. 跳页 + sessionStorage**（推荐）
- index.html 把分析结果存 sessionStorage
- 跳转 review.html，页面顶部一段引导 script 从 sessionStorage 读数据，写入 S/BLK/CHAPS/audio.src
- 优点：保留 review.html 独立可用

**B. 单页 div 切换**
- 整个流程都在 index.html 里，review 部分用 iframe 或 div 切换
- 优点：状态不丢
- 缺点：review.html 要改成"被嵌入"模式，复杂

**推荐 A**。

---

### 4.3 审查页（`web/review.html`，已完成视觉，需要数据注入接口）

**Codex 不需要重写审查页**，只需要：

1. 在 `review.html` 文件最开头插入一段 bootstrap script：
   ```html
   <script>
     // 从 sessionStorage 读分析结果，覆盖默认的 demo 数据
     const __INJECTED = sessionStorage.getItem('jinqian_data');
     if (__INJECTED) {
       const { S: injS, BLK: injBLK, CHAPS: injCHAPS, audioUrl } = JSON.parse(__INJECTED);
       window.__S_OVERRIDE = injS;
       window.__BLK_OVERRIDE = injBLK;
       window.__CHAPS_OVERRIDE = injCHAPS;
       window.__AUDIO_OVERRIDE = audioUrl;
     }
   </script>
   ```

2. 改 `review.html` 第 684-690 行的常量声明为：
   ```js
   const S = window.__S_OVERRIDE || [/* 现有 demo 数据保留作为兜底 */];
   const BLK = window.__BLK_OVERRIDE || [];
   const CHAPS = window.__CHAPS_OVERRIDE || [/* demo */];
   ```

3. 改 `<audio>` 标签的 src 为动态：
   ```html
   <audio id="au" preload="auto"></audio>
   <script>
     document.getElementById('au').src = window.__AUDIO_OVERRIDE || '1_转录/audio_seekable.mp3';
   </script>
   ```

4. 修改 review.html 的「导出」按钮（找 `doExport()` 函数）：
   - 原行为：下载 `delete_segments_edited.json`
   - 新行为：把 `delete_segments_edited.json` 存 sessionStorage，跳转到 `cut.html`

---

### 4.4 剪辑页（`web/cut.html`，新建）

**任务**：用 ffmpeg.wasm 在浏览器内执行剪辑，生成成品 MP3 供下载。

**UI**：
```
┌─────────────────────────────────────────────┐
│  金钱剪刀 💰✂️                              │
├─────────────────────────────────────────────┤
│                                             │
│  正在剪辑你的播客…                          │
│                                             │
│  ◐ 加载剪辑引擎    (首次 ~10s)              │
│  ○ 解码音频                                 │
│  ○ 执行剪辑      (按删除段数估时 3-8min)    │
│  ○ 编码 MP3                                 │
│                                             │
│  ─── 进度条 ──────────────────────          │
│                                             │
│  剪辑完成后这里出现下载按钮                  │
│                                             │
└─────────────────────────────────────────────┘
```

**实现**：
```js
import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.x/+esm';
import { fetchFile } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.x/+esm';

const ffmpeg = new FFmpeg();
await ffmpeg.load({
  coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.x/dist/umd/ffmpeg-core.js',
});

await ffmpeg.writeFile('input.mp3', await fetchFile(audioBlob));

// 根据 delete_segments 构造 keep 段
const keepSegments = invertDeleteSegments(deleteSegments, totalDuration);
// 用 trim filter 拼接
const filterComplex = keepSegments
  .map((seg, i) => `[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS[a${i}]`)
  .join(';') + ';' +
  keepSegments.map((_, i) => `[a${i}]`).join('') +
  `concat=n=${keepSegments.length}:v=0:a=1[out]`;

await ffmpeg.exec([
  '-i', 'input.mp3',
  '-filter_complex', filterComplex,
  '-map', '[out]',
  '-b:a', '192k',
  'output.mp3',
]);

const data = await ffmpeg.readFile('output.mp3');
const blob = new Blob([data.buffer], { type: 'audio/mpeg' });
const url = URL.createObjectURL(blob);
// 触发下载
const a = document.createElement('a');
a.href = url;
a.download = `${podcastName}_精剪版.mp3`;
a.click();
```

**剪辑参数对齐原项目 `cut_audio.py`**：
- 输出比特率 ≥ 192kbps CBR
- 无 fade（或最多 3ms 微 fade）
- 不做静音替换，直接剪掉

**完成后页面**：
- 大字"剪辑完成"
- 「下载成品 MP3」按钮
- 提示卡片：
  > **下一步：后期处理**
  > 这份 MP3 已经完成粗剪。如需降噪、加片头片尾音乐、做高光片段，推荐使用：
  > - Adobe Audition / Logic（专业）
  > - 剪映 / Audacity（免费）

---

## 5. 技术架构 + 目录结构

### 5.1 设计原则
- **无构建步骤**（不用 Webpack/Vite，参考 jianji）
- **无大框架**（不用 React/Vue，原生 JS + 少量 ES Module）
- **第三方依赖走 CDN**（marked、ffmpeg.wasm）
- **状态用 sessionStorage**（页面间传递）+ **localStorage**（用户编辑持久化）
- **每个页面单独 HTML 文件**，方便部署到 GitHub Pages

### 5.2 目录结构
```
web/
├── index.html          # 入口 + 上传 + 处理流程（单页 step view）
├── review.html         # 审查页（已完成视觉，需加 bootstrap script）
├── cut.html            # 剪辑页（新建）
├── js/
│   ├── config.js       # API Keys（M1 写前端）
│   ├── upload.js       # uguu.se 上传
│   ├── transcribe.js   # 阿里云 FunASR
│   ├── subtitles.js    # subtitles_words.json 生成（移植自 generate_subtitles_from_aliyun.js）
│   ├── sentences.js    # 句子分割（移植自 generate_sentences.js）
│   ├── analyze.js      # DeepSeek 调用（5a + 5b）
│   ├── rules.js        # 规则层精剪（移植自 run_fine_analysis.js）
│   ├── prompts.js      # 所有 DeepSeek system prompts（从 基础剪辑规则/*.md 抽取）
│   └── cut.js          # ffmpeg.wasm 剪辑
└── css/
    └── shared.css      # jianji 风格 CSS 变量（从 review.html 抽出复用）
```

### 5.3 API Keys 配置（`js/config.js`）
```js
// ⚠️ M1: 写前端，仅用于测试和小范围内测，开营前必须迁后端
export const ALIYUN_DASHSCOPE_KEY = '__FILL_BEFORE_DEPLOY__';
export const DEEPSEEK_KEY = '__FILL_BEFORE_DEPLOY__';
```

**Codex 注意**：代码里用占位符 `__FILL_BEFORE_DEPLOY__`，README 写清楚部署前要替换。**不要把真实 Key 写进 git**。

---

## 6. 数据格式规范

### 6.1 subtitlesWords（核心数据）
```ts
type Word = {
  t: string;       // 词文本
  s: number;       // 开始时间（秒，3 位小数）
  e: number;       // 结束时间
  sp?: string;     // 说话人姓名（仅句首词有）
  isGap?: boolean; // 是否是说话人切换间隙
  isSpeakerLabel?: boolean; // 是否是说话人标签
};
```

### 6.2 sentences
```ts
type Sentence = {
  idx: number;
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
  words: Word[];
};
```

### 6.3 BLK（删除段）
```ts
type Block = {
  id: number;
  range: [number, number];   // 句子 idx 范围
  type: 'pre_show' | 'tech_debug' | 'chit_chat' | 'privacy' | 'repeated_content' | 'production_talk';
  reason: string;
  duration: string;          // 如 "1:06"
};
```

### 6.4 review.html 注入用的 S 数组
参见 `web/review.html:684`，单项格式：
```ts
type S_Item = {
  idx: number;
  sp: string;
  t: string;
  s: number;
  e: number;
  ts: string;
  w: Word[];
  ai?: boolean;       // AI 标记删除
  sug?: boolean;      // AI 建议删除
  sugReason?: string;
  dt?: string;        // 删除类型
};
```

### 6.5 delete_segments_edited.json（审查页导出）
```ts
type DeleteSegment = {
  start: number;  // 秒
  end: number;
  type: string;
  reason: string;
};
```

---

## 7. 视觉规范

完全沿用 `web/review.html` 已定义的设计 token：

```css
--bg: #fafafa;
--surface: #ffffff;
--surface-2: #f5f5f7;
--hairline: #e5e5ea;
--hairline-strong: #d2d2d7;
--ink: #1d1d1f;
--ink-2: #424245;
--muted: #86868b;
--accent: #F5A623;
--accent-hover: #e6991a;
--accent-soft: rgba(245,166,35,0.10);
--accent-deep: #c47d0e;
--shadow-card: 0 1px 3px rgba(0,0,0,0.06);
--shadow-md: 0 4px 16px rgba(0,0,0,0.08);
--shadow-accent: 0 2px 8px rgba(245,166,35,0.3);
```

字体：`-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", sans-serif`

圆角：按钮 10-12px，卡片 16px，小标签 6-8px

按钮：主按钮橙色填充 + 白字 + 橙色阴影；次按钮白底 + 灰边 + 黑字

**Codex 应该把这些 token 抽到 `css/shared.css`，三个 HTML 都引用同一份。**

---

## 8. 明确不做的事（划界）

| 功能 | 状态 | 原因 |
|---|---|---|
| 音质处理（降噪、回声去除） | ❌ M1 不做 | 浏览器跑不动 DeepFilterNet，下游工具处理 |
| 响度标准化（LUFS） | ❌ M1 不做 | 同上 |
| 加片头片尾音乐 | ❌ M1 不做 | 下游工具处理 |
| 高光片段提取 | ❌ M1 不做 | 下游工具处理 |
| 用户登录/账号 | ❌ M1 不做 | 50-200 学员小范围，URL 不公开传播即可 |
| 配额/计费 | ❌ M1 不做 | 同上 |
| 移动端 | ❌ M1 不做 | 桌面浏览器为主，移动端 ffmpeg.wasm 内存吃紧 |
| AI 自审查（5c） | ❌ M1 不做 | 5a + 5b 已能覆盖 80% 价值，5c 后续迭代加 |
| 用户偏好 / 反馈学习闭环 | ❌ M1 不做 | 原项目复杂功能，网页版砍 |

---

## 9. 验收标准

**M1 完成的标志**（按重要性排序）：

1. ✅ 用户在 Chrome 中打开网页，上传一个 30 分钟的测试音频，能在 15 分钟内**自动得到**一份可下载的剪辑成品 MP3。
2. ✅ 视觉对齐 `web/review.html` 已有 jianji 风格。
3. ✅ 部署到 GitHub Pages 后 URL 可访问且功能正常。
4. ✅ 审查页的所有现有功能（编辑、试听、模式切换、说话人修正、半句删除等）在注入数据后**全部正常工作**。
5. ✅ 剪辑出的 MP3 比特率 ≥ 192kbps，时长合理（≈ 原时长 - 删除段总时长）。
6. ✅ 处理流程的每一步都有清晰的进度提示，长任务（转录、剪辑）显示已耗时。
7. ✅ 任意一步出错时有明确错误提示（不是白屏）。
8. ✅ README.md 写清楚：怎么填 Key、怎么部署 GitHub Pages、已知限制。

---

## 10. 推荐执行顺序

按以下顺序做，每完成一步本地浏览器测试可见效果：

### Day 1
- [ ] 抽取 CSS 到 `css/shared.css`，三个 HTML 共享
- [ ] 重写 `web/index.html`（上传 + 表单 + 进度 step view 骨架）
- [ ] 实现 Step 1：上传到 uguu.se（独立可测）

### Day 2
- [ ] 实现 Step 2：阿里云 FunASR 转录（包含 CORS 验证！如有问题及时反馈）
- [ ] 实现 Step 3：说话人识别 modal

### Day 3
- [ ] 移植 generate_subtitles_from_aliyun.js → `js/subtitles.js`
- [ ] 移植 generate_sentences.js → `js/sentences.js`
- [ ] Step 4 完整跑通（出 subtitlesWords + sentences）

### Day 4
- [ ] 从 `基础剪辑规则/` 抽取 prompts 到 `js/prompts.js`
- [ ] 实现 Step 5：DeepSeek 粗剪（5a）
- [ ] 实现 Step 6：DeepSeek 精剪（5b）

### Day 5
- [ ] 移植 run_fine_analysis.js 规则层 → `js/rules.js`
- [ ] Step 7：合并 5b + 规则层
- [ ] Step 8：数据注入 review.html 并跳转，**端到端跑通到审查页**

### Day 6
- [ ] 改造 review.html 的 bootstrap script + 导出跳转
- [ ] 新建 cut.html，集成 ffmpeg.wasm
- [ ] 端到端跑通：上传 → 审查 → 下载 MP3

### Day 7
- [ ] 错误处理、loading 状态打磨
- [ ] README + 部署 GitHub Pages
- [ ] 用一个真实播客音频完整测试一次

---

## 11. 已知风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 阿里云 dashscope 不允许浏览器直连（CORS） | 阻塞 Step 2 | Day 2 优先验证；如不行，临时上 Cloudflare Workers 代理（提前告知用户） |
| ffmpeg.wasm 长音频内存爆 | 2 小时音频可能崩 | 测试 30/60/120 分钟三档；如果 120 min 失败，UI 提示"超长音频请分段处理" |
| 阿里云 Key 暴露 | 被恶意调用，按音频时长扣费 | M1 接受（小范围内测）；开营前迁 Workers 代理（不在本次范围） |
| DeepSeek 输出非合法 JSON | 分析失败 | 用 `response_format: json_object`；二次 fallback：抓 JSON.parse 异常后用 regex 提取 |
| uguu.se 上传失败或服务挂掉 | 阻塞所有流程 | 加一个 fallback：transfer.sh 或 file.io |
| 说话人识别错（speaker_count 不对） | 转录结果质量下降 | Step 1 明确提示用户"必须填准确的说话人数" |
| 审查页注入数据后 JS 报错 | 跳转到审查页白屏 | Step 8 之后必须用真实数据完整测试一次审查页所有功能 |

---

## 12. 参考资源

- 现有项目主文档：`/Users/dang/Documents/podcastcut-skills/剪播客/SKILL.md`
- 阿里云 FunASR 文档：搜 "DashScope 录音文件识别 fun-asr API"
- DeepSeek API 文档：https://platform.deepseek.com/api-docs/
- ffmpeg.wasm：https://ffmpegwasm.netlify.app/
- 视觉参考：https://dangxiaoshi.github.io/jianji/
- 现有审查页：用浏览器打开 `/Users/dang/Documents/podcastcut-skills/web/review.html` 查看完整功能

---

## 13. 给 Codex 的话

- 你的工作目录是 `/Users/dang/Documents/podcastcut-skills/`，所有新代码放 `web/` 下
- 不要动 `剪播客/templates/` 目录下的任何文件（那是用户日常本地工具的模板）
- 不要动 `剪播客/scripts/` 下任何文件（移植时复制+改写，不修改原文件）
- 不要把真实 API Key 提交到 git
- 如果遇到设计/技术取舍犹豫不决，**优先选简单方案 + 在 README 列已知限制**，而不是过度工程
- 每完成一个阶段，本地浏览器打开测试一遍，再进入下一阶段
- 阿里云 CORS 问题在 Day 2 第一时间验证，如果阻塞，立即反馈给用户决策（不要自己跑去搭复杂的代理）

完成 M1 后，预期下一步是：
- 加密码访问（一个简单的 prompt 弹窗 + 一个写死的密码）
- 阿里云 Key 迁 Cloudflare Workers 代理
- 加 5c 自审查
- 多个 episode 的本地历史记录
