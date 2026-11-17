// mux 事件中转队列的上限、优先级丢弃与"通知类发送不阻塞事件流"的接线回归。
//
// 事故形态：事件流消费端（bridge 的 for await 循环）会 await QQ 发送，慢发送期间
// 事件只能往一个**无上限**数组里堆；同时那 5 处通知（拦截/出错/停止/提问/审批）
// 每个都要 sleep(sendDelayMs) + 一次 OneBot 往返，等于把整条事件流按 300ms 起一跳。
//
// 积压丢弃的优先级回归：满了先丢可降级的流式 token（assistant/chunk，collector 与
// token 账本都不读），丢完仍满才丢最旧；终结标记 {kind:'end'} 永远不能被优先丢。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBoundedQueue } from '../src/bounded-queue.js';

// 与 dsh-client.js 里 inbox 的 preferDrop 同形的辅助构造：队列项是
// `{ kind:'frame', envelope:{ payload } }` 包装（不是裸 envelope）。
const muxChunk = (n = 0) => ({
  kind: 'frame',
  envelope: { payload: { type: 'session/event', event: { type: 'assistant/chunk', data: { delta: String(n) } } } }
});
const muxEvent = (type, n = 0) => ({
  kind: 'frame',
  envelope: { payload: { type: 'session/event', event: { type, data: { n } } } }
});
const isMuxChunk = (item) => item?.envelope?.payload?.type === 'session/event'
  && item?.envelope?.payload?.event?.type === 'assistant/chunk';

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
  const badPredicate = createBoundedQueue({ max: 1, preferDrop: () => { throw new Error('分类器炸了'); } });
  assert.doesNotThrow(() => { badPredicate.push({ kind: 'a' }); badPredicate.push({ kind: 'b' }); }, '分类器抛错不能影响队列');
  assert.deepEqual(badPredicate.snapshot(), [{ kind: 'b' }], '分类器抛错时回退到丢最旧');
  const notAFunction = createBoundedQueue({ max: 1, preferDrop: 'assistant/chunk' });
  notAFunction.push(1); notAFunction.push(2);
  assert.deepEqual(notAFunction.snapshot(), [2], 'preferDrop 非函数时等价于不传');
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

// 6) 满时优先丢 chunk，普通事件保留
{
  const lost = [];
  const q = createBoundedQueue({ max: 3, preferDrop: isMuxChunk, onDrop: (item) => lost.push(item) });
  const first = muxEvent('assistant/message', 1);
  const chunk = muxChunk(1);
  const last = muxEvent('turn/end', 1);
  q.push(first); q.push(chunk); q.push(last);
  assert.equal(q.length, 3);
  q.push(muxChunk(2)); // 溢出：丢掉最前面的 chunk（一条就够回到上限）
  assert.deepEqual(q.snapshot(), [first, last, muxChunk(2)], '普通事件保留且顺序不变，丢的是旧 chunk');
  assert.equal(q.dropped, 1);
  assert.equal(lost.length, 1, 'onDrop 回调一次');
  assert.equal(lost[0]?.envelope?.payload?.event?.type, 'assistant/chunk', '回调收到的是被丢的 chunk');
  console.log('  ✅ 溢出优先丢 chunk、普通事件保留');
}

// 7) 队列里没有 chunk 时退回丢最旧
{
  const q = createBoundedQueue({ max: 2, preferDrop: isMuxChunk });
  q.push(muxEvent('assistant/message', 1));
  q.push(muxEvent('assistant/message', 2));
  q.push(muxEvent('assistant/message', 3));
  assert.deepEqual(
    q.snapshot().map((item) => item.envelope.payload.event.data.n),
    [2, 3],
    '没有可优先丢弃项时，行为与原来的"丢最旧"一致'
  );
  assert.equal(q.dropped, 1);
  console.log('  ✅ 无 chunk 时退回丢最旧');
}

// 8) {kind:'end'} 永远不会被优先丢
{
  // 真实接线里的事故形态：chunk 和 end 挤在极小上限里，还必须保住 end。
  const q = createBoundedQueue({ max: 1, preferDrop: isMuxChunk });
  q.push(muxChunk(1));
  q.push({ kind: 'end' });
  assert.equal(q.length, 1);
  assert.deepEqual(q.shift(), { kind: 'end' }, 'end 不能被优先丢');

  // end 没有 envelope/payload 形状：即使谓词命中所有 frame 包装的事件项，也不会命中它。
  const broader = createBoundedQueue({ max: 1, preferDrop: (item) => item?.kind === 'frame' });
  broader.push({ kind: 'end' });
  broader.push(muxEvent('assistant/message', 1));
  assert.deepEqual(broader.shift(), { kind: 'end' }, 'end 不属于可优先丢弃项');
  console.log('  ✅ end 标记永远不会被优先丢');
}

// 9) 大量 chunk 灌入后，普通事件的条数与顺序不变
{
  const normals = Array.from({ length: 5 }, (_, i) => muxEvent('assistant/message', i));
  const q = createBoundedQueue({ max: 5, preferDrop: isMuxChunk });
  for (const normal of normals) q.push(normal);
  for (let i = 0; i < 2000; i += 1) q.push(muxChunk(i));
  assert.equal(q.length, 5, '长度始终压在上限内');
  assert.deepEqual(q.snapshot(), normals, '普通事件一条不少、顺序不变');
  assert.equal(q.dropped, 2000, '2000 条 chunk 全被优先丢弃');
  // 灌完 chunk 后再来普通事件：此时没有 chunk 可丢，才回退丢最旧。
  const extra = muxEvent('assistant/message', 5);
  q.push(extra);
  assert.deepEqual(q.snapshot(), [...normals.slice(1), extra], 'chunk 耗尽后才回退丢最旧');
  console.log('  ✅ 大量 chunk 灌入后普通事件条数与顺序不变');
}

// 10) 接线契约：dsh-client 的 inbox 真的传了 preferDrop，且分类器指向 assistant/chunk
{
  const client = fs.readFileSync(fileURLToPath(new URL('../src/dsh-client.js', import.meta.url)), 'utf8');
  const start = client.indexOf('createBoundedQueue({');
  assert.ok(start >= 0, 'dsh-client 必须用 createBoundedQueue');
  const end = client.indexOf('\n    });', start);
  assert.ok(end > start, '能定位到 createBoundedQueue 的选项块');
  const block = client.slice(start, end);
  assert.match(block, /preferDrop:\s*\(item\)\s*=>/, 'inbox 必须传 preferDrop 分类器');
  assert.match(block, /item\?\.envelope\?\.payload\?\.type\s*===\s*'session\/event'/, '分类器要按实际队列项形状（envelope 包装）判断事件类型');
  assert.match(block, /item\?\.envelope\?\.payload\?\.event\?\.type\s*===\s*'assistant\/chunk'/, '优先丢弃项必须指向 assistant/chunk');
  assert.ok(!/kind\s*===\s*'end'/.test(block), 'end 不得进入优先丢弃分类器');
  console.log('  ✅ 接线契约：inbox 的 preferDrop 指向 assistant/chunk');
}

console.log('\nPASS');
