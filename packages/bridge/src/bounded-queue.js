// 有界 FIFO 队列：生产者可能比消费者快时兜底（mux 事件流 → 事件循环）。
//
// 为什么需要：`_remoteMuxGenerator` 里的 inbox 是做「WebSocket 回调 → 异步迭代器」的
// 中转。消费端在 bridge 的 `for await` 循环里，而那个循环会 `await` QQ 发送 ——
// 一次慢发送（最长 SEND_TIMEOUT_MS）期间，事件只能往数组里堆，且没有任何上限。
//
// 这里只做"有界 + 计数"，不改变投递语义：默认满了丢**最旧**的，丢的时候回调一次，
// 由调用方决定怎么记日志。
//
// 可选的 `preferDrop` 让调用方声明「哪些项降级丢弃不伤语义」。mux 里就是流式 token
// （`assistant/chunk`）：`createTurnCollector` 明确忽略它（assistant/message 才是同一
// 内容的完整组装文本），token 账本也只吃 `assistant/message|assistant/attempt`，
// 所以先丢 chunk 既不会少发回复，也不会打歪账本。溢出时先从头找第一个
// `preferDrop(item) === true` 的项丢掉，一个都找不到才回退到丢最旧。
//
// **终结标记 `{kind:'end'}` 永远不能丢**：它**不匹配** preferDrop（没有 envelope/payload
// 形状，分类器恒为 false），而它又是最新入队的那条，所以回退的"丢最旧"也伤不到它 ——
// 两者合起来保证消费端一定看得到结束信号。丢了 end，`for await` 会永久挂起，
// 重连逻辑也收不到"流已结束"的通知。
//
// 性能：只在溢出时做丢弃决策，正常情况下 push/shift 都是 O(1)。`firstPreferred`/
// `scannedTo` 只是两个下标缓存（「最靠前的可优先丢弃项」与「已确认不是可优先丢弃项
// 的前缀」），没有常驻定时器，也不会每次 push 都全表扫。
export function createBoundedQueue({ max = 10000, onDrop = null, preferDrop = null } = {}) {
  // max 不是数字 → 用默认；显式给 0/负数 → 压到 1（只保最新一条），不要静默变大。
  const raw = Number.isFinite(Number(max)) ? Math.round(Number(max)) : 10000;
  const limit = Math.max(1, raw);
  const canPreferDrop = typeof preferDrop === 'function';
  let items = [];
  let dropped = 0;
  // 最靠前的可优先丢弃项下标；-1 = 队列里当前没有这样的项。
  let firstPreferred = -1;
  // [0, scannedTo) 已确认不满足 preferDrop；下次从这里继续往后找。
  let scannedTo = 0;

  function isPreferred(item) {
    if (!canPreferDrop) return false;
    // 分类器是调用方传进来的，抛错就当"不可优先丢"，不能把队列搞崩。
    try { return preferDrop(item) === true; } catch { return false; }
  }

  /** 从 start 起找第一个可优先丢弃项，返回下标（找不到 -1）；顺手推进缓存。 */
  function findPreferred(start) {
    let i = Math.max(0, start);
    while (i < items.length && !isPreferred(items[i])) i += 1;
    scannedTo = i;
    firstPreferred = i < items.length ? i : -1;
    return firstPreferred;
  }

  /** 删掉一个元素后维护缓存下标：被删位置之后的项整体前移一位。 */
  function noteRemoval(index) {
    if (scannedTo > index) scannedTo -= 1;
    if (firstPreferred > index) firstPreferred -= 1;
    else if (firstPreferred === index) {
      // 正好删掉了缓存的那一项：前缀仍已知，后面重新懒扫描。
      firstPreferred = -1;
      scannedTo = Math.min(scannedTo, index);
    }
  }

  return {
    push(item) {
      items.push(item);
      // 新项在队尾：只有它前面没有"未扫描区"时，才能直接断定它就是"最靠前的可优先
      // 丢弃项"；否则交给溢出时的 findPreferred 从 scannedTo 顺序找（保证仍是第一个）。
      if (canPreferDrop && scannedTo === items.length - 1 && isPreferred(item)) {
        firstPreferred = items.length - 1;
      }
      while (items.length > limit) {
        let lost;
        let index = -1;
        if (canPreferDrop) index = firstPreferred >= 0 ? firstPreferred : findPreferred(scannedTo);
        if (index >= 0) {
          lost = items.splice(index, 1)[0];
          noteRemoval(index);
        } else {
          lost = items.shift();
          noteRemoval(0);
        }
        dropped += 1;
        try { onDrop?.(lost, dropped); } catch { /* 回调自己的错不影响队列 */ }
      }
    },
    shift() {
      if (!items.length) return undefined;
      const item = items.shift();
      noteRemoval(0);
      return item;
    },
    get length() { return items.length; },
    get dropped() { return dropped; },
    /** 只给测试/诊断用：看一眼里面还剩什么。 */
    snapshot() { return items.slice(); },
  };
}
