// 离电省电策略的离线单测（src/power.js）。
// 只测纯函数与状态机：不真的调用 pmset、不碰 QQ/DSH、不写仓库 data/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_BATTERY_ALLOW,
  POWER_CAPABILITY_IDS,
  createPowerMonitor,
  decidePowerPolicy,
  normalizePowerConfig,
  parsePmsetBattery,
  parsePmsetLowPower,
  powerAllowsCapability,
  powerCapabilityForPath,
  powerPromptLine,
  powerRefusal,
  readPowerState,
} from '../src/power.js';

const AC_TEXT = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=22610019)\t100%; charged; 0:00 remaining present: true\n";
const BATTERY_TEXT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22610019)\t82%; discharging; 4:12 remaining present: true\n";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'power-test-'));
}

test('pmset 输出解析：插电 / 电池 / 台式机 / 垃圾输入', () => {
  assert.deepEqual(parsePmsetBattery(AC_TEXT), { source: 'ac', percent: 100, charging: true });
  assert.deepEqual(parsePmsetBattery(BATTERY_TEXT), { source: 'battery', percent: 82, charging: false });
  // 台式机：只有第一行，没有电池
  assert.deepEqual(parsePmsetBattery("Now drawing from 'AC Power'\n"), { source: 'ac', percent: null, charging: null });
  // 空/异常输入不能猜成 battery，否则会误伤能力
  assert.deepEqual(parsePmsetBattery(''), { source: 'unknown', percent: null, charging: null });
  assert.equal(parsePmsetLowPower(' lowpowermode         1\n'), true);
  assert.equal(parsePmsetLowPower(' lowpowermode         0\n'), false);
  assert.equal(parsePmsetLowPower(''), false);
});

test('配置归一化：默认值、非法值收敛、未知能力被丢弃', () => {
  const d = normalizePowerConfig(undefined);
  assert.equal(d.enabled, true);
  assert.equal(d.pollMs, 15_000);
  assert.equal(d.debounceMs, 10_000);
  assert.deepEqual(d.battery.allow, DEFAULT_BATTERY_ALLOW);
  assert.equal(d.battery.reasoningEffort, 'low');

  const weird = normalizePowerConfig({
    pollMs: 1,
    debounceMs: 999_999,
    battery: { allow: ['sing', 'nope', 'sing', 'memory'], reasoningEffort: 'TURBO' },
  });
  assert.equal(weird.pollMs, 5000);
  assert.equal(weird.debounceMs, 300_000);
  assert.deepEqual(weird.battery.allow, ['sing', 'memory']);
  assert.equal(weird.battery.reasoningEffort, 'low', '非法档位回退默认');
  assert.deepEqual(normalizePowerConfig({ battery: { allow: [] } }).battery.allow, DEFAULT_BATTERY_ALLOW);
});

test('策略判定：插电全放行、离电按白名单、关闭策略全放行', () => {
  const cfg = normalizePowerConfig({ battery: { allow: ['sticker', 'memory'] } });
  const ac = decidePowerPolicy(cfg, { source: 'ac' });
  assert.equal(ac.onBattery, false);
  assert.deepEqual(ac.deny, []);

  const battery = decidePowerPolicy(cfg, { source: 'battery' });
  assert.equal(battery.onBattery, true);
  assert.deepEqual(battery.allow, ['sticker', 'memory']);
  assert.deepEqual(battery.deny, POWER_CAPABILITY_IDS.filter((id) => !['sticker', 'memory'].includes(id)));

  const off = decidePowerPolicy(normalizePowerConfig({ enabled: false, battery: { allow: [] } }), { source: 'battery' });
  assert.deepEqual(off.deny, []);
});

test('能力放行：核心永远放行；未知/过期/读不到状态一律 fail-open', () => {
  const cfg = normalizePowerConfig({ battery: { allow: ['memory'] } });
  const battery = { source: 'battery' };
  assert.equal(powerAllowsCapability(cfg, battery, 'chat'), true);
  assert.equal(powerAllowsCapability(cfg, battery, 'memory'), true);
  assert.equal(powerAllowsCapability(cfg, battery, 'sing'), false);
  assert.equal(powerAllowsCapability(cfg, null, 'sing'), true);
  assert.equal(powerAllowsCapability(cfg, { source: 'unknown' }, 'sing'), true);
  assert.equal(powerAllowsCapability(cfg, { source: 'battery', stale: true }, 'sing'), true);
  assert.equal(powerAllowsCapability({ enabled: false }, battery, 'sing'), true);
});

test('路径 → 能力映射：只认智能体写路径', () => {
  assert.equal(powerCapabilityForPath('/api/socialV2/send-voice'), 'voice');
  assert.equal(powerCapabilityForPath('/api/socialV2/speak'), 'speak');
  assert.equal(powerCapabilityForPath('/api/socialV2/sing'), 'sing');
  assert.equal(powerCapabilityForPath('/api/socialV2/cover'), 'sing');
  assert.equal(powerCapabilityForPath('/api/images/message'), 'images');
  assert.equal(powerCapabilityForPath('/api/socialV2/memory-append'), 'memory');
  assert.equal(powerCapabilityForPath('/api/socialV2/send-sticker'), 'sticker');
  // 核心聊天/管理端点不归电源策略管
  for (const p of ['/api/socialV2/send-message', '/api/socialV2/wait', '/api/features', '/api/power', '/api/send/group']) {
    assert.equal(powerCapabilityForPath(p), null, p);
  }
});

test('拒答文案与提示词：只在电池+有禁用项时出现', () => {
  const refusal = powerRefusal('sing');
  assert.equal(refusal.code, 'POWER_SAVING');
  assert.match(refusal.error, /电池/);
  assert.match(refusal.error, /唱歌/);
  assert.match(refusal.hint, /不要重试/);

  const cfg = normalizePowerConfig({ battery: { allow: ['memory'] } });
  assert.equal(powerPromptLine(cfg, { source: 'ac' }), '');
  assert.equal(powerPromptLine(cfg, null), '');
  assert.equal(powerPromptLine({ enabled: false }, { source: 'battery' }), '');
  const line = powerPromptLine(cfg, { source: 'battery' });
  assert.match(line, /【电源】/);
  assert.match(line, /唱歌/);
  assert.doesNotMatch(line, /长期记忆/);
});

test('状态文件：读取、mtime 缓存与过期标记', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const file = path.join(root, 'data', 'power-state.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({
    source: 'battery', percent: 66, charging: false,
    sampledAt: new Date(now).toISOString(), committedAt: new Date(now).toISOString(),
  }));
  const fresh = readPowerState(root, { now });
  assert.equal(fresh.source, 'battery');
  assert.equal(fresh.stale, false);
  assert.equal(readPowerState(root, { now: now + 10_000, maxAgeMs: 1 }).stale, true);
  assert.equal(readPowerState(path.join(root, 'nope'), { now }), null);
});

test('监控状态机：首次立即生效、切换去抖、模拟绕过去抖', async () => {
  const root = tempRoot();
  let current = { source: 'ac', percent: 100, charging: true };
  let clock = 1_000_000;
  const changes = [];
  const monitor = createPowerMonitor({
    root,
    getConfig: () => ({ enabled: true, pollMs: 60_000, debounceMs: 20_000, battery: { allow: ['memory'] } }),
    sample: async () => ({ ...current }),
    now: () => clock,
    onChange: (prev, next, meta) => changes.push({ from: prev?.source ?? null, to: next.source, reason: meta.reason }),
  });
  const first = await monitor.start();
  assert.equal(first.source, 'ac');
  assert.equal(changes.length, 1, '首次采样立即生效，不等去抖');

  current = { source: 'battery', percent: 90, charging: false };
  await monitor.refresh();
  assert.equal(monitor.state().source, 'ac', '第一次看到电池只登记，不切换');
  clock += 21_000;
  await monitor.refresh();
  assert.equal(monitor.state().source, 'battery', '去抖窗口过后才切换');
  assert.equal(changes.at(-1).to, 'battery');

  await monitor.simulate('ac');
  assert.equal(monitor.state().source, 'ac', '模拟插电立即生效');
  await monitor.simulate(null);

  monitor.stop();
});
