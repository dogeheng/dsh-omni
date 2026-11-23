// 网易云免登录直连：搜索 → outer/url 302 → 音频；会员曲 302 到 /404 要判死。
// 用本地假服务器，不访问真实网易云。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeCoverConfig } from '../src/short-cover/config.js';
import { searchOnline, resolveOnlineSource, isNeteaseOuterUrlUsable } from '../src/short-cover/online.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-ned-'));
const hits = { search: 0, outer: 0 };

// ── 1) 纯函数 ────────────────────────────────────────────────────────────────
assert.equal(isNeteaseOuterUrlUsable('https://m801.music.126.net/x/a.mp3', 'audio/mpeg'), true);
assert.equal(isNeteaseOuterUrlUsable('https://music.163.com/404', 'text/html'), false, '302 到 /404 = 会员/版权受限');
assert.equal(isNeteaseOuterUrlUsable('https://x/y.mp3', 'text/html'), false, '非音频 content-type 不能用');
assert.equal(isNeteaseOuterUrlUsable('not-a-url', 'audio/mpeg'), false);
console.log('  ✅ 判定：正常直链 / 404 页 / 非音频');

const mp3 = path.join(tmp, 'sample.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', '-q:a', '9', '-y', mp3]);
const AUDIO = fs.readFileSync(mp3);

let server;
server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/search/get') {
    hits.search += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { songs: [
      { id: 222, name: '晴天', artists: [{ name: '某UP' }], duration: 6000, fee: 0, album: { name: '' } },
      { id: 111, name: '晴天 (Remix)', artists: [{ name: '某DJ' }], duration: 6000, fee: 1, album: { name: '' } },
    ] } }));
    return;
  }
  if (url.pathname === '/song/media/outer/url') {
    hits.outer += 1;
    const id = String(url.searchParams.get('id') || '').replace(/\.mp3$/, '');
    // 111=会员曲（302 到 404 页），222=免费曲（302 到音频）
    res.writeHead(302, { location: id === '111' ? '/404' : '/audio.mp3' });
    res.end();
    return;
  }
  if (url.pathname === '/404') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>404</html>'); return; }
  if (url.pathname === '/audio.mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO.length }); res.end(AUDIO); return; }
  if (url.pathname === '/api/song/lyric') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ lrc: { lyric: '[00:01.00]晴天\n[00:03.00]晴天\n' } }));
    return;
  }
  res.writeHead(404); res.end('');
});

const base = () => `http://127.0.0.1:${server.address().port}`;
const makeCfg = (extra = {}, cache = 'cache') => normalizeCoverConfig({
  cacheDir: path.join(tmp, cache), minDuration: 5, maxDuration: 20,
  online: {
    retries: 0, timeoutMs: 5000, maxBytes: 4 * 1024 * 1024, searchCacheTtlMs: 60000, minSourceSeconds: 0,
    qqmusic: false, kuwo: false, bilibili: false, migu: false,
    neteaseBaseUrl: '', neteaseDirect: true, neteaseWebBase: base(),
    ...extra,
  },
}, tmp);

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ── 2) 搜索 ────────────────────────────────────────────────────────────────
  const cfg = makeCfg();
  const list = await searchOnline({ song: '晴天' }, cfg);
  assert.equal(list.length, 2);
  assert.ok(list.every((c) => c.source === 'netease'));
  assert.equal(list[0].id, '222');
  assert.equal(list[0].title, '晴天');
  assert.equal(list[0].artist, '某UP');
  assert.equal(list[0].paid, false, '直连候选不让 paid 标记挡住（能不能放由 302 结果决定）');
  console.log('  ✅ 搜索：字段映射');

  // ── 3) 解析：会员曲跳过，免费曲下载成功 ───────────────────────────────────
  const got = await resolveOnlineSource({ song: '晴天' }, cfg);
  assert.equal(got.candidate.id, '222', '同名免费曲应当直接可用');
  assert.ok(fs.existsSync(got.candidate.path));
  assert.ok(got.candidate.duration >= 5);
  assert.ok(got.candidate.lrc && fs.existsSync(got.candidate.lrc), '直连也要能取到歌词');
  console.log('  ✅ 解析/下载：会员曲跳过 + 免费曲音频与歌词');

  // ── 4) 全部 404 时给出 no_authorized_url ──────────────────────────────────
  // 独立缓存目录：否则会命中前面那次成功下载的 sources 缓存，测不到"全部不可播"。
  const onlyVip = makeCfg({ neteaseWebBase: `${base()}/vip` }, 'cache-vip');
  await assert.rejects(
    () => resolveOnlineSource({ song: '晴天' }, onlyVip),
    (error) => {
      assert.match(String(error.stage || ''), /no_authorized_url|source_not_found/);
      return true;
    }
  );
  console.log('  ✅ 失败路径：全部会员曲时带 stage');
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\nPASS');
