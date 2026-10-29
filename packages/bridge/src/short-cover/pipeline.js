// Audio pipeline: cut a window, separate vocals, Seed-VC sing, mix with the
// original accompaniment. Every heavy step is an isolated child process.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chooseSegment, probeDuration } from './segment.js';

function memoryMb(pid) {
  try {
    const ps = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const rss = Number(ps.trim()) / 1024;
    if (process.platform === 'darwin') {
      try {
        const fp = execFileSync('/usr/bin/footprint', ['-p', String(pid)], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
        const m = /Footprint:\s+([\d.]+)\s*(KB|MB|GB)/i.exec(fp);
        if (m) {
          const n = Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 : m[2].toUpperCase() === 'MB' ? 1 : 1 / 1024);
          return Math.max(rss, Math.round(n));
        }
      } catch {}
    }
    return Number.isFinite(rss) ? Math.round(rss) : 0;
  } catch { return 0; }
}

function run(cmd, args, { cwd, timeoutMs = 120000, env, maxRssMb = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = '';
    const timer = setTimeout(() => {
      killed = `子进程超时（${Math.round(timeoutMs / 1000)}s）：${path.basename(cmd)}`;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    const mon = maxRssMb > 0 ? setInterval(() => {
      const mb = memoryMb(child.pid);
      if (mb > maxRssMb && !killed) {
        killed = `子进程内存 ${mb}MB 超过上限 ${maxRssMb}MB：${path.basename(cmd)}`;
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 700) : null;
    child.stdout.on('data', (b) => { out = (out + b.toString()).slice(-12000); });
    child.stderr.on('data', (b) => { err = (err + b.toString()).slice(-12000); });
    child.on('error', (e) => { clearTimeout(timer); if (mon) clearInterval(mon); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer); if (mon) clearInterval(mon);
      if (killed) return reject(new Error(killed));
      if (code === 0) return resolve({ out, err });
      reject(new Error(`子进程失败（exit ${code}）：${(err || out).trim().split('\n').slice(-4).join(' ').slice(0, 500)}`));
    });
  });
}

function niceRun(python, args, opts) {
  if (process.platform === 'win32') return run(python, args, opts);
  return run('/usr/bin/nice', ['-n', '10', python, ...args], opts);
}

async function ffmpeg(cfg, args, timeoutMs = 120000) {
  await run(cfg.ffmpegPath, args, { timeoutMs });
}

function findFile(dir, names) {
  if (!fs.existsSync(dir)) return '';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (names.includes(e.name)) return p;
    }
  }
  return '';
}

function newestWav(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.wav')) out.push(p);
    }
  };
  try { walk(dir); } catch {}
  out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return out[0] || '';
}

export async function separate(cfg, source, workDir, candidate, window) {
  const extStart = Math.max(0, window.start - cfg.contextSeconds);
  const extEnd = Math.min(window.songDuration || (window.start + window.duration + cfg.contextSeconds), window.start + window.duration + cfg.contextSeconds);
  const extDuration = Math.max(1, extEnd - extStart);
  const clip = path.join(workDir, 'clip.wav');
  await ffmpeg(cfg, ['-y', '-i', source, '-ss', String(extStart), '-t', String(extDuration), '-ar', '44100', '-ac', '2', clip]);

  // If the library supplies pre-separated stems, use them. This is the preferred
  // path for copyrighted material the operator has already processed legally.
  if (candidate?.stems?.vocals && candidate?.stems?.instrumental) {
    const vocals = path.join(workDir, 'vocals.wav');
    const instrumental = path.join(workDir, 'instrumental.wav');
    await ffmpeg(cfg, ['-y', '-i', candidate.stems.vocals, '-ss', String(extStart), '-t', String(extDuration), '-ar', '44100', '-ac', '1', vocals]);
    await ffmpeg(cfg, ['-y', '-i', candidate.stems.instrumental, '-ss', String(extStart), '-t', String(extDuration), '-ar', '44100', '-ac', '2', instrumental]);
    return { vocals, instrumental, extStart, extDuration, clip, separatedBy: 'stems' };
  }

  if (!cfg.demucsPython || !fs.existsSync(cfg.demucsPython)) {
    const e = new Error(`缺少分离环境：${cfg.demucsPython || 'demucsPython 未配置'}（安装：pip install demucs）`);
    e.stage = 'separation_unavailable';
    throw e;
  }
  const outDir = path.join(workDir, 'demucs');
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['-m', 'demucs.separate', '--two-stems=vocals', '-n', cfg.demucsModel, '-o', outDir];
  if (cfg.demucsDevice) args.push('--device', cfg.demucsDevice);
  args.push(clip);
  try {
    await niceRun(cfg.demucsPython, args, { timeoutMs: cfg.demucsTimeoutMs, maxRssMb: cfg.maxRssMb });
  } catch (e) {
    e.stage = 'separation_failed';
    throw e;
  }
  const vocals = findFile(outDir, ['vocals.wav']);
  const instrumental = findFile(outDir, ['no_vocals.wav']);
  if (!vocals || !instrumental) {
    const e = new Error('Demucs 没有产出 vocals/no_vocals');
    e.stage = 'separation_failed';
    throw e;
  }
  return { vocals, instrumental, extStart, extDuration, clip, separatedBy: 'demucs' };
}

export async function convert(cfg, vocals, workDir) {
  if (!cfg.refAudio || !fs.existsSync(cfg.refAudio)) {
    const e = new Error(`缺少目标音色参考：${cfg.refAudio || 'refAudio 未配置'}`);
    e.stage = 'reference_missing';
    throw e;
  }
  if (!cfg.pythonPath || !fs.existsSync(cfg.pythonPath)) {
    const e = new Error(`缺少 Seed-VC Python：${cfg.pythonPath || 'pythonPath 未配置'}`);
    e.stage = 'seedvc_unavailable';
    throw e;
  }
  if (!cfg.inferenceScript || !fs.existsSync(cfg.inferenceScript)) {
    const e = new Error(`缺少 Seed-VC inference.py：${cfg.inferenceScript || 'inferenceScript 未配置'}`);
    e.stage = 'seedvc_unavailable';
    throw e;
  }
  const outDir = path.join(workDir, 'seedvc');
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    cfg.inferenceScript,
    '--source', vocals,
    '--target', cfg.refAudio,
    '--output', outDir,
    '--diffusion-steps', String(cfg.seedvcSteps),
    '--f0-condition', 'True',
    '--fp16', cfg.seedvcFp16 ? 'True' : 'False',
    '--semi-tone-shift', '0',
  ];
  try {
    await niceRun(cfg.pythonPath, args, { cwd: cfg.seedVcDir, timeoutMs: cfg.seedvcTimeoutMs, maxRssMb: cfg.maxRssMb, env: { OMP_NUM_THREADS: '4', PYTORCH_ENABLE_MPS_FALLBACK: '1' } });
  } catch (e) {
    e.stage = 'conversion_failed';
    throw e;
  }
  const wav = newestWav(outDir);
  if (!wav) {
    const e = new Error('Seed-VC 没有产出 wav');
    e.stage = 'conversion_failed';
    throw e;
  }
  return wav;
}

export async function mix(cfg, vocals, instrumental, workDir, window, extStart, duration) {
  const offset = Math.max(0, window.start - extStart);
  const fadeIn = 0.12;
  const fadeOut = 0.16;
  const final = path.join(workDir, 'final.mp3');
  const vf = `[0:a]atrim=start=${offset}:duration=${duration},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut},volume=1.0[v]`;
  if (instrumental && fs.existsSync(instrumental)) {
    const af = `[1:a]atrim=start=${offset}:duration=${duration},asetpts=PTS-STARTPTS,volume=0.55,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}[i]`;
    await ffmpeg(cfg, ['-y', '-i', vocals, '-i', instrumental, '-filter_complex', `${vf};${af};[v][i]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]`, '-map', '[out]', '-t', String(duration), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', final]);
  } else {
    await ffmpeg(cfg, ['-y', '-i', vocals, '-filter_complex', `${vf};[v]alimiter=limit=0.95[out]`, '-map', '[out]', '-t', String(duration), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', final]);
  }
  return final;
}

export function hashFile(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch { return ''; }
}

export function cacheKey({ query, candidate, window, cfg }) {
  const voiceHash = hashFile(cfg.refAudio);
  const sourceStat = (() => { try { const s = fs.statSync(candidate.path); return `${candidate.path}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return candidate.path; } })();
  return crypto.createHash('sha256').update(JSON.stringify({
    song: query.song, artist: query.artist || '', version: query.version || '', segment: query.segment || 'chorus',
    duration: window.duration, start: query.start_time ?? null, sourceStat, voiceHash,
    model: 'seed-vc', steps: cfg.seedvcSteps, cacheVersion: cfg.cacheVersion,
  })).digest('hex').slice(0, 32);
}

export async function runPipeline({ source, candidate, query, cfg, workDir, log = () => {} }) {
  const window = await chooseSegment({ source, candidate, query, cfg });
  log(`[cover] 片段 ${window.reason}: ${window.start.toFixed(2)}s + ${window.duration.toFixed(2)}s / 全曲 ${window.songDuration.toFixed(1)}s`);
  const sep = await separate(cfg, source, workDir, candidate, window);
  const converted = await convert(cfg, sep.vocals, workDir);
  const final = await mix(cfg, converted, sep.instrumental, workDir, window, sep.extStart, window.duration);
  const seconds = (await probeDuration(final, cfg.ffmpegPath)) || window.duration;
  return {
    file: final,
    buffer: fs.readFileSync(final),
    ext: 'mp3',
    mime: 'audio/mpeg',
    seconds,
    window: { start: window.start, duration: window.duration, reason: window.reason },
    separatedBy: sep.separatedBy,
  };
}
