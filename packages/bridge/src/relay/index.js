// 外部应用中继（Relay）：本机程序 → QQ → 你的回答 → 本机程序。
//
// 定位：这不是"给 QQ 发通知"的 webhook，而是一条**请求/响应通道**。
// 一条 `ask` 带着问题出去，你的回复通过引用或 `#短码` 关联回来，原样交给调用方。
//
// 三条设计约束（见 docs 与提交说明）：
//   1. **默认不经过模型**：模型会带来延迟、成本、和改写；答案必须原样回到调用方。
//      附带好处是 DSH 挂了、模型欠费时这条通道照样能用。
//   2. **一次只问一个问题**：同一会话同时只允许一个 sent 状态的 ask，其余排队。
//      同时挂五个待答问题，关联必然出错。
//   3. **不做隐式匹配**：必须引用那条消息，或正文带 `#短码`。歧义时宁可反问，不猜。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELAY_VERSION = 1;

/** 终端态请求保留条数：够事后查，又不会让状态文件无限长。 */
export const KEEP_TERMINAL = 200;

/** 短码：4 位十六进制，会话内唯一，用来在消息里标"回哪条"。 */
export function makeCode(seed) {
  const hex = crypto.createHash('sha1').update(String(seed)).digest('hex');
  return hex.slice(0, 4);
}

/** 从正文里剥出 `#a3f9` 前缀；没有就返回 null。 */
export function parseCodePrefix(text) {
  const m = /^#([0-9a-f]{4})\b[\s:：,，-]*/i.exec(String(text ?? '').trim());
  if (!m) return null;
  return { code: m[1].toLowerCase(), rest: String(text ?? '').trim().slice(m[0].length).trim() };
}

/** QQ 不支持 markdown，这里只用纯文本；选项带序号，回答数字或原文都认。 */
export function formatRelayMessage({ appName = '应用', code, text, choices = [], expect = 'text', footer = true } = {}) {
  const lines = [`📨 ${appName} · #${code}`];
  lines.push(String(text ?? '').trim());
  if (Array.isArray(choices) && choices.length) {
    choices.forEach((c, i) => lines.push(`${i + 1}) ${c}`));
  }
  if (footer) lines.push(`—— 回复本条，或带上 #${code}`);
  return lines.join('\n');
}

/** 通知类消息：只要一行标题 + 正文，不带短码（本来就不等回答）。 */
export function formatNotifyMessage({ appName = '应用', text, level = 'info' } = {}) {
  const icon = level === 'urgent' ? '🚨' : level === 'warn' ? '⚠️' : '📨';
  return `${icon} ${appName}\n${String(text ?? '').trim()}`;
}

/**
 * 匹配一条入站消息是不是某个待答请求的回答。
 *
 * 只有两条路：引用（quoteId 命中发出去的那条）或 `#短码`。
 * 多条待答又没引用没短码 → 返回 ambiguous，让调用方反问；**绝不按"最近一条"猜**。
 *
 * @returns {{request: object, via: 'quote'|'code', answer: string} | {ambiguous: true} | null}
 */
export function matchAnswer(pending, { quoteId = null, text = '' } = {}) {
  const list = Array.isArray(pending) ? pending.filter((r) => r && r.status === 'sent') : [];
  if (!list.length) return null;
  if (quoteId != null) {
    const hit = list.find((r) => r.messageId != null && String(r.messageId) === String(quoteId));
    if (hit) return { request: hit, via: 'quote', answer: String(text ?? '').trim() };
  }
  const parsed = parseCodePrefix(text);
  if (parsed) {
    const hit = list.find((r) => r.code === parsed.code);
    if (hit) return { request: hit, via: 'code', answer: parsed.rest };
    // 短码写错了：当成"回错了"，不要退化成普通聊天把它交给模型。
    return { ambiguous: true, reason: 'unknown-code' };
  }
  return null;
}

/** 把"1"/"25k"这类回答对上选项序号。纯函数，测试直接钉。 */
export function resolveChoice(choices, answer) {
  const list = Array.isArray(choices) ? choices : [];
  if (!list.length) return {};
  const raw = String(answer ?? '').trim();
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= list.length) {
    return { choiceIndex: asNumber - 1, choice: list[asNumber - 1] };
  }
  const index = list.findIndex((c) => String(c).trim().toLowerCase() === raw.toLowerCase());
  if (index >= 0) return { choiceIndex: index, choice: list[index] };
  return {};
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {object} options
 * @param {string} options.stateFile
 * @param {string} options.appsFile
 * @param {(msg: string) => void} [options.log]
 * @param {(conversation: string, text: string) => Promise<string|null>} options.send 发出并返回 QQ message_id
 * @param {(conversation: string, text: string) => void} [options.recordSelf] 记成"自己说过"
 * @param {() => number} [options.now]
 * @param {() => string} options.defaultConversation 默认落点（private:xxx / group:xxx）
 */
export function createRelay({
  stateFile,
  appsFile,
  log = () => {},
  send,
  recordSelf = () => {},
  now = Date.now,
  defaultConversation = () => '',
  defaultTimeoutSec = 1800
} = {}) {
  if (!stateFile || !appsFile) throw new Error('relay 需要 stateFile 与 appsFile');
  if (typeof send !== 'function') throw new Error('relay 需要 send()');

  let requests = [];
  let apps = [];
  let writable = true;
  let writableApps = true;
  const waiters = new Map(); // id -> Set<resolve>

  function atomicWrite(file, data) {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function loadJson(file, fallback, label) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        writable = false;
        log(`⚠️ relay ${label} 读取失败，本次运行不写回（保留原文件）：${error?.message ?? error}`);
      }
      return fallback;
    }
  }

  function load() {
    const state = loadJson(stateFile, { version: RELAY_VERSION, requests: [] }, '状态');
    const appState = loadJson(appsFile, { version: RELAY_VERSION, apps: [] }, '应用表');
    requests = Array.isArray(state.requests) ? state.requests.filter((r) => r && typeof r.id === 'string') : [];
    apps = Array.isArray(appState.apps) ? appState.apps.filter((a) => a && typeof a.id === 'string') : [];
    // 重启后 queued 继续排、sent 继续等：messageId 还在，引用关联依旧有效。
    // **不要**把 sent 打回 queued —— 那会在 QQ 里再发一条同样短码的消息。
    for (const request of requests) {
      if (request.status === 'queued' && !request.expiresAt) request.expiresAt = now() + defaultTimeoutSec * 1000;
    }
    return requests.slice();
  }

  function persist() {
    if (!writable) return;
    try {
      atomicWrite(stateFile, { version: RELAY_VERSION, requests });
    } catch (error) {
      writable = false;
      log(`⚠️ relay 状态写入失败，本次运行改为纯内存：${error?.message ?? error}`);
    }
  }

  function persistApps() {
    if (!writableApps) return;
    try {
      atomicWrite(appsFile, { version: RELAY_VERSION, apps });
    } catch (error) {
      writableApps = false;
      log(`⚠️ relay 应用表写入失败，本次运行改为纯内存：${error?.message ?? error}`);
    }
  }

  function trim() {
    const terminal = requests.filter((r) => ['answered', 'timeout', 'cancelled', 'undeliverable'].includes(r.status));
    if (terminal.length <= KEEP_TERMINAL) return;
    const drop = new Set(terminal.slice(0, terminal.length - KEEP_TERMINAL).map((r) => r.id));
    requests = requests.filter((r) => !drop.has(r.id));
  }

  // ── 应用令牌 ────────────────────────────────────────────────────────────────
  function createApp(name) {
    const clean = String(name ?? '').trim().slice(0, 40);
    if (!clean) throw new Error('应用名不能为空');
    const token = `relay_${crypto.randomBytes(18).toString('hex')}`;
    const app = {
      id: `app_${crypto.randomBytes(4).toString('hex')}`,
      name: clean,
      tokenHash: hashToken(token),
      hint: token.slice(0, 12),
      createdAt: now(),
      lastUsedAt: 0,
      revokedAt: 0
    };
    apps.push(app);
    persistApps();
    return { app: publicApp(app), token };
  }

  function publicApp(app) {
    return { id: app.id, name: app.name, hint: app.hint, createdAt: app.createdAt, lastUsedAt: app.lastUsedAt, revoked: !!app.revokedAt };
  }

  function listApps() {
    return apps.map(publicApp);
  }

  function revokeApp(id) {
    const app = apps.find((a) => a.id === id);
    if (!app) return false;
    app.revokedAt = now();
    persistApps();
    return true;
  }

  /** 校验令牌：返回应用对象或 null。只比较 hash，令牌明文不落盘。 */
  function verify(token) {
    const raw = String(token ?? '').trim();
    if (!raw) return null;
    const digest = hashToken(raw);
    const app = apps.find((a) => !a.revokedAt && safeEqualHex(a.tokenHash, digest));
    if (!app) return null;
    app.lastUsedAt = now();
    persistApps();
    return publicApp(app);
  }

  // ── 请求生命周期 ────────────────────────────────────────────────────────────
  function nextCode(conversation) {
    for (let i = 0; i < 50; i += 1) {
      const code = makeCode(`${crypto.randomBytes(8).toString('hex')}:${i}`);
      if (!requests.some((r) => r.conversation === conversation && r.code === code && !isTerminal(r))) return code;
    }
    return crypto.randomBytes(2).toString('hex');
  }

  const isTerminal = (r) => ['answered', 'timeout', 'cancelled', 'undeliverable'].includes(r?.status);

  function notifyWaiters(id) {
    const set = waiters.get(id);
    if (!set) return;
    waiters.delete(id);
    for (const resolve of set) resolve(get(id));
  }

  function get(id) {
    const r = requests.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  function list({ status, conversation, limit = 50 } = {}) {
    let list_ = requests;
    if (status) list_ = list_.filter((r) => r.status === status);
    if (conversation) list_ = list_.filter((r) => r.conversation === conversation);
    return list_.slice(-Math.max(1, Math.min(200, limit))).reverse().map((r) => ({ ...r }));
  }

  function pending(conversation) {
    return requests.filter((r) => r.status === 'sent' && (!conversation || r.conversation === conversation));
  }

  function pickNext(conversation) {
    const queued = requests.filter((r) => r.status === 'queued' && r.kind === 'ask' && r.conversation === conversation);
    if (!queued.length) return null;
    // urgent 优先，其次按创建时间。
    queued.sort((a, b) => (b.level === 'urgent') - (a.level === 'urgent') || a.createdAt - b.createdAt);
    return queued[0];
  }

  // 同一个会话的 pump 必须串行：resolve()/cancel() 里是 `void pump()`，
  // 外部又会并发调 create()，两个 pump 同时看到同一条 queued 就会**重复发送**。
  // 这不是理论问题——测试里就复现了（同一条消息发了两次）。
  const pumpLocks = new Map(); // conversation -> Promise

  function pump(conversation) {
    if (!conversation) return Promise.resolve(null);
    const prev = pumpLocks.get(conversation) ?? Promise.resolve();
    const run = prev.then(() => pumpOnce(conversation));
    const settled = run.catch(() => null);
    pumpLocks.set(conversation, settled);
    settled.finally(() => { if (pumpLocks.get(conversation) === settled) pumpLocks.delete(conversation); });
    return run;
  }

  /**
   * 把队列里下一条发出去。同一会话同时只发一条 ask。
   * 发送失败（网关掉线）就留在 queued，等 sweep 重试。
   */
  /** 真正发一条：格式化 + 发送 + 落状态。pump 与"通知直发"共用。 */
  async function deliver(request) {
    const body = request.kind === 'ask'
      ? formatRelayMessage({ appName: request.appName, code: request.code, text: request.text, choices: request.choices })
      : formatNotifyMessage({ appName: request.appName, text: request.text, level: request.level });
    try {
      const messageId = await send(request.conversation, body);
      if (!messageId) throw new Error('网关未返回 message_id');
      request.status = 'sent';
      request.messageId = String(messageId);
      request.sentAt = now();
      request.attempts = (request.attempts || 0) + 1;
      request.lastError = '';
      try { recordSelf(request.conversation, body); } catch {}
      persist();
      log(`[relay] ${request.kind} ${request.id}${request.code ? ` (#${request.code})` : ''} 已发往 ${request.conversation}`);
      return request;
    } catch (error) {
      request.attempts = (request.attempts || 0) + 1;
      request.lastError = String(error?.message ?? error).slice(0, 200);
      persist();
      log(`[relay] ${request.id} 发送失败（留在队列）：${request.lastError}`);
      return null;
    }
  }

  async function pumpOnce(conversation) {
    if (!conversation) return null;
    // 通知不排队：它不等回答，没有理由被一个待答问题挡住半小时。
    // （旧写法里通知会排在 ask 后面，而 ask 可能要等到超时。）
    const notes = requests.filter((r) => r.status === 'queued' && r.kind === 'notify' && r.conversation === conversation);
    for (const note of notes) await deliver(note);
    if (requests.some((r) => r.status === 'sent' && r.conversation === conversation && r.kind === 'ask')) return null;
    const next = pickNext(conversation);
    if (!next) return null;
    if (next.expiresAt && now() > next.expiresAt) {
      next.status = 'timeout';
      next.lastError = '排队期间已超时';
      persist();
      notifyWaiters(next.id);
      return pumpOnce(conversation);
    }
    return deliver(next);
  }

  async function create({ app, kind = 'ask', text, choices = [], level = null, timeoutSec = defaultTimeoutSec, conversation, dedupeKey } = {}) {
    if (!app) throw new Error('缺少应用身份');
    const body = String(text ?? '').trim();
    if (!body) throw new Error('text 不能为空');
    if (body.length > 2000) throw new Error('text 过长（上限 2000 字）');
    const target = String(conversation || defaultConversation() || '').trim();
    if (!/^(private|group):\d+$/.test(target)) throw new Error('中继落点未配置（先在控制台设置私聊或群）');
    if (dedupeKey) {
      const existing = requests.find((r) => r.dedupeKey === dedupeKey && !isTerminal(r));
      if (existing) return { ...existing, deduped: true };
    }
    const id = `r_${crypto.randomBytes(4).toString('hex')}`;
    const code = kind === 'notify' ? '' : nextCode(target);
    const request = {
      id,
      code,
      appId: app.id,
      appName: app.name,
      kind: kind === 'notify' ? 'notify' : 'ask',
      // 通知默认 info（📨），提问默认 warn（⚠️）：通知只是告诉你一声，不该看起来像告警。
      level: ['info', 'warn', 'urgent'].includes(level) ? level : (kind === 'notify' ? 'info' : 'warn'),
      conversation: target,
      text: body,
      choices: Array.isArray(choices) ? choices.map((c) => String(c).slice(0, 40)).slice(0, 9) : [],
      expect: Array.isArray(choices) && choices.length ? 'choice' : 'text',
      status: 'queued',
      createdAt: now(),
      sentAt: 0,
      answeredAt: 0,
      expiresAt: now() + Math.max(30, Math.min(86400, Number(timeoutSec) || defaultTimeoutSec)) * 1000,
      messageId: '',
      answer: null,
      dedupeKey: dedupeKey ? String(dedupeKey).slice(0, 80) : '',
      attempts: 0,
      lastError: ''
    };
    requests.push(request);
    persist();
    await pump(target);
    return { ...request };
  }

  function resolve(id, { text = '', via = 'quote', attachments = [] } = {}) {
    const request = requests.find((r) => r.id === id);
    if (!request || isTerminal(request)) return null;
    const choice = resolveChoice(request.choices, text);
    request.status = 'answered';
    request.answeredAt = now();
    trim();
    request.answer = {
      text: String(text ?? '').trim(),
      ...choice,
      ...(attachments.length ? { attachments } : {}),
      via
    };
    persist();
    notifyWaiters(id);
    // 让出位置给下一条
    void pump(request.conversation);
    log(`[relay] ${id} 已回答（${via}）`);
    return { ...request };
  }

  function cancel(id) {
    const request = requests.find((r) => r.id === id);
    if (!request || isTerminal(request)) return null;
    request.status = 'cancelled';
    persist();
    notifyWaiters(id);
    void pump(request.conversation);
    return { ...request };
  }

  /** 定时扫描：超时的标 timeout，并给等待方一个明确结果（而不是永远挂着）。 */
  function sweep() {
    const at = now();
    const expired = [];
    for (const request of requests) {
      if (isTerminal(request)) continue;
      if (request.expiresAt && at > request.expiresAt) {
        request.status = 'timeout';
        persist();
        notifyWaiters(request.id);
        expired.push({ ...request });
      }
    }
    if (expired.length) trim();
    // 发送失败（网关掉线）的请求会留在 queued。旧写法只有 create/回答才触发 pump，
    // 于是网关恢复后没人再叫醒它们 —— 消息一直躺到超时。每次扫描给一次机会。
    const waiting = new Set(requests
      .filter((r) => r.status === 'queued' && (r.kind === 'ask' || r.kind === 'notify'))
      .map((r) => r.conversation));
    for (const conversation of waiting) void pump(conversation);
    return expired;
  }

  /**
   * 入站消息进来时调用。
   * @returns {{consumed: boolean, request?: object, ambiguous?: boolean}}
   */
  function onInbound({ conversation, quoteId = null, text = '', isOwner = false } = {}) {
    const pendingHere = pending(conversation);
    if (!pendingHere.length) return { consumed: false };
    if (!isOwner) {
      // 群友不能替外部应用回答问题：既不消费，也不当普通聊天——留给模型时会被误读成答非所问。
      return { consumed: false, ignored: true };
    }
    const matched = matchAnswer(pendingHere, { quoteId, text });
    if (!matched) return { consumed: false };
    if (matched.ambiguous) return { consumed: true, ambiguous: true };
    const answered = resolve(matched.request.id, { text: matched.answer, via: matched.via });
    return { consumed: true, request: answered };
  }

  /** 长轮询：等到终态或超时。返回最新请求快照。 */
  function wait(id, ms = 25000) {
    const current = get(id);
    if (!current || isTerminal(current)) return Promise.resolve(current);
    return new Promise((resolveWait) => {
      const bucket = waiters.get(id) ?? new Set();
      bucket.add(resolveWait);
      waiters.set(id, bucket);
      const timer = setTimeout(() => {
        const set = waiters.get(id);
        if (set) set.delete(resolveWait);
        resolveWait(get(id));
      }, Math.max(0, Math.min(60000, ms)));
      timer.unref?.();
    });
  }

  return {
    load, create, resolve, cancel, sweep, wait, get, list, pending, onInbound, pump,
    createApp, listApps, revokeApp, verify,
    get size() { return requests.length; }
  };
}
