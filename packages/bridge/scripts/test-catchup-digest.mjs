// 补课摘要：休眠/掉线/重启之后，把"你不在的时候发生了什么"压成几行加进唤醒提示词。
//
// 只做确定性摘要（不调模型）：有离开窗口才加、按时间顺序、条数与字符数都有上限。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const HOUR = 60 * 60 * 1000;

function fixture(fn, { catchUp } = {}) {
  return (async () => {
    const h = await bridgeHarness({ config: {
      allow: { private: ['123'], groups: ['456'] },
      socialV2: {
        wake: { preSleepWaitEnabled: false },
        proactive: { enabled: false },
        sticker: { enabled: false },
        context: catchUp ? { catchUp } : {},
      },
    } });
    h.setMode('reserved2');
    try {
      await fn(h);
      console.log('PASS');
    } catch (error) {
      console.error('FAIL', error?.stack ?? error);
      process.exitCode = 1;
    } finally {
      await h.close();
    }
  })();
}

const appendAged = (h, text, ageMs) => {
  const st = h.getSocialV2State(KEY);
  h.appendSocialV2Message(KEY, '小明', text, text, false, false, `m-${text}`, [], '789', []);
  const msg = st.recentMessages.at(-1);
  if (msg) msg.time = Date.now() - ageMs;
};

// 1) 正常补课：离开 2 小时，期间 3 条消息
await fixture(async (h) => {
  const st = h.getSocialV2State(KEY);
  st.lastPromptAt = Date.now() - 2 * HOUR;
  appendAged(h, '我下周去波士顿', 90 * 60 * 1000);
  appendAged(h, '帮我看看这个表情', 60 * 60 * 1000);
  appendAged(h, '对了你刚才说的那个', 10 * 60 * 1000);
  const prompt = h.buildWakePromptV2(KEY, 'message');
  assert.match(prompt, /【你离开期间】约 120 分钟/, '要有离开窗口与条数');
  assert.ok(prompt.includes('我下周去波士顿'), '期间的消息要出现在摘要里');
  assert.ok(prompt.includes('对了你刚才说的那个'), '最近一条不能漏');
  assert.match(prompt, /不要逐条回应/, '要明确"只当背景"');
});

// 2) 离开时间不够长：一个字都不加
await fixture(async (h) => {
  const st = h.getSocialV2State(KEY);
  st.lastPromptAt = Date.now() - 60 * 1000;
  appendAged(h, '刚刚说的话', 30 * 1000);
  const prompt = h.buildWakePromptV2(KEY, 'message');
  assert.equal(prompt.includes('【你离开期间】'), false);
});

// 3) 关掉开关：即使离开很久也不加
await fixture(async (h) => {
  const st = h.getSocialV2State(KEY);
  st.lastPromptAt = Date.now() - 5 * HOUR;
  appendAged(h, '很久以前的一句', HOUR);
  const prompt = h.buildWakePromptV2(KEY, 'message');
  assert.equal(prompt.includes('【你离开期间】'), false);
}, { catchUp: { enabled: false } });

// 4) 条数与字符上限：40 条消息不能全塞进去
await fixture(async (h) => {
  const st = h.getSocialV2State(KEY);
  st.lastPromptAt = Date.now() - 6 * HOUR;
  for (let i = 0; i < 40; i++) appendAged(h, `第${i}条消息内容`, (5 * 60 - i) * 60 * 1000);
  const prompt = h.buildWakePromptV2(KEY, 'message');
  const block = prompt.slice(prompt.indexOf('【你离开期间】'), prompt.indexOf('\n\n', prompt.indexOf('【你离开期间】')));
  const lines = block.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length <= 12, `最多 12 条（实际 ${lines.length}）`);
  assert.ok(block.length <= 1000, `摘要要有字符上限（实际 ${block.length}）`);
  assert.ok(lines.at(-1).includes('第39条'), '保留的是最新的那几条');
});

// 5) 投递成功后要更新时间锚：下一次就不会重复补课
await fixture(async (h) => {
  const st = h.getSocialV2State(KEY);
  st.lastPromptAt = Date.now() - 3 * HOUR;
  appendAged(h, '一条新消息', 5 * 60 * 1000);
  assert.ok(h.buildWakePromptV2(KEY, 'message').includes('【你离开期间】'));
  const before = st.lastPromptAt;
  await h.deliverPrompt(KEY, '', { wakeReason: 'message' });
  assert.ok(st.lastPromptAt > before, '投递成功后必须推进时间锚');
  const prompt2 = h.buildWakePromptV2(KEY, 'message');
  assert.equal(prompt2.includes('【你离开期间】'), false, '刚投递过就不该再补课');
});
