// 沉睡前观察改成「桥接侧等待」之后的回归。
//
// 旧行为：最近还有人说话时设置潜水，接口直接回 400，逼模型在回合里
// qq_wait_for_messages(300000) 等满 5 分钟。这 5 分钟里会话一直判忙，
// 新 @ 只能暂存，最后被"繁忙期间唤醒…已被当前回合处理"吞掉。
//
// 新行为：设置潜水立刻 200 + deferred，观察窗口由桥接自己跑；窗口内来了新消息就取消。
// 这里用 80ms 的窗口验证时序，不靠真实的 5 分钟。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const DIVING = { mode: 'diving', infinite: true, triggers: { atMention: true } };
const ACTIVE = { mode: 'active', infinite: true, triggers: { anyMessage: true } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(fn, { preSleepWaitMs = 80 } = {}) {
  const h = await bridgeHarness({ config: {
    allow: { private: ['123'], groups: ['456'] },
    socialV2: {
      wake: { preSleepWaitEnabled: true, preSleepWaitMs },
      proactive: { enabled: false },
      sticker: { enabled: false },
    },
  } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, token = st.agentToken, key = KEY } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token', 'x-agent-token': token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text) => {
    h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, `m-${Date.now()}-${Math.random()}`, [], '789', []);
  };
  try {
    await fn({ h, st, request, append });
    console.log('PASS');
  } catch (error) {
    console.error('FAIL', error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

// 1) 最近的对话让潜水进入"待生效"：立刻 200，不挡回合；窗口结束后自动生效
await fixture(async ({ st, request, append }) => {
  append('还在正常聊天');
  const read = await request('unread');
  const before = JSON.stringify(st.wakeConfig);
  const close = await request('wake-config', { body: { throughSeq: read.data.readThroughSeq, config: DIVING } });
  assert.equal(close.status, 200, JSON.stringify(close.data));
  assert.equal(close.data.deferred, true, '最近有人说话时必须走延迟生效');
  assert.ok(close.data.pendingSleep.remainingMs > 0);
  assert.equal(JSON.stringify(st.wakeConfig), before, '生效前唤醒配置不得改变');
  assert.ok(st.pendingSleep, '待生效的潜水要挂在会话状态上');
  assert.equal(close.data.wakeConfig.mode, st.wakeConfig.mode, '回给模型的必须是当前（旧）配置');
  assert.match(String(close.data.hint), /(不需要在回合里等|结束回合)/);

  await sleep(200);
  assert.equal(st.pendingSleep, null, '窗口结束后要清掉待生效状态');
  assert.equal(st.wakeConfig.mode, 'diving', '窗口结束后潜水应当已生效');
  assert.equal(st.wakeConfig.triggers.atMention, true);
  assert.equal(st.wakeConfig.confirmedBy, 'pending-sleep', '要能看出这是延迟生效的');
  console.log('  ✅ 延迟生效：200 立刻返回 → 窗口结束后自动潜水');
});

// 2) 窗口内有人说话：取消这次潜水，配置保持不变
await fixture(async ({ st, request, append }) => {
  append('还聊着');
  const read = await request('unread');
  const before = JSON.stringify(st.wakeConfig);
  const close = await request('wake-config', { body: { throughSeq: read.data.readThroughSeq, config: DIVING } });
  assert.equal(close.data.deferred, true);
  append('又来一句');
  assert.equal(st.pendingSleep, null, '新消息必须取消待生效的潜水');
  await sleep(200);
  assert.equal(JSON.stringify(st.wakeConfig), before, '取消后配置不得变化');
  console.log('  ✅ 新消息取消：潜水作废，配置不动');
});

// 3) 已经安静够久：立即生效（不延迟），行为与以前一致
await fixture(async ({ st, request, append }) => {
  append('很久以前的一句');
  const read = await request('unread');
  st.lastIncomingAt = Date.now() - 5000; // 远超 80ms 窗口
  const close = await request('wake-config', { body: { throughSeq: read.data.readThroughSeq, config: DIVING } });
  assert.equal(close.status, 200);
  assert.equal(close.data.deferred, undefined, '已安静够久应当立即生效');
  assert.equal(st.wakeConfig.mode, 'diving');
  assert.equal(st.pendingSleep, null);
  console.log('  ✅ 已安静够久：立即生效，不引入额外等待');
});

// 4) mark_read 不再被观察窗口挡住
await fixture(async ({ st, request, append }) => {
  append('一句普通的话');
  const read = await request('unread');
  const marked = await request('mark-read', { body: { throughSeq: read.data.readThroughSeq } });
  assert.equal(marked.status, 200, 'mark_read 只负责确认已读，不该被观察窗口拦下');
  assert.equal(marked.data.markedCount, 1);
  console.log('  ✅ mark_read 放行：不再逼模型在回合里空等');
});

// 5) 重新提交配置会覆盖上一次的待生效潜水
await fixture(async ({ st, request, append }) => {
  append('聊着');
  await request('unread');
  await request('wake-config', { body: { config: DIVING } });
  const first = st.pendingSleep;
  assert.ok(first);
  const second = await request('wake-config', { body: { config: { ...DIVING, triggers: { atMention: true, keywords: ['在吗'] } } } });
  assert.equal(second.data.deferred, true);
  assert.notEqual(st.pendingSleep, first, '新的提交要替换上一次的待生效状态');
  await sleep(200);
  // 注意：桥接运行在 vm 里，它造的数组是**另一个 realm** 的 Array，
  // deepEqual 会因为原型不同判定不等；先展开成宿主数组再比。
  assert.deepEqual([...st.wakeConfig.triggers.keywords], ['在吗'], '最后一次提交生效');
  console.log('  ✅ 重复提交：后者覆盖前者');
});
