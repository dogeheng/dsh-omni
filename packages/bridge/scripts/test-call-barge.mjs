#!/usr/bin/env node
// 通话打断判定：应声识别 + "开口时该不该取消这一轮" + 提前打断阈值。
//
// 这些是纯函数，不接麦、不跑 ASR；真正的音频链路在通话里验证。
import assert from 'node:assert/strict';
import {
  isBackchannel,
  decideSpeechStartBarge,
  resolveEarlyBargeMs,
  DEFAULT_EARLY_BARGE_MS,
  MIN_EARLY_BARGE_MS,
} from '../src/call-barge.js';
import { normalizeCallConfig } from '../src/call-config.js';

const yes = ['嗯', '嗯嗯。', '对', '对对', '好', '好的', '是', '是的', '哦', '行', '可以', '收到', '明白', 'ok', 'OK'];
const no = ['等等', '不是', '你先听我说', '对，但是我觉得不行', '嗯？你刚才说什么', '好，那你继续', ''];
for (const text of yes) assert.equal(isBackchannel(text, 0.8), true, `应识别为应声：${text}`);
for (const text of no) assert.equal(isBackchannel(text, 0.8), false, `不应识别为应声：${text}`);
assert.equal(isBackchannel('嗯', 2.0), false, '超过 1.4s 不算应声');
console.log('  ✅ 应声判定：嗯/对/好/收到；等等/不是/长句不误判；时长限制');

// 该不该取消在途回合
assert.equal(decideSpeechStartBarge({ speaking: false, thinking: false }), 'none', '没在说也没在想：正常收一句');
assert.equal(decideSpeechStartBarge({ speaking: false, thinking: true }), 'queue', '思考中开口：让这一轮答完，这句排队（不能取消）');
assert.equal(decideSpeechStartBarge({ speaking: true, thinking: true, softBarge: true }), 'wait', '正在出声 + 软打断：先等 ASR 判断');
assert.equal(decideSpeechStartBarge({ speaking: true, thinking: false, softBarge: false }), 'cancel', '正在出声 + 关闭软打断：开口即打断');
assert.equal(decideSpeechStartBarge({ speaking: true, thinking: true, softBarge: false }), 'cancel', '出声优先于思考');
console.log('  ✅ 打断决策：思考中排队不取消；出声时按软打断开关走');

// 提前打断阈值：默认 1200，低于 ASR 往返下限的配置被抬到 900，0 = 关闭
assert.equal(DEFAULT_EARLY_BARGE_MS, 1200);
assert.equal(MIN_EARLY_BARGE_MS, 900);
assert.equal(resolveEarlyBargeMs(undefined), 1200, '未配置用默认值');
assert.equal(resolveEarlyBargeMs('abc'), 1200, '非法值用默认值');
assert.equal(resolveEarlyBargeMs(0), 0, '0 表示关闭');
assert.equal(resolveEarlyBargeMs(-5), 0, '负数等于关闭');
assert.equal(resolveEarlyBargeMs(600), 900, '600ms 赶在 ASR 之前烧掉，抬到下限');
assert.equal(resolveEarlyBargeMs(1500), 1500, '正常值原样保留');
console.log('  ✅ 提前打断阈值：默认 1200 / 下限 900 / 0 关闭');

// 配置归一化接上了上面的策略（默认值不再硬编码 600）
assert.equal(normalizeCallConfig({}).fullDuplex.earlyBargeMs, 1200, '空配置用 1200');
assert.equal(normalizeCallConfig({ fullDuplex: { earlyBargeMs: 600 } }).fullDuplex.earlyBargeMs, 900, '老配置里的 600 被抬到 900');
assert.equal(normalizeCallConfig({ fullDuplex: { earlyBargeMs: 0 } }).fullDuplex.earlyBargeMs, 0, '显式关闭仍然有效');
assert.equal(normalizeCallConfig({ fullDuplex: { earlyBargeMs: 9999 } }).fullDuplex.earlyBargeMs, 2000, '上限仍是 2000');
assert.equal(normalizeCallConfig({ fullDuplex: { softBarge: false } }).fullDuplex.softBarge, false, '软打断开关保留');
console.log('  ✅ 配置归一化：默认/下限/上限/关闭/软打断开关');

console.log('\nPASS');
