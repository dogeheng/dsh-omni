// 唱歌：Seed-VC 零样本歌声转换的按需 worker。
//
// 设计目标（16GB Mac）：
//   · 不在 DSH/bridge 常驻模型，空闲时没有 Python 进程；
//   · 一次只跑一首 15–20 秒的短片段；
//   · 子进程峰值 RSS 超限 / 超时 / 内存不足就杀，绝不拖死系统；
//   · 输入必须来自曲库的「已分离干声」，不在 Mac 上跑人声分离；
//   · Seed-VC 是 GPL-3.0，本模块只通过 CLI 调它，不复制它的代码/权重。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeCoverConfig } from './short-cover/config.js';

const execFileAsync = promisify(execFile);

export const SINGING_DEFAULTS = Object.freeze({
  enabled: false,
  engine: 'seed-vc',
  pythonPath: '',
  seedVcDir: '',
  inferenceScript: '',
  refAudio: '',
  songsDir: '',
  tmpDir: '',
  maxSeconds: 20,
  maxRssMb: 6500,
  minFreeMb: 3000,
  diffusionSteps: 30,
  semiToneShift: 0,
  fp16: false,
  timeoutMs: 180000,
  maxQueue: 1,
  cooldownMs: 180000,
  ffmpegPath: 'ffmpeg',
});

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v, fallback, { min = -Infinity, max = Infinity, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
};
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function resolvePath(root, value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}

/** 补全唱歌配置；路径按 bridge 根目录解析，允许绝对路径。 */
export function normalizeSingingConfig(raw = {}, root = process.cwd()) {
  const r = obj(raw);
  const D = SINGING_DEFAULTS;
  const defaultSeedVcDir = path.resolve(root, '..', 'seed-vc');
  const seedVcDir = resolvePath(root, r.seedVcDir, defaultSeedVcDir);
  const defaultPython = process.platform === 'win32'
    ? path.join(seedVcDir, '.venv', 'Scripts', 'python.exe')
    : path.join(seedVcDir, '.venv', 'bin', 'python');
  return {
    enabled: r.enabled === true,
    engine: 'seed-vc',
    pythonPath: resolvePath(root, r.pythonPath, defaultPython),
    seedVcDir,
    inferenceScript: resolvePath(root, r.inferenceScript, path.join(seedVcDir, 'inference.py')),
    refAudio: resolvePath(root, r.refAudio, path.join(root, 'data', 'voice', 'dsh-ref.wav')),
    songsDir: resolvePath(root, r.songsDir, path.join(root, 'data', 'singing', 'songs')),
    tmpDir: resolvePath(root, r.tmpDir, path.join(root, 'data', 'singing', 'tmp')),
    maxSeconds: num(r.maxSeconds, D.maxSeconds, { min: 5, max: 30, int: true }),
    maxRssMb: num(r.maxRssMb, D.maxRssMb, { min: 2000, max: 12000, int: true }),
    minFreeMb: num(r.minFreeMb, D.minFreeMb, { min: 500, max: 8000, int: true }),
    diffusionSteps: num(r.diffusionSteps, D.diffusionSteps, { min: 10, max: 50, int: true }),
    semiToneShift: num(r.semiToneShift, D.semiToneShift, { min: -12, max: 12, int: true }),
    fp16: r.fp16 === true,
    timeoutMs: num(r.timeoutMs, D.timeoutMs, { min: 60000, max: 300000, int: true }),
    maxQueue: num(r.maxQueue, D.maxQueue, { min: 0, max: 3, int: true }),
    cooldownMs: num(r.cooldownMs, D.cooldownMs, { min: 0, max: 600000, int: true }),
    ffmpegPath: str(r.ffmpegPath, D.ffmpegPath) || D.ffmpegPath,
    // Short-cover pipeline config is normalized separately by short-cover/config.js.
    cover: (r.cover && typeof r.cover === 'object' && !Array.isArray(r.cover)) ? r.cover : {},
  };
}

export function redactSingingConfig(raw = {}, root = process.cwd()) {
  const c = normalizeSingingConfig(raw, root);
  const cover = normalizeCoverConfig(c.cover, root, c);
  const safeCover = {
    ...cover,
    _singing: undefined,
    online: {
      ...cover.online,
      neteaseCookie: cover.online.neteaseCookie ? '********' : '',
      thirdPartyResolverUrl: cover.online.thirdPartyResolverUrl ? '********' : '',
    },
  };
  return { ...c, cover: safeCover, pythonPathSet: Boolean(c.pythonPath), refAudioSet: Boolean(c.refAudio) };
}

function safeId(id) {
  return /^[\w\u4e00-\u9fff.-]{1,80}$/u.test(String(id ?? '')) && !String(id).includes('..');
}

function findFile(dir, names) {
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return '';
}

function listSongs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    const base = path.join(dir, entry.name);
    const vocal = findFile(base, ['vocal.wav', 'vocal.flac', 'vocal.mp3', 'vocal.m4a']);
    if (!vocal) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(base, 'meta.json'), 'utf8')); } catch {}
    out.push({
      id: entry.name,
      title: str(meta.title, entry.name) || entry.name,
      vocal,
      instrumental: findFile(base, ['instrumental.wav', 'instrumental.flac', 'instrumental.mp3', 'instrumental.m4a']),
      source: str(meta.source),
      license: str(meta.license),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}

/** macOS 的 os.freemem() 只算 free，不含 inactive；用 vm_stat 估算可用。 */
function availableMemoryMb() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
      const page = Number((/page size of (\d+)/.exec(out) ?? [])[1]) || 16384;
      const get = (name) => Number((new RegExp(`${name}:\\s+(\\d+)`).exec(out) ?? [])[1]) || 0;
      const pages = get('Pages free') + get('Pages inactive') + get('Pages speculative');
      if (pages > 0) return Math.round((pages * page) / 1024 / 1024);
    }
    return Math.round(os.freemem() / 1024 / 1024);
  } catch {
    return Math.round(os.freemem() / 1024 / 1024);
  }
}

export function createSingingService({ getConfig, root = process.cwd(), log = () => {} } = {}) {
  const cfgNow = () => normalizeSingingConfig(typeof getConfig === 'function' ? getConfig() : {}, root);
  let active = null;
  let queue = [];
  let last = null;
  let lastError = '';
  let peakRssMb = 0;
  let lastAt = 0;

  function engineStatus() {
    const c = cfgNow();
    const missing = [];
    if (!fs.existsSync(c.pythonPath)) missing.push(`python: ${c.pythonPath}`);
    if (!fs.existsSync(c.inferenceScript)) missing.push(`inference.py: ${c.inferenceScript}`);
    if (!fs.existsSync(c.refAudio)) missing.push(`参考音频: ${c.refAudio}`);
    if (process.platform === 'darwin' && fs.existsSync(c.inferenceScript)) {
      try {
        const src = fs.readFileSync(c.inferenceScript, 'utf8');
        if (!src.includes('F0_ori.astype(np.float32)')) missing.push('Seed-VC MPS 补丁未打（运行 setup:seedvc 或 patch-seedvc-mps.mjs）');
      } catch {}
    }
    let ffmpegOk = false;
    try { execFileSync(c.ffmpegPath, ['-version'], { stdio: 'ignore', timeout: 2000 }); ffmpegOk = true; } catch {}
    if (!ffmpegOk) missing.push(`ffmpeg: ${c.ffmpegPath}`);
    return {
      ok: missing.length === 0,
      missing,
      python: c.pythonPath,
      seedVcDir: c.seedVcDir,
      refAudio: c.refAudio,
      songsDir: c.songsDir,
      songs: listSongs(c.songsDir).length,
      ffmpeg: ffmpegOk,
    };
  }

  function status() {
    const c = cfgNow();
    return {
      enabled: c.enabled,
      engine: c.engine,
      config: redactSingingConfig(c, root),
      engineStatus: engineStatus(),
      running: Boolean(active),
      queue: queue.length,
      last,
      lastError,
      peakRssMb,
      availableMemoryMb: availableMemoryMb(),
    };
  }

  function songs() {
    return listSongs(cfgNow().songsDir);
  }

  function findSong(id) {
    const c = cfgNow();
    const raw = String(id ?? '').trim();
    if (!raw || !safeId(raw)) throw new Error('歌名/ID 不合法');
    const hit = listSongs(c.songsDir).find((s) => s.id === raw || s.title === raw);
    if (!hit) throw new Error(`曲库里没有「${raw}」；可用：${listSongs(c.songsDir).map((s) => s.title).join('、') || '（空）'}`);
    return hit;
  }

  async function runFfmpeg(c, args) {
    await execFileAsync(c.ffmpegPath, args, { timeout: c.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  }

  async function getRssMb(pid) {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1000 });
      const kb = Number(stdout.trim());
      const rss = Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
      // macOS 的 MPS 分配不一定体现在 RSS 里；用 footprint 兜底，否则 5.4GB 的
      // MPS 峰值可能只看到 2GB RSS，内存守卫会形同虚设。
      if (process.platform === 'darwin' && rss > 0) {
        try {
          const fp = await execFileAsync('/usr/bin/footprint', ['-p', String(pid)], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
          const m = /Footprint:\s+([\d.]+)\s*(KB|MB|GB)/i.exec(fp.stdout);
          if (m) {
            const n = Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 : m[2].toUpperCase() === 'MB' ? 1 : 1 / 1024);
            if (Number.isFinite(n)) return Math.max(rss, Math.round(n));
          }
        } catch {}
      }
      return rss;
    } catch {
      return 0;
    }
  }

  async function probeDuration(file) {
    try {
      const ffprobe = process.platform === 'win32' ? 'ffprobe' : path.join(path.dirname(cfgNow().ffmpegPath), 'ffprobe');
      const bin = fs.existsSync(ffprobe) ? ffprobe : 'ffprobe';
      const { stdout } = await execFileAsync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 5000 });
      const n = Number(stdout.trim());
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  function killTree(child) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }

  async function convert(song, maxSeconds) {
    const c = cfgNow();
    const free = availableMemoryMb();
    if (free < c.minFreeMb) {
      throw new Error(`可用内存不足：${free}MB < ${c.minFreeMb}MB；先关掉一些程序再唱`);
    }
    fs.mkdirSync(c.tmpDir, { recursive: true });
    const jobDir = fs.mkdtempSync(path.join(c.tmpDir, 'sing-'));
    const source = path.join(jobDir, 'source.wav');
    const outDir = path.join(jobDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const started = Date.now();
    let child = null;
    let killedReason = '';
    let stdout = '';
    let stderr = '';
    try {
      // 只截取 15–20 秒，避免长音频把内存/时间拉高；统一成 44.1k 单声道。
      await runFfmpeg(c, ['-y', '-i', song.vocal, '-t', String(maxSeconds), '-ar', '44100', '-ac', '1', source]);
      const args = [
        c.inferenceScript,
        '--source', source,
        '--target', c.refAudio,
        '--output', outDir,
        '--diffusion-steps', String(c.diffusionSteps),
        '--f0-condition', 'True',
        '--fp16', c.fp16 ? 'True' : 'False',
        '--semi-tone-shift', String(c.semiToneShift),
      ];
      const command = process.platform === 'win32' ? c.pythonPath : '/usr/bin/nice';
      const commandArgs = process.platform === 'win32' ? args : ['-n', '10', c.pythonPath, ...args];
      child = spawn(command, commandArgs, {
        cwd: c.seedVcDir,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OMP_NUM_THREADS: '4',
          MKL_NUM_THREADS: '4',
          TOKENIZERS_PARALLELISM: 'false',
          PYTORCH_ENABLE_MPS_FALLBACK: '1',
        },
      });
      active = { pid: child.pid, started, song: song.title, peakRssMb: 0 };
      child.stdout?.on('data', (b) => { stdout = (stdout + b.toString()).slice(-6000); });
      child.stderr?.on('data', (b) => { stderr = (stderr + b.toString()).slice(-6000); });
      const exit = new Promise((resolve) => {
        child.once('error', (error) => resolve({ code: -1, error }));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const deadline = Date.now() + c.timeoutMs;
      let monitorBusy = false;
      const monitor = setInterval(async () => {
        if (!child || monitorBusy) return;
        monitorBusy = true;
        try {
          const rss = await getRssMb(child.pid);
          if (rss > (active?.peakRssMb ?? 0)) active.peakRssMb = rss;
          peakRssMb = Math.max(peakRssMb, rss);
          if (rss > c.maxRssMb && !killedReason) {
            killedReason = `Seed-VC 峰值内存 ${rss}MB 超过上限 ${c.maxRssMb}MB`;
            log(`[sing] ${killedReason}，终止 pid=${child.pid}`);
            killTree(child);
          }
          if (Date.now() > deadline && !killedReason) {
            killedReason = `Seed-VC 超时（${Math.round(c.timeoutMs / 1000)}s）`;
            killTree(child);
          }
        } finally {
          monitorBusy = false;
        }
      }, 500);
      const res = await exit;
      clearInterval(monitor);
      if (killedReason) throw new Error(killedReason);
      if (res.code !== 0) {
        const detail = (stderr || stdout || res.error?.message || '').trim().split('\n').slice(-6).join(' ');
        throw new Error(`Seed-VC 失败（exit ${res.code}）${detail ? `：${detail.slice(0, 300)}` : ''}`);
      }
      const wavs = fs.readdirSync(outDir).filter((n) => n.endsWith('.wav')).map((n) => path.join(outDir, n));
      if (!wavs.length) throw new Error('Seed-VC 没有产出 wav');
      wavs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const converted = wavs[0];
      const final = path.join(jobDir, 'final.mp3');
      if (song.instrumental) {
        await runFfmpeg(c, [
          '-y', '-i', converted, '-i', song.instrumental,
          '-filter_complex', '[0:a]volume=1.0[a];[1:a]volume=0.50[b];[a][b]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]',
          '-map', '[out]', '-t', String(maxSeconds), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', final,
        ]);
      } else {
        await runFfmpeg(c, ['-y', '-i', converted, '-t', String(maxSeconds), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', final]);
      }
      const buffer = fs.readFileSync(final);
      const seconds = (await probeDuration(final)) || Math.max(1, Math.round((Date.now() - started) / 100) / 10);
      const result = {
        buffer,
        ext: 'mp3',
        mime: 'audio/mpeg',
        seconds,
        elapsedMs: Date.now() - started,
        peakRssMb: active?.peakRssMb ?? 0,
        song: { id: song.id, title: song.title },
      };
      last = { at: Date.now(), song: song.title, seconds, elapsedMs: result.elapsedMs, peakRssMb: result.peakRssMb };
      lastError = '';
      return result;
    } finally {
      if (child) killTree(child);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
      active = null;
    }
  }

  async function runJob(song, maxSeconds) {
    active = { pid: null, started: Date.now(), song: song.title, peakRssMb: 0 };
    try {
      return await convert(song, maxSeconds);
    } catch (error) {
      lastError = error?.message ?? String(error);
      last = { at: Date.now(), song: song.title, error: lastError };
      throw error;
    } finally {
      active = null;
    }
  }

  function enqueue(song, maxSeconds) {
    if (active) {
      if (queue.length >= cfgNow().maxQueue) throw new Error('前面还有一首在唱，稍后再点');
      return new Promise((resolve, reject) => {
        queue.push({ song, maxSeconds, resolve, reject });
      });
    }
    return runJob(song, maxSeconds).finally(drain);
  }

  function drain() {
    if (active || !queue.length) return;
    const job = queue.shift();
    runJob(job.song, job.maxSeconds).then(job.resolve, job.reject).finally(drain);
  }

  async function sing(songId, { maxSeconds = null } = {}) {
    const c = cfgNow();
    if (!c.enabled) throw new Error('唱歌功能未开启（socialV2.singing.enabled=false）');
    const es = engineStatus();
    if (!es.ok) throw new Error(`唱歌引擎未就绪：${es.missing.join('；')}`);
    fs.mkdirSync(c.songsDir, { recursive: true });
    const song = findSong(songId);
    const limit = Math.max(5, Math.min(c.maxSeconds, Number(maxSeconds) || c.maxSeconds));
    return enqueue(song, limit);
  }

  return { sing, songs, status, engineStatus, findSong, normalize: cfgNow };
}
