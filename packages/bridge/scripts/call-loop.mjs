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
import os from 'node:os';
import path from 'node:path';
import { spawn, fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { pcm16ToFloat32, resampleLinear, parseWav } from '../src/voice-asr.js';
import { createTtsService } from '../src/voice-tts.js';
import { SpeakerTracker } from '../src/speaker-tracker.js';
import { VoiceprintStore } from '../src/voiceprints.js';
import { readConsoleToken } from '../src/call-presence.js';
import { startSayServer } from '../src/call-say-server.js';
import { buildCrossChannelNote } from '../src/call-context.js';
import { parseWindows, pickNewWindow } from '../src/x11-windows.js';
import {
  normalizeCallConfig, matchCaller, friendNameIndex, CALL_GROUP_GEOMETRY_DEFAULTS
} from '../src/call-config.js';

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
    micNoise: 40,
    autoAnswer: '',
    acceptX: null,
    acceptY: null,
    simulateCall: false,
    identifyShot: '',
    identifySize: '800x600',
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
    else if (a === '--mic-noise') out.micNoise = Number(val()) || 0;
    else if (a === '--auto-answer') {
      const v = (argv[i + 1] ?? '').toLowerCase();
      if (v === 'on' || v === 'learn') { out.autoAnswer = v; i++; } else out.autoAnswer = 'learn';
    }
    else if (a === '--accept-x') out.acceptX = Number(val());
    else if (a === '--accept-y') out.acceptY = Number(val());
    else if (a === '--simulate-call') out.simulateCall = true;
    else if (a === '--identify-shot') out.identifyShot = path.resolve(val());
    else if (a === '--identify-size') out.identifySize = val();
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
    this.retries = 0;
    this.restarting = false;
  }

  start() {
    if (this.opts.fromWav) return this._startFromWav();
    const inner = `echo $$ > /tmp/call-capture.pid; exec parec --device=${this.opts.device} `
      + `--format=s16le --rate=${SR} --channels=1 --raw`;
    log('capture', `docker exec ${this.opts.container} sh -c '${inner}'`);
    this.child = spawn('docker', ['exec', this.opts.container, 'sh', '-c', inner], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (b) => log('capture', `stderr: ${String(b).trim()}`));
    this.child.on('exit', (code) => {
      if (this.closed) return;
      log('capture', `parec 退出（code=${code}）`);
      // 容器重启 / PA 掉线时 parec 会立刻退出。别就此哑掉：指数退避重开，
      // 每次重开前先补 PulseAudio 和虚拟设备；数据一恢复就把重试计数清零。
      // 不设上限 —— 这是个常驻进程，容器可能半夜才被 watchdog 拉起来。
      if (this.restarting) return;
      this.retries += 1;
      this.restarting = true;
      const delay = Math.min(30_000, 3000 * 2 ** Math.min(this.retries - 1, 4));
      setTimeout(async () => {
        this.restarting = false;
        if (this.closed) return;
        await ensurePulseAudio(this.opts);
        if (!this.closed) this.start();
      }, delay);
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
      this.retries = 0;
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
    // docker exec 的客户端被杀，容器里的 parec 不会跟着退 —— 按 pid 补一刀
    try {
      spawn('docker', ['exec', this.opts.container, 'sh', '-c',
        'kill $(cat /tmp/call-capture.pid) 2>/dev/null; rm -f /tmp/call-capture.pid'], { stdio: 'ignore' });
    } catch {}
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
  constructor({ onUtterance, onSpeechStart, log }) {
    this.onUtterance = onUtterance;
    this.onSpeechStart = onSpeechStart || (() => {});
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
        this.onSpeechStart();
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

    if (this.silenceRun >= 15 || this.frames.length >= this.maxFrames) {
      this._finish(this.silenceRun >= 15 ? 'silence' : 'maxlen');
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

  /** 丢掉当前正在攒的那一句和预卷（挂断/未接通时用）。 */
  reset() {
    this.state = 'idle';
    this.frames = [];
    this.preroll = [];
    this.speechRun = 0;
    this.silenceRun = 0;
  }
}

// ── 识别 ────────────────────────────────────────────────────────────────────

class Asr {
  constructor({ modelDir, numThreads = 2, language = 'zh', log = () => {} }) {
    this.log = log;
    this.modelDir = modelDir;
    this.numThreads = numThreads;
    this.language = language;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
  }

  async ensure() {
    if (!this.child) await this.open();
  }

  /** 挂断后把识别进程结束掉，855MB 立刻还回去；下次通话再懒加载。 */
  unload(reason = '') {
    if (!this.child) return;
    try { this.child.kill('SIGTERM'); } catch {}
    this.child = null;
    for (const [, waiter] of this.pending) {
      try { waiter.reject(new Error('识别进程已卸载')); } catch {}
    }
    this.pending.clear();
    this.log(reason ? `识别进程已释放（${reason}）` : '识别进程已释放');
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

  async decode(samples) {
    await this.ensure();
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

const MIC_RATE = 48000;
const MIC_FRAME = 1920; // 20ms，单声道 s16le

/**
 * 虚拟麦克风。
 *
 * 关键点：**必须一直有数据在流**。
 * 早先的做法是「说话时写一段，其余时间空着」，结果 QQ 的采集链在每段话之间被饿死，
 * 重新出声时要热身，每句开头半秒都被吃掉（实测：对方只听到「就好」）。
 * 所以这里做成一个真正的麦克风：每 20ms 恒定写一帧，没话说就写本底噪声。
 */
class Mic {
  constructor({ container, fifo, outWav, noiseLevel = 40, onRecorderChange = () => {} }) {
    this.onRecorderChange = onRecorderChange;
    this.container = container;
    this.fifo = fifo;
    this.outWav = outWav;
    this.child = null;
    this.file = null;
    this.buf = Buffer.alloc(0);
    this.timer = null;
    this.noise = Buffer.alloc(MIC_FRAME);
    for (let i = 0; i < MIC_FRAME / 2; i++) {
      // 本底噪声：像一支真麦克风，而不是数字零（零会让降噪/AGC 判断失准）
      this.noise.writeInt16LE(Math.round((Math.random() * 2 - 1) * noiseLevel), i * 2);
    }
    this.droppedFrames = 0;
    this.pumping = false;
    this.watchTimer = null;
    this.recorder = false;
    this.sourceIdx = null;
  }

  start() {
    if (this.outWav) {
      this.file = fs.createWriteStream(this.outWav);
      log('mic', `输出到文件 ${this.outWav}`);
      return;
    }
    const inner = `echo $$ > /tmp/call-mic.pid; exec cat > ${this.fifo}`;
    this.child = spawn('docker', ['exec', '-i', this.container, 'sh', '-c', inner], {
      stdio: ['pipe', 'ignore', 'pipe']
    });
    this.child.stderr.on('data', (b) => log('mic', `stderr: ${String(b).trim()}`));
    this.child.on('exit', (code) => log('mic', `注入进程退出（code=${code}）`));
    log('mic', `注入到 ${this.container}:${this.fifo}`);
    // 关键：管道在没人录的时候会把数据囤起来（实测能攒到 5 秒），
    // 而 QQ 是接听后才有录音流 —— 那段积压会让她的第一句话整体延后。
    // 所以只在检测到 QQ 在录 qq_in 时才开泵。
    this._watchTimer = setInterval(() => { this._checkRecorder(); }, 3000);
    this._checkRecorder();
  }

  _pactl(args) {
    return new Promise((resolve) => {
      execFile('docker', ['exec', this.container, 'pactl', ...args], { timeout: 4000 }, (err, stdout) => {
        resolve(err ? '' : String(stdout));
      });
    });
  }

  async _checkRecorder() {
    if (this.file) return;
    if (!this.sourceIdx) {
      const sources = await this._pactl(['list', 'short', 'sources']);
      const line = sources.split('\n').find((l) => l.includes('qq_in'));
      if (!line) return;
      this.sourceIdx = line.trim().split(/\s+/)[0];
    }
    const idx = this.sourceIdx;
    const outputs = await this._pactl(['list', 'short', 'source-outputs']);
    const recording = outputs.split('\n').some((l) => l.trim() && l.trim().split(/\s+/)[1] === idx);
    if (recording === this.recorder) return;
    this.recorder = recording;
    try { this.onRecorderChange(recording); } catch {}
    if (recording) {
      log('mic', '检测到 QQ 在录音，麦克风开泵');
      this.pumping = true;
      this._loop();
    } else {
      log('mic', 'QQ 停止录音，麦克风待机（不再囤积数据）');
      this.pumping = false;
      this.buf = Buffer.alloc(0);
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 把一段 48k 单声道 PCM 排进麦克风（不阻塞，按真实时间播出去）。 */
  isSpeaking() { return this.buf.length > MIC_FRAME * 2; }

  flush() { this.buf = Buffer.alloc(0); }

  async speak(pcm) {
    if (this.file) { await this._writeFile(pcm); return; }
    // 补齐到整帧，避免半帧尾巴被截掉
    const pad = (MIC_FRAME - (pcm.length % MIC_FRAME)) % MIC_FRAME;
    this.buf = Buffer.concat([this.buf, pcm, Buffer.alloc(pad)]);
    log('mic', `排队 ${(pcm.length / 2 / MIC_RATE).toFixed(2)}s（待播 ${(this.buf.length / 2 / MIC_RATE).toFixed(2)}s）`);
  }

  _writeFile(pcm) {
    return new Promise((r) => this.file.write(pcm, r));
  }

  _loop() {
    clearInterval(this.timer);
    const t0 = Date.now();
    let sent = 0;
    this.timer = setInterval(() => {
      if (!this.pumping) return;
      const due = Math.floor((Date.now() - t0) / 20);
      let n = Math.min(due - sent, 4); // 落后了就补，最多补 4 帧
      while (n-- > 0) {
        if (!this._emit()) { this.droppedFrames++; break; } // 下游堵住：不推进时钟，等它缓过来
        sent++;
      }
      if (due - sent > 1500) sent = due; // 落后 30s 以上，放弃追赶
    }, 10);
  }

  _emit() {
    if (!this.child?.stdin?.writable) return false;
    // 下游没在消费（没来电时没人录 qq_in）：别往缓冲里堆，否则来电后要先把积压放完
    if (this.child.stdin.writableLength > MIC_FRAME * 25) return false;
    let frame;
    if (this.buf.length >= MIC_FRAME) {
      frame = Buffer.from(this.buf.subarray(0, MIC_FRAME));
      this.buf = this.buf.subarray(MIC_FRAME);
    } else {
      frame = this.noise;
    }
    this.child.stdin.write(frame);
    return true;
  }

  close() {
    try { clearInterval(this.timer); } catch {}
    try { clearInterval(this._watchTimer); } catch {}
    if (this.droppedFrames > 0) log('mic', `本次共跳过 ${this.droppedFrames} 帧（下游堵住过）`);
    try { this.child?.stdin?.end(); } catch {}
    try {
      spawn('docker', ['exec', this.container, 'sh', '-c',
        'kill $(cat /tmp/call-mic.pid) 2>/dev/null; rm -f /tmp/call-mic.pid'], { stdio: 'ignore' });
    } catch {}
    try { this.file?.end(); } catch {}
  }
}

// ── 来电观察 / 自动接听 ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 来电浮层的几何（800x600 窗口实测；全部相对窗口中心，窗口大小变了也不会错）
const AVATAR_DIAMETER = 116;
const AVATAR_DY = -129;          // 头像圆心 = 窗口中心 -(0,129)
const ACCEPT_DX = -68;           // 接听按钮圆心 = 窗口中心 +(-68,+186)
const ACCEPT_DY = 186;

const AVATAR_CACHE = path.join(ROOT, 'data', 'call-avatars');

/** 32x32 灰度向量里、半径为 14.5 的圆内像素（避开圆外角上的背景）。 */
const AVATAR_MASK = (() => {
  const pts = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if ((x - 15.5) ** 2 + (y - 15.5) ** 2 <= 14.5 ** 2) pts.push(y * 32 + x);
    }
  }
  return pts;
})();

function correlation(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let n = 0, sa = 0, sb = 0;
  for (const i of AVATAR_MASK) { sa += a[i]; sb += b[i]; n++; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (const i of AVATAR_MASK) {
    const u = a[i] - ma, v = b[i] - mb;
    num += u * v; da += u * u; db += v * v;
  }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}

async function ffmpegGray(input, filter) {
  if (!input || !fs.existsSync(input)) return null;
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', input, '-vf', filter,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    ff.on('error', () => resolve(null));
  });
}

/** 白名单某个 QQ 号的头像，缩成 32x32 灰度后缓存 7 天。 */
async function referenceAvatar(id, kind = 'friend') {
  fs.mkdirSync(AVATAR_CACHE, { recursive: true });
  const raw = path.join(AVATAR_CACHE, `${kind}-${id}.raw`);
  const jpg = path.join(AVATAR_CACHE, `${kind}-${id}.jpg`);
  try {
    if (fs.existsSync(raw) && Date.now() - fs.statSync(raw).mtimeMs < 7 * 86400000) {
      const buf = fs.readFileSync(raw);
      if (buf.length === 1024) return buf;
    }
  } catch { /* 缓存坏了就重下 */ }
  try {
    const url = kind === 'group'
      ? `https://p.qlogo.cn/gh/${encodeURIComponent(id)}/${encodeURIComponent(id)}/640`
      : `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(id)}&s=640`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    fs.writeFileSync(jpg, Buffer.from(await res.arrayBuffer()));
    const vec = await ffmpegGray(jpg, 'scale=32:32');
    if (vec?.length === 1024) { fs.writeFileSync(raw, vec); return vec; }
  } catch { /* 网络失败就当没有这个人的头像 */ }
  return null;
}

/** 单实例锁：两个 call-loop 同时跑会互相抢 FIFO 和 pid 文件。 */
const LOCK = path.join(ROOT, 'data', 'call-loop.lock');
function acquireLock() {
  try {
    const pid = Number(String(fs.readFileSync(LOCK, 'utf8')).trim());
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return pid; } catch { /* 进程没了，锁是陈的 */ }
    }
  } catch { /* 没有锁文件 */ }
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));
  return 0;
}
function releaseLock() {
  try {
    if (Number(String(fs.readFileSync(LOCK, 'utf8')).trim()) === process.pid) fs.unlinkSync(LOCK);
  } catch { /* 无所谓 */ }
}

/** 上一轮被强杀时容器里可能留着 parec / cat，启动先扫一遍。 */
async function sweepStale() {
  try {
    await execP('docker', ['exec', 'snowluma', 'sh', '-c',
      'for f in /tmp/call-capture.pid /tmp/call-mic.pid; do '
      + '[ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done; true']);
  } catch { /* 容器没起来就算了 */ }
}

/**
 * 容器重启后 PulseAudio 和 qq_out/qq_in 都会消失（脚本在 /b0 里，包还在）。
 * 采集前先确认 PA 和 qq_in 在，缺了就重跑 02-start-pa.sh —— 否则 parec 会
 * 以 code=1 退出，表现为「来电了但听不见」。
 */
async function ensurePulseAudio(opts) {
  if (opts.fromWav) return;
  try {
    await execP('docker', ['exec', opts.container, 'sh', '-c',
      'pactl info >/dev/null 2>&1 && pactl list short sources | grep -q qq_in']);
    return;
  } catch { /* 缺 PA 或 qq_in，下面补 */ }
  try {
    const out = await execP('docker', ['exec', opts.container, 'sh', '-c',
      'if [ -f /b0/02-start-pa.sh ]; then sh /b0/02-start-pa.sh; else echo "NO_SCRIPT"; fi']);
    log('capture', out.includes('NO_SCRIPT')
      ? '容器里没有 /b0/02-start-pa.sh，通话音频不可用（需要先 docker cp call-audio 到容器）'
      : 'PulseAudio 已就绪（已运行 02-start-pa.sh）');
  } catch (error) {
    log('capture', `PulseAudio 启动失败：${String(error?.message ?? error).slice(0, 160)}`);
  }
}

function execP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 200)));
      else resolve(String(stdout));
    });
  });
}

/**
 * 盯 X11 窗口树，来电时按 `接听`。
 *
 * 认不出"这是来电窗口"——QQ 是 Electron，所有窗口标题都是 "QQ"。所以判据是
 * **出现了一个从没见过的大窗口**。代价：任何新弹出的 QQ 窗口都会被当成来电，
 * 所以只在显式开 `--auto-answer` 时才启用，而且答完有 20 秒冷却。
 */
class CallWatcher {
  constructor({ container, mode, accept, log, geometry = null, groupGeometry = null, allowIds = [], allowGroups = [], allowNames = [], oneBotUrl = '', oneBotToken = '' }) {
    this.container = container;
    this.mode = mode;
    this.accept = accept;
    this.log = log;
    this.geometry = geometry || { avatarSize: AVATAR_DIAMETER, avatarOffsetY: AVATAR_DY, acceptOffsetX: ACCEPT_DX, acceptOffsetY: ACCEPT_DY };
    this.groupGeometry = groupGeometry || CALL_GROUP_GEOMETRY_DEFAULTS;
    this.allowIds = allowIds;
    this.allowGroups = allowGroups;
    this.allowNames = allowNames;
    this.oneBotUrl = oneBotUrl;
    this.oneBotToken = oneBotToken;
    this.nameCache = { at: 0, names: [] };
    this.known = new Set();
    this.lastCallInfo = null;
    this.groupCache = { at: 0, list: [] };
    this.ocrPromise = null;
    this.ocrDisabled = false;
    this.timer = null;
    this.busy = false;
    this.cooldownUntil = 0;
  }

  async start() {
    const tree = await this._tree();
    this.known = new Set(parseWindows(tree).map((w) => w.id));
    this.log('call', `看着 ${this.known.size} 个已有窗口，等新窗口（模式 ${this.mode}）`);
    this.timer = setInterval(() => { this._tick(); }, 1500);
  }

  _tree() {
    return execP('docker', ['exec', this.container, 'sh', '-c', 'DISPLAY=:1 xwininfo -root -tree']);
  }

  /** 白名单里的 QQ 号 → 昵称/备注。缓存 5 分钟，别每次来电都去问 OneBot。 */
  async _allowedNames() {
    const names = [...this.allowNames];
    if (this.allowIds.length === 0) return [...new Set(names)];
    if (Date.now() - this.nameCache.at < 300000) return [...new Set([...names, ...this.nameCache.names])];
    const list = await this._friendList();
    const index = friendNameIndex(list);
    for (const id of this.allowIds) {
      for (const n of index.get(String(id)) ?? []) names.push(n);
    }
    this.nameCache = { at: Date.now(), names: [...new Set(names)] };
    this.log('call', `白名单 ${this.allowIds.length} 人有 ${this.nameCache.names.length} 个可用名字：${this.nameCache.names.join('、') || '（查不到）'}`);
    return this.nameCache.names;
  }

  async _friendList() {
    if (!this.oneBotUrl) return [];
    const base = this.oneBotUrl.replace(/\/+$/, '');
    const auth = this.oneBotToken ? { authorization: `Bearer ${this.oneBotToken}` } : {};
    for (const [url, body] of [
      [`${base}/get_friend_list`, {}],
      [`${base}/`, { action: 'get_friend_list', params: {} }]
    ]) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000)
        });
        const json = await res.json();
        const data = json?.data;
        if (Array.isArray(data)) return data;
      } catch { /* 换下一种写法 */ }
    }
    return [];
  }

  /** 认人：先看窗口标题，再看头像。认不出来就返回 null（不接）。 */
  async _identify(win, shotPath) {
    if (this.allowIds.length === 0 && this.allowGroups.length === 0 && this.allowNames.length === 0) {
      this.log('call', '白名单是空的——不接（先到控制台「通话」里加人或加群）');
      return null;
    }
    const names = await this._allowedNames();
    const byTitle = matchCaller(win.title, names);
    if (byTitle) {
      this.log('call', `认出来了（标题）：${byTitle}`);
      return { who: byTitle, via: 'title' };
    }
    if (!shotPath) {
      this.log('call', '没截到图，认不出是谁，不接');
      return null;
    }
    // 头像：浮层里固定居中，116px 圆，圆心在窗口中心上方 129px
    const g = this.geometry;
    const crop = `crop=${g.avatarSize}:${g.avatarSize}:`
      + `${Math.round(win.width / 2 - g.avatarSize / 2)}:`
      + `${Math.round(win.height / 2 + g.avatarOffsetY - g.avatarSize / 2)},scale=32:32`;
    const vec = await ffmpegGray(shotPath, crop);
    if (!vec || vec.length !== 1024) {
      this.log('call', '裁剪头像失败，不接');
      return null;
    }
    let best = { score: -2, label: '' };
    for (const qq of this.allowIds) {
      const ref = await referenceAvatar(qq, 'friend');
      if (!ref) { this.log('call', `QQ ${qq} 的头像取不到`); continue; }
      const score = correlation(vec, ref);
      this.log('call', `头像比对 好友 ${qq}: ${score.toFixed(3)}`);
      if (score > best.score) best = { score, label: `QQ ${qq}` };
    }
    for (const gid of this.allowGroups) {
      const ref = await referenceAvatar(gid, 'group');
      if (!ref) { this.log('call', `群 ${gid} 的头像取不到`); continue; }
      const score = correlation(vec, ref);
      this.log('call', `头像比对 群 ${gid}: ${score.toFixed(3)}`);
      if (score > best.score) best = { score, label: `群 ${gid}` };
    }
    if (best.label && best.score >= 0.6) {
      this.log('call', `认出来了（头像）：${best.label}，相关 ${best.score.toFixed(3)}`);
      return { who: best.label, via: 'avatar' };
    }
    // 群语音邀请显示的是发起人头像，不是群头像；再用邀请文案里的群名兜底。
    const group = await this._ocrGroupInvite(shotPath, win);
    if (group) {
      return { who: `群 ${group.id}`, via: 'ocr-group', groupId: group.id };
    }
    this.log('call', `头像没对上（最高 ${best.score.toFixed(3)} ${best.label || '无候选'}），不接`);
    return null;
  }

  /** 编译 macOS Vision OCR helper（scripts/ocr.swift → data/bin/qq-ocr）。 */
  async _ensureOcr() {
    if (this.ocrDisabled) throw new Error('OCR 已禁用');
    if (this.ocrPromise) return this.ocrPromise;
    this.ocrPromise = (async () => {
      const bin = path.join(ROOT, 'data', 'bin', 'qq-ocr');
      const src = path.join(ROOT, 'scripts', 'ocr.swift');
      let need = !fs.existsSync(bin);
      if (!need) {
        try { need = fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs; } catch {}
      }
      if (need) {
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        await new Promise((resolve, reject) => {
          execFile('swiftc', ['-O', src, '-o', bin], { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 200)));
            else resolve();
          });
        });
        this.log('call', 'OCR helper 已编译');
      }
      return bin;
    })();
    try {
      return await this.ocrPromise;
    } catch (error) {
      this.ocrPromise = null;
      this.ocrDisabled = true;
      throw error;
    }
  }

  async _ocr(imagePath) {
    const bin = await this._ensureOcr();
    const raw = await execP(bin, [imagePath]);
    return String(raw).split('\n')
      .map((line) => line.split('\t'))
      .filter((parts) => parts.length >= 5)
      .map((parts) => ({ text: parts[0], x: Number(parts[1]), y: Number(parts[2]), w: Number(parts[3]), h: Number(parts[4]) }));
  }

  async _groupList() {
    if (Date.now() - this.groupCache.at < 300000) return this.groupCache.list;
    const url = `${String(this.oneBotUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')}/get_group_list`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.oneBotToken ? { authorization: `Bearer ${this.oneBotToken}` } : {})
      },
      body: '{}',
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`get_group_list HTTP ${response.status}`);
    const payload = await response.json();
    const list = (Array.isArray(payload?.data) ? payload.data : [])
      .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? '') }));
    this.groupCache = { at: Date.now(), list };
    return list;
  }

  /**
   * 群语音邀请里显示的是「发起人头像 + 邀请您加入「群名」的语音通话」，
   * 不是群头像，所以头像比对认不出来。这里裁中间邀请文案做 OCR，再用群名反查群号。
   */
  async _ocrGroupInvite(shotPath, win) {
    if (this.ocrDisabled || this.allowGroups.length === 0) return null;
    const x = Math.max(0, Math.round(win.width * 0.25));
    const y = Math.max(0, Math.round(win.height * 0.36));
    const w = Math.max(120, Math.round(win.width * 0.5));
    const h = Math.max(60, Math.round(win.height * 0.16));
    const crop = path.join(os.tmpdir(), `call-invite-${Date.now()}.png`);
    try {
      await execP('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', shotPath,
        '-vf', `crop=${w}:${h}:${x}:${y},scale=${w * 2}:${h * 2}`, crop
      ]);
      const lines = await this._ocr(crop);
      const text = lines.map((line) => line.text).join('').replace(/\s+/g, '');
      const match = text.match(/邀请您加入[“"「]?(.+?)[”"」“]?的语音通话/);
      if (!match) return null;
      const name = match[1].replace(/[“”"「」\s]/g, '').trim();
      if (!name) return null;
      const groups = await this._groupList();
      const hit = groups.find((g) => this.allowGroups.includes(g.id)
        && g.name.replace(/[，,。.、\s]/g, '') === name.replace(/[，,。.、\s]/g, ''));
      if (hit) {
        this.log('call', `OCR 群邀请：${hit.name}（${hit.id}）`);
        return hit;
      }
      this.log('call', `OCR 群邀请未命中白名单：${name}`);
      return null;
    } catch (error) {
      this.log('call', `群邀请 OCR 失败：${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  /** 启动时预热 OCR（swiftc 编译 + Vision 冷启动），别等来电才做。 */
  async warmOcr() {
    if (this.allowGroups.length === 0) return;
    try {
      const bin = await this._ensureOcr();
      const tmp = path.join(os.tmpdir(), 'qq-ocr-warm.png');
      await execP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16', '-frames:v', '1', tmp]);
      await new Promise((resolve, reject) => {
        execFile(bin, [tmp], { timeout: 30000 }, (error) => (error ? reject(error) : resolve()));
      });
      this.log('call', 'OCR 预热完成（群语音自动接听可用）');
    } catch (error) {
      this.ocrDisabled = true;
      this.log('call', `OCR 预热失败（群语音自动接听不可用）：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  async _tick() {
    if (this.busy || Date.now() < this.cooldownUntil) return;
    this.busy = true;
    try {
      const windows = parseWindows(await this._tree());
      const candidate = pickNewWindow(windows, this.known);
      for (const w of windows) this.known.add(w.id);
      if (candidate) await this._onNewWindow(candidate);
    } catch (error) {
      this.log('call', `轮询失败：${String(error?.message ?? error).slice(0, 80)}`);
    } finally {
      this.busy = false;
    }
  }

  async _onNewWindow(win) {
    this.log('call', `新窗口 ${win.id} ${win.width}x${win.height}@${win.x},${win.y}「${win.title}」`);
    await sleep(900); // 等它渲染出来
    const shot = await this._capture(win, this.mode === 'learn' ? 3 : 1);
    if (this.mode !== 'on') return;

    const who = await this._identify(win, shot);
    if (!who) {
      this.cooldownUntil = Date.now() + 15000; // 别对着同一个窗口反复认
      return;
    }

    this.lastCallInfo = who;
    const g = who.via === 'ocr-group' ? this.groupGeometry : this.geometry;
    const ax = this.accept ? this.accept.x : Math.round(win.width / 2 + g.acceptOffsetX);
    const ay = this.accept ? this.accept.y : Math.round(win.height / 2 + g.acceptOffsetY);
    const x = win.x + ax;
    const y = win.y + ay;
    try {
      await execP('docker', ['exec', this.container, 'sh', '-c',
        `DISPLAY=:1 xdotool mousemove ${x} ${y} click 1`]);
      this.log('call', `已点击接听 (${x},${y}) ← ${who.who}`);
      this.cooldownUntil = Date.now() + 20000;
    } catch (error) {
      this.log('call', `点击失败：${String(error?.message ?? error).slice(0, 80)}`);
    }
  }

  async _capture(win, frames = 1) {
    let firstHost = null;
    const inner = `/tmp/call-window-${Date.now()}.png`;
    const x = Math.max(0, win.x);
    const y = Math.max(0, win.y);
    for (let i = 0; i < frames; i++) {
      if (i > 0) await sleep(800);
      const file = frames > 1 ? inner.replace(/\.png$/, `-${i + 1}.png`) : inner;
      try {
        await execP('docker', ['exec', this.container, 'sh', '-c',
          `DISPLAY=:1 ffmpeg -hide_banner -loglevel error -y -f x11grab `
          + `-video_size ${win.width}x${win.height} -i :1+${x},${y} -frames:v 1 ${file}`]);
        const host = path.join(os.tmpdir(), path.basename(file));
        await execP('docker', ['cp', `${this.container}:${file}`, host]);
        this.log('call', `截图 ${host}`);
        if (!firstHost) firstHost = host;
      } catch (error) {
        this.log('call', `截图失败：${String(error?.message ?? error).slice(0, 80)}`);
      }
    }
    return firstHost;
  }

  close() {
    clearInterval(this.timer);
  }
}

// ── 语义端点检测（Smart Turn v3） ─────────────────────────────────────────────

/**
 * 常驻 Python worker：stdin 收 base64 PCM，stdout 回完成概率。
 * 模型只有 8MB（int8 ONNX），CPU 推理 10~30ms；不可用时 call-loop 自动回退标点。
 */
class TurnDetector {
  constructor({ pythonPath, modelPath, workerPath, log }) {
    this.pythonPath = pythonPath;
    this.modelPath = modelPath;
    this.workerPath = workerPath;
    this.log = log;
    this.child = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = new Map();
    this.seq = 0;
    this.buffer = '';
  }

  async ensure() {
    if (this.child) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const child = spawn(this.pythonPath, [this.workerPath, this.modelPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          TRANSFORMERS_VERBOSITY: 'error',
          TOKENIZERS_PARALLELISM: 'false'
        }
      });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.log('turn', `smart-turn stderr: ${text.slice(0, 160)}`);
      });
      child.on('error', (error) => this._failAll(new Error(`启动失败：${error.message}`)));
      child.on('exit', (code, signal) => {
        const error = new Error(`worker 退出 code=${code} signal=${signal}`);
        this.child = null;
        this.readyPromise = null;
        this._failAll(error);
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 ready 超时（20s）')), 20000);
        this.readyResolve = () => { clearTimeout(timer); resolve(); };
        this.readyReject = (error) => { clearTimeout(timer); reject(error); };
      });
    })();
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      this.close();
      throw error;
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'ready') {
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        continue;
      }
      if (msg.type === 'fatal') {
        this.readyReject?.(new Error(msg.error || 'worker fatal'));
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error));
      else waiter.resolve(Number(msg.probability));
    }
  }

  _failAll(error) {
    this.readyReject?.(error);
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async predict(pcm) {
    await this.ensure();
    if (!this.child) throw new Error('worker 未启动');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Smart Turn 超时'));
      }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ id, pcm: pcm.toString('base64') }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this._failAll(new Error('worker 已关闭'));
    try { this.child?.kill('SIGTERM'); } catch {}
    this.child = null;
    this.readyPromise = null;
    this.buffer = '';
  }
}

// ── 大脑：DSH 会话 ──────────────────────────────────────────────────────────

const CALL_HINT = '（正在打电话。用口语回答，一到两句，不要列表、不要 markdown，不要提"工具"或"会话"。）';

function bargeInError() {
  const error = new Error('barge-in');
  error.code = 'BARGE_IN';
  return error;
}

class Brain {
  constructor({ cfg, preset, cwd, log, rolePrompt = '' }) {
    this.cfg = cfg;
    this.preset = preset;
    this.cwd = cwd;
    this.log = log;
    this.rolePrompt = rolePrompt;
    this.primed = false;
    this.api = null;
    this.sessionId = null;
    this.collector = null;
    this.pending = null;
    this.closed = false;
    this.pumpStarted = false;
    this.streamOpen = false;
    this.streamOpenPromise = null;
    this.streamReadyResolve = null;
    this.streamReadyReject = null;
    this.busy = false;
    this.preparing = false;
    this.cancelPromise = null;
    this.promptAbort = null;
    this.turnEpoch = 0;
  }

  isBusy() { return this.busy || this.preparing || Boolean(this.pending) || Boolean(this.cancelPromise); }

  setRolePrompt(text) { this.rolePrompt = String(text || ''); }

  /** 第一次开口前才建会话；每通电话用完就归档，下一通是全新上下文。 */
  async ensure() {
    if (this.sessionId) return;
    await this.open();
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
    this.primed = false;
    this.log('brain', `会话 ${this.sessionId}（preset=${this.preset || '无'}）`);
    // 第一次建会话时，先等事件流真正打开再发 prompt。否则 prompt 很快、turn 在
    // WebSocket 订阅生效之前就结束，turn/end 会丢，调用方只能等 90s 超时。
    const needWait = !this.streamOpen;
    if (needWait) {
      this.streamOpenPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DSH 事件流 10s 未打开')), 10000);
        this.streamReadyResolve = () => { clearTimeout(timer); resolve(); };
        this.streamReadyReject = (error) => { clearTimeout(timer); reject(error); };
      });
    }
    if (!this.pumpStarted) { this.pumpStarted = true; this._pump(); }
    if (needWait) {
      try {
        await this.streamOpenPromise;
      } finally {
        this.streamOpenPromise = null;
        this.streamReadyResolve = null;
        this.streamReadyReject = null;
      }
    }
  }

  /** 挂断后归档本通会话：下次来电是干净的上下文，不会继承上一通的自我介绍。 */
  async closeSession() {
    if (this.isBusy()) await this.cancelCurrentTurn('hangup');
    const sid = this.sessionId;
    this.sessionId = null;
    this.primed = false;
    if (!sid || !this.api) return;
    try {
      await this.api.workspace.archiveSession({ sessionId: sid });
      this.log('brain', `会话 ${sid} 已归档（下次通话重新开始）`);
    } catch (error) {
      this.log('brain', `会话归档失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  /**
   * 用户开口打断：取消 DSH 在途回合，并让当前 ask 立刻返回。
   *
   * 只掐本地音频是不够的：模型会继续生成（烧 token），部分工具调用也可能已经
   * 落地。DSH 的 session/cancel 会把这一轮标成 aborted；实测被取消的半截
   * assistant 文本不会进入下一轮上下文。
   */
  async cancelCurrentTurn(reason = 'barge-in') {
    // epoch 先加：哪怕此刻还在建会话/组 prompt，ask 也会在下一个检查点放弃。
    this.turnEpoch += 1;
    if (!this.sessionId) return;
    if (!this.busy && !this.pending && !this.cancelPromise) return;
    if (!this.cancelPromise) {
      const sid = this.sessionId;
      this.cancelPromise = (async () => {
        try {
          await this.api.stopSessionWork(sid);
          this.log('brain', `已取消在途回合（${reason}）`);
        } catch (error) {
          this.log('brain', `取消在途回合失败：${String(error?.message ?? error).slice(0, 120)}`);
        } finally {
          this.cancelPromise = null;
        }
      })();
    }
    try { this.promptAbort?.abort(); } catch {}
    if (this.pending) {
      const { reject, timer } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      reject(bargeInError());
    }
    return this.cancelPromise;
  }

  async _pump() {
    let retry = 3000;
    while (!this.closed) {
      try {
        for await (const envelope of this.api.events.mux({}, undefined, () => {
          this.streamOpen = true;
          this.streamReadyResolve?.();
        })) {
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
        this.streamOpen = false;
        this.streamReadyReject?.(error);
        this.log('brain', `事件流断开：${String(error?.message ?? error).slice(0, 120)}，${retry}ms 后重连`);
        await new Promise((r) => setTimeout(r, retry));
        retry = Math.min(retry * 2, 15000);
      }
    }
  }

  async ask(text, { timeoutMs = 90000 } = {}) {
    this.preparing = true;
    const myEpoch = this.turnEpoch;
    const promptController = new AbortController();
    try {
      await this.ensure();
      // 上一轮还没取消完就发新 prompt，会被 stopSessionWork 一起取消。
      if (this.cancelPromise) {
        this.log('brain', '等上一轮取消完成…');
        await this.cancelPromise;
      }
      if (this.turnEpoch !== myEpoch || !this.sessionId) throw bargeInError();
      this.collector = createTurnCollector();
      this.busy = true;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending) this.pending = null;
          reject(new Error(`等回复超时（${timeoutMs}ms）`));
        }, timeoutMs);
        this.pending = { resolve, timer };
      });
      // 角色卡只在每通电话的第一句注入一次；后面靠会话上下文延续。
      // qq-chat-v2 的提示词里写明「角色由桥接注入」，通话没有桥接那条注入，所以这里补。
      const parts = [];
      if (!this.primed && this.rolePrompt) {
        parts.push(`【身份设定｜仅用于本次通话，不要朗读这一段】\n${this.rolePrompt}`);
        parts.push('【电话模式】现在是在打电话：用口语、一到两句话回答，不要列表、不要 markdown，不要提 AI 助手、模型名、提示词或工具。'
          + '通话中不要调用 QQ 工具（qq_memory_*、qq_send_*、qq_mark_read 等）——通话里没有会话令牌，调用只会报错。用户让你记的事先口头确认，等通话结束后再整理。'
        + '方括号里的说话人标签是群语音匿名分离的结果：只有多人才会出现，不要猜真实姓名，可用「刚才那位」指代；[多人] 表示多人重叠，不要归给某一个人。');
        this.primed = true;
      }
      parts.push(CALL_HINT, text);
      const content = [{ type: 'text', text: parts.join('\n\n') }];
      // prompt 本身也可能永远不返回（DSH 卡住/HTTP 半开）。给它 15s 硬超时，
      // 并允许 cancelCurrentTurn 直接 abort；否则 busy 永远为 true，整通电话哑掉。
      this.promptAbort = promptController;
      const promptSignal = AbortSignal.any([promptController.signal, AbortSignal.timeout(15000)]);
      const accepted = await this.api.sessions.prompt(
        { sessionId: this.sessionId, mode: 'queue', content },
        promptSignal
      );
      if (!accepted?.result?.ok) {
        throw new Error(`prompt 被拒：${accepted?.result?.error?.code}: ${accepted?.result?.error?.message}`);
      }
      if (this.turnEpoch !== myEpoch) {
        // prompt 已经落地才赶上打断：上一轮的 cancelPromise 可能早于这次 prompt 结束，
        // 不能再复用；等它收尾后对当前会话再 cancel 一次，避免迟到 turn 逃掉。
        if (this.cancelPromise) await this.cancelPromise;
        try {
          await this.api.stopSessionWork(this.sessionId);
          this.log('brain', '已取消迟到的在途回合');
        } catch (error) {
          this.log('brain', `取消迟到回合失败：${String(error?.message ?? error).slice(0, 120)}`);
        }
        throw bargeInError();
      }
      return await reply;
    } catch (error) {
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending = null;
      }
      if (error?.name === 'AbortError' && this.turnEpoch !== myEpoch) throw bargeInError();
      throw error;
    } finally {
      if (this.promptAbort === promptController) this.promptAbort = null;
      this.preparing = false;
      this.busy = false;
    }
  }

  close() {
    this.closed = true;
    this.streamReadyReject?.(new Error('brain 已关闭'));
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

/** 当前角色卡（控制台切换角色后，下一通电话自动生效）。 */
function loadCallRolePrompt() {
  try {
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'current-role.json'), 'utf8'));
    const name = String(current?.role ?? '').trim();
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(name)) return '';
    const file = path.join(ROOT, 'roles', `${name}.md`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node scripts/call-loop.mjs [--container snowluma] [--preset qq-chat-v2] [--from-wav a.wav] [--out-wav out.raw] [--once] [--no-tts]');
    return;
  }
  // 离线自测 / 诊断模式不占容器的设备，不需要跟守护进程抢锁
  const needsLock = !opts.outWav && !opts.identifyShot && !opts.simulateCall;
  const other = needsLock ? acquireLock() : 0;
  if (other) {
    console.error(`已经有一个 call-loop 在跑（pid ${other}），本实例退出。`);
    console.error('要起第二个，先停掉守护进程：npm run uninstall:call');
    process.exit(0);
  }
  process.on('exit', releaseLock);

  const cfg = loadConfig();
  const asrDir = (() => {
    const rel = cfg.socialV2?.asr?.modelDir || 'data/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
    return path.isAbsolute(rel) ? rel : path.resolve(ROOT, rel);
  })();

  const callCfg = normalizeCallConfig(cfg.call);
  // 配置里可以固定通话人格（call.preset）；命令行 --preset 优先，方便临时排查。
  const preset = opts.preset || callCfg.preset || '';
  log('boot', `容器=${opts.container} 设备=${opts.device} preset=${preset || '无'}`);

  const turnCfg = callCfg.turnDetection;
  const turnPython = turnCfg.pythonPath || path.join(ROOT, '.turn-venv', 'bin', 'python');
  const turnModel = turnCfg.modelPath
    ? path.resolve(ROOT, turnCfg.modelPath)
    : path.join(ROOT, 'data', 'models', 'smart-turn', 'smart-turn-v3.2-cpu.onnx');
  const turnWorker = path.join(ROOT, 'scripts', 'turn-detector-worker.py');
  const turnSmartAvailable = turnCfg.mode === 'smart'
    && fs.existsSync(turnPython) && fs.existsSync(turnModel) && fs.existsSync(turnWorker);
  let turnMode = turnCfg.mode;
  if (turnMode === 'smart' && !turnSmartAvailable) {
    turnMode = 'punctuation';
    log('turn', 'Smart Turn 不可用（.turn-venv 或模型缺失），回退标点判停');
  }
  let turnDetector = null;
  function getTurnDetector() {
    if (turnMode !== 'smart' || !turnSmartAvailable) return null;
    if (!turnDetector) {
      turnDetector = new TurnDetector({ pythonPath: turnPython, modelPath: turnModel, workerPath: turnWorker, log });
    }
    return turnDetector;
  }

  const diarCfg = callCfg.diarization;
  const speakerModel = diarCfg.modelPath
    ? path.resolve(ROOT, diarCfg.modelPath)
    : path.join(ROOT, 'data', 'models', 'speaker', '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx');
  const speakerWorker = path.join(ROOT, 'src', 'speaker-worker.mjs');
  let speakerAvailable = diarCfg.mode === 'anonymous'
    && fs.existsSync(speakerModel) && fs.existsSync(speakerWorker);
  let speakerTracker = null;
  function getSpeakerTracker() {
    if (!speakerAvailable) return null;
    if (!speakerTracker) {
      const voiceCfg = callCfg.voiceprints;
      let voiceprints = [];
      if (voiceCfg.enabled) {
        try { voiceprints = new VoiceprintStore({ root: ROOT, log }).all(); }
        catch (error) { log('speaker', `声纹库读取失败：${String(error?.message ?? error).slice(0, 100)}`); }
      }
      if (voiceprints.length) log('speaker', `声纹库 ${voiceprints.length} 条，命中后会标姓名`);
      speakerTracker = new SpeakerTracker({
        modelPath: speakerModel,
        workerPath: speakerWorker,
        threshold: diarCfg.threshold,
        maxSpeakers: diarCfg.maxSpeakers,
        minSegmentMs: diarCfg.minSegmentMs,
        minNewClusterMs: diarCfg.minNewClusterMs,
        voiceprints,
        voiceprintThreshold: voiceCfg.threshold,
        voiceprintMargin: voiceCfg.margin,
        log
      });
    }
    return speakerTracker;
  }
  if (diarCfg.mode === 'anonymous' && !speakerAvailable) {
    log('speaker', '零样本说话人模型/worker 缺失，本次不标说话人');
  }

  // ── 通话文字→语音桥：只在通话接通时启动本地 /say 服务并向 bridge 注册 presence ──
  const textBridgeCfg = callCfg.textBridge;
  const callMemoryCfg = callCfg.memory;
  const bridgeBase = `http://127.0.0.1:${Number(cfg.consolePort) || 3100}`;
  const callOwnerQQ = (() => {
    const owner = String(cfg.ownerQQ || '');
    if (owner && callCfg.allow.some((id) => String(id) === owner)) return owner;
    return String(callCfg.allow[0] || owner || '');
  })();
  let watcher = null;
  let memoryWarned = false;
  async function postCallMemory(text) {
    if (!callMemoryCfg.enabled || !gateOnCall || !callOwnerQQ) return;
    const clean = String(text ?? '').trim();
    if (!clean) return;
    const info = watcher?.lastCallInfo;
    const isGroupCall = info?.via === 'ocr-group' && info.groupId;
    // 群语音没有稳定身份：只收显式“记住…”，写 group scope；不把匿名候选误归到某个人。
    const key = isGroupCall ? `group:${info.groupId}` : `private:${callOwnerQQ}`;
    const userId = isGroupCall ? '' : callOwnerQQ;
    const sender = isGroupCall ? '群语音' : '主人';
    const token = readConsoleToken(ROOT);
    if (!token) return;
    try {
      const response = await fetch(`${bridgeBase}/api/call/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify({
          key,
          text: clean,
          userId,
          sender,
          explicitOnly: !!isGroupCall
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok && !memoryWarned) {
        memoryWarned = true;
        log('memory', `通话记忆投递失败：HTTP ${response.status}`);
      }
    } catch (error) {
      if (!memoryWarned) {
        memoryWarned = true;
        log('memory', `通话记忆投递失败：${String(error?.message ?? error).slice(0, 100)}`);
      }
    }
  }

  let sayServer = null;
  let presenceTimer = null;
  let externalQueue = [];
  let externalContextNotes = [];
  let externalBusy = false;
  let presenceWarned = false;

  async function registerCallPresence(active) {
    const token = readConsoleToken(ROOT);
    if (!token) throw new Error('缺少控制台令牌（data/console-token）');
    const response = await fetch(`${bridgeBase}/api/call/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({
        active,
        withQQ: active ? callOwnerQQ : undefined,
        sayUrl: active ? sayServer?.url : undefined,
        ttlMs: 90_000
      }),
      signal: AbortSignal.timeout(5000)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
    return body;
  }

  async function startCallTextBridge() {
    if (!textBridgeCfg.enabled || sayServer) return;
    const token = readConsoleToken(ROOT);
    if (!token) { log('call', '通话文字→语音：缺少控制台令牌，关闭桥接'); return; }
    sayServer = await startSayServer({
      token,
      log: (message) => log('call', message),
      onSay: (payload) => enqueueExternalSpeech(payload.text, payload)
    });
    log('call', `通话文字→语音：/say 已启动（${sayServer.url}），主人 ${callOwnerQQ || '?'}`);
    try {
      await registerCallPresence(true);
      log('call', '通话文字→语音：presence 已注册');
    } catch (error) {
      log('call', `通话文字→语音：presence 注册失败（会重试）：${String(error?.message ?? error).slice(0, 100)}`);
    }
    presenceTimer = setInterval(() => {
      registerCallPresence(true).catch((error) => {
        if (!presenceWarned) {
          presenceWarned = true;
          log('call', `通话文字→语音：presence 心跳失败：${String(error?.message ?? error).slice(0, 100)}`);
        }
      });
    }, 30_000);
    presenceTimer.unref?.();
  }

  async function stopCallTextBridge(reason = '通话结束') {
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    externalQueue = [];
    externalContextNotes = [];
    externalBusy = false;
    if (!sayServer) return;
    try { await registerCallPresence(false); } catch {}
    const server = sayServer;
    sayServer = null;
    log('call', `通话文字→语音：${reason}，/say 关闭`);
    setTimeout(() => { server.close().catch(() => {}); }, 1000).unref?.();
  }

  function enqueueExternalSpeech(text, meta = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    if (externalQueue.length >= 20) externalQueue.shift();
    externalQueue.push({ text: clean, meta });
    const note = buildCrossChannelNote({ key: meta?.key, source: meta?.context, reply: clean });
    if (note) {
      externalContextNotes.push(note);
      if (externalContextNotes.length > 3) externalContextNotes.shift();
    }
    log('call', `收到通话语音回复（${clean.length} 字）：${clean.slice(0, 50)}`);
    pumpExternalSpeech().catch((error) => log('call', `外部语音失败：${String(error?.message ?? error).slice(0, 100)}`));
  }

  async function pumpExternalSpeech() {
    if (externalBusy || ttsActive || brain.isBusy() || externalQueue.length === 0) return;
    externalBusy = true;
    ttsActive = true;
    const item = externalQueue.shift();
    try {
      await speak(item.text);
    } catch (error) {
      log('call', `外部语音说话失败：${String(error?.message ?? error).slice(0, 100)}`);
    } finally {
      ttsActive = false;
      externalBusy = false;
      if (externalQueue.length > 0) setTimeout(() => { pumpExternalSpeech().catch(() => {}); }, 200).unref?.();
    }
  }

  // 诊断用：拿一张已经截好的图跑一遍认人（不需要来电）
  if (opts.identifyShot) {
    const callCfg = normalizeCallConfig(cfg.call);
    const [w, h] = String(opts.identifySize).split('x').map(Number);
    const watcher = new CallWatcher({
      container: opts.container, mode: 'on', accept: callCfg.accept, log,
      geometry: callCfg.geometry, groupGeometry: callCfg.groupGeometry,
      allowIds: callCfg.allow, allowGroups: callCfg.allowGroups, allowNames: callCfg.allowNames,
      oneBotUrl: cfg.snowluma?.httpUrl || '', oneBotToken: cfg.snowluma?.accessToken || ''
    });
    log('call', `诊断：${opts.identifyShot}（${w}x${h}）`);
    const who = await watcher._identify({ id: 'diag', title: 'QQ', width: w, height: h, x: 0, y: 0 }, opts.identifyShot);
    log('call', who ? `结论：${who.who}（${who.via}）` : '结论：认不出来');
    process.exit(who ? 0 : 2);
  }

  const rolePrompt = loadCallRolePrompt();
  const brain = new Brain({ cfg, preset, cwd: opts.cwd, log, rolePrompt });
  if (rolePrompt) log('brain', `已加载通话角色卡（${rolePrompt.length} 字符），首句注入`);

  const asr = new Asr({
    modelDir: asrDir,
    numThreads: cfg.socialV2?.asr?.numThreads ?? 2,
    log: (m) => log('asr', m)
  });
  // SenseVoice 不预加载：模型子进程约 855MB，空闲时不该常驻。
  // 第一句话之前（来电接通时）会 ensure()，首句识别前有几百毫秒预热时间；
  // 挂断后 unload()，内存立刻还回去。

  const tts = opts.tts
    ? createTtsService({ getConfig: () => cfg.socialV2?.speak ?? {}, root: ROOT, log: (m) => log('tts', m) })
    : null;
  await sweepStale();

  // 通话状态：mic 的回调可能在我们还没执行到下面那些声明时就被调用（中间有 await），
  // 所以这些必须提前声明。
  const queue = [];
  const INTER_TURN_SILENCE = Buffer.alloc(16000 * 0.2 * 2);
  let pendingTurn = null;
  let busy = false;
  let stopped = false;
  let utteranceIndex = 0;
  let speechEpoch = 0;
  // 被打断时记下「用户到底听到了多少」，下一轮告诉模型，避免它以为整段都说过。
  let bargeInContext = null;
  let lastSpokenText = '';
  let ttsActive = false;
  let idleDropped = 0;
  let vad = null;
  // 离线自测（--from-wav）没有真实通话，通话闸不生效
  const gateOnCall = !opts.outWav;

  const mic = new Mic({
    container: opts.container,
    fifo: opts.fifo,
    outWav: opts.outWav,
    noiseLevel: opts.micNoise,
    onRecorderChange: (recording) => {
      if (recording) {
        log('call', '通话接通：提前把识别进程拉起来');
        asr.ensure().catch((e) => log('asr', `预加载失败：${String(e?.message ?? e).slice(0, 60)}`));
        // Smart Turn 的 Python worker 启动约 0.8s，趁用户还在说第一句先拉起来。
        getTurnDetector()?.ensure().catch((e) => log('turn', `Smart Turn 预加载失败：${String(e?.message ?? e).slice(0, 60)}`));
        getSpeakerTracker()?.ensure().catch((e) => log('speaker', `说话人模型预加载失败：${String(e?.message ?? e).slice(0, 60)}`));
        startCallTextBridge().catch((e) => log('call', `通话文字→语音启动失败：${String(e?.message ?? e).slice(0, 100)}`));
      } else {
        log('call', '通话结束：回收');
        speechEpoch++;                 // 作废在途的那一轮，回来也不念
        bargeInContext = null;
        lastSpokenText = '';
        ttsActive = false;
        if (pendingTurn?.timer) clearTimeout(pendingTurn.timer);
        pendingTurn = null;
        try { turnDetector?.close(); } catch {}
        turnDetector = null;
        try { speakerTracker?.close(); } catch {}
        speakerTracker = null;
        queue.length = 0;              // 没处理的那几句直接丢掉
        try { vad?.reset(); } catch {}   // 不保留半句
        try { mic.flush(); } catch {}
        if (idleDropped) { log('call', `未通话期间丢弃了 ${idleDropped} 帧`); idleDropped = 0; }
        stopCallTextBridge('通话结束').catch(() => {});
        asr.unload('通话结束');
        brain.closeSession().catch(() => {});
      }
    }
  });
  mic.start();

  const autoMode = opts.autoAnswer || (callCfg.autoAnswer ? 'on' : '');
  if (autoMode) {
    const accept = (opts.acceptX !== null && opts.acceptY !== null)
      ? { x: opts.acceptX, y: opts.acceptY }
      : callCfg.accept;
    log('call', `自动接听：${autoMode}｜白名单 ${callCfg.allow.length} 人 ${callCfg.allow.join(',') || '（空）'}`
      + `｜群 ${callCfg.allowGroups.length} 个 ${callCfg.allowGroups.join(',') || '（空）'}`
      + `｜接听坐标 ${accept ? `${accept.x},${accept.y}` : '未设置'}`);
    watcher = new CallWatcher({
      container: opts.container,
      mode: autoMode,
      accept,
      log,
      geometry: callCfg.geometry,
      groupGeometry: callCfg.groupGeometry,
      allowIds: callCfg.allow,
      allowGroups: callCfg.allowGroups,
      allowNames: callCfg.allowNames,
      oneBotUrl: cfg.snowluma?.httpUrl || '',
      oneBotToken: cfg.snowluma?.accessToken || ''
    });
    if (opts.simulateCall) {
      // 自测：不真打电话，直接走一遍"发现新窗口 → 截图"的路径
      await watcher._onNewWindow({ id: '0xsim', title: 'QQ', width: 360, height: 420, x: 460, y: 190 });
      watcher.close();
      mic.close();
      asr.close();
      brain.close();
      process.exit(0);
    }
    await watcher.start();
    // OCR 编译 + Vision 冷启动很慢（首次十几秒），放在后台预热，别等来电才做。
    watcher.warmOcr().catch(() => {});
  }

  /** 把回复切成短句：短句先合成、先开口，长句并行合成。 */
  function splitForSpeech(text, max = 24) {
    const parts = String(text).split(/(?<=[。！？!?~～，,])/).filter((x) => x.trim());
    const chunks = [];
    let cur = '';
    for (const p of parts) {
      if (cur && cur.length + p.length > max) { chunks.push(cur); cur = p; }
      else cur += p;
    }
    if (cur) chunks.push(cur);
    return chunks.length ? chunks : [String(text)];
  }

  /** 任意格式 → 48k 单声道 s16le */
  function toPcm48(buffer) {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [];
      let err = '';
      ff.stdout.on('data', (c) => chunks.push(c));
      ff.stderr.on('data', (c) => { err += c; });
      ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg 转码失败：${err.slice(0, 160)}`))));
      ff.stdin.end(buffer);
    });
  }

  /**
   * 说话。
   *
   * 首字延迟全在 CosyVoice 那边（实测首包 0.8–2.5s，跟文本长度关系不大），所以把回复
   * 切成短句**并行**合成：第一句好了就开口，后面的在她说第一句时已经合成完了。
   * 一串句子里任意一句失败就跳过，不拖着整轮变哑。
   */
  // CosyVoice 的第一次请求要多花 ~2s（建连/服务端冷启动）。通话前先打一发，
  // 把连接焐热，第一句回复就不用再付这笔钱。60 秒最多一次，别把配额刷爆。
  let lastWarm = 0;
  function warmTts() {
    if (!tts || Date.now() - lastWarm < 60000) return;
    lastWarm = Date.now();
    const t = Date.now();
    tts.synthesize('嗯').then(
      () => log('tts', `预热完成 ${Date.now() - t}ms`),
      (e) => log('tts', `预热失败：${String(e?.message ?? e).slice(0, 60)}`)
    );
  }

  async function speak(text) {
    if (!tts) return;
    const clean = toSpeechText(text);
    if (!clean) { log('tts', '没有可念的内容'); return; }
    const epoch = speechEpoch;
    const parts = splitForSpeech(clean);
    lastSpokenText = '';
    const t0 = Date.now();
    let first = true;
    // 流水线而不是并行：并行请求会在服务端排队，实测第一个包反而更晚
    // （并行 2.2–3.1s vs 串行 1.8–2.0s）。串行的同时 mic 已经在放上一句，
    // 所以第二句的合成和第一句的播放是重叠的。
    for (const part of parts) {
      if (epoch !== speechEpoch) { log('tts', '被打断，剩下的不念了'); return; }
      let synth;
      try {
        synth = await tts.synthesize(part);
      } catch (error) {
        log('tts', `「${part}」合成失败：${String(error?.message ?? error).slice(0, 80)}`);
        continue;
      }
      const pcm = await toPcm48(synth.buffer);
      if (epoch !== speechEpoch) return;
      await mic.speak(pcm);
      lastSpokenText += part;
      if (first) { log('tts', `首句开口 ${Date.now() - t0}ms（共 ${parts.length} 句）：「${part}」`); first = false; }
    }
  }

  async function askAndSpeak(text, seconds = 0, startedAt = Date.now(), speakers = []) {
    const t0 = startedAt;
    const epoch = speechEpoch;
    lastSpokenText = '';
    const speakerLabel = speakers.length === 1 ? speakers[0] : (speakers.length > 1 ? '多人' : '');
    if (speakerLabel) log('speaker', `本轮标签 ${speakerLabel}`);
    const crossChannelNote = externalContextNotes.length ? `${externalContextNotes.join('\n')}\n\n` : '';
    externalContextNotes = [];
    const userText = speakerLabel ? `[${speakerLabel}] ${text}` : text;
    let promptText = crossChannelNote + userText;
    if (bargeInContext) {
      const { heard: spoken, playing, ttsActive: wasTts } = bargeInContext;
      let note = '【打断提示】用户刚才打断了你的上一句。';
      if (spoken) note += `你已经说出口的只有：「${spoken}」；后面的内容用户没有听到。`;
      else if (playing) note += '你刚开始出声就被打断了，用户基本没听到内容。';
      else if (wasTts) note += '你还没来得及说出口就被打断了。';
      else note += '上一句还没有说出口。';
      note += '被打断的部分没有说完，也没有生效；不要以为用户听到了，也不要把它当成已经答应/已经记下。'
        + '以用户下面这句话为准，用户纠正过的以最新说法为准。';
      promptText = `${crossChannelNote}${note}\n\n${userText}`;
      bargeInContext = null;
    }
    const t1 = Date.now();
    const reply = await brain.ask(promptText);
    log('brain', `${Date.now() - t1}ms → 「${String(reply).slice(0, 120)}」`);
    if (!reply?.trim()) return;
    if (epoch !== speechEpoch) { log('turn', '这轮已经被打断，不念了'); return; }
    ttsActive = true;
    try {
      await speak(reply);
    } finally {
      ttsActive = false;
      setTimeout(() => { pumpExternalSpeech().catch(() => {}); }, 100).unref?.();
    }
    log('turn', `整轮 ${Date.now() - t0}ms（说话 ${seconds.toFixed(1)}s）`);
  }

  /** 没有语义模型时的兜底：句末标点 + 常见未完结连接词。 */
  function punctuationComplete(text) {
    const t = String(text ?? '').trim();
    if (!t) return false;
    if (/(但是|然后|因为|所以|而且|不过|可是|如果|虽然|还有|就是说|我是说|那个|就是|比如说|比如)$/.test(t)) return false;
    if (/[，、；：,;:]$/.test(t)) return false;
    if (/[。！？!?…]$/.test(t)) return true;
    if (/[”」』】）)]$/.test(t)) return /[。！？!?…][”」』】）)]$/.test(t);
    return false;
  }

  async function turnIsComplete(pcm, text) {
    if (turnMode === 'vad') return true;
    if (turnMode === 'smart') {
      const detector = getTurnDetector();
      if (detector) {
        try {
          const probability = await detector.predict(pcm);
          log('turn', `Smart Turn ${probability.toFixed(2)}（阈值 ${turnCfg.threshold}）`);
          return probability >= turnCfg.threshold;
        } catch (error) {
          log('turn', `Smart Turn 失败，回退标点：${String(error?.message ?? error).slice(0, 120)}`);
          turnMode = 'punctuation';
          try { detector.close(); } catch {}
          turnDetector = null;
        }
      }
    }
    return punctuationComplete(text);
  }

  function submitPending(reason) {
    const pending = pendingTurn;
    if (!pending) return;
    pendingTurn = null;
    if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
    log('turn', `提交累积的一句（${reason}，${pending.text.length} 字）`);
    queue.push({
      text: pending.text,
      seconds: pending.seconds,
      startedAt: pending.firstAt,
      speakers: [...pending.speakers.values()],
      index: ++utteranceIndex
    });
    drain();
  }

  async function feedTurn(pcm, text, seconds, speaker = null) {
    const now = Date.now();
    const addSpeaker = (turn) => {
      if (speaker?.label) turn.speakers.set(speaker.id, speaker.label);
    };
    if (pendingTurn) {
      pendingTurn.text += text;
      pendingTurn.pcm = Buffer.concat([pendingTurn.pcm, INTER_TURN_SILENCE, pcm]);
      pendingTurn.seconds += seconds;
      addSpeaker(pendingTurn);
      if (pendingTurn.timer) { clearTimeout(pendingTurn.timer); pendingTurn.timer = null; }
    } else {
      pendingTurn = { text, pcm, seconds, firstAt: now, timer: null, speakers: new Map() };
      addSpeaker(pendingTurn);
    }
    const elapsed = now - pendingTurn.firstAt;
    const complete = await turnIsComplete(pendingTurn.pcm, pendingTurn.text);
    if (complete || elapsed >= turnCfg.maxWaitMs) {
      submitPending(complete ? 'model-complete' : 'max-wait');
      return;
    }
    pendingTurn.timer = setTimeout(() => submitPending('window-timeout'), turnCfg.continuationWindowMs);
    pendingTurn.timer.unref?.();
    log('turn', `这句还没完（${turnMode}），等 ${turnCfg.continuationWindowMs}ms 看有没有下文`);
  }

  async function handleUtterance(pcm, seconds, index) {
    if (gateOnCall && !mic.recorder) { log('turn', '不在通话中，跳过这一句'); return; }
    const t0 = Date.now();
    const samples = pcm16ToFloat32(pcm);
    const asrResult = await asr.decode(samples);
    const heard = String(asrResult?.text ?? '').trim();
    log('asr', `${Date.now() - t0}ms → 「${heard}」`);
    if (!heard || heard.length < 2) {
      log('asr', '没听清，跳过');
      return;
    }
    // 通话里的用户原话按文字聊天的规则进记忆（候选/显式），不写 AI 自己的话。
    postCallMemory(heard);
    let speaker = null;
    if (speakerAvailable) {
      try {
        speaker = await getSpeakerTracker()?.assign(samples) ?? null;
      } catch (error) {
        log('speaker', `说话人分配失败，关闭标签：${String(error?.message ?? error).slice(0, 120)}`);
        speakerAvailable = false;
        try { speakerTracker?.close(); } catch {}
        speakerTracker = null;
      }
    }
    await feedTurn(pcm, heard, seconds, speaker);
  }

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try {
          if (item.text) await askAndSpeak(item.text, item.seconds || 0, item.startedAt || Date.now(), item.speakers || []);
          else await handleUtterance(item.pcm, item.seconds, item.index);
        } catch (error) {
          if (error?.code === 'BARGE_IN') { log('turn', '这一轮被新的打断取消'); continue; }
          const msg = String(error?.message ?? error);
          log('turn', `处理失败：${msg}`);
          // DSH 每次重启会换随机端口；桥接会把新端口写回 config.json，但我们只在启动时读一次。
          // 连不上就退出，让 LaunchAgent 拿新配置重起（比在这里热更简单可靠）。
          if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|401|unauthorized|事件流.*未打开/i.test(msg)) {
            log('boot', 'DSH 连不上（可能重启换了端口），退出等守护进程重起');
            setTimeout(() => shutdown(3), 100);
          }
        }
      }
    } finally {
      busy = false;
      if (opts.once && queue.length === 0 && !pendingTurn) shutdown(0);
    }
  }

  vad = new Vad({
    log,
    // 打断：她还在说的时候你开口，立刻把她剩下的话丢掉
    onSpeechStart: () => {
      warmTts();
      // 出声和「正在想」都算打断：她没说话时你接着说，不该把上一轮作废；
      // 但只要还有在途回合，用户开口就意味着要换话题/纠正，必须取消。
      const playing = mic.isSpeaking();
      const speaking = playing || ttsActive;
      const thinking = brain.isBusy();
      if (!speaking && !thinking) return;
      speechEpoch++;
      try { mic.flush(); } catch {}
      bargeInContext = { heard: lastSpokenText, playing, ttsActive, thinking };
      log('turn', speaking ? '被打断：停止播放并取消推理' : '打断思考：取消推理');
      brain.cancelCurrentTurn(speaking ? 'speaking' : 'thinking').catch(() => {});
    },
    onUtterance: (pcm, seconds) => {
      queue.push({ pcm, seconds, index: ++utteranceIndex });
      drain();
    }
  });

  await ensurePulseAudio(opts);
  const capture = new Capture(opts);
  // 只有通话接通后（QQ 真的在录 qq_in）才把声音喂给 VAD。
  // 不然铃声、挂断提示音、房间底噪都会被当成一句话：白跑 ASR、白烧一轮 DSH。
  capture.onFrame = (f) => {
    if (gateOnCall && !mic.recorder) { idleDropped++; return; }
    vad.push(f);
  };
  capture.start();

  function shutdown(code = 0) {
    if (stopped) return;
    stopped = true;
    log('boot', '收尾…');
    if (pendingTurn?.timer) clearTimeout(pendingTurn.timer);
    pendingTurn = null;
    try { turnDetector?.close(); } catch {}
    try { speakerTracker?.close(); } catch {}
    try { stopCallTextBridge('call-loop 退出').catch(() => {}); } catch {}
    try { vad.flush(); } catch {}
    capture.close();
    mic.close();
    watcher?.close();
    asr.close();
    brain.close();
    setTimeout(() => process.exit(code), 300);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (opts.maxSeconds > 0) setTimeout(() => shutdown(0), opts.maxSeconds * 1000);
  if (opts.fromWav) setTimeout(() => shutdown(0), 120000);

  setTimeout(warmTts, 200); // 放到最后：warmTts 依赖的声明都在上面（TDZ）
  log('boot', '就绪，等声音…');
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
