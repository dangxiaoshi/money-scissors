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
