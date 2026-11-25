// SnowLuma 上游卡死的恢复判定（纯函数，便于测试）。
//
// 现象：桥接与 SnowLuma 的 WS 还连着，账号也在线，但 SnowLuma 的 QQ hook 卡住，
// 连续十几分钟没有任何事件包（连 30s 心跳都没有）。重启容器能清掉这个状态。
// 这里只决定「现在该不该自动重启」，真正执行由桥接负责；默认关闭，避免误伤。

export function shouldAutoRestartSnowluma({
  enabled = false,
  connected = false,
  lastPacketAt = 0,
  good = null,
  now = Date.now(),
  staleMs = 180_000,
  cooldownMs = 900_000,
  lastRestartAt = 0,
  restarting = false,
  // 「根本连不上」这一面（OneBot 没起来 / QQ 掉登录）：以前只在 connected=true 时才会
  // 自愈，结果容器明明在、OneBot 连不上，桥接却一直干等（11-24 掉了 6 小时就是这么来的）。
  disconnectedSince = 0,
  disconnectedRestartMs = 300_000,
  disconnectedRestarts = 0,
  maxDisconnectedRestarts = 3,
} = {}) {
  if (!enabled || restarting) return false;
  if (lastRestartAt && now - Number(lastRestartAt) < cooldownMs) return false;
  if (!connected) {
    // 断开超过 disconnectedRestartMs 才重启；连续重启 maxDisconnectedRestarts 次还连不上，
    // 多半是 QQ 需要扫码登录 —— 再重启也没用，交给告警/人工。
    const since = Number(disconnectedSince) || 0;
    if (!since || now - since < Math.max(60_000, Number(disconnectedRestartMs) || 300_000)) return false;
    if (Number(disconnectedRestarts) >= Number(maxDisconnectedRestarts)) return false;
    return true;
  }
  if (!Number.isFinite(Number(lastPacketAt)) || Number(lastPacketAt) <= 0) return false;
  if (good === false) return true;
  return now - Number(lastPacketAt) >= Math.max(60_000, Number(staleMs) || 180_000);
}
