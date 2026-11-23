// 发送超时后的"到底发出去没有"核对：避免模型重发造成同一条消息发两遍。
//
// 现场：日志里出现过 "QQ 发送失败 (group:x): The operation was aborted due to timeout"，
// 随后又成功发送同一条 —— OneBot 其实已经发到 QQ 了，只是 HTTP 响应没等到。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const SELF_ID = 12345;

function makeFetch(state) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/send_group_msg')) {
      state.sendCount += 1;
      if (state.behavior === 'timeout') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 900 + state.sendCount } }) };
    }
    if (u.pathname.endsWith('/get_login_info')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: SELF_ID, nickname: 'YUKI' } }) };
    }
    if (u.pathname.endsWith('/get_group_msg_history')) {
      state.historyCalls += 1;
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { messages: state.history } }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
  };
}

const call = (port, token, body) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1', port, path: '/api/socialV2/send-message', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token },
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { data += c; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});

async function withBridge(fn, state) {
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456'] }, socialV2: { send: { burstEnabled: true } } },
    globals: { fetch: makeFetch(state) },
  });
  let server = null;
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    await fn({ h, st, port: server.address().port });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

// 1) 超时但历史里能看到这条 → 按成功处理，不报 uncertain（模型不会重发）
{
  const state = { behavior: 'timeout', sendCount: 0, historyCalls: 0, history: [
    { time: Math.floor(Date.now() / 1000), user_id: SELF_ID, message: [{ type: 'text', data: { text: '超时但送达的一条' } }] },
  ] };
  await withBridge(async ({ st, port }) => {
    const res = await call(port, st.agentToken, { key: KEY, messages: ['超时但送达的一条'] });
    assert.equal(res.body.ok, true, `应视为已送达：${JSON.stringify(res.body)}`);
    assert.equal(res.body.sent, 1);
    assert.equal(state.sendCount, 1, '不应重发');
    assert.ok(state.historyCalls >= 1, '应当查过一次历史');
  }, state);
  console.log('  ✅ 超时但已送达：按成功处理，不触发重发');
}

// 2) 超时且历史里没有 → 如实标记 uncertain（允许模型核对后补发）
{
  const state = { behavior: 'timeout', sendCount: 0, historyCalls: 0, history: [] };
  await withBridge(async ({ st, port }) => {
    const res = await call(port, st.agentToken, { key: KEY, messages: ['真的没发出去的一条'] });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.uncertain, true);
    assert.match(String(res.body.hint), /核对|可能已经发出去了/);
    assert.equal(state.sendCount, 1);
  }, state);
  console.log('  ✅ 超时且确认未送达：如实标记 uncertain');
}

// 3) 已标记 uncertain 后模型重发，此时历史里出现了 → 拦下重复发送
{
  const state = { behavior: 'timeout', sendCount: 0, historyCalls: 0, history: [] };
  await withBridge(async ({ st, port }) => {
    const first = await call(port, st.agentToken, { key: KEY, messages: ['延迟送达的一条'] });
    assert.equal(first.body.uncertain, true);
    // 模拟 OneBot 延迟写入历史：现在能查到了
    state.history = [
      { time: Math.floor(Date.now() / 1000), user_id: SELF_ID, message: [{ type: 'text', data: { text: '延迟送达的一条' } }] },
    ];
    state.behavior = 'ok';
    const second = await call(port, st.agentToken, { key: KEY, messages: ['延迟送达的一条'] });
    assert.equal(second.body.ok, true, JSON.stringify(second.body));
    assert.equal(state.sendCount, 1, '重复发送必须被拦下');
  }, state);
  console.log('  ✅ 重发前核对：已送达则拦下重复发送');
}

console.log('\nPASS');
