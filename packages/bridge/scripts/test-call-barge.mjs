#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isBackchannel } from '../src/call-barge.js';

const yes = ['嗯', '嗯嗯。', '对', '对对', '好', '好的', '是', '是的', '哦', '行', '可以', '收到', '明白', 'ok', 'OK'];
const no = ['等等', '不是', '你先听我说', '对，但是我觉得不行', '嗯？你刚才说什么', '好，那你继续', ''];
for (const text of yes) assert.equal(isBackchannel(text, 0.8), true, `应识别为应声：${text}`);
for (const text of no) assert.equal(isBackchannel(text, 0.8), false, `不应识别为应声：${text}`);
assert.equal(isBackchannel('嗯', 2.0), false, '超过 1.4s 不算应声');
console.log('  ✅ 应声判定：嗯/对/好/收到；等等/不是/长句不误判；时长限制');
console.log('\nPASS');
