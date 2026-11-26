// 酷我音源适配器：搜索解析 + 播放地址解析 + 真实下载 + 多源回退。
// 全程用本地 HTTP 假服务器，不访问真实酷我接口（避免测试依赖外网）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeCoverConfig } from '../src/short-cover/config.js';
import { searchOnline, resolveOnlineSource, parseKuwoSearch, parseKuwoPlayUrl, isPreviewClip } from '../src/short-cover/online.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-kuwo-'));
let server;

const hits = { search: 0, play: 0, audio: 0 };

// ── 1) 纯解析 ────────────────────────────────────────────────────────────────
{
  const json = {
    abslist: [
      { SONGNAME: '晴天', ARTIST: '周杰伦', DURATION: '269', DC_TARGETID: '228908', ALBUM: '叶惠美' },
      { SONGNAME: '晴天 (翻唱)', ARTIST: '某人', DURATION: '200', MUSICRID: 'MUSIC_555' },
      { SONGNAME: '', ARTIST: '空标题', DC_TARGETID: '1' },
      { SONGNAME: '没有 rid', ARTIST: 'x' },
    ],
  };
  const items = parseKuwoSearch(json);
  assert.equal(items.length, 2, '空标题/空 rid 要被丢掉');
  assert.equal(items[0].DC_TARGETID, '228908');
  assert.equal(parseKuwoSearch(null).length, 0, '坏 JSON 不能抛');

  assert.equal(parseKuwoPlayUrl('https://kw-bj.kuwo.cn/x/yy/resource/n1/69/32/588957081.mp3'), 'https://kw-bj.kuwo.cn/x/yy/resource/n1/69/32/588957081.mp3');
  assert.equal(parseKuwoPlayUrl('  \nhttps://x.example/a.mp3\n'), 'https://x.example/a.mp3', '要能容忍换行/空白');
  assert.equal(parseKuwoPlayUrl(''), '', '空响应=没有可播地址');
  assert.equal(parseKuwoPlayUrl('<html>error</html>'), '', '错误页不能当 URL');
  // 试听片段判定：酷我给会员曲返回 "15 秒试听 + 语音提示去 APP 听"，绝不能用
assert.equal(isPreviewClip(11, 222), true, '11s / 全曲 222s 明显是试听');
assert.equal(isPreviewClip(222, 222), false);
assert.equal(isPreviewClip(30, 0, 60), true, '没有全曲时长时按最短时长兜底');
assert.equal(isPreviewClip(90, 0, 60), false);
console.log('  ✅ 解析：搜索字段/空数据/播放地址/试听判定');
}

// 6 秒静音 mp3（下载后要过 ffprobe 校验，必须是真的音频）
const mp3 = path.join(tmp, 'sample.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', '-q:a', '9', '-y', mp3]);

const AUDIO = fs.readFileSync(mp3);
const teaserFile = path.join(tmp, 'teaser.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '11', '-q:a', '9', '-y', teaserFile]);
const TEASER = fs.readFileSync(teaserFile);
server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/r.s') {
    hits.search += 1;
    const kw = url.searchParams.get('all') || '';
    const list = kw.includes('晴天')
      ? [
          { SONGNAME: '晴天', ARTIST: '周杰伦', DURATION: '6', DC_TARGETID: 'good' },
          { SONGNAME: '晴天不相关', ARTIST: '某人', DURATION: '6', DC_TARGETID: 'other' },
          { SONGNAME: '晴天试听版', ARTIST: '某人', DURATION: '200', DC_TARGETID: 'teaser' },
        ]
      : [];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ abslist: list }));
    return;
  }
  if (url.pathname === '/anti.s') {
    hits.play += 1;
    const rid = String(url.searchParams.get('rid') || '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(rid === 'MUSIC_good' ? `http://127.0.0.1:${server.address().port}/audio.mp3`
      : rid === 'MUSIC_teaser' ? `http://127.0.0.1:${server.address().port}/teaser.mp3` : '');
    return;
  }
  if (url.pathname === '/teaser.mp3') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': TEASER.length });
    res.end(TEASER);
    return;
  }
  if (url.pathname === '/audio.mp3') {
    hits.audio += 1;
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO.length });
    res.end(AUDIO);
    return;
  }
  // netease 假接口：能搜到但拿不到播放地址（模拟"这个源当前放不了"）
  if (url.pathname === '/ne/search') {
    const songs = Array.from({ length: 6 }, (_, i) => ({ id: 900 + i, name: '晴天', ar: [{ name: '周杰伦' }], dt: 6000, fee: 0 }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { songs } }));
    return;
  }
  if (url.pathname === '/ne/song/url/v1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: null }] }));
    return;
  }
  res.writeHead(404);
  res.end('');
});

const base = () => `http://127.0.0.1:${server.address().port}`;
const makeCfg = (extra = {}) => normalizeCoverConfig({
  cacheDir: path.join(tmp, 'cache'),
  minDuration: 5,
  maxDuration: 20,
  online: {
    retries: 0,
    timeoutMs: 5000,
    maxBytes: 4 * 1024 * 1024,
    searchCacheTtlMs: 60000,
    minSourceSeconds: 0,
    qqmusic: false,
    neteaseBaseUrl: '',
    bilibili: false, migu: false, kugou: false,
    neteaseDirect: false,
    kuwo: true,
    kuwoSearchUrl: `${base()}/r.s`,
    kuwoPlayUrl: `${base()}/anti.s`,
    ...extra,
  },
}, tmp);

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ── 2) 搜索 ────────────────────────────────────────────────────────────────
  const cfg = makeCfg();
  const list = await searchOnline({ song: '晴天' }, cfg);
  assert.ok(list.length >= 1, '要搜到酷我候选');
  assert.ok(list.every((c) => c.source === 'kuwo'), '只开酷我时结果应全是酷我');
  assert.equal(list[0].id, 'good');
  assert.equal(list[0].title, '晴天');
  assert.equal(list[0].artist, '周杰伦');
  assert.equal(list[0].duration, 6);
  assert.equal(list[0].paid, false);

  // 搜索缓存：第二次不再打接口
  const hitBefore = hits.search;
  await searchOnline({ song: '晴天' }, cfg);
  assert.equal(hits.search, hitBefore, '搜索命中缓存后不应再请求');
  console.log('  ✅ 搜索：字段映射 + 缓存');

  // ── 3) 下载（端到端）──────────────────────────────────────────────────────
  const got = await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(got.candidate.source, 'kuwo');
  assert.ok(fs.existsSync(got.candidate.path), '要落盘到缓存目录');
  assert.match(got.candidate.path, /[\\/]sources[\\/]/, '音源要落在 sources 缓存目录（由 cleanupStorage 按 TTL/体积自动回收）');
  assert.ok(got.candidate.duration >= 5 && got.candidate.duration <= 7, `时长应≈6s（实际 ${got.candidate.duration}）`);
  assert.equal(got.candidate.isPreview, false);

  // 二次解析走缓存，不再下载
  const audioBefore = hits.audio;
  const again = await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(again.candidate.path, got.candidate.path);
  assert.equal(hits.audio, audioBefore, '缓存命中后不应重新下载');
  console.log('  ✅ 解析/下载：真实 mp3 校验通过 + 缓存复用');

  // ── 4) 多源回退：网易云 6 个候选都放不了，也要轮到酷我 ────────────────────
  // 注意：必须换一个缓存目录 —— 搜索缓存按「歌名|歌手|版本」做键，同一个目录会直接
  // 命中前一次"只开了酷我"的结果，就测不到多源回退了。
  const multiBase = normalizeCoverConfig({
    cacheDir: path.join(tmp, 'cache-multi'),
    minDuration: 5,
    maxDuration: 20,
    online: {
      retries: 0, timeoutMs: 5000, maxBytes: 4 * 1024 * 1024, searchCacheTtlMs: 60000, minSourceSeconds: 0,
      qqmusic: false, neteaseBaseUrl: `${base()}/ne`,
      bilibili: false, migu: false, kugou: false,
      neteaseDirect: false,
      kuwo: true, kuwoSearchUrl: `${base()}/r.s`, kuwoPlayUrl: `${base()}/anti.s`,
    },
  }, tmp);
  const multi = multiBase;
  const multiGot = await resolveOnlineSource({ song: '晴天' }, multi);
  assert.equal(multiGot.candidate.source, 'kuwo', '一个源整体放不了时，必须回退到其它源');
  console.log('  ✅ 多源回退：网易云候选全失败后仍能落到酷我');

  // ── 5b) 试听片段：搜索说 200s、实际只给 11s → 必须拒绝（不能当翻唱源）─────
  {
    const teaserCfg = normalizeCoverConfig({
      cacheDir: path.join(tmp, 'cache-teaser'), minDuration: 5, maxDuration: 20,
      online: {
        retries: 0, timeoutMs: 5000, maxBytes: 4 * 1024 * 1024, searchCacheTtlMs: 60000,
        minSourceSeconds: 0, qqmusic: false, neteaseBaseUrl: '', neteaseDirect: false, bilibili: false, migu: false, kugou: false,
        kuwo: true, kuwoSearchUrl: `${base()}/r.s`, kuwoPlayUrl: `${base()}/anti.s`,
      },
    }, tmp);
    await assert.rejects(
      () => resolveOnlineSource({ song: '晴天试听版' }, teaserCfg),
      (error) => {
        assert.match(String(error.message), /试听片段/);
        return true;
      },
      '11s 试听必须被拒绝'
    );
    console.log('  ✅ 试听拦截：15 秒试听片段不会当翻唱源');
  }

  // ── 6) 拿不到播放地址时要给出明确 stage（供上层提示）──────────────────────
  const bad = makeCfg({ kuwoSearchUrl: `${base()}/r.s` });
  await assert.rejects(
    () => resolveOnlineSource({ song: '晴天不相关' }, bad),
    (error) => {
      assert.match(String(error.stage || ''), /source_not_found|no_authorized_url/);
      return true;
    },
    '搜不到/放不了时要抛带 stage 的错误'
  );
  console.log('  ✅ 失败路径：带 stage 的明确错误');
  // ── 7) 短路：源挂了不能拖慢每次点歌（失败后 5 分钟内直接跳过）─────────────
  // 用慢接口（2s 才返回 500）模拟"接口被墙/限速"：第一次会等失败，
  // 第二次必须在毫秒级返回空，而不是再等一次超时。
  const slow = http.createServer((req, res) => {
    if (req.url.startsWith('/slow.r.s')) { setTimeout(() => { res.writeHead(500); res.end('boom'); }, 2000); return; }
    res.writeHead(404); res.end('');
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  try {
    const slowCfg = normalizeCoverConfig({
      cacheDir: path.join(tmp, 'cache-slow'),
      online: { retries: 0, timeoutMs: 5000, minSourceSeconds: 0, kuwo: true, bilibili: false, migu: false, kugou: false, neteaseDirect: false, qqmusic: false, neteaseBaseUrl: '', kuwoSearchUrl: `http://127.0.0.1:${slow.address().port}/slow.r.s` },
    }, tmp);
    const t0 = Date.now();
    const first = await searchOnline({ song: '短路测试' }, slowCfg);
    const firstMs = Date.now() - t0;
    assert.deepEqual([...first], [], '接口失败时应当返回空列表而不是抛错');
    assert.ok(firstMs >= 1800, `第一次应真的等到失败（实际 ${firstMs}ms）`);
    const t1 = Date.now();
    const second = await searchOnline({ song: '短路测试' }, slowCfg);
    const secondMs = Date.now() - t1;
    assert.deepEqual([...second], []);
    assert.ok(secondMs < 300, `短路后应立即返回（实际 ${secondMs}ms）`);
    console.log(`  ✅ 短路：失败一次后跳过（${firstMs}ms → ${secondMs}ms）`);
  } finally {
    await new Promise((resolve) => slow.close(resolve));
  }

} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nPASS');
