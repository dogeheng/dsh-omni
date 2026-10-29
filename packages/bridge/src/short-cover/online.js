// Online source adapters: QQ Music (qqmusic-api-python) and NeteaseCloudMusicApi.
// Only platform-returned playable URLs are used; encrypted/DRM formats are rejected.
// A configured third-party resolver is an optional fallback, never a requirement.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scoreCandidate } from './library.js';
import { probeDuration } from './segment.js';

const execFileAsync = promisify(execFile);
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[（）()\[\]【】《》"'“”‘’·,，.。!！?？&|]/g, '');
const versionOf = (title) => {
  const m = /[（(]([^）)]+)[）)]/.exec(String(title ?? ''));
  return m ? m[1].trim() : '';
};

function cacheName(key, ext = '.json') { return crypto.createHash('sha1').update(key).digest('hex').slice(0, 24) + ext; }

async function fetchWithRetry(url, opts = {}, cfg) {
  let last;
  for (let attempt = 0; attempt <= cfg.online.retries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(cfg.online.timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      last = e;
      if (attempt < cfg.online.retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw last;
}

async function jsonFetch(url, opts, cfg) {
  const res = await fetchWithRetry(url, opts, cfg);
  return res.json();
}

function runQQ(payload, cfg) {
  return new Promise((resolve, reject) => {
    const py = cfg.online.qqmusicPython;
    if (!py || !fs.existsSync(py)) return reject(Object.assign(new Error(`QQ 音乐 Python 不存在：${py}`), { stage: 'online_unavailable' }));
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'qqmusic_bridge.py');
    const child = spawn(py, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(Object.assign(new Error('QQ 音乐请求超时'), { stage: 'online_timeout' })); }, cfg.online.timeoutMs + 3000);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        if (!j.ok) return reject(Object.assign(new Error(j.error || 'QQ 音乐失败'), { stage: j.stage || 'online_error' }));
        resolve(j);
      } catch {
        reject(Object.assign(new Error(`QQ 音乐返回异常：${(err || out).slice(0, 200)}`), { stage: 'online_error' }));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function mapNeteaseSong(s) {
  const artist = (s.ar || s.artists || []).map((a) => a.name).filter(Boolean).join('、');
  const title = String(s.name || '');
  return {
    source: 'netease', id: String(s.id), title, artist,
    version: versionOf(title), tags: versionOf(title) ? [versionOf(title)] : [],
    duration: Math.round((Number(s.dt || s.duration) || 0) / 1000),
    album: String(s.al?.name || s.album?.name || ''),
    fee: Number(s.fee) || 0,
    paid: [1, 2, 3, 4].includes(Number(s.fee)),
    lrc: '', license: 'NeteaseCloudMusicApi platform URL (operator-authorised use only)',
  };
}

async function searchQQ(query, cfg) {
  const keyword = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const j = await runQQ({ action: 'search', keyword, num: 10, timeoutMs: cfg.online.timeoutMs }, cfg);
  return (j.results || []).map((c) => ({ ...c, paid: Object.values(c.pay || {}).some((v) => Number(v) > 0) }));
}

async function searchNetease(query, cfg) {
  if (!cfg.online.neteaseBaseUrl) return [];
  const kw = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const u = new URL(`${cfg.online.neteaseBaseUrl}/search`);
  u.searchParams.set('keywords', kw);
  u.searchParams.set('type', '1');
  u.searchParams.set('limit', '10');
  const headers = cfg.online.neteaseCookie ? { cookie: cfg.online.neteaseCookie } : {};
  const j = await jsonFetch(u, { headers }, cfg);
  return (j.result?.songs || []).map(mapNeteaseSong);
}

export async function searchOnline(query, cfg, log = () => {}) {
  const key = cacheName(`search:${query.song}|${query.artist}|${query.version}`);
  const file = path.join(cfg.cacheDir, 'online-search', key);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < cfg.online.searchCacheTtlMs) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const out = [];
  if (cfg.online.qqmusic) {
    try { out.push(...await searchQQ(query, cfg)); } catch (e) { log(`[cover] QQ 搜索失败：${e.message}`); }
  }
  if (cfg.online.neteaseBaseUrl) {
    try { out.push(...await searchNetease(query, cfg)); } catch (e) { log(`[cover] 网易云搜索失败：${e.message}`); }
  }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(out)); } catch {}
  return out;
}

function versionMatches(c, version) {
  if (!version) return true;
  const v = norm(version);
  const cv = norm(c.version);
  if (cv && (cv === v || cv.split('|').some((x) => x === v))) return true;
  return c.tags.some((t) => norm(t) === v);
}

function paidOf(c) { return c.paid === true || c.pay?.payDown > 0 || c.pay?.payPlay > 0 || c.pay?.payMonth > 0 || c.pay?.priceTrack > 0 || c.fee > 0; }

async function lyricQQ(mid, cfg) {
  try { const j = await runQQ({ action: 'lyric', mid, timeoutMs: cfg.online.timeoutMs }, cfg); return j.lyric || ''; } catch { return ''; }
}

async function lyricNetease(id, cfg) {
  try {
    const j = await jsonFetch(`${cfg.online.neteaseBaseUrl}/lyric?id=${encodeURIComponent(id)}`, { headers: cfg.online.neteaseCookie ? { cookie: cfg.online.neteaseCookie } : {} }, cfg);
    return j.lrc?.lyric || '';
  } catch { return ''; }
}

async function resolveThirdParty(c, query, cfg) {
  if (!cfg.online.thirdPartyResolverUrl) throw Object.assign(new Error('未配置第三方解析服务'), { stage: 'no_authorized_url' });
  if (paidOf(c) && !cfg.online.allowPaidMedia) throw Object.assign(new Error('候选标记为付费，未开启 allowPaidMedia'), { stage: 'no_authorized_url' });
  const j = await jsonFetch(cfg.online.thirdPartyResolverUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: c.source, id: c.id, title: c.title, artist: c.artist, version: c.version, query: { song: query.song, artist: query.artist, version: query.version } }),
  }, cfg);
  if (!j?.url || !/^https:\/\//.test(j.url)) throw Object.assign(new Error('第三方解析没有返回 https 音频地址'), { stage: 'no_authorized_url' });
  return { url: j.url, isPreview: false, license: j.license || 'third-party (operator-authorised)' };
}

async function resolveCandidate(c, query, cfg) {
  if (paidOf(c) && !cfg.online.allowPaidMedia) throw Object.assign(new Error('候选需要付费/会员，未开启 allowPaidMedia'), { stage: 'no_authorized_url' });
  if (c.source === 'qqmusic') {
    const j = await runQQ({ action: 'resolve', mid: c.mid || c.id, fileType: cfg.online.qqmusicFileType, pay: c.pay || {}, allowPaidMedia: cfg.online.allowPaidMedia, previewFallback: cfg.online.previewFallback, vs: c.vs, timeoutMs: cfg.online.timeoutMs }, cfg);
    return { url: j.url, isPreview: j.isPreview === true, license: c.license };
  }
  if (c.source === 'netease') {
    const u = new URL(`${cfg.online.neteaseBaseUrl}/song/url/v1`);
    u.searchParams.set('id', c.id); u.searchParams.set('level', cfg.online.neteaseLevel);
    const j = await jsonFetch(u, { headers: cfg.online.neteaseCookie ? { cookie: cfg.online.neteaseCookie } : {} }, cfg);
    const url = j.data?.[0]?.url;
    if (!url) throw Object.assign(new Error('网易云没有返回可播放地址'), { stage: 'no_authorized_url' });
    return { url, isPreview: false, license: c.license };
  }
  return resolveThirdParty(c, query, cfg);
}

async function validateAudio(file, cfg) {
  const st = fs.statSync(file);
  if (st.size < 10 * 1024 || st.size > cfg.online.maxBytes) throw new Error('音频大小异常');
  const duration = await probeDuration(file, cfg.ffmpegPath);
  if (!duration || duration < 5) throw new Error('音频时长不足或无法解析');
  const ffprobe = path.join(path.dirname(cfg.ffmpegPath), 'ffprobe');
  const bin = fs.existsSync(ffprobe) ? ffprobe : 'ffprobe';
  const info = await execFileAsync(bin, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file], { timeout: 8000 });
  const streams = JSON.parse(info.stdout || '{}').streams || [];
  if (!streams.some((s) => s.codec_type === 'audio')) throw new Error('文件没有音频流');
  await execFileAsync(cfg.ffmpegPath, ['-v', 'error', '-t', '5', '-i', file, '-f', 'null', '-'], { timeout: 15000 });
  return duration;
}

async function download(c, resolved, query, cfg) {
  const dir = path.join(cfg.cacheDir, 'sources');
  fs.mkdirSync(dir, { recursive: true });
  const urlExt = (path.extname(new URL(resolved.url).pathname) || '.mp3').toLowerCase();
  if (/\.(mflac|mgg|ncm)$/.test(urlExt)) throw Object.assign(new Error('加密/DRM 音频格式，拒绝下载'), { stage: 'drm_protected' });
  const ext = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg'].includes(urlExt) ? urlExt : '.mp3';
  const id = `${c.source}-${c.id}`.replace(/[^\w.-]/g, '_');
  const file = path.join(dir, id + ext);
  const metaFile = path.join(dir, id + '.json');
  let knownDuration = c.duration;
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
    try {
      const d = await validateAudio(file, cfg);
      const lrcFile = file.replace(/\.[^.]+$/, '.lrc');
      return { ...c, path: file, duration: d, lrc: fs.existsSync(lrcFile) ? lrcFile : (c.lrc || ''), isPreview: resolved.isPreview, license: resolved.license, online: true };
    } catch { try { fs.rmSync(file, { force: true }); } catch {} }
  }
  const res = await fetchWithRetry(resolved.url, {}, cfg);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cfg.online.maxBytes) throw new Error('音频超过大小限制');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10 * 1024 || buf.length > cfg.online.maxBytes) throw new Error('音频大小异常');
  const tmp = file + '.part';
  fs.writeFileSync(tmp, buf);
  try {
    knownDuration = await validateAudio(tmp, cfg);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  let lrc = '';
  try {
    if (c.source === 'qqmusic') lrc = await lyricQQ(c.mid || c.id, cfg);
    else if (c.source === 'netease') lrc = await lyricNetease(c.id, cfg);
  } catch {}
  if (lrc) fs.writeFileSync(file.replace(/\.[^.]+$/, '.lrc'), lrc);
  const meta = { source: c.source, id: c.id, title: c.title, artist: c.artist, version: c.version, duration: knownDuration, isPreview: resolved.isPreview, license: resolved.license, cacheVersion: cfg.cacheVersion, savedAt: Date.now() };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return { ...c, path: file, duration: knownDuration, lrc: lrc ? file.replace(/\.[^.]+$/, '.lrc') : '', isPreview: resolved.isPreview, license: resolved.license, online: true };
}

export async function resolveOnlineSource(query, cfg, log = () => {}) {
  if (!cfg.online.enabled) throw Object.assign(new Error('在线音源未开启'), { stage: 'source_not_found' });
  const all = await searchOnline(query, cfg, log);
  const songNorm = norm(query.song);
  const candidates = all
    .filter((c) => {
      const t = norm(c.title);
      // Online search is fuzzy; never accept a result that only shares a generic token.
      if (!t || !(t === songNorm || t.includes(songNorm))) return false;
      if (query.artist) {
        const a = norm(c.artist);
        const wanted = norm(query.artist);
        if (!a || !(a.includes(wanted) || wanted.includes(a))) return false;
      }
      return !query.version || versionMatches(c, query.version);
    })
    .map((c) => ({ ...c, score: scoreCandidate(c, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    const e = new Error(query.version ? `没有找到「${query.song}（${query.version}）」的对应版本，已拒绝普通版替代` : `没有找到可处理音源：${query.song}`);
    e.stage = 'source_not_found'; throw e;
  }
  // Prefer exact version, then free (unless the operator explicitly allowed paid media).
  const exact = query.version ? candidates.filter((c) => norm(c.version) === norm(query.version)) : candidates;
  const ordered = (exact.length ? exact : candidates).sort((a, b) => (paidOf(a) ? 1 : 0) - (paidOf(b) ? 1 : 0) || b.score - a.score);
  let lastError;
  for (const c of ordered.slice(0, 5)) {
    try {
      let resolved;
      try { resolved = await resolveCandidate(c, query, cfg); }
      catch (e) {
        if (!cfg.online.thirdPartyResolverUrl) throw e;
        try { resolved = await resolveThirdParty(c, query, cfg); }
        catch (e2) { e2.cause = e; throw e2; }
      }
      const file = await download(c, resolved, query, cfg);
      log(`[cover] 在线音源 ${c.source} ${c.title} / ${c.artist} ${file.duration.toFixed(1)}s${file.isPreview ? '（试听）' : ''}`);
      return { candidate: file, candidates };
    } catch (e) { lastError = e; log(`[cover] 在线候选失败 ${c.source} ${c.title}：${e.message}`); }
  }
  const e = new Error(lastError?.message || '没有可处理的在线音源');
  e.stage = lastError?.stage || 'no_authorized_url'; throw e;
}
