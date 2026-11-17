// 状态文件「合并写」的回归。
//
// 背景：social-v2.json 以前每来一条消息就全量 stringify + 原子写（52 个调用点），
// 会话越多，单次同步写越贵，而且卡在 mux 事件循环和 MCP 工具线程上。合并写把
// 250ms 内的多次变更压成一次，并且**推迟快照生成**到落盘那一刻。
//
// 这里用假定时器验证：只写一次、写的是最后一次的状态、失败不抛、flush 幂等。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCoalescedWriter } from '../src/state-writer.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutImpl(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(handle) {
      if (handle && typeof handle === 'object') timers.delete(handle.id);
    },
    fireAll() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.fn();
      }
    },
    get count() { return timers.size; },
  };
}

// 1) 窗口内的多次 schedule 只落盘一次，且落的是最新快照
{
  const timers = fakeTimers();
  const writes = [];
  const writer = createCoalescedWriter({ delayMs: 250, setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
  for (let i = 1; i <= 5; i++) writer.schedule(() => writes.push(`snapshot-${i}`));
  assert.equal(writes.length, 0, '窗口内不应立刻写盘');
  assert.equal(timers.count, 1, '多次变更只挂一个定时器');
  assert.equal(writer.pending, true);
  timers.fireAll();
  assert.deepEqual(writes, ['snapshot-5'], '只写一次，且是最后一次的状态');
  assert.equal(writer.pending, false);
  assert.equal(writer.stats.writes, 1);
  console.log('  ✅ 合并：5 次变更 → 1 次落盘，写的是最新态');
}

// 2) flush 立刻落盘，并清掉定时器；重复 flush 无副作用
{
  const timers = fakeTimers();
  const writes = [];
  const writer = createCoalescedWriter({ delayMs: 250, setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
  writer.schedule(() => writes.push('a'));
  assert.equal(writer.flush(), true);
  assert.deepEqual(writes, ['a']);
  assert.equal(timers.count, 0, 'flush 要清掉待触发的定时器');
  assert.equal(writer.flush(), false, '没有待写内容时 flush 返回 false');
  assert.equal(writes.length, 1);
  console.log('  ✅ flush：立即落盘 + 清定时器 + 幂等');
}

// 3) flush 之后还能继续 schedule
{
  const timers = fakeTimers();
  const writes = [];
  const writer = createCoalescedWriter({ delayMs: 100, setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
  writer.schedule(() => writes.push('first'));
  writer.flush();
  writer.schedule(() => writes.push('second'));
  assert.equal(timers.count, 1, '新变更要重新挂定时器');
  timers.fireAll();
  assert.deepEqual(writes, ['first', 'second']);
  console.log('  ✅ 生命周期：flush 之后仍可继续合并写');
}

// 4) 快照构造函数抛错：不冒泡、记 lastError，下次变更还能继续
{
  const timers = fakeTimers();
  const errors = [];
  const writer = createCoalescedWriter({
    delayMs: 10,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    log: (...args) => errors.push(args.join(' ')),
  });
  writer.schedule(() => { throw new Error('disk full'); });
  assert.doesNotThrow(() => writer.flush(), '落盘失败不能把调用方带崩');
  assert.equal(writer.stats.lastError?.message, 'disk full');
  assert.equal(errors.length, 1, '失败要打一条日志');
  const writes = [];
  writer.schedule(() => writes.push('ok'));
  timers.fireAll();
  assert.deepEqual(writes, ['ok'], '失败之后还能正常写');
  assert.equal(writer.stats.lastError, null);
  console.log('  ✅ 失败隔离：抛错不冒泡、记日志、后续仍可用');
}

// 5) 参数校验 + 零延迟
{
  const writer = createCoalescedWriter({ delayMs: 0, setTimeoutImpl: (fn) => { fn(); return { unref() {} }; }, clearTimeoutImpl: () => {} });
  let wrote = 0;
  writer.schedule(() => { wrote += 1; });
  assert.equal(wrote, 1, 'delayMs=0 时下一个 tick 就写（假定时器同步触发）');
  assert.throws(() => writer.schedule(null), /需要一个返回快照的函数/);
  console.log('  ✅ 边界：delayMs=0 立即写；非法参数抛 TypeError');
}

// 6) 桥接接线：saveSocialV2State 必须真的走合并写，flush 后才能读到最新态
{
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456'] } } });
  try {
    const file = path.join(h.temp, 'data', 'social-v2.json');
    h.appendSocialV2Message('group:456', '小明', '只在内存里的这句', '只在内存里的这句', false, false, '1', [], '111', []);
    const early = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    assert.ok(!early.includes('只在内存里的这句'), '合并写窗口内不应立刻落盘');
    h.flushSocialV2State();
    const late = fs.readFileSync(file, 'utf8');
    assert.ok(late.includes('只在内存里的这句'), 'flush 之后必须能读到最新态');
  } finally {
    await h.close();
  }
  console.log('  ✅ 桥接接线：消息先进内存、flush 后落盘');
}

console.log('\nPASS');
