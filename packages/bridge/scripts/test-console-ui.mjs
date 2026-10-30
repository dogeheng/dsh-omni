#!/usr/bin/env node
/** Real-browser tests against an isolated fixture. Never starts dsh-omni or sends real messages. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startConsoleFixture } from './console-ui-fixture.mjs';
import { manualDirCommand } from '../src/state-acl.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const original = args.includes('--original');
const record = args.includes('--record-baseline');
const artifacts = args.find(x => x.startsWith('--artifacts='))?.slice('--artifacts='.length);
const views = ['overview', 'sessions', 'persona', 'social-v2', 'social-v1', 'vision', 'hearing', 'voice', 'expression', 'memory', 'slang', 'runtime', 'usage', 'access', 'power', 'operations', 'reference'];
const legacyIds = JSON.parse((await readFile(join(here, 'console-ui-legacy-ids.json'), 'utf8')).replace(/^\uFEFF/, ''));
const baselinePath = join(here, 'console-ui-contracts.json');
if (record && !original) throw new Error('--record-baseline requires --original; only the pre-redesign console can define the baseline.');

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install with npm install --no-save playwright, or set PLAYWRIGHT_MODULE to its package directory.');
}

const { chromium } = await loadPlaywright();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(x => existsSync(x));
const fixture = await startConsoleFixture({ original });
let browser;
const results = [];
const errors = [];
const blockedRequests = [];
async function test(name, fn) {
  const start = Date.now();
  try { await fn(); results.push({ name, ok: true, durationMs: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message, durationMs: Date.now() - start }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  // Even if a future console accidentally references an external endpoint, tests cannot reach it.
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url());
    if (requested.origin === fixture.url) return route.continue();
    blockedRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.getElementById('v2AgentPreset')?.value === 'qq-chat-v2' && document.getElementById('wlGroups')?.value.includes('123456789'));

  async function navigate(view) {
    if (original) return;
    if (await page.locator(`[data-page="${view}"]:visible`).count()) return;
    const nav = page.locator(`#pageNav [data-view="${view}"]`).first();
    if (!await nav.isVisible()) {
      const category = await nav.evaluate(el => el.closest('[data-nav-group]')?.dataset.navGroup);
      if (category) await page.locator(`[data-category="${category}"]`).click();
    }
    await nav.click();
  }
  async function reveal(selector) {
    const target = page.locator(selector).first();
    const view = await target.evaluate(el => el.closest('[data-page]')?.dataset.page);
    if (view) await navigate(view);
    const pane = await target.evaluate(el => el.closest('[data-setting-pane]')?.dataset.settingPane);
    if (pane) await page.locator(`[data-pane="${pane}"]`).click();
    for (const details of await target.locator('xpath=ancestor::details').all()) {
      if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
    }
    return target;
  }
  async function fill(id, value) { await (await reveal(`#${id}`)).fill(String(value)); }
  async function check(id, checked) { await (await reveal(`#${id}`)).setChecked(checked); }
  async function clickWrite(selector, path, method = 'POST') {
    const target = await reveal(selector);
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method),
      target.click(),
    ]);
    assert.equal(response.status(), 200, `${method} ${path} should succeed`);
    assert.equal((await response.json()).ok, true);
    return fixture.requests.at(-1)?.body;
  }

  await test('All 225 legacy IDs remain present and every DOM ID is unique', async () => {
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(x => x.id));
    assert.equal(legacyIds.length, 225);
    assert.deepEqual(legacyIds.filter(x => !ids.includes(x)), []);
    const sourceIds = await page.evaluate(async () => {
      const html = await (await fetch(location.pathname)).text();
      return [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('[id]')].map(node => node.id);
    });
    assert.deepEqual(sourceIds.filter(id => !ids.includes(id)), [], 'Every current source control must remain mounted, including newer voice and memory fields');
    assert.equal(new Set(ids).size, ids.length, 'Duplicate DOM IDs detected');
  });

  if (!original) await test('All navigation destinations work and preserve unsaved form values across polling', async () => {
    for (const view of views) {
      await navigate(view);
      const visiblePages = await page.locator('[data-page]').evaluateAll(nodes => nodes.filter(x => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden').map(x => x.dataset.page));
      assert(visiblePages.length > 0, `${view} has no visible content`);
      assert(visiblePages.every(x => x === view), `${view} exposes another page: ${visiblePages.join(', ')}`);
    }
    const drafts = { wlGroups: '100001, 100002', roleInput: '未保存的角色', v2AgentPreset: 'draft-preset', sKeywords: '未保存关键词', slangMeaning: '未保存的含义', tsMsg: '未发送的测试消息' };
    for (const [id, value] of Object.entries(drafts)) await fill(id, value);
    await navigate('overview');
    await page.waitForTimeout(3300); // Exercise the real 3-second status polling interval.
    for (const [id, value] of Object.entries(drafts)) assert.equal(await (await reveal(`#${id}`)).inputValue(), value, `${id} lost its draft`);
    // Restore fixture defaults so the independent payload baseline remains deterministic.
    await page.reload();
    await page.waitForFunction(() => document.getElementById('v2AgentPreset')?.value === 'qq-chat-v2');
  });

  await test('Mode and preset contracts', async () => {
    for (const mode of ['chat', 'reserved', 'reserved2', 'closed-agent']) {
      assert.deepEqual(await clickWrite(`#modeRow [data-mode="${mode}"]`, '/api/mode'), { mode, closedAgentPreset: '' });
    }
    const select = await reveal('#closedPreset');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/mode') && r.request().method() === 'POST'), select.selectOption('qq-chat-v2')]);
    assert.deepEqual(fixture.requests.at(-1).body, { mode: 'closed-agent', closedAgentPreset: 'qq-chat-v2' });
  });

  await test('Role creation, selection, clearing and silent-mode contracts', async () => {
    await fill('newRoleName', '契约测试角色');
    await fill('newRoleContent', '温柔、有耐心，回答简洁。');
    assert.deepEqual(await clickWrite('#roleCreate', '/api/roles/create'), { name: '契约测试角色', content: '温柔、有耐心，回答简洁。' });
    await fill('roleInput', '契约测试角色');
    assert.deepEqual(await clickWrite('#roleSet', '/api/role'), { role: '契约测试角色' });
    assert.deepEqual(await clickWrite('#roleClear', '/api/role'), { role: null });
    assert.deepEqual(await clickWrite('#silentOn', '/api/role-mode'), { mode: 'silent' });
    assert.deepEqual(await clickWrite('#silentOff', '/api/role-mode'), { mode: 'active' });
  });

  await test('Whitelist numeric parsing and security contracts', async () => {
    for (const [id, value] of Object.entries({ wlGroups: '123456789，100003', wlPrivate: '100001 100002', dnGroups: '800001,800002', dnPrivate: '900001', ownerQQ: '100001' })) await fill(id, value);
    assert.deepEqual(await clickWrite('#wlSave', '/api/whitelist'), { allow: { private: [100001, 100002], groups: [123456789, 100003] }, deny: { private: [900001], groups: [800001, 800002] }, ownerQQ: '100001' });
    await check('secInterceptNotify', false);
    assert.deepEqual(await clickWrite('#secSave', '/api/security'), { interceptNotify: false });
  });

  // state/ 的 ACL 收紧需要管理员权限，未提权时桥接会明确报告 hardened:false。
  // 控制台必须把这件事**显式**呈现（含可复制的提权命令），而不是让用户以为已经安全；
  // 用户按提示处理后点「重新检测」应当转为成功态。
  await test('Unhardened state directory surfaces a warning with the exact command', async () => {
    await navigate('access');
    await page.waitForFunction(() => document.getElementById('stateDirWarn')?.style.display !== 'none');
    const shown = await page.evaluate(() => ({
      path: document.getElementById('stateDirPath').textContent,
      cmd: document.getElementById('stateDirCmd').textContent,
    }));
    assert.match(shown.path, /state|data/, '应当显示 state 目录路径');
    assert.equal(shown.cmd, manualDirCommand(shown.path), '命令应来自当前平台的权限修复实现');
    // 只验证按钮确实发起「重新检测」请求，**不**写进/触发 baseline 的写载荷契约
    // （baseline 记录的是改版前控制台的表单写载荷，这条不算表单写）。
    await page.waitForFunction(() => document.getElementById('stateDirReharden') !== null);
    const [request] = await Promise.all([
      page.waitForRequest(r => new URL(r.url()).pathname === '/api/security' && r.method() === 'POST'),
      page.click('#stateDirReharden'),
    ]);
    assert.deepEqual(JSON.parse(request.postData() || '{}'), { rehardenStateDir: true });
    await page.waitForFunction(() => document.getElementById('stateDirWarn')?.style.display === 'none');
  });

  await test('Second-generation complete save payload, units, zero values and tool switches', async () => {
    await fill('v2AgentPreset', 'contract-v2');
    await fill('v2RecSleepMin', 7);
    await fill('v2SleepMinMs', 42);
    await fill('v2PreSleepWaitMin', 0);
    await fill('v2RecProb', 0);
    await fill('v2RecKeywords', '鲸鱼，DeepSeek, 测试');
    await fill('v2AutoReplyCheckSec', 17);
    await fill('v2WaitDefaultQuietMs', 0);
    await fill('v2MaxSendMin', 0);
    await check('v2ProvideRecommendations', false);
    const firstTool = page.locator('#v2Tools [data-v2-tool]').first();
    await reveal('#v2Tools [data-v2-tool]');
    await firstTool.setChecked(false);
    const body = await clickWrite('#v2ConfigSaveTop', '/api/socialV2/config');
    assert.equal(body.wake.recommendedSleepMinMs, 420000);
    assert.equal(body.wake.sleepMinMs, 42000);
    assert.equal(body.wake.preSleepWaitMs, 0);
    assert.equal(body.wake.recommendedProbability, 0);
    assert.deepEqual(body.wake.recommendedKeywords, ['鲸鱼', 'DeepSeek', '测试']);
    assert.equal(body.autoReplyCheckMs, 17000);
    assert.equal(body.wait.defaultQuietMs, 0);
    assert.equal(body.send.maxSendPerMinute, 0);
    assert.equal(body.provideRecommendations, false);
    assert.equal(body.tools[await firstTool.getAttribute('data-v2-tool')], false);
    // The lower save button must submit the same complete configuration.
    await page.waitForFunction(() => document.getElementById('v2AgentPreset').value === 'contract-v2');
    assert.deepEqual(await clickWrite('#v2ConfigSave', '/api/socialV2/config'), body);
    assert.deepEqual(await clickWrite('#v2PauseBtn', '/api/socialV2/activity'), { paused: true });
    assert.deepEqual(await clickWrite('#v2ResumeBtn', '/api/socialV2/activity'), { paused: false });
  });

  await test('First-generation social parameter and phase contracts', async () => {
    await fill('sTrigger', 0.35);
    await fill('sCheckMin', 12);
    await fill('sKeywords', '鲸鱼，测试');
    const body = await clickWrite('#socialSave', '/api/social');
    assert.equal(body.triggerProbability, 0.35);
    assert.equal(body.activeCheckMinMs, 12000);
    assert.deepEqual(body.mustReplyKeywords, ['鲸鱼', '测试']);
    await (await reveal('#sStateKey')).selectOption('group:123456789');
    assert.deepEqual(await clickWrite('#sStateIdle', '/api/social/state'), { key: 'group:123456789', phase: 'idle' });
    assert.deepEqual(await clickWrite('#socialFlush', '/api/social/flush'), {});
  });

  await test('Slang add, search, confirm modal, tab switching and parameter contracts', async () => {
    for (const [id, value] of Object.entries({ slangContent: '测试词条', slangMeaning: '很棒', slangUsage: '赞美', slangExample: '这个效果很棒。' })) await fill(id, value);
    assert.deepEqual(await clickWrite('#slangAdd', '/api/slang'), { content: '测试词条', meaning: '很棒', usage: '赞美', example: '这个效果很棒。' });
    await (await reveal('.slang-tab[data-slang-tab="confirmed"]')).click();
    await fill('slangSearchConfirmed', '测试词条');
    assert.equal(await page.locator('#slangConfirmedList tbody tr').count(), 2, 'Filtered table should contain header and one entry');
    await (await reveal('.slang-tab[data-slang-tab="candidate"]')).click();
    await page.locator('[data-slang-confirm="demo-candidate"]').click();
    await fill('slangModalMeaning', '感到安慰');
    await fill('slangModalUsage', '轻松聊天');
    await fill('slangModalExample', '有被治愈到。');
    await fill('slangModalRisk', '无');
    await fill('slangModalSources', 'https://example.invalid/offline-source');
    assert.deepEqual(await clickWrite('#slangModalDirectConfirm', '/api/slang/demo-candidate/confirm'), { meaning: '感到安慰', usage: '轻松聊天', example: '有被治愈到。', risk: '无', sources: ['https://example.invalid/offline-source'] });
    await fill('slangExtractMin', 14);
    await fill('slangThresholds', '3，6 12');
    const config = await clickWrite('#slangConfigSave', '/api/slang/config');
    assert.equal(config.extractMinMessages, 14);
    assert.deepEqual(config.inferenceThresholds, [3, 6, 12]);
  });

  await test('Test message and AI notification reach only the mock endpoints', async () => {
    await (await reveal('#tsKind')).selectOption('group');
    await fill('tsId', '123456789');
    await fill('tsMsg', '离线测试，不会发往 QQ。');
    assert.deepEqual(await clickWrite('#tsSend', '/api/test-send'), { kind: 'group', id: '123456789', message: '离线测试，不会发往 QQ。' });
    await (await reveal('#aiNotifyKind')).selectOption('private');
    await fill('aiNotifyId', '100001');
    await fill('aiNotifyMessage', '离线提醒，不会发往 DSH。');
    assert.deepEqual(await clickWrite('#aiNotifySend', '/api/console/notify-ai'), { key: 'private:100001', message: '离线提醒，不会发往 DSH。' });
  });

  if (record) {
    assert(results.every(x => x.ok), 'Cannot record a baseline from a failed suite');
    await writeFile(baselinePath, JSON.stringify(fixture.requests, null, 2) + '\n');
    console.log(`Recorded original API contracts: ${baselinePath}`);
  } else await test('All historical fields exactly match the original contracts; newer fields are checked separately', async () => {
    const expected = JSON.parse(await readFile(baselinePath, 'utf8'));
    // This immutable snapshot predates voice IO, singing, sticker probability and the
    // enabled flag. Compare its entire contract, with only those explicit additions
    // projected out. Their modern payloads are exercised by the voice/feature tests.
    const actual = structuredClone(fixture.requests).filter(request => !request.body?.rehardenStateDir);
    for (const request of actual) {
      if (request.path === '/api/social') delete request.body.enabled;
      if (request.path === '/api/socialV2/config') {
        for (const key of ['voice', 'asr', 'speak', 'singing']) delete request.body[key];
        for (const key of ['sendProbability', 'nudgeAfterSend', 'nudgeMinChars']) delete request.body.sticker[key];
        for (const key of ['sendVoice', 'sendImage', 'addSticker', 'speak', 'sing']) delete request.body.tools[key];
      }
    }
    assert.equal(actual.length, expected.length, 'Contract request count changed');
    actual.forEach((request, i) => assert.deepEqual(request, expected[i], `${request.method} ${request.path}, request ${i + 1}`));
  });

  // 放在基线比对之后：这里产生的写请求不影响「改版前载荷基线」那条检查。
  if (!original) await test('听懂语音 / 开口说话：参数回显、服务商切换、按需加载控制、试听试发与保存载荷', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    // 总览页的大功能开关
    assert.equal(await (await reveal('[data-feature="asr"]')).isChecked(), true, '听懂语音应回显 asr:true');
    assert.equal(await (await reveal('[data-feature="speak"]')).isChecked(), false, '开口说话应回显 speak:false');
    assert.equal(await page.locator('[data-v2-tool="speak"]').count(), 1, '工具开关里应有 qq_speak');
    // 展开分组会自动拉一次状态；按需加载模式下初始是「未加载」
    await reveal('#v2AsrEnabled');
    await page.waitForFunction(() => /未加载/.test(document.getElementById('asrStatus')?.textContent || ''));
    assert.match(await page.textContent('#asrStatus'), /按需加载，闲置 10 分钟后自动释放/);
    assert.match(await page.textContent('#ttsStatus'), /小米 MiMo，✅ 已就绪/);
    // 回显：单位换算 + Key 脱敏不回填
    assert.equal(await page.inputValue('#v2AsrIdleUnloadMin'), '10');
    assert.equal(await page.inputValue('#v2SpeakAutoProb'), '5');
    assert.equal(await page.inputValue('#v2MimoVoice'), '冰糖');
    assert.equal(await page.inputValue('#v2MimoApiKey'), '', '脱敏后的 Key 不能回填进输入框');
    assert.equal(await page.getAttribute('#v2MimoApiKey', 'placeholder'), '已保存（留空 = 不修改）');
    assert.equal(await page.getAttribute('#v2DoubaoApiKey', 'placeholder'), '未设置');
    // 服务商 / 引擎切换只显示对应参数区
    await reveal('#v2SpeakProvider');
    assert(await page.isVisible('#v2SpeakMimoBox') && !await page.isVisible('#v2SpeakDoubaoBox'));
    await page.selectOption('#v2SpeakProvider', 'gptsovits');
    assert(await page.isVisible('#v2SpeakGsvBox') && !await page.isVisible('#v2SpeakMimoBox'));
    // GPT-SoVITS 参考音频 JSON 写错：拦在前端，不发保存请求
    const before = fixture.requests.length;
    await fill('v2GsvRefs', '{"default": ');
    await (await reveal('#v2ConfigSave')).click();
    await page.waitForFunction(() => /GPT-SoVITS 参考音频不是合法 JSON/.test(document.getElementById('v2ConfigMsg')?.textContent || ''));
    assert.equal(fixture.requests.length, before, '非法 JSON 不应发出保存请求');
    await fill('v2GsvRefs', '');
    // 立即加载 / 立即释放（按需加载的手动控制）
    assert.deepEqual(await clickWrite('#asrLoadBtn', '/api/voice/asr'), { action: 'load' });
    await page.waitForFunction(() => /已加载（识别子进程/.test(document.getElementById('asrStatus')?.textContent || ''));
    assert.deepEqual(await clickWrite('#asrUnloadBtn', '/api/voice/asr'), { action: 'unload' });
    await page.waitForFunction(() => /已释放/.test(document.getElementById('asrMsg')?.textContent || ''));
    // 试听：dryRun + 同源音频（CSP 下不能用 data:/blob:）
    await fill('ttsPreviewText', '你好呀，我在呢');
    await page.selectOption('#ttsPreviewEmotion', '开心');
    assert.deepEqual(await clickWrite('#ttsPreviewBtn', '/api/voice/speak'), { text: '你好呀，我在呢', dryRun: true, emotion: '开心' });
    await page.waitForFunction(() => (document.getElementById('ttsPreviewAudio')?.getAttribute('src') || '').startsWith('/api/voice/preview-audio?'));
    assert(await page.isVisible('#ttsPreviewAudio'));
    // 试发：目标格式错误拦在前端；正确时确认后发到 mock
    await fill('ttsSendTarget', '123456789');
    await (await reveal('#ttsSendBtn')).click();
    assert.match(await page.textContent('#ttsMsg'), /发送目标格式/);
    await fill('ttsSendTarget', 'group:123456789');
    assert.deepEqual(await clickWrite('#ttsSendBtn', '/api/voice/speak'), { text: '你好呀，我在呢', target: 'group:123456789', emotion: '开心' });
    // 保存载荷：单位换算、Key 占位与新 Key
    await fill('v2AsrIdleUnloadMin', '0.5');
    await check('v2AsrPreload', true);
    await check('v2SpeakEnabled', true);
    await check('v2SpeakAutoEnabled', true);
    await fill('v2SpeakAutoProb', '12.5');
    await fill('v2SpeakAutoCooldownMin', '2');
    await page.selectOption('#v2SpeakProvider', 'doubao');
    await fill('v2DoubaoApiKey', 'fixture-doubao-key');
    await (await reveal('[data-v2-tool="speak"]')).setChecked(false);
    const saved = await clickWrite('#v2ConfigSave', '/api/socialV2/config');
    assert.equal(saved.asr.idleUnloadMs, 30000, '0.5 分钟 = 30000ms');
    assert.equal(saved.asr.preload, true);
    assert.equal(saved.speak.enabled, true);
    assert.equal(saved.speak.provider, 'doubao');
    assert.equal(saved.speak.autoConvert.enabled, true);
    assert.equal(saved.speak.autoConvert.probability, 0.125);
    assert.equal(saved.speak.autoConvert.cooldownMs, 120000);
    assert.equal(saved.speak.mimo.apiKey, '********', '已保存但没改的 Key 回传占位，由后端保留原值');
    assert.equal(saved.speak.doubao.apiKey, 'fixture-doubao-key');
    assert.deepEqual(saved.speak.gptsovits.refs, {});
    assert.equal(saved.tools.speak, false, 'qq_speak 工具开关随工具列表一起保存');
  });

  if (!original) await test('Token usage panel renders totals, per-conversation and per-turn cost', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate('usage');
    await page.waitForFunction(() => document.getElementById('metricUsageTokens')?.textContent !== '—');

    // 四个总览指标
    assert.match((await page.textContent('#metricUsageCost')).trim(), /^¥\d/, '总花费应渲染成货币金额');
    assert.match((await page.textContent('#metricUsageTokens')).trim(), /\d/, '累计 token 应有数值');
    assert.match((await page.textContent('#metricUsageHitRate')).trim(), /%$/, '缓存命中率应为百分比');
    assert.match((await page.textContent('#metricUsagePerTurn')).trim(), /^¥\d/, '平均每轮应为货币金额');

    // 按会话（群 / 私聊 / 内部）明细
    const conversations = await page.textContent('#usageConversations');
    assert.match(conversations, /group:123456789/, '按会话表应列出群会话');
    assert.match(conversations, /private:100001/, '按会话表应列出私聊会话');
    assert.match(conversations, /internal:黑话学习/, '按会话表应列出内部（黑话学习）用量');
    assert.match(conversations, /¥/, '按会话表应显示花费列');
    assert.match(conversations, /未命中输入/, '按会话表应拆分缓存命中 / 未命中');

    // 下钻逐轮：点会话行 → 加载该会话的逐轮花费
    await page.click('#usageConversations [data-usage-key="group:123456789"]');
    await page.waitForFunction(() => /#\d+/.test(document.getElementById('usageTurns')?.textContent || ''));
    const turns = await page.textContent('#usageTurns');
    assert.match(turns, /#42/, '逐轮明细应显示轮次编号');
    assert.match(turns, /步数/, '逐轮明细应显示步数');
    assert.match(turns, /空闲|高峰|跨时段/, '逐轮明细应标注峰谷时段');
    assert.match(turns, /¥/, '逐轮明细应显示每轮花费');

    // 会话下拉与逐轮表同步
    assert.equal(await page.inputValue('#usageKeySelect'), 'group:123456789', '下拉框应跟随选中的会话');

    // 实时流水与价目表
    assert.match(await page.textContent('#usageRecent'), /group:123456789|private:100001/, '最近流水应列出采样');
    assert.match(await page.textContent('#usagePrices'), /deepseek-flash/, '价目表应列出模型单价');
  });

  if (!original) await test('Token usage trend chart renders bars, tiers and range/metric switching', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate('usage');
    await page.waitForFunction(() => document.querySelectorAll('#usageChart svg rect.usage-bar-off, #usageChart svg rect.usage-bar-peak').length > 0);

    // 柱：空闲与高峰两类都要画出来（fixture 按真实峰谷规则生成）
    const bars = await page.evaluate(() => ({
      off: document.querySelectorAll('#usageChart svg rect.usage-bar-off').length,
      peak: document.querySelectorAll('#usageChart svg rect.usage-bar-peak').length,
      mixed: document.querySelectorAll('#usageChart svg rect.usage-bar-mixed').length,
      grid: document.querySelectorAll('#usageChart svg line.usage-grid').length,
      axis: document.querySelectorAll('#usageChart svg text.usage-axis').length,
    }));
    assert(bars.off > 0 && bars.peak > 0, `走势图应画出空闲与高峰两类柱（${JSON.stringify(bars)}）`);
    assert.equal(bars.grid, 3, '应有 3 条横向网格线');
    assert(bars.axis >= 4, '应有纵轴刻度与横轴时间标签');

    // 悬停提示：每个柱都要带 <title>，能读出该格的花费与时段
    const titles = await page.$$eval('#usageChart svg title', (nodes) => nodes.map((n) => n.textContent));
    assert(titles.length > 0, '每个格子都应带悬停提示');
    assert(titles.some((t) => /花费：¥/.test(t)), '提示里应包含该格花费');
    assert(titles.some((t) => /时段：高峰/.test(t)), '提示里应标注高峰时段');

    // 汇总行与"图外还有多少"的说明
    assert.match(await page.textContent('#usageChartTotal'), /^¥\d/, '应显示窗口内合计花费');
    assert.match(await page.textContent('#usageChartHint'), /每格 \d+ 分钟/, '应说明每格代表多长时间');
    assert.match(await page.textContent('#usageChartNote'), /不在上图里/, '应说明时间轴之外还有多少花费（避免图合计 ≠ 总花费引起误解）');

    // 切范围：重新请求并按生产同一套桶宽阶梯换粒度
    // （24h→30min / 3d→2h / 7d→6h / 30d→24h，桶数始终 ≤ 48）
    await page.click('#usageChartControls [data-usage-hours="168"]');
    await page.waitForFunction(() => /每格 360 分钟/.test(document.getElementById('usageChartHint')?.textContent || '')
      && document.querySelector('#usageChartControls [data-usage-hours="168"]')?.classList.contains('active'));
    assert.match(await page.textContent('#usageChartHint'), /每格 360 分钟/, '切到 7 天后桶宽变成 6 小时');

    // 粗桶会把高峰窗口整个包在中间 → 必须标『跨时段』（细桶边界对齐则不会，这也是真账本的行为）
    await page.click('#usageChartControls [data-usage-hours="720"]');
    await page.waitForFunction(() => /每格 1440 分钟/.test(document.getElementById('usageChartHint')?.textContent || '')
      && document.querySelector('#usageChartControls [data-usage-hours="720"]')?.classList.contains('active'));
    assert.match(await page.textContent('#usageChartHint'), /每格 1440 分钟/, '切到 30 天后桶宽变成 24 小时');
    const coarse = await page.evaluate(() => ({
      mixed: document.querySelectorAll('#usageChart svg rect.usage-bar-mixed').length,
      buckets: document.querySelectorAll('#usageChart svg rect.usage-hit').length,
    }));
    assert(coarse.mixed > 0, `跨时段的粗桶应标为「跨时段」（${JSON.stringify(coarse)}）`);
    assert(coarse.buckets <= 48, `30 天视图的桶数仍受上限约束（实得 ${coarse.buckets}）`);

    // 切纵轴：不重新请求，直接重画成 token
    await page.click('#usageChartControls [data-usage-metric="tokens"]');
    assert.match(await page.textContent('#usageChartTotal'), /token/, '切到 token 后合计显示 token 数');
    assert.equal(await page.getAttribute('#usageChartControls [data-usage-metric="tokens"]', 'class'), 'tag active', 'token 按钮应处于选中态');
    await page.click('#usageChartControls [data-usage-metric="cost"]');
    assert.match(await page.textContent('#usageChartTotal'), /^¥\d/, '切回花费');

    // 回到 24 小时，避免影响后续断言
    await page.click('#usageChartControls [data-usage-hours="24"]');
    await page.waitForFunction(() => document.querySelector('#usageChartControls [data-usage-hours="24"]')?.classList.contains('active'));
  });

  if (!original) await test('Mobile and tablet layouts have no document-level horizontal overflow', async () => {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of views) {
        await navigate(view);
        const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(dimensions.document <= dimensions.viewport + 1, `${width}px / ${view}: ${JSON.stringify(dimensions)}`);
        if (artifacts && width === 390 && ['overview', 'social-v2', 'slang'].includes(view)) {
          await mkdir(resolve(artifacts), { recursive: true });
          await page.screenshot({ path: resolve(artifacts, `mobile-${view}.png`), fullPage: true, animations: 'disabled' });
        }
      }
    }
  });

  if (!original) await test('Dark mode toggles, persists across reload and stays overflow-free', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const snapshot = () => page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem('qq-console-theme'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      toggle: document.getElementById('themeToggle').getAttribute('aria-pressed'),
    }));
    const light = await snapshot();
    assert.equal(light.theme, 'light', '测试环境系统偏好为浅色，默认应为浅色');
    await page.locator('#themeToggle').click();
    const dark = await snapshot();
    assert.equal(dark.theme, 'dark');
    assert.equal(dark.stored, 'dark', '主题选择需要写入 localStorage');
    assert.equal(dark.toggle, 'true', 'aria-pressed 需要反映当前主题');
    assert.equal(dark.scheme, 'dark', 'color-scheme 需同步，滚动条与表单控件才会跟随');
    assert.notEqual(dark.bodyBg, light.bodyBg, 'body 背景色必须真的改变');
    assert.notEqual(dark.text, light.text, '正文颜色必须真的改变');
    const ratio = await page.evaluate(() => {
      const parse = value => value.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
      const luminance = rgb => { const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const background = luminance(parse(getComputedStyle(document.body).backgroundColor));
      const heading = luminance(parse(getComputedStyle(document.querySelector('h1')).color));
      return (Math.max(background, heading) + 0.05) / (Math.min(background, heading) + 0.05);
    });
    assert(ratio >= 7, `深色下标题与背景对比度不足：${ratio.toFixed(2)}`);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    assert.equal((await snapshot()).theme, 'dark', '刷新后应保持深色');
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
      assert(dimensions.document <= dimensions.viewport + 1, `深色 ${width}px 出现横向溢出：${JSON.stringify(dimensions)}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#themeToggle').click();
    assert.equal((await snapshot()).theme, 'light', '应能切回浅色');
  });

  if (!original) await test('Console follows the system preference when no theme was chosen', async () => {
    const systemDark = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', serviceWorkers: 'block' });
    await systemDark.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort('blockedbyclient'));
    const systemPage = await systemDark.newPage();
    systemPage.on('pageerror', error => errors.push(error.message));
    await systemPage.goto(fixture.url);
    await systemPage.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    assert.equal(await systemPage.evaluate(() => document.documentElement.dataset.theme), 'dark', '系统偏好深色时应默认深色');
    await systemDark.close();
  });

  if (!original) await test('Reduced-motion preference disables decorative motion', async () => {
    const calm = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await calm.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort('blockedbyclient'));
    const calmPage = await calm.newPage();
    calmPage.on('pageerror', error => errors.push(error.message));
    await calmPage.goto(fixture.url);
    await calmPage.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    const motion = await calmPage.evaluate(() => ({
      decor: getComputedStyle(document.querySelector('.bg-decor'), '::before').animationName,
      page: getComputedStyle(document.querySelector('[data-page="overview"]')).animationName,
      transition: getComputedStyle(document.querySelector('button')).transitionDuration,
    }));
    assert.equal(motion.decor, 'none', '背景动效应在 reduced-motion 下关闭');
    assert.equal(motion.page, 'none', '页面切换动画应在 reduced-motion 下关闭');
    assert.equal(motion.transition, '0s', '过渡应在 reduced-motion 下关闭');
    await calm.close();
  });

  if (!original) await test('人格管理：新建 → 载入编辑 → 保存修改 → 重命名 → 删除', async () => {
    await navigate('persona');
    const created = '回归人格A';
    const renamed = '回归人格B';
    const namesInList = () => page.locator('#roleList .persona-item strong').allTextContents();
    await page.locator('#newRoleName').fill(created);
    await page.locator('#newRoleContent').fill('# 回归人格A\n\n- 性格：用于回归测试');
    const [createRes] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/create' && r.request().method() === 'POST'),
      page.locator('#roleCreate').click(),
    ]);
    assert.equal(createRes.status(), 200);
    await page.waitForFunction((n) => [...document.querySelectorAll('#roleList .persona-item strong')].some((el) => el.textContent === n), created);
    // 点列表载入编辑：内容回填 + 按钮切到「保存修改」
    await page.locator('#roleList .persona-item').filter({ hasText: created }).first().click();
    await page.waitForFunction((n) => document.getElementById('newRoleName').value === n, created);
    assert.match(await page.locator('#newRoleContent').inputValue(), /用于回归测试/);
    assert.equal((await page.locator('#roleCreate').textContent()).trim(), '保存修改');
    // 保存修改
    await page.locator('#newRoleContent').fill('# 回归人格A\n\n- 性格：已修改');
    const [updateRes] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/update' && r.request().method() === 'POST'),
      page.locator('#roleCreate').click(),
    ]);
    assert.equal(updateRes.status(), 200);
    // 重命名（编辑模式改名后再保存 = 先 rename 再 update），等列表真正刷新
    await page.locator('#newRoleName').fill(renamed);
    await page.locator('#roleCreate').click();
    await page.waitForFunction((n) => [...document.querySelectorAll('#roleList .persona-item strong')].some((el) => el.textContent === n), renamed);
    assert.match(await page.locator('#roleCreateMsg').textContent(), new RegExp(`已保存「${renamed}」`));
    assert.ok((await namesInList()).includes(renamed), '重命名后列表应出现新名字');
    assert.ok(!(await namesInList()).includes(created), '重命名后旧名字应消失');
    // 删除（会弹确认框，测试环境自动接受）
    const [deleteRes] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/delete' && r.request().method() === 'POST'),
      page.locator('#roleDelete').click(),
    ]);
    assert.equal(deleteRes.status(), 200);
    await page.waitForFunction((n) => ![...document.querySelectorAll('#roleList .persona-item strong')].some((el) => el.textContent === n), renamed);
    assert.match(await page.locator('#roleCreateMsg').textContent(), /已删除/);
  });

  if (!original) await test('仿真提示词默认可查看、解锁后可编辑、保存后提示需重启 DSH', async () => {
    await navigate('persona');
    await page.waitForFunction(() => document.getElementById('simPromptText').value.length > 0);
    assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), '', '默认应为只读');
    assert.equal(await page.locator('#simPromptSave').isDisabled(), true, '只读时不应能保存');
    assert.match(await page.locator('#layer-note, .layer-note').first().textContent(), /仿真提示词/, '页面应说明两层提示词的边界');
    await page.locator('#simPromptEdit').click();
    assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), null, '解锁后应可编辑');
    assert.equal(await page.locator('#simPromptSave').isDisabled(), false);
    const edited = (await page.locator('#simPromptText').inputValue()) + '\n\n【回归追加】一句测试规则。';
    await page.locator('#simPromptText').fill(edited);
    const [saved] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/preset/sim-prompt' && r.request().method() === 'POST'),
      page.locator('#simPromptSave').click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.equal((await saved.json()).ok, true);
    assert.match(await page.locator('#simPromptMsg').textContent(), /重启 DSH/, '保存后必须提示重启 DSH');
    assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), '', '保存后应回到只读');
  });

  if (!original) await test('仿真提示词可切换到一代/二代，两代内容相互独立', async () => {
    await navigate('persona');
    await page.waitForFunction(() => document.getElementById('simPromptText').value.length > 0);
    const v2 = await page.locator('#simPromptText').inputValue();
    assert.match(await page.locator('#simPromptStatus').textContent(), /二代仿真|qq-chat-v2/);
    await page.locator('#simPromptPreset').selectOption('qq-chat');
    await page.waitForFunction((prev) => document.getElementById('simPromptText').value !== prev, v2);
    const v1 = await page.locator('#simPromptText').inputValue();
    assert.notEqual(v1, v2, '两代预设的提示词应各自独立');
    assert.match(await page.locator('#simPromptStatus').textContent(), /一代仿真|qq-chat/);
    // 切回二代，避免影响后续断言
    await page.locator('#simPromptPreset').selectOption('qq-chat-v2');
    await page.waitForFunction((prev) => document.getElementById('simPromptText').value === prev, v2);
  });

  if (!original) await test('人格注入上限可调，且随模式筛选后统计', async () => {
    await navigate('persona');
    await page.waitForFunction(() => document.querySelectorAll('#roleList .persona-item').length > 0);
    const before = await page.locator('#roleInjectMax').inputValue();
    assert.equal(Number(before), 6000, '默认上限应为 6000');
    await page.locator('#roleInjectMax').fill('8000');
    const [saved] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/limit' && r.request().method() === 'POST'),
      page.locator('#roleInjectMaxSave').click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.equal((await saved.json()).maxInjectChars, 8000);
    assert.match(await page.locator('#roleInjectMaxMsg').textContent(), /8000/);
    // 改回默认
    await page.locator('#roleInjectMax').fill('6000');
    await page.locator('#roleInjectMaxSave').click();
    await page.waitForFunction(() => document.getElementById('roleInjectMaxMsg').textContent.includes('6000'));
  });

  if (!original) await test('思考强度：档位来自 DSH、默认 max、可切换并明示全局副作用', async () => {
    await navigate('runtime');
    await page.waitForFunction(() => document.getElementById('dshEffortSelect').options.length > 0);
    const options = await page.locator('#dshEffortSelect option').evaluateAll((nodes) => nodes.map((n) => n.value));
    assert.deepEqual(options, ['low', 'high', 'max'], `档位应来自 DSH 公布的能力，实际 ${options.join(',')}`);
    assert.equal(await page.locator('#dshEffortSelect').inputValue(), 'max', '默认应为 max');
    assert.match(await page.locator('#dshEffortSideEffect').textContent(), /全局默认/, '必须说明会连带改 DSH 全局默认');
    await page.locator('#dshEffortSelect').selectOption('high');
    const [saved] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/dsh/effort' && r.request().method() === 'POST'),
      page.locator('#dshEffortSave').click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.equal((await saved.json()).reasoningEffort, 'high');
    assert.match(await page.locator('#dshEffortMsg').textContent(), /high/);
    // 改回默认，避免影响后续断言
    await page.locator('#dshEffortSelect').selectOption('max');
    await page.locator('#dshEffortSave').click();
    await page.waitForFunction(() => document.getElementById('dshEffortSelect').value === 'max');
  });

  if (artifacts) {
    await mkdir(resolve(artifacts), { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const view of original ? ['overview'] : ['overview', 'persona', 'social-v2', 'slang', 'access']) {
      await navigate(view);
      await page.screenshot({ path: resolve(artifacts, `${original ? 'original' : 'desktop'}-${view}.png`), fullPage: true, animations: 'disabled' });
    }
    if (!original) {
      await page.locator('#themeToggle').click();
      for (const view of ['overview', 'social-v2']) {
        await navigate(view);
        await page.screenshot({ path: resolve(artifacts, `dark-${view}.png`), fullPage: true, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await navigate('overview');
      await page.screenshot({ path: resolve(artifacts, 'dark-mobile-overview.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('#themeToggle').click();
    }
  }
  if (!original) await test('Character hotspots explain on hover and navigate on click or keyboard without writes', async () => {
    const before = fixture.requests.length;
    const destinations = { eyes: 'vision', ears: 'hearing', mouth: 'voice', heart: 'persona', memory: 'memory' };
    for (const [key, destination] of Object.entries(destinations)) {
      await navigate('overview');
      const hotspot = page.locator(`[data-hotspot="${key}"]`);
      await hotspot.hover();
      assert.equal(await page.evaluate(() => document.body.dataset.consolePage), 'overview', 'Hover must not unexpectedly switch pages');
      assert.match(await page.textContent('#hotspotCaption'), /点击前往/);
      if (key === 'ears') { await hotspot.focus(); await hotspot.press('Enter'); }
      else await hotspot.click();
      assert.equal(await page.evaluate(() => document.body.dataset.consolePage), destination);
    }
    assert.equal(fixture.requests.length, before, 'Hotspots must never change settings');
    await navigate('overview');
    await page.locator('.mascot-motion-toggle').click();
    assert.equal(await page.locator('.mascot-motion-toggle').getAttribute('aria-pressed'), 'true');
    await page.reload();
    await page.waitForSelector('#companionStage.motion-paused');
    await page.locator('.mascot-motion-toggle').click();
  });

  if (!original) await test('Parameter help supports focus, Escape, search aliases and hidden setting sections', async () => {
    await fill('v2ProactiveProbability', '0.65');
    await page.locator('#v2ProactiveProbability + .help-trigger').focus();
    assert(await page.locator('#parameterTooltip').isVisible());
    assert.match(await page.textContent('#parameterTooltip'), /冷场.*基础概率/);
    assert.match(await page.locator('#v2ProactiveProbability').getAttribute('aria-describedby'), /setting-help-/);
    assert.match(await page.textContent('#proactiveImpact'), /65%/);
    await page.keyboard.press('Escape');
    assert(!await page.locator('#parameterTooltip').isVisible());
    await page.locator('#consoleSearch').fill('v2WaitDefaultQuietMs');
    await page.locator('#searchResults button').first().click();
    assert(await page.locator('#v2WaitDefaultQuietMs').isVisible(), 'Search opens the rhythm section and its disclosure');
    assert.equal(await page.locator('[data-pane="rhythm"]').getAttribute('aria-selected'), 'true');
    await page.locator('#consoleSearch').fill('冒泡');
    assert.match(await page.textContent('#searchResults'), /触发概率|主动冒泡/);
    await page.keyboard.press('Escape');
  });

  if (!original) await test('Cross-page drafts use one complete save and preserve voice credentials', async () => {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('v2AgentPreset')?.value === 'contract-v2');
    await fill('v2ProactiveProbability', '0.45');
    await fill('v2AsrIdleUnloadMin', '3');
    await navigate('persona');
    assert(await page.locator('#sharedSettingsSave').isVisible(), 'Pending edits remain visible outside their source category');
    assert.match(await page.textContent('.save-draft-label'), /2 项未保存/);
    const body = await clickWrite('#v2ConfigSave', '/api/socialV2/config');
    assert.equal(body.proactive.probability, 0.45);
    assert.equal(body.asr.idleUnloadMs, 180000);
    assert.equal(body.speak.mimo.apiKey, '********');
    await page.waitForFunction(() => document.querySelector('.save-draft-label')?.textContent === '设置已同步');
    await navigate('hearing');
    assert.equal(await page.inputValue('#v2AsrIdleUnloadMin'), '3');
  });

  if (!original) await test('Visual ability save retains all global feature flags', async () => {
    await navigate('vision');
    const before = await page.locator('[data-feature]').evaluateAll(inputs => Object.fromEntries(inputs.map(input => [input.dataset.feature, input.checked])));
    await page.locator('[data-feature="images"]').setChecked(!before.images);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/features' && r.request().method() === 'POST');
    await page.locator('#section-vision .primary').click();
    assert.equal((await response).status(), 200);
    assert.deepEqual(fixture.requests.at(-1).body, { ...before, images: !before.images });
  });

  if (!original) await test('An older running bridge without the new assets retains a usable legacy console', async () => {
    const legacy = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const legacyErrors = [];
    await legacy.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === fixture.url && !url.pathname.startsWith('/console-assets/') ? route.continue() : route.abort('blockedbyclient');
    });
    const legacyPage = await legacy.newPage(); legacyPage.on('pageerror', error => legacyErrors.push(error.message));
    await legacyPage.goto(fixture.url);
    await legacyPage.waitForFunction(() => document.getElementById('v2AgentPreset')?.value === 'contract-v2');
    await legacyPage.locator('#mainNav [data-view="social-v2"]').click();
    assert(await legacyPage.locator('#v2ConfigSaveTop').isVisible());
    assert.equal(await legacyPage.locator('#mainNav [data-view]').count(), 11);
    assert.deepEqual(legacyErrors, []);
    await legacy.close();
  });

  await test('No JavaScript errors, unknown API routes or external requests', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.unknownRequests, []);
    assert.deepEqual(blockedRequests, []);
  });
} finally {
  if (browser) await browser.close();
  await fixture.close();
  if (artifacts) {
    await mkdir(resolve(artifacts), { recursive: true });
    await writeFile(resolve(artifacts, 'test-results.json'), JSON.stringify({ original, results, requests: fixture.requests, errors, blockedRequests }, null, 2) + '\n');
  }
}
const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${fixture.requests.length} isolated mock writes.`);
if (failed.length) process.exitCode = 1;
