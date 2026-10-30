// 出站语音合成（TTS）：让大肥鱼「开口说话」。
//
// 本模块只负责「文字 → 一段可以当 QQ 语音条发出去的音频」，不碰会话、限流和发送：
//   prepareSpeechText  把模型写的聊天文本整理成适合朗读的句子（去 Markdown/链接/emoji/颜文字、
//                      保留或剔除括号标签、补换气逗号与句末标点）
//   createTtsService   调用服务商合成，并做时长/体积校验与首尾静音裁剪
// 服务商：mimo（默认，小米 MiMo-V2.5-TTS）/ doubao（火山豆包语音 V3）/ openai（任何 OpenAI 兼容
// `/audio/speech`：OpenAI、硅基流动 CosyVoice2/IndexTTS2、本地 mlx-audio 等）/ gptsovits（本地 api_v2）。
//
// 设计参考与出处（MIT 项目的思路做了 JS 移植，AGPL 项目只参考设计、不复制代码）：
// （被移植的 MIT 项目的版权声明按许可证要求保留在仓库根目录 NOTICE.md「Voice I/O」一节。）
//   - Emilia-awa / Liccsu「maibot-mimotts-voice」text_processor.py（MIT）：
//       Markdown/URL/emoji/颜文字清洗、短括号保留为音频标签、长括号旁白剔除、风格标签归位到开头、
//       语气词优先的自动断句（_soft_break）、句末补标点（_ensure_terminal）——本文件 prepareSpeechText 的主体。
//       https://github.com/Liccsu/maibot-mimotts-voice
//   - SoulString-Dev「maibot-mimo-voice」（MIT，上游 Ling-LA/ling-tts-bot）：
//       ～/省略号折成逗号、去首尾引号（实测这些符号会让合成音高漂移 2–4 个半音）；风格指令放 user 消息
//       稳定音高；固定参考音频 voiceclone 保证音色一致；可重试状态码集合；过小音频视为失败；首尾静音裁剪。
//       https://github.com/SoulString-Dev/maibot-mimo-voice
//   - ZhaoCang-QWQ「doubao-tts」（MIT）：豆包 V3 单向流式接口的请求格式、NDJSON 解析与情感映射。
//       https://github.com/ZhaoCang-QWQ/doubao-tts
//   - xuqian13「tts_voice_plugin」、CGl123「gpt-sovits-voice-plugin」：GPT-SoVITS 按情绪切换参考音频的做法。
//       https://github.com/xuqian13/tts_voice_plugin  https://github.com/CGl123/gpt-sovits-voice-plugin
//   - AstrBot（AGPL-3.0）`openai_tts_api_source.py` / `mimo_tts_api_source.py`：多服务商抽象的设计参考。
//       https://github.com/AstrBotDevs/AstrBot
//   - MiMo 官方文档（请求格式、预置音色、音频标签）：
//       https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SPEAK_PROVIDERS = ['cosyvoice', 'mimo', 'doubao', 'openai', 'gptsovits'];

// 统一的情绪词表（工具参数用）。各服务商在 mapEmotion 里各自翻译。
export const SPEAK_EMOTIONS = ['开心', '难过', '生气', '惊讶', '害怕', '温柔', '撒娇', '无奈', '委屈', '兴奋', '慵懒', '俏皮', '平静', '嫌弃', '小声'];

// MiMo 官方「风格标签」词表（文档 2026-07-15 版）。命中的括号标签会被提到文本最开头。
export const MIMO_STYLE_WORDS = new Set([
  '开心', '悲伤', '愤怒', '恐惧', '惊讶', '兴奋', '委屈', '平静', '冷漠',
  '怅然', '欣慰', '无奈', '愧疚', '释然', '嫉妒', '厌倦', '忐忑', '动情',
  '温柔', '高冷', '活泼', '严肃', '慵懒', '俏皮', '深沉', '干练', '凌厉',
  '磁性', '醇厚', '清亮', '空灵', '稚嫩', '苍老', '甜美', '沙哑', '醇雅',
  '夹子音', '御姐音', '正太音', '大叔音', '台湾腔',
  '东北话', '四川话', '河南话', '粤语', '唱歌', 'sing', 'singing'
]);

// SoulString-Dev 实测：把风格指令放在 user 消息里，同文本多次合成的音高离散度从 σ≈35Hz 降到 σ≈6–14Hz。
export const DEFAULT_MIMO_STYLE = '用同一个人的音色自然地说话，像在 QQ 上随口发语音，语速平稳，情绪自然，不要夸张，不要拖长尾音。';

export const SPEAK_DEFAULTS = Object.freeze({
  enabled: false,              // 总开关：需要先配好服务商与 API Key
  provider: 'cosyvoice',
  maxChars: 80,                // 单条语音最多读多少字（清洗后）；超出直接拒绝，让模型改成打字
  maxSeconds: 30,
  timeoutMs: 30000,
  maxPerMinute: 2,
  maxPerHour: 20,
  dailyCharBudget: 0,          // 每日合成字数上限（0=不限）；按量计费的服务商用它兜底成本
  trimSilence: true,
  allowEmotion: true,
  // 发音替换：TTS 前端经常把英文名按中文拼音/字母读错。键不区分大小写，
  // 只替换独立单词（不会把 Yukiko 里的 Yuki 换掉）。
  pronunciations: Object.freeze({ Yuki: '优key' }),
  // 随机把短句文字改成语音发出（MaiBot 生态 random_llm 模式；AstrBot 的 trigger_probability）
  autoConvert: Object.freeze({
    enabled: false,
    probability: 0.05,         // SoulString-Dev 默认 0.05：少量、短句
    mirrorProbability: 0.35,   // 对方刚发过语音时的概率（「你发语音我也回语音」）
    mirrorWindowMs: 10 * 60 * 1000,
    minChars: 2,
    maxChars: 40,
    cooldownMs: 3 * 60 * 1000, // 同一会话两次自动语音的最小间隔
    privateOnly: false,
    timeoutMs: 15000           // 自动转换的合成预算更紧：超时就照常发文字
  }),
  mimo: Object.freeze({
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: '冰糖',               // 预置音色：冰糖/茉莉（女）、苏打/白桦（男）、Mia/Chloe/Milo/Dean（英文）
    format: 'wav',
    apiKey: '',
    apiKeyEnv: 'MIMO_API_KEY',
    styleInstruction: DEFAULT_MIMO_STYLE,
    cloneAudio: '',            // 参考音频（mp3/wav，≤7MB）。设置后自动改用 mimo-v2.5-tts-voiceclone
    voiceDesign: '',           // 音色描述。设置后先用 voicedesign 生成一次参考音频并缓存，之后都用 voiceclone 复刻，保证音色一致
    designSampleText: '嗯，我在呢。今天群里好热闹啊，你们在聊什么呀？'
  }),
  doubao: Object.freeze({
    url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    apiKey: '',
    apiKeyEnv: 'DOUBAO_TTS_API_KEY',
    resourceId: 'seed-tts-2.0', // 预置音色用 seed-tts-2.0；复刻音色（S_ 开头）用 seed-icl-2.0
    speaker: 'zh_female_vv_uranus_bigtts',
    format: 'mp3',
    sampleRate: 24000,
    speechRate: 0,
    emotionScale: 3
  }),
  openai: Object.freeze({
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',
    format: 'wav',
    speed: 1,
    apiKey: '',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    // 可选：把情绪写进 input 的模板。CosyVoice2 示例：'用{emotion}的语气说<|endofprompt|>{text}'
    instructTemplate: ''
  }),
  gptsovits: Object.freeze({
    baseUrl: 'http://127.0.0.1:9880',
    textLang: 'zh',
    format: 'wav',
    // 按情绪切换参考音频：{ "default": { "audio": "绝对路径.wav", "text": "参考音频原文", "lang": "zh" }, "开心": {...} }
    refs: Object.freeze({})
  }),
  // 百炼 DashScope CosyVoice 3.5：远程 TTS，不占本机模型内存。
  // 音色先用百炼控制台/API 的声音设计或复刻创建，把 voiceId 填进来。
  cosyvoice: Object.freeze({
    baseUrl: '',              // 可留空，由 workspaceId + region 拼
    workspaceId: '',
    region: 'cn-beijing',
    apiKey: '',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    model: 'cosyvoice-v3.5-flash',
    voiceId: '',
    format: 'wav',
    sampleRate: 24000,
    instruction: '',
    timeoutMs: 30000
  })
});

function num(v, fallback, { min = -Infinity, max = Infinity, int = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

/** 合并 socialV2.speak 与默认值并收敛类型。返回的对象可以安全地 JSON 化（apiKey 会被 redactSpeakConfig 去掉）。 */
export function normalizeSpeakConfig(raw = {}) {
  const r = obj(raw);
  const a = obj(r.autoConvert);
  const m = obj(r.mimo);
  const d = obj(r.doubao);
  const o = obj(r.openai);
  const g = obj(r.gptsovits);
  const cv = obj(r.cosyvoice);
  const D = SPEAK_DEFAULTS;
  return {
    enabled: r.enabled === true,
    provider: SPEAK_PROVIDERS.includes(r.provider) ? r.provider : D.provider,
    maxChars: num(r.maxChars, D.maxChars, { min: 5, max: 500, int: true }),
    maxSeconds: num(r.maxSeconds, D.maxSeconds, { min: 2, max: 120 }),
    timeoutMs: num(r.timeoutMs, D.timeoutMs, { min: 3000, max: 120000, int: true }),
    maxPerMinute: num(r.maxPerMinute, D.maxPerMinute, { min: 0, max: 60, int: true }),
    maxPerHour: num(r.maxPerHour, D.maxPerHour, { min: 0, max: 1000, int: true }),
    dailyCharBudget: num(r.dailyCharBudget, D.dailyCharBudget, { min: 0, max: 10_000_000, int: true }),
    trimSilence: r.trimSilence !== false,
    allowEmotion: r.allowEmotion !== false,
    pronunciations: (() => {
      const merged = { ...D.pronunciations };
      for (const [key, value] of Object.entries(obj(r.pronunciations))) {
        const k = String(key ?? '').trim();
        const v = String(value ?? '').trim();
        if (k && v && k.length <= 40 && v.length <= 40) merged[k] = v;
      }
      return merged;
    })(),
    autoConvert: {
      enabled: a.enabled === true,
      probability: num(a.probability, D.autoConvert.probability, { min: 0, max: 1 }),
      mirrorProbability: num(a.mirrorProbability, D.autoConvert.mirrorProbability, { min: 0, max: 1 }),
      mirrorWindowMs: num(a.mirrorWindowMs, D.autoConvert.mirrorWindowMs, { min: 0, max: 86_400_000, int: true }),
      minChars: num(a.minChars, D.autoConvert.minChars, { min: 1, max: 200, int: true }),
      maxChars: num(a.maxChars, D.autoConvert.maxChars, { min: 2, max: 500, int: true }),
      cooldownMs: num(a.cooldownMs, D.autoConvert.cooldownMs, { min: 0, max: 86_400_000, int: true }),
      privateOnly: a.privateOnly === true,
      timeoutMs: num(a.timeoutMs, D.autoConvert.timeoutMs, { min: 2000, max: 60000, int: true })
    },
    mimo: {
      baseUrl: str(m.baseUrl, D.mimo.baseUrl).replace(/\/+$/, '') || D.mimo.baseUrl,
      model: str(m.model, D.mimo.model) || D.mimo.model,
      voice: str(m.voice, D.mimo.voice) || D.mimo.voice,
      format: ['wav', 'mp3'].includes(m.format) ? m.format : D.mimo.format,
      apiKey: str(m.apiKey),
      apiKeyEnv: str(m.apiKeyEnv, D.mimo.apiKeyEnv) || D.mimo.apiKeyEnv,
      styleInstruction: typeof m.styleInstruction === 'string' ? m.styleInstruction : D.mimo.styleInstruction,
      cloneAudio: str(m.cloneAudio).trim(),
      voiceDesign: str(m.voiceDesign).trim(),
      designSampleText: str(m.designSampleText, D.mimo.designSampleText) || D.mimo.designSampleText
    },
    doubao: {
      url: str(d.url, D.doubao.url) || D.doubao.url,
      apiKey: str(d.apiKey),
      apiKeyEnv: str(d.apiKeyEnv, D.doubao.apiKeyEnv) || D.doubao.apiKeyEnv,
      resourceId: str(d.resourceId, D.doubao.resourceId) || D.doubao.resourceId,
      speaker: str(d.speaker, D.doubao.speaker) || D.doubao.speaker,
      format: ['mp3', 'wav', 'ogg_opus', 'pcm'].includes(d.format) ? d.format : D.doubao.format,
      sampleRate: num(d.sampleRate, D.doubao.sampleRate, { min: 8000, max: 48000, int: true }),
      speechRate: num(d.speechRate, D.doubao.speechRate, { min: -50, max: 100, int: true }),
      emotionScale: num(d.emotionScale, D.doubao.emotionScale, { min: 1, max: 5 })
    },
    openai: {
      baseUrl: str(o.baseUrl, D.openai.baseUrl).replace(/\/+$/, '') || D.openai.baseUrl,
      model: str(o.model, D.openai.model) || D.openai.model,
      voice: str(o.voice, D.openai.voice),
      format: ['wav', 'mp3', 'opus', 'flac', 'aac', 'pcm'].includes(o.format) ? o.format : D.openai.format,
      speed: num(o.speed, D.openai.speed, { min: 0.25, max: 4 }),
      apiKey: str(o.apiKey),
      apiKeyEnv: str(o.apiKeyEnv, D.openai.apiKeyEnv) || D.openai.apiKeyEnv,
      instructTemplate: str(o.instructTemplate)
    },
    gptsovits: {
      baseUrl: str(g.baseUrl, D.gptsovits.baseUrl).replace(/\/+$/, '') || D.gptsovits.baseUrl,
      textLang: str(g.textLang, D.gptsovits.textLang) || D.gptsovits.textLang,
      format: ['wav', 'ogg', 'aac', 'raw'].includes(g.format) ? g.format : D.gptsovits.format,
      refs: Object.fromEntries(Object.entries(obj(g.refs)).filter(([, v]) => v && typeof v === 'object' && typeof v.audio === 'string'))
    },
    cosyvoice: {
      baseUrl: str(cv.baseUrl, D.cosyvoice.baseUrl).replace(/\/+$/, ''),
      workspaceId: str(cv.workspaceId).trim(),
      region: str(cv.region, D.cosyvoice.region) || D.cosyvoice.region,
      apiKey: str(cv.apiKey),
      apiKeyEnv: str(cv.apiKeyEnv, D.cosyvoice.apiKeyEnv) || D.cosyvoice.apiKeyEnv,
      model: ['cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus'].includes(cv.model) ? cv.model : D.cosyvoice.model,
      voiceId: str(cv.voiceId).trim(),
      format: ['wav', 'mp3'].includes(cv.format) ? cv.format : D.cosyvoice.format,
      sampleRate: num(cv.sampleRate, D.cosyvoice.sampleRate, { min: 8000, max: 48000, int: true }),
      instruction: typeof cv.instruction === 'string' ? cv.instruction : D.cosyvoice.instruction,
      timeoutMs: num(cv.timeoutMs, D.cosyvoice.timeoutMs, { min: 5000, max: 120000, int: true })
    }
  };
}

/** 控制台/状态接口返回配置时去掉明文密钥，只告诉对方「有没有」。 */
export function redactSpeakConfig(raw = {}) {
  const r = JSON.parse(JSON.stringify(obj(raw)));
  for (const p of SPEAK_PROVIDERS) {
    if (r[p] && typeof r[p] === 'object' && typeof r[p].apiKey === 'string') {
      r[p].apiKeySet = r[p].apiKey.length > 0;
      r[p].apiKey = r[p].apiKey ? '********' : '';
    }
  }
  return r;
}

// ── 文本整理（移植自 Liccsu/maibot-mimotts-voice text_processor.py，MIT）────────────────

const BRACKET_PAIRS = { '（': '）', '(': ')', '[': ']', '【': '】' };
const OPEN_BRACKETS = '（([【';
const CLOSE_BRACKETS = '）)]】';
const PUNCT_CHARS = '，。！？；：、…,.!?;:～~—-';
const KAOMOJI_CHARS = new Set('^_▽ω・´`∀≧≦╯╰ノ°Дﾟд⊙≖⌒╥〃′‵＊*');
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const EMOJI_RE = /[\u{1f300}-\u{1faff}\u{1f000}-\u{1f2ff}\u{1f1e6}-\u{1f1ff}\u{2600}-\u{27bf}\u{2b00}-\u{2bff}\u{fe0f}\u{200d}\u{20e3}\u{2190}-\u{21ff}\u{24c2}\u{203c}\u{2049}]+/gu;
const URL_RE = /(?:https?|ftp):\/\/[^\s，。！？；、）)\]】]+/gi;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]*)`/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const HTML_TAG_RE = /<[^>]{1,40}>/g;
const EMPHASIS_RE = /(\*\*|__|~~|\*|_)(?=\S)(.+?)(?<=\S)\1/g;
const LINE_PREFIX_RE = /^[ \t]*(?:#{1,6}\s*|>\s*|[-*+]\s+|\d{1,2}[.)]\s+|[-=*_]{3,}\s*$)/gm;
const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
const CQ_RE = /\[CQ:[^\]]+\]/g;
const FINAL_PARTICLES = '吧了呢啊吗呀嘛哦啦呗';
const LEAD_NOISE_RE = /^[\s'"“”‘’「」『』《》<>~～\-—*_`#>、，,。]+/;
const TAIL_NOISE_RE = /[\s'"“”‘’「」『』《》<>*_`~～\-—、，,]+$/;

const looksLikeKaomoji = (inner) => [...inner].some((ch) => KAOMOJI_CHARS.has(ch));
/** 短、纯文字、无颜文字特征的括号内容视为音频标签（如「（叹气）」「（小声）」）。 */
const looksLikeTag = (inner) => {
  const core = inner.trim();
  if (!core || looksLikeKaomoji(core) || core.length > 12) return false;
  return /^[\u4e00-\u9fffA-Za-z0-9\s,，、·/\-]{1,12}$/.test(core);
};

function hasSpokenContent(text) {
  if (!text) return false;
  let rest = '';
  for (let i = 0; i < text.length; i++) {
    const close = BRACKET_PAIRS[text[i]];
    if (close) {
      const end = text.indexOf(close, i + 1);
      if (end !== -1) { i = end; continue; }
    }
    rest += text[i];
  }
  return CJK_RE.test(rest) || /[A-Za-z0-9]/.test(rest);
}

/** keepTags=true：短括号保留为音频标签、长旁白/颜文字剔除；false：所有括号段都剔除（服务商不认标签时会念出来）。 */
function rewriteBrackets(text, keepTags) {
  let out = '';
  let dropped = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const close = BRACKET_PAIRS[ch];
    if (!close) {
      if (!CLOSE_BRACKETS.includes(ch)) out += ch; // 落单的右括号直接丢
      continue;
    }
    const end = text.indexOf(close, i + 1);
    if (end === -1) continue; // 未闭合的开括号：丢括号本身，保留后文
    const inner = text.slice(i + 1, end);
    if (keepTags && looksLikeTag(inner)) out += ch + inner + close;
    else if (inner.trim()) dropped++;
    i = end;
  }
  return { text: out, dropped };
}

function collectStyleTags(text) {
  const tags = [];
  let rest = '';
  for (let i = 0; i < text.length; i++) {
    const close = BRACKET_PAIRS[text[i]];
    if (close) {
      const end = text.indexOf(close, i + 1);
      if (end !== -1) {
        const parts = text.slice(i + 1, end).trim().split(/[\s,，、/]+/).filter(Boolean);
        if (parts.length && parts.every((p) => MIMO_STYLE_WORDS.has(p.toLowerCase()))) {
          for (const p of parts) if (!tags.includes(p)) tags.push(p);
          i = end;
          continue;
        }
      }
    }
    rest += text[i];
  }
  return { tags, rest };
}

/** 在超长无标点片段里补逗号给 TTS 换气，优先断在语气词后（Liccsu 的 _soft_break）。 */
function softBreak(text, limit = 30) {
  if (limit <= 0 || !text) return text;
  const out = [];
  let run = 0;
  let runAtParticle = 0;
  let depth = 0;
  let particleIdx = -1;
  for (const ch of text) {
    if (OPEN_BRACKETS.includes(ch)) { depth++; out.push(ch); continue; }
    if (CLOSE_BRACKETS.includes(ch)) { depth = Math.max(0, depth - 1); out.push(ch); continue; }
    out.push(ch);
    if (depth > 0) continue;
    if (PUNCT_CHARS.includes(ch) || ch === '\n') { run = 0; particleIdx = -1; continue; }
    if (!CJK_RE.test(ch)) continue;
    run++;
    if (FINAL_PARTICLES.includes(ch)) {
      if (run >= Math.max(8, Math.floor((limit * 3) / 5))) { out.push('，'); run = 0; particleIdx = -1; continue; }
      particleIdx = out.length;
      runAtParticle = run;
    }
    if (run >= limit) {
      if (particleIdx !== -1 && run - runAtParticle <= Math.max(6, Math.floor(limit / 3))) {
        out.splice(particleIdx, 0, '，');
        run -= runAtParticle;
      } else {
        out.push('，');
        run = 0;
      }
      particleIdx = -1;
    }
  }
  return out.join('')
    .replace(new RegExp(`，([${FINAL_PARTICLES}])(?=[^，。！？…\\s])`, 'g'), '$1，')
    .replace(new RegExp(`，([${FINAL_PARTICLES}])(?=[，。！？…])`, 'g'), '$1');
}

function ensureTerminal(text) {
  if (!text) return text;
  let core = text;
  for (;;) {
    const m = /[（(\[【][^（()）\[\]【】]{1,12}[）)\]】]\s*$/.exec(core);
    if (!m) break;
    core = core.slice(0, m.index);
  }
  if (core && '。！？!?…～~.；;'.includes(core[core.length - 1])) return text;
  return `${text}。`;
}

/**
 * 把模型写的一句聊天文本整理成送 TTS 的文本。
 * @returns {{ text: string, ok: boolean, reason?: string, styleTags: string[], notes: string[], chars: number }}
 *   chars 是去掉括号标签后真正会念出来的字数（限长与计费都按它算）。
 */
/** 按独立单词做发音替换；键不区分大小写，长键优先（如 "Yuki" 先于 "Yu"）。 */
export function applyPronunciations(text, pronunciations = {}) {
  let out = String(text ?? '');
  const entries = Object.entries(pronunciations ?? {})
    .filter(([key, value]) => key && value)
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
  for (const [key, value] of entries) {
    const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      out = out.replace(new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'gi'), String(value));
    } catch {
      // 非法正则键（理论上不会）直接跳过，绝不让 TTS 因配置写坏而崩。
    }
  }
  return out;
}

export function prepareSpeechText(raw, { keepTags = true, foldEllipsis = true, punctuationLimit = 30, emotionTag = '' } = {}) {
  const notes = [];
  let s = String(raw ?? '');
  if (!s.trim()) return { text: '', ok: false, reason: '文本为空', styleTags: [], notes, chars: 0 };
  // 先摘出风格标签，避免清洗时被当作旁白删掉（只有支持标签的服务商才保留）
  let styleTags = [];
  if (keepTags) ({ tags: styleTags, rest: s } = collectStyleTags(s));
  s = s.replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH_RE, '')
    .replace(FENCED_CODE_RE, '')
    .replace(CQ_RE, '')
    .replace(URL_RE, '')
    .replace(MD_IMAGE_RE, '')
    .replace(MD_LINK_RE, '$1')
    .replace(HTML_TAG_RE, '')
    .replace(INLINE_CODE_RE, '$1')
    .replace(EMPHASIS_RE, '$2')
    .replace(LINE_PREFIX_RE, '');
  const noEmoji = s.replace(EMOJI_RE, '');
  if (noEmoji !== s) { notes.push('已移除 emoji'); s = noEmoji; }
  const br = rewriteBrackets(s, keepTags);
  s = br.text;
  if (br.dropped) notes.push(`已移除 ${br.dropped} 处括号旁白/颜文字`);
  // 引号/书名号会被念成奇怪的语气（SoulString-Dev 实测），统一去掉
  s = s.replace(/[「」『』“”‘’"《》〈〉]/g, '');
  if (foldEllipsis) {
    // SoulString-Dev：～ 与省略号会让音高漂移 2–4 个半音并带来长静音，折成逗号
    s = s.replace(/[~～]+/g, '，').replace(/(…+|\.{3,}|。{2,}|．{3,})/g, '，');
  } else {
    s = s.replace(/。。。|\.\.\.|．．．/g, '……').replace(/…{2,}/g, '……').replace(/[~～]{2,}/g, '～');
  }
  s = s.replace(/-{2,}/g, '——')
    .replace(/[，,、]{2,}/g, '，')
    .replace(/[！!]{2,}/g, '！')
    .replace(/[？?]{2,}/g, '？')
    .replace(/，+([。！？])/g, '$1')
    .replace(/(?<=[\u4e00-\u9fff])[ \t\u3000]+(?=[\u4e00-\u9fff])/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n+/g, '，')
    .trim()
    .replace(LEAD_NOISE_RE, '')
    .replace(TAIL_NOISE_RE, '');
  if (!hasSpokenContent(s)) return { text: '', ok: false, reason: '清洗后没有可朗读的文字', styleTags, notes, chars: 0 };
  s = ensureTerminal(softBreak(s, punctuationLimit));
  const lead = [...new Set([emotionTag, ...styleTags].filter(Boolean))];
  if (keepTags && lead.length) s = `(${lead.join(' ')})${s}`;
  const chars = spokenChars(s);
  return { text: s, ok: true, styleTags: lead, notes, chars };
}

/** 去掉括号标签后的字数（计费、限长都按「真正念出来的字」算）。 */
export function spokenChars(text) {
  return String(text ?? '')
    .replace(/[（(\[【][^（()）\[\]【】]{0,24}[）)\]】]/g, '')
    .replace(/[\s，。！？；：、,.!?;:…—～~]/g, '')
    .length;
}

/**
 * 自动转换（随机语音）前的「像不像一句能说出口的话」判断。宁可少转：有链接、代码、
 * 长数字串（电话/QQ 号/金额）、多行、@、列表符号的都保持文字。
 */
export function autoSpeakable(raw, { minChars = 2, maxChars = 40 } = {}) {
  const s = String(raw ?? '');
  if (/https?:\/\/|www\./i.test(s)) return { ok: false, reason: '含链接' };
  if (/```|`[^`]+`/.test(s)) return { ok: false, reason: '含代码' };
  if (/\d{5,}/.test(s)) return { ok: false, reason: '含长数字' };
  if (/[@＠]/.test(s)) return { ok: false, reason: '含 @' };
  if (/\n.*\n/.test(s) || /^\s*([-*•]|\d+[.)、])\s/m.test(s)) return { ok: false, reason: '像列表/多行' };
  if (/\[[^\]]{1,12}\]/.test(s)) return { ok: false, reason: '含占位符' };
  // 长括号旁白（动作/舞台说明）念出来会被剔除，转成语音就丢了一半意思，保持文字
  if (/[（(【][^（()）【】]{13,}[）)】]/.test(s)) return { ok: false, reason: '含旁白' };
  const n = spokenChars(s.replace(EMOJI_RE, ''));
  if (n < minChars) return { ok: false, reason: '太短' };
  if (n > maxChars) return { ok: false, reason: '太长' };
  if (!CJK_RE.test(s) && !/[A-Za-z]{2,}/.test(s)) return { ok: false, reason: '没有可读文字' };
  return { ok: true, chars: n };
}

// ── 情绪映射 ─────────────────────────────────────────────────────────────────

const MIMO_EMOTION = { 难过: '悲伤', 生气: '愤怒', 害怕: '恐惧', 嫌弃: '冷漠', 撒娇: '夹子音' };
// 豆包 V3 audio_params.emotion 取值（ZhaoCang-QWQ/doubao-tts PRESET_EMOTIONS）
const DOUBAO_EMOTION = { 开心: 'happy', 兴奋: 'happy', 俏皮: 'happy', 难过: 'sad', 委屈: 'sad', 生气: 'angry', 害怕: 'scare', 惊讶: 'surprise', 嫌弃: 'hate', 平静: 'pleased', 温柔: 'pleased' };

export function normalizeEmotion(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'none' || s === '无' || s === '默认') return '';
  return s.slice(0, 8);
}

/** 模型/操作者说「唱歌」时，MiMo 要求 assistant 文本最开头出现 (唱歌) 标签；只写 style 不会触发唱歌。 */
export function isSingingStyle(style) {
  return /唱歌|sing|singing/i.test(String(style ?? ''));
}

/** 把 (唱歌) 放到文本最前面；已有风格标签时合并成 (唱歌 风格)，不覆盖原标签。 */
export function withSingingTag(text) {
  const s = String(text ?? '');
  if (/^[（(]\s*(唱歌|sing|singing)(?:\s|$)/i.test(s)) return s;
  const lead = /^[（(]([^）)]*)[）)]/.exec(s);
  if (lead) return `(唱歌 ${lead[1]})${s.slice(lead[0].length)}`;
  return `(唱歌)${s}`;
}

/** 文本本身带 (唱歌) 标签（模型直接写在 text 里）也算唱歌。 */
export function hasSingingTag(text) {
  return /^[（(]\s*(唱歌|sing|singing)(?:\s|$)/i.test(String(text ?? ''));
}


// ── WAV 工具（只处理 PCM16，其它格式原样透传）────────────────────────────────

export function wavInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), sampleRate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      if (size === 0 || size === 0xffffffff || start + size > buf.length) size = buf.length - start;
      if (!fmt) return null;
      const frameBytes = (fmt.bits / 8) * fmt.channels;
      return { ...fmt, dataOffset: start, dataBytes: size, seconds: frameBytes ? size / frameBytes / fmt.sampleRate : 0 };
    }
    off = start + size + (size % 2);
  }
  return null;
}

/**
 * 裁掉首尾静音并做 8ms 淡入淡出（SoulString-Dev 观察到合成结果常带首尾爆音/长静音）。
 * 阈值 -45dBFS、两端各留 80ms，避免把轻声的第一个字吃掉。只处理 PCM16，其它格式原样返回。
 */
export function trimWavSilence(buf, { thresholdDb = -45, padMs = 80, fadeMs = 8 } = {}) {
  const info = wavInfo(buf);
  if (!info || info.format !== 1 || info.bits !== 16) return buf;
  const { channels, sampleRate, dataOffset, dataBytes } = info;
  const frames = Math.floor(dataBytes / (2 * channels));
  if (frames < sampleRate * 0.3) return buf;
  const thr = Math.round(32768 * 10 ** (thresholdDb / 20));
  const loud = (f) => {
    for (let c = 0; c < channels; c++) if (Math.abs(buf.readInt16LE(dataOffset + (f * channels + c) * 2)) > thr) return true;
    return false;
  };
  let first = 0;
  while (first < frames && !loud(first)) first++;
  let last = frames - 1;
  while (last > first && !loud(last)) last--;
  if (first >= last) return buf;
  const pad = Math.round((sampleRate * padMs) / 1000);
  const from = Math.max(0, first - pad);
  const to = Math.min(frames, last + 1 + pad);
  if (from === 0 && to === frames) return buf;
  const pcm = Buffer.from(buf.subarray(dataOffset + from * channels * 2, dataOffset + to * channels * 2));
  const n = to - from;
  const fade = Math.min(Math.round((sampleRate * fadeMs) / 1000), Math.floor(n / 4));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    for (let c = 0; c < channels; c++) {
      const a = (i * channels + c) * 2;
      const b = ((n - 1 - i) * channels + c) * 2;
      pcm.writeInt16LE(Math.round(pcm.readInt16LE(a) * g), a);
      pcm.writeInt16LE(Math.round(pcm.readInt16LE(b) * g), b);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 粗略探测音频容器，决定发给网关时的扩展名与是否能算时长。 */
export function sniffAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return { ext: 'bin', mime: 'application/octet-stream' };
  if (buf.toString('latin1', 0, 4) === 'RIFF') return { ext: 'wav', mime: 'audio/wav' };
  if (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf.toString('latin1', 0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (buf.toString('latin1', 0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  if (buf.toString('latin1', 1, 10) === '#!SILK_V3' || buf.toString('latin1', 0, 9) === '#!SILK_V3') return { ext: 'silk', mime: 'audio/silk' };
  return { ext: 'bin', mime: 'application/octet-stream' };
}

/** 估算 mp3 时长（CBR 近似：按首个帧头的比特率）。拿不到时返回 null。 */
function estimateMp3Seconds(buf) {
  let i = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3' && buf.length > 10) {
    i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  for (; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1=Layer III
    const brIdx = (buf[i + 2] >> 4) & 15;
    if (layer !== 1 || brIdx === 0 || brIdx === 15) continue;
    const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const kbps = (ver === 3 ? v1 : v2)[brIdx];
    return kbps ? ((buf.length - i) * 8) / (kbps * 1000) : null;
  }
  return null;
}

// ── 合成服务 ────────────────────────────────────────────────────────────────

// SoulString-Dev：超时与 4xx 业务错误不重试，避免把总耗时翻倍
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// 小于这个字节数的音频基本是空的（约 0.15 秒），按失败处理
const MIN_AUDIO_BYTES = 600;

class RetryableError extends Error {}

function keyFor(pcfg) {
  return pcfg.apiKey || (pcfg.apiKeyEnv ? process.env[pcfg.apiKeyEnv] || '' : '');
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig  返回 socialV2.speak 原始配置
 * @param {string} deps.root             bridge 根目录（参考音频、缓存目录相对它解析）
 * @param {(...args:any[]) => void} [deps.log]
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createTtsService({ getConfig, root, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const baseDir = root ?? process.cwd();
  const cacheDir = path.join(baseDir, 'data', 'tts');
  const usage = { day: '', chars: 0 };
  const stats = { synthesized: 0, failed: 0, lastMs: 0, lastError: '', lastProvider: '' };
  let designRef = null; // { hash, uri }
  let cloneRef = null;  // { file, mtime, uri }

  const cfgNow = () => normalizeSpeakConfig(typeof getConfig === 'function' ? getConfig() : {});
  const resolvePath = (p) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));

  function dayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function budgetCheck(cfg, chars) {
    if (usage.day !== dayKey()) { usage.day = dayKey(); usage.chars = 0; }
    if (cfg.dailyCharBudget > 0 && usage.chars + chars > cfg.dailyCharBudget) {
      throw new Error(`今日语音合成字数已用完（${usage.chars}/${cfg.dailyCharBudget}），先打字吧`);
    }
  }

  async function postJson(url, body, headers, timeoutMs) {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(`合成超时（${timeoutMs}ms）`);
      throw new RetryableError(`网络错误：${error?.message ?? error}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      const E = RETRYABLE_STATUS.has(res.status) ? RetryableError : Error;
      throw new E(`HTTP ${res.status} ${detail}`);
    }
    return res;
  }

  async function withRetry(fn) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof RetryableError)) throw error;
      await new Promise((r) => setTimeout(r, 600));
      return fn();
    }
  }

  // ---- MiMo ---------------------------------------------------------------
  async function mimoCall(cfg, { model, user, assistant, audio }) {
    const m = cfg.mimo;
    const apiKey = keyFor(m);
    if (!apiKey) throw new Error(`MiMo 缺少 API Key（socialV2.speak.mimo.apiKey 或环境变量 ${m.apiKeyEnv}）`);
    const messages = [];
    if (user !== undefined && user !== null) messages.push({ role: 'user', content: user });
    if (assistant) messages.push({ role: 'assistant', content: assistant });
    const url = m.baseUrl.endsWith('/chat/completions') ? m.baseUrl : `${m.baseUrl}/chat/completions`;
    const res = await withRetry(() => postJson(url, { model, messages, audio }, { authorization: `Bearer ${apiKey}`, 'api-key': apiKey }, cfg.timeoutMs));
    const body = await res.json().catch(() => ({}));
    const b64 = body?.choices?.[0]?.message?.audio?.data;
    if (!b64) throw new Error('MiMo 返回中缺少音频数据');
    return Buffer.from(String(b64), 'base64');
  }

  function fileToDataUri(file) {
    const buf = fs.readFileSync(file);
    if (buf.length > 7 * 1024 * 1024) throw new Error(`参考音频过大（${(buf.length / 1048576).toFixed(1)}MB，base64 后会超过 MiMo 的 10MB 限制）`);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
    if (!['.wav', '.mp3'].includes(ext)) throw new Error('MiMo 复刻只支持 mp3/wav 参考音频');
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  /** voiceDesign：只设计一次音色，存成参考音频，之后都走 voiceclone —— 否则每条语音的声线都会不一样。 */
  async function ensureDesignRef(cfg) {
    const m = cfg.mimo;
    const hash = crypto.createHash('sha1').update(`${m.voiceDesign}\n${m.designSampleText}`).digest('hex').slice(0, 12);
    if (designRef?.hash === hash) return designRef.uri;
    const file = path.join(cacheDir, `mimo-design-${hash}.wav`);
    if (!fs.existsSync(file)) {
      log(`[tts] 首次使用音色描述，正在用 mimo-v2.5-tts-voicedesign 生成参考音频（之后复用 ${path.basename(file)}）`);
      const buf = await mimoCall(cfg, { model: 'mimo-v2.5-tts-voicedesign', user: m.voiceDesign, assistant: m.designSampleText, audio: { format: 'wav' } });
      if (buf.length < MIN_AUDIO_BYTES) throw new Error('音色设计返回了空音频');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, cfg.trimSilence ? trimWavSilence(buf) : buf);
    }
    designRef = { hash, uri: fileToDataUri(file) };
    return designRef.uri;
  }

  function ensureCloneRef(cfg) {
    const file = resolvePath(cfg.mimo.cloneAudio);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) throw new Error(`找不到参考音频 ${cfg.mimo.cloneAudio}`);
    if (cloneRef?.file === file && cloneRef.mtime === st.mtimeMs) return cloneRef.uri;
    cloneRef = { file, mtime: st.mtimeMs, uri: fileToDataUri(file) };
    return cloneRef.uri;
  }

  async function synthMimo(cfg, prepared, { style }) {
    const m = cfg.mimo;
    const user = String(style || m.styleInstruction || '');
    if (m.cloneAudio || m.voiceDesign) {
      const voice = m.cloneAudio ? ensureCloneRef(cfg) : await ensureDesignRef(cfg);
      return mimoCall(cfg, { model: 'mimo-v2.5-tts-voiceclone', user, assistant: prepared.text, audio: { format: m.format, voice } });
    }
    return mimoCall(cfg, { model: m.model, user: user || undefined, assistant: prepared.text, audio: { format: m.format, voice: m.voice } });
  }

  // ---- 豆包 V3（ZhaoCang-QWQ/doubao-tts 的请求格式）---------------------------
  async function synthDoubao(cfg, prepared, { emotion }) {
    const d = cfg.doubao;
    const apiKey = keyFor(d);
    if (!apiKey) throw new Error(`豆包语音缺少 API Key（socialV2.speak.doubao.apiKey 或环境变量 ${d.apiKeyEnv}）`);
    const audioParams = { format: d.format, sample_rate: d.sampleRate };
    const emo = DOUBAO_EMOTION[emotion];
    if (emo) { audioParams.emotion = emo; audioParams.emotion_scale = d.emotionScale; }
    if (d.speechRate) audioParams.speech_rate = d.speechRate;
    const payload = { req_params: { text: prepared.text, speaker: d.speaker, audio_params: audioParams } };
    const res = await withRetry(() => postJson(d.url, payload, {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': d.resourceId,
      'X-Api-Request-Id': crypto.randomUUID()
    }, cfg.timeoutMs));
    // NDJSON 流：code=0 携带 base64 音频段；20000000=结束；其它=业务错误
    const raw = await res.text();
    const chunks = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let o;
      try { o = JSON.parse(t); } catch { continue; }
      if (o.code === 20000000) break;
      if (o.code === 0) { if (o.data) chunks.push(Buffer.from(String(o.data), 'base64')); continue; }
      throw new Error(`豆包业务错误：${o.message || o.error || `code=${o.code}`}`);
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('豆包返回空音频（检查音色与 resourceId 是否匹配：预置音色 seed-tts-2.0，复刻音色 seed-icl-2.0）');
    return buf;
  }

  // ---- OpenAI 兼容 /audio/speech ------------------------------------------
  async function synthOpenAI(cfg, prepared, { emotion }) {
    const o = cfg.openai;
    const apiKey = keyFor(o);
    let input = prepared.text;
    if (emotion && o.instructTemplate) input = o.instructTemplate.replaceAll('{emotion}', emotion).replaceAll('{text}', prepared.text);
    const res = await withRetry(() => postJson(`${o.baseUrl}/audio/speech`, {
      model: o.model,
      input,
      ...(o.voice ? { voice: o.voice } : {}),
      response_format: o.format,
      speed: o.speed
    }, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, cfg.timeoutMs));
    return Buffer.from(await res.arrayBuffer());
  }

  // ---- GPT-SoVITS api_v2 -------------------------------------------------
  async function synthGptSovits(cfg, prepared, { emotion }) {
    const g = cfg.gptsovits;
    const ref = (emotion && g.refs[emotion]) || g.refs.default || Object.values(g.refs)[0];
    if (!ref) throw new Error('GPT-SoVITS 需要配置参考音频 socialV2.speak.gptsovits.refs.default = { audio, text, lang }');
    const res = await withRetry(() => postJson(`${g.baseUrl}/tts`, {
      text: prepared.text,
      text_lang: g.textLang,
      ref_audio_path: ref.audio,
      prompt_text: ref.text ?? '',
      prompt_lang: ref.lang ?? g.textLang,
      media_type: g.format,
      streaming_mode: false
    }, {}, cfg.timeoutMs));
    return Buffer.from(await res.arrayBuffer());
  }

  function cosyBase(c) {
    if (c.baseUrl) return c.baseUrl;
    if (!c.workspaceId) return '';
    return `https://${c.workspaceId}.${c.region || 'cn-beijing'}.maas.aliyuncs.com`;
  }

  /**
   * 百炼 DashScope CosyVoice 3.5。非流式 HTTP API：同步返回一个 24h 有效的 OSS URL。
   * 这是远程 TTS，不加载任何本地模型；voiceId 来自百炼控制台的声音设计/复刻。
   */
  async function synthCosyVoice(cfg, prepared, { style, emotion }) {
    const c = cfg.cosyvoice;
    const base = cosyBase(c);
    if (!base) throw new Error('CosyVoice 未配置 baseUrl 或 workspaceId');
    if (!c.voiceId) throw new Error('CosyVoice 未配置 voiceId（先在百炼创建声音设计/复刻音色）');
    const key = keyFor(c);
    if (!key) throw new Error(`CosyVoice 缺少 API Key（socialV2.speak.cosyvoice.apiKey 或环境变量 ${c.apiKeyEnv}）`);
    const instruction = [emotion ? `用${emotion}的语气` : '', style || c.instruction || '']
      .filter(Boolean).join('，').slice(0, 500);
    const body = {
      model: c.model,
      input: {
        text: prepared.text,
        voice: c.voiceId,
        format: c.format,
        sample_rate: c.sampleRate,
        ...(instruction ? { instruction } : {})
      }
    };
    const res = await fetchImpl(`${base}/api/v1/services/audio/tts/SpeechSynthesizer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(c.timeoutMs)
    });
    const text = await res.text().catch(() => '');
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) {
      throw new Error(`CosyVoice HTTP ${res.status}：${String(json?.message ?? json?.code ?? text).replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    const audio = json?.output?.audio ?? {};
    let buf;
    if (typeof audio.data === 'string' && audio.data.length > 64) {
      const b64 = audio.data.includes(',') ? audio.data.slice(audio.data.indexOf(',') + 1) : audio.data;
      buf = Buffer.from(b64, 'base64');
    } else if (typeof audio.url === 'string' && /^https?:\/\//.test(audio.url)) {
      const ar = await fetchImpl(audio.url, { signal: AbortSignal.timeout(c.timeoutMs) });
      if (!ar.ok) throw new Error(`CosyVoice 音频下载 HTTP ${ar.status}`);
      buf = Buffer.from(await ar.arrayBuffer());
    } else {
      throw new Error('CosyVoice 没有返回音频 URL/data');
    }
    if (buf.length < MIN_AUDIO_BYTES || buf.length > 64 * 1024 * 1024) throw new Error('CosyVoice 返回的音频无效或过大');
    return buf;
  }

  /**
   * 合成一句话。返回 { buffer, ext, mime, seconds, chars, provider, text, ms }。
   * 失败抛错（调用方决定是回给模型还是静默改发文字）。
   */
  async function synthesize(rawText, { emotion = '', style = '', maxChars = null, timeoutMs = null } = {}) {
    const cfg0 = cfgNow();
    const cfg = timeoutMs ? { ...cfg0, timeoutMs: Math.min(cfg0.timeoutMs, timeoutMs) } : cfg0;
    const provider = cfg.provider;
    if (provider === 'cosyvoice' && (isSingingStyle(style) || hasSingingTag(rawText))) {
      throw new Error('CosyVoice TTS 只支持说话，不支持唱歌；唱歌请用 Seed-VC 唱歌功能');
    }
    const keepTags = provider === 'mimo';
    const emo = cfg.allowEmotion ? normalizeEmotion(emotion) : '';
    const emotionTag = keepTags && emo ? (MIMO_EMOTION[emo] ?? emo) : '';
    let prepared = prepareSpeechText(rawText, { keepTags, emotionTag });
    if (!prepared.ok) throw new Error(prepared.reason);
    const pronounced = applyPronunciations(prepared.text, cfg.pronunciations);
    if (pronounced !== prepared.text) {
      prepared = { ...prepared, text: pronounced, chars: spokenChars(pronounced) };
    }
    const limit = maxChars ?? cfg.maxChars;
    if (prepared.chars > limit) throw new Error(`这句太长了（${prepared.chars} 字，语音最多 ${limit} 字）；长内容请打字`);
    budgetCheck(cfg, prepared.chars);
    // MiMo 唱歌：必须把 (唱歌) 放在 assistant 文本最开头；只传 style="唱歌" 只会用唱歌的
    // 语气说话，不会真的唱。voiceDesign / voiceClone 官方明确不支持唱歌，提前拒绝而不是静默降级。
    const wantsSinging = provider === 'mimo' && (isSingingStyle(style) || hasSingingTag(prepared.text));
    if (wantsSinging && (cfg.mimo.cloneAudio || cfg.mimo.voiceDesign)) {
      throw new Error('当前 MiMo 音色是 design/clone 模式，不支持唱歌；请清空 voiceDesign/cloneAudio 切回预置音色');
    }
    const spoken = wantsSinging
      ? { ...prepared, text: withSingingTag(prepared.text) }
      : prepared;
    const t0 = Date.now();
    let buffer;
    try {
      if (provider === 'mimo') buffer = await synthMimo(cfg, spoken, { style });
      else if (provider === 'doubao') buffer = await synthDoubao(cfg, prepared, { emotion: emo });
      else if (provider === 'openai') buffer = await synthOpenAI(cfg, prepared, { emotion: emo });
      else if (provider === 'cosyvoice') buffer = await synthCosyVoice(cfg, prepared, { style, emotion: emo });
      else buffer = await synthGptSovits(cfg, prepared, { emotion: emo });
    } catch (error) {
      stats.failed++;
      stats.lastError = error?.message ?? String(error);
      throw new Error(`语音合成失败（${provider}）：${stats.lastError}`);
    }
    if (!buffer || buffer.length < MIN_AUDIO_BYTES) {
      stats.failed++;
      stats.lastError = '返回的音频过小（疑似空音频）';
      throw new Error(`语音合成失败（${provider}）：${stats.lastError}`);
    }
    let kind = sniffAudio(buffer);
    if (kind.ext === 'wav' && cfg.trimSilence) buffer = trimWavSilence(buffer);
    kind = sniffAudio(buffer);
    const seconds = kind.ext === 'wav' ? (wavInfo(buffer)?.seconds ?? null) : kind.ext === 'mp3' ? estimateMp3Seconds(buffer) : null;
    if (seconds != null && seconds > cfg.maxSeconds) throw new Error(`合成结果太长（${seconds.toFixed(1)}s，上限 ${cfg.maxSeconds}s）`);
    usage.chars += prepared.chars;
    stats.synthesized++;
    stats.lastMs = Date.now() - t0;
    stats.lastProvider = provider;
    return { buffer, ext: kind.ext, mime: kind.mime, seconds, chars: prepared.chars, provider, text: prepared.text, notes: prepared.notes, ms: stats.lastMs };
  }

  /** 当前服务商是否「看起来能用」（有 Key / 有参考音频）。不发网络请求。 */
  function ready(cfg = cfgNow()) {
    const p = cfg.provider;
    if (p === 'mimo') return keyFor(cfg.mimo) ? { ok: true } : { ok: false, reason: `缺少 MiMo API Key（环境变量 ${cfg.mimo.apiKeyEnv}）` };
    if (p === 'doubao') return keyFor(cfg.doubao) ? { ok: true } : { ok: false, reason: `缺少豆包 API Key（环境变量 ${cfg.doubao.apiKeyEnv}）` };
    if (p === 'gptsovits') return Object.keys(cfg.gptsovits.refs).length ? { ok: true } : { ok: false, reason: '缺少 GPT-SoVITS 参考音频配置' };
    if (p === 'cosyvoice') {
      if (!cosyBase(cfg.cosyvoice)) return { ok: false, reason: 'CosyVoice 缺少 baseUrl 或 workspaceId' };
      if (!cfg.cosyvoice.voiceId) return { ok: false, reason: 'CosyVoice 缺少 voiceId（先在百炼创建声音设计/复刻音色）' };
      return keyFor(cfg.cosyvoice)
        ? { ok: true, note: '百炼远程 TTS，不占本机模型内存' }
        : { ok: false, reason: `缺少 CosyVoice API Key（环境变量 ${cfg.cosyvoice.apiKeyEnv}）` };
    }
    return { ok: true };
  }

  function status() {
    const cfg = cfgNow();
    if (usage.day !== dayKey()) { usage.day = dayKey(); usage.chars = 0; }
    return { enabled: cfg.enabled, provider: cfg.provider, ready: ready(cfg), todayChars: usage.chars, dailyCharBudget: cfg.dailyCharBudget, ...stats };
  }

  return { synthesize, ready, status };
}
