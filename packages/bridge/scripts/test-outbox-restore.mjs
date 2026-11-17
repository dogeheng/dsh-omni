// 回归：桥接启动时必须把 data/outbox.json 读回内存队列。
//
// 事故形态：restoreOutboxDeliveries() 早就写好了，但 outbox.load() 从未被调用，
// 于是 pending() 永远是空数组 —— ARCHITECTURE 与函数注释里的「重启也不丢」
// 只存在于注释里。更隐蔽的一层：唤醒项故意不带 promptText（提示词在投递那一刻
// 才按 wakeReason 重拼），旧 load 的「空文本过滤」会把它们直接丢掉，而它们恰好
// 就是 DSH/桥接停机期间收到的 @ 和私聊。
//
// 本用例用 harness 的临时目录当 ROOT，不碰真实 data/ 与网络。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OUTBOX_FIXTURE = {
  version: 1,
  entries: [
    {
      id: 'persisted-text',
      key: 'group:456',
      payload: { promptText: '重启前没投出去的话', wakeReason: 'message' },
      createdAt: 1,
      attempts: 0,
      nextAt: 0,
      lastError: '',
    },
    {
      id: 'persisted-wake',
      key: 'group:456',
      payload: { promptText: '', wakeReason: 'atMention' },
      // 上一轮失败过、还在退避里；重启后应当立刻可投，不该继续等。
      createdAt: 2,
      attempts: 3,
      nextAt: Date.now() + 60000,
      lastError: 'DSH 未就绪',
    },
    // 既没有文本也没有唤醒原因：没有可投递的内容，读回时丢弃。
    { id: 'persisted-empty', key: 'group:456', payload: { promptText: '' }, createdAt: 3, attempts: 0, nextAt: 0, lastError: '' },
  ],
};

const h = await bridgeHarness({ files: { 'data/outbox.json': OUTBOX_FIXTURE } });
try {
  const pending = h.outbox.pending();
  assert.equal(pending.length, 2, `启动时应读回 2 条可投递条目（实际 ${pending.length}）`);
  assert.deepEqual(pending.map((entry) => entry.id), ['persisted-text', 'persisted-wake']);
  assert.equal(pending[1].payload.promptText, '', '唤醒项本来就没有文本');
  assert.equal(pending[1].payload.wakeReason, 'atMention', '唤醒原因要原样带回来');
  assert.equal(h.outbox.ready().length, 2, '读回后应立即可投（不继承上一次的退避时间）');
  assert.equal(h.outbox.size(), 2, '读回不是再入队一次：不能重复，也不能把空条目算进来');
  console.log('outbox restore: ok');
} finally {
  await h.close();
}
