// 跨通道上下文：把“刚才群里那条消息 + 你在电话里怎么回的”压成一行，
// 只注入下一次通话的 prompt，不写进群会话，避免私聊语气/内容泄漏到群里。
export function buildCrossChannelNote({ key = '', source = null, reply = '' } = {}) {
  const text = String(source?.text ?? '').trim();
  if (!text) return '';
  const sender = String(source?.sender ?? '对方').trim().slice(0, 32) || '对方';
  const replyText = String(reply ?? '').trim().slice(0, 200);
  const media = Array.isArray(source?.media) && source.media.length > 0 ? '（带图片/媒体）' : '';
  return `【跨通道】你刚才在电话里回复了 QQ 会话 ${key} 里 ${sender} 的消息${media}：「${text.slice(0, 200)}」`
    + (replyText ? `；你当时说：「${replyText}」` : '')
    + '。如果用户接着聊这件事，你知道上下文。';
}
