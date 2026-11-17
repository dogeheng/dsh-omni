// 发送失败的语义分类。
//
// 为什么需要：桥接对外层发送做过 `withTimeout(..., 15s)`，而底层 SDK 自己的请求超时是
// 30s（`@snowluma/sdk` 的 requestTimeoutMs 默认值）。旧实现只 race 不 abort，于是
// 15–30s 这段窗口里桥接已经判"失败"、底层请求却还在跑 —— 消息**可能其实已经送达**。
// 这时候如果模型照着"只补发失败项"的提示重发，群里就会出现重复消息。
//
// 现在的处理：
//   1) 把 SDK 的请求超时调成和桥接一致（见 bridge.js 里 new SnowLumaWebSocketClient 的
//      requestTimeoutMs），外层 withTimeout 只做稍大一点的看门狗，窗口基本消失；
//   2) 真出现超时/连接中断时，明确告诉模型"结果未知"：先核对最近消息，别直接重发。

/**
 * @param {unknown} error
 * @returns {{uncertain:boolean, hint:string}}
 */
export function classifySendFailure(error) {
  const name = String(error?.name ?? '');
  const code = String(error?.code ?? '');
  const text = [
    error?.message ?? String(error ?? ''),
    name,
    code,
    error?.cause?.message ?? '',
    error?.cause?.code ?? '',
  ].join(' ');
  const uncertain = /超时|timeout|timed out|aborted|abort|ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|ENOTFOUND|socket hang up|network/i.test(text);
  return {
    uncertain,
    hint: uncertain
      ? '超时/连接中断：这条**可能已经发出去了**。先用 qq_get_recent_messages 核对最近消息，确认没有再说补发，不要直接重发。'
      : '这条确定没发出去（请求没有被接受），可以只补发失败项。',
  };
}
