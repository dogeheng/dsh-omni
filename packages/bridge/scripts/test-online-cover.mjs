import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeCoverConfig } from '../src/short-cover/config.js';
import { resolveOnlineSource } from '../src/short-cover/online.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-online-'));
function wav(seconds = 6, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 5000), 44 + i * 2);
  return b;
}
const audio = wav();
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/audio.wav')) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(audio); return; }
  if (req.url.startsWith('/search')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { songs: [{ id: 7, name: '雨爱', ar: [{ name: '测试歌手' }], al: { name: '测试专辑' }, dt: 6000, fee: 0 }] } })); return; }
  if (req.url.startsWith('/song/url')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${server.address().port}/audio.wav` }] })); return; }
  if (req.url.startsWith('/lyric')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ lrc: { lyric: '[00:01.00]雨爱\n[00:03.00]雨爱\n' } })); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const fake = path.join(tmp, 'fake-qq.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
let s=''; process.stdin.on('data',b=>s+=b).on('end',()=>{
  const q=JSON.parse(s||'{}');
  if(q.action==='search') console.log(JSON.stringify({ok:true,results: process.env.FAKE_PAID_ONLY==='1' ? [
    {source:'qqmusic',id:'paid',mid:'paid',title:'雨爱 (司凤版)',artist:'测试',version:'司凤版',tags:['司凤版'],duration:6,pay:{payDown:1,payPlay:0,payMonth:1,priceTrack:200},preview:false,vs:''}
  ] : [
    {source:'qqmusic',id:'paid',mid:'paid',title:'雨爱 (司凤版)',artist:'测试',version:'司凤版',tags:['司凤版'],duration:6,pay:{payDown:1,payPlay:0,payMonth:1,priceTrack:200},preview:false,vs:''},
    {source:'qqmusic',id:'free',mid:'free',title:'雨爱 (司凤版)',artist:'测试',version:'司凤版',tags:['司凤版'],duration:6,pay:{payDown:0,payPlay:0,payMonth:0,priceTrack:0},preview:false,vs:''},
    {source:'qqmusic',id:'normal',mid:'normal',title:'雨爱',artist:'测试',version:'',tags:[],duration:6,pay:{payDown:0},preview:false,vs:''}
  ]}));
  else if(q.action==='lyric') console.log(JSON.stringify({ok:true,lyric:'[00:01.00]雨爱'}));
  else console.log(JSON.stringify({ok:true,url:process.env.FAKE_AUDIO_URL,ext:'wav'}));
});`);
fs.chmodSync(fake, 0o755);
process.env.FAKE_AUDIO_URL = `${base}/audio.wav`;
const mk = (extra = {}) => normalizeCoverConfig({ cacheDir: path.join(tmp, 'cache'), tempDir: path.join(tmp, 'tmp'), refAudio: path.join(tmp, 'nope.wav'), online: { enabled: true, qqmusic: true, qqmusicPython: fake, allowPaidMedia: false, previewFallback: false, ...extra } }, tmp, {});
const qv = { song: '雨爱', version: '司凤版', duration: 15 };
const cfg = mk();
const r = await resolveOnlineSource(qv, cfg, () => {});
assert.equal(r.candidate.source, 'qqmusic');
assert.equal(r.candidate.version, '司凤版');
assert.equal(r.candidate.id, 'free', '应优先使用可用的免费精确版本');
assert.ok(r.candidate.path.endsWith('.wav'));
assert.ok(r.candidate.lrc.endsWith('.lrc'));
assert.equal(r.candidate.isPreview, false);
// A paid-only exact version must fail, not fall back to the normal version.
process.env.FAKE_PAID_ONLY = '1';
fs.rmSync(path.join(tmp, 'cache', 'online-search'), { recursive: true, force: true });
const paidCfg = mk({ qqmusicPython: fake });
await assert.rejects(() => resolveOnlineSource({ song: '雨爱', version: '司凤版', duration: 15 }, paidCfg), (e) => e.stage === 'no_authorized_url');
delete process.env.FAKE_PAID_ONLY;
// Netease adapter against a local mock of NeteaseCloudMusicApi.
const nd = normalizeCoverConfig({ cacheDir: path.join(tmp, 'cache2'), tempDir: path.join(tmp, 'tmp2'), refAudio: path.join(tmp, 'nope.wav'), online: { enabled: true, qqmusic: false, neteaseBaseUrl: base, neteaseCookie: '', allowPaidMedia: false } }, tmp, {});
const nr = await resolveOnlineSource({ song: '雨爱', duration: 15 }, nd, () => {});
assert.equal(nr.candidate.source, 'netease');
assert.ok(nr.candidate.duration >= 5);
console.log('online cover tests passed');
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
