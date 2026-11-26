// 酷狗音源适配器：搜索解析 + playInfo 解析 + 真实下载 + 付费候选跳过。
// 全程用本地 HTTP 假服务器，不访问真实酷狗接口（避免测试依赖外网）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeCoverConfig } from '../src/short-cover/config.js';
import { searchOnline, resolveOnlineSource, parseKugouSearch, parseKugouPlayInfo } from '../src/short-cover/online.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-kugou-'));
let server;

const hits = { search: 0, play: 0, audio: 0 };

// ── 1) 纯解析 ────────────────────────────────────────────────────────────────
{
  const json = {
    status: 1,
    data: {
      total: 5,
      info: [
        { songname: '晴天', singername: '周杰伦', hash: 'HASH_GOOD', duration: 6, pay_type: 0, album_name: '叶惠美' },
        { songname: '晴天 (Live)', singername: '周杰伦', hash: 'HASH_LIVE', duration: 6, pay_type: 0 },
        { songname: '', singername: '空标题', hash: 'HASH_X' },
        { songname: '没有 hash', singername: 'x' },
      ],
    },
  };
  const items = parseKugouSearch(json);
  assert.equal(items.length, 2, '空标题/空 hash 要被丢掉');
  assert.equal(items[0].hash, 'HASH_GOOD');
  assert.equal(parseKugouSearch(null).length, 0, '坏 JSON 不能抛');
  assert.equal(parseKugouSearch({ data: { info: [] } }).length, 0);

  // playInfo：免费曲有直链；会员曲空 url + error；必须只认 http(s)。
  const free = parseKugouPlayInfo({ url: 'https://sharefs.kugou.com/a/b.mp3', timeLength: 6, fileSize: 1024, bitRate: 128, extName: 'mp3', pay_type: 0 });
  assert.equal(free.url, 'https://sharefs.kugou.com/a/b.mp3');
  assert.equal(free.duration, 6);
  const paid = parseKugouPlayInfo({ url: '', timeLength: 0, pay_type: 3, error: '需要付费' });
  assert.equal(paid.url, '', '空 url 不能当可播地址');
  assert.equal(paid.error, '需要付费');
  assert.equal(parseKugouPlayInfo({ url: 'javascript:alert(1)' }).url, '', '非 http(s) 一律丢弃');
  assert.equal(parseKugouPlayInfo(null).url, '');
  console.log('  ✅ 解析：搜索字段/空数据/playInfo 免费与付费/非法 URL');
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
  if (url.pathname === '/ks') {
    hits.search += 1;
    const kw = url.searchParams.get('keyword') || '';
    const list = kw.includes('晴天')
      ? [
          { songname: '晴天付费', singername: '周杰伦', hash: 'HASH_PAID', duration: 200, pay_type: 3 },
          { songname: '晴天', singername: '周杰伦', hash: 'HASH_GOOD', duration: 6, pay_type: 0 },
          { songname: '晴天不相关', singername: '某人', hash: 'HASH_OTHER', duration: 6, pay_type: 0 },
          { songname: '晴天试听版', singername: '某人', hash: 'HASH_TEASER', duration: 200, pay_type: 0 },
        ]
      : kw.includes('只有付费')
        ? [{ songname: '只有付费', singername: '某人', hash: 'HASH_PAID_ONLY', duration: 200, pay_type: 3 }]
        : [];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 1, data: { info: list } }));
    return;
  }
  if (url.pathname === '/kp') {
    hits.play += 1;
    const hash = String(url.searchParams.get('hash') || '');
    const table = {
      HASH_GOOD: { url: `http://127.0.0.1:${server.address().port}/audio.mp3`, timeLength: 6, pay_type: 0, fileSize: AUDIO.length, extName: 'mp3' },
      HASH_OTHER: { url: `http://127.0.0.1:${server.address().port}/audio.mp3`, timeLength: 6, pay_type: 0, fileSize: AUDIO.length, extName: 'mp3' },
      HASH_TEASER: { url: `http://127.0.0.1:${server.address().port}/teaser.mp3`, timeLength: 11, pay_type: 0, fileSize: TEASER.length, extName: 'mp3' },
      HASH_PAID: { url: '', timeLength: 0, pay_type: 3, error: '需要付费' },
      HASH_PAID_ONLY: { url: '', timeLength: 0, pay_type: 3, error: '需要付费' },
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(table[hash] || { url: '' }));
    return;
  }
  if (url.pathname === '/audio.mp3') {
    hits.audio += 1;
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO.length });
    res.end(AUDIO);
    return;
  }
  if (url.pathname === '/teaser.mp3') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': TEASER.length });
    res.end(TEASER);
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
    neteaseDirect: false,
    kuwo: false,
    bilibili: false,
    migu: false,
    kugou: true,
    kugouSearchUrl: `${base()}/ks`,
    kugouPlayUrl: `${base()}/kp`,
    ...extra,
  },
}, tmp);

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ── 2) 搜索：字段映射 + 付费标记 ────────────────────────────────────────────
  const cfg = makeCfg();
  const list = await searchOnline({ song: '晴天' }, cfg);
  assert.ok(list.length >= 1, '要搜到酷狗候选');
  assert.ok(list.every((c) => c.source === 'kugou'), '只开酷狗时结果应全是酷狗');
  const good = list.find((c) => c.hash === 'HASH_GOOD');
  assert.ok(good, '要保留免费候选');
  assert.equal(good.title, '晴天');
  assert.equal(good.artist, '周杰伦');
  assert.equal(good.duration, 6);
  assert.equal(good.paid, false);
  const paid = list.find((c) => c.hash === 'HASH_PAID');
  assert.equal(paid.paid, true, 'pay_type≠0 必须标成付费，避免被当成免费候选');
  // 搜到的是付费候选时，走 resolve 必须被 allowPaidMedia=false 拦下
  assert.ok(list.every((c) => c.id === c.hash), 'id 用 hash（playInfo 只需 hash）');

  const hitBefore = hits.search;
  await searchOnline({ song: '晴天' }, cfg);
  assert.equal(hits.search, hitBefore, '搜索命中缓存后不应再请求');
  console.log('  ✅ 搜索：字段映射 + 付费标记 + 缓存');

  // ── 3) 下载（端到端）──────────────────────────────────────────────────────
  const got = await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(got.candidate.source, 'kugou');
  assert.ok(fs.existsSync(got.candidate.path), '要落盘到缓存目录');
  assert.match(got.candidate.path, /[\\/]sources[\\/]/);
  assert.ok(got.candidate.duration >= 5 && got.candidate.duration <= 7, `时长应≈6s（实际 ${got.candidate.duration}）`);
  assert.equal(got.candidate.isPreview, false);

  const audioBefore = hits.audio;
  const again = await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(again.candidate.path, got.candidate.path);
  assert.equal(hits.audio, audioBefore, '缓存命中后不应重新下载');
  console.log('  ✅ 解析/下载：真实 mp3 校验通过 + 缓存复用');

  // ── 4) 付费候选排在前面也不能用：必须落到免费的 ────────────────────────────
  // 「晴天付费」标题含晴天、分数不一定低，但允许付费=false 时要被过滤/跳过。
  assert.notEqual(got.candidate.hash, 'HASH_PAID');

  // ── 5) 只有付费候选时，要给出明确的 no_authorized_url ──────────────────────
  {
    const paidCfg = makeCfg({ cacheDir: path.join(tmp, 'cache-paid') });
    const err = await resolveOnlineSource({ song: '只有付费' }, paidCfg).catch((e) => e);
    assert.ok(err instanceof Error, '只有付费候选时应报错而不是返回空');
    assert.match(String(err.stage || ''), /no_authorized_url|source_not_found/);
    console.log('  ✅ 付费路径：只有会员曲时明确失败（不会拿空地址凑数）');
  }

  // ── 6) 试听片段：搜索说 200s、实际只给 11s → 必须拒绝 ──────────────────────
  {
    const teaserCfg = makeCfg({ cacheDir: path.join(tmp, 'cache-teaser') });
    await assert.rejects(
      () => resolveOnlineSource({ song: '晴天试听版' }, teaserCfg),
      (error) => {
        assert.match(String(error.message), /试听片段/);
        return true;
      },
      '11s 试听必须被拒绝'
    );
    console.log('  ✅ 试听拦截：短片段不会当翻唱源');
  }

  // ── 7) 拿不到任何候选时给 source_not_found ────────────────────────────────
  await assert.rejects(
    () => resolveOnlineSource({ song: '完全不存在' }, makeCfg({ cacheDir: path.join(tmp, 'cache-none') })),
    (error) => { assert.match(String(error.stage || ''), /source_not_found/); return true; },
  );
  console.log('  ✅ 失败路径：带 stage 的明确错误');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✅ 酷狗音源测试通过');
}
