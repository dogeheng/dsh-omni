// 发送失败语义：区分"确定没发出去"与"结果未知（可能已送达）"。
//
// 背景：桥接外层 withTimeout(15s) 只 race 不 abort，而 SDK 默认 30s —— 旧实现有
// 15–30s 窗口"桥接判失败、底层还在发"，模型照提示重发就会在群里重复。
// 现在 SDK 超时与桥接对齐，并且超时/断连会被标成 uncertain，提示模型先核对再补发。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifySendFailure } from '../src/send-failure.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 1) 分类：超时/断连 = 结果未知；明确被拒 = 确定失败
{
  const uncertain = [
    new Error('操作超时(15000ms)：QQ发送 group:456'),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    new Error('fetch failed: network error'),
  ];
  for (const error of uncertain) {
    assert.equal(classifySendFailure(error).uncertain, true, `应判为结果未知：${error.message}`);
    assert.match(classifySendFailure(error).hint, /可能已经发出去了|核对/);
  }
  const certain = [
    new Error('OneBot send_group_msg 失败: 消息含敏感信息，已阻止发送'),
    new Error('发送频率超限，请稍后再试'),
    new Error('消息未被接受：invalid_request: bad format'),
    new Error('发送内容包含会话令牌，已阻止发送'),
  ];
  for (const error of certain) {
    assert.equal(classifySendFailure(error).uncertain, false, `应判为确定失败：${error.message}`);
  }
  console.log('  ✅ 分类：超时/断连=未知，明确拒绝=确定失败');
}

// 2) 端到端：第一条成功、第二条超时 → partial + uncertainIndexes
{
  let sends = 0;
  const serverFetch = async (url) => {
    if (!String(url).includes('send_group_msg')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
    }
    sends += 1;
    if (sends === 2) {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1000 + sends } }) };
  };
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456'] }, socialV2: { send: { burstEnabled: true } } },
    globals: { fetch: serverFetch },
  });
  let server = null;
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (body) => new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/socialV2/send-message', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken }
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end(JSON.stringify({ key: 'group:456', messages: ['第一条', '第二条'], gaps: [0, 0] }));
    });
    const res = await call();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.partial, true);
    assert.equal(res.body.sent, 1);
    assert.equal(res.body.failed, 1);
    assert.deepEqual([...res.body.uncertainIndexes], [1], '第二条是超时，必须标成结果未知');
    assert.equal(res.body.uncertain, true);
    assert.match(String(res.body.hint), /核对/);
    assert.equal(res.body.results[1].uncertain, true, 'results 里也要带标记');
    assert.equal(res.body.results[0].ok, true);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
  console.log('  ✅ 端到端：部分成功 + 超时项标记 uncertain + 提示先核对');
}

// 3) 契约：SDK 请求超时与桥接对齐；发送路径用 classifySendFailure
{
  const bridge = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');
  assert.match(bridge, /requestTimeoutMs: SEND_TIMEOUT_MS/, 'SDK 的请求超时必须与 SEND_TIMEOUT_MS 对齐');
  assert.match(bridge, /const SEND_WATCHDOG_MS = SEND_TIMEOUT_MS \+ 3000/, '外层只做看门狗，给 SDK 留出先报错的余量');
  assert.match(bridge, /const verdict = classifySendFailure\(error\)/, '发送结果要按分类判定');
  assert.match(bridge, /results\[i\]\.uncertain = true/, '发送结果要标记 uncertain');
  const mcp = fs.readFileSync(fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url)), 'utf8');
  assert.match(mcp, /可能已经发出去了/, '工具描述要让模型知道超时可能已送达');
  console.log('  ✅ 契约：超时对齐 + uncertain 标记 + 工具描述');
}

console.log('\nPASS');
