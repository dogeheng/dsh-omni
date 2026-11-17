// 冷会话瘦身：进过的群/私聊不能永久留着 200 条历史把它们撑大。
//
// 事故形态：social-v2.json 每个会话最多存 200 条 recentMessages（实测 6 个会话 370KB），
// 而 conversations 只会新增、从不清理 —— 群越多，每次落盘越慢，文件越长。
// 这里的规则是"只瘦身、不删会话"，并且**有未读/有待生效潜水/还挂着定时器时一律不动**。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ALLOW = { private: ['123'], groups: ['456', '789', '111'] };
const DAY = 24 * 60 * 60 * 1000;

const h = await bridgeHarness({ config: { allow: ALLOW } });
try {
  h.setMode('reserved2');
  const plant = (key, { idleDays, unread = false, pendingSleep = false } = {}) => {
    const st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, '小明', '一句话', '一句话', false, false, `m-${key}`, [], '789', []);
    // 再造几条历史，确保 recentMessages 非空
    for (let i = 0; i < 3; i++) {
      h.appendSocialV2Message(key, '小明', `历史 ${i}`, `历史 ${i}`, false, false, `m-${key}-${i}`, [], '789', []);
    }
    if (!unread) {
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    }
    if (pendingSleep) st.pendingSleep = { config: { mode: 'diving' }, applyAt: Date.now() + 1000, timer: null };
    st.lastIncomingAt = Date.now() - idleDays * DAY;
    st.lastAiReplyAt = 0;
    st.lastActionAt = 0;
    // 限频窗口按时间过滤：3 小时前的应当被丢掉，10 分钟前的必须留着
    st.wakeTimes = [Date.now() - 3 * 60 * 60 * 1000, Date.now() - 10 * 60 * 1000];
    st.sendTimes = [Date.now() - 3 * 60 * 60 * 1000, Date.now() - 5 * 60 * 1000];
    st.wakeConfig = { ...st.wakeConfig, mode: 'diving', infinite: true, triggers: { ...st.wakeConfig.triggers, keywords: ['在吗'] } };
    return st;
  };

  const cold = plant('group:456', { idleDays: 30 });
  const withUnread = plant('group:789', { idleDays: 30, unread: true });
  const pending = plant('group:111', { idleDays: 30, pendingSleep: true });

  const result = h.compactIdleConversationsV2();
  assert.equal(result.compacted, 1, `只有真正冷掉、且没状态的那一个才该瘦身（实际 ${result.compacted}）`);

  // 桥接跑在 vm 里，它造的数组属于另一个 realm：比长度/展开成宿主数组，别直接 deepEqual
  assert.equal(cold.recentMessages.length, 0, '冷会话的历史要清掉');
  assert.equal([...cold.seenInbound].length, 0, '去重指纹也要清（它只防网关重放）');
  assert.deepEqual([...cold.wakeConfig.triggers.keywords], ['在吗'], '唤醒配置必须保留');
  assert.equal(cold.wakeConfig.mode, 'diving', '潜水状态不能被瘦身弄丢');
  assert.ok(cold.lastReadThroughSeq >= 0, '水位字段还在');
  assert.equal([...cold.wakeTimes].length, 1, '限频窗口只保留最近 1 小时的时间戳');
  assert.ok(cold.wakeTimes[0] > Date.now() - 60 * 60 * 1000);

  assert.ok(withUnread.recentMessages.length > 0, '有未读的会话不动');
  assert.ok(withUnread.unread.length > 0);
  assert.ok(pending.recentMessages.length > 0, '有待生效潜水的会话不动');
  assert.ok(pending.pendingSleep, '待生效潜水要还在');

  // 上限：只有"已经瘦身过、没状态"的会话才会被淘汰
  const h2 = await bridgeHarness({ config: { allow: ALLOW } });
  try {
    h2.setMode('reserved2');
    const keys = ['group:456', 'group:789', 'group:111'];
    for (const key of keys) {
      const st = h2.getSocialV2State(key);
      h2.appendSocialV2Message(key, '小明', '旧消息', '旧消息', false, false, `m-${key}`, [], '789', []);
      st.unread = [];
      st.lastIncomingAt = Date.now() - 60 * DAY;
    }
    // 一个挂着待投递唤醒 → 不瘦身；一个还握着 DSH 会话映射 → 不能淘汰
    h2.getSocialV2State('group:456').pendingWakeTimer = { fake: true };
    h2.state.sessions['group:789'] = 'session-old';

    const r = h2.compactIdleConversationsV2({ maxConversations: 1 });
    // 挂着待投递唤醒的不瘦身（历史还要用来拼快照）；另外两个照常瘦身
    assert.equal(r.compacted, 2, '挂着待投递唤醒的那个不能瘦身');
    assert.equal(r.dropped, 1, '只淘汰既没状态、也没有 DSH 会话映射的那个');
    assert.equal(h2.socialV2.conversations.has('group:789'), true, '还握着 DSH 会话的不能被淘汰');
    assert.equal(h2.socialV2.conversations.has('group:111'), false, '其余按上限淘汰');
  } finally {
    await h2.close();
  }

  console.log('state compact: ok');
} finally {
  await h.close();
}
