#!/usr/bin/env node
// SpeakerTracker + 声纹匹配测试：用四说话人样本的真实 embedding。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseWav } from '../src/voice-asr.js';
import { SpeakerTracker } from '../src/speaker-tracker.js';

const require = createRequire(import.meta.url);
const MODEL = 'data/models/speaker/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';
const WAV = '/tmp/0-four-speakers-zh.wav';
if (!fs.existsSync(MODEL) || !fs.existsSync(WAV)) {
  console.log('SKIP：缺少模型或四说话人样本（先 npm run setup:speaker，样本见测试说明）');
  process.exit(0);
}
const sherpa = require('sherpa-onnx-node');
const wav = parseWav(fs.readFileSync(WAV));
const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 1 });
const embedding = (a, b) => {
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples: wav.samples.slice(Math.floor(a * 16000), Math.floor(b * 16000)) });
  return extractor.compute(stream);
};

const speakerA = embedding(0.4, 5.5);
const record = { id: 'qq_10001', name: '测试甲', qq: '10001', centroid: [...speakerA] };
const tracker = new SpeakerTracker({ modelPath: MODEL, voiceprints: [record], log: () => {} });
try {
  const first = await tracker.assign(wav.samples.slice(Math.floor(0.4 * 16000), Math.floor(5.5 * 16000)));
  assert.ok(first, '应识别出说话人');
  assert.equal(first.name, '测试甲', '已知声纹应命中');
  assert.equal(first.label, '测试甲', '命中后 label 直接用名字（1:1 也能认）');
  assert.equal(first.qq, '10001');

  const second = await tracker.assign(wav.samples.slice(Math.floor(7.0 * 16000), Math.floor(10.0 * 16000)));
  assert.ok(second);
  assert.equal(second.name, null, '第二个未知说话人不应被误认');
  assert.equal(second.label, '说话人2', '未知说话人保持匿名标签');
  assert.equal(tracker.getCentroid('S1').length, 192);
  assert.equal(tracker.setName('S2', '测试乙', ''), true);
  assert.equal(tracker.snapshot()[1].name, '测试乙');
  console.log('  ✅ 声纹命中姓名 / 未知保持匿名 / setName / centroid');
  console.log('\nPASS');
} finally {
  tracker.close();
}
