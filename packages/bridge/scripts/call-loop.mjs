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
import { parseWindows, pickNewWindow } from '../src/x11-windows.js';

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
    const inner = `echo $$ > /tmp/call-capture.pid; exec parec --device=${this.opts.device} `
      + `--format=s16le --rate=${SR} --channels=1 --raw`;
    log('capture', `docker exec ${this.opts.container} sh -c '${inner}'`);
    this.child = spawn('docker', ['exec', this.opts.container, 'sh', '-c', inner], { stdio: ['ignore', 'pipe', 'pipe'] });
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

    if (this.silenceRun >= 10 || this.frames.length >= this.maxFrames) {
      this._finish(this.silenceRun >= 10 ? 'silence' : 'maxlen');
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
  constructor({ container, fifo, outWav, noiseLevel = 40 }) {
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
  constructor({ container, mode, accept, log }) {
    this.container = container;
    this.mode = mode;
    this.accept = accept;
    this.log = log;
    this.known = new Set();
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
    if (this.mode === 'on' && this.accept) {
      const x = win.x + this.accept.x;
      const y = win.y + this.accept.y;
      try {
        await execP('docker', ['exec', this.container, 'sh', '-c',
          `DISPLAY=:1 xdotool mousemove ${x} ${y} click 1`]);
        this.log('call', `已点击接听 (${x},${y})`);
        this.cooldownUntil = Date.now() + 20000; // 别再连点
      } catch (error) {
        this.log('call', `点击失败：${String(error?.message ?? error).slice(0, 80)}`);
      }
    } else if (this.mode === 'on') {
      this.log('call', '没给 --accept-x/--accept-y，只截图不点');
    }
    await this._capture(win, this.mode === 'learn' ? 3 : 1);
  }

  async _capture(win, frames = 1) {
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
      } catch (error) {
        this.log('call', `截图失败：${String(error?.message ?? error).slice(0, 80)}`);
      }
    }
  }

  close() {
    clearInterval(this.timer);
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
  const mic = new Mic({ container: opts.container, fifo: opts.fifo, outWav: opts.outWav, noiseLevel: opts.micNoise });
  mic.start();

  let watcher = null;
  if (opts.autoAnswer) {
    const accept = (opts.acceptX !== null && opts.acceptY !== null)
      ? { x: opts.acceptX, y: opts.acceptY }
      : null;
    watcher = new CallWatcher({ container: opts.container, mode: opts.autoAnswer, accept, log });
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
  }

  const queue = [];
  let busy = false;
  let stopped = false;

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
      if (first) { log('tts', `首句开口 ${Date.now() - t0}ms（共 ${parts.length} 句）：「${part}」`); first = false; }
    }
  }

  async function handleUtterance(pcm, seconds, index) {
    const t0 = Date.now();
    const epoch = speechEpoch;
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
    if (epoch !== speechEpoch) { log('turn', '这轮已经被打断，不念了'); return; }
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
  let speechEpoch = 0;
  const vad = new Vad({
    log,
    // 打断：她还在说的时候你开口，立刻把她剩下的话丢掉
    onSpeechStart: () => {
      warmTts();
      speechEpoch++; // 作废在途的那一轮：它回来也不念了
      if (!mic.isSpeaking()) return;
      mic.flush();
      log('turn', '被打断，停止播放');
    },
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
