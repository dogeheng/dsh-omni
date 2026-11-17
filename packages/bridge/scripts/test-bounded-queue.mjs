// mux 事件中转队列的上限与"通知类发送不阻塞事件流"的接线回归。
//
// 事故形态：事件流消费端（bridge 的 for await 循环）会 await QQ 发送，慢发送期间
// 事件只能往一个**无上限**数组里堆；同时那 5 处通知（拦截/出错/停止/提问/审批）
// 每个都要 sleep(sendDelayMs) + 一次 OneBot 往返，等于把整条事件流按 300ms 起一跳。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBoundedQueue } from '../src/bounded-queue.js';

// 1) 基本 FIFO
{
  const q = createBoundedQueue({ max: 3 });
  q.push('a'); q.push('b');
  assert.equal(q.length, 2);
  assert.equal(q.shift(), 'a');
  assert.equal(q.shift(), 'b');
  assert.equal(q.shift(), undefined);
  assert.equal(q.length, 0);
  console.log('  ✅ 基本 FIFO');
}

// 2) 超限丢最旧，并且回调告诉我们丢了什么
{
  const lost = [];
  const q = createBoundedQueue({ max: 2, onDrop: (item, dropped) => lost.push([item, dropped]) });
  q.push(1); q.push(2); q.push(3); q.push(4);
  assert.equal(q.length, 2, '长度压回上限');
  assert.deepEqual(q.snapshot(), [3, 4], '留下的是最新的');
  assert.deepEqual(lost, [[1, 1], [2, 2]], '每丢一条回调一次，带累计计数');
  assert.equal(q.dropped, 2);
  console.log('  ✅ 超限丢最旧 + 计数/回调');
}

// 3) 终结标记不会被"丢最旧"误伤（它永远是最新入队的那个）
{
  const q = createBoundedQueue({ max: 1 });
  q.push({ kind: 'event', n: 1 });
  q.push({ kind: 'end' });
  assert.equal(q.length, 1);
  assert.deepEqual(q.shift(), { kind: 'end' });
  console.log('  ✅ end 标记保留');
}

// 4) 非法参数兜底
{
  const q = createBoundedQueue({ max: 0 });
  q.push('x'); q.push('y');
  assert.equal(q.length, 1, 'max<=0 兜底为 1');
  assert.deepEqual(q.snapshot(), ['y']);
  const noisy = createBoundedQueue({ max: 1, onDrop: () => { throw new Error('回调炸了'); } });
  assert.doesNotThrow(() => { noisy.push(1); noisy.push(2); }, '回调抛错不能影响队列');
  console.log('  ✅ 非法参数与回调异常兜底');
}

// 5) 接线契约：dsh-client 用有界队列；bridge 的通知发送不再 await
{
  const client = fs.readFileSync(fileURLToPath(new URL('../src/dsh-client.js', import.meta.url)), 'utf8');
  assert.match(client, /createBoundedQueue\(\{/, 'mux 的 inbox 必须是有限队列');
  assert.match(client, /MUX_INBOX_MAX/, '上限要是具名常量，便于排障');
  const bridge = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');
  for (const needle of ["sendNotice(key, '⏹️ 已停止'", "sendNotice(key, '❓ agent 需要你回答", "sendNotice(key, `🔐 agent 请求审批", "sendNotice(key, '⚠️ 刚才处理出错了"]) {
    assert.ok(bridge.includes(needle), `通知发送要走 sendNotice（不阻塞事件流）：${needle}`);
  }
  assert.ok(!bridge.includes("await sendToQQ(key, '⏹️ 已停止')"), '通知发送不得再 await（会拖住整条事件流）');
  console.log('  ✅ 接线契约：有界 inbox + 通知不阻塞');
}

console.log('\nPASS');
