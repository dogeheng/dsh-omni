// 本地图片出口：桥接接受 imageBase64（MCP 从沙箱读出来的文件），与网络图片同一套校验。
//
// 背景：以前 qq_send_image 只收 http(s) 直链 —— 她能搜图、能收图，却发不出自己生成的图。
// 现在两条来源并存：imageUrl（网络）/ imageBase64（本地，来自沙箱工作区），
// 桥接这端只做最后一道校验：体积、base64 形状、图片魔数，一个都不能少。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
// 1x1 PNG（与 harness 的 fixture 同一个）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';

const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456'] } } });
const sent = [];
let server = null;
try {
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  // 记下发出去的请求：FakeBot.request 默认不记录参数。
  h.bot.request = async (action, payload) => {
    sent.push({ action, payload });
    return { status: 'ok', retcode: 0, data: { message_id: 4321 } };
  };
  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = (body, { token = st.agentToken } = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ key: KEY, ...body });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/socialV2/send-image', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...(token ? { 'x-agent-token': token } : {}) }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(payload);
  });

  // 1) 正常本地图片：真的以 base64 段发出去
  const ok = await call({ imageBase64: PNG_B64, imagePath: 'out/cover.png' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  assert.equal(sent.length, 1, '应当发出一次图片消息');
  const segments = sent[0].payload.message;
  const img = segments.find((s) => s.type === 'image');
  assert.ok(img, '消息里要有 image 段');
  assert.ok(img.data.file.startsWith('base64://'), '本地图片以 base64 交给 OneBot');
  console.log('  ✅ 本地图片：校验通过并以 base64 段发出');

  // 2) data: URL 前缀也接受
  const dataUrl = await call({ imageBase64: `data:image/png;base64,${PNG_B64}` });
  assert.equal(dataUrl.status, 200, JSON.stringify(dataUrl.body));
  console.log('  ✅ data: URL 前缀兼容');

  // 3) 非图片内容（魔数不对）必须拒绝
  const notImage = await call({ imageBase64: Buffer.from('hello world').toString('base64') });
  assert.equal(notImage.status, 400);
  assert.match(String(notImage.body.error), /图片校验失败|图片/);
  console.log('  ✅ 非图片内容被拒');

  // 4) 不是合法 base64
  const badB64 = await call({ imageBase64: '!!!not-base64!!!' });
  assert.equal(badB64.status, 400);

  // 5) 超过 4MB 上限
  const huge = Buffer.alloc(4 * 1024 * 1024 + 1024, 1).toString('base64');
  const tooBig = await call({ imageBase64: huge });
  assert.equal(tooBig.status, 400);
  assert.match(String(tooBig.body.error), /超过上限/);

  // 6) 两个来源同时给 / 都不给
  const both = await call({ imageBase64: PNG_B64, imageUrl: 'https://example.com/a.png' });
  assert.equal(both.status, 400);
  const none = await call({});
  assert.equal(none.status, 400);
  console.log('  ✅ 体积/形状/二选一 都挡住了');

  // 7) 没有 agent token 不能从这条路径发（本地图片也不能绕过鉴权）
  const noToken = await call({ imageBase64: PNG_B64 }, { token: null });
  assert.equal(noToken.status, 403);
  console.log('  ✅ 鉴权仍然生效');

  // 8) 接线契约：MCP 侧真的注册了 imagePath，并且走沙箱同一条路径校验
  const mcp = fs.readFileSync(fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url)), 'utf8');
  assert.match(mcp, /imagePath: z\.string\(\)\.optional\(\)/, 'qq_send_image 必须暴露 imagePath');
  assert.match(mcp, /readSandboxBinary\(/, '本地图片必须走沙箱路径校验');
  assert.match(mcp, /imageBase64: file\.buffer\.toString\('base64'\)/, '本地文件要转成 base64 交给桥接');
  console.log('  ✅ 接线契约：MCP 的 imagePath → 沙箱校验 → base64');
} finally {
  // 必须关掉控制台服务器：它监听着一个端口，会把进程挂住（跑全套时表现为超时）
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await h.close();
}

console.log('\nPASS');
