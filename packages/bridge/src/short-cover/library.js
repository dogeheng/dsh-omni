// Song metadata search and authorised-source resolution.
//
// Sources, in order:
//   1. local library (MUSIC_LIBRARY_PATH): files the operator already owns/has rights to;
//   2. Jamendo (optional client id): Creative Commons tracks with a direct legal audio URL.
// No NetEase/QQ audio extraction, DRM bypass or premium URL scraping is implemented.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg']);
const parseJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[（）()\[\]【】《》"'“”‘’·,，.。!！?？&]/g, '');
const tokens = (s) => String(s ?? '').toLowerCase().split(/[\s,，/]+/).filter(Boolean);

function parseFilename(file) {
  const base = path.basename(file, path.extname(file));
  const clean = base.replace(/\[[^\]]*]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s*-\s*(.+)$/.exec(clean);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: clean };
}

function versionTags(text) {
  const s = String(text ?? '').toLowerCase();
  const tags = [];
  for (const tag of ['司凤', '翻唱', 'cover', 'live', '现场', '女声', '男声', '童声', 'acoustic', 'remix', '片段', '副歌', 'demo']) {
    if (s.includes(tag.toLowerCase())) tags.push(tag);
  }
  return tags;
}

function collectFiles(dir, depth = 0, out = []) {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(p, depth + 1, out);
    else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

function stemsFor(file) {
  const base = file.slice(0, -path.extname(file).length);
  const inst = [`${base}.instrumental.wav`, `${base}.no_vocals.wav`, path.join(path.dirname(file), 'instrumental.wav')];
  const voc = [`${base}.vocals.wav`, path.join(path.dirname(file), 'vocals.wav')];
  return {
    instrumental: inst.find((p) => fs.existsSync(p)) || '',
    vocals: voc.find((p) => fs.existsSync(p)) || '',
  };
}

export function listLibrary(dir) {
  const files = collectFiles(dir);
  return files.map((file) => {
    const meta = parseJson(file.replace(/\.[^.]+$/, '.json')) || parseJson(path.join(path.dirname(file), 'meta.json')) || {};
    const name = parseFilename(file);
    const lrc = ['', '.lrc'].map((ext) => file.replace(/\.[^.]+$/, ext)).find((p) => p && fs.existsSync(p)) || '';
    const stems = stemsFor(file);
    return {
      id: crypto.createHash('sha1').update(file).digest('hex').slice(0, 12),
      path: file,
      title: String(meta.title || name.title || path.basename(file)).trim(),
      artist: String(meta.artist || name.artist || '').trim(),
      version: String(meta.version || '').trim(),
      tags: [...new Set([...(Array.isArray(meta.tags) ? meta.tags : []), ...versionTags(path.basename(file)), ...versionTags(meta.version)])],
      duration: Number(meta.duration) || null,
      lrc,
      stems,
      segments: Array.isArray(meta.segments) ? meta.segments : [],
      source: 'local',
      license: String(meta.license || ''),
    };
  });
}

export function scoreCandidate(c, q) {
  const title = norm(c.title);
  const artist = norm(c.artist);
  const hay = norm(`${c.title} ${c.artist} ${c.version} ${c.tags.join(' ')}`);
  const song = norm(q.song);
  if (!song) return -1;
  let score = 0;
  if (title === song) score += 100;
  else if (title.includes(song) || song.includes(title)) score += 55;
  else if (hay.includes(song)) score += 25;
  else {
    const parts = tokens(q.song);
    const hit = parts.filter((p) => hay.includes(norm(p))).length;
    if (!hit) return -1;
    score += Math.min(30, hit * 10);
  }
  if (q.artist) {
    if (artist === norm(q.artist)) score += 30;
    else if (artist.includes(norm(q.artist)) || norm(q.artist).includes(artist)) score += 15;
  }
  if (q.version) {
    const v = norm(q.version);
    const vNorm = norm(c.version);
    const matched = (vNorm && (vNorm.includes(v) || v.includes(vNorm)))
      || c.tags.some((t) => { const n = norm(t); return n && (n.includes(v) || v.includes(n)); });
    if (matched) score += 45;
    else return -1; // do not silently return the ordinary version when a specific one was asked
  }
  if (/伴奏|instrumental|off vocal/i.test(`${c.title} ${c.version}`) && !/伴奏/.test(q.song)) score -= 30;
  return score;
}

export function searchLibrary(query, dir) {
  const all = listLibrary(dir);
  return all
    .map((c) => ({ ...c, score: scoreCandidate(c, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

async function jamendoSearch(query, cfg) {
  if (!cfg.jamendoClientId) return [];
  const q = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const u = new URL('https://api.jamendo.com/v3.0/tracks/');
  u.searchParams.set('client_id', cfg.jamendoClientId);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '8');
  u.searchParams.set('search', q);
  u.searchParams.set('audioformat', 'mp32');
  const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return (json.results || []).map((t) => ({
    id: `jamendo-${t.id}`,
    title: String(t.name || ''),
    artist: String(t.artist_name || ''),
    version: '',
    tags: ['creative-commons'],
    duration: Number(t.duration) || null,
    path: '',
    audioUrl: String(t.audio || ''),
    source: 'jamendo',
    license: String(t.license_ccurl || ''),
    lrc: '',
    stems: {},
    segments: [],
  })).filter((c) => c.title && /^https:\/\//.test(c.audioUrl));
}

async function downloadSource(candidate, cfg) {
  const dir = path.join(cfg.cacheDir, 'sources');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(new URL(candidate.audioUrl).pathname) || '.mp3';
  const file = path.join(dir, `${candidate.id}${ext}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) return { ...candidate, path: file };
  const res = await fetch(candidate.audioUrl, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Jamendo 音频下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 || buf.length > 40 * 1024 * 1024) throw new Error('Jamendo 音频大小异常');
  fs.writeFileSync(file, buf);
  return { ...candidate, path: file };
}

export async function resolveSource(query, cfg) {
  const local = searchLibrary(query, cfg.libraryDir);
  if (local.length) return { candidate: local[0], candidates: local };
  const remote = (await jamendoSearch(query, cfg))
    .map((c) => ({ ...c, score: scoreCandidate(c, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (remote.length) return { candidate: await downloadSource(remote[0], cfg), candidates: remote };
  const err = new Error(`没有找到可处理的音源：${[query.song, query.artist, query.version].filter(Boolean).join(' ')}`);
  err.stage = 'source_not_found';
  err.candidates = [];
  throw err;
}
