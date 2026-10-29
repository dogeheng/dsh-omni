import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCoverConfig } from '../src/short-cover/config.js';
import { searchLibrary } from '../src/short-cover/library.js';
import { chooseSegment, parseLrc } from '../src/short-cover/segment.js';
import { createShortCoverService } from '../src/short-cover/manager.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-'));
const lib = path.join(tmp, 'library');
fs.mkdirSync(lib, { recursive: true });
fs.writeFileSync(path.join(lib, '杨丞琳 - 雨爱.mp3'), '');
fs.writeFileSync(path.join(lib, '杨丞琳 - 雨爱 (司凤版).mp3'), '');
fs.writeFileSync(path.join(lib, '周杰伦 - 青花瓷.mp3'), '');
fs.writeFileSync(path.join(lib, '杨丞琳 - 雨爱.lrc'), '[00:10.00]第一句\n[00:30.00]副歌一句\n[00:45.00]副歌一句\n[01:00.00]副歌一句\n[01:20.00]结尾\n');
const cfg = normalizeCoverConfig({ libraryDir: lib, cacheDir: path.join(tmp, 'cache'), tempDir: path.join(tmp, 'tmp'), refAudio: path.join(tmp, 'missing-ref.wav'), pythonPath: '/no/python' }, tmp, {});
assert.equal(cfg.defaultDuration, 15);
assert.equal(cfg.minDuration, 10);
assert.equal(cfg.maxDuration, 20);

const normal = searchLibrary({ song: '雨爱' }, lib);
assert.ok(normal.length >= 2);
assert.ok(normal.some((c) => /司凤/.test(c.tags.join(' '))));
const versioned = searchLibrary({ song: '雨爱', version: '司凤版' }, lib);
assert.ok(versioned.length >= 1);
assert.ok(/司凤/.test(versioned[0].tags.join(' ')), '指定版本必须优先匹配');

const lines = parseLrc(fs.readFileSync(path.join(lib, '杨丞琳 - 雨爱.lrc'), 'utf8'));
assert.equal(lines.length, 5);
const candidate = { title: '雨爱', artist: '杨丞琳', version: '', tags: [], duration: 180, lrc: path.join(lib, '杨丞琳 - 雨爱.lrc'), stems: {}, segments: [] };
const windowNullStart = await chooseSegment({ source: path.join(lib, '杨丞琳 - 雨爱.mp3'), candidate, query: { song: '雨爱', duration: 10, segment: 'chorus', start_time: null }, cfg });
assert.ok(windowNullStart.start > 0, 'start_time=null 不应被当成 0 秒');
assert.match(windowNullStart.reason, /lrc/);
const window = await chooseSegment({ source: path.join(lib, '杨丞琳 - 雨爱.mp3'), candidate, query: { song: '雨爱', duration: 10, segment: 'chorus' }, cfg });
assert.ok(window.start > 0, '不应从 0 秒直接开始');
assert.ok(window.duration >= 10 && window.duration <= 20);
assert.match(window.reason, /lrc/);

const empty = path.join(tmp, 'empty');
fs.mkdirSync(empty);
const svc = createShortCoverService({ getConfig: () => ({ cover: { libraryDir: empty, cacheDir: path.join(tmp, 'cache2'), tempDir: path.join(tmp, 'tmp2'), refAudio: path.join(tmp, 'missing-ref.wav') }, singing: {} }), root: tmp });
await assert.rejects(() => svc.start({ song: '不存在的歌' }, 'group:1'), (e) => e.stage === 'source_not_found');
const sends = [];
let fakeCalls = 0;
const asyncSvc = createShortCoverService({
  getConfig: () => ({ cover: { enabled: true, libraryDir: lib, cacheDir: path.join(tmp, 'cache3'), tempDir: path.join(tmp, 'tmp3'), refAudio: path.join(tmp, 'missing-ref.wav') }, singing: {} }),
  root: tmp,
  pipeline: async ({ workDir }) => {
    fakeCalls++;
    const file = path.join(workDir, 'final.mp3');
    fs.writeFileSync(file, Buffer.alloc(4096, 1));
    return { file, buffer: fs.readFileSync(file), ext: 'mp3', mime: 'audio/mpeg', seconds: 10, window: { start: 30, duration: 10, reason: 'test' }, separatedBy: 'mock' };
  },
  onAudio: async (_key, r) => { sends.push(r); },
});
const started = await asyncSvc.start({ song: '雨爱', duration: 10 }, 'group:1');
assert.equal(started.status, 'queued');
for (let i = 0; i < 50 && (asyncSvc.getJob(started.jobId)?.status !== 'done'); i++) await new Promise((r) => setTimeout(r, 20));
assert.equal(asyncSvc.getJob(started.jobId)?.status, 'done');
assert.equal(sends.length, 1);
assert.equal(fakeCalls, 1);
const cached = await asyncSvc.start({ song: '雨爱', duration: 10 }, 'group:1');
assert.equal(cached.status, 'cached');
assert.equal(sends.length, 2);
assert.equal(fakeCalls, 1);
const oldCache = path.join(tmp, 'cache3', 'old-preview.mp3');
fs.mkdirSync(path.dirname(oldCache), { recursive: true });
fs.writeFileSync(oldCache, Buffer.alloc(2048, 1));
const oldTime = new Date(Date.now() - 8 * 86400000);
fs.utimesSync(oldCache, oldTime, oldTime);
await asyncSvc.start({ song: '雨爱', duration: 10 }, 'group:1');
assert.equal(fs.existsSync(oldCache), false, '超过 TTL 的缓存应被回收');
const bridgeSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'bridge.js'), 'utf8');
assert.ok(bridgeSrc.includes("url.pathname === '/api/socialV2/cover'"), '缺少 cover 路由');
assert.ok(bridgeSrc.includes('startCoverForV2'), '缺少 startCoverForV2');
assert.ok(bridgeSrc.includes('upload_group_file') && bridgeSrc.includes('upload_private_file'), '缺少 QQ 文件兜底');
assert.ok(bridgeSrc.includes('cleanupTtsArtifacts'), '缺少 TTS 试听回收');
const mcpSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'mcp-snowluma-safe.js'), 'utf8');
assert.ok(mcpSrc.includes("'sing_short_cover'"), '缺少 sing_short_cover 工具');
assert.ok(mcpSrc.includes("sing_short_cover: 'sing'"), '缺少 sing_short_cover 工具开关');
console.log('short cover unit tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
