// 待投递持久队列（outbox）。
//
// 为什么需要它：桥接现在的两支投递队列——DSH 未就绪时的 `queued`（上限 50 条）和
// 每会话串行的 `promptQueues`——都只活在内存里。桥接一重启（崩溃、`ensure-bridge` 拉起、
// 手动重启），还没投出去的消息就**永久消失**，而 QQ 那边看起来只是"它没理我"。
// `sessions.json` 只存 key→sessionId 的映射，救不了这个。
//
// 为什么不是"任务队列"：dsh-omni 的工作单位是一个 turn，turn 不可续跑；能续的只有
// "要投递的一段话"。所以这里存的是**投递意图**（一句话 + 它的唤醒原因/媒体），
// 不是任务状态机。刻意不做 status 机、租约、重试编排——失败就按次数退避，成功就删。
//
// 形状直接对齐 `src/short-cover/manager-v2.js` 已经跑熟的 queue.json：
// 单文件 + 原子写 + version 字段 + 启动时整体读回。那套已经在生产里验证过。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OUTBOX_VERSION = 1;

/** 第 n 次失败后等多久再试：3s → 6s → 12s … 封顶 60s。纯函数，测试直接钉。 */
export function backoffMs(attempts, { base = 3000, max = 60000 } = {}) {
  const n = Math.max(1, Math.min(16, Number(attempts) || 1));
  return Math.min(max, Math.round(base * Math.pow(2, n - 1)));
}

/** 投递文本。桥接的 payload 字段叫 promptText；单独接受 text 是为了让模块可独立测试。 */
export function deliveryText(entry) {
  return String(entry?.payload?.promptText ?? entry?.payload?.text ?? '');
}

/**
 * 这条队列项还值得保留吗。
 *
 * 唤醒项故意没有 promptText：真正的提示词由 deliverPromptNow 在**投递那一刻**
 * 用 wakeReason 重新拼（会话可能已换 token、未读也多了几条）。所以「文本为空」
 * 不等于「空条目」—— 旧实现只认文本，重启时会把这类条目静默丢掉，正好是最该
 * 保住的那一类（DSH 停机期间收到的 @ 和私聊）。
 */
export function isRestorable(entry) {
  return deliveryText(entry) !== '' || String(entry?.payload?.wakeReason ?? '') !== '';
}

/** 队列里同一条消息的判据：同一会话 + 同一段文本 + 同一唤醒原因，就不重复入队。 */
export function sameDelivery(a, b) {
  return !!a && !!b && a.key === b.key
    && deliveryText(a) === deliveryText(b)
    && String(a.payload?.wakeReason ?? '') === String(b.payload?.wakeReason ?? '');
}

/**
 * @param {object} options
 * @param {string} options.file 队列文件（通常是 data/outbox.json）
 * @param {(msg: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.maxEntries] 上限；超出丢最旧，避免异常时无限增长
 * @param {typeof fs} [options.fsImpl] 测试注入用
 */
export function createOutbox({ file, log = () => {}, now = Date.now, maxEntries = 500, fsImpl = fs } = {}) {
  if (!file) throw new Error('outbox 需要 file');
  let entries = [];
  let writable = true;

  function atomicWrite(data) {
    const tmp = `${file}.tmp`;
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
  }

  /**
   * 读回队列。文件损坏时**降级为只读**（与 sessions.json / 表情库同一口径）：
   * 宁可这次不持久化，也不能用一份空队列把用户原来的待投递消息覆盖掉。
   */
  function load() {
    let raw = null;
    try {
      raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        writable = false;
        log(`⚠️ outbox 读取失败，本次运行不写回（保留原文件）：${error?.message ?? error}`);
      }
      return [];
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
      writable = false;
      log('⚠️ outbox 内容不是预期形状，本次运行不写回（保留原文件）');
      return [];
    }
    entries = raw.entries
      .filter((e) => e && typeof e.id === 'string' && typeof e.key === 'string' && e.payload && typeof e.payload === 'object' && isRestorable(e))
      .map((e) => ({
        id: e.id,
        key: e.key,
        payload: e.payload,
        createdAt: Number(e.createdAt) || 0,
        attempts: Number(e.attempts) || 0,
        nextAt: Number(e.nextAt) || 0,
        lastError: typeof e.lastError === 'string' ? e.lastError : ''
      }));
    // 重启后所有条目都该尽快重试一次：上次的退避时间点已经没意义了（桥接都不在了）。
    for (const entry of entries) entry.nextAt = 0;
    return entries.slice();
  }

  function persist() {
    if (!writable) return;
    try {
      atomicWrite({ version: OUTBOX_VERSION, entries });
    } catch (error) {
      writable = false;
      log(`⚠️ outbox 写入失败，本次运行改为纯内存（不覆盖磁盘）：${error?.message ?? error}`);
    }
  }

  /**
   * 入队。默认**不去重**：同一个人连说两句"在吗"是两条消息，必须都投出去。
   * `dedupe: true` 只给"重试路径"用（同一次投递的重复入队要合并），由调用方显式要求。
   */
  function add({ key, payload, dedupe = false }) {
    const next = { key, payload };
    if (dedupe) {
      const existing = entries.find((e) => sameDelivery(e, next));
      if (existing) return existing;
    }
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      key,
      payload,
      createdAt: now(),
      attempts: 0,
      nextAt: 0,
      lastError: ''
    };
    entries.push(entry);
    if (entries.length > maxEntries) {
      entries.sort((a, b) => a.createdAt - b.createdAt);
      entries = entries.slice(entries.length - maxEntries);
      log(`outbox 超过 ${maxEntries} 条，丢弃最旧的待投递消息`);
    }
    persist();
    return entry;
  }

  /** 某会话（或全部）的待投递条目，按入队顺序；只有到点的才该被投。 */
  function pending(key) {
    const list = key == null ? entries.slice() : entries.filter((e) => e.key === key);
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  function ready(key, at = now()) {
    return pending(key).filter((e) => !e.nextAt || e.nextAt <= at);
  }

  function remove(id) {
    const before = entries.length;
    entries = entries.filter((e) => e.id !== id);
    if (entries.length !== before) persist();
  }

  /** 记一次失败：累加次数、算好下次可重试时间。 */
  function fail(id, error) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.attempts += 1;
    entry.lastError = String(error?.message ?? error ?? '').slice(0, 300);
    entry.nextAt = now() + backoffMs(entry.attempts);
    persist();
    return entry;
  }

  function size() { return entries.length; }
  function all() { return entries.slice(); }
  function clear() { entries = []; persist(); }

  return { load, add, pending, ready, remove, fail, size, all, clear, get file() { return file; } };
}
