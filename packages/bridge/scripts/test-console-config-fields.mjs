#!/usr/bin/env node
// 控制台「有配置但没入口」的字段契约：真实桥接 + 真实控制台服务器 + 临时 config.json。
//
// 覆盖 /api/socialV2/config 的 GET/POST：
//   · GET 返回归一化后的 sandbox / media / session / reminders / context.catchUp / alerts；
//   · POST 接受这些段落（含非法值），合法值落盘、非法值 clamp 或回退当前值；
//   · 顶层 alerts 必须写在 config.json 的顶层，不能混进 socialV2；
//   · catchUp / wake 新开关 / initialPromptMaxChars / voice 上限 真的生效。
//
// 不碰真实 config.json：bridgeHarness 在 os.tmpdir() 里建临时根目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const MB = 1024 * 1024;
const harness = await bridgeHarness();
const server = harness.startConsoleServer();
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;
const configPath = path.join(harness.temp, 'config.json');
const readConfigFile = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        'x-console-token': 'fixture-console-token',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const getConfig = async () => {
  const response = await request('GET', '/api/socialV2/config');
  assert.equal(response.status, 200, `GET 状态码：${response.text}`);
  assert.equal(response.json?.ok, true);
  return response.json.config;
};
const postConfig = async (body) => {
  const response = await request('POST', '/api/socialV2/config', body);
  assert.equal(response.status, 200, `POST 状态码：${response.text}`);
  assert.equal(response.json?.ok, true, `POST 失败：${response.text}`);
  return response.json;
};

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; throw error; }
};

try {
  await test('GET 补全默认值：旧配置缺段落时返回归一化后的生效值', async () => {
    const config = await getConfig();
    assert.deepEqual(config.sandbox, { enabled: false, maxReadBytes: 1 * MB, maxWriteBytes: 1 * MB, maxEntries: 500 });
    assert.deepEqual(config.media, { maxBytes: 8 * MB, maxPixels: 64_000_000, maxCount: 5 });
    assert.deepEqual(config.session, {
      hotReloadPersona: false, // 夹具 config.json 里显式关了
      freshEveryTurn: false,
      retireWhenIdle: true,
      idleRetireMs: 12 * 60 * 60 * 1000,
    });
    assert.deepEqual(config.reminders, { enabled: false, listName: 'Yuki', dueMinutes: 10, notifyOwner: true });
    assert.deepEqual(config.context.catchUp, { enabled: true, gapMs: 30 * 60 * 1000, maxMessages: 12, maxChars: 800 });
    assert.equal(config.alerts.enabled, false);
    assert.deepEqual(config.alerts.channels, ['macos']);
    assert.deepEqual(config.alerts.events, {
      startup: false, gatewayDown: true, qqOffline: true, upstreamDegraded: true, sleep: true, dshDown: true,
    });
  });

  await test('POST 合法值：sandbox / media / session / reminders / catchUp / alerts 落盘', async () => {
    const response = await postConfig({
      sandbox: { enabled: true, maxReadBytes: 2 * MB, maxWriteBytes: 512 * 1024, maxEntries: 42 },
      media: { maxBytes: 4 * MB, maxPixels: 32_000_000, maxCount: 7 },
      session: { hotReloadPersona: false, freshEveryTurn: true, retireWhenIdle: false, idleRetireMs: 3 * 60 * 60 * 1000 },
      reminders: { enabled: true, listName: '工作提醒', dueMinutes: 15, notifyOwner: false },
      context: { catchUp: { enabled: false, gapMs: 90 * 60 * 1000, maxMessages: 20, maxChars: 1200 } },
      voice: { maxSeconds: 120, maxBytes: 5 * MB, maxPerMinute: 3, maxPerHour: 30, allowAbsolutePath: true },
      wake: { mediaProbability: 0.25, mediaCooldownMs: 90_000, skipEmptyReplyCheck: false, forceAnyMessage: true },
      initialPromptMaxChars: 1500,
      alerts: {
        enabled: true,
        channels: ['webhook'],
        webhook: { url: 'https://example.invalid/hook' },
        minIntervalMs: 120_000,
        maxPerHour: 5,
        events: { startup: true, gatewayDown: true, qqOffline: false, upstreamDegraded: true, sleep: false, dshDown: true },
      },
    });
    assert.equal(response.alertsRestartRequired, true, '保存 alerts 后要提示重启桥接');

    const file = readConfigFile();
    assert.deepEqual(file.socialV2.sandbox, { enabled: true, maxReadBytes: 2 * MB, maxWriteBytes: 512 * 1024, maxEntries: 42 });
    assert.deepEqual(file.socialV2.media, { maxBytes: 4 * MB, maxPixels: 32_000_000, maxCount: 7 });
    assert.deepEqual(file.socialV2.session, {
      hotReloadPersona: false, freshEveryTurn: true, retireWhenIdle: false, idleRetireMs: 3 * 60 * 60 * 1000,
    });
    assert.deepEqual(file.socialV2.reminders, { enabled: true, listName: '工作提醒', dueMinutes: 15, notifyOwner: false });
    assert.equal(file.socialV2.context.catchUp.enabled, false);
    assert.equal(file.socialV2.context.catchUp.gapMs, 90 * 60 * 1000);
    assert.equal(file.socialV2.context.catchUp.maxMessages, 20);
    assert.equal(file.socialV2.context.catchUp.maxChars, 1200);
    assert.equal(file.socialV2.initialPromptMaxChars, 1500);
    assert.equal(file.socialV2.voice.maxSeconds, 120);
    assert.equal(file.socialV2.voice.maxBytes, 5 * MB);
    assert.equal(file.socialV2.voice.maxPerMinute, 3);
    assert.equal(file.socialV2.voice.maxPerHour, 30);
    assert.equal(file.socialV2.voice.allowAbsolutePath, true);
    assert.equal(file.socialV2.wake.mediaProbability, 0.25);
    assert.equal(file.socialV2.wake.mediaCooldownMs, 90_000);
    assert.equal(file.socialV2.wake.skipEmptyReplyCheck, false);
    assert.equal(file.socialV2.wake.forceAnyMessage, true);

    // 顶层 alerts：不能落到 socialV2 里
    assert.ok(file.alerts && typeof file.alerts === 'object', 'config.json 顶层应有 alerts');
    assert.equal(file.socialV2.alerts, undefined, 'alerts 不能混进 socialV2');
    assert.equal(file.alerts.enabled, true);
    assert.deepEqual(file.alerts.channels, ['webhook']);
    assert.equal(file.alerts.webhook.url, 'https://example.invalid/hook');
    assert.equal(file.alerts.minIntervalMs, 120_000);
    assert.equal(file.alerts.maxPerHour, 5);
    assert.equal(file.alerts.webhook.timeoutMs, 8000, '未暴露的 webhook.timeoutMs 要保留默认');
    assert.deepEqual(file.alerts.events, {
      startup: true, gatewayDown: true, qqOffline: false, upstreamDegraded: true, sleep: false, dshDown: true,
    });
  });

  await test('POST 非法值：clamp 到边界或回退当前值，不抛错', async () => {
    const response = await postConfig({
      sandbox: { enabled: 'yes', maxReadBytes: 1, maxWriteBytes: 999_999_999, maxEntries: 999_999 },
      media: { maxBytes: 0, maxPixels: 1, maxCount: 0 },
      session: { idleRetireMs: 100 },
      context: { catchUp: { enabled: 'maybe', gapMs: 1000, maxMessages: 0, maxChars: 10 } },
      initialPromptMaxChars: 5,
      alerts: { channels: ['nope', 'macos'], maxPerHour: 0 },
      wake: { mediaProbability: 5, forceAnyMessage: 'yes' },
    });
    assert.equal(response.alertsRestartRequired, true, 'alerts 内容变了要提示重启桥接');
    const file = readConfigFile();
    // sandbox：enabled 非法 → 回退当前 true；字节/条目夹到边界
    assert.equal(file.socialV2.sandbox.enabled, true);
    assert.equal(file.socialV2.sandbox.maxReadBytes, 1024);
    assert.equal(file.socialV2.sandbox.maxWriteBytes, 16 * MB);
    assert.equal(file.socialV2.sandbox.maxEntries, 5000);
    // media
    assert.equal(file.socialV2.media.maxBytes, 1024);
    assert.equal(file.socialV2.media.maxPixels, 1_000_000);
    assert.equal(file.socialV2.media.maxCount, 1);
    // session：100ms 太小且不是 0 → 回退上一次合法值（3 小时）；布尔字段保留当前值
    assert.equal(file.socialV2.session.idleRetireMs, 3 * 60 * 60 * 1000);
    assert.equal(file.socialV2.session.freshEveryTurn, true);
    assert.equal(file.socialV2.session.retireWhenIdle, false);
    // catchUp：enabled 非法 → 回退当前 false；gap/messages/chars 夹到下限
    assert.equal(file.socialV2.context.catchUp.enabled, false);
    assert.equal(file.socialV2.context.catchUp.gapMs, 60_000);
    assert.equal(file.socialV2.context.catchUp.maxMessages, 1);
    assert.equal(file.socialV2.context.catchUp.maxChars, 200);
    // initialPromptMaxChars 夹到下限
    assert.equal(file.socialV2.initialPromptMaxChars, 100);
    // wake：概率夹到 1；非布尔开关回退当前 true
    assert.equal(file.socialV2.wake.mediaProbability, 1);
    assert.equal(file.socialV2.wake.forceAnyMessage, true);
    // alerts：非法通道被过滤；maxPerHour 夹到下限；其余保留当前值
    assert.deepEqual(file.alerts.channels, ['macos']);
    assert.equal(file.alerts.maxPerHour, 1);
    assert.equal(file.alerts.enabled, true);
  });

  await test('GET 回读：返回的是归一化后的落盘值（含夹紧结果）', async () => {
    const config = await getConfig();
    assert.deepEqual(config.sandbox, { enabled: true, maxReadBytes: 1024, maxWriteBytes: 16 * MB, maxEntries: 5000 });
    assert.deepEqual(config.media, { maxBytes: 1024, maxPixels: 1_000_000, maxCount: 1 });
    assert.equal(config.session.idleRetireMs, 3 * 60 * 60 * 1000);
    assert.deepEqual(config.session, {
      hotReloadPersona: false, freshEveryTurn: true, retireWhenIdle: false, idleRetireMs: 3 * 60 * 60 * 1000,
    });
    assert.deepEqual(config.reminders, { enabled: true, listName: '工作提醒', dueMinutes: 15, notifyOwner: false });
    assert.deepEqual(config.context.catchUp, { enabled: false, gapMs: 60_000, maxMessages: 1, maxChars: 200 });
    assert.equal(config.initialPromptMaxChars, 100);
    assert.equal(config.alerts.enabled, true);
    assert.deepEqual(config.alerts.channels, ['macos']);
    assert.equal(config.alerts.maxPerHour, 1);
    assert.equal(config.alerts.webhook.url, 'https://example.invalid/hook');
  });

  await test('call 段：routeTtlMs 读提交值、turnDetection 落盘、非法值回退', async () => {
    await postConfig({
      call: {
        textBridge: { enabled: true, routeOwnerOnly: true, routeTtlMs: 120_000 },
        turnDetection: { mode: 'punctuation', threshold: 0.7, continuationWindowMs: 1500, maxWaitMs: 4000 },
      },
    });
    let config = await getConfig();
    assert.equal(config.call.textBridge.routeTtlMs, 120_000, '保存 call 时不能把 routeTtlMs 覆盖回硬编码的 600000');
    assert.equal(config.call.turnDetection.mode, 'punctuation');
    assert.equal(config.call.turnDetection.threshold, 0.7);
    assert.equal(config.call.turnDetection.continuationWindowMs, 1500);
    assert.equal(config.call.turnDetection.maxWaitMs, 4000);

    // 非法值交给 normalizeCallConfig 收敛（不抛错）
    await postConfig({ call: { textBridge: { routeTtlMs: 1 }, turnDetection: { mode: 'nonsense', maxWaitMs: 1 } } });
    config = await getConfig();
    assert.equal(config.call.textBridge.routeTtlMs, 60_000);
    assert.equal(config.call.turnDetection.mode, 'smart');
    assert.equal(config.call.turnDetection.maxWaitMs, 1000);
  });

  await test('speak.pronunciations 通过配置接口落盘并回读', async () => {
    await postConfig({ speak: { pronunciations: { DSH: '滴艾斯诶尺' } } });
    const config = await getConfig();
    assert.equal(config.speak.pronunciations.DSH, '滴艾斯诶尺');
    assert.equal(config.speak.pronunciations.Yuki, '优key', '默认发音由 normalizeSpeakConfig 保留');
  });

  await test('保存其它段落不会误删/误改本次没提交的段落（且不误报重启提示）', async () => {
    const response = await postConfig({ context: { recentLimit: 88 } });
    assert.equal(response.alertsRestartRequired, false, 'alerts 没变时不应提示重启桥接');
    const file = readConfigFile();
    assert.equal(file.socialV2.sandbox.maxReadBytes, 1024, 'sandbox 应保留');
    assert.equal(file.socialV2.session.freshEveryTurn, true, 'session 应保留');
    assert.equal(file.socialV2.reminders.listName, '工作提醒', 'reminders 应保留');
    assert.equal(file.alerts.maxPerHour, 1, '顶层 alerts 应保留');
    assert.equal(file.socialV2.context.recentLimit, 88);
    assert.equal(file.socialV2.context.catchUp.maxChars, 200, 'catchUp 应保留');
  });

  console.log(`\n全部通过（${passed} 项）`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  await harness.close();
}
