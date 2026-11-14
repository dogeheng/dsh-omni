// 通话读取长期记忆：把 bridge 的记忆检索结果压成一小段 prompt block。
// 只读；写入仍走 /api/call/memory。
export function buildCallMemoryContext({ memory, key, text = '', userId = '', speaker = '', ownerQQ = '' } = {}) {
  if (!memory) return { ok: false, block: '', tokens: 0, hits: 0, reason: '记忆模块未初始化' };
  if (!/^(private|group):\d+$/.test(String(key ?? ''))) return { ok: false, block: '', tokens: 0, hits: 0, reason: '会话 key 无效' };
  const query = String(text || '主人最近有什么约定、偏好和重要的事情').trim();
  const uid = /^\d{5,12}$/.test(String(userId || '')) ? String(userId) : '';
  const senders = uid ? [{ userId: uid, name: String(speaker || '') }] : [];
  const ctx = memory.buildContext({ conversationKey: key, ownerQQ: String(ownerQQ || ''), senders });
  if (!ctx) return { ok: false, block: '', tokens: 0, hits: 0, reason: '无法构造记忆上下文' };
  const result = memory.buildPromptBlock({ ctx, text: query, reason: 'call', key });
  return {
    ok: true,
    block: result.text || '',
    tokens: result.tokens || 0,
    hits: result.hits || 0,
    tier: result.tier || null,
    mode: result.mode || null
  };
}
