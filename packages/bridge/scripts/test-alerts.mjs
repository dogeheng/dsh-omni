// 站外告警：QQ 发不出消息时，用 macOS 通知 / webhook 通知操作者。
//
// 这里用注入的 fetch / execFile 与假时钟验证分发逻辑，不会真的弹通知、也不发网络请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAlertDispatcher, normalizeAlertConfig, appleScriptString, ALERT_EVENTS } from '../src/alerts.js';

// 1) 归一化：默认安全（关闭、无地址），非法通道/头被过滤，数值被夹紧
{
  const cfg = normalizeAlertConfig({});
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.channels, ['macos']);
  assert.equal(cfg.webhook.url, '');
  assert.equal(cfg.minIntervalMs, 10 * 60 * 1000);
  assert.equal(cfg.maxPerHour, 12);
  assert.equal(ALERT_EVENTS.every((e) => typeof cfg.events[e] === 'boolean'), true, '每个事件都有布尔默认值');

  const messy = normalizeAlertConfig({
    enabled: true,
    channels: ['macos', 'telegram', 'webhook', 'webhook'],
    webhook: { url: ' https://example.invalid/hook ', headers: { 'X-Token': 't', 'bad header': 'x', ok: 42 } },
    minIntervalMs: -5,
    maxPerHour: 9999,
    events: { startup: true, gatewayDown: 'yes' },
  });
  assert.deepEqual(messy.channels, ['macos', 'webhook'], '未知识别通道被过滤、重复去掉');
  assert.equal(messy.webhook.url, 'https://example.invalid/hook');
  assert.deepEqual(messy.webhook.headers, { 'X-Token': 't' }, '非法头名/非字符串值被丢弃');
  assert.equal(messy.minIntervalMs, 0);
  assert.equal(messy.maxPerHour, 100);
  assert.equal(messy.events.startup, true);
  assert.equal(messy.events.gatewayDown, true, '非布尔值回落到默认（该事件默认开）');
  console.log('  ✅ 归一化：默认安全 / 通道与请求头过滤 / 数值夹紧');
}

// 2) AppleScript 转义
assert.equal(appleScriptString('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
console.log('  ✅ AppleScript 字符串转义');

// 3) 关闭时什么都不做
{
  const calls = [];
  const d = createAlertDispatcher({
    config: { enabled: false },
    execFileImpl: (...a) => calls.push(a),
    fetchImpl: () => { throw new Error('不该被调用'); },
  });
  const r = await d.notify({ event: 'gatewayDown', title: 't', message: 'm' });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'disabled');
  assert.equal(calls.length, 0);
  console.log('  ✅ 未启用时不动作');
}

// 4) macOS 通道：只在 darwin 上发，脚本里带标题正文
{
  const calls = [];
  const d = createAlertDispatcher({
    config: { enabled: true, channels: ['macos'], events: { gatewayDown: true } },
    platform: 'darwin',
    execFileImpl: (file, args, opts, cb) => { calls.push({ file, args }); cb(null); },
  });
  const r = await d.notify({ event: 'gatewayDown', title: '标题"引号"', message: '正文\n换行' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'osascript');
  const script = calls[0].args[1];
  assert.match(script, /display notification/);
  assert.match(script, /标题\\"引号\\"/, '标题里的引号要转义');
  assert.match(script, /正文\\n换行/);

  const linux = createAlertDispatcher({
    config: { enabled: true, channels: ['macos'], events: { gatewayDown: true } },
    platform: 'linux',
    execFileImpl: () => { throw new Error('不该被调用'); },
  });
  const lr = await linux.notify({ event: 'gatewayDown', title: 't' });
  assert.equal(lr.ok, false, '非 macOS 上 macOS 通道不可用');
  assert.match(String(lr.channels[0].error), /darwin/);
  console.log('  ✅ macOS 通道：darwin 才发、引号与换行已转义');
}

// 5) webhook 通道：POST JSON、带头、非 2xx 只记失败不抛
{
  const requests = [];
  const logs = [];
  const d = createAlertDispatcher({
    config: {
      enabled: true, channels: ['webhook'], minIntervalMs: 0,
      webhook: { url: 'https://ntfy.invalid/topic', headers: { 'X-Token': 'abc' }, timeoutMs: 3000 },
      events: { gatewayDown: true },
    },
    logger: (...a) => logs.push(a.join(' ')),
    fetchImpl: async (url, init) => { requests.push({ url, init }); return { ok: true, status: 200 }; },
  });
  const r = await d.notify({ event: 'gatewayDown', title: '标题', message: '正文' });
  assert.equal(r.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://ntfy.invalid/topic');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['X-Token'], 'abc');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.event, 'gatewayDown');
  assert.equal(body.title, '标题');
  assert.equal(body.message, '正文');
  assert.equal(body.source, 'dsh-omni');
  assert.ok(body.at);

  const failing = createAlertDispatcher({
    config: { enabled: true, channels: ['webhook'], minIntervalMs: 0, webhook: { url: 'https://x.invalid' }, events: { gatewayDown: true } },
    logger: (...a) => logs.push(a.join(' ')),
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  const fr = await failing.notify({ event: 'gatewayDown', title: 'x' });
  assert.equal(fr.ok, false);
  assert.match(String(fr.channels[0].error), /502/);
  assert.ok(logs.some((l) => l.includes('发送失败')), '失败要记日志');
  console.log('  ✅ webhook：请求形状正确、失败只记日志不抛');
}

// 6) 节流：同事件最小间隔 + 每小时总量上限
{
  let t = 1_000_000;
  const sent = [];
  const d = createAlertDispatcher({
    config: { enabled: true, channels: ['webhook'], minIntervalMs: 60_000, maxPerHour: 2, webhook: { url: 'https://x.invalid' }, events: { sleep: true, gatewayDown: true } },
    now: () => t,
    fetchImpl: async () => { sent.push(t); return { ok: true, status: 200 }; },
  });
  assert.equal((await d.notify({ event: 'sleep', title: 'a' })).ok, true);
  const again = await d.notify({ event: 'sleep', title: 'a' });
  assert.equal(again.skipped, 'interval', '同一事件在最小间隔内要跳过');
  t += 61_000;
  assert.equal((await d.notify({ event: 'sleep', title: 'a' })).ok, true);
  t += 61_000;
  const capped = await d.notify({ event: 'gatewayDown', title: 'b' });
  assert.equal(capped.skipped, 'hourly', '每小时总量上限要生效');
  assert.equal(sent.length, 2);
  console.log('  ✅ 节流：同事件最小间隔 + 每小时上限');
}

// 7) 事件开关与未知事件
{
  const d = createAlertDispatcher({
    config: { enabled: true, channels: ['webhook'], minIntervalMs: 0, webhook: { url: 'https://x.invalid' }, events: { sleep: false } },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal((await d.notify({ event: 'sleep', title: 'x' })).skipped, 'event-off');
  assert.equal((await d.notify({ event: 'nope', title: 'x' })).skipped, 'unknown-event');
  console.log('  ✅ 事件开关 / 未知事件');
}

// 8) 接线契约：bridge 必须在四个真实故障点调用 notify
{
  const bridge = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');
  for (const event of ['gatewayDown', 'qqOffline', 'upstreamDegraded', 'sleep', 'dshDown', 'startup']) {
    assert.match(bridge, new RegExp(`event: '${event}'`), `bridge 缺少 ${event} 的告警接线`);
  }
  assert.match(bridge, /createAlertDispatcher\(\{/, 'bridge 必须真的创建分发器');
  console.log('  ✅ 接线契约：6 个事件都在真实故障点接了告警');
}

console.log('\nPASS');
