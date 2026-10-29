// Pick a 10–20 second singing window. Prefer cached timestamps, then LRC chorus
// lines, then a vocal-energy analysis fallback. Never blindly start at 0:00.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const normText = (s) => String(s ?? '').replace(/[\s，。！？、,.!?~～…"'“”‘’（）()【】\[\]]/g, '');

export async function probeDuration(file, ffmpegPath = 'ffmpeg') {
  try {
    const ffprobe = path.join(path.dirname(ffmpegPath), 'ffprobe');
    const bin = fs.existsSync(ffprobe) ? ffprobe : 'ffprobe';
    const { stdout } = await execFileAsync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 8000 });
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function parseLrc(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const body = line.replace(/\[[^\]]+\]/g, '').trim();
    if (!body) continue;
    for (const m of stamps) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(`0.${m[3].padEnd(3, '0')}`) : 0;
      out.push({ time: min * 60 + sec + frac, text: body });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

function chooseFromLrc(lines, duration, mode, songDuration) {
  if (!lines.length) return null;
  const counts = new Map();
  for (const l of lines) {
    const k = normText(l.text);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const repeated = lines.filter((l) => (counts.get(normText(l.text)) || 0) > 1);
  const candidates = [];
  const source = mode === 'verse' ? lines.filter((l) => (counts.get(normText(l.text)) || 0) <= 1) : (repeated.length ? repeated : lines);
  for (let i = 0; i < source.length; i++) {
    const start = source[i].time;
    if (start >= songDuration - 5) continue;
    // Expand to the next line boundary at or after the requested duration, but don't add >3s.
    let end = start + duration;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].time >= start + duration) { end = Math.min(start + duration + 3, lines[j].time); break; }
    }
    candidates.push({ start: Math.max(0, start), duration: Math.max(5, Math.min(duration, end - start, songDuration - start)), reason: mode === 'verse' ? 'lrc-verse' : 'lrc-chorus' });
  }
  if (!candidates.length) return null;
  // Prefer the earliest repeated chorus, but keep the requested duration close to target.
  candidates.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration) || a.start - b.start);
  return candidates[0];
}

function chooseFromCache(candidate, duration, mode) {
  if (!Array.isArray(candidate.segments) || !candidate.segments.length) return null;
  const list = candidate.segments.filter((s) => s && Number.isFinite(Number(s.start)));
  if (!list.length) return null;
  const wanted = mode === 'chorus' ? list.find((s) => /chorus|副歌|hook/i.test(`${s.label || ''} ${(s.tags || []).join(' ')}`)) : null;
  const pick = wanted || list[0];
  return { start: Number(pick.start), duration: Math.min(Number(pick.duration) || duration, duration + 2), reason: `cache:${pick.label || 'segment'}` };
}

async function analyzeAudio(cfg, source, duration, songDuration) {
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'segment_analyze.py');
  const py = cfg.pythonPath;
  if (!py || !fs.existsSync(py) || !fs.existsSync(script)) return null;
  const args = [script, '--audio', source, '--duration', String(duration), '--song-duration', String(songDuration || 0)];
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/nice', ['-n', '10', py, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(null); }, 30000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        if (Number.isFinite(Number(j.start))) return resolve({ start: Number(j.start), duration: Number(j.duration) || duration, reason: 'audio-energy' });
      } catch {}
      resolve(null);
    });
  });
}

/**
 * Returns { start, duration, reason } in seconds. `query.segment` is
 * chorus|verse|random; `query.start_time` wins when supplied.
 */
export async function chooseSegment({ source, candidate, query, cfg }) {
  const songDuration = Number(candidate.duration) || await probeDuration(source, cfg.ffmpegPath) || 0;
  const duration = Math.min(cfg.maxDuration, Math.max(cfg.minDuration, Number(query.duration) || cfg.defaultDuration));
  const rawStart = query.start_time;
  const hasStart = rawStart !== undefined && rawStart !== null && rawStart !== '' && Number.isFinite(Number(rawStart));
  if (hasStart) {
    const start = Math.max(0, Math.min(Number(rawStart), Math.max(0, songDuration - duration)));
    return { start, duration, reason: 'user-start-time', songDuration };
  }
  if (query.segment === 'random') {
    const maxStart = Math.max(0, (songDuration || duration * 3) - duration);
    const start = maxStart > 0 ? Math.random() * maxStart : 0;
    return { start, duration, reason: 'random', songDuration };
  }
  const cached = chooseFromCache(candidate, duration, query.segment || 'chorus');
  if (cached) return { ...cached, songDuration };
  if (candidate.lrc && fs.existsSync(candidate.lrc)) {
    let lines = [];
    try { lines = parseLrc(fs.readFileSync(candidate.lrc, 'utf8')); } catch {}
    if (lines.length) {
      const fromLrc = chooseFromLrc(lines, duration, query.segment || 'chorus', songDuration || (lines.at(-1)?.time || 0) + 5);
      if (fromLrc) return { ...fromLrc, songDuration };
    }
  }
  const analyzed = await analyzeAudio(cfg, source, duration, songDuration);
  if (analyzed) return { ...analyzed, songDuration };
  const start = Math.max(0, Math.min((songDuration || duration * 2) * 0.33, Math.max(0, (songDuration || duration) - duration)));
  return { start, duration, reason: 'fallback-33%', songDuration };
}

export function trimWindow(start, duration, songDuration) {
  const s = Math.max(0, Math.min(Number(start) || 0, Math.max(0, songDuration - duration)));
  return { start: s, duration: Math.max(1, Math.min(duration, songDuration - s)) };
}
