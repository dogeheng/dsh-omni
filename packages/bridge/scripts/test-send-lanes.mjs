// 回归：QQ 发送队列必须**按会话**隔离，不能一条全局链。
//
// 事故形态：语音 / 图片 / 表情 / 分条 / MCP 文本发送都挂在同一个 sendChain 上（只有
// 文本和合成语音走了按会话的 lane）。于是 A 群发一条要转码 60s 的语音、或一串带
// 5~10s 间隔的分条消息时，B/C 群的回复全部排在后面 —— 日志里就是"别的群也突然哑了"。
//
// 用例设计：两个群都用**分条发送**（旧实现两者共用全局链，新实现各走各的 lane）。
// 群 456 的一串消息占住约 2 个间隔的时间；期间群 789 的一条消息必须立刻发出去，
// 并且插在 456 的分条中间，而不是等它整串发完。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness({
  config: {
    allow: { private: ['123'], groups: ['456', '789'] },
    sendDelayMs: 0,
  },
});

try {
  const gapMs = 300;
  const burst = h.sendBurstToQQ('group:456', ['一', '二', '三'], {
    burstIntervalMinMs: gapMs,
    burstIntervalMaxMs: gapMs,
  });

  // 让 456 先发出第一条，进入条间间隔。
  await new Promise((resolve) => setTimeout(resolve, 30));

  const started = Date.now();
  await h.sendBurstToQQ('group:789', ['别的群的话'], { burstIntervalMinMs: 0, burstIntervalMaxMs: 0 });
  const waited = Date.now() - started;
  assert.ok(
    waited < 200,
    `另一个群被分条发送拖住了 ${waited}ms（全局 sendChain 的典型症状；456 的分条总时长约 ${gapMs * 2}ms）`,
  );

  await burst;

  const sent = h.calls.sent.map((entry) => `${entry.id}:${entry.text}`);
  assert.deepEqual(sent.filter((line) => line.startsWith('456:')), ['456:一', '456:二', '456:三'], '同一会话内顺序必须不变');
  const at789 = sent.indexOf('789:别的群的话');
  const last456 = sent.lastIndexOf('456:三');
  assert.ok(at789 > 0, '另一个群的消息应该真的发出去了');
  assert.ok(at789 < last456, '另一个群的消息应插在分条之间，而不是等整串发完');

  // 同一会话内，不同发送路径（文本 / 分条）也必须串行，不然会出现"先文字后分条"乱序。
  h.calls.sent.length = 0;
  await Promise.all([
    h.sendToQQ('group:456', '先'),
    h.sendBurstToQQ('group:456', ['后一', '后二'], { burstIntervalMinMs: 5, burstIntervalMaxMs: 5 }),
  ]);
  const sameKey = h.calls.sent.map((entry) => `${entry.id}:${entry.text}`).filter((line) => line.startsWith('456:'));
  assert.deepEqual(sameKey, ['456:先', '456:后一', '456:后二'], '同一会话的并发发送要按调用顺序串行');

  console.log('send lanes: ok');
} finally {
  await h.close();
}
