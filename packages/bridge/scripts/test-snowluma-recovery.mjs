// SnowLuma 上游卡死的自动重启策略（纯函数）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldAutoRestartSnowluma } from '../src/snowluma-recovery.js';

test('默认关闭；未连接/没有收到过包/冷却中都不重启', () => {
  assert.equal(shouldAutoRestartSnowluma({}), false);
  assert.equal(shouldAutoRestartSnowluma({ enabled: true, connected: false, lastPacketAt: 1, now: 999999, staleMs: 1 }), false);
  assert.equal(shouldAutoRestartSnowluma({ enabled: true, connected: true, lastPacketAt: 0, now: 999999, staleMs: 1 }), false);
  assert.equal(shouldAutoRestartSnowluma({ enabled: true, connected: true, lastPacketAt: 1000, now: 999999, staleMs: 60000, lastRestartAt: 990000, cooldownMs: 900000 }), false);
  assert.equal(shouldAutoRestartSnowluma({ enabled: true, connected: true, lastPacketAt: 1000, now: 999999, staleMs: 60000, restarting: true }), false);
});

test('超过 staleMs 自动重启；good=false 立刻触发', () => {
  assert.equal(shouldAutoRestartSnowluma({ enabled: true, connected: true, lastPacketAt: 1000, now: 1000 + 180001, staleMs: 180000 }), true);
  assert.equal(shouldAutoRestartSnowluma({ enabled: true, connected: true, lastPacketAt: 1000, now: 2000, staleMs: 180000, good: false }), true);
});

test('冷却后会允许下一次重启', () => {
  assert.equal(shouldAutoRestartSnowluma({ enabled: true, connected: true, lastPacketAt: 1000, now: 1000000, staleMs: 60000, lastRestartAt: 1000, cooldownMs: 900000 }), true);
});

test('连不上（OneBot 不在）也要能自愈：断开 5 分钟起重启，最多 3 次', () => {
  const base = { enabled: true, connected: false, now: 1_000_000, autoRestartOnStale: true };
  // 还没到阈值 / 没有断开起点 → 不重启
  assert.equal(shouldAutoRestartSnowluma({ ...base, disconnectedSince: 1_000_000 - 60_000 }), false);
  assert.equal(shouldAutoRestartSnowluma({ ...base, disconnectedSince: 0 }), false);
  // 断开 5 分钟 → 重启
  assert.equal(shouldAutoRestartSnowluma({ ...base, disconnectedSince: 1_000_000 - 300_001 }), true);
  // 已连试 3 次仍连不上 → 不再无脑重启（多半要扫码）
  assert.equal(shouldAutoRestartSnowluma({ ...base, disconnectedSince: 1_000_000 - 600_000, disconnectedRestarts: 3 }), false);
  // 冷却期内也不重启
  assert.equal(shouldAutoRestartSnowluma({ ...base, disconnectedSince: 1_000_000 - 600_000, lastRestartAt: 1_000_000 - 60_000 }), false);
});

test('自定义阈值生效', () => {
  const base = { enabled: true, connected: false, now: 1_000_000 };
  assert.equal(shouldAutoRestartSnowluma({ ...base, disconnectedSince: 1_000_000 - 90_000, disconnectedRestartMs: 60_000 }), true);
  assert.equal(shouldAutoRestartSnowluma({ ...base, disconnectedSince: 1_000_000 - 90_000, disconnectedRestartMs: 120_000 }), false);
});
