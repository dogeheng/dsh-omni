#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseSpeakerBinding } from '../src/call-voice-binding.js';

const cases = [
  ['刚才说话的是张三', { name: '张三' }],
  ['刚才说话的是张三。', { name: '张三' }],
  ['说话人2是李四', { name: '李四', speakerIndex: 2 }],
  ['S3是王五', { name: '王五', speakerIndex: 3 }],
  ['记一下，说话人2是李四', { name: '李四', speakerIndex: 2 }],
  ['记一下，张三', { name: '张三' }],
  ['刚才说话的是谁', null],
  ['刚才说话的是不是张三', null],
  ['今天天气不错', null],
  ['张三刚才说话了吗', null]
];
for (const [text, expected] of cases) {
  const got = parseSpeakerBinding(text);
  assert.deepEqual(got, expected, `${text} -> ${JSON.stringify(got)}`);
}
console.log('  ✅ 绑定句式解析：明确句式命中 / 疑问句不误触发');
console.log('\nPASS');
