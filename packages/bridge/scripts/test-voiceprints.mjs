#!/usr/bin/env node
// 声纹库单元测试：临时目录，不碰真实 data/voiceprints。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceprintStore, voiceprintId } from '../src/voiceprints.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voiceprints-'));
const store = new VoiceprintStore({ root, log: () => {} });
const vec = (seed) => {
  const a = new Float32Array(192);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin((i + 1) * seed) + (i % 7 === 0 ? 0.2 : 0);
  return [...a];
};
const zhang = vec(1.7);
const li = vec(2.9);
const pcm = Buffer.alloc(32000);
for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 9) * 3000), i);

try {
  const id = voiceprintId({ name: '张三' });
  assert.match(id, /^name_[a-f0-9]{12}$/);
  const qqId = voiceprintId({ name: '张三', qq: '12345678' });
  assert.equal(qqId, 'qq_12345678');

  const a = store.enroll({ name: '张三', qq: '12345678', centroid: zhang, samples: 1, source: 'call', samplePcm: pcm });
  assert.equal(a.id, 'qq_12345678');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].hasSample, true);
  assert.ok(store.samplePath(a.id) && fs.existsSync(store.samplePath(a.id)));
  const wav = fs.readFileSync(store.samplePath(a.id));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', '试听样本应是 WAV');

  const hit = store.match(zhang, { threshold: 0.72, margin: 0.05 });
  assert.ok(hit, '同一向量应命中');
  assert.equal(hit.id, a.id);
  assert.ok(hit.score > 0.99);

  store.enroll({ name: '李四', centroid: li, samples: 1, source: 'manual' });
  assert.equal(store.list().length, 2);
  assert.equal(store.match(li).name, '李四');
  assert.equal(store.match(zhang).name, '张三');

  const near = zhang.map((v) => v + 0.001);
  const again = store.enroll({ name: '张三', qq: '12345678', centroid: near, samples: 1 });
  assert.equal(again.samples, 2, '同 QQ 应做 few-shot 合并');
  assert.equal(store.list().length, 2, '合并后不应多一条');

  store.rename(a.id, '张三丰');
  assert.equal(store.get(a.id).name, '张三丰');
  assert.throws(() => store.rename(a.id, '李四'), /已被/, '重名应拒绝');

  store.remove(a.id);
  assert.equal(store.get(a.id), null);
  assert.equal(store.list().length, 1);
  console.log('  ✅ voiceprints：注册/试听样本/匹配/合并/重命名/删除');

  console.log('\nPASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
