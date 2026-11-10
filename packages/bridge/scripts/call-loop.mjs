#!/usr/bin/env node
/**
 * B-2 通话回路：把 QQ 通话的声音接进 DSH，再把她的回答用 TTS 送回 QQ 麦克风。
 *
 *   容器 QQ ──播放──▶ qq_out ──monitor──▶ parec ──▶ VAD ──▶ SenseVoice ──▶ DSH
 *                                                                          │
 *   容器 QQ ◀──录音── qq_in ◀──FIFO── cat ◀── 48k PCM ◀── ffmpeg ◀── TTS ◀─┘
 *
 * 用法：
 *   node scripts/call-loop.mjs                     # 正常跑（需要一个容器 + 一通电话）
 *   node scripts/call-loop.mjs --from-wav a.wav --out-wav out.raw --once   # 离线自测
 *
 * 说明：
 *   · 只跑这一支，不碰 bridge.js；QQ 聊天照常。
 *   · 默认不挂 agent preset（无工具），只求"能听、能想、能说"。
 *     想带上她的人格，加 --preset qq-chat-v2，但那样会话里会有 QQ 工具，通话中她可能想发消息。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { pcm16ToFloat32, resampleLinear, parseWav } from '../src/voice-asr.js';
import { createTtsService } from '../src/voice-tts.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const T0 = Date.now();

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    container: 'snowluma',
    device: 'qq_out.monitor',
    fifo: '/tmp/qqin.pcm',
    preset: '',
    cwd: path.join(ROOT, 'data', 'agents'),
    fromWav: '',
    outWav: '',
    once: false,
    tts: true,
    maxSeconds: 0,
    asrPromptHint: ''
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少参数`);
      return v;
    };
    if (a === '--container') out.container = val();
    else if (a === '--device') out.device = val();
    else if (a === '--fifo') out.fifo = val();
    else if (a === '--preset') out.preset = val();
    else if (a === '--cwd') out.cwd = path.resolve(val());
    else if (a === '--from-wav') out.fromWav = path.resolve(val());
    else if (a === '--out-wav') out.outWav = path.resolve(val());
    else if (a === '--once') out.once = true;
    else if (a === '--no-tts') out.tts = false;
    else if (a === '--max-seconds') out.maxSeconds = Number(val()) || 0;
    else if (a === '--hint') out.asrPromptHint = val();
    else if (a === '-h' || a === '--help') { out.help = true; }
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// ── 日志 ────────────────────────────────────────────────────────────────────

const stamp = () => `${((Date.now() - T0) / 1000).toFixed(2)}s`;
const log = (stage, msg) => console.log(`${stamp().padStart(7)}  ${stage.padEnd(6)} ${msg}`);

// ── 配置 ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw;
}

// ── 采集 ────────────────────────────────────────────────────────────────────

const SR = 16000;
const FRAME_SAMPLES = 480; // 30ms
const FRAME_BYTES = FRAME_SAMPLES * 2;

/**
 * 采集源：容器里的 parec，或者一个 WAV 文件（离线自测）。
 * 统一吐 16k/单声道/s16le 的定长帧。
 */
class Capture {
  constructor(opts) {
    this.opts = opts;
    this.onFrame = () => {};
    this.child = null;
    this.closed = false;
  }

  start() {
    if (this.opts.fromWav) return this._startFromWav();
    const args = [
      'exec', this.opts.container,
      'parec', `--device=${this.opts.device}`,
      '--format=s16le', `--rate=${SR}`, '--channels=1', '--raw'
    ];
    log('capture', `docker ${args.join(' ')}`);
    this.child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (b) => log('capture', `stderr: ${String(b).trim()}`));
    this.child.on('exit', (code) => {
      if (!this.closed) log('capture', `parec 退出（code=${code}）`);
    });
    this._pumpStream(this.child.stdout);
  }

  _startFromWav() {
    const buf = fs.readFileSync(this.opts.fromWav);
    const wav = parseWav(buf);
    let samples = wav.samples;
    if (wav.sampleRate !== SR) samples = resampleLinear(samples, wav.sampleRate, SR);
    // 末尾补 1 秒静音，保证 VAD 能收尾
    const padded = new Float32Array(samples.length + SR);
    padded.set(samples, 0);
    const pcm = Buffer.alloc(padded.length * 2);
    for (let i = 0; i < padded.length; i++) {
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(padded[i] * 32767))), i * 2);
    }
    log('capture', `wav ${wav.sampleRate}Hz/${wav.channels}ch → ${(pcm.length / 2 / SR).toFixed(2)}s @16k`);
    this._feed(pcm);
  }

  _pumpStream(stream) {
    let rest = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % FRAME_BYTES);
      for (let off = 0; off < usable; off += FRAME_BYTES) {
        this.onFrame(buf.subarray(off, off + FRAME_BYTES));
      }
      rest = buf.subarray(usable);
    });
  }

  _feed(pcm) {
    for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
      this.onFrame(pcm.subarray(off, off + FRAME_BYTES));
    }
  }

  close() {
    this.closed = true;
    try { this.child?.kill('SIGTERM'); } catch {}
  }
}

// ── VAD ─────────────────────────────────────────────────────────────────────

function rms(frame) {
  let sum = 0;
  const n = frame.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = frame.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** 能量 VAD：自适应噪声底 + 起始/收尾滞回。够用来切人声，不追求抗噪。 */
class Vad {
  constructor({ onUtterance, log }) {
    this.onUtterance = onUtterance;
    this.log = log;
    this.state = 'idle';
    this.noise = 0.002;
    this.frames = [];
    this.speechRun = 0;
    this.silenceRun = 0;
    this.preroll = [];
    this.maxFrames = Math.round(15 * 1000 / 30); // 15s 上限
  }

  threshold() {
    return Math.min(0.2, Math.max(0.0045, this.noise * 3.2));
  }

  push(frame) {
    const energy = rms(frame);
    const isSpeech = energy > this.threshold();

    if (this.state === 'idle') {
      if (!isSpeech) {
        this.noise = this.noise * 0.97 + energy * 0.03;
        this.preroll.push(frame);
        if (this.preroll.length > 10) this.preroll.shift(); // 300ms 预卷
        this.speechRun = 0;
        return;
      }
      this.speechRun++;
      this.preroll.push(frame);
      if (this.preroll.length > 10) this.preroll.shift();
      if (this.speechRun >= 3) {
        this.state = 'active';
        this.frames = [...this.preroll];
        this.preroll = [];
        this.silenceRun = 0;
      }
      return;
    }

    // active
    this.frames.push(frame);
    if (isSpeech) this.silenceRun = 0;
    else this.silenceRun++;

    if (this.silenceRun >= 12 || this.frames.length >= this.maxFrames) {
      this._finish(this.silenceRun >= 12 ? 'silence' : 'maxlen');
    }
  }

  _finish(reason) {
    // 去掉尾巴多余静音，保留 ~150ms
    const keep = Math.max(0, this.frames.length - Math.max(0, this.silenceRun - 5));
    const frames = this.frames.slice(0, keep);
    const pcm = Buffer.concat(frames);
    const seconds = pcm.length / 2 / SR;
    this.state = 'idle';
    this.frames = [];
    this.preroll = [];
    this.speechRun = 0;
    this.silenceRun = 0;
    if (seconds < 0.45) {
      this.log('vad', `丢弃过短片段 ${seconds.toFixed(2)}s`);
      return;
    }
    this.log('vad', `一句话 ${seconds.toFixed(2)}s（${reason}）`);
    this.onUtterance(pcm, seconds);
  }

  flush() {
    if (this.state === 'active') this._finish('flush');
  }
}

// ── 识别 ────────────────────────────────────────────────────────────────────

class Asr {
  constructor({ modelDir, numThreads = 2, language = 'zh' }) {
    this.modelDir = modelDir;
    this.numThreads = numThreads;
    this.language = language;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
  }

  async open() {
    const model = path.join(this.modelDir, 'model.int8.onnx');
    const tokens = path.join(this.modelDir, 'tokens.txt');
    if (!fs.existsSync(model)) throw new Error(`找不到 SenseVoice 模型：${model}（先跑 npm run setup:asr）`);
    const t0 = Date.now();
    this.child = fork(path.join(ROOT, 'src', 'asr-worker.mjs'), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    this.child.on('message', (m) => {
      if (m?.type === 'ready') log('asr', `模型加载完成 ${Date.now() - t0}ms`);
      else if (m?.type === 'fatal') log('asr', `加载失败：${m.error}`);
      const waiter = this.pending.get(m?.id);
      if (waiter) {
        this.pending.delete(m.id);
        if (m.type === 'result') waiter.resolve(m.result);
        else waiter.reject(new Error(m.error ?? '识别失败'));
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('加载 SenseVoice 超时（120s）')), 120000);
      this.child.on('message', (m) => {
        if (m?.type === 'ready') { clearTimeout(timer); resolve(); }
        else if (m?.type === 'fatal') { clearTimeout(timer); reject(new Error(m.error)); }
      });
      this.child.send({ type: 'init', model, tokens, numThreads: this.numThreads, language: this.language, useItn: true });
    });
  }

  decode(samples) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ type: 'decode', id, samples });
    });
  }

  close() {
    try { this.child?.kill('SIGTERM'); } catch {}
  }
}

// ── 麦克风（注入） ──────────────────────────────────────────────────────────

class Mic {
  constructor({ container, fifo, outWav }) {
    this.container = container;
    this.fifo = fifo;
    this.outWav = outWav;
    this.child = null;
    this.file = null;
  }

  start() {
    if (this.outWav) {
      this.file = fs.createWriteStream(this.outWav);
      log('mic', `输出到文件 ${this.outWav}`);
      return;
    }
    this.child = spawn('docker', ['exec', '-i', this.container, 'sh', '-c', `cat > ${this.fifo}`], {
      stdio: ['pipe', 'ignore', 'pipe']
    });
    this.child.stderr.on('data', (b) => log('mic', `stderr: ${String(b).trim()}`));
    this.child.on('exit', (code) => log('mic', `注入进程退出（code=${code}）`));
    log('mic', `注入到 ${this.container}:${this.fifo}`);
  }

  async write(pcm) {
    if (this.file) {
      await new Promise((r) => this.file.write(pcm, r));
      return;
    }
    if (!this.child?.stdin?.writable) return;
    await new Promise((resolve) => {
      const ok = this.child.stdin.write(pcm, () => resolve());
      if (!ok) this.child.stdin.once('drain', resolve);
    });
  }

  close() {
    try { this.child?.stdin?.end(); } catch {}
    try { this.file?.end(); } catch {}
  }
}

// ── 大脑：DSH 会话 ──────────────────────────────────────────────────────────

const CALL_HINT = '（正在打电话。用口语回答，一到两句，不要列表、不要 markdown、不要提"工具"或"会话"。）';

class Brain {
  constructor({ cfg, preset, cwd, log }) {
    this.cfg = cfg;
    this.preset = preset;
    this.cwd = cwd;
    this.log = log;
    this.api = null;
    this.sessionId = null;
    this.collector = null;
    this.pending = null;
    this.closed = false;
  }

  async open() {
    const dsh = this.cfg.dsh ?? {};
    this.api = new NodeApiClient(dsh.baseUrl, undefined, {
      token: dsh.authToken,
      tokenExplicit: dsh.authTokenExplicit === true,
      header: dsh.authHeader,
      prefix: dsh.authPrefix,
      allowRemote: dsh.allowRemote === true
    });
    fs.mkdirSync(this.cwd, { recursive: true });
    const ws = unwrap(await this.api.workspace.create({ path: this.cwd }), 'workspace.create');
    const params = { workspaceId: ws.workspace.workspaceId };
    if (this.preset) params.agentPreset = this.preset;
    const value = unwrap(await this.api.sessions.create(params), 'session.create');
    this.sessionId = value.sessionId;
    // 事件流必须显式 follow 才会下发这个会话的 turn 事件（不 follow 就永远等不到回复）
    this.api.events.follow(this.sessionId);
    this.log('brain', `会话 ${this.sessionId}（preset=${this.preset || '无'}）`);
    this._pump();
  }

  async _pump() {
    let retry = 3000;
    while (!this.closed) {
      try {
        for await (const envelope of this.api.events.mux({})) {
          const frame = envelope.payload;
          if (frame?.type !== 'session/event' || frame.sessionId !== this.sessionId) continue;
          const ended = this.collector ? this.collector.push(frame.event) : null;
          if (ended && this.pending) {
            const { resolve, timer } = this.pending;
            this.pending = null;
            clearTimeout(timer);
            resolve(ended.text ?? '');
          }
        }
        retry = 3000;
      } catch (error) {
        if (this.closed) return;
        this.log('brain', `事件流断开：${String(error?.message ?? error).slice(0, 120)}，${retry}ms 后重连`);
        await new Promise((r) => setTimeout(r, retry));
        retry = Math.min(retry * 2, 15000);
      }
    }
  }

  async ask(text, { timeoutMs = 90000 } = {}) {
    if (!this.sessionId) throw new Error('会话还没建好');
    this.collector = createTurnCollector();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) this.pending = null;
        reject(new Error(`等回复超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending = { resolve, timer };
    });
    const content = [{ type: 'text', text: `${CALL_HINT}\n\n${text}` }];
    const accepted = await this.api.sessions.prompt({ sessionId: this.sessionId, mode: 'queue', content });
    if (!accepted?.result?.ok) {
      throw new Error(`prompt 被拒：${accepted?.result?.error?.code}: ${accepted?.result?.error?.message}`);
    }
    return reply;
  }

  close() {
    this.closed = true;
  }
}

// ── 文本 → 可念的短句 ───────────────────────────────────────────────────────

function toSpeechText(text, max = 80) {
  const t = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  // 电话里最多说两句：多说了对方等不起，也听着像念稿。
  const parts = t.split(/(?<=[。！？!?~～])/).filter((s) => s.trim());
  let out = '';
  for (const p of parts.slice(0, 2)) {
    if (out && out.length + p.length > max) break;
    out += p;
  }
  if (!out) out = t.length > max ? `${t.slice(0, max)}…` : t;
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node scripts/call-loop.mjs [--container snowluma] [--preset qq-chat-v2] [--from-wav a.wav] [--out-wav out.raw] [--once] [--no-tts]');
    return;
  }
  const cfg = loadConfig();
  const asrDir = (() => {
    const rel = cfg.socialV2?.asr?.modelDir || 'data/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
    return path.isAbsolute(rel) ? rel : path.resolve(ROOT, rel);
  })();

  log('boot', `容器=${opts.container} 设备=${opts.device} preset=${opts.preset || '无'}`);

  const brain = new Brain({ cfg, preset: opts.preset, cwd: opts.cwd, log });
  await brain.open();

  const asr = new Asr({ modelDir: asrDir, numThreads: cfg.socialV2?.asr?.numThreads ?? 2 });
  await asr.open();

  const tts = opts.tts
    ? createTtsService({ getConfig: () => cfg.socialV2?.speak ?? {}, root: ROOT, log: (m) => log('tts', m) })
    : null;
  const mic = new Mic({ container: opts.container, fifo: opts.fifo, outWav: opts.outWav });
  mic.start();

  const queue = [];
  let busy = false;
  let stopped = false;

  async function speak(text) {
    if (!tts) return;
    const clean = toSpeechText(text);
    if (!clean) { log('tts', '没有可念的内容'); return; }
    const t = Date.now();
    const { buffer, ext, seconds } = await tts.synthesize(clean);
    log('tts', `${ext} ${(buffer.length / 1024).toFixed(0)}KB ${seconds ?? '?'}s 合成${Date.now() - t}ms：「${clean}」`);
    // 任意格式 → 48k 单声道 s16le
    const pcm = await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [];
      let err = '';
      ff.stdout.on('data', (c) => chunks.push(c));
      ff.stderr.on('data', (c) => { err += c; });
      ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg 转码失败：${err.slice(0, 160)}`))));
      ff.stdin.end(buffer);
    });
    await mic.write(pcm);
    log('mic', `已送入 ${(pcm.length / 2 / 48000).toFixed(2)}s 音频`);
  }

  async function handleUtterance(pcm, seconds, index) {
    const t0 = Date.now();
    const samples = pcm16ToFloat32(pcm);
    const asrResult = await asr.decode(samples);
    const heard = String(asrResult?.text ?? '').trim();
    log('asr', `${Date.now() - t0}ms → 「${heard}」`);
    if (!heard || heard.length < 2) {
      log('asr', '没听清，跳过');
      return;
    }
    const t1 = Date.now();
    const reply = await brain.ask(heard);
    log('brain', `${Date.now() - t1}ms → 「${String(reply).slice(0, 120)}」`);
    if (!reply?.trim()) return;
    await speak(reply);
    log('turn', `整轮 ${Date.now() - t0}ms（说话 ${seconds.toFixed(1)}s）`);
  }

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try {
          await handleUtterance(item.pcm, item.seconds, item.index);
        } catch (error) {
          log('turn', `处理失败：${String(error?.message ?? error)}`);
        }
      }
    } finally {
      busy = false;
      if (opts.once && queue.length === 0) shutdown(0);
    }
  }

  let utteranceIndex = 0;
  const vad = new Vad({
    log,
    onUtterance: (pcm, seconds) => {
      queue.push({ pcm, seconds, index: ++utteranceIndex });
      drain();
    }
  });

  const capture = new Capture(opts);
  capture.onFrame = (f) => vad.push(f);
  capture.start();

  function shutdown(code = 0) {
    if (stopped) return;
    stopped = true;
    log('boot', '收尾…');
    try { vad.flush(); } catch {}
    capture.close();
    mic.close();
    asr.close();
    brain.close();
    setTimeout(() => process.exit(code), 300);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (opts.maxSeconds > 0) setTimeout(() => shutdown(0), opts.maxSeconds * 1000);
  if (opts.fromWav) setTimeout(() => shutdown(0), 120000);

  log('boot', '就绪，等声音…');
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
