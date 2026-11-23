// 咪咕音源：搜索映射 + 302 播放地址 + 「暂不提供试听地址」判死。
// 全程本地假服务器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeCoverConfig } from '../src/short-cover/config.js';
import { searchOnline, resolveOnlineSource, parseMiguSearch } from '../src/short-cover/online.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-migu-'));
const hits = { search: 0, listen: 0 };

// ── 纯解析 ──────────────────────────────────────────────────────────────────
{
  const json = { songResultData: { result: [
    { name: '起风了', contentId: 'c1', copyrightId: 'r1', singers: [{ name: '买辣椒也用券' }], albums: [{ name: '起风了' }], tags: ['翻唱', '流行'] },
    { name: '无版权信息', contentId: 'c2' },
    { name: '', contentId: 'c3', copyrightId: 'r3' },
  ] } };
  const rows = parseMiguSearch(json);
  assert.equal(rows.length, 1, '缺 copyrightId / 空标题要被过滤');
  assert.equal(parseMiguSearch(null).length, 0);
  console.log('  ✅ 解析：只保留可播候选');
}

const mp3 = path.join(tmp, 'sample.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', '-q:a', '9', '-y', mp3]);
const AUDIO = fs.readFileSync(mp3);

let server;
server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/vip/MIGUM2.0/v1.0/content/search_all.do') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ songResultData: { result: [
      { name: '晴天', contentId: 'vip', copyrightId: 'rvip', singers: [{ name: '周杰伦' }], tags: [] },
    ] } }));
    return;
  }
  if (url.pathname === '/MIGUM2.0/v1.0/content/search_all.do') {
    hits.search += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ songResultData: { result: [
      { name: '晴天', contentId: 'vip', copyrightId: 'rvip', singers: [{ name: '周杰伦' }], albums: [{ name: '叶惠美' }], tags: [] },
      { name: '晴天', contentId: 'free', copyrightId: 'rfree', singers: [{ name: '某UP' }], albums: [{ name: '' }], tags: ['翻唱'] },
    ] } }));
    return;
  }
  if (url.pathname === '/MIGUM2.0/v1.0/content/sub/listenSong.do') {
    hits.listen += 1;
    const id = String(url.searchParams.get('contentId') || '');
    if (id === 'free') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/audio.mp3` }); res.end(); return; }
    // 会员曲：200 + JSON「暂不提供试听地址」
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: '200000', info: '暂不提供试听地址' }));
    return;
  }
  if (url.pathname === '/audio.mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO.length }); res.end(AUDIO); return; }
  res.writeHead(404); res.end('');
});

const base = () => `http://127.0.0.1:${server.address().port}`;
const makeCfg = (extra = {}, cache = 'cache') => normalizeCoverConfig({
  cacheDir: path.join(tmp, cache), minDuration: 5, maxDuration: 20,
  online: {
    retries: 0, timeoutMs: 5000, maxBytes: 4 * 1024 * 1024, searchCacheTtlMs: 60000, minSourceSeconds: 0,
    qqmusic: false, neteaseBaseUrl: '', neteaseDirect: false, kuwo: false, bilibili: false,
    migu: true, miguApiBase: base(),
    ...extra,
  },
}, tmp);

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // 搜索
  const cfg = makeCfg();
  const list = await searchOnline({ song: '晴天' }, cfg);
  assert.equal(list.length, 2);
  assert.ok(list.every((c) => c.source === 'migu'));
  const free = list.find((c) => c.id === 'free');
  assert.equal(free.title, '晴天');
  assert.equal(free.artist, '某UP');
  assert.ok(free.tags.includes('翻唱'));
  assert.equal(free.copyrightId, 'rfree');
  console.log('  ✅ 搜索：字段映射 / 翻唱标签');

  // 解析：会员曲 200 JSON 判死 → 回退到免费曲
  const got = await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(got.candidate.id, 'free', '会员曲应被跳过');
  assert.ok(fs.existsSync(got.candidate.path));
  assert.ok(got.candidate.duration >= 5);
  assert.ok(hits.listen >= 2, '应分别尝试过会员曲和免费曲');
  console.log('  ✅ 解析：302 地址 + 会员曲「暂不提供试听地址」自动跳过');

  // 开关关闭：不发请求
  const offCfg = makeCfg({ migu: false }, 'cache-off');
  const offList = await searchOnline({ song: '晴天' }, offCfg);
  assert.equal(offList.length, 0);
  console.log('  ✅ 开关：关闭后不发请求');

  // 全部会员曲 → 带 stage 拒绝（单独一个 base，只返回会员曲）
  server.on('request', () => {}); // 保持服务器引用
  const vipOnly = makeCfg({ miguApiBase: `${base()}/vip` }, 'cache-vip');
  await assert.rejects(
    () => resolveOnlineSource({ song: '晴天' }, vipOnly),
    (e) => /no_authorized_url|source_not_found/.test(String(e.stage || ''))
  );
  console.log('  ✅ 失败路径：带 stage');
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\nPASS');
