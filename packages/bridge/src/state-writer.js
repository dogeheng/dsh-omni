// 状态文件的「合并写」。
//
// 背景：social-v2.json 每来一条 QQ 消息就要落盘一次（52 个 saveSocialV2State 调用点），
// 每次都是**全量** JSON.stringify + 原子写。现在 6 个会话已经 380KB，50 个群时单次约
// 10ms 的同步写会直接卡在 mux 事件循环和 MCP HTTP 工具线程上 —— 群里越热闹越抖。
//
// 这里把 delayMs 内的多次变更合并成一次，并且把快照的生成**推迟到真正落盘那一刻**：
// 中间那些消息的落盘开销几乎为零。文件格式不变，不需要迁移；退出前 flush 一次即可。

/**
 * @param {object} [options]
 * @param {number} [options.delayMs] 合并窗口（毫秒）
 * @param {Function} [options.setTimeoutImpl] 测试注入
 * @param {Function} [options.clearTimeoutImpl] 测试注入
 * @param {Function} [options.log] 落盘失败时用
 */
export function createCoalescedWriter({
  delayMs = 250,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  log = () => {},
} = {}) {
  let timer = null;
  let pending = null;
  let writes = 0;
  let lastError = null;

  /** 立刻落盘（退出前、或用例要读文件时调用）。没有待写内容时什么也不做。 */
  function flush() {
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (!pending) return false;
    const build = pending;
    pending = null;
    try {
      build();
      writes += 1;
      lastError = null;
    } catch (error) {
      lastError = error;
      log('状态落盘失败（内存态保留，下次变更会再试）:', error?.message ?? error);
    }
    return true;
  }

  /** 标记「有变化」：只记录最新的快照构造函数，到点再生成并落盘。 */
  function schedule(build) {
    if (typeof build !== 'function') throw new TypeError('schedule 需要一个返回快照的函数');
    pending = build; // 后到的覆盖先到的：落盘时永远是最新态
    if (timer) return;
    const wait = Math.max(0, Number(delayMs) || 0);
    timer = setTimeoutImpl(() => {
      timer = null;
      flush();
    }, wait);
    // 定时器不钉住进程：常驻进程无所谓，退出时由 process 'exit' 钩子统一 flush。
    timer?.unref?.();
  }

  return {
    schedule,
    flush,
    get pending() { return pending !== null; },
    get stats() { return { writes, lastError }; },
  };
}
