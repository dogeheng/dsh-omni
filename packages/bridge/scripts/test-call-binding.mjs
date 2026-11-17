#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseSpeakerBinding } from '../src/call-voice-binding.js';

const cases = [
  ['刚才说话的是张三', { action: 'bind', name: '张三' }],
  ['刚才说话的是张三。', { action: 'bind', name: '张三' }],
  ['说话人2是李四', { action: 'bind', name: '李四', speakerIndex: 2 }],
  ['S3是王五', { action: 'bind', name: '王五', speakerIndex: 3 }],
  ['记一下，说话人2是李四', { action: 'bind', name: '李四', speakerIndex: 2 }],
  ['记一下，张三', { action: 'bind', name: '张三' }],
  ['记住我的声线', { action: 'bind', self: true }],
  ['记住我的声音', { action: 'bind', self: true }],
  ['刚才说话的是谁', null],
  ['刚才说话的是不是张三', null],
  ['今天天气不错', null],
  ['张三刚才说话了吗', null],
  // 认错了可以当场纠：取消 / 改正
  ['刚才说话的不是张三', { action: 'unbind', name: '张三' }],
  ['我说错了，刚才说话的不是张三', { action: 'unbind', name: '张三' }],
  ['不是张三，是李四', { action: 'rebind', from: '张三', name: '李四' }],
  ['刚才说话的不是张三，叫李四', { action: 'rebind', from: '张三', name: '李四' }],
  // 普通否定不能被当成改声纹（没有人名线索）
  ['不是这样', null],
  ['这个不是我说的', null]
];
for (const [text, expected] of cases) {
  const got = parseSpeakerBinding(text);
  assert.deepEqual(got, expected, `${text} -> ${JSON.stringify(got)}`);
}
console.log('  ✅ 绑定句式解析：明确句式命中 / 疑问句不误触发');
console.log('\nPASS');
