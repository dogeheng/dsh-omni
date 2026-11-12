// 把一通电话里的“用户说的话”送进长期记忆，复用文字聊天的规则：
//   - 普通句子 → memory.observeMessage（Level 2 候选缓冲，不调 LLM、不直接写长期记忆）
//   - “记住/记一下/帮我记…” → memory.remember（Level 1 显式记忆）
// 不写 AI 自己的话，不写原始音频/全文，不跨 scope。
import { looksExplicitRemember, guessExplicitKind } from './memory/index.js';

function stripExplicitCommand(text) {
  return String(text ?? '')
    .replace(/^(喂[，,。！!]?\s*)?(记住|记一下|帮我记(?:住)?|别忘了|记得提醒我?|存一下)[：:，,]?\s*/u, '')
    .trim();
}

/**
 * @param {object} p
 * @param {import('./memory/manager.js').MemoryManager} p.memory
 * @param {string} p.key               private:<qq> 或 group:<gid>
 * @param {string} p.text              用户这句话（ASR 文本）
 * @param {string} [p.userId]          说话人 QQ；私聊就是主人
 * @param {string} [p.sender]          展示名
 * @param {string|number|null} [p.messageId]
 */
export function recordCallTurn({ memory, key, text, userId = '', sender = '', messageId = null } = {}) {
  if (!memory) return { ok: false, reason: '记忆模块未初始化' };
  const cleanText = String(text ?? '').trim();
  if (!cleanText) return { ok: false, reason: '文本为空' };
  if (!/^(private|group):\d+$/.test(String(key ?? ''))) return { ok: false, reason: '会话 key 无效' };
  const ownerQQ = String(userId || '').trim();
  const ctx = memory.buildContext({
    conversationKey: key,
    ownerQQ,
    senders: ownerQQ && /^\d+$/.test(ownerQQ) ? [{ userId: ownerQQ, name: String(sender || '') }] : []
  });
  if (!ctx) return { ok: false, reason: '无法构造记忆上下文' };

  // Level 1：用户明确要求“记住”。只去掉命令词，不把“记住”本身写进事实。
  if (looksExplicitRemember(cleanText)) {
    const fact = stripExplicitCommand(cleanText);
    if (fact.length >= 4) {
      const result = memory.remember({
        ctx,
        kind: guessExplicitKind(fact),
        content: fact,
        subjectId: /^\d+$/.test(ownerQQ) ? ownerQQ : null,
        subjectLabel: String(sender || '').trim() || null,
        sourceMessageId: messageId,
        origin: 'explicit'
      });
      return { ...result, mode: 'explicit', text: fact };
    }
  }

  // Level 2：规则候选。命中才落候选，没命中一条都不写。
  const result = memory.observeMessage({
    ctx,
    msg: {
      userId: ownerQQ || null,
      sender: String(sender || '').trim() || null,
      plain: cleanText,
      text: cleanText,
      isSelf: false,
      hasMedia: false,
      kind: 'message',
      messageId: messageId ?? null
    }
  });
  return { ok: true, ...result, mode: 'candidate' };
}
