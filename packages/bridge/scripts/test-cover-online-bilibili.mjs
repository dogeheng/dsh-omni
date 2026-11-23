// 哔哩哔哩音源：搜索解析 / 音频流选择 / 带 Referer 真实下载。
// 全程用本地假服务器，不访问真实 B站接口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeCoverConfig } from '../src/short-cover/config.js';
import {
  searchOnline, resolveOnlineSource,
  parseBiliSearch, parseBiliDuration, parseBiliAudioUrl,
} from '../src/short-cover/online.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-bili-'));
const hits = { search: 0, audioReferer: '', audioCount: 0 };

// ── 1) 纯解析 ────────────────────────────────────────────────────────────────
{
  const json = {
    data: {
      result: [
        { type: 'video', bvid: 'BV1xx', title: '《<em class="keyword">晴天</em>》翻唱', author: 'UP主', duration: '4:20' },
        { type: 'video', bvid: 'BV2xx', title: '和这首歌无关的视频', author: '路人', duration: '1:00' },
        { type: 'media_bangumi', bvid: 'BV3xx', title: '番剧', author: '官方', duration: '24:00' },
      ],
    },
  };
  const list = parseBiliSearch(json);
  assert.equal(list.length, 2, '非 video 条目要过滤');
  assert.equal(parseBiliSearch(null).length, 0, '坏 JSON 不能抛');
  assert.equal(parseBiliDuration('4:20'), 260);
  assert.equal(parseBiliDuration('300'), 300);
  assert.equal(parseBiliDuration(''), 0);
  assert.equal(
    parseBiliAudioUrl({ data: { dash: { audio: [{ baseUrl: 'http://x/a.m4s', bandwidth: 64000 }, { baseUrl: 'http://x/b.m4s', bandwidth: 192000 }] } } }),
    'http://x/b.m4s', '要挑带宽最高的一档'
  );
  assert.equal(parseBiliAudioUrl({ data: { durl: [{ url: 'http://x/f.m4a' }] } }), 'http://x/f.m4a', '老接口 durl 兜底');
  assert.equal(parseBiliAudioUrl({ data: {} }), '', '没有音频流时返回空串');
  console.log('  ✅ 解析：搜索过滤 / 时长格式 / 音轨选择');
}

// 6 秒静音 mp3（下载后要过 ffprobe）
const mp3 = path.join(tmp, 'sample.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', '-q:a', '9', '-y', mp3]);
const AUDIO = fs.readFileSync(mp3);

let server;
server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/x/web-interface/search/type') {
    hits.search += 1;
    const kw = url.searchParams.get('keyword') || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { result: [
      { type: 'video', bvid: 'BVok', title: `${kw} 翻唱`, author: 'UP主', duration: '0:06' },
      { type: 'video', bvid: 'BVother', title: '完全不相关的视频', author: '路人', duration: '0:06' },
    ] } }));
    return;
  }
  if (url.pathname === '/x/web-interface/view') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { cid: 12345 } }));
    return;
  }
  if (url.pathname === '/x/player/playurl') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { dash: { audio: [
      { baseUrl: `http://127.0.0.1:${server.address().port}/low.m4s`, bandwidth: 64000 },
      { baseUrl: `http://127.0.0.1:${server.address().port}/best.m4s`, bandwidth: 192000 },
    ] } } }));
    return;
  }
  if (url.pathname === '/best.m4s') {
    hits.audioCount += 1;
    hits.audioReferer = String(req.headers.referer || '');
    res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': AUDIO.length });
    res.end(AUDIO);
    return;
  }
  res.writeHead(404);
  res.end('');
});

const base = () => `http://127.0.0.1:${server.address().port}`;
const makeCfg = (extra = {}, cache = 'cache') => normalizeCoverConfig({
  cacheDir: path.join(tmp, cache),
  minDuration: 5,
  maxDuration: 20,
  online: {
    retries: 0, timeoutMs: 5000, maxBytes: 4 * 1024 * 1024, searchCacheTtlMs: 60000, minSourceSeconds: 0,
    qqmusic: false, neteaseBaseUrl: '', kuwo: false, neteaseDirect: false, migu: false,
    bilibili: true, bilibiliApiBase: base(),
    ...extra,
  },
}, tmp);

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ── 2) 搜索 ────────────────────────────────────────────────────────────────
  const cfg = makeCfg();
  const list = await searchOnline({ song: '晴天' }, cfg);
  // searchOnline 只负责"收集候选"，标题匹配在上层（resolveOnlineSource）过滤。
  assert.equal(list.length, 2);
  const hit = list.find((c) => c.id === 'BVok');
  assert.ok(hit, '要找得到匹配的那条');
  assert.equal(hit.source, 'bilibili');
  assert.equal(hit.title, '晴天 翻唱', '标题要从 <em> 标签里还原');
  assert.equal(hit.artist, 'UP主');
  assert.equal(hit.duration, 6);
  assert.ok(hit.tags.includes('翻唱'), '翻唱关键词要进 tags');
  console.log('  ✅ 搜索：字段映射与过滤');

  // ── 3) 下载（端到端，必须带 Referer）──────────────────────────────────────
  const got = await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(got.candidate.source, 'bilibili');
  assert.ok(fs.existsSync(got.candidate.path));
  assert.ok(got.candidate.duration >= 5, `时长应≈6s（实际 ${got.candidate.duration}）`);
  assert.equal(hits.audioCount, 1, '应当只下载一次');
  assert.match(hits.audioReferer, /bilibili\.com/, '音频 CDN 请求必须带 Referer（否则 403）');
  console.log('  ✅ 解析/下载：选中最高码率音轨 + Referer 生效');

  // 缓存：第二次不再请求搜索与音频
  const searchBefore = hits.search;
  const audioBefore = hits.audioCount;
  await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(hits.search, searchBefore, '搜索应命中缓存');
  assert.equal(hits.audioCount, audioBefore, '下载应命中缓存');
  console.log('  ✅ 缓存：搜索与音频都不重复请求');

  // ── 4) 关掉开关就不请求 ────────────────────────────────────────────────────
  const offCfg = makeCfg({ bilibili: false, migu: false }, 'cache-off');
  const offList = await searchOnline({ song: '晴天' }, offCfg);
  assert.equal(offList.length, 0);
  console.log('  ✅ 开关：关闭后不发请求');

  // ── 5) 视频下架/无音频 → 明确 stage ───────────────────────────────────────
  const viewFail = makeCfg({ bilibiliApiBase: `${base()}/nope` }, 'cache-fail');
  await assert.rejects(
    () => resolveOnlineSource({ song: '晴天' }, viewFail),
    (error) => {
      assert.match(String(error.stage || ''), /no_authorized_url|source_not_found/);
      return true;
    }
  );
  console.log('  ✅ 失败路径：带 stage');
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nPASS');
