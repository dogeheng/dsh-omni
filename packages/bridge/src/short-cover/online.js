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

// ── 网易云（免自建服务的直连兜底）────────────────────────────────────────────
// 配了 neteaseBaseUrl 时走自建 API（音质/会员更全）；没配时用这套**免登录直连**：
// 搜索用 /api/search/get，播放用 /song/media/outer/url 的 302 直链。
// 直链只对部分免费/UGC 曲目有效（会员曲会 302 到 /404 页面），拿不到就当这个候选失败。
const neteaseWebBase = (cfg) => String(cfg.online?.neteaseWebBase || 'https://music.163.com').replace(/\/+$/, '');
const NETEASE_WEB_HEADERS = {
  referer: 'https://music.163.com/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  cookie: 'os=pc; appver=2.9.7'
};

// 302 到 /404 页面 = 会员/版权受限；content-type 不是音频也不能用。
export function isNeteaseOuterUrlUsable(finalUrl, contentType) {
  const url = String(finalUrl || '');
  const type = String(contentType || '');
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\/404(\?|$)/.test(url)) return false;
  return /audio\/|octet-stream/i.test(type);
}

async function searchNeteaseDirect(query, cfg) {
  if (cfg.online.neteaseDirect === false) return [];
  const keyword = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const u = new URL(`${neteaseWebBase(cfg)}/api/search/get`);
  u.searchParams.set('s', keyword);
  u.searchParams.set('type', '1');
  u.searchParams.set('limit', '20');
  u.searchParams.set('offset', '0');
  u.searchParams.set('total', 'true');
  const j = await jsonFetch(u, { headers: NETEASE_WEB_HEADERS }, cfg);
  return (j.result?.songs || []).map(mapNeteaseSong).map((c) => ({ ...c, paid: false, fee: 0 }));
}

async function resolveNeteaseDirect(c, cfg) {
  const res = await fetchWithRetry(`${neteaseWebBase(cfg)}/song/media/outer/url?id=${encodeURIComponent(c.id)}.mp3`, { headers: NETEASE_WEB_HEADERS }, cfg);
  if (!isNeteaseOuterUrlUsable(res.url, res.headers.get('content-type'))) {
    throw Object.assign(new Error('网易云直链没有返回可播放音频（多为会员/版权曲，需要登录态或自建 API）'), { stage: 'no_authorized_url' });
  }
  return { url: res.url, isPreview: false, license: c.license, headers: { referer: NETEASE_WEB_HEADERS.referer } };
}

async function lyricNeteaseDirect(id, cfg) {
  try {
    const j = await jsonFetch(`${neteaseWebBase(cfg)}/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&tv=-1`, { headers: NETEASE_WEB_HEADERS }, cfg);
    return String(j?.lrc?.lyric || '').trim();
  } catch { return ''; }
}

// ── 酷我（Kuwo）─────────────────────────────────────────────────────────────
// 免登录就能拿到 128k 直链，华语老歌/翻唱都全；接口很轻，两个 HTTP 请求，无外部服务。
// 搜索必须带 `pcjson=1` 这类参数才返回严格 JSON（默认返回的是单引号 JS 对象字面量）；
// 播放地址是 anti.s 返回的一行纯文本 URL，空响应=没有版权/会员限制。
function mapKuwoSong(item) {
  const title = String(item?.SONGNAME ?? item?.NAME ?? '').trim();
  const artist = String(item?.ARTIST ?? item?.SINGERNAME ?? '').trim();
  const rid = String(item?.DC_TARGETID ?? item?.MUSICRID ?? item?.RID ?? '').replace(/^MUSIC_/i, '').trim();
  const version = versionOf(title);
  return {
    source: 'kuwo',
    id: rid,
    title,
    artist,
    version,
    tags: version ? [version] : [],
    duration: Math.round(Number(item?.DURATION) || 0),
    album: String(item?.ALBUM ?? '').trim(),
    fee: 0,
    paid: false,
    lrc: '',
    license: 'Kuwo platform URL (operator-authorised use only)'
  };
}

export function parseKuwoSearch(json) {
  const list = Array.isArray(json?.abslist) ? json.abslist : [];
  return list.filter((item) => item && String(item.SONGNAME ?? '').trim() && String(item.DC_TARGETID ?? item.MUSICRID ?? '').trim());
}

// anti.s 正常时返回一行 http(s) 直链；版权/会员受限时返回空串或错误文本。
export function parseKuwoPlayUrl(text) {
  const line = String(text ?? '').trim().split(/\r?\n/).map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s));
  return line && /\/resource\/|\.(mp3|m4a|aac|flac|ogg)/i.test(line) ? line : '';
}

// 短路记忆：某个音源接口在别的网络里可能被墙/限速，失败一次就别在接下来几分钟里
// 反复等超时。纯内存时间戳，不落盘、不加定时器；5 分钟后自动重试（重启也会重置）。
const DOWN_COOLDOWN_MS = 5 * 60 * 1000;
function makeDownBreaker() {
  let downUntil = 0;
  return {
    down: () => Date.now() < downUntil,
    fail: () => { downUntil = Date.now() + DOWN_COOLDOWN_MS; },
    reset: () => { downUntil = 0; }
  };
}
const kuwoBreaker = makeDownBreaker();
const bilibiliBreaker = makeDownBreaker();

async function searchKuwo(query, cfg) {
  if (cfg.online.kuwo === false) return [];
  if (kuwoBreaker.down()) return [];
  const keyword = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const u = new URL(cfg.online.kuwoSearchUrl);
  const params = {
    client: 'kt', all: keyword, pn: '0', rn: '20', uid: '0',
    ver: 'kwplayer_ar_9.2.2.1', vipver: '1', show_copyright_off: '1', newver: '1',
    ft: 'music', cluster: '0', strategy: '2012', encoding: 'utf8',
    rformat: 'json', vermerge: '1', mobi: '1'
  };
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  try {
    const j = await jsonFetch(u, {}, cfg);
    return parseKuwoSearch(j).map(mapKuwoSong);
  } catch (error) {
    kuwoBreaker.fail();
    throw error;
  }
}

async function resolveKuwo(c, cfg) {
  const u = new URL(cfg.online.kuwoPlayUrl);
  u.searchParams.set('type', 'convert_url');
  u.searchParams.set('rid', `MUSIC_${c.id}`);
  u.searchParams.set('format', 'mp3');
  u.searchParams.set('response', 'url');
  const res = await fetchWithRetry(u, {}, cfg);
  const url = parseKuwoPlayUrl(await res.text());
  if (!url) throw Object.assign(new Error('酷我没有返回可播放地址（可能是版权/会员受限）'), { stage: 'no_authorized_url' });
  return { url, isPreview: false, license: c.license };
}

// ── 哔哩哔哩（Bilibili）────────────────────────────────────────────────────
// 翻唱/日系/小众版本的主要来源。搜索一请求，解析再两个请求（view 拿 cid → playurl 拿
// dash 音频流）；音频 URL 是带时效的 CDN 直链，下载时必须带 Referer，否则 403。
const BILI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
let biliBuvid = '';
function biliHeaders(cfg) {
  if (!biliBuvid) biliBuvid = `${crypto.randomUUID().toUpperCase()}infoc`;
  // 未登录也能搜/取音频；运营商给了 cookie（比如自己的账号）就用它的，音质可能更高。
  const cookie = String(cfg.online?.bilibiliCookie || '').trim() || `buvid3=${biliBuvid}`;
  return { referer: 'https://www.bilibili.com/', 'user-agent': BILI_UA, cookie };
}

function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 搜索接口的 duration 有时是 "4:20"，有时是秒数；统一成秒。
export function parseBiliDuration(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map((n) => Number(n) || 0);
  if (!parts.length) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

export function parseBiliSearch(json) {
  const list = Array.isArray(json?.data?.result) ? json.data.result : [];
  return list.filter((item) => item && item.bvid && item.title && item.type === 'video');
}

function mapBiliVideo(video) {
  const title = stripHtml(video.title);
  const tags = [];
  if (/翻唱|cover|翻自/i.test(title)) tags.push('翻唱');
  const version = versionOf(title) || (tags.includes('翻唱') ? '翻唱' : '');
  return {
    source: 'bilibili',
    id: String(video.bvid),
    title,
    artist: stripHtml(video.author || ''),
    version,
    tags: version && !tags.includes(version) ? [...tags, version] : tags,
    duration: parseBiliDuration(video.duration),
    album: '',
    fee: 0,
    paid: false,
    lrc: '',
    license: 'Bilibili platform URL (operator-authorised use only)'
  };
}

async function searchBilibili(query, cfg) {
  if (cfg.online.bilibili === false) return [];
  if (bilibiliBreaker.down()) return [];
  const keyword = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const u = new URL(`${cfg.online.bilibiliApiBase.replace(/\/+$/, '')}/x/web-interface/search/type`);
  u.searchParams.set('search_type', 'video');
  u.searchParams.set('keyword', keyword);
  u.searchParams.set('page', '1');
  try {
    const j = await jsonFetch(u, { headers: biliHeaders(cfg) }, cfg);
    return parseBiliSearch(j).map(mapBiliVideo);
  } catch (error) {
    bilibiliBreaker.fail();
    throw error;
  }
}

// playurl 的 dash.audio 按带宽挑最高的一档；老接口返回的 durl 也兜一下。
export function parseBiliAudioUrl(json) {
  const audio = Array.isArray(json?.data?.dash?.audio) ? json.data.dash.audio : [];
  if (audio.length) {
    const best = [...audio].sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
    const url = String(best?.baseUrl || best?.base_url || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  const durl = Array.isArray(json?.data?.durl) ? json.data.durl : [];
  const fallback = String(durl[0]?.url || '').trim();
  return /^https?:\/\//i.test(fallback) ? fallback : '';
}

async function resolveBilibili(c, cfg) {
  const api = cfg.online.bilibiliApiBase.replace(/\/+$/, '');
  const headers = biliHeaders(cfg);
  const view = await jsonFetch(`${api}/x/web-interface/view?bvid=${encodeURIComponent(c.id)}`, { headers }, cfg);
  const cid = view?.data?.cid;
  if (!cid) throw Object.assign(new Error('哔哩哔哩没有返回 cid（视频可能已下架）'), { stage: 'no_authorized_url' });
  const u = new URL(`${api}/x/player/playurl`);
  u.searchParams.set('bvid', c.id);
  u.searchParams.set('cid', String(cid));
  u.searchParams.set('fnval', '16');
  u.searchParams.set('fourk', '1');
  const playurl = await jsonFetch(u, { headers }, cfg);
  const url = parseBiliAudioUrl(playurl);
  if (!url) throw Object.assign(new Error('哔哩哔哩没有返回可播放音频（可能是会员/地区限制）'), { stage: 'no_authorized_url' });
  // 音频 CDN 需要 Referer，下载时一并带上。
  return { url, isPreview: false, license: c.license, headers: { referer: headers.referer, 'user-agent': headers['user-agent'] } };
}

// ── 咪咕音乐（Migu）────────────────────────────────────────────────────────
// 免登录的 App 接口：搜索一个请求、播放地址是 listenSong.do 的 302。
// 免费曲能拿完整音频；会员曲会返回 200 JSON「暂不提供试听地址」→ 当该候选失败。
const miguBreaker = makeDownBreaker();
const MIGU_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  referer: 'https://app.c.nf.migu.cn/',
  channel: '014X041',
  ua: 'Android_migu',
  version: '5.0'
};

export function parseMiguSearch(json) {
  const list = Array.isArray(json?.songResultData?.result) ? json.songResultData.result : [];
  return list.filter((item) => item && item.name && item.contentId && item.copyrightId);
}

function mapMiguSong(item) {
  const title = String(item.name || '').trim();
  const tags = [];
  for (const tag of Array.isArray(item.tags) ? item.tags : []) {
    const t = String(tag || '').trim();
    if (t && /翻唱|cover|伴奏|纯音乐/i.test(t) && !tags.includes(t)) tags.push(t);
  }
  const version = versionOf(title) || (tags.length ? tags[0] : '');
  return {
    source: 'migu',
    id: String(item.contentId),
    copyrightId: String(item.copyrightId),
    title,
    artist: (Array.isArray(item.singers) ? item.singers : []).map((x) => String(x?.name || '')).filter(Boolean).join('、'),
    version,
    tags: version && !tags.includes(version) ? [...tags, version] : tags,
    duration: 0, // 搜索接口不给时长，试听片段靠 minSourceSeconds 兜底拦截
    album: (Array.isArray(item.albums) ? item.albums : []).map((x) => String(x?.name || '')).filter(Boolean)[0] || '',
    fee: 0,
    paid: false,
    lrc: '',
    license: 'Migu platform URL (operator-authorised use only)'
  };
}

async function searchMigu(query, cfg) {
  if (cfg.online.migu === false) return [];
  if (miguBreaker.down()) return [];
  const keyword = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const u = new URL(`${cfg.online.miguApiBase.replace(/\/+$/, '')}/MIGUM2.0/v1.0/content/search_all.do`);
  u.searchParams.set('text', keyword);
  u.searchParams.set('pageNo', '1');
  u.searchParams.set('pageSize', '20');
  u.searchParams.set('isCorrect', '1');
  u.searchParams.set('isCopyright', '1');
  u.searchParams.set('sort', '1');
  u.searchParams.set('searchSwitch', JSON.stringify({ song: 1 }));
  try {
    const j = await jsonFetch(u, { headers: MIGU_HEADERS }, cfg);
    return parseMiguSearch(j).map(mapMiguSong);
  } catch (error) {
    miguBreaker.fail();
    throw error;
  }
}

async function resolveMigu(c, cfg) {
  if (!c.copyrightId) throw Object.assign(new Error('咪咕候选缺少 copyrightId'), { stage: 'no_authorized_url' });
  const u = new URL(`${cfg.online.miguApiBase.replace(/\/+$/, '')}/MIGUM2.0/v1.0/content/sub/listenSong.do`);
  const params = {
    channel: 'mx', copyrightId: c.copyrightId, contentId: c.id, toneFlag: 'HQ',
    netType: '00', userId: '1551919669717412', ua: 'Android_migu', version: '5.0', resourceType: '2'
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let lastError;
  for (let attempt = 0; attempt <= cfg.online.retries; attempt++) {
    try {
      // 这里必须手动处理 302：跟着重定向会直接把整首歌下下来，我们只要地址。
      const res = await fetch(u, { headers: MIGU_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(cfg.online.timeoutMs) });
      const location = String(res.headers.get('location') || '').trim();
      if (res.status >= 300 && res.status < 400 && /^https?:\/\//i.test(location)) {
        return { url: location, isPreview: false, license: c.license, headers: { referer: 'https://app.c.nf.migu.cn/' } };
      }
      const body = await res.json().catch(() => null);
      // 200 但「暂不提供试听地址」= 会员/版权受限
      throw Object.assign(new Error(body?.info ? `咪咕：${body.info}` : `咪咕没有返回播放地址（HTTP ${res.status}）`), { stage: 'no_authorized_url' });
    } catch (error) {
      lastError = error;
      if (error?.stage) break; // 明确的"没有地址"不值得重试
      if (attempt < cfg.online.retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

// ── 酷狗音乐（Kugou）────────────────────────────────────────────────────────
// 免登录、无签名：mobileservice 的搜索接口 + m.kugou 的 playInfo 拿 128k 直链。
// 搜索结果的 hash 本身就是播放凭据，不需要 album_id；会员/付费曲 playInfo 返回空
// url 和「需要付费」，按该候选失败处理（绝不拿空地址或试听片段凑数）。
const kugouBreaker = makeDownBreaker();
const KUGOU_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const KUGOU_HEADERS = { 'user-agent': KUGOU_UA, referer: 'https://m.kugou.com/' };

export function parseKugouSearch(json) {
  const list = Array.isArray(json?.data?.info) ? json.data.info : [];
  return list.filter((item) => item && String(item.songname ?? '').trim() && String(item.hash ?? '').trim());
}

function mapKugouSong(item) {
  const title = String(item.songname ?? '').trim();
  const artist = String(item.singername ?? '').trim();
  const version = versionOf(title);
  const payType = Number(item.pay_type) || 0;
  return {
    source: 'kugou',
    id: String(item.hash).trim(),
    hash: String(item.hash).trim(),
    title,
    artist,
    version,
    tags: version ? [version] : [],
    duration: Math.round(Number(item.duration) || 0),
    album: String(item.album_name ?? item.albumname ?? '').trim(),
    fee: payType,
    paid: payType !== 0,
    lrc: '',
    license: 'Kugou platform URL (operator-authorised use only)'
  };
}

export function parseKugouPlayInfo(json) {
  const url = String(json?.url ?? '').trim();
  return {
    url: /^https?:\/\//i.test(url) ? url : '',
    duration: Math.round(Number(json?.timeLength) || 0),
    fileSize: Number(json?.fileSize) || 0,
    bitRate: Number(json?.bitRate) || 0,
    extName: String(json?.extName ?? '').trim().toLowerCase(),
    payType: Number(json?.pay_type) || 0,
    error: String(json?.error ?? '').trim()
  };
}

async function searchKugou(query, cfg) {
  if (cfg.online.kugou === false) return [];
  if (kugouBreaker.down()) return [];
  const keyword = [query.song, query.artist, query.version].filter(Boolean).join(' ');
  const u = new URL(cfg.online.kugouSearchUrl);
  u.searchParams.set('keyword', keyword);
  u.searchParams.set('format', 'json');
  u.searchParams.set('page', '1');
  u.searchParams.set('pagesize', '20');
  u.searchParams.set('showtype', '1');
  try {
    const j = await jsonFetch(u, { headers: KUGOU_HEADERS }, cfg);
    return parseKugouSearch(j).map(mapKugouSong);
  } catch (error) {
    kugouBreaker.fail();
    throw error;
  }
}

async function resolveKugou(c, cfg) {
  const u = new URL(cfg.online.kugouPlayUrl);
  u.searchParams.set('cmd', 'playInfo');
  u.searchParams.set('hash', c.hash || c.id);
  u.searchParams.set('format', 'json');
  const j = await jsonFetch(u, { headers: KUGOU_HEADERS }, cfg);
  const info = parseKugouPlayInfo(j);
  if (!info.url) throw Object.assign(new Error(`酷狗没有返回可播放地址${info.error ? `（${info.error}）` : ''}`), { stage: 'no_authorized_url' });
  if (/\.(mflac|mgg|kgm)$/i.test(info.url)) throw Object.assign(new Error('酷狗返回加密/DRM 音频，拒绝下载'), { stage: 'drm_protected' });
  // 音频 CDN 只认 UA，不带 Referer，避免部分节点 403。
  return { url: info.url, isPreview: false, license: c.license, headers: { 'user-agent': KUGOU_UA } };
}

export async function searchOnline(query, cfg, log = () => {}) {
  // 缓存键带上「当前启用的音源集合」：否则新加/切换音源后，同一首歌 6 小时内还会命中
  // 旧缓存（里面根本没有新音源的候选），表现为「加了源却搜不到」。
  const sourceFlags = [
    cfg.online.qqmusic ? 'qq' : '',
    cfg.online.neteaseBaseUrl ? 'ne' : (cfg.online.neteaseDirect ? 'nd' : ''),
    cfg.online.kuwo ? 'kw' : '',
    cfg.online.bilibili ? 'bl' : '',
    cfg.online.migu ? 'mg' : '',
    cfg.online.kugou ? 'kg' : ''
  ].filter(Boolean).join('+');
  const key = cacheName(`search:${query.song}|${query.artist}|${query.version}|${sourceFlags}`);
  const file = path.join(cfg.cacheDir, 'online-search', key);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < cfg.online.searchCacheTtlMs) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  // 四个源并行搜（串行时 QQ 的 python 子进程会先拖 2~3 秒）。仍然全是按需请求，
  // 不预热、不轮询；单个源失败只记日志，不影响别的源。
  const jobs = [];
  if (cfg.online.qqmusic) jobs.push(['QQ', searchQQ(query, cfg)]);
  if (cfg.online.neteaseBaseUrl) jobs.push(['网易云', searchNetease(query, cfg)]);
  else jobs.push(['网易云直连', searchNeteaseDirect(query, cfg)]);
  jobs.push(['酷我', searchKuwo(query, cfg)]);
  jobs.push(['哔哩哔哩', searchBilibili(query, cfg)]);
  jobs.push(['咪咕', searchMigu(query, cfg)]);
  jobs.push(['酷狗', searchKugou(query, cfg)]);
  const settled = await Promise.all(jobs.map(async ([label, promise]) => {
    try { return await promise; } catch (e) { log(`[cover] ${label}搜索失败：${e.message}`); return []; }
  }));
  const out = settled.flat();
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

async function cachedSource(c, cfg) {
  const dir = path.join(cfg.cacheDir, 'sources');
  const id = `${c.source}-${c.id}`.replace(/[^\w.-]/g, '_');
  for (const ext of ['.mp3', '.m4a', '.wav', '.flac', '.ogg']) {
    const file = path.join(dir, id + ext);
    if (!fs.existsSync(file) || fs.statSync(file).size < 1024) continue;
    try {
      const d = await validateAudio(file, cfg);
      // 旧缓存里可能存过"15 秒试听"（酷我会员曲），这里也要拦：命中试听就删掉缓存重下。
      if (isPreviewClip(d, c.duration, Math.max(0, Number(cfg.online.minSourceSeconds) || 0))) {
        try { fs.rmSync(file, { force: true }); } catch {}
        try { fs.rmSync(file.replace(/\.[^.]+$/, '.json'), { force: true }); } catch {}
        return null;
      }
      const lrcFile = file.replace(/\.[^.]+$/, '.lrc');
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch {}
      return { ...c, path: file, duration: d, lrc: fs.existsSync(lrcFile) ? lrcFile : '', isPreview: meta.isPreview === true, license: meta.license || c.license, online: true, cachedSource: true };
    } catch {}
  }
  return null;
}

async function resolveCandidate(c, query, cfg) {
  if (paidOf(c) && !cfg.online.allowPaidMedia) throw Object.assign(new Error('候选需要付费/会员，未开启 allowPaidMedia'), { stage: 'no_authorized_url' });
  if (c.source === 'qqmusic') {
    const j = await runQQ({ action: 'resolve', mid: c.mid || c.id, fileType: cfg.online.qqmusicFileType, pay: c.pay || {}, allowPaidMedia: cfg.online.allowPaidMedia, previewFallback: cfg.online.previewFallback, vs: c.vs, timeoutMs: cfg.online.timeoutMs }, cfg);
    return { url: j.url, isPreview: j.isPreview === true, license: c.license };
  }
  if (c.source === 'kuwo') return resolveKuwo(c, cfg);
  if (c.source === 'bilibili') return resolveBilibili(c, cfg);
  if (c.source === 'migu') return resolveMigu(c, cfg);
  if (c.source === 'kugou') return resolveKugou(c, cfg);
  if (c.source === 'netease') {
    if (!cfg.online.neteaseBaseUrl) return resolveNeteaseDirect(c, cfg);
    const u = new URL(`${cfg.online.neteaseBaseUrl}/song/url/v1`);
    u.searchParams.set('id', c.id); u.searchParams.set('level', cfg.online.neteaseLevel);
    const j = await jsonFetch(u, { headers: cfg.online.neteaseCookie ? { cookie: cfg.online.neteaseCookie } : {} }, cfg);
    const url = j.data?.[0]?.url;
    if (!url) throw Object.assign(new Error('网易云没有返回可播放地址'), { stage: 'no_authorized_url' });
    return { url, isPreview: false, license: c.license };
  }
  return resolveThirdParty(c, query, cfg);
}

// 试听片段判定：搜索接口给了全曲时长，下载回来却短一大截 —— 酷我对会员曲会返回
// "15 秒试听 + 语音提示去 APP 听"，这种东西绝不能当翻唱源。
export function isPreviewClip(knownDuration, expectedDuration, minSourceSeconds = 0) {
  const actual = Number(knownDuration) || 0;
  const expected = Number(expectedDuration) || 0;
  if (minSourceSeconds > 0 && actual > 0 && actual < minSourceSeconds) return true;
  if (expected > 0 && actual > 0 && actual < expected * 0.6) return true;
  return false;
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
  const minSourceSeconds = Math.max(0, Number(cfg.online.minSourceSeconds) || 0);
  const rejectPreview = (seconds) => {
    if (!isPreviewClip(seconds, c.duration, minSourceSeconds)) return;
    throw Object.assign(new Error(`音源是试听片段（${seconds.toFixed(0)}s / 全曲 ${Number(c.duration) || '?'}s），不是完整歌曲`), { stage: 'no_authorized_url' });
  };
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
      rejectPreview(d);
      const lrcFile = file.replace(/\.[^.]+$/, '.lrc');
      return { ...c, path: file, duration: d, lrc: fs.existsSync(lrcFile) ? lrcFile : (c.lrc || ''), isPreview: resolved.isPreview, license: resolved.license, online: true };
    } catch { try { fs.rmSync(file, { force: true }); } catch {} }
  }
  const res = await fetchWithRetry(resolved.url, resolved.headers ? { headers: resolved.headers } : {}, cfg);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cfg.online.maxBytes) throw new Error('音频超过大小限制');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10 * 1024 || buf.length > cfg.online.maxBytes) throw new Error('音频大小异常');
  const tmp = file + '.part';
  fs.writeFileSync(tmp, buf);
  try {
    knownDuration = await validateAudio(tmp, cfg);
    rejectPreview(knownDuration);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  let lrc = '';
  try {
    if (c.source === 'qqmusic') lrc = await lyricQQ(c.mid || c.id, cfg);
    else if (c.source === 'netease') lrc = cfg.online.neteaseBaseUrl ? await lyricNetease(c.id, cfg) : await lyricNeteaseDirect(c.id, cfg);
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
  // If an exact-title candidate exists, do not silently fall back to a remix
  // ("雨爱 (Afro House版)") when that exact source has no authorised URL.
  const exactTitle = candidates.filter((c) => norm(c.title) === songNorm);
  const basedOnTitle = exactTitle.length ? exactTitle : candidates;
  // Prefer exact version, then free (unless the operator explicitly allowed paid media).
  const exact = query.version ? basedOnTitle.filter((c) => norm(c.version) === norm(query.version)) : basedOnTitle;
  const ordered = (exact.length ? exact : basedOnTitle).sort((a, b) => (paidOf(a) ? 1 : 0) - (paidOf(b) ? 1 : 0) || b.score - a.score);
  let lastError;
  // 多源回退：候选按分数排序后可能被同一个源占满前 5 个（QQ 匿名播放已经关闭，
  // 5 个 QQ 候选全失败就轮不到酷我）。这里把"确定放不了"的源标记为坏了，
  // 下一轮优先从别的源里挑；网络抖动/超时不标记（换一首同源的还可能成功）。
  const brokenSources = new Set();
  const sourceFailures = new Map();
  const queue = [...ordered];
  // 注意：`no_authorized_url` 常常是**单曲**限制（会员曲/版权曲），不代表整个源挂了
  // （网易云直连就是典型）。所以同一个源连续失败 2 次才判定为"这个源当前用不了"，
  // 否则正常降级到下一首/下一个源。
  const BROKEN_STAGES = new Set(['no_authorized_url', 'online_unavailable', 'drm_protected']);
  const BROKEN_AFTER = 2;
  let attempts = 0;
  while (queue.length && attempts < 10) {
    const idx = queue.findIndex((c) => !brokenSources.has(c.source));
    if (idx < 0) break;
    const c = queue.splice(idx, 1)[0];
    attempts += 1;
    try {
      const cached = await cachedSource(c, cfg);
      if (cached) {
        log(`[cover] 使用已缓存音源 ${c.source} ${c.title} / ${c.artist} ${cached.duration.toFixed(1)}s`);
        return { candidate: cached, candidates };
      }
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
    } catch (e) {
      lastError = e;
      const failures = (sourceFailures.get(c.source) || 0) + 1;
      sourceFailures.set(c.source, failures);
      if (BROKEN_STAGES.has(e?.stage) && failures >= BROKEN_AFTER) brokenSources.add(c.source);
      log(`[cover] 在线候选失败 ${c.source} ${c.title}：${e.message}`);
    }
  }
  const e = new Error(lastError?.message || '没有可处理的在线音源');
  e.stage = lastError?.stage || 'no_authorized_url'; throw e;
}
