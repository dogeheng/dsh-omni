// 唤醒策略：纯图片/表情走独立的低概率通道，不放大文字闲聊。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = '456';
const OWNER = '123';

async function withWake(fn, wake = {}) {
  const h = await bridgeHarness({
    config: {
      allow: { groups: [GROUP], private: [OWNER] },
      socialV2: {
        wake: {
          forceAnyMessage: false,
          mediaProbability: 1,
          mediaCooldownMs: 600000,
          ...wake
        }
      }
    }
  });
  h.setMode('reserved2');
  h.setSelfIdentity('Yuki', '999');
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

function state({ lastAiReplyAt = 0, probability = 0, anyMessage = false } = {}) {
  return {
    lastAiReplyAt,
    wakeConfig: {
      mode: 'diving',
      infinite: true,
      batchWindowMs: 6000,
      triggers: {
        anyMessage, atMention: true, nameMention: true, question: true, poke: true,
        keywords: [], speakerIds: [], probability
      }
    }
  };
}

const image = (extra = []) => ({ message: [{ type: 'image', data: { file: 'a.jpg' } }, ...extra], user_id: '111', self_id: '999', sender: { card: '小明' } });
const text = (value) => ({ message: [{ type: 'text', data: { text: value } }], user_id: '111', self_id: '999', sender: { card: '小明' } });
const call = (h, st, event) => h.evaluateWakeTriggerV2(`group:${GROUP}`, st, event, 'group', '', '', false);

test('纯图片：独立概率命中 media', async () => {
  await withWake(async (h) => {
    assert.equal(call(h, state(), image()), 'media');
  });
});

test('纯图片：她刚发过言时受冷却限制', async () => {
  await withWake(async (h) => {
    assert.equal(call(h, state({ lastAiReplyAt: Date.now() }), image()), null);
  });
});

test('图片带文字/普通文字：不走 media 通道', async () => {
  await withWake(async (h) => {
    assert.equal(call(h, state(), image([{ type: 'text', data: { text: '看这个' } }])), null);
    assert.equal(call(h, state(), text('随便聊聊')), null);
  });
});

test('mediaProbability=0 时图片完全不唤醒；普通概率不能兜底图片', async () => {
  await withWake(async (h) => {
    assert.equal(call(h, state({ probability: 1 }), image()), null);
  }, { mediaProbability: 0 });
});

test('@ 图片仍走明确触发，优先于 media', async () => {
  await withWake(async (h) => {
    const event = image([{ type: 'at', data: { qq: '999' } }]);
    assert.equal(call(h, state(), event), 'atMention');
  });
});

test('forceAnyMessage=true 仍覆盖媒体通道', async () => {
  await withWake(async (h) => {
    assert.equal(call(h, state(), text('随便聊聊')), 'anyMessage');
  }, { forceAnyMessage: true });
});

test('唤醒提示词带「后台原因封口」规则', async () => {
  await withWake(async (h) => {
    const prompt = h.buildWakePromptV2(`group:${GROUP}`, 'media');
    assert.match(prompt, /【话术】/);
    assert.match(prompt, /不要提模型/);
    assert.match(prompt, /没电/);
    assert.match(prompt, /先给反应/);
    assert.match(prompt, /不要先描述/);
    assert.doesNotMatch(prompt, /省电模式已关闭/);
  });
});

test('私聊任何消息都唤醒，不受媒体通道影响', async () => {
  await withWake(async (h) => {
    assert.equal(h.evaluateWakeTriggerV2(`private:${OWNER}`, state(), text('在吗'), 'private', '在吗', '在吗', false), 'private');
  }, { mediaProbability: 0 });
});
