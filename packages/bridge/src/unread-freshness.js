// 群/私聊未读的时效裁剪。
// 长时间没回消息时，未读会堆到上限；如果直接把最旧的 12 条塞给模型，
// 它很容易把几小时前的消息当“刚刚发生”来回复。这里只保留最近 staleMs 内的未读，
// 更早的从 unread 移除（仍留在 recentMessages 里当背景），并把水位安全前移。
export function pruneStaleUnread({ unread = [], now = Date.now(), staleMs = 2 * 60 * 60 * 1000, lastUnreadSeq = 0 } = {}) {
  const cutoff = now - Math.max(0, Number(staleMs) || 0);
  const kept = [];
  const removed = [];
  for (const msg of Array.isArray(unread) ? unread : []) {
    const time = Number(msg?.time);
    if (Number.isFinite(time) && time > 0 && time < cutoff) removed.push(msg);
    else kept.push(msg);
  }
  let through = null;
  if (removed.length) {
    const seqs = removed.map((m) => Number(m.seq)).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    if (seqs.length) through = Math.min(Number(lastUnreadSeq) || 0, Math.max(...seqs));
  }
  return { unread: kept, removed, through };
}
