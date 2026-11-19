// 「别翻旧账」回归：死了很久的群，主动冒泡/定时醒来时不能把几小时前的消息当新事说。
//
// 现场：14:44 一次 proactiveCheck 唤醒，群里 13 条未读都已超 2h 被时效剪掉，
// 她仍然发了一条消息，并且是在"没人说话"的群里追旧话题。根因不是单一开关：
//   ① 主动机会的提示词原本写着「追问上次没聊完的事」——直接教她翻旧账；
//   ② 补课摘要会把离开期间（可能 20 小时）最多 12 条旧消息列给她；
//   ③ 唤醒快照的 recent 与【进行中的话题】都是"几小时前也算背景"，没有新鲜度门槛。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const h = await bridgeHarness({ config: {
  allow: { private: ['123'], groups: ['456'] },
  socialV2: { proactive: { enabled: false }, sticker: { enabled: false }, wake: { preSleepWaitEnabled: false } },
} });
try {
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const appendAged = (text, ageMs, id) => {
    h.appendSocialV2Message(KEY, '小明', text, text, false, false, id, [], '789', []);
    const msg = st.recentMessages.at(-1);
    if (msg) msg.time = Date.now() - ageMs;
    return st.lastUnreadSeq;
  };

  // 3 小时前聊过的东西 + 10 分钟前的一句
  appendAged('三小时前说的旧事', 3 * HOUR, 'old-1');
  appendAged('四小时前说的旧事', 4 * HOUR, 'old-2');
  appendAged('刚说的一句', 10 * MIN, 'new-1');
  st.unread = [];
  st.lastReadThroughSeq = st.lastUnreadSeq;
  st.lastPromptAt = Date.now() - 5 * HOUR;
  st.activeTopics = [
    { text: '三小时前的旧话题', lastMentionAt: Date.now() - 3 * HOUR },
    { text: '十分钟前的新话题', lastMentionAt: Date.now() - 10 * MIN },
  ];

  // 1) 主动机会：不注入补课摘要、不带旧话题、措辞明确禁止翻旧账
  const proactive = h.buildWakePromptV2(KEY, 'proactiveCheck');
  assert.equal(proactive.includes('【你离开期间】'), false, '主动冒泡不能补课（等于教她翻旧账）');
  assert.equal(proactive.includes('三小时前的旧话题'), false, '超过 1 小时的话题不该进主动机会的提示词');
  assert.ok(proactive.includes('十分钟前的新话题'), '新鲜话题仍然可以当话头');
  assert.ok(proactive.includes('只聊现在'), '提示词要明确"只聊现在"');
  assert.ok(proactive.includes('不要翻旧账') || proactive.includes('不要提起几小时前'), '要有明确禁止翻旧账的措辞');
  assert.ok(proactive.includes('最近一条消息在'), '状态行要写出最近一条距今多久');

  // 2) 定时唤醒（timeout）：同样不补课、不带旧话题
  const timeout = h.buildWakePromptV2(KEY, 'timeout');
  assert.equal(timeout.includes('【你离开期间】'), false);
  assert.equal(timeout.includes('三小时前的旧话题'), false);

  // 3) 被消息触发的唤醒：补课摘要仍然要有（功能不能被一刀切掉）
  const messageWake = h.buildWakePromptV2(KEY, 'message');
  assert.ok(messageWake.includes('【你离开期间】'), '消息唤醒仍然要补课');
  assert.ok(messageWake.includes('三小时前说的旧事'), '补课要包含离开期间的消息（6 小时内）');
  assert.ok(messageWake.includes('三小时前的旧话题'), '消息唤醒可以带 24 小时内的话题');

  // 4) 补课摘要只回看最近 6 小时：离开 20 小时不能把 10 小时前的事重新列出来
  st.lastPromptAt = Date.now() - 20 * HOUR;
  appendAged('十小时前的旧事', 10 * HOUR, 'very-old');
  appendAged('一小时前的事', 1 * HOUR, 'recent-1');
  const longGap = h.buildWakePromptV2(KEY, 'message');
  assert.ok(longGap.includes('一小时前的事'), '6 小时内的事要带上');
  assert.equal(longGap.includes('十小时前的旧事'), false, '超过 6 小时的不再补课');

  // 5) 快照新鲜度：主动唤醒只带 30 分钟内的 recent，消息唤醒照旧带背景
  const fresh = h.buildWakeSnapshotV2(KEY, { recentMaxAgeMs: 30 * MIN, skipThread: true });
  const freshTexts = JSON.stringify(fresh);
  assert.equal(freshTexts.includes('三小时前说的旧事'), false, '主动唤醒的快照不能带几小时前的消息');
  assert.ok(freshTexts.includes('刚说的一句'), '最近 30 分钟内的消息要保留');
  const normal = h.buildWakeSnapshotV2(KEY);
  assert.ok(JSON.stringify(normal).includes('三小时前说的旧事'), '消息唤醒的快照仍然带最近背景');

  console.log('PASS');
} catch (error) {
  console.error('FAIL', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await h.close();
}
