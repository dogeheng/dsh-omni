// 站外告警：在 QQ 本身不可用的时候，用**别的通道**通知操作者。
//
// 为什么必须做：桥接现在把"网关掉线 / QQ 会话失效 / 合盖休眠"写在日志和控制台里，
// 而这三个故障的共同点是 **QQ 已经发不出消息**。唯一的报警通道变成"需要 QQ 才能看到"
// 的东西，人不在电脑前就永远不知道她哑了。日志实测每天 5~8 次休眠，每次都可能让
// QQ 会话失效 —— 这是这台机器上最常发生的故障。
//
// 设计约束：
//   · 按需：不挂任何轮询，全部由已有的健康检查 / 休眠采样在"事件发生"时调用；
//   · 可迁移：只认两条通道 —— macOS 系统通知（osascript，本机自带）与通用 webhook
//     （ntfy/Bark/自建服务都行，URL 由使用者填，代码里没有任何默认地址）；
//   · 不打扰：同一事件有最小间隔，另有每小时总量上限，失败只记日志不重试。
import { execFile as nodeExecFile } from 'node:child_process';

export const ALERT_EVENTS = Object.freeze(['startup', 'gatewayDown', 'qqOffline', 'upstreamDegraded', 'sleep', 'dshDown']);
export const ALERT_CHANNELS = Object.freeze(['macos', 'webhook']);

const EVENT_DEFAULTS = Object.freeze({
  startup: false,          // 每次启动都提醒一下？默认关（重启很频繁）
  gatewayDown: true,       // SnowLuma/QQ 链路断了
  qqOffline: true,         // WS 还连着但 QQ 账号掉线（多半是休眠后会话失效）
  upstreamDegraded: true,  // SnowLuma hook 卡死（收到了 WS 但收不到消息）
  sleep: true,             // 合盖/空闲休眠（会让 QQ 会话失效）
  dshDown: true,           // DSH 长时间不可用（重启/崩溃）
});

/** AppleScript 字符串转义：与 reminders.js 同口径（反斜杠、引号、换行）。 */
export function appleScriptString(value, max = 600) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .slice(0, max)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** 归一化告警配置（缺省全部安全：未开启、不写任何地址）。 */
export function normalizeAlertConfig(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const channels = Array.isArray(r.channels)
    ? [...new Set(r.channels.map((c) => String(c).trim()).filter((c) => ALERT_CHANNELS.includes(c)))]
    : ['macos'];
  const webhookRaw = r.webhook && typeof r.webhook === 'object' ? r.webhook : {};
  const eventsRaw = r.events && typeof r.events === 'object' ? r.events : {};
  const events = {};
  for (const event of ALERT_EVENTS) {
    const value = eventsRaw[event];
    events[event] = typeof value === 'boolean' ? value : EVENT_DEFAULTS[event];
  }
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    enabled: r.enabled === true,
    channels: channels.length ? channels : ['macos'],
    webhook: {
      url: typeof webhookRaw.url === 'string' ? webhookRaw.url.trim() : '',
      // 只接受字符串键值对：防止把对象/数组拼进请求头
      headers: Object.fromEntries(Object.entries(webhookRaw.headers && typeof webhookRaw.headers === 'object' ? webhookRaw.headers : {})
        .filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string')
        .slice(0, 12)),
      timeoutMs: num(webhookRaw.timeoutMs, 8000, 1000, 30000),
    },
    minIntervalMs: num(r.minIntervalMs, 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    maxPerHour: num(r.maxPerHour, 12, 1, 100),
    events,
  };
}

/**
 * 告警分发器。
 *
 * @param {object} p
 * @param {object} [p.config] normalizeAlertConfig 的结果
 * @param {(msg:string, err?:unknown)=>void} [p.logger]
 * @param {Function} [p.fetchImpl] 测试注入（默认全局 fetch）
 * @param {Function} [p.execFileImpl] 测试注入（默认 child_process.execFile）
 * @param {string} [p.platform] 测试注入（默认 process.platform）
 * @param {() => number} [p.now]
 */
export function createAlertDispatcher({
  config = {},
  logger = () => {},
  fetchImpl = globalThis.fetch,
  execFileImpl = nodeExecFile,
  platform = process.platform,
  now = Date.now,
} = {}) {
  const cfg = normalizeAlertConfig(config);
  const lastByEvent = new Map();
  const sentAt = [];   // 最近一小时的发送时间，用于总量上限
  let attempts = 0;
  let delivered = 0;
  let failed = 0;

  function rateLimited(event) {
    const t = now();
    const last = lastByEvent.get(event) || 0;
    if (cfg.minIntervalMs > 0 && last && t - last < cfg.minIntervalMs) return 'interval';
    while (sentAt.length && t - sentAt[0] > 60 * 60 * 1000) sentAt.shift();
    if (sentAt.length >= cfg.maxPerHour) return 'hourly';
    return null;
  }

  async function sendMacos(title, message) {
    if (platform !== 'darwin') return { ok: false, error: 'macOS 通知只在 darwin 上可用' };
    const script = `display notification "${appleScriptString(message)}" with title "${appleScriptString(title)}"`;
    try {
      await new Promise((resolve, reject) => {
        execFileImpl('osascript', ['-e', script], { timeout: 10000, maxBuffer: 64 * 1024 }, (error) => (error ? reject(error) : resolve()));
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  async function sendWebhook(event, title, message) {
    if (!cfg.webhook.url) return { ok: false, error: '未配置 webhook.url' };
    if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行时没有 fetch' };
    try {
      const res = await fetchImpl(cfg.webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cfg.webhook.headers },
        body: JSON.stringify({ event, title, message, at: new Date(now()).toISOString(), source: 'dsh-omni' }),
        signal: AbortSignal.timeout(cfg.webhook.timeoutMs),
      });
      if (!res?.ok) return { ok: false, error: `HTTP ${res?.status ?? '?'}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * 发一条告警。永远不抛：告警失败不能影响聊天主流程。
   * @returns {Promise<{ok:boolean, skipped?:string, channels?:object[]}>}
   */
  async function notify({ event, title, message = '' } = {}) {
    if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
    const name = String(event ?? '').trim();
    if (!ALERT_EVENTS.includes(name)) return { ok: false, skipped: 'unknown-event' };
    if (!cfg.events[name]) return { ok: false, skipped: 'event-off' };
    const limited = rateLimited(name);
    if (limited) return { ok: false, skipped: limited };
    const text = String(message ?? '').trim();
    const head = String(title ?? '').trim() || `dsh-omni：${name}`;
    // 先记账再发：宁可丢一条，也不要在异常路径上反复打同一个轰炸。
    lastByEvent.set(name, now());
    sentAt.push(now());
    attempts += 1;
    const channels = [];
    for (const channel of cfg.channels) {
      const result = channel === 'macos'
        ? await sendMacos(head, text)
        : await sendWebhook(name, head, text);
      if (result.ok) delivered += 1;
      else {
        failed += 1;
        logger(`[alert] ${channel} 发送失败（${name}）：${result.error}`);
      }
      channels.push({ channel, ...result });
    }
    const ok = channels.some((c) => c.ok);
    if (ok) logger(`[alert] ${name} 已发出：${head}${text ? ` / ${text.slice(0, 80)}` : ''}`);
    return { ok, channels };
  }

  return {
    cfg,
    notify,
    get stats() { return { attempts, delivered, failed }; },
    /** 测试用：清掉节流状态。 */
    reset() { lastByEvent.clear(); sentAt.length = 0; },
  };
}
