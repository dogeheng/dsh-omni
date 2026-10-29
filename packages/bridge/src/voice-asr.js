// 入站语音转写（ASR）：让大肥鱼「听懂」群友发来的 QQ 语音。
//
// 链路（逐级兜底，任何一级成功即返回）：
//   1. SnowLuma `get_record(out_format:'wav')` —— 网关在容器里把 QQ 的 SILK 转成 PCM WAV（实测 24kHz/16bit/单声道，0.5~1.6s）
//   2. 直接下载 record 段里的 `url`（QQ CDN 上的原始 `#!SILK_V3`）→ silk-wasm 解码成 PCM
//   3. 识别失败时可选回退到 SnowLuma `fetch_ptt_text`（QQ 自带的语音转文字）
// 识别引擎默认是本地 SenseVoice-Small（sherpa-onnx-node，CPU，int8 模型 ~230MB）。模型跑在独立子进程
// （asr-worker.mjs）里按需加载：第一条语音到来时才启动，闲置 idleUnloadMs 后结束进程，~850MB 内存随之归还；
//
// 设计参考（只借鉴思路，代码为本项目独立实现）：
//   - AstrBot `astrbot/core/provider/sources/sensevoice_selfhosted_source.py`（AGPL-3.0）：
//     SenseVoice 自部署 + 情绪标签可选输出 —— https://github.com/AstrBotDevs/AstrBot
//   - DMJXMJ/maibot-sensevoice-stt（MIT）：MaiBot 生态的本地 SenseVoice 语音识别插件 ——
//     https://github.com/DMJXMJ/maibot-sensevoice-stt
//   - FunAudioLLM/SenseVoice（模型本体）—— https://github.com/FunAudioLLM/SenseVoice
//   - k2-fsa/sherpa-onnx（推理运行时与 int8 模型包）—— https://github.com/k2-fsa/sherpa-onnx
//
// 安全边界：
//   - 只下载 QQ 自己的媒体域名（见 QQ_MEDIA_HOST_RE），且先过 safe-fetch 的私网/回环地址校验；
//   - 转写文本会进入模型上下文：压掉换行与控制字符、限长，避免一条语音伪造出新的提示词段落；
//   - 模型、依赖缺失时静默降级为「[语音 N秒]」占位，不影响桥接其它功能。
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateFetchUrl } from './safe-fetch.js';

const require = createRequire(import.meta.url);
const WORKER_PATH = fileURLToPath(new URL('./asr-worker.mjs', import.meta.url));
const WORKER_LOAD_TIMEOUT_MS = 60000;

export const DEFAULT_SENSEVOICE_DIR = 'data/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
export const SENSEVOICE_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2';

export const ASR_DEFAULTS = Object.freeze({
  enabled: true,
  // sensevoice：本地 SenseVoice-Small；qq：只用 QQ 自带转写；off：关闭
  engine: 'sensevoice',
  modelDir: DEFAULT_SENSEVOICE_DIR,
  numThreads: 2,
  language: 'auto',
  useItn: true,               // 逆文本归一化：输出标点与阿拉伯数字
  preload: false,             // true：桥接启动时就加载模型；false：第一条语音到来时才加载（按需）
  idleUnloadMs: 10 * 60 * 1000, // 多久没有语音就结束识别子进程、释放内存（0 = 加载后一直常驻）
  maxSeconds: 60,             // 超过这个时长的语音不转写（QQ 单条语音上限 60s）
  maxBytes: 4 * 1024 * 1024,  // 原始 SILK 下载上限
  timeoutMs: 15000,           // 单条语音「取音频 + 识别」的总预算
  maxConcurrent: 2,
  qqFallback: true,           // 本地识别失败时回退到 fetch_ptt_text
  showEmotion: true,          // 在标注里带上 SenseVoice 识别的情绪（开心/难过/生气…）
  showEvent: true,            // 在标注里带上声学事件（笑声/掌声/背景音乐…）
  maxTextChars: 300,
  cacheSize: 500
});

const ENGINES = new Set(['sensevoice', 'qq', 'off']);

function num(v, fallback, { min = -Infinity, max = Infinity, int = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
}

/** 把 config.json 里的 socialV2.asr 与默认值合并并做类型收敛（用户手写配置常见字符串数字）。 */
export function normalizeAsrConfig(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const engine = ENGINES.has(String(r.engine)) ? String(r.engine) : ASR_DEFAULTS.engine;
  const idle = num(r.idleUnloadMs, ASR_DEFAULTS.idleUnloadMs, { min: 0, max: 7 * 86_400_000, int: true });
  return {
    enabled: r.enabled !== false,
    engine,
    modelDir: typeof r.modelDir === 'string' && r.modelDir.trim() ? r.modelDir.trim() : ASR_DEFAULTS.modelDir,
    numThreads: num(r.numThreads, ASR_DEFAULTS.numThreads, { min: 1, max: 8, int: true }),
    language: typeof r.language === 'string' && r.language.trim() ? r.language.trim() : 'auto',
    useItn: r.useItn !== false,
    preload: r.preload === true,
    idleUnloadMs: idle > 0 ? Math.max(1000, idle) : 0,
    maxSeconds: num(r.maxSeconds, ASR_DEFAULTS.maxSeconds, { min: 1, max: 600 }),
    maxBytes: num(r.maxBytes, ASR_DEFAULTS.maxBytes, { min: 64 * 1024, max: 32 * 1024 * 1024, int: true }),
    timeoutMs: num(r.timeoutMs, ASR_DEFAULTS.timeoutMs, { min: 1000, max: 120000, int: true }),
    maxConcurrent: num(r.maxConcurrent, ASR_DEFAULTS.maxConcurrent, { min: 1, max: 8, int: true }),
    qqFallback: r.qqFallback !== false,
    showEmotion: r.showEmotion !== false,
    showEvent: r.showEvent !== false,
    maxTextChars: num(r.maxTextChars, ASR_DEFAULTS.maxTextChars, { min: 20, max: 2000, int: true }),
    cacheSize: num(r.cacheSize, ASR_DEFAULTS.cacheSize, { min: 10, max: 5000, int: true }),
  };
}

// ── 音频工具 ─────────────────────────────────────────────────────────────────

/**
 * 解析 RIFF/WAVE（PCM 8/16/24/32 位整数与 32 位浮点），多声道下混成单声道 Float32。
 * 不依赖 ffmpeg：SnowLuma 已经在网关里转好码，这里只需要读 PCM。
 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 数据');
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    // 有些编码器把 data 块大小写成 0 或 0xFFFFFFFF（流式写入），按剩余长度兜底
    if (id === 'data' && (size === 0 || start + size > buf.length)) size = buf.length - start;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14)
      };
      // WAVE_FORMAT_EXTENSIBLE：真实格式在子格式 GUID 的前两个字节
      if (fmt.format === 0xfffe && size >= 26) fmt.format = buf.readUInt16LE(start + 24);
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
      break;
    }
    off = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  const { format, channels, sampleRate, bits } = fmt;
  if (!channels || !sampleRate) throw new Error('WAV 头部无效');
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes;
      let v;
      if (format === 3 && bits === 32) v = data.readFloatLE(p);
      else if (format === 1 && bits === 16) v = data.readInt16LE(p) / 32768;
      else if (format === 1 && bits === 8) v = (data[p] - 128) / 128;
      else if (format === 1 && bits === 24) v = data.readIntLE(p, 3) / 8388608;
      else if (format === 1 && bits === 32) v = data.readInt32LE(p) / 2147483648;
      else throw new Error(`不支持的 WAV 编码：format=${format} bits=${bits}`);
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { sampleRate, channels, samples: out, seconds: frames / sampleRate };
}

/** PCM s16le（silk-wasm 的输出）→ Float32。 */
export function pcm16ToFloat32(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = b.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(i * 2) / 32768;
  return out;
}

/** 线性插值重采样。在 JS 里先转到 16k，避免 sherpa-onnx 每条流都往 stderr 打一行「Creating a resampler」。 */
export function resampleLinear(x, from, to) {
  if (!from || !to || from === to) return x;
  const ratio = to / from;
  const n = Math.max(0, Math.floor(x.length * ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / ratio;
    const j = Math.floor(p);
    const f = p - j;
    const a = x[j] ?? 0;
    const b = x[j + 1] ?? a;
    y[i] = a * (1 - f) + b * f;
  }
  return y;
}

/** Float32 单声道 → 16bit PCM WAV（测试/音频工具用）。 */
export function encodeWavPcm16(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ── SenseVoice 富文本标签 ───────────────────────────────────────────────────

// SenseVoice 的情绪/事件标签（https://github.com/FunAudioLLM/SenseVoice 的 rich transcription 说明）。
// NEUTRAL / Speech / *_UNKNOWN 不标注 —— 绝大多数语音都是这两个，标出来只会浪费 token。
const EMOTION_LABELS = {
  HAPPY: '开心', SAD: '难过', ANGRY: '生气', FEARFUL: '害怕', DISGUSTED: '嫌弃', SURPRISED: '惊讶'
};
const EVENT_LABELS = {
  BGM: '背景音乐', Applause: '掌声', Laughter: '笑声', Cry: '哭声', Sneeze: '喷嚏', Breath: '喘气', Cough: '咳嗽'
};

function stripTag(v) {
  return String(v ?? '').replace(/^<\|/, '').replace(/\|>$/, '').trim();
}

export function senseVoiceTags(result = {}) {
  const lang = stripTag(result.lang);
  const emotionRaw = stripTag(result.emotion);
  const eventRaw = stripTag(result.event);
  return {
    lang: lang || '',
    emotion: EMOTION_LABELS[emotionRaw] ?? '',
    event: EVENT_LABELS[eventRaw] ?? ''
  };
}

/** 转写文本进上下文前的清洗：去掉残留的 <|tag|>、换行与控制字符，并限长。 */
export function sanitizeTranscript(text, maxChars = ASR_DEFAULTS.maxTextChars) {
  let s = String(text ?? '')
    .replace(/<\|[^|]{0,32}\|>/g, '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}…`;
  return s;
}

/**
 * 生成写进会话记录 / 唤醒提示的语音标注。
 *   有转写：[语音 6秒·语气开心] 不至于吧，还入戏太深
 *   没听清：[语音 3秒（没听清）]
 *   不转写：[语音 45秒]（超长/引擎关闭）
 */
export function formatVoiceText(info, { showEmotion = true, showEvent = true } = {}) {
  if (!info) return '[语音]';
  const sec = Number(info.seconds);
  const dur = Number.isFinite(sec) && sec > 0 ? ` ${Math.max(1, Math.round(sec))}秒` : '';
  const bits = [];
  if (showEmotion && info.emotion) bits.push(`语气${info.emotion}`);
  if (showEvent && info.event) bits.push(`有${info.event}`);
  const tag = `[语音${dur}${bits.length ? `·${bits.join('·')}` : ''}`;
  if (info.text) return `${tag}] ${info.text}`;
  if (info.status === 'empty') return `${tag}（没听清）]`;
  return `${tag}]`;
}

// ── 识别服务 ────────────────────────────────────────────────────────────────

// QQ 语音的媒体域名（NT 架构为 multimedia.nt.qq.com.cn；旧链路为 grouptalk.c2c.qq.com 等）。
const QQ_MEDIA_HOST_RE = /(^|\.)(qq\.com|qq\.com\.cn|qpic\.cn|gtimg\.cn|qlogo\.cn)$/i;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms); timer.unref?.(); })
  ]).finally(() => clearTimeout(timer));
}

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return {
    run(fn) { return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); }); },
    get active() { return active; },
    get pending() { return queue.length; }
  };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig   返回 socialV2.asr 原始配置（每次调用都读，控制台改了即时生效）
 * @param {string} deps.root              bridge 根目录（modelDir 相对它解析）
 * @param {(action:string, params:object, timeoutMs:number) => Promise<object>} deps.oneBot  调 SnowLuma HTTP 动作，返回原始 body
 * @param {(...args:any[]) => void} [deps.log]
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createAsrService({ getConfig, root, oneBot, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map(); // key → { at, promise }
  let sem = null;
  let semLimit = 0;
  let unavailable = null; // { reason, at }
  let warnedUnavailable = '';
  const stats = { transcribed: 0, failed: 0, fallbackQq: 0, viaGateway: 0, viaSilk: 0, lastMs: 0, lastError: '' };
  // 识别子进程（按需启动）。worker = { child, key, pid, pending: Map<id,{resolve,reject,timer}>, seq, isReady, ready }
  let worker = null;
  let idleTimer = null;
  let idleAt = 0;
  const life = { loads: 0, unloads: 0, crashes: 0, lastLoadMs: 0, loadedAt: 0, lastUsedAt: 0, lastUnloadReason: '' };

  const cfgNow = () => normalizeAsrConfig(typeof getConfig === 'function' ? getConfig() : {});

  function semaphore(cfg) {
    if (!sem || semLimit !== cfg.maxConcurrent) { sem = createSemaphore(cfg.maxConcurrent); semLimit = cfg.maxConcurrent; }
    return sem;
  }

  function modelPaths(cfg) {
    const dir = path.isAbsolute(cfg.modelDir) ? cfg.modelDir : path.resolve(root ?? process.cwd(), cfg.modelDir);
    const model = ['model.int8.onnx', 'model.onnx'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) ?? path.join(dir, 'model.int8.onnx');
    return { dir, model, tokens: path.join(dir, 'tokens.txt') };
  }

  // ── 识别子进程（按需加载）────────────────────────────────────────────────
  // 模型约占 850MB 内存，所以不在桥接进程里加载：第一条语音到来时 fork asr-worker.mjs，
  // 闲置 idleUnloadMs 后结束子进程，内存随进程退出完整归还系统。下一条语音再冷启动（约 0.5–1s）。

  const fmtDur = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`);

  function markUnavailable(error) {
    unavailable = { reason: error?.message ?? String(error), at: Date.now() };
    if (warnedUnavailable !== unavailable.reason) {
      warnedUnavailable = unavailable.reason;
      log(`[asr] 本地识别不可用：${unavailable.reason}`);
    }
    return error;
  }

  /** 有请求在途（或正在加载）时 ref 子进程，空闲时 unref —— 识别子进程本身不应该把父进程「吊着」不退出。 */
  function refWorker(w) {
    const busy = !w.isReady || w.pending.size > 0;
    try {
      if (busy) { w.child.ref(); w.child.channel?.ref?.(); }
      else { w.child.unref(); w.child.channel?.unref?.(); }
    } catch {}
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    idleAt = 0;
  }

  function stopWorker(reason, { quiet = false } = {}) {
    clearIdle();
    const w = worker;
    if (!w) return false;
    worker = null;
    w.stopped = true;
    for (const [, p] of w.pending) { clearTimeout(p.timer); p.reject(new Error(`识别进程已结束（${reason}）`)); }
    w.pending.clear();
    w.rejectReady?.(new Error(`识别进程已结束（${reason}）`));
    try { w.child.kill(); } catch {}
    life.unloads++;
    life.lastUnloadReason = reason;
    if (!quiet) log(`[asr] 已释放 SenseVoice 识别进程（${reason}），内存已归还系统`);
    return true;
  }

  function scheduleIdle(cfg) {
    clearIdle();
    if (!worker || !worker.isReady || worker.pending.size || cfg.idleUnloadMs <= 0) return;
    const ms = cfg.idleUnloadMs;
    idleAt = Date.now() + ms;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      idleAt = 0;
      if (worker && !worker.pending.size) stopWorker(`闲置 ${fmtDur(ms)}`);
    }, ms);
    idleTimer.unref?.();
  }

  /** 拿到一个已加载好模型的子进程；参数（模型/线程/语言）变了就换一个。 */
  function ensureWorker(cfg) {
    const mp = modelPaths(cfg);
    const key = `${mp.model}|${cfg.numThreads}|${cfg.language}|${cfg.useItn}`;
    if (worker && worker.key === key) return worker.ready;
    if (worker) stopWorker('识别参数已变更');
    if (!fs.existsSync(mp.model) || !fs.existsSync(mp.tokens)) {
      return Promise.reject(markUnavailable(new Error(`找不到 SenseVoice 模型（${path.relative(root ?? process.cwd(), mp.dir) || mp.dir}）；运行 npm run setup:asr 下载`)));
    }
    try { require.resolve('sherpa-onnx-node'); } catch (error) {
      return Promise.reject(markUnavailable(new Error(`未安装 sherpa-onnx-node（npm i sherpa-onnx-node）：${error?.message ?? error}`)));
    }
    const t0 = Date.now();
    // execArgv: [] —— 不继承父进程的 --inspect 等参数（否则调试端口冲突）
    const child = fork(WORKER_PATH, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let errTail = '';
    child.stderr?.on('data', (b) => { errTail = (errTail + b.toString()).slice(-600); });
    child.stderr?.unref?.();
    const w = { child, key, pid: child.pid, pending: new Map(), seq: 0, isReady: false };
    w.ready = new Promise((resolve, reject) => { w.resolveReady = resolve; w.rejectReady = reject; });
    const loadTimer = setTimeout(() => w.rejectReady(new Error(`SenseVoice 加载超时（${WORKER_LOAD_TIMEOUT_MS}ms）`)), WORKER_LOAD_TIMEOUT_MS);
    loadTimer.unref?.();
    child.on('message', (m) => {
      if (m?.type === 'ready') {
        clearTimeout(loadTimer);
        w.isReady = true;
        life.loads++;
        life.lastLoadMs = Date.now() - t0;
        life.loadedAt = Date.now();
        unavailable = null;
        warnedUnavailable = '';
        log(`[asr] SenseVoice 已按需加载（子进程 ${child.pid}，${life.lastLoadMs}ms，${cfg.numThreads} 线程）`);
        refWorker(w);
        w.resolveReady(w);
        if (worker === w && !w.pending.size) scheduleIdle(cfgNow());
      } else if (m?.type === 'fatal') {
        w.rejectReady(new Error(String(m.error ?? '识别进程加载失败')));
      } else if (m?.type === 'result' || m?.type === 'error') {
        const p = w.pending.get(m.id);
        if (!p) return;
        w.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.type === 'result') p.resolve(m.result ?? {});
        else p.reject(new Error(String(m.error ?? '识别失败')));
        refWorker(w);
        if (worker === w && !w.pending.size) scheduleIdle(cfgNow());
      }
    });
    child.on('error', (error) => w.rejectReady(error));
    child.on('exit', (code, signal) => {
      clearTimeout(loadTimer);
      const last = errTail.trim().split('\n').pop();
      const reason = `识别进程退出（code=${code ?? '-'}${signal ? `，${signal}` : ''}）${last ? `：${last}` : ''}`;
      w.rejectReady(new Error(reason));
      for (const [, p] of w.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
      w.pending.clear();
      if (worker === w) { // 不是我们主动结束的：崩溃。下一条语音会重新拉起
        worker = null;
        clearIdle();
        life.crashes++;
        log(`[asr] ${reason}`);
      }
    });
    worker = w;
    w.ready.catch((error) => {
      if (w.stopped) return; // 我们主动结束的（参数变更/手动释放），不算「不可用」
      markUnavailable(error);
      if (worker === w) { worker = null; clearIdle(); }
      try { child.kill(); } catch {}
    });
    try {
      child.send({ type: 'init', model: mp.model, tokens: mp.tokens, numThreads: cfg.numThreads, language: cfg.language === 'auto' ? '' : cfg.language, useItn: cfg.useItn });
    } catch (error) {
      w.rejectReady(error);
    }
    return w.ready;
  }

  async function recognizeLocal(cfg, pcm16k) {
    const w = await ensureWorker(cfg);
    clearIdle();
    life.lastUsedAt = Date.now();
    const id = ++w.seq;
    const r = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!w.pending.delete(id)) return;
        reject(new Error(`本地识别超时（${cfg.timeoutMs}ms）`));
        if (worker === w) stopWorker('识别超时，重启识别进程');
      }, cfg.timeoutMs);
      timer.unref?.();
      w.pending.set(id, { resolve, reject, timer });
      refWorker(w);
      try {
        w.child.send({ type: 'decode', id, samples: pcm16k instanceof Float32Array ? pcm16k : Float32Array.from(pcm16k) });
      } catch (error) {
        w.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
    const tags = senseVoiceTags(r);
    return { text: String(r?.text ?? ''), ...tags, engine: 'sensevoice' };
  }

  /** 拿到 16k 单声道 PCM：先走网关转码，失败再直接下载原始 SILK 自己解码。 */
  async function fetchPcm(cfg, d) {
    const errors = [];
    const ref = d.file || d.file_id || '';
    if (ref && typeof oneBot === 'function') {
      try {
        const body = await oneBot('get_record', { ...(d.file ? { file: d.file } : {}), ...(d.file_id ? { file_id: d.file_id } : {}), out_format: 'wav' }, Math.min(cfg.timeoutMs, 10000));
        const b64 = body?.status === 'ok' && body?.retcode === 0 ? String(body?.data?.base64 ?? '') : '';
        if (b64) {
          const buf = Buffer.from(b64, 'base64');
          if (buf.length > cfg.maxBytes * 8) throw new Error('网关返回的音频过大');
          const wav = parseWav(buf);
          stats.viaGateway++;
          return { pcm: resampleLinear(wav.samples, wav.sampleRate, 16000), seconds: wav.seconds, via: 'gateway' };
        }
        errors.push(`get_record：${body?.wording || body?.message || body?.retcode || '无 base64'}`);
      } catch (error) {
        errors.push(`get_record：${error?.message ?? error}`);
      }
    }
    const url = String(d.url ?? '');
    if (/^https?:\/\//i.test(url)) {
      try {
        const host = new URL(url).hostname;
        if (!QQ_MEDIA_HOST_RE.test(host)) throw new Error(`拒绝下载非 QQ 媒体域名 ${host}`);
        await validateFetchUrl(url); // 私网/回环地址校验（防 SSRF）
        const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 10000)) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') || 0);
        if (len && len > cfg.maxBytes) throw new Error('语音文件过大');
        const raw = Buffer.from(await res.arrayBuffer());
        if (raw.length > cfg.maxBytes) throw new Error('语音文件过大');
        if (raw.toString('latin1', 0, 4) === 'RIFF') {
          const wav = parseWav(raw);
          stats.viaSilk++;
          return { pcm: resampleLinear(wav.samples, wav.sampleRate, 16000), seconds: wav.seconds, via: 'url-wav' };
        }
        let silk;
        try { silk = require('silk-wasm'); } catch (error) { throw new Error(`未安装 silk-wasm：${error?.message ?? error}`); }
        if (!silk.isSilk(raw)) throw new Error('不是 SILK/WAV 音频');
        const dec = await silk.decode(raw, 16000);
        stats.viaSilk++;
        return { pcm: pcm16ToFloat32(dec.data), seconds: Number(dec.duration) / 1000, via: 'silk' };
      } catch (error) {
        errors.push(`url：${error?.message ?? error}`);
      }
    }
    throw new Error(errors.join('；') || '语音段没有可用的 file/url');
  }

  async function qqTranscript(cfg, messageId) {
    if (!messageId || typeof oneBot !== 'function') return '';
    try {
      const body = await oneBot('fetch_ptt_text', { message_id: String(messageId) }, Math.min(cfg.timeoutMs, 10000));
      if (body?.status === 'ok' && body?.retcode === 0) return String(body?.data?.text ?? '');
    } catch {}
    return '';
  }

  async function transcribeUncached(cfg, d, ctx) {
    const t0 = Date.now();
    if (cfg.engine === 'qq') {
      const text = sanitizeTranscript(await qqTranscript(cfg, ctx.messageId), cfg.maxTextChars);
      return { status: text ? 'ok' : 'empty', text, seconds: null, emotion: '', event: '', engine: 'qq', ms: Date.now() - t0 };
    }
    let audio;
    try {
      audio = await fetchPcm(cfg, d);
    } catch (error) {
      if (cfg.qqFallback) {
        const text = sanitizeTranscript(await qqTranscript(cfg, ctx.messageId), cfg.maxTextChars);
        if (text) { stats.fallbackQq++; return { status: 'ok', text, seconds: null, emotion: '', event: '', engine: 'qq', ms: Date.now() - t0 }; }
      }
      throw error;
    }
    if (audio.seconds > cfg.maxSeconds) {
      return { status: 'skipped', reason: 'too_long', text: '', seconds: audio.seconds, emotion: '', event: '', engine: cfg.engine, ms: Date.now() - t0 };
    }
    let r;
    try {
      r = await recognizeLocal(cfg, audio.pcm);
    } catch (error) {
      if (cfg.qqFallback) {
        const text = sanitizeTranscript(await qqTranscript(cfg, ctx.messageId), cfg.maxTextChars);
        if (text) { stats.fallbackQq++; return { status: 'ok', text, seconds: audio.seconds, emotion: '', event: '', engine: 'qq', via: audio.via, ms: Date.now() - t0 }; }
      }
      throw error;
    }
    const text = sanitizeTranscript(r.text, cfg.maxTextChars);
    return { status: text ? 'ok' : 'empty', text, seconds: audio.seconds, emotion: r.emotion, event: r.event, lang: r.lang, engine: r.engine, via: audio.via, ms: Date.now() - t0 };
  }

  /**
   * 转写一个 record 段。同一个文件只转写一次（Promise 级缓存，并发调用共享同一次识别）。
   * 永不抛错：失败返回 { status:'error', error }，调用方据此回退为「[语音]」占位。
   */
  async function transcribeSegment(d = {}, ctx = {}) {
    const cfg = cfgNow();
    if (!cfg.enabled || cfg.engine === 'off') return null;
    const key = String(d.file || d.file_id || d.url || '');
    if (!key) return null;
    const hit = cache.get(key);
    if (hit) return hit.promise;
    const promise = semaphore(cfg)
      .run(() => withTimeout(transcribeUncached(cfg, d, ctx), cfg.timeoutMs, '语音转写'))
      .then((info) => {
        stats.transcribed++;
        stats.lastMs = info.ms ?? 0;
        return info;
      })
      .catch((error) => {
        stats.failed++;
        stats.lastError = error?.message ?? String(error);
        log(`[asr] 语音转写失败：${stats.lastError}`);
        // 失败结果不长期缓存：60s 后允许重试（网关刚重启/模型刚下载好的情况）
        setTimeout(() => { if (cache.get(key)?.promise === promise) cache.delete(key); }, 60000).unref?.();
        return { status: 'error', error: stats.lastError, text: '', seconds: null };
      });
    cache.set(key, { at: Date.now(), promise });
    while (cache.size > cfg.cacheSize) cache.delete(cache.keys().next().value);
    return promise;
  }

  /**
   * 预加载模型。桥接启动时调用 warmup()：只有配置了 preload:true 才会真的加载（默认按需）；
   * 控制台「立即加载」调用 warmup({ force:true })。加载后同样受 idleUnloadMs 约束。失败只记日志。
   */
  async function warmup({ force = false } = {}) {
    const cfg = cfgNow();
    if (!cfg.enabled || cfg.engine !== 'sensevoice') return false;
    if (!force && !cfg.preload) return false;
    try {
      await ensureWorker(cfg);
      if (worker && !worker.pending.size) scheduleIdle(cfg);
      return true;
    } catch {
      return false;
    }
  }

  /** 立即结束识别子进程、释放内存（控制台「立即释放」）。下一条语音会重新按需加载。 */
  function unload(reason = '手动释放') {
    return stopWorker(reason);
  }

  /** 关闭服务（测试/进程退出用），不打日志。 */
  function close() {
    stopWorker('关闭', { quiet: true });
  }

  function status() {
    const cfg = cfgNow();
    const mp = modelPaths(cfg);
    let sherpaInstalled = false;
    try { require.resolve('sherpa-onnx-node'); sherpaInstalled = true; } catch {}
    let silkInstalled = false;
    try { require.resolve('silk-wasm'); silkInstalled = true; } catch {}
    return {
      enabled: cfg.enabled,
      engine: cfg.engine,
      modelReady: fs.existsSync(mp.model) && fs.existsSync(mp.tokens),
      sherpaInstalled,
      silkInstalled,
      loadMode: cfg.preload ? 'preload' : 'onDemand',
      idleUnloadMs: cfg.idleUnloadMs,
      loaded: Boolean(worker?.isReady),
      loading: Boolean(worker && !worker.isReady),
      workerPid: worker?.pid ?? null,
      idleUnloadAt: idleAt || null,
      ...life,
      unavailable: unavailable?.reason ?? null,
      cached: cache.size,
      ...stats
    };
  }

  return { transcribeSegment, warmup, unload, close, status, _cache: cache };
}
