import { apiJson } from './api.js?v=20260606-1';

const ROUGH_TYPES = [
  'pre_show',
  'tech_debug',
  'chit_chat',
  'privacy',
  'repeated_content',
  'production_talk',
  'redundant_viewpoint',
  'over_detail',
  'low_density',
  'weak_relevance',
];

export async function analyzeEditing(sentences, { onProgress } = {}) {
  const roughBatches = chunk(sentences, 200);
  const sentenceDecisions = [];
  const blocks = [];
  for (let i = 0; i < roughBatches.length; i += 1) {
    onProgress?.(`粗剪分析 第 ${i + 1}/${roughBatches.length} 批`);
    const result = await callJson(roughSystemPrompt(), roughUserPrompt(roughBatches[i]));
    if (Array.isArray(result.sentences)) sentenceDecisions.push(...result.sentences);
    if (Array.isArray(result.blocks)) blocks.push(...result.blocks);
  }

  return { blocks, sentenceDecisions, fineEdits: [] };
}

export function applyAnalysisToReviewPayload(payload, analysis) {
  const byIdx = new Map(payload.S.map((sentence) => [sentence.idx, sentence]));

  (analysis.sentenceDecisions || []).forEach((decision) => {
    const sentence = byIdx.get(Number(decision.sentenceIdx));
    if (!sentence || decision.action !== 'delete') return;
    sentence.ai = true;
    sentence.dt = sanitizeType(decision.type);
    if (decision.reason) sentence.sugReason = String(decision.reason).slice(0, 120);
  });

  (analysis.fineEdits || []).forEach((edit) => {
    const sentence = byIdx.get(Number(edit.sentenceIdx));
    if (!sentence || sentence.ai) return;
    sentence.sug = 1;
    sentence.dt = sanitizeType(edit.type || 'low_density');
    sentence.sugReason = String(edit.reason || edit.deleteText || '建议精简').slice(0, 120);
  });

  payload.BLK = normalizeBlocks(analysis.blocks || [], payload.S);
  return payload;
}

async function analyzeEditingStrategy(sentences) {
  const data = await apiJson('/api/deepseek/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `${decisionSystemPrompt()}\n\n以下是播客逐字稿：\n\n${formatTranscriptForDecision(sentences)}`,
        },
      ],
    }),
  });

  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function callJson(system, user) {
  const data = await apiJson('/api/deepseek/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  const content = data.choices?.[0]?.message?.content || '';
  return parseJson(content);
}

function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('DeepSeek 没有返回合法 JSON');
    return JSON.parse(match[0]);
  }
}

function roughSystemPrompt() {
  return [
    '你是播客粗剪编辑，只输出 JSON。',
    '任务：判断哪些句子或连续段落应该整段删除，目标是去掉录前准备、技术调试、闲聊寒暄、隐私信息、制作讨论、重复观点、低密度内容。',
    '不要删除承载观点、故事、情绪推进、关键信息的句子。',
    `type 只能从这些值中选择：${ROUGH_TYPES.join(', ')}。`,
    '输出格式：{"blocks":[{"range":[startIdx,endIdx],"type":"tech_debug","reason":"..."}],"sentences":[{"sentenceIdx":12,"action":"delete","type":"tech_debug","reason":"..."}]}',
  ].join('\n');
}

function decisionSystemPrompt() {
  return `你是一个做了十年内容营销的播客剪辑顾问。你帮人决定一期播客哪些该留、哪些该删。

你判断内容好不好，不看讲得对不对，看的是：
1. 听众听到这段会不会有感觉，会笑、会难过、会觉得说到心坎里了，这种留
2. 两个人聊到观点不一样、或者说了大家没想到的话，这种留
3. 讲了一个真实的事，有画面感的，比干巴巴讲道理好，留
4. 没什么情绪、在重复前面说过的、或者跑题了的，删

语气要求：说人话，别用书面语，别用AI味的词，不要用书名号，不要用「」这种括号，写出来要像跟朋友聊天一样。

用户粘贴播客逐字稿，直接分析，别问东问西，有什么就分析什么。用 markdown 格式输出。

---

## 节目概要

- **播客主**：
- **嘉宾**：
- **这期聊了什么**：用一句话说清楚，要让人一看就想听
- **适合谁听 / 能带走什么**：
- **内容侧重**：干货 / 故事 / 情绪，大概各占多少
- **高光时刻**：全篇最值得传播的一个地方，说清楚为什么
- **最不能删的部分**：全篇最有价值的一个地方，说清楚为什么
- **下次优化**：站在老播客主的角度，指出一个地方其实可以追问得更深
- **建议保留比例**：xx%

## 剪辑方案
**核心主线**：一句话，写得像一个让人想点进来的标题

**为什么这么剪**：两句话说清楚

**金句开场**：从原文里挑3-5句最能打动人的话，优先选那种听完会想截图发朋友圈的


**第一幕：[标题]**
- 这段要做到什么：让听众 ___
- 听完的感觉：___
- 保留内容：

**第二幕：[标题]**
- 这段要做到什么：让听众 ___
- 听完的感觉：___
- 保留内容：

**第三幕：[标题]**
- 这段要做到什么：让听众 ___
- 听完的感觉：___
- 保留内容：`;
}

function formatTranscriptForDecision(sentences) {
  const text = sentences.map((sentence) => {
    const speaker = sentence.speaker || sentence.sp || '说话人';
    const time = formatClock(sentence.startTime ?? sentence.s);
    return `[${time}] ${speaker}：${sentence.text || sentence.t || ''}`;
  }).join('\n');
  return trimTranscriptForDecision(text);
}

function trimTranscriptForDecision(text) {
  const maxLength = 28000;
  if (text.length <= maxLength) return text;
  const headLength = 18000;
  const tailLength = 8000;
  return [
    text.slice(0, headLength),
    '\n\n[中间逐字稿过长，已省略一部分。请基于开头、结尾和上下文做剪辑决策。]\n\n',
    text.slice(-tailLength),
  ].join('');
}

function fallbackDecisionReport(sentences, error) {
  const total = sentences.length;
  const first = sentences.find((sentence) => String(sentence.text || sentence.t || '').length > 12);
  const middle = sentences[Math.floor(total / 2)];
  const last = [...sentences].reverse().find((sentence) => String(sentence.text || sentence.t || '').length > 12);
  const reason = error?.message || '剪辑决策生成失败';
  return [
    '## 节目概要',
    '',
    '- **这期聊了什么**：AI 剪辑顾问报告生成失败，先进入逐字稿剪辑台按已有粗剪建议继续处理。',
    '- **适合谁听 / 能带走什么**：需要人工在逐字稿里确认。',
    '- **内容侧重**：需要人工确认。',
    '- **高光时刻**：建议从下面几个入口开始听。',
    '- **最不能删的部分**：先保留有故事、有情绪、有观点冲突的段落。',
    '- **下次优化**：逐字稿过长时，后续应分段生成剪辑决策。',
    '- **建议保留比例**：先按 60%-80% 粗剪，再人工细修。',
    '',
    '## 剪辑方案',
    '**核心主线**：先保留主线讨论，再删除录前准备、技术调试、重复观点和低密度闲聊。',
    '',
    `**为什么这么剪**：这次剪辑助手报告没有完整生成，原因是：${reason}。页面下方仍保留 AI 粗剪段落建议，可以先进入逐字稿剪辑台继续剪。`,
    '',
    '**金句开场**：',
    first ? `- ${first.text || first.t}` : '- 从逐字稿里挑一句最有情绪或最反常识的话。',
    middle ? `- ${middle.text || middle.t}` : '',
    last ? `- ${last.text || last.t}` : '',
    '',
    '**第一幕：开场和问题**',
    '- 这段要做到什么：让听众知道这期为什么值得听',
    '- 听完的感觉：想继续听下去',
    '- 保留内容：开头里直接进入主题的句子',
    '',
    '**第二幕：核心讨论**',
    '- 这段要做到什么：保留观点冲突、真实故事和有画面感的细节',
    '- 听完的感觉：有共鸣，有收获',
    '- 保留内容：嘉宾讲真实经历、两人观点不一样、出现关键判断的地方',
    '',
    '**第三幕：收束和行动**',
    '- 这段要做到什么：把结论讲清楚，不拖尾',
    '- 听完的感觉：知道这一期到底想表达什么',
    '- 保留内容：总结、转折、最有价值的最后判断',
  ].filter(Boolean).join('\n');
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function roughUserPrompt(batch) {
  return JSON.stringify({
    sentences: batch.map((sentence) => ({
      idx: sentence.idx,
      speaker: sentence.speaker,
      start: sentence.startTime,
      end: sentence.endTime,
      text: sentence.text,
    })),
  });
}

function fineSystemPrompt() {
  return [
    '你是播客精剪助手，只输出 JSON。',
    '任务：只找出可以整句删除的低价值短句，例如孤立反应词、独立笑声、没有信息量的口头确认。',
    '保守处理：如果一句话有实质信息，只是句内有填充词或卡顿，不要输出；后续由人工半句删除处理。',
    '输出格式：{"edits":[{"sentenceIdx":12,"type":"filler","deleteText":"嗯。","reason":"孤立反应词，可整句删除"}]}',
  ].join('\n');
}

function fineUserPrompt(batch) {
  return JSON.stringify({
    sentences: batch.map((sentence) => ({
      idx: sentence.idx,
      speaker: sentence.speaker,
      text: sentence.text,
    })),
  });
}

function normalizeBlocks(blocks, S) {
  return blocks.map((block, index) => {
    const range = block.range || block.r || [block.startIdx, block.endIdx];
    const start = Number(range?.[0]);
    const end = Number(range?.[1]);
    const first = S.find((sentence) => sentence.idx === start);
    const last = S.find((sentence) => sentence.idx === end);
    return {
      id: block.id ?? index,
      r: [start, end],
      type: sanitizeType(block.type),
      reason: String(block.reason || ''),
      dur: first && last ? formatDuration(last.e - first.s) : '',
    };
  }).filter((block) => Number.isFinite(block.r[0]) && Number.isFinite(block.r[1]) && block.r[1] >= block.r[0]);
}

function sanitizeType(type) {
  const value = String(type || 'low_density');
  return ROUGH_TYPES.includes(value) ? value : 'low_density';
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
