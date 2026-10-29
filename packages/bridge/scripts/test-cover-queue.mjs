import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShortCoverService } from '../src/short-cover/manager-v2.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-q-'));
const lib = path.join(tmp, 'library');
fs.mkdirSync(lib, { recursive: true });
fs.writeFileSync(path.join(lib, 'Artist - Song.wav'), '');
const accepted = []; const audio = []; const text = [];
const config = {
  cover: {
    enabled: true, libraryDir: lib, cacheDir: path.join(tmp, 'cache'), tempDir: path.join(tmp, 'tmp'),
    queueFile: path.join(tmp, 'queue.json'), refAudio: path.join(tmp, 'missing-ref.wav'),
    maxQueue: 2, maxPerKey: 2, minFreeMb: 1,
    online: { enabled: false },
  },
  singing: {},
};
let calls = 0;
const svc = createShortCoverService({
  getConfig: () => config,
  root: tmp,
  pipeline: async ({ workDir, query }) => {
    calls++;
    await new Promise((r) => setTimeout(r, query.duration === 13 ? 120 : 30));
    const file = path.join(workDir, 'final.mp3');
    fs.writeFileSync(file, Buffer.alloc(4096, 1));
    return { file, buffer: fs.readFileSync(file), ext: 'mp3', mime: 'audio/mpeg', seconds: query.duration, window: { start: 10, duration: query.duration } };
  },
  onAccepted: (_key, info) => accepted.push(info),
  onAudio: (_key, r) => audio.push(r.song.title + ':' + r.seconds),
  onText: (_key, t) => text.push(t),
});
const a = await svc.start({ song: 'Song', duration: 15 }, 'group:1');
const b = await svc.start({ song: 'Song', duration: 13 }, 'group:1');
assert.equal(a.status, 'queued');
assert.equal(b.status, 'queued');
assert.equal(accepted.length, 2, '每个 accepted 任务必须有立即回执');
assert.equal(accepted[0].position, 1);
assert.equal(accepted[1].position, 2);
for (let i = 0; i < 100 && (svc.getJob(a.jobId)?.status !== 'done' || svc.getJob(b.jobId)?.status !== 'done'); i++) await new Promise((r) => setTimeout(r, 20));
assert.equal(svc.getJob(a.jobId)?.status, 'done');
assert.equal(svc.getJob(b.jobId)?.status, 'done');
assert.deepEqual(audio, ['Song:15', 'Song:13'], '同一群的结果必须按请求顺序发送');
assert.equal(calls, 2);
const c = await svc.start({ song: 'Song', duration: 15 }, 'group:1');
assert.equal(c.status, 'queued');
for (let i = 0; i < 50 && svc.getJob(c.jobId)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(svc.getJob(c.jobId)?.cached, true, '相同参数应命中缓存');
assert.equal(calls, 2, '缓存命中不应重跑模型');
// Per-key admission is bounded; an accepted job is never silently dropped.
config.cover.maxPerKey = 1;
const d = await svc.start({ song: 'Song', duration: 16 }, 'group:1');
await assert.rejects(() => svc.start({ song: 'Song', duration: 17 }, 'group:1'), (e) => e.stage === 'busy');
for (let i = 0; i < 80 && svc.getJob(d.jobId)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
assert.ok(fs.existsSync(path.join(tmp, 'queue.json')), '排队任务应写入持久化队列');
// A queued job written before a process restart must be resumed, not lost.
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-restore-'));
const lib2 = path.join(tmp2, 'library');
fs.mkdirSync(lib2, { recursive: true });
fs.writeFileSync(path.join(lib2, 'Artist - Song.wav'), '');
const queue2 = path.join(tmp2, 'queue.json');
fs.writeFileSync(queue2, JSON.stringify({ version: 1, nextSeq: { 'group:2': 1 }, jobs: [{
  id: 'restored-job', key: 'group:2', seq: 1, query: { song: 'Song', artist: '', version: '', duration: 15, segment: 'chorus', start_time: null },
  status: 'queued', stage: 'queued', title: 'Song', candidate: null, createdAt: Date.now(), sent: false,
}] }));
const restored = [];
const cfg2 = { cover: { enabled: true, libraryDir: lib2, cacheDir: path.join(tmp2, 'cache'), tempDir: path.join(tmp2, 'tmp'), queueFile: queue2, refAudio: path.join(tmp2, 'missing-ref.wav'), maxQueue: 10, maxPerKey: 2, minFreeMb: 1, online: { enabled: false } }, singing: {} };
const svc2 = createShortCoverService({ getConfig: () => cfg2, root: tmp2, pipeline: async ({ workDir }) => {
  const f = path.join(workDir, 'f.mp3'); fs.writeFileSync(f, Buffer.alloc(4096, 1));
  return { file: f, buffer: fs.readFileSync(f), ext: 'mp3', mime: 'audio/mpeg', seconds: 15, window: { start: 1, duration: 15 } };
}, onAudio: (_k, r) => restored.push(r), onText: () => {} });
for (let i = 0; i < 80 && !restored.length; i++) await new Promise((r) => setTimeout(r, 20));
assert.equal(restored.length, 1, '重启后 queued 任务应恢复并发送');
console.log('cover queue tests passed');
svc.status(); svc2.status();
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
