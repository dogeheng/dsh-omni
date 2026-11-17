// 有界 FIFO 队列：生产者可能比消费者快时兜底（mux 事件流 → 事件循环）。
//
// 为什么需要：`_remoteMuxGenerator` 里的 inbox 是做「WebSocket 回调 → 异步迭代器」的
// 中转。消费端在 bridge 的 `for await` 循环里，而那个循环会 `await` QQ 发送 ——
// 一次慢发送（最长 SEND_TIMEOUT_MS）期间，事件只能往数组里堆，且没有任何上限。
//
// 这里只做"有界 + 计数"，不改变投递语义：满了丢**最旧**的，丢的时候回调一次，
// 由调用方决定怎么记日志。不丢 `{kind:'end'}` 这类终结标记 —— 它总是最新的那个。

export function createBoundedQueue({ max = 10000, onDrop = null } = {}) {
  // max 不是数字 → 用默认；显式给 0/负数 → 压到 1（只保最新一条），不要静默变大。
  const raw = Number.isFinite(Number(max)) ? Math.round(Number(max)) : 10000;
  const limit = Math.max(1, raw);
  let items = [];
  let dropped = 0;
  return {
    push(item) {
      items.push(item);
      while (items.length > limit) {
        const lost = items.shift();
        dropped += 1;
        try { onDrop?.(lost, dropped); } catch { /* 回调自己的错不影响队列 */ }
      }
    },
    shift() { return items.shift(); },
    get length() { return items.length; },
    get dropped() { return dropped; },
    /** 只给测试/诊断用：看一眼里面还剩什么。 */
    snapshot() { return items.slice(); },
  };
}
