#!/usr/bin/env node
// 控制台「有配置但没入口」的字段契约：真实桥接 + 真实控制台服务器 + 临时 config.json。
//
// 覆盖 /api/socialV2/config 的 GET/POST：
//   · GET 返回归一化后的 sandbox / media / session / reminders / context.catchUp / alerts / webSearch；
//   · POST 接受这些段落（含非法值），合法值落盘、非法值 clamp 或回退当前值；
//   · 顶层 alerts / webSearch 必须写在 config.json 的顶层，不能混进 socialV2；
//   · webSearch.apiKey 脱敏：GET 只回 '********' + apiKeySet，POST 回传 '********' 不覆盖原值；
//   · singing / singing.cover / singing.cover.online 三层深合并（只提交部分 cover 不丢其它键）；
//   · /api/memory/config 的 GET 归一化回读、POST 阈值落盘 + clamp + restartRequired。
//
// 不碰真实 config.json：bridgeHarness 在 os.tmpdir() 里建临时根目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const MB = 1024 * 1024;
const harness = await bridgeHarness({
  config: {
    // webSearch 的 apiKey 用来验证「GET 脱敏 / POST 占位不覆盖」；其余字段验证归一化与 clamp。
    webSearch: {
      enabled: true,
      provider: 'bing',
      apiKey: 'sk-fixture-web-search',
      apiKeyEnv: 'TEST_WEB_SEARCH_KEY',
      model: 'fixture-search-model',
      baseURL: '',
      maxUses: 3,
      maxTokens: 1024,
      maxResults: 5,
      timeoutMs: 20000
    }
  }
});
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

  // ── webSearch（顶层配置，不在 socialV2 下）────────────────────────────────
  await test('webSearch：GET 脱敏 + POST 占位不覆盖原 Key + 合法值落盘回读 + 非法值 clamp', async () => {
    // GET：只回 '********' + apiKeySet，整个响应里不能出现明文 Key。
    const masked = await request('GET', '/api/socialV2/config');
    assert.equal(masked.status, 200, masked.text);
    assert.equal(masked.json.config.webSearch.apiKey, '********');
    assert.equal(masked.json.config.webSearch.apiKeySet, true);
    assert.equal(masked.text.includes('sk-fixture-web-search'), false, 'GET 回包不能出现明文 apiKey');
    assert.equal(masked.json.config.webSearch.provider, 'bing');
    assert.equal(masked.json.config.webSearch.maxUses, 3);

    // POST：'********' = 不改原 Key；其余合法值原样落盘。
    await postConfig({
      webSearch: {
        enabled: true,
        provider: 'deepseek',
        model: 'search-model',
        baseURL: 'https://example.invalid/v1',
        apiKeyEnv: 'CUSTOM_SEARCH_KEY',
        apiKey: '********',
        maxUses: 4,
        maxTokens: 8000,
        maxResults: 15,
        timeoutMs: 60000
      }
    });
    let file = readConfigFile();
    assert.equal(file.webSearch.apiKey, 'sk-fixture-web-search', "'********' 不能覆盖已保存的 apiKey");
    assert.equal(file.webSearch.provider, 'deepseek');
    assert.equal(file.webSearch.model, 'search-model');
    assert.equal(file.webSearch.baseURL, 'https://example.invalid/v1');
    assert.equal(file.webSearch.apiKeyEnv, 'CUSTOM_SEARCH_KEY');
    assert.equal(file.webSearch.maxUses, 4);
    assert.equal(file.webSearch.maxTokens, 8000);
    assert.equal(file.webSearch.maxResults, 15);
    assert.equal(file.webSearch.timeoutMs, 60000);
    // 顶层段：不能混进 socialV2（否则 MCP 读不到、还会出现两份）。
    assert.equal(file.socialV2.webSearch, undefined, 'webSearch 不能混进 socialV2');
    assert.ok(file.webSearch && typeof file.webSearch === 'object', 'config.json 顶层应有 webSearch');

    let config = await getConfig();
    assert.equal(config.webSearch.apiKey, '********');
    assert.equal(config.webSearch.apiKeySet, true);
    assert.equal(config.webSearch.provider, 'deepseek');
    assert.equal(config.webSearch.maxUses, 4, '合法值应原样回读');
    assert.equal(config.webSearch.maxTokens, 8000);
    assert.equal(config.webSearch.maxResults, 15);
    assert.equal(config.webSearch.timeoutMs, 60000);

    // 非法值：clamp 到边界；非法 provider 回退当前值；非布尔 enabled 也回退。
    await postConfig({ webSearch: { enabled: 'yes', provider: 'nope', maxUses: 0, maxTokens: 1, maxResults: 99, timeoutMs: 1 } });
    file = readConfigFile();
    assert.equal(file.webSearch.enabled, true, '非布尔 enabled 回退当前值');
    assert.equal(file.webSearch.provider, 'deepseek', '非法 provider 回退当前值');
    assert.equal(file.webSearch.maxUses, 1);
    assert.equal(file.webSearch.maxTokens, 256);
    assert.equal(file.webSearch.maxResults, 20);
    assert.equal(file.webSearch.timeoutMs, 5000, '与运行时同区间：最小 5s');
  });

  // ── memory.* 阈值（只走 /api/memory/config；阈值类不热更新）─────────────────
  await test('memory 阈值：GET 归一化返回 + POST 落盘 config.json 的 memory 段 + clamp + restartRequired', async () => {
    const before = await request('GET', '/api/memory/config');
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.ok, true);
    assert.equal(before.json.config.retrieval.maxResults, 5);
    assert.equal(before.json.config.retrieval.candidateLimit, 40);
    assert.equal(before.json.config.retrieval.minScore, 0.18);
    assert.equal(before.json.config.retrieval.halfLifeDays, 30);
    assert.equal(before.json.config.prompt.maxTokens, 350);
    assert.equal(before.json.config.prompt.targetAverageTokens, 150);
    assert.equal(before.json.config.prompt.includeSessionState, false);
    assert.equal(before.json.config.capture.explicitMemoryEnabled, true);
    assert.equal(before.json.config.capture.candidateBufferEnabled, true);
    assert.equal(before.json.config.capture.batchCandidateThreshold, 15);
    assert.equal(before.json.config.capture.minExtractionIntervalMs, 30 * 60 * 1000);
    assert.equal(before.json.config.capture.candidateTtlMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(before.json.config.capture.maxCandidates, 500);
    assert.equal(before.json.config.consolidation.enabled, false);
    assert.equal(before.json.config.consolidation.onlyWhenIdle, true);
    assert.equal(before.json.config.consolidation.idleMs, 15 * 60 * 1000);
    assert.equal(before.json.config.consolidation.intervalMs, 60 * 60 * 1000);
    assert.equal(before.json.config.consolidation.preferACPower, true);
    assert.equal(before.json.config.maxAdditionalRamMB, 50);
    assert.equal('root' in before.json.config, false, 'GET 不应把本机 root 路径回给前端');

    const posted = await request('POST', '/api/memory/config', {
      retrieval: { maxResults: 9, candidateLimit: 60, minScore: 0.3, halfLifeDays: 45 },
      prompt: { maxTokens: 300, targetAverageTokens: 120, includeSessionState: true },
      capture: {
        explicitMemoryEnabled: false,
        candidateBufferEnabled: false,
        batchCandidateThreshold: 30,
        minExtractionIntervalMs: 900_000,
        candidateTtlMs: 24 * 60 * 60 * 1000,
        maxCandidates: 800
      },
      consolidation: { enabled: true, onlyWhenIdle: false, idleMs: 10 * 60 * 1000, intervalMs: 2 * 60 * 60 * 1000, preferACPower: false },
      maxAdditionalRamMB: 77
    });
    assert.equal(posted.status, 200, posted.text);
    assert.equal(posted.json.restartRequired, true, '阈值变了要提示重启桥接');
    const file = readConfigFile();
    assert.ok(file.memory && typeof file.memory === 'object', 'config.json 应有 memory 段');
    assert.deepEqual(file.memory.retrieval, { maxResults: 9, candidateLimit: 60, minScore: 0.3, halfLifeDays: 45 });
    assert.deepEqual(file.memory.prompt, { maxTokens: 300, targetAverageTokens: 120, includeSessionState: true });
    assert.equal(file.memory.capture.explicitMemoryEnabled, false);
    assert.equal(file.memory.capture.candidateBufferEnabled, false);
    assert.equal(file.memory.capture.batchCandidateThreshold, 30);
    assert.equal(file.memory.capture.minExtractionIntervalMs, 900_000);
    assert.equal(file.memory.capture.candidateTtlMs, 24 * 60 * 60 * 1000);
    assert.equal(file.memory.capture.maxCandidates, 800);
    assert.deepEqual(file.memory.consolidation, {
      enabled: true, onlyWhenIdle: false, idleMs: 600_000, intervalMs: 7_200_000, preferACPower: false
    });
    assert.equal(file.memory.maxAdditionalRamMB, 77);
    // 热更新字段（mode 等）仍走原有逻辑：阈值没变时 restartRequired=false。
    const hotOnly = await request('POST', '/api/memory/config', { mode: 'live' });
    assert.equal(hotOnly.status, 200, hotOnly.text);
    assert.equal(hotOnly.json.restartRequired, false, '只改可热更新的 mode 时不应提示重启');
    assert.equal(readConfigFile().memory.retrieval.mode, 'live');

    const readBack = await request('GET', '/api/memory/config');
    assert.equal(readBack.json.config.retrieval.maxResults, 9);
    assert.equal(readBack.json.config.retrieval.minScore, 0.3);
    assert.equal(readBack.json.config.prompt.maxTokens, 300);
    assert.equal(readBack.json.config.prompt.includeSessionState, true);
    assert.equal(readBack.json.config.capture.maxCandidates, 800);
    assert.equal(readBack.json.config.consolidation.idleMs, 600_000);
    assert.equal(readBack.json.config.maxAdditionalRamMB, 77);

    // 非法值：全部 clamp 到 normalizeMemoryConfig 的边界，不抛错。
    const clamped = await request('POST', '/api/memory/config', {
      retrieval: { maxResults: 0, candidateLimit: 1, minScore: 5, halfLifeDays: 0 },
      prompt: { maxTokens: 999, targetAverageTokens: 999 },
      capture: { batchCandidateThreshold: 1, minExtractionIntervalMs: 1, candidateTtlMs: 1, maxCandidates: 1 },
      consolidation: { idleMs: 1, intervalMs: 1 },
      maxAdditionalRamMB: 0
    });
    assert.equal(clamped.status, 200, clamped.text);
    assert.equal(clamped.json.restartRequired, true);
    const clampedFile = readConfigFile();
    assert.equal(clampedFile.memory.retrieval.maxResults, 1);
    assert.equal(clampedFile.memory.retrieval.candidateLimit, 5);
    assert.equal(clampedFile.memory.retrieval.minScore, 0.95);
    assert.equal(clampedFile.memory.retrieval.halfLifeDays, 1);
    assert.equal(clampedFile.memory.prompt.maxTokens, 350);
    assert.equal(clampedFile.memory.prompt.targetAverageTokens, 350, '目标平均 token 不能超过 maxTokens');
    assert.equal(clampedFile.memory.capture.batchCandidateThreshold, 5);
    assert.equal(clampedFile.memory.capture.minExtractionIntervalMs, 60_000);
    assert.equal(clampedFile.memory.capture.candidateTtlMs, 60 * 60 * 1000);
    assert.equal(clampedFile.memory.capture.maxCandidates, 50);
    assert.equal(clampedFile.memory.consolidation.idleMs, 60_000);
    assert.equal(clampedFile.memory.consolidation.intervalMs, 5 * 60 * 1000);
    assert.equal(clampedFile.memory.maxAdditionalRamMB, 1);
  });

  // ── singing.cover 三层深合并（修复浅合并把没提交的键整块覆盖）──────────────
  await test('singing.cover 深合并：只提交 cover.enabled 时其它 cover / online 键保持原值 + clamp', async () => {
    await postConfig({
      singing: {
        enabled: true,
        cover: {
          enabled: false,
          defaultDuration: 18,
          minDuration: 8,
          maxDuration: 25,
          maxConcurrent: 2,
          maxQueue: 7,
          maxPerKey: 3,
          cooldownMs: 123_456,
          online: {
            enabled: false,
            qqmusic: false,
            neteaseLevel: 'exhigh',
            allowPaidMedia: true,
            previewFallback: true,
            timeoutMs: 15_000,
            retries: 2
          }
        }
      }
    });
    let file = readConfigFile();
    const seeded = file.socialV2.singing.cover;
    assert.equal(seeded.enabled, false);
    assert.equal(seeded.defaultDuration, 18);

    // 只提交 cover.enabled：修复前（浅合并）这里会把 cover 其它键与 online 整块覆盖掉。
    await postConfig({ singing: { cover: { enabled: true } } });
    file = readConfigFile();
    const cover = file.socialV2.singing.cover;
    assert.equal(cover.enabled, true);
    for (const key of ['defaultDuration', 'minDuration', 'maxDuration', 'maxConcurrent', 'maxQueue', 'maxPerKey', 'cooldownMs']) {
      assert.equal(cover[key], seeded[key], `只改 cover.enabled 时 cover.${key} 应保持原值`);
    }
    for (const key of ['enabled', 'qqmusic', 'neteaseLevel', 'allowPaidMedia', 'previewFallback', 'timeoutMs', 'retries']) {
      assert.equal(cover.online[key], seeded.online[key], `只改 cover.enabled 时 cover.online.${key} 应保持原值`);
    }
    // 顶层 singing 字段同样深合并（不能被 cover patch 清掉）。
    assert.equal(file.socialV2.singing.maxSeconds, 20, 'singing.maxSeconds 不应被 cover patch 覆盖');
    assert.equal(file.socialV2.singing.enabled, true);

    // GET 回读也应保留合并后的值（redactSingingConfig 会再次归一化）。
    const config = await getConfig();
    assert.equal(config.singing.cover.defaultDuration, 18);
    assert.equal(config.singing.cover.maxQueue, 7);
    assert.equal(config.singing.cover.online.neteaseLevel, 'exhigh');
    assert.equal(config.singing.cover.online.allowPaidMedia, true);

    // 非法值 clamp：与运行时（short-cover/config.js）一致 —— 时长 5..30、并发 1..2、队列 0..50、冷却 0..600000。
    await postConfig({ singing: { cover: { maxConcurrent: 99, maxQueue: 0, cooldownMs: 99_999_999, minDuration: 1, maxDuration: 99 } } });
    file = readConfigFile();
    const clamped = file.socialV2.singing.cover;
    assert.equal(clamped.maxConcurrent, 2);
    assert.equal(clamped.maxQueue, 0);
    assert.equal(clamped.cooldownMs, 600_000);
    assert.equal(clamped.minDuration, 5);
    assert.equal(clamped.maxDuration, 30);
    assert.ok(clamped.defaultDuration >= clamped.minDuration && clamped.defaultDuration <= clamped.maxDuration,
      '默认时长必须落在最短/最长之间');
    assert.equal(clamped.online.neteaseLevel, 'exhigh', '只改资源限制时 online 也应保留');
  });

  console.log(`\n全部通过（${passed} 项）`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  await harness.close();
}
