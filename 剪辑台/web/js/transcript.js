export function getAliyunSentences(aliyunData) {
  const transcripts = aliyunData?.transcripts;
  const sentences = transcripts?.[0]?.sentences;
  if (!Array.isArray(sentences)) {
    throw new Error('阿里云转录结果格式不符合预期：缺少 transcripts[0].sentences');
  }
  return sentences;
}

export function buildSpeakerGroups(aliyunData, perSpeaker = 3) {
  const sentences = getAliyunSentences(aliyunData);
  const groups = new Map();

  sentences.forEach((sentence) => {
    const id = String(sentence.speaker_id ?? '0');
    if (!groups.has(id)) groups.set(id, []);
    const examples = groups.get(id);
    if (examples.length < perSpeaker) {
      examples.push({
        text: sentence.text || sentence.words?.map((word) => word.text + (word.punctuation || '')).join('') || '',
        time: (sentence.begin_time || 0) / 1000,
      });
    }
  });

  return Array.from(groups.entries())
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([speakerId, examples]) => ({ speakerId, examples }));
}

export function generateSubtitlesWords(aliyunData, speakerMapping = {}) {
  const sentences = getAliyunSentences(aliyunData);
  const words = [];

  sentences.forEach((sentence, index) => {
    const speakerId = String(sentence.speaker_id ?? '0');
    const speakerName = speakerMapping[speakerId] || `Speaker ${speakerId}`;
    const start = msToSec(sentence.begin_time);
    const end = msToSec(sentence.end_time);

    if (index === 0 || String(sentences[index - 1].speaker_id ?? '0') !== speakerId) {
      words.push({
        t: `[${speakerName}]`,
        text: `[${speakerName}]`,
        s: start,
        e: start,
        start,
        end: start,
        sp: speakerName,
        speaker: speakerName,
        isGap: false,
        isSpeakerLabel: true,
      });
    }

    (sentence.words || []).forEach((word) => {
      const text = `${word.text || ''}${word.punctuation || ''}`;
      words.push({
        t: text,
        text,
        s: msToSec(word.begin_time),
        e: msToSec(word.end_time),
        start: msToSec(word.begin_time),
        end: msToSec(word.end_time),
        sp: speakerName,
        speaker: speakerName,
        isGap: false,
      });
    });

    if (index < sentences.length - 1) {
      const nextStart = msToSec(sentences[index + 1].begin_time);
      const gap = nextStart - end;
      if (gap >= 0.5) {
        words.push({
          t: '',
          text: '',
          s: end,
          e: nextStart,
          start: end,
          end: nextStart,
          isGap: true,
        });
      }
    }
  });

  return words;
}

export function generateSentences(aliyunData, speakerMapping = {}) {
  return getAliyunSentences(aliyunData).map((sentence, index) => {
    const speakerId = String(sentence.speaker_id ?? '0');
    const speaker = speakerMapping[speakerId] || `Speaker ${speakerId}`;
    const words = (sentence.words || []).map((word) => ({
      t: `${word.text || ''}${word.punctuation || ''}`,
      s: msToSec(word.begin_time),
      e: msToSec(word.end_time),
    }));
    const text = sentence.text || words.map((word) => word.t).join('');

    return {
      idx: index,
      speaker,
      text,
      startTime: msToSec(sentence.begin_time),
      endTime: msToSec(sentence.end_time),
      words,
    };
  });
}

export function buildReviewPayload(sentences, {
  blocks = [],
  chapters,
  audioUrl,
  fileName,
  subtitlesWords,
} = {}) {
  const S = sentences.map((sentence) => ({
    idx: sentence.idx,
    sp: sentence.speaker,
    t: sentence.text,
    s: round3(sentence.startTime),
    e: round3(sentence.endTime),
    ts: formatTime(sentence.startTime),
    w: sentence.words.map((word) => ({
      t: word.t,
      s: round3(word.s),
      e: round3(word.e),
    })),
  }));

  return {
    version: 'jinqian_m1',
    createdAt: new Date().toISOString(),
    audioUrl,
    fileName,
    S,
    BLK: normalizeBlocks(blocks),
    CHAPS: chapters || autoChapters(S),
    subtitlesWords,
  };
}

function normalizeBlocks(blocks) {
  return blocks.map((block, index) => ({
    id: block.id ?? index,
    r: block.r || block.range || [block.startIdx, block.endIdx],
    type: block.type || 'low_density',
    reason: block.reason || '',
    dur: block.dur || block.duration || '',
  }));
}

function autoChapters(S) {
  if (!S.length) return [];
  const count = Math.min(8, Math.max(1, Math.ceil(S.length / 40)));
  const step = Math.max(1, Math.ceil(S.length / count));
  const chapters = [];
  for (let i = 0; i < S.length; i += step) {
    chapters.push({
      startIdx: S[i].idx,
      time: S[i].ts,
      title: S[i].t.slice(0, 28) || `第 ${chapters.length + 1} 节`,
      desc: '',
    });
  }
  return chapters;
}

function msToSec(ms) {
  return round3((Number(ms) || 0) / 1000);
}

function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
