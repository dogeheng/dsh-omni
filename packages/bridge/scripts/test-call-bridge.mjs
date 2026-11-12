#!/usr/bin/env node
// 通话文字→语音路由的单元/接口测试：不启动 QQ、不依赖 DSH。
import assert from 'node:assert/strict';
import { startSayServer } from '../src/call-say-server.js';
import { CallPresence } from '../src/call-presence.js';
import { buildCrossChannelNote } from '../src/call-context.js';

const TOKEN = 'test-token-0123456789abcdef';
const said = [];
const server = await startSayServer({
  token: TOKEN,
  onSay: (payload) => { said.push(payload); },
  log: (message) => console.log('  [say]', message)
});

try {
  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(health.status, 200, 'health 应返回 200');

  const unauthorized = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '不该被接受' })
  });
  assert.equal(unauthorized.status, 401, '缺 token 应 401');

  const empty = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': TOKEN },
    body: JSON.stringify({ text: '   ' })
  });
  assert.equal(empty.status, 400, '空文本应 400');

  const ok = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': TOKEN },
    body: JSON.stringify({ text: '群里那张图我看到了', key: 'group:123', kind: 'group' })
  });
  assert.equal(ok.status, 200, '/say 应返回 200');
  assert.equal(said.length, 1, 'onSay 应被调用一次');
  assert.equal(said[0].text, '群里那张图我看到了');
  console.log('  ✅ say server：鉴权 / 空文本 / 正常入队');

  const presence = new CallPresence({ ttlMs: 90_000, routeTtlMs: 600_000, log: () => {} });
  assert.equal(presence.isActive(), false, '初始应为未接通');
  presence.update({ active: true, withQQ: '952866364', sayUrl: server.url });
  assert.equal(presence.isActive(), true);
  assert.equal(presence.shouldRoute('group:973614217', 'group', 973614217), false, '未标记的群不应路由');
  presence.markRoute('group:973614217');
  assert.equal(presence.shouldRoute('group:973614217', 'group', 973614217), true, '主人发过消息的群应路由');
  assert.equal(presence.shouldRoute('private:952866364', 'private', 952866364), true, '和主人私聊应路由');
  assert.equal(presence.shouldRoute('private:111111', 'private', 111111), false, '其他私聊不应路由');
  assert.equal(presence.shouldRoute('group:222222', 'group', 222222), false, '其他群不应路由');

  await presence.say('这是要走语音的回复', {
    token: TOKEN,
    key: 'group:973614217',
    kind: 'group',
    context: { sender: 'doge.恆', text: '看这张图', media: ['image'] }
  });
  assert.equal(said.length, 2, 'presence.say 应把文本送到 say server');
  assert.equal(said[1].text, '这是要走语音的回复');
  assert.equal(said[1].context.text, '看这张图', '跨通道上下文应随 say 一起传');
  const note = buildCrossChannelNote({ key: 'group:973614217', source: said[1].context, reply: said[1].text });
  assert.match(note, /看这张图/);
  assert.match(note, /这是要走语音的回复/);
  assert.match(note, /带图片/);
  console.log('  ✅ presence：标记 / 私聊 owner / 其他会话隔离 / say 投递 / 跨通道上下文');

  presence.expiresAt = Date.now() - 1;
  assert.equal(presence.isActive(), false, '过期后应自动失效');
  presence.update({ active: false });
  assert.equal(presence.status().active, false);
  console.log('  ✅ presence：过期 / 断开清理');

  console.log('\nPASS');
} finally {
  await server.close();
}
