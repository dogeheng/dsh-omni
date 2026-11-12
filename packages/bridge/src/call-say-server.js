// 通话期间给 bridge 用的“把这句话说出来”本地 HTTP 服务。
//
// 只在通话接通时启动，监听 127.0.0.1 的随机端口；挂断即关闭。
// bridge 的 /api/send/* 在命中通话路由时 POST /say，call-loop 把文本排进 TTS 队列。
import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY = 64 * 1024;

function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw) });
  res.end(raw);
}

/**
 * @param {{ token:string, onSay:(payload:{text:string,key?:string,kind?:string,messageId?:any})=>any, log?:Function }} opts
 */
export async function startSayServer({ token, onSay, log = () => {} }) {
  if (!token) throw new Error('缺少控制台令牌，无法启动 /say');
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/say') {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      if (!tokenEq(String(req.headers['x-console-token'] ?? ''), token)) {
        sendJson(res, 401, { ok: false, error: '未授权' });
        return;
      }
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { sendJson(res, 400, { ok: false, error: 'JSON 无效' }); return; }
      const text = String(payload?.text ?? '').trim();
      if (!text) { sendJson(res, 400, { ok: false, error: 'text 不能为空' }); return; }
      try {
        await onSay({ ...payload, text });
      } catch (error) {
        log(`/say 处理失败：${String(error?.message ?? error).slice(0, 120)}`);
        sendJson(res, 500, { ok: false, error: '语音队列处理失败' });
        return;
      }
      sendJson(res, 200, { ok: true, queued: true });
    } catch (error) {
      log(`/say 请求失败：${String(error?.message ?? error).slice(0, 120)}`);
      try { sendJson(res, 400, { ok: false, error: '请求无效' }); } catch {}
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/say`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
