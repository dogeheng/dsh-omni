// 通话内“刚才说话的是 X”这类控制句的解析。
// 只认明确句式，避免把普通聊天误当成声纹注册。
const BAD_NAMES = /^(谁|谁啊|哪个|什么人|什么|谁呀|不知道|有人|他|她|它|你|我)$/;

function cleanName(raw) {
  let text = String(raw ?? '').trim()
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
    .replace(/[，。！？、,.!?~～]+$/g, '')
    .replace(/[吗呢吧啊呀嘛]+$/g, '')
    .trim();
  text = text.replace(/^是/, '').trim();
  if (/^(不是|是不是|是么|是谁|是哪个)/.test(text)) return '';
  if (!text || text.length > 20) return '';
  if (BAD_NAMES.test(text)) return '';
  if (/[谁什么哪]/.test(text)) return '';
  return text;
}

/**
 * @param {string} text ASR 文本
 * @returns {{name:string, speakerIndex?:number}|null}
 */
export function parseSpeakerBinding(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (!t) return null;

  // 说话人2是张三 / S2 是张三
  let m = t.match(/(?:说话人|S)([1-8])(?:是|叫)([^，。！？、,.!?]{1,20})/i);
  if (m) {
    const name = cleanName(m[2]);
    return name ? { name, speakerIndex: Number(m[1]) } : null;
  }

  // 刚才说话的是张三
  m = t.match(/(?:刚才|刚刚|上一个|上一位)?说话的是([^，。！？、,.!?]{1,20})/);
  if (m) {
    const name = cleanName(m[1]);
    return name ? { name } : null;
  }

  // 记一下，张三 / 记一下，说话人2是张三
  m = t.match(/记一下[，,]?(?:说话人([1-8])(?:是|叫))?([^，。！？、,.!?]{1,20})/);
  if (m) {
    const name = cleanName(m[2]);
    return name ? { name, ...(m[1] ? { speakerIndex: Number(m[1]) } : {}) } : null;
  }

  return null;
}
