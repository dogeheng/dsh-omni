// 通话 presence + 文字→语音路由的共享状态。
//
// call-loop 在通话接通时把 sayUrl / withQQ 注册到 bridge；bridge 收到 owner 的
// QQ 文字/图片消息后标记对应的 key；模型调用发送工具时，bridge 若发现该 key
// 正在通话路由窗口内，就不发 QQ，而是把文本 POST 到 call-loop 的 /say 说出来。
//
// 这是“输出通道切换”，不改变 reserved2 的唤醒/概率/节奏：模型还是那个模型、
// 同一个 turn、同一个工具；只是发送终点从 QQ 变成通话 TTS。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL_MS = 90_000;
const DEFAULT_ROUTE_TTL_MS = 10 * 60_000;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function validSayUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:') return '';
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return '';
    if (!url.port) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export class CallPresence {
  constructor({ ttlMs = DEFAULT_TTL_MS, routeTtlMs = DEFAULT_ROUTE_TTL_MS, log = () => {} } = {}) {
    this.ttlMs = clamp(ttlMs, 30_000, 180_000, DEFAULT_TTL_MS);
    this.routeTtlMs = clamp(routeTtlMs, 60_000, 30 * 60_000, DEFAULT_ROUTE_TTL_MS);
    this.log = log;
    this.active = false;
    this.withQQ = '';
    this.sayUrl = '';
    this.startedAt = 0;
    this.expiresAt = 0;
    this.routeKeys = new Map();
    this.lastError = '';
  }

  update({ active, withQQ = '', sayUrl = '', ttlMs } = {}, now = Date.now()) {
    if (active !== true) {
      this.clear('call-loop 报告通话结束');
      return this.status(now);
    }
    const url = validSayUrl(sayUrl);
    if (!url) {
      this.lastError = `sayUrl 必须是本机 http 地址：${String(sayUrl).slice(0, 120)}`;
      throw new Error(this.lastError);
    }
    const nextWith = String(withQQ || '');
    if (this.withQQ && nextWith && this.withQQ !== nextWith) this.routeKeys.clear();
    this.active = true;
    this.withQQ = nextWith;
    this.sayUrl = url;
    if (!this.startedAt) this.startedAt = now;
    this.expiresAt = now + clamp(ttlMs, 30_000, 180_000, this.ttlMs);
    this.lastError = '';
    return this.status(now);
  }

  _check(now = Date.now()) {
    if (this.active && this.expiresAt <= now) {
      this.clear('presence 心跳超时');
    }
    for (const [key, until] of this.routeKeys) {
      if (until <= now) this.routeKeys.delete(key);
    }
  }

  isActive(now = Date.now()) {
    this._check(now);
    return this.active;
  }

  markRoute(key, routeTtlMs = this.routeTtlMs, now = Date.now()) {
    this._check(now);
    if (!this.active || !key) return false;
    this.routeKeys.set(String(key), now + clamp(routeTtlMs, 60_000, 30 * 60_000, this.routeTtlMs));
    return true;
  }

  /** 这个发送是否应该改走语音。 */
  shouldRoute(key, kind, id, now = Date.now()) {
    this._check(now);
    if (!this.active) return false;
    if (this.routeKeys.has(String(key))) return true;
    return kind === 'private' && this.withQQ && String(id) === String(this.withQQ);
  }

  /** 把一段文本交给 call-loop 的 /say。 */
  async say(text, { token, timeoutMs = 12_000, key = '', kind = '', messageId = null, context = null } = {}) {
    if (!this.isActive()) throw new Error('当前不在通话中');
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('要说的文本为空');
    const res = await fetch(this.sayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-console-token': token } : {})
      },
      body: JSON.stringify({ text: clean, key, kind, messageId, context }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.error || `call-loop /say HTTP ${res.status}`);
    }
    return body ?? { ok: true };
  }

  status(now = Date.now()) {
    this._check(now);
    return {
      active: this.active,
      withQQ: this.withQQ,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      ttlMs: this.ttlMs,
      routeKeys: [...this.routeKeys.keys()],
      lastError: this.lastError
    };
  }

  clear(reason = '') {
    const wasActive = this.active;
    this.active = false;
    this.withQQ = '';
    this.sayUrl = '';
    this.startedAt = 0;
    this.expiresAt = 0;
    this.routeKeys.clear();
    if (wasActive && reason) this.log('call', `presence 关闭：${reason}`);
  }
}

export function readConsoleToken(root) {
  try {
    const fromConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).consoleToken;
    if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim();
  } catch {}
  try {
    return fs.readFileSync(path.join(root, 'data', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
