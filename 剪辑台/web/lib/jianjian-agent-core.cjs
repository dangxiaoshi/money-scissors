'use strict';

const crypto = require('node:crypto');

const STRATEGIES = Object.freeze({
  structure_first: Object.freeze({
    id: 'structure_first',
    label: '结构优先',
    instruction: '先保护主线、论点顺序和必要转场，再删除偏题、重复和低价值展开。',
  }),
  density_first: Object.freeze({
    id: 'density_first',
    label: '密度优先',
    instruction: '在不破坏事实、逻辑和硬性要求的前提下，积极删除重复、口头铺垫和低信息密度内容。',
  }),
  audience_retention: Object.freeze({
    id: 'audience_retention',
    label: '留存优先',
    instruction: '优先保护开场钩子、悬念、情绪变化和可感知收益，删除会让听众流失的绕行。',
  }),
});

const PLANNER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'decisions'],
  properties: {
    strategy: { type: 'string', enum: Object.keys(STRATEGIES) },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'sentenceIdx', 'scope', 'reason', 'requirementIds'],
        properties: {
          action: { type: 'string', enum: ['keep', 'delete'] },
          sentenceIdx: { type: 'integer', minimum: 0 },
          scope: { type: 'string', enum: ['full', 'partial'] },
          cs: { type: 'integer', minimum: 0 },
          ce: { type: 'integer', minimum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 240 },
          requirementIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
      },
    },
  },
});

const LEDGER_STATES = Object.freeze([
  'AUTHED',
  'BOOTSTRAPPED',
  'CLAIMED',
  'TRANSCRIBED',
  'PLANNED',
  'EDITED',
  'CUT_DONE',
  'QA_PASSED',
  'SUBMITTED',
  'TA_VISIBLE',
]);

const STRATEGY_VERSION = 'jianjian-strategy-v1';
const WAITING_FOR_TA = 'WAITING_FOR_TA';
const CLAIM_DEADLINE_MS = 48 * 60 * 60 * 1000;

const TRANSITIONS = Object.freeze(Object.fromEntries(
  LEDGER_STATES.map((state, index) => [state, index ? [LEDGER_STATES[index - 1]] : []])
));

function fail(message, code = 'CONTRACT_ERROR', details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be finite`, 'INVALID_NUMBER');
  return number;
}

function sentenceId(sentence, index) {
  const value = Number(sentence && sentence.idx);
  return Number.isInteger(value) && value >= 0 ? value : index;
}

function transcriptText(sentence) {
  if (Array.isArray(sentence && sentence.w) && sentence.w.length) {
    return sentence.w.map((word) => String(word && word.t || '')).join('');
  }
  return String(sentence && (sentence.t ?? sentence.text) || '');
}

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    fail('transcript must be a non-empty array', 'MISSING_TRANSCRIPT');
  }
  const seen = new Set();
  return transcript.map((sentence, index) => {
    if (!sentence || typeof sentence !== 'object') fail(`transcript[${index}] must be an object`);
    const idx = sentenceId(sentence, index);
    if (seen.has(idx)) fail(`duplicate sentence idx ${idx}`, 'DUPLICATE_SENTENCE');
    seen.add(idx);
    const s = finite(sentence.s, `transcript[${index}].s`);
    const e = finite(sentence.e, `transcript[${index}].e`);
    if (s < 0 || e <= s) fail(`invalid sentence time range at idx ${idx}`, 'INVALID_RANGE');
    const text = transcriptText(sentence);
    if (!text) fail(`empty transcript text at idx ${idx}`, 'EMPTY_TRANSCRIPT_TEXT');
    return { ...sentence, idx, s, e, t: text };
  });
}

function list(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeRequirementItem(value, type, index) {
  const raw = typeof value === 'string' ? { text: value } : value;
  if (!raw || typeof raw !== 'object') fail(`invalid ${type} requirement at ${index}`, 'INVALID_REQUIREMENT');
  const item = {
    id: String(raw.id || `${type}-${index + 1}`),
    type,
    text: String(raw.text ?? raw.phrase ?? raw.content ?? '').trim(),
    sentenceIdx: raw.sentenceIdx == null && raw.idx == null ? null : Number(raw.sentenceIdx ?? raw.idx),
    cs: raw.cs == null ? null : Number(raw.cs),
    ce: raw.ce == null ? null : Number(raw.ce),
    start: raw.start == null && raw.s == null ? null : Number(raw.start ?? raw.s),
    end: raw.end == null && raw.e == null ? null : Number(raw.end ?? raw.e),
  };
  if (!item.text && item.sentenceIdx == null && item.start == null) {
    fail(`${item.id} needs text, sentenceIdx, or time range`, 'INVALID_REQUIREMENT');
  }
  if (item.sentenceIdx != null && (!Number.isInteger(item.sentenceIdx) || item.sentenceIdx < 0)) {
    fail(`${item.id} has invalid sentenceIdx`, 'INVALID_REQUIREMENT');
  }
  if ((item.cs == null) !== (item.ce == null) || (item.cs != null && (!Number.isInteger(item.cs) || !Number.isInteger(item.ce) || item.ce <= item.cs))) {
    fail(`${item.id} has invalid character range`, 'INVALID_REQUIREMENT');
  }
  if ((item.start == null) !== (item.end == null) || (item.start != null && (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= item.start))) {
    fail(`${item.id} has invalid time range`, 'INVALID_REQUIREMENT');
  }
  return item;
}

function parseTargetDuration(value) {
  if (value == null || value === '') return null;
  let min;
  let max;
  if (typeof value === 'number') min = max = value;
  else if (Array.isArray(value)) [min, max] = value;
  else if (typeof value === 'object') {
    min = value.min ?? value.minimum ?? value.target;
    max = value.max ?? value.maximum ?? value.target;
  } else {
    const numbers = String(value).match(/\d+(?:\.\d+)?/g) || [];
    if (numbers.length === 1) min = max = Number(numbers[0]) * (String(value).includes('分') ? 60 : 1);
    else if (numbers.length >= 2) {
      const multiplier = String(value).includes('分') ? 60 : 1;
      min = Number(numbers[0]) * multiplier;
      max = Number(numbers[1]) * multiplier;
    }
  }
  min = Number(min);
  max = Number(max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    fail('invalid target duration', 'INVALID_TARGET_DURATION');
  }
  return { min, max };
}

function normalizeRequirements(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('requirements must be an object');
  const mustKeep = list(input.mustKeep ?? input.must_keep ?? input.requiredKeep ?? input.required_keep)
    .map((item, index) => normalizeRequirementItem(item, 'must_keep', index));
  const mustDelete = list(input.mustDelete ?? input.must_delete ?? input.requiredDelete ?? input.required_delete)
    .map((item, index) => normalizeRequirementItem(item, 'must_delete', index));
  const formats = list(input.formats ?? input.format ?? input.deliveryFormats ?? input.delivery_formats)
    .map(String).map((item) => item.trim()).filter(Boolean);
  return {
    mustKeep,
    mustDelete,
    targetDuration: parseTargetDuration(input.targetDuration ?? input.target_duration ?? input.duration),
    formats: [...new Set(formats)],
    opening: String(input.opening ?? input.openingRequirement ?? input.opening_requirement ?? '').trim(),
    ending: String(input.ending ?? input.endingRequirement ?? input.ending_requirement ?? '').trim(),
    notes: list(input.notes).map(String).map((item) => item.trim()).filter(Boolean),
  };
}

function chunkTranscript(transcript, options = {}) {
  const normalized = normalizeTranscript(transcript);
  const maxChars = Number(options.maxChars ?? 6000);
  if (!Number.isInteger(maxChars) || maxChars < 200) fail('maxChars must be an integer >= 200');
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const sentence of normalized) {
    const line = `[${sentence.idx}] ${sentence.sp ? `${sentence.sp}: ` : ''}${sentence.t}`;
    const size = line.length + 1;
    if (current.length && chars + size > maxChars) {
      chunks.push(makeChunk(chunks.length, current));
      current = [];
      chars = 0;
    }
    current.push(sentence);
    chars += size;
  }
  if (current.length) chunks.push(makeChunk(chunks.length, current));
  return chunks;
}

function makeChunk(index, sentences) {
  return {
    chunkIndex: index,
    startSentenceIdx: sentences[0].idx,
    endSentenceIdx: sentences[sentences.length - 1].idx,
    sentenceIds: sentences.map((sentence) => sentence.idx),
    text: sentences.map((sentence) => `[${sentence.idx}] ${sentence.sp ? `${sentence.sp}: ` : ''}${sentence.t}`).join('\n'),
  };
}

function injectPriorFeedback(messages, feedback) {
  const clean = list(feedback).map((item) => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    return String(item.feedback ?? item.comment ?? item.text ?? '').trim();
  }).filter(Boolean);
  if (!clean.length) return messages;
  const block = `\n\n【上一轮助教反馈，必须逐条吸收；若与本单硬要求冲突，以硬要求为准】\n${clean.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
  if (Array.isArray(messages)) {
    const copy = messages.map((message) => ({ ...message }));
    const userIndex = copy.map((message) => message.role).lastIndexOf('user');
    if (userIndex < 0) copy.push({ role: 'user', content: block.trim() });
    else copy[userIndex].content = String(copy[userIndex].content || '') + block;
    return copy;
  }
  return String(messages || '') + block;
}

function buildPlannerPrompt({ strategy = 'structure_first', chunk, requirements = {}, priorFeedback = [] }) {
  if (!STRATEGIES[strategy]) fail(`unknown strategy: ${strategy}`, 'UNKNOWN_STRATEGY');
  if (!chunk || !Array.isArray(chunk.sentenceIds) || typeof chunk.text !== 'string') fail('valid chunk is required');
  const normalized = normalizeRequirements(requirements);
  const system = [
    '你是剪简 agent 的播客粗剪规划器。只能根据给定逐字稿作决定。',
    STRATEGIES[strategy].instruction,
    '必须保留项是安全闸门：有任何不确定就 keep，绝不能删除或部分删除。',
    '每个输入 sentenceIdx 必须且只能有一个决定；partial 仅用于 delete，且必须给 cs/ce。',
    '只输出符合给定 JSON Schema 的 JSON，不要 Markdown。',
    `JSON Schema: ${JSON.stringify(PLANNER_SCHEMA)}`,
  ].join('\n');
  const user = [
    `策略：${strategy}`,
    `本块句号：${chunk.sentenceIds.join(',')}`,
    `要求：${JSON.stringify(normalized)}`,
    '逐字稿：',
    chunk.text,
  ].join('\n');
  return injectPriorFeedback([{ role: 'system', content: system }, { role: 'user', content: user }], priorFeedback);
}

function resolveRequirementSpans(requirement, transcript) {
  const spans = [];
  for (const sentence of transcript) {
    if (requirement.sentenceIdx != null && sentence.idx !== requirement.sentenceIdx) continue;
    if (requirement.start != null && Math.min(sentence.e, requirement.end) > Math.max(sentence.s, requirement.start)) {
      spans.push({ sentenceIdx: sentence.idx, cs: 0, ce: sentence.t.length, start: Math.max(sentence.s, requirement.start), end: Math.min(sentence.e, requirement.end) });
      continue;
    }
    if (requirement.text) {
      let at = sentence.t.indexOf(requirement.text);
      while (at >= 0) {
        spans.push({ sentenceIdx: sentence.idx, cs: at, ce: at + requirement.text.length });
        at = sentence.t.indexOf(requirement.text, at + Math.max(1, requirement.text.length));
      }
    } else if (requirement.sentenceIdx === sentence.idx) {
      spans.push({ sentenceIdx: sentence.idx, cs: requirement.cs ?? 0, ce: requirement.ce ?? sentence.t.length });
    }
  }
  return spans;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.min(aEnd, bEnd) > Math.max(aStart, bStart);
}

function validatePlannerOutput(output, context = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) fail('planner output must be an object', 'INVALID_PLANNER_OUTPUT');
  const allowedTop = new Set(['strategy', 'decisions']);
  for (const key of Object.keys(output)) if (!allowedTop.has(key)) fail(`unexpected planner field: ${key}`, 'INVALID_PLANNER_OUTPUT');
  if (!STRATEGIES[output.strategy]) fail('invalid planner strategy', 'INVALID_PLANNER_OUTPUT');
  if (context.strategy && output.strategy !== context.strategy) fail('planner strategy mismatch', 'INVALID_PLANNER_OUTPUT');
  if (!Array.isArray(output.decisions)) fail('planner decisions must be an array', 'INVALID_PLANNER_OUTPUT');
  const transcript = normalizeTranscript(context.transcript);
  const byId = new Map(transcript.map((sentence) => [sentence.idx, sentence]));
  const expected = context.sentenceIds ? new Set(context.sentenceIds.map(Number)) : new Set(byId.keys());
  const requirements = normalizeRequirements(context.requirements || {});
  const keepSpans = requirements.mustKeep.flatMap((requirement) => {
    const spans = resolveRequirementSpans(requirement, transcript);
    if (spans.length === 0) {
      fail(`must-keep requirement ${requirement.id} could not be resolved`, 'MUST_KEEP_UNRESOLVED');
    }
    return spans;
  });
  const seen = new Set();
  const clean = output.decisions.map((decision, index) => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) fail(`decision ${index} must be an object`, 'INVALID_PLANNER_OUTPUT');
    const allowed = new Set(['action', 'sentenceIdx', 'scope', 'cs', 'ce', 'reason', 'requirementIds']);
    for (const key of Object.keys(decision)) if (!allowed.has(key)) fail(`unexpected decision field: ${key}`, 'INVALID_PLANNER_OUTPUT');
    if (!['keep', 'delete'].includes(decision.action) || !['full', 'partial'].includes(decision.scope)) fail(`invalid decision ${index}`, 'INVALID_PLANNER_OUTPUT');
    const idx = Number(decision.sentenceIdx);
    if (!Number.isInteger(idx) || !expected.has(idx) || !byId.has(idx)) fail(`decision references invalid sentence ${decision.sentenceIdx}`, 'INVALID_PLANNER_OUTPUT');
    if (seen.has(idx)) fail(`duplicate decision for sentence ${idx}`, 'INVALID_PLANNER_OUTPUT');
    seen.add(idx);
    const sentence = byId.get(idx);
    if (typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > 240) fail(`invalid reason for sentence ${idx}`, 'INVALID_PLANNER_OUTPUT');
    if (!Array.isArray(decision.requirementIds) || decision.requirementIds.some((id) => typeof id !== 'string')) fail(`invalid requirementIds for sentence ${idx}`, 'INVALID_PLANNER_OUTPUT');
    let cs = null;
    let ce = null;
    if (decision.scope === 'partial') {
      if (decision.action !== 'delete') fail('partial keep decisions are not supported', 'INVALID_PLANNER_OUTPUT');
      cs = Number(decision.cs);
      ce = Number(decision.ce);
      if (!Number.isInteger(cs) || !Number.isInteger(ce) || cs < 0 || ce <= cs || ce > sentence.t.length) fail(`invalid partial range for sentence ${idx}`, 'INVALID_PLANNER_OUTPUT');
    } else if (decision.cs != null || decision.ce != null) {
      fail(`full decision ${idx} cannot contain cs/ce`, 'INVALID_PLANNER_OUTPUT');
    }
    if (decision.action === 'delete') {
      const deleteStart = cs ?? 0;
      const deleteEnd = ce ?? sentence.t.length;
      if (keepSpans.some((span) => span.sentenceIdx === idx && rangesOverlap(deleteStart, deleteEnd, span.cs, span.ce))) {
        fail(`delete overlaps must-keep content at sentence ${idx}`, 'MUST_KEEP_VIOLATION');
      }
    }
    return { action: decision.action, sentenceIdx: idx, scope: decision.scope, ...(cs == null ? {} : { cs, ce }), reason: decision.reason.trim(), requirementIds: [...new Set(decision.requirementIds)] };
  });
  if (clean.length !== expected.size || [...expected].some((idx) => !seen.has(idx))) fail('planner output does not cover every requested sentence', 'INCOMPLETE_COVERAGE');
  return { strategy: output.strategy, decisions: clean };
}

function charRangeToTime(sentence, cs, ce) {
  const text = sentence.t;
  const words = Array.isArray(sentence.w) ? sentence.w : [];
  let cursor = 0;
  const mapped = words.map((word) => {
    const value = String(word && word.t || '');
    const start = cursor;
    cursor += value.length;
    return { start, end: cursor, s: Number(word.s), e: Number(word.e) };
  }).filter((word) => Number.isFinite(word.s) && Number.isFinite(word.e) && word.e > word.s);
  const touched = mapped.filter((word) => rangesOverlap(cs, ce, word.start, word.end));
  if (touched.length) {
    const first = touched[0];
    const last = touched[touched.length - 1];
    const startFraction = first.end > first.start ? Math.max(0, cs - first.start) / (first.end - first.start) : 0;
    const endFraction = last.end > last.start ? Math.min(last.end, ce) - last.start : last.end;
    const normalizedEndFraction = last.end > last.start ? endFraction / (last.end - last.start) : 1;
    return {
      s: round3(first.s + (first.e - first.s) * startFraction),
      e: round3(last.s + (last.e - last.s) * normalizedEndFraction),
    };
  }
  const ratioStart = text.length ? cs / text.length : 0;
  const ratioEnd = text.length ? ce / text.length : 1;
  return { s: round3(sentence.s + (sentence.e - sentence.s) * ratioStart), e: round3(sentence.s + (sentence.e - sentence.s) * ratioEnd) };
}

function round3(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

function mergeSegments(segments, maxGap = 0.08) {
  const gap = finite(maxGap, 'maxGap');
  if (gap < 0 || gap > 0.08) fail('merge gap cannot exceed 0.08 seconds', 'UNSAFE_MERGE_GAP');
  const sorted = list(segments).map((segment) => ({
    start: finite(segment.start ?? segment.s, 'segment.start'),
    end: finite(segment.end ?? segment.e, 'segment.end'),
  })).filter((segment) => segment.end > segment.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const segment of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start - previous.end <= gap + 1e-9) previous.end = round3(Math.max(previous.end, segment.end));
    else merged.push({ start: round3(segment.start), end: round3(segment.end) });
  }
  return merged;
}

function decisionsToArtifacts({ transcript, decisions, audioUrl = '', maxMergeGap = 0.08 }) {
  const normalized = normalizeTranscript(transcript);
  const byId = new Map(normalized.map((sentence) => [sentence.idx, sentence]));
  const d = [];
  const p = {};
  const segments = [];
  for (const decision of decisions || []) {
    if (decision.action !== 'delete') continue;
    const sentence = byId.get(Number(decision.sentenceIdx));
    if (!sentence) fail(`unknown sentence ${decision.sentenceIdx}`, 'INVALID_DECISION_REFERENCE');
    if (decision.scope === 'full') {
      d.push(sentence.idx);
      segments.push({ start: sentence.s, end: sentence.e });
    } else {
      const cs = Number(decision.cs);
      const ce = Number(decision.ce);
      if (!Number.isInteger(cs) || !Number.isInteger(ce) || cs < 0 || ce <= cs || ce > sentence.t.length) fail(`invalid partial delete at ${sentence.idx}`);
      const time = charRangeToTime(sentence, cs, ce);
      (p[sentence.idx] ||= []).push({ cs, ce, s: time.s, e: time.e });
      segments.push({ start: time.s, end: time.e });
    }
  }
  d.sort((a, b) => a - b);
  for (const key of Object.keys(p)) p[key].sort((a, b) => a.cs - b.cs);
  const cutSegments = mergeSegments(segments, maxMergeGap);
  return {
    editState: { d, p },
    cutPayload: { audioUrl: String(audioUrl || ''), segments: cutSegments },
  };
}

function requirementCoveredByDeletes(requirement, transcript, artifacts) {
  const spans = resolveRequirementSpans(requirement, transcript);
  if (!spans.length) return false;
  const deleted = new Set(artifacts.editState.d);
  return spans.every((span) => {
    if (deleted.has(span.sentenceIdx)) return true;
    return (artifacts.editState.p[span.sentenceIdx] || []).some((range) => range.cs <= span.cs && range.ce >= span.ce);
  });
}

function qaPlan({ transcript, requirements = {}, decisions, artifacts, coverageSentenceIds }) {
  const normalizedTranscript = normalizeTranscript(transcript);
  const normalizedRequirements = normalizeRequirements(requirements);
  const built = artifacts || decisionsToArtifacts({ transcript: normalizedTranscript, decisions });
  const checks = [];
  for (const requirement of normalizedRequirements.mustDelete) {
    checks.push({
      id: `required-delete:${requirement.id}`,
      pass: requirementCoveredByDeletes(requirement, normalizedTranscript, built),
      message: `必须删除项 ${requirement.id}`,
    });
  }
  const originalDuration = Math.max(...normalizedTranscript.map((sentence) => sentence.e));
  const removedDuration = built.cutPayload.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  const outputDuration = Math.max(0, originalDuration - removedDuration);
  if (normalizedRequirements.targetDuration) {
    checks.push({
      id: 'target-duration',
      pass: outputDuration >= normalizedRequirements.targetDuration.min - 0.001 && outputDuration <= normalizedRequirements.targetDuration.max + 0.001,
      actual: round3(outputDuration),
      expected: normalizedRequirements.targetDuration,
    });
  }
  const expected = new Set((coverageSentenceIds || normalizedTranscript.map((sentence) => sentence.idx)).map(Number));
  const covered = new Set((decisions || []).map((decision) => Number(decision.sentenceIdx)));
  checks.push({
    id: 'coverage',
    pass: expected.size === covered.size && [...expected].every((idx) => covered.has(idx)),
    actual: covered.size,
    expected: expected.size,
  });
  return {
    pass: checks.every((check) => check.pass),
    checks,
    metrics: { originalDuration: round3(originalDuration), removedDuration: round3(removedDuration), outputDuration: round3(outputDuration) },
  };
}

function buildAuditRecord({ orderId, taskId, strategy, decisions, requirements, qa, priorFeedback }) {
  const reasons = (decisions || []).map((decision) => ({
    sentenceIdx: Number(decision.sentenceIdx),
    action: decision.action,
    scope: decision.scope,
    reason: String(decision.reason || ''),
    requirementIds: list(decision.requirementIds).map(String),
  }));
  const record = {
    version: 1,
    orderId: orderId == null ? null : String(orderId),
    taskId: taskId == null ? null : String(taskId),
    strategy,
    requirementSummary: {
      mustKeep: normalizeRequirements(requirements || {}).mustKeep.map((item) => item.id),
      mustDelete: normalizeRequirements(requirements || {}).mustDelete.map((item) => item.id),
    },
    priorFeedbackCount: list(priorFeedback).filter(Boolean).length,
    reasons,
    qa,
  };
  const serialized = JSON.stringify(record);
  if (/"(?:transcript|body|text|content)"\s*:/i.test(serialized)) fail('audit record contains transcript-like body', 'AUDIT_BODY_FORBIDDEN');
  return record;
}

class Ledger {
  constructor(snapshot = null, options = {}) {
    this.entries = [];
    this.knownSecrets = list(options.knownSecrets).filter(Boolean).map(String);
    if (snapshot) this.resume(snapshot);
  }

  get current() {
    return this.entries.length ? this.entries[this.entries.length - 1].state : null;
  }

  transition(state, metadata = {}) {
    if (!LEDGER_STATES.includes(state)) fail(`unknown ledger state ${state}`, 'INVALID_LEDGER_STATE');
    const currentIndex = this.current == null ? -1 : LEDGER_STATES.indexOf(this.current);
    const nextIndex = LEDGER_STATES.indexOf(state);
    if (nextIndex !== currentIndex + 1) fail(`invalid transition ${this.current || 'START'} -> ${state}`, 'INVALID_LEDGER_TRANSITION');
    this.entries.push({ state, at: new Date().toISOString(), metadata: sanitizeLedgerMetadata(metadata, this.knownSecrets) });
    return this.current;
  }

  resume(snapshot) {
    const entries = Array.isArray(snapshot) ? snapshot : snapshot && snapshot.entries;
    if (!Array.isArray(entries)) fail('invalid ledger snapshot', 'INVALID_LEDGER_SNAPSHOT');
    this.entries = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') fail('invalid ledger entry', 'INVALID_LEDGER_SNAPSHOT');
      const expected = LEDGER_STATES[this.entries.length];
      if (entry.state !== expected) fail(`invalid resumed transition to ${entry.state}`, 'INVALID_LEDGER_SNAPSHOT');
      this.entries.push({ state: entry.state, at: String(entry.at || ''), metadata: sanitizeLedgerMetadata(entry.metadata || {}, this.knownSecrets) });
    }
    return this;
  }

  snapshot() {
    return { version: 1, entries: this.entries.map((entry) => ({ ...entry, metadata: { ...entry.metadata } })) };
  }
}

function looksLikeCredential(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (/^(?:Bearer|Basic)\s+\S+$/i.test(trimmed)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(trimmed)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) return false;
  if (trimmed.length < 32 || /\s/.test(trimmed)) return false;
  const classes = [/[a-z]/.test(trimmed), /[A-Z]/.test(trimmed), /\d/.test(trimmed), /[^A-Za-z0-9]/.test(trimmed)].filter(Boolean).length;
  return classes >= 3;
}

function sanitizeValue(value, knownSecrets = [], key = '') {
  if (/token|secret|password|authorization|cookie|transcript|body/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (knownSecrets.some((secret) => secret && value.includes(secret))) return redactSecrets(value, knownSecrets);
    if (looksLikeCredential(value)) {
      return /^(?:Bearer|Basic)\s+/i.test(value.trim()) ? redactSecrets(value, knownSecrets) : '[REDACTED]';
    }
    return redactSecrets(value, knownSecrets);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, knownSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, knownSecrets, childKey)]));
  }
  return value;
}

function sanitizeLedgerMetadata(metadata, knownSecrets = []) {
  return sanitizeValue(metadata, knownSecrets);
}

function redactSecrets(value, secrets = []) {
  let output = typeof value === 'string' ? value : JSON.stringify(value);
  output = output
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
  for (const secret of secrets.filter(Boolean).map(String).sort((a, b) => b.length - a.length)) output = output.split(secret).join('[REDACTED]');
  return output;
}

const NON_PRODUCTION_ORIGINS = Object.freeze(new Set([
  'http://8.136.133.196:8090',
]));

function isProductionUrl(baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return false;
  if (NON_PRODUCTION_ORIGINS.has(url.origin)) return false;
  return true;
}

function assertSafetyGates(options = {}) {
  if (!options.baseUrl) fail('--base-url is required', 'BASE_URL_REQUIRED');
  if (isProductionUrl(options.baseUrl) && !options.allowProduction) fail('production URL requires --allow-production', 'PRODUCTION_APPROVAL_REQUIRED');
  const hasTaskTarget = Boolean(options.taskId || csvList(options.taskIds).length);
  if (options.claim && (!options.approveClaim || !hasTaskTarget)) fail('claim requires --approve-claim plus exact task target(s)', 'CLAIM_APPROVAL_REQUIRED');
  if (options.submit && !options.approveSubmit) fail('submit requires --approve-submit', 'SUBMIT_APPROVAL_REQUIRED');
  return true;
}

class JsonClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) fail('baseUrl is required');
    if (typeof fetchImpl !== 'function') fail('fetch implementation is missing', 'PROVIDER_MISSING');
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/, '');
    this.token = token || '';
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, body) {
    const response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { fail(`non-JSON response (${response.status})`, 'NON_JSON_RESPONSE'); }
    }
    if (!response.ok) fail(`HTTP ${response.status}`, 'HTTP_ERROR', { status: response.status, data });
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
}

async function reconcileBeforeCreate({ findExisting, create, identity }) {
  if (typeof findExisting !== 'function' || typeof create !== 'function') fail('reconcile provider missing', 'PROVIDER_MISSING');
  const existing = await findExisting(identity);
  if (existing) return { artifact: existing, created: false };
  const artifact = await create(identity);
  if (!artifact) fail('create returned no artifact', 'ARTIFACT_MISSING');
  return { artifact, created: true };
}

async function snapshotBeforeMutation({ read, mutate, target }) {
  if (typeof read !== 'function' || typeof mutate !== 'function') fail('snapshot provider missing', 'PROVIDER_MISSING');
  const before = await read(target);
  if (before == null) fail('cannot mutate without snapshot', 'ARTIFACT_MISSING');
  const result = await mutate(target, before);
  if (result == null) fail('mutation returned no artifact', 'ARTIFACT_MISSING');
  return { before, result };
}

function responseList(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['data', 'tasks', 'claims', 'projects', 'items', 'list']) {
    if (Array.isArray(value && value[key])) return value[key];
  }
  return [];
}

function taskIdentity(value) {
  return String((value && (value.taskId ?? value.task_id ?? value.id)) ?? '');
}

function claimIdentity(value) {
  return String((value && (value.claimId ?? value.claim_id ?? value.id)) ?? '');
}

function projectIdentity(value) {
  return String((value && (value.projectId ?? value.project_id ?? value.id)) ?? '');
}

function claimProjectIdentity(value) {
  return String((value && (value.projectId ?? value.project_id)) ?? '');
}

function clock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function millisecondsToSeconds(value) {
  const number = finite(value, 'DashScope timestamp');
  return round3(number / 1000);
}

function dashscopeToV1S(result) {
  const sentences = result && result.transcripts && result.transcripts[0] && result.transcripts[0].sentences;
  if (!Array.isArray(sentences) || !sentences.length) fail('DashScope result has no sentences', 'ARTIFACT_MISSING');
  return sentences.map((sentence, index) => {
    const rawStart = sentence.begin_time ?? sentence.start_time ?? sentence.start;
    const rawEnd = sentence.end_time ?? sentence.end;
    const s = millisecondsToSeconds(rawStart);
    const e = millisecondsToSeconds(rawEnd);
    if (e <= s) fail(`invalid DashScope sentence range ${index}`, 'INVALID_RANGE');
    const words = list(sentence.words).map((word) => {
      const ws = millisecondsToSeconds(word.begin_time ?? word.start_time ?? word.start);
      const we = millisecondsToSeconds(word.end_time ?? word.end);
      return { t: String(word.text ?? word.word ?? word.punctuation ?? ''), s: ws, e: we };
    }).filter((word) => word.t && word.e > word.s);
    const text = String(sentence.text ?? sentence.t ?? words.map((word) => word.t).join('')).trim();
    if (!text) fail(`empty DashScope sentence ${index}`, 'EMPTY_TRANSCRIPT_TEXT');
    return {
      idx: index,
      sp: String(sentence.speaker_id ?? sentence.speaker ?? sentence.sp ?? ''),
      t: text,
      s,
      e,
      ts: clock(s),
      w: words,
    };
  });
}

function parseAiJson(response) {
  const content = response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) fail('planner returned no content', 'PLANNER_MISSING');
  try { return JSON.parse(content); }
  catch { fail('planner returned invalid JSON', 'INVALID_PLANNER_OUTPUT'); }
}

function materialFromTask(task) {
  const source = task && (task.material || task.audio || task);
  const audioUrl = String(source.audioUrl ?? source.audio_url ?? source.materialUrl ?? source.material_url ?? source.materialLink ?? source.material_link ?? task.audioUrl ?? task.audio_url ?? task.materialLink ?? task.material_link ?? '').trim();
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) fail('unsupported or missing material link', 'UNSUPPORTED_MATERIAL');
  return {
    audioUrl,
    storage: String(source.storage ?? task.storage ?? ''),
    objectKey: String(source.objectKey ?? source.object_key ?? task.objectKey ?? task.object_key ?? ''),
    fileName: String(source.fileName ?? source.file_name ?? task.fileName ?? task.file_name ?? task.title ?? 'podcast.mp3'),
  };
}

function unwrapOutput(value) {
  return value && typeof value.output === 'object' && value.output ? value.output : value || {};
}

function unwrapClaim(value) {
  return value && typeof value.claim === 'object' && value.claim ? value.claim : value;
}

function unwrapProject(value) {
  return value && typeof value.project === 'object' && value.project ? value.project : value;
}

function unwrapSnapshot(value) {
  return value && typeof value.snapshot === 'object' && value.snapshot ? value.snapshot : value;
}

function normalizeTaskRequirements(task) {
  const raw = task && (task.requirements ?? task.demand);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return normalizeRequirements(raw);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return normalizeRequirements(parsed);
    } catch {}
  }
  return normalizeRequirements({});
}

function outputQa({ transcript, requirements, plannedDuration, statusDuration, toleranceSeconds = 1 }) {
  const S = normalizeTranscript(transcript);
  const normalized = normalizeRequirements(requirements || {});
  const combined = S.map((sentence) => sentence.t).join('\n');
  const checks = [];
  for (const requirement of normalized.mustKeep) {
    const verifiable = Boolean(requirement.text);
    checks.push({
      id: `output-must-keep:${requirement.id}`,
      pass: verifiable && combined.includes(requirement.text),
      message: verifiable ? `成品必须保留 ${requirement.id}` : `成品无法验证必须保留项 ${requirement.id}`,
    });
  }
  for (const requirement of normalized.mustDelete) {
    const verifiable = Boolean(requirement.text);
    checks.push({
      id: `output-must-delete:${requirement.id}`,
      pass: verifiable && !combined.includes(requirement.text),
      message: verifiable ? `成品必须删除 ${requirement.id}` : `成品无法验证必须删除项 ${requirement.id}`,
    });
  }
  const transcriptDuration = Math.max(...S.map((sentence) => sentence.e));
  const remoteDuration = Number(statusDuration);
  const actualDuration = Number.isFinite(remoteDuration) && remoteDuration > 0 ? remoteDuration : transcriptDuration;
  const tolerance = Math.max(0, finite(toleranceSeconds, 'duration tolerance'));
  if (normalized.targetDuration) {
    checks.push({
      id: 'output-target-duration',
      pass: actualDuration >= normalized.targetDuration.min - tolerance && actualDuration <= normalized.targetDuration.max + tolerance,
      actual: round3(actualDuration),
      expected: normalized.targetDuration,
      tolerance,
    });
  } else {
    const planned = finite(plannedDuration, 'planned duration');
    const plannedTolerance = Math.max(tolerance, planned * 0.05);
    checks.push({
      id: 'output-planned-duration',
      pass: Math.abs(actualDuration - planned) <= plannedTolerance,
      actual: round3(actualDuration),
      expected: round3(planned),
      tolerance: round3(plannedTolerance),
    });
  }
  return { pass: checks.every((check) => check.pass), checks, actualDuration: round3(actualDuration) };
}

class V1Provider {
  constructor({
    baseUrl,
    token,
    fetchImpl = globalThis.fetch,
    maxPollAttempts = 20,
    pollIntervalMs = 1500,
    durationToleranceSeconds = 1,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    checkpoint = async () => {},
  }) {
    if (!token) fail('credential is required', 'CREDENTIAL_REQUIRED');
    this.client = new JsonClient({ baseUrl, token, fetchImpl });
    this.baseUrl = this.client.baseUrl;
    this.maxPollAttempts = Number(maxPollAttempts);
    this.pollIntervalMs = Number(pollIntervalMs);
    this.durationToleranceSeconds = Number(durationToleranceSeconds);
    if (!Number.isInteger(this.maxPollAttempts) || this.maxPollAttempts < 1 || this.maxPollAttempts > 1000) fail('invalid max poll attempts');
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 0 || this.pollIntervalMs > 60000) fail('invalid poll interval');
    if (typeof sleep !== 'function' || typeof checkpoint !== 'function') fail('poll/checkpoint provider missing', 'PROVIDER_MISSING');
    this.sleep = sleep;
    this.checkpoint = checkpoint;
  }

  async poll(read, classify, label) {
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      const value = await read(attempt);
      const state = classify(value);
      if (state === 'success') return value;
      if (state === 'failed') fail(`${label} failed`, 'REMOTE_JOB_FAILED', value);
      if (attempt < this.maxPollAttempts) await this.sleep(this.pollIntervalMs);
    }
    fail(`${label} polling exhausted`, 'POLL_EXHAUSTED');
  }

  async transition(ledger, state, metadata = {}) {
    const target = LEDGER_STATES.indexOf(state);
    const current = ledger.current == null ? -1 : LEDGER_STATES.indexOf(ledger.current);
    if (current >= target) return;
    if (target !== current + 1) fail(`cannot skip ledger state before ${state}`, 'INVALID_LEDGER_TRANSITION');
    ledger.transition(state, metadata);
    await this.checkpoint(ledger.snapshot());
  }

  async getClaims() {
    return responseList(await this.client.get('/api/orders/my-claims'));
  }

  async transcribe(material, speakerCount) {
    const created = await this.client.post('/dashscope/transcription', {
      audioUrl: material.audioUrl,
      speakerCount,
      storage: material.storage,
      objectKey: material.objectKey,
    });
    const createdOutput = unwrapOutput(created);
    const id = String(createdOutput.task_id ?? createdOutput.taskId ?? created.task_id ?? created.taskId ?? created.id ?? '');
    if (!id) fail('transcription task id missing', 'ARTIFACT_MISSING');
    const completed = await this.poll(
      () => this.client.get(`/dashscope/tasks/${encodeURIComponent(id)}`),
      (value) => {
        const output = unwrapOutput(value);
        const status = String(output.task_status ?? output.status ?? value.task_status ?? value.status ?? '').toUpperCase();
        if (['SUCCEEDED', 'SUCCESS', 'DONE', 'COMPLETED'].includes(status)) return 'success';
        if (['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(status)) return 'failed';
        return 'pending';
      },
      'transcription'
    );
    const completedOutput = unwrapOutput(completed);
    const results = Array.isArray(completedOutput.results) ? completedOutput.results : [];
    const resultUrl = String(
      (results[0] && (results[0].transcription_url ?? results[0].transcriptionUrl))
      ?? completedOutput.resultUrl
      ?? completedOutput.result_url
      ?? completedOutput.url
      ?? completed.resultUrl
      ?? completed.result_url
      ?? completed.url
      ?? ''
    );
    if (!resultUrl) fail('transcription result URL missing', 'ARTIFACT_MISSING');
    const result = await this.client.get(`/dashscope/result?url=${encodeURIComponent(resultUrl)}`);
    return { taskId: id, resultUrl, S: dashscopeToV1S(result) };
  }

  async plan(task, S, strategy, priorFeedback) {
    const chunks = chunkTranscript(S);
    const requirements = normalizeTaskRequirements(task);
    const decisions = [];
    for (const chunk of chunks) {
      const messages = buildPlannerPrompt({ strategy, chunk, requirements, priorFeedback });
      messages[messages.length - 1].content += `\n原始 task.demand：${typeof task.demand === 'string' ? task.demand : JSON.stringify(task.demand || {})}`;
      const response = await this.client.post('/api/deepseek/chat', {
        model: 'deepseek-v4-flash',
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        purpose: 'decision_bundle',
        messages,
      });
      const output = parseAiJson(response);
      const validated = validatePlannerOutput(output, { strategy, transcript: S, sentenceIds: chunk.sentenceIds, requirements });
      decisions.push(...validated.decisions);
    }
    if (decisions.length !== S.length) fail('planner did not cover full transcript', 'INCOMPLETE_COVERAGE');
    return { strategy, decisions, requirements };
  }

  async reconcileClaim(taskId, allowCreate) {
    const claims = await this.getClaims();
    const existing = claims.find((claim) => taskIdentity(claim) === String(taskId));
    if (existing) return existing;
    if (!allowCreate) fail('task is not claimed and claim was not approved', 'CLAIM_APPROVAL_REQUIRED');
    let created = null;
    let createError = null;
    try {
      created = unwrapClaim(await this.client.post(`/api/orders/tasks/${encodeURIComponent(taskId)}/claim`, {}));
    } catch (error) {
      createError = error;
    }
    if (!claimIdentity(created)) {
      const after = (await this.getClaims()).find((claim) => taskIdentity(claim) === String(taskId));
      if (!after) {
        if (createError) throw createError;
        fail('claim artifact missing after reconciliation', 'ARTIFACT_MISSING');
      }
      return after;
    }
    return created;
  }

  async findProjectForDispatch(taskId, claimId) {
    const projects = responseList(await this.client.get('/api/projects'));
    const candidates = projects.slice(0, 50);
    for (const summary of candidates) {
      const id = projectIdentity(summary);
      if (!id) continue;
      const detailResponse = await this.client.get(`/api/projects/${encodeURIComponent(id)}`);
      const detailProject = unwrapProject(detailResponse);
      const payload = (detailResponse && detailResponse.payload)
        ?? (detailProject && detailProject.payload)
        ?? {};
      const dispatch = payload && payload.dispatchTask;
      if (String(dispatch && dispatch.id) === String(taskId) && String(dispatch && dispatch.claimId) === String(claimId)) {
        return { ...detailProject, id };
      }
    }
    return null;
  }

  async reconcileProject(claim, task, material, S, editState) {
    if (claimProjectIdentity(claim)) {
      const direct = await this.client.get(`/api/projects/${encodeURIComponent(claimProjectIdentity(claim))}`);
      const directProject = unwrapProject(direct);
      if (projectIdentity(directProject)) return directProject;
    }
    const existing = await this.findProjectForDispatch(taskIdentity(task), claimIdentity(claim));
    if (existing) return existing;
    const originalDuration = Math.max(...S.map((sentence) => sentence.e));
    const payload = {
      version: 'jinqian_m1',
      audioUrl: material.audioUrl,
      fileName: material.fileName,
      S,
      BLK: [],
      CHAPS: [],
      subtitlesWords: [],
      dispatchTask: {
        id: taskIdentity(task),
        claimId: claimIdentity(claim),
        title: String(task.title || ''),
        demand: task.demand ?? {},
      },
      editState,
    };
    const body = {
      fileName: material.fileName,
      audioUrl: material.audioUrl,
      payload,
      metrics: { originalDuration, roughcutDuration: originalDuration, removedDuration: 0 },
    };
    let project = null;
    let createError = null;
    try {
      project = unwrapProject(await this.client.post('/api/projects', body));
    } catch (error) {
      createError = error;
    }
    if (projectIdentity(project)) return project;
    const reconciled = await this.findProjectForDispatch(taskIdentity(task), claimIdentity(claim));
    if (!reconciled) {
      if (createError) throw createError;
      fail('project id missing after reconciliation', 'ARTIFACT_MISSING');
    }
    return reconciled;
  }

  async cut(material, segments, originalDuration) {
    const created = await this.client.post('/api/cut/start', {
      audioUrl: material.audioUrl,
      storage: material.storage,
      objectKey: material.objectKey,
      segments,
      originalDuration,
      fileName: material.fileName,
      goldenSegments: [],
      introMusic: null,
    });
    const jobId = String(created.jobId ?? created.job_id ?? created.id ?? '');
    if (!jobId) fail('cut job id missing', 'ARTIFACT_MISSING');
    const completed = await this.poll(
      () => this.client.get(`/api/cut/status/${encodeURIComponent(jobId)}`),
      (value) => {
        const status = String(value.status ?? '').toUpperCase();
        if (['DONE', 'SUCCEEDED', 'SUCCESS', 'COMPLETED'].includes(status)) return 'success';
        if (['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(status)) return 'failed';
        return 'pending';
      },
      'cut'
    );
    const completedOutput = unwrapOutput(completed);
    const duration = Number(completedOutput.duration ?? completedOutput.outputDuration ?? completedOutput.output_duration);
    return { jobId, downloadUrl: `${this.baseUrl}/api/cut/download/${encodeURIComponent(jobId)}`, duration: Number.isFinite(duration) ? duration : null };
  }

  async reconcileSnapshot(projectId, taskId, body) {
    const claims = await this.getClaims();
    const claim = claims.find((item) => taskIdentity(item) === String(taskId));
    if (!claim) fail('claim disappeared before snapshot', 'ARTIFACT_MISSING');
    if (String(claim.snapshotId ?? claim.snapshot_id ?? '')) return { snapshotId: claim.snapshotId ?? claim.snapshot_id, created: false };
    let snapshot = null;
    let createError = null;
    try {
      snapshot = unwrapSnapshot(await this.client.post(`/api/projects/${encodeURIComponent(projectId)}/snapshots`, body));
    } catch (error) {
      createError = error;
    }
    if (snapshot && (snapshot.id || snapshot.snapshotId)) return { ...snapshot, created: true };
    const afterClaims = await this.getClaims();
    const after = afterClaims.find((item) => taskIdentity(item) === String(taskId));
    const snapshotId = after && (after.snapshotId ?? after.snapshot_id);
    if (!snapshotId) {
      if (createError) throw createError;
      fail('snapshot artifact missing after reconciliation', 'ARTIFACT_MISSING');
    }
    return { snapshotId, created: true, reconciled: true };
  }

  async run({ taskId, strategy, strategyVersion = STRATEGY_VERSION, claim: allowClaim, submit, speakerCount = 2, ledger, priorFeedback = [] }) {
    if (!taskId) fail('taskId is required', 'TASK_ID_REQUIRED');
    if (!(ledger instanceof Ledger)) fail('separate ledger is required', 'INVALID_LEDGER_SNAPSHOT');
    if (['SUBMITTED', 'TA_VISIBLE'].includes(ledger.current)) {
      const claims = await this.getClaims();
      const claim = claims.find((item) => taskIdentity(item) === String(taskId));
      if (!claim) fail('submitted claim is not visible', 'ARTIFACT_MISSING');
      const evidence = reviewEvidence(claim);
      if (!hasTaReviewEvidence(claim)) {
        return {
          state: WAITING_FOR_TA,
          taskId: String(taskId),
          strategy,
          strategyVersion,
          ...evidence,
          ledger: ledger.snapshot(),
        };
      }
      if (ledger.current === 'SUBMITTED') await this.transition(ledger, 'TA_VISIBLE', evidence);
      return {
        state: 'TA_VISIBLE',
        taskId: String(taskId),
        strategy,
        strategyVersion,
        ...evidence,
        ledger: ledger.snapshot(),
      };
    }
    await this.transition(ledger, 'AUTHED');
    const tasks = responseList(await this.client.get('/api/orders/tasks'));
    const task = tasks.find((item) => taskIdentity(item) === String(taskId));
    if (!task) fail(`task ${taskId} not found`, 'ARTIFACT_MISSING');
    const material = materialFromTask(task);
    await this.transition(ledger, 'BOOTSTRAPPED', { taskId: String(taskId) });
    const claim = await this.reconcileClaim(taskId, allowClaim);
    await this.transition(ledger, 'CLAIMED', { taskId: String(taskId), claimId: claimIdentity(claim) });
    assertClaimDeadline(ledger);
    const transcription = await this.transcribe(material, speakerCount);
    assertClaimDeadline(ledger);
    await this.transition(ledger, 'TRANSCRIBED', { transcriptionTaskId: transcription.taskId, sentenceCount: transcription.S.length });
    const plan = await this.plan(task, transcription.S, strategy, priorFeedback);
    assertClaimDeadline(ledger);
    await this.transition(ledger, 'PLANNED', { strategy, strategyVersion, decisionCount: plan.decisions.length });
    const artifacts = decisionsToArtifacts({ transcript: transcription.S, decisions: plan.decisions, audioUrl: material.audioUrl });
    const project = await this.reconcileProject(claim, task, material, transcription.S, artifacts.editState);
    assertClaimDeadline(ledger);
    const projectId = projectIdentity(project);
    if (!projectId) fail('project id missing', 'ARTIFACT_MISSING');
    const originalDuration = Math.max(...transcription.S.map((sentence) => sentence.e));
    const removedDuration = artifacts.cutPayload.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    const roughcutDuration = round3(originalDuration - removedDuration);
    const basePayload = {
      version: 'jinqian_m1',
      audioUrl: material.audioUrl,
      fileName: material.fileName,
      S: transcription.S,
      BLK: [],
      CHAPS: [],
      subtitlesWords: [],
      dispatchTask: { id: taskIdentity(task), claimId: claimIdentity(claim), title: String(task.title || ''), demand: task.demand ?? {} },
      editState: artifacts.editState,
    };
    await this.client.patch(`/api/projects/${encodeURIComponent(projectId)}`, {
      fileName: material.fileName,
      audioUrl: material.audioUrl,
      payload: basePayload,
      metrics: { originalDuration, roughcutDuration, removedDuration },
    });
    await this.transition(ledger, 'EDITED', { projectId });
    const cut = await this.cut(material, artifacts.cutPayload.segments, originalDuration);
    const cutTranscript = await this.transcribe({ audioUrl: cut.downloadUrl, storage: '', objectKey: '', fileName: material.fileName }, speakerCount);
    assertClaimDeadline(ledger);
    await this.transition(ledger, 'CUT_DONE', { cutJobId: cut.jobId, retranscribedSentenceCount: cutTranscript.S.length });
    const qa = qaPlan({ transcript: transcription.S, requirements: plan.requirements, decisions: plan.decisions, artifacts });
    const finalOutputQa = outputQa({
      transcript: cutTranscript.S,
      requirements: plan.requirements,
      plannedDuration: roughcutDuration,
      statusDuration: cut.duration,
      toleranceSeconds: this.durationToleranceSeconds,
    });
    qa.checks.push(...finalOutputQa.checks);
    const boundaryQa = buildSuspiciousBoundaryChecklist({ transcript: transcription.S, segments: artifacts.cutPayload.segments });
    qa.checks.push({
      id: 'suspicious-boundaries',
      pass: boundaryQa.pass,
      actual: boundaryQa.suspicious.length,
      expected: 'no high-risk suspicious boundary',
    });
    qa.boundaryEvidence = boundaryQa;
    qa.outputDuration = finalOutputQa.actualDuration;
    qa.pass = qa.checks.every((check) => check.pass);
    if (!qa.pass) fail('final QA failed; snapshot blocked', 'QA_FAILED', qa);
    await this.transition(ledger, 'QA_PASSED', { metrics: qa.metrics });
    if (!submit) fail('QA passed but submit was not approved', 'SUBMIT_APPROVAL_REQUIRED');
    assertClaimDeadline(ledger);
    const cutPayload = {
      version: 'roughcut_v1',
      audioUrl: material.audioUrl,
      segments: artifacts.cutPayload.segments,
      original_duration: originalDuration,
      roughcut_duration: roughcutDuration,
      removed_duration: removedDuration,
    };
    const snapshot = await this.reconcileSnapshot(projectId, taskId, {
      fileName: material.fileName,
      audioUrl: material.audioUrl,
      payload: basePayload,
      cutPayload,
      metrics: { originalDuration, roughcutDuration, removedDuration },
    });
    await this.transition(ledger, 'SUBMITTED', { projectId, snapshotId: snapshot.snapshotId ?? snapshot.id ?? null });
    const finalClaims = await this.getClaims();
    const finalClaim = finalClaims.find((item) => taskIdentity(item) === String(taskId));
    if (!finalClaim) fail('submitted claim is not visible', 'ARTIFACT_MISSING');
    const evidence = {
      taskId: String(taskId),
      projectId: projectIdentity(finalClaim) || projectId,
      snapshotId: finalClaim.snapshotId ?? finalClaim.snapshot_id ?? snapshot.snapshotId ?? snapshot.id ?? null,
      status: finalClaim.status ?? null,
      reviewNote: finalClaim.reviewNote ?? finalClaim.review_note ?? null,
      reviewedAt: finalClaim.reviewedAt ?? finalClaim.reviewed_at ?? null,
    };
    if (!hasTaReviewEvidence(finalClaim)) {
      return {
        state: WAITING_FOR_TA,
        taskId: String(taskId),
        strategy,
        strategyVersion,
        projectId,
        snapshotId: evidence.snapshotId,
        status: evidence.status,
        reviewNote: evidence.reviewNote,
        reviewedAt: evidence.reviewedAt,
        qa,
        ledger: ledger.snapshot(),
      };
    }
    await this.transition(ledger, 'TA_VISIBLE', evidence);
    return {
      state: 'TA_VISIBLE',
      taskId: String(taskId),
      strategy,
      strategyVersion,
      projectId,
      snapshotId: evidence.snapshotId,
      status: evidence.status,
      reviewNote: evidence.reviewNote,
      reviewedAt: evidence.reviewedAt,
      qa,
      ledger: ledger.snapshot(),
    };
  }
}

const ONBOARDING_VERSION = 'jianjian-onboarding-v1';
const ONBOARDING_WAITING_FOR_OTP = 'WAITING_FOR_OTP';

function maskPhoneNumber(phone) {
  const value = String(phone || '').trim();
  return /^1\d{10}$/.test(value) ? `${value.slice(0, 3)}****${value.slice(-4)}` : '[REDACTED]';
}

function generateDay1Intro(nickname = '金钱剪剪') {
  const name = String(nickname || '金钱剪剪').trim();
  const body = {
    nickname: name,
    field1: '我是金钱剪剪，一名按订单要求完成播客粗剪、复核和提交的 AI 剪辑学员。',
    field2: '我会先保护核心观点和叙事结构，再处理重复、口癖与低密度内容。',
    field3: '我适合目标时长明确、必须保留与必须删除要求清楚的播客订单。',
    field4: '每次交付前我会全量重转写成品、检查时长和内容要求，并把可疑剪辑边界列入机器抽查清单。',
  };
  return { ...body, confirmationHash: stableHash(body).slice(0, 16) };
}

function validateOnboardingInput(options = {}) {
  const nickname = String(options.nickname || '金钱剪剪').trim();
  if (!nickname || nickname.length > 30) fail('onboarding nickname must be 1-30 characters', 'INVALID_NICKNAME');
  const phone = String(options.phone || '').trim();
  if (!options.token && !/^1\d{10}$/.test(phone)) fail('explicit 11-digit phone is required without bearer token', 'PHONE_REQUIRED');
  const otp = String(options.otp || '').trim();
  if (otp && !/^\d{6}$/.test(otp)) fail('OTP must be exactly 6 digits', 'OTP_REQUIRED');
  return { nickname, phone, otp, intro: generateDay1Intro(nickname) };
}

class OnboardingProvider {
  constructor({
    baseUrl,
    token = '',
    fetchImpl = globalThis.fetch,
    maxPollAttempts = 20,
    pollIntervalMs = 1500,
    sleep,
  }) {
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/, '');
    this.token = String(token || '');
    this.fetchImpl = fetchImpl;
    this.maxPollAttempts = maxPollAttempts;
    this.pollIntervalMs = pollIntervalMs;
    this.sleep = sleep;
    this.client = new JsonClient({ baseUrl: this.baseUrl, token: this.token, fetchImpl });
  }

  setToken(token) {
    this.token = String(token || '');
    if (!this.token) fail('verify response has no bearer token', 'CREDENTIAL_REQUIRED');
    this.client.token = this.token;
  }

  async sendCode(phone) {
    const response = await this.client.post('/api/auth/send-code', { phone });
    if (!response || response.ok !== true) fail('send-code did not confirm success', 'ARTIFACT_MISSING');
    return { ok: true, cooldownSeconds: Number(response.cooldownSeconds || 0), expiresAt: String(response.expiresAt || '') };
  }

  async verify(phone, otp) {
    const response = await this.client.post('/api/auth/verify', { phone, code: otp });
    if (!response || !response.token || !response.user) fail('verify response missing token or user', 'ARTIFACT_MISSING');
    this.setToken(response.token);
    return response;
  }

  async getMe() {
    if (!this.token) fail('bearer token required', 'CREDENTIAL_REQUIRED');
    const response = await this.client.get('/api/auth/me');
    if (!response || !response.user) fail('auth/me response missing user', 'ARTIFACT_MISSING');
    return response.user;
  }

  async setNickname(nickname) {
    let response;
    let writeError;
    try {
      response = await this.client.post('/api/auth/set-nickname', { nickname });
    } catch (error) {
      writeError = error;
    }
    if ((!response || !response.user) && writeError) {
      const reconciled = await this.getMe();
      if (reconciled.nickname === nickname) return reconciled;
      throw writeError;
    }
    if (!response || !response.user || response.user.nickname !== nickname) fail('nickname was not persisted', 'ARTIFACT_MISSING');
    return response.user;
  }

  async completeDay1(intro) {
    const body = {
      nickname: String(intro.nickname || '').trim(),
      field1: String(intro.field1 || '').trim(),
      field2: String(intro.field2 || '').trim(),
      field3: String(intro.field3 || '').trim(),
      field4: String(intro.field4 || '').trim(),
    };
    if (!body.nickname || [body.field1, body.field2, body.field3, body.field4].some((field) => !field)) {
      fail('Day1 requires nickname and all four answers', 'DAY1_CONTENT_REQUIRED');
    }
    let response;
    let writeError;
    try {
      response = await this.client.post('/api/auth/complete-day1', body);
    } catch (error) {
      writeError = error;
    }
    if ((!response || !response.user) && writeError) {
      const reconciled = await this.getMe();
      const fields = reconciled.day1Intro && reconciled.day1Intro.fields;
      if (reconciled.day1Complete === true && Array.isArray(fields) && fields.length === 4 && fields.every((field, index) => field === body[`field${index + 1}`])) {
        return reconciled;
      }
      throw writeError;
    }
    if (!response || !response.user || response.user.day1Complete !== true) fail('Day1 completion not confirmed', 'ARTIFACT_MISSING');
    return response.user;
  }

  async listProjects() {
    return responseList(await this.client.get('/api/projects'));
  }

  async getProject(projectId) {
    const response = await this.client.get(`/api/projects/${encodeURIComponent(projectId)}`);
    if (!response || !response.project || !response.payload) fail('practice project detail missing', 'ARTIFACT_MISSING');
    return response;
  }

  async reconcilePracticeProject() {
    const find = async () => (await this.listProjects()).find((project) => String(project.fileName || '').includes('开营直播'));
    const existing = await find();
    if (existing) return existing;
    let created = null;
    let createError = null;
    try {
      created = unwrapProject(await this.client.post('/api/projects/practice/launch', {}));
    } catch (error) {
      createError = error;
    }
    if (projectIdentity(created)) return created;
    const reconciled = await find();
    if (reconciled) return reconciled;
    if (createError) throw createError;
    fail('practice project missing after reconciliation', 'ARTIFACT_MISSING');
  }

  v1() {
    if (!this.token) fail('bearer token required for Day2', 'CREDENTIAL_REQUIRED');
    return new V1Provider({
      baseUrl: this.baseUrl,
      token: this.token,
      fetchImpl: this.fetchImpl,
      maxPollAttempts: this.maxPollAttempts,
      pollIntervalMs: this.pollIntervalMs,
      sleep: this.sleep,
    });
  }

  async prepareDay2(projectSummary, strategy = 'structure_first') {
    const detail = await this.getProject(projectIdentity(projectSummary));
    const payload = detail.payload;
    const S = normalizeTranscript(payload.S);
    const material = {
      audioUrl: String(detail.project.audioUrl || payload.audioUrl || ''),
      storage: String(payload.storage || ''),
      objectKey: String(payload.objectKey || ''),
      fileName: String(detail.project.fileName || payload.fileName || 'D2 练习项目｜开营直播'),
    };
    if (!material.audioUrl) fail('practice audio missing', 'ARTIFACT_MISSING');
    const provider = this.v1();
    const task = { id: 'practice-launch', title: material.fileName, demand: { targetDuration: { min: 1500, max: 1800 } } };
    const plan = await provider.plan(task, S, strategy, []);
    const artifacts = decisionsToArtifacts({ transcript: S, decisions: plan.decisions, audioUrl: material.audioUrl });
    const originalDuration = Math.max(...S.map((sentence) => sentence.e));
    const removedDuration = artifacts.cutPayload.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    const roughcutDuration = round3(originalDuration - removedDuration);
    const updatedPayload = { ...payload, editState: artifacts.editState };
    await this.client.patch(`/api/projects/${encodeURIComponent(detail.project.id)}`, {
      fileName: material.fileName,
      audioUrl: material.audioUrl,
      payload: updatedPayload,
      metrics: { originalDuration, roughcutDuration, removedDuration },
    });
    const cut = await provider.cut(material, artifacts.cutPayload.segments, originalDuration);
    const output = await provider.transcribe({ audioUrl: cut.downloadUrl, storage: '', objectKey: '', fileName: material.fileName }, 2);
    const contentQa = outputQa({
      transcript: output.S,
      requirements: plan.requirements,
      plannedDuration: roughcutDuration,
      statusDuration: cut.duration,
    });
    const boundaryQa = buildSuspiciousBoundaryChecklist({ transcript: S, segments: artifacts.cutPayload.segments });
    const qa = {
      pass: contentQa.pass && boundaryQa.pass,
      mode: boundaryQa.mode,
      checks: [...contentQa.checks, { id: 'suspicious-boundaries', pass: boundaryQa.pass, actual: boundaryQa.suspicious.length }],
      boundaryEvidence: boundaryQa,
      metrics: { originalDuration, roughcutDuration, removedDuration, outputDuration: contentQa.actualDuration },
    };
    if (!qa.pass) fail('Day2 machine QA failed; snapshot blocked', 'QA_FAILED', qa);
    return {
      project: detail.project,
      payload: updatedPayload,
      qa,
      cutPayload: {
        version: 'roughcut_v1',
        audioUrl: material.audioUrl,
        segments: artifacts.cutPayload.segments,
        original_duration: originalDuration,
        roughcut_duration: roughcutDuration,
        removed_duration: removedDuration,
      },
      metrics: { originalDuration, roughcutDuration, removedDuration },
    };
  }

  async reconcileDay2Snapshot(prepared) {
    const before = await this.getMe();
    if (before.day2Complete === true) return { reconciled: true, user: before };
    const detail = await this.getProject(prepared.project.id);
    if (detail.project.status === 'pending_review') {
      const user = await this.getMe();
      if (user.day2Complete === true) return { reconciled: true, user };
      fail('project is pending review but Day2 is not unlocked', 'ARTIFACT_MISSING');
    }
    let snapshot = null;
    let createError = null;
    try {
      snapshot = unwrapSnapshot(await this.client.post(`/api/projects/${encodeURIComponent(prepared.project.id)}/snapshots`, {
        fileName: prepared.project.fileName,
        audioUrl: prepared.project.audioUrl,
        payload: prepared.payload,
        cutPayload: prepared.cutPayload,
        metrics: prepared.metrics,
      }));
    } catch (error) {
      createError = error;
    }
    if (snapshot && snapshot.id) return { snapshot, user: await this.getMe() };
    const after = await this.getMe();
    const afterProject = await this.getProject(prepared.project.id);
    if (after.day2Complete === true && afterProject.project.status === 'pending_review') return { reconciled: true, user: after };
    if (createError) throw createError;
    fail('Day2 snapshot missing after reconciliation', 'ARTIFACT_MISSING');
  }

  async getOrderAccess() {
    const user = await this.getMe();
    if (user.day2Complete !== true) fail('Day2 permission is not unlocked', 'DAY2_REQUIRED');
    const response = await this.client.get('/api/orders/tasks');
    if (!response || !Array.isArray(response.tasks)) fail('orders access not confirmed', 'ARTIFACT_MISSING');
    return { user, taskCount: response.tasks.length };
  }
}

class OnboardingRunner {
  constructor({ provider, checkpoint = async () => {} }) {
    if (!provider) fail('onboarding provider missing', 'PROVIDER_MISSING');
    this.provider = provider;
    this.checkpoint = checkpoint;
  }

  async save(state) {
    await this.checkpoint(sanitizeValue(state));
  }

  async run(options = {}) {
    const input = validateOnboardingInput({ ...options, token: this.provider.token || options.token });
    const state = {
      version: ONBOARDING_VERSION,
      state: 'STARTED',
      maskedPhone: this.provider.token ? null : maskPhoneNumber(input.phone),
      nickname: input.nickname,
      day1: { text: input.intro, confirmationHash: input.intro.confirmationHash },
      evidence: [],
    };
    let user;
    if (this.provider.token) {
      user = await this.provider.getMe();
      state.evidence.push({ step: 'AUTH_RECONCILED', userId: user.id });
    } else if (!input.otp) {
      if (!options.approveSendCode) fail('send-code requires --approve-send-code', 'SEND_CODE_APPROVAL_REQUIRED');
      const sent = await this.provider.sendCode(input.phone);
      state.state = ONBOARDING_WAITING_FOR_OTP;
      state.evidence.push({ step: 'CODE_SENT', cooldownSeconds: sent.cooldownSeconds, expiresAt: sent.expiresAt });
      await this.save(state);
      return state;
    } else {
      if (!options.approveVerify) fail('verify requires --approve-verify and explicit OTP', 'VERIFY_APPROVAL_REQUIRED');
      const verified = await this.provider.verify(input.phone, input.otp);
      user = verified.user;
      state.evidence.push({ step: 'VERIFIED', userId: user.id });
    }
    if (user.nickname !== input.nickname) {
      if (!options.approveNickname) fail('nickname write requires --approve-nickname', 'NICKNAME_APPROVAL_REQUIRED');
      user = await this.provider.setNickname(input.nickname);
      state.evidence.push({ step: 'NICKNAME_SET' });
    }
    if (user.day1Complete !== true) {
      if (!options.approveDay1) fail('Day1 write requires --approve-day1', 'DAY1_APPROVAL_REQUIRED');
      if (String(options.confirmDay1Hash || '') !== input.intro.confirmationHash) fail('Day1 confirmation hash mismatch', 'DAY1_CONFIRMATION_REQUIRED');
      user = await this.provider.completeDay1(input.intro);
      state.evidence.push({ step: 'DAY1_COMPLETE', confirmationHash: input.intro.confirmationHash });
    }
    if (user.day2Complete !== true) {
      if (!options.approveDay2Submit) fail('Day2 snapshot requires --approve-day2-submit', 'DAY2_APPROVAL_REQUIRED');
      const practice = await this.provider.reconcilePracticeProject();
      const prepared = await this.provider.prepareDay2(practice, options.strategy || 'structure_first');
      const submitted = await this.provider.reconcileDay2Snapshot(prepared);
      user = submitted.user;
      state.evidence.push({
        step: 'DAY2_SUBMITTED',
        projectId: practice.id,
        snapshotId: submitted.snapshot && submitted.snapshot.id || null,
        machineQa: machineQaSummary(prepared.qa),
        boundaryEvidence: prepared.qa.boundaryEvidence,
      });
    }
    const access = await this.provider.getOrderAccess();
    state.state = 'ORDERS_UNLOCKED';
    state.day1Complete = access.user.day1Complete === true;
    state.day2Complete = access.user.day2Complete === true;
    state.orderTaskCount = access.taskCount;
    await this.save(state);
    return state;
  }
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function csvList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeBatchPlan(input = {}) {
  const taskIds = csvList(input.taskIds);
  if (taskIds.length < 3 || taskIds.length > 5) fail('batch requires 3 to 5 taskIds', 'INVALID_BATCH_SIZE');
  if (new Set(taskIds).size !== taskIds.length) fail('batch taskIds must be distinct', 'DUPLICATE_TASK_ID');
  const approvedTaskIds = csvList(input.approvedTaskIds);
  if (approvedTaskIds.length !== taskIds.length || approvedTaskIds.some((id, index) => id !== taskIds[index])) {
    fail('approved taskIds must exactly match taskIds in order', 'BATCH_APPROVAL_MISMATCH');
  }
  const requestedStrategies = csvList(input.strategies);
  const defaults = ['structure_first', 'density_first', 'audience_retention'];
  const strategies = requestedStrategies.length
    ? requestedStrategies
    : taskIds.map((_, index) => defaults[index % defaults.length]);
  if (strategies.length !== taskIds.length) fail('strategies must exactly match taskIds count', 'INVALID_STRATEGY_SEQUENCE');
  for (const strategy of strategies) if (!STRATEGIES[strategy]) fail(`unknown strategy: ${strategy}`, 'UNKNOWN_STRATEGY');
  const strategyVersion = String(input.strategyVersion || STRATEGY_VERSION);
  if (!strategyVersion.trim()) fail('strategyVersion is required', 'STRATEGY_VERSION_REQUIRED');
  return {
    taskIds,
    approvedTaskIds,
    strategies,
    strategyVersion,
    batchId: String(input.batchId || stableHash({ taskIds, strategies, strategyVersion }).slice(0, 20)),
  };
}

function hasTaReviewEvidence(value) {
  if (!value || typeof value !== 'object') return false;
  const status = String(value.status || '').trim().toLowerCase();
  return Boolean(
    String(value.reviewedAt ?? value.reviewed_at ?? '').trim()
    || String(value.reviewNote ?? value.review_note ?? '').trim()
    || status === 'reviewed'
  );
}

function assertClaimDeadline(ledger, now = Date.now()) {
  if (!(ledger instanceof Ledger)) fail('ledger is required for claim deadline', 'INVALID_LEDGER_SNAPSHOT');
  const claimed = ledger.entries.find((entry) => entry.state === 'CLAIMED');
  if (!claimed) return null;
  const claimedAt = Date.parse(claimed.at);
  if (!Number.isFinite(claimedAt)) fail('CLAIMED timestamp is invalid', 'INVALID_LEDGER_SNAPSHOT');
  const deadlineAt = claimedAt + CLAIM_DEADLINE_MS;
  const elapsedMs = Number(now) - claimedAt;
  if (Number(now) >= deadlineAt) {
    fail('48-hour claim deadline exceeded', 'CLAIM_DEADLINE_EXCEEDED', {
      blocker: 'CLAIM_DEADLINE_EXCEEDED',
      claimedAt: new Date(claimedAt).toISOString(),
      deadlineAt: new Date(deadlineAt).toISOString(),
      currentState: ledger.current,
      action: 'Do not continue writes; return order to manual reconciliation.',
    });
  }
  const status = elapsedMs >= 36 * 60 * 60 * 1000
    ? 'FREEZE_EXTRA_OPTIMIZATION'
    : elapsedMs >= 24 * 60 * 60 * 1000
      ? 'WARNING'
      : 'ON_TRACK';
  return {
    status,
    claimedAt: new Date(claimedAt).toISOString(),
    deadlineAt: new Date(deadlineAt).toISOString(),
    elapsedHours: round3(elapsedMs / (60 * 60 * 1000)),
    freezeExtraOptimization: status === 'FREEZE_EXTRA_OPTIMIZATION',
    reportRequired: status !== 'ON_TRACK',
  };
}

function buildSuspiciousBoundaryChecklist({ transcript, segments }) {
  const S = normalizeTranscript(transcript);
  const words = S.flatMap((sentence) => list(sentence.w).map((word) => ({
    start: Number(word.s),
    end: Number(word.e),
    sentenceIdx: sentence.idx,
  }))).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  const cuts = mergeSegments(segments || []);
  const items = [];
  cuts.forEach((cut, index) => {
    if (cut.end - cut.start < 0.04) items.push({ index, severity: 'high', reason: '删除段短于40ms，可能产生点击声', start: cut.start, end: cut.end });
    for (const [edge, value] of [['start', cut.start], ['end', cut.end]]) {
      const word = words.find((item) => value > item.start + 0.08 && value < item.end - 0.08);
      if (word) items.push({ index, severity: 'review', reason: `${edge}边界位于词内`, at: value, sentenceIdx: word.sentenceIdx });
    }
    const next = cuts[index + 1];
    if (next) {
      const retainedGap = next.start - cut.end;
      if (retainedGap > 0.08 && retainedGap < 0.12) {
        items.push({ index, severity: 'high', reason: '相邻删除段之间仅保留80–120ms碎片', start: cut.end, end: next.start });
      } else if (retainedGap >= 0.12 && retainedGap < 0.25) {
        items.push({ index, severity: 'review', reason: '相邻删除段之间保留片段短于250ms', start: cut.end, end: next.start });
      }
    }
  });
  return {
    mode: 'machine-full-retranscription-plus-suspicious-boundary-list',
    pass: !items.some((item) => item.severity === 'high'),
    checkedBoundaryCount: cuts.length * 2,
    suspicious: items,
  };
}

function machineQaSummary(qa) {
  if (!qa || typeof qa !== 'object') return null;
  return {
    pass: Boolean(qa.pass),
    metrics: qa.metrics && typeof qa.metrics === 'object' ? sanitizeValue(qa.metrics) : null,
    checks: list(qa.checks).map((check) => ({
      id: String(check && check.id || ''),
      pass: Boolean(check && check.pass),
      ...(check && check.actual !== undefined ? { actual: check.actual } : {}),
      ...(check && check.expected !== undefined ? { expected: check.expected } : {}),
    })),
  };
}

function reviewEvidence(value) {
  return {
    status: value && value.status != null ? String(value.status) : '',
    reviewNote: value && (value.reviewNote ?? value.review_note) != null ? String(value.reviewNote ?? value.review_note) : '',
    reviewedAt: value && (value.reviewedAt ?? value.reviewed_at) != null ? String(value.reviewedAt ?? value.reviewed_at) : '',
    projectId: value && (value.projectId ?? value.project_id) != null ? String(value.projectId ?? value.project_id) : '',
    snapshotId: value && (value.snapshotId ?? value.snapshot_id) != null ? String(value.snapshotId ?? value.snapshot_id) : '',
  };
}

function crossRunLearning(previousRun) {
  if (!previousRun) return [];
  const feedback = previousRun.evidence && previousRun.evidence.taReview;
  const qa = previousRun.evidence && previousRun.evidence.machineQa;
  const learning = [];
  if (feedback) {
    learning.push(`上一单助教证据：${JSON.stringify({
      status: feedback.status || '',
      reviewNote: feedback.reviewNote || '',
      reviewedAt: feedback.reviewedAt || '',
    })}`);
  }
  if (qa) learning.push(`上一单机器 QA 摘要：${JSON.stringify(qa)}`);
  const serialized = JSON.stringify(learning);
  if (/"(?:transcript|body|S)"\s*:/i.test(serialized)) fail('cross-run learning contains transcript body', 'CROSS_RUN_BODY_FORBIDDEN');
  return learning;
}

function appendRunEvidence(run, kind, value) {
  run.evidenceHistory ||= [];
  const clean = sanitizeValue(value);
  const fingerprint = stableHash({ kind, value: clean });
  if (!run.evidenceHistory.some((event) => event.fingerprint === fingerprint)) {
    run.evidenceHistory.push({
      sequence: run.evidenceHistory.length + 1,
      kind,
      fingerprint,
      value: clean,
    });
  }
  return clean;
}

class BatchOrchestrator {
  constructor({ provider, checkpoint = async () => {} }) {
    if (!provider || typeof provider.run !== 'function') fail('batch provider missing', 'PROVIDER_MISSING');
    if (typeof checkpoint !== 'function') fail('batch checkpoint missing', 'PROVIDER_MISSING');
    this.provider = provider;
    this.checkpoint = checkpoint;
  }

  initialState(plan) {
    return {
      version: 1,
      batchId: plan.batchId,
      strategyVersion: plan.strategyVersion,
      taskIds: [...plan.taskIds],
      approvedTaskIds: [...plan.approvedTaskIds],
      strategies: [...plan.strategies],
      state: 'READY',
      runs: [],
    };
  }

  resumeState(plan, snapshot) {
    if (!snapshot) return this.initialState(plan);
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.runs)) fail('invalid batch checkpoint', 'INVALID_BATCH_CHECKPOINT');
    for (const key of ['batchId', 'strategyVersion']) {
      if (String(snapshot[key]) !== String(plan[key])) fail(`batch checkpoint ${key} mismatch`, 'BATCH_CHECKPOINT_MISMATCH');
    }
    for (const key of ['taskIds', 'approvedTaskIds', 'strategies']) {
      if (JSON.stringify(snapshot[key]) !== JSON.stringify(plan[key])) fail(`batch checkpoint ${key} mismatch`, 'BATCH_CHECKPOINT_MISMATCH');
    }
    const seen = new Set();
    snapshot.runs.forEach((run, index) => {
      if (!run || run.taskId !== plan.taskIds[index] || seen.has(run.taskId)) fail('batch checkpoint reuses or reorders an order', 'BATCH_CHECKPOINT_MISMATCH');
      seen.add(run.taskId);
    });
    return JSON.parse(JSON.stringify(snapshot));
  }

  async save(state) {
    await this.checkpoint(JSON.parse(JSON.stringify(state)));
  }

  async refreshTa(run) {
    if (typeof this.provider.getClaims !== 'function') return run;
    const claims = await this.provider.getClaims();
    const claim = claims.find((item) => taskIdentity(item) === String(run.taskId));
    if (!claim) return run;
    run.evidence ||= {};
    run.evidence.taReview = appendRunEvidence(run, 'ta_review', reviewEvidence(claim));
    if (hasTaReviewEvidence(claim)) {
      const ledger = new Ledger(run.ledger || null);
      if (ledger.current === 'SUBMITTED') ledger.transition('TA_VISIBLE', run.evidence.taReview);
      run.ledger = ledger.snapshot();
      run.state = 'TA_VISIBLE';
    }
    return run;
  }

  async run(input, snapshot = null) {
    const plan = normalizeBatchPlan(input);
    const state = this.resumeState(plan, snapshot);
    for (let index = 0; index < plan.taskIds.length; index += 1) {
      if (index > 0) {
        const previous = await this.refreshTa(state.runs[index - 1]);
        if (!previous || previous.state !== 'TA_VISIBLE' || !hasTaReviewEvidence(previous.evidence && previous.evidence.taReview)) {
          state.state = WAITING_FOR_TA;
          state.waitingForTaskId = plan.taskIds[index - 1];
          state.nextTaskId = plan.taskIds[index];
          await this.save(state);
          return state;
        }
      }
      let run = state.runs[index];
      if (run && run.state === WAITING_FOR_TA) {
        run = await this.refreshTa(run);
        if (run.state === 'TA_VISIBLE' && hasTaReviewEvidence(run.evidence && run.evidence.taReview)) {
          await this.save(state);
          continue;
        }
      }
      if (run && run.state === 'TA_VISIBLE' && hasTaReviewEvidence(run.evidence && run.evidence.taReview)) continue;
      if (!run) {
        run = {
          runId: `${plan.batchId}-${index + 1}-${plan.taskIds[index]}`,
          taskId: plan.taskIds[index],
          strategy: plan.strategies[index],
          strategyVersion: plan.strategyVersion,
          state: 'READY',
          ledger: new Ledger().snapshot(),
          evidence: { machineQa: null, taReview: null },
          evidenceHistory: [],
        };
        state.runs.push(run);
        await this.save(state);
      }
      const ledger = new Ledger(run.ledger);
      const previousCheckpoint = this.provider.checkpoint;
      if (typeof previousCheckpoint === 'function') {
        this.provider.checkpoint = async (ledgerSnapshot) => {
          run.ledger = JSON.parse(JSON.stringify(ledgerSnapshot));
          await this.save(state);
        };
      }
      let result;
      try {
        result = await this.provider.run({
          taskId: run.taskId,
          strategy: run.strategy,
          strategyVersion: run.strategyVersion,
          claim: true,
          submit: true,
          ledger,
          priorFeedback: crossRunLearning(state.runs[index - 1]),
        });
      } finally {
        if (typeof previousCheckpoint === 'function') this.provider.checkpoint = previousCheckpoint;
      }
      run.ledger = result.ledger || ledger.snapshot();
      run.evidence.machineQa = appendRunEvidence(run, 'machine_qa', machineQaSummary(result.qa));
      run.evidence.taReview = appendRunEvidence(run, 'ta_review', reviewEvidence(result));
      run.evidence.projectId = result.projectId == null ? '' : String(result.projectId);
      run.evidence.snapshotId = result.snapshotId == null ? '' : String(result.snapshotId);
      appendRunEvidence(run, 'artifacts', {
        projectId: run.evidence.projectId,
        snapshotId: run.evidence.snapshotId,
      });
      run.state = result.state === WAITING_FOR_TA || !hasTaReviewEvidence(result) ? WAITING_FOR_TA : 'TA_VISIBLE';
      await this.save(state);
      if (run.state !== 'TA_VISIBLE') {
        state.state = WAITING_FOR_TA;
        state.waitingForTaskId = run.taskId;
        state.nextTaskId = plan.taskIds[index + 1] || null;
        await this.save(state);
        return state;
      }
    }
    state.state = 'COMPLETE';
    state.waitingForTaskId = null;
    state.nextTaskId = null;
    await this.save(state);
    return state;
  }
}

module.exports = {
  STRATEGIES,
  STRATEGY_VERSION,
  WAITING_FOR_TA,
  CLAIM_DEADLINE_MS,
  ONBOARDING_VERSION,
  ONBOARDING_WAITING_FOR_OTP,
  PLANNER_SCHEMA,
  LEDGER_STATES,
  TRANSITIONS,
  Ledger,
  normalizeTranscript,
  normalizeRequirements,
  chunkTranscript,
  buildPlannerPrompt,
  injectPriorFeedback,
  validatePlannerOutput,
  decisionsToArtifacts,
  mergeSegments,
  qaPlan,
  buildAuditRecord,
  sanitizeValue,
  sanitizeLedgerMetadata,
  redactSecrets,
  NON_PRODUCTION_ORIGINS,
  isProductionUrl,
  assertSafetyGates,
  JsonClient,
  V1Provider,
  dashscopeToV1S,
  parseAiJson,
  materialFromTask,
  unwrapOutput,
  unwrapClaim,
  unwrapProject,
  unwrapSnapshot,
  normalizeTaskRequirements,
  outputQa,
  buildSuspiciousBoundaryChecklist,
  maskPhoneNumber,
  generateDay1Intro,
  validateOnboardingInput,
  OnboardingProvider,
  OnboardingRunner,
  normalizeBatchPlan,
  hasTaReviewEvidence,
  assertClaimDeadline,
  machineQaSummary,
  reviewEvidence,
  crossRunLearning,
  appendRunEvidence,
  BatchOrchestrator,
  reconcileBeforeCreate,
  snapshotBeforeMutation,
  stableHash,
};
