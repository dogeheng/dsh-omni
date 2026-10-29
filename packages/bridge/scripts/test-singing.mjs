import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSingingService, normalizeSingingConfig } from '../src/singing.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-singing-'));
const root = path.join(tmp, 'bridge');
const refDir = path.join(root, 'data', 'voice');
const songDir = path.join(root, 'data', 'singing', 'songs', '雨爱');
fs.mkdirSync(refDir, { recursive: true });
fs.mkdirSync(songDir, { recursive: true });

function wav(seconds = 1, sr = 44100) {
  const n = Math.round(seconds * sr);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const ref = path.join(refDir, 'dsh-ref.wav');
const vocal = path.join(songDir, 'vocal.wav');
fs.writeFileSync(ref, wav(1));
fs.writeFileSync(vocal, wav(1));
fs.writeFileSync(path.join(songDir, 'instrumental.wav'), wav(1));
fs.writeFileSync(path.join(songDir, 'meta.json'), JSON.stringify({ title: '雨爱' }));

// 假 Python：忽略真实推理，把源音频复制成 Seed-VC 会生成的 wav。
const fake = path.join(tmp, 'fake-python.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
// F0_ori.astype(np.float32) (fixture: pretend the MPS patch is applied)
import fs from 'node:fs';
import path from 'node:path';
let out = '';
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--output') out = process.argv[i + 1];
if (!out) process.exit(2);
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(process.env.FAKE_SOURCE_WAV, path.join(out, 'vc_fake.wav'));
`);
fs.chmodSync(fake, 0o755);
process.env.FAKE_SOURCE_WAV = vocal;

const raw = {
  enabled: true,
  pythonPath: fake,
  seedVcDir: tmp,
  inferenceScript: fake,
  refAudio: ref,
  songsDir: path.dirname(songDir),
  maxSeconds: 5,
  maxRssMb: 5600,
  minFreeMb: 100,
  diffusionSteps: 20,
  timeoutMs: 120000,
  maxQueue: 1,
  cooldownMs: 0,
};
const svc = createSingingService({ getConfig: () => raw, root, log: () => {} });

const norm = normalizeSingingConfig(raw, root);
assert.equal(norm.enabled, true);
assert.equal(norm.maxSeconds, 5);
assert.equal(norm.diffusionSteps, 20);
assert.equal(norm.engine, 'seed-vc');

const songs = svc.songs();
assert.equal(songs.length, 1);
assert.equal(songs[0].title, '雨爱');

const st = svc.status();
assert.equal(st.engineStatus.ok, true);
assert.equal(st.engineStatus.songs, 1);
assert.equal(st.running, false);

const result = await svc.sing('雨爱', { maxSeconds: 5 });
assert.equal(result.ext, 'mp3');
assert.ok(result.buffer.length > 1000);
assert.ok(result.seconds > 0 && result.seconds <= 6, `seconds=${result.seconds}`);
assert.equal(result.song.title, '雨爱');
console.log('singing service test passed', { seconds: result.seconds, peakRssMb: result.peakRssMb, elapsedMs: result.elapsedMs });

const blocked = createSingingService({ getConfig: () => ({ ...raw, minFreeMb: 999999 }), root, log: () => {} });
await assert.rejects(() => blocked.sing('雨爱'), /可用内存不足/);

fs.rmSync(tmp, { recursive: true, force: true });
