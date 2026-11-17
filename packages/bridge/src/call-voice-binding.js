// 通话内“刚才说话的是 X”这类控制句的解析。
// 只认明确句式，避免把普通聊天误当成声纹注册。
const BAD_NAMES = /^(谁|谁啊|哪个|什么人|什么|谁呀|不知道|有人|他|她|它|你|我|这个|那个|这样|那样|真的|假的|故意的|开玩笑|骗你)$/;

// 纠错句必须带"说/认/听"这类人相关的线索，避免把普通否定（"不是这样"）当成改声纹。
const CORRECTION_CUE = /(?:说话|说错|认错|听错|弄错|那位|这位|刚才那个|刚刚那个)/;

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
 * @returns {{action:'bind'|'unbind'|'rebind', name?:string, from?:string, speakerIndex?:number, self?:boolean}|null}
 *
 * action：
 * - bind（默认）：把刚才那位绑定成某个名字；
 * - unbind：认错了，把刚才那位的名字取消；
 * - rebind：认错了并改正（不是X，是Y）。
 */
export function parseSpeakerBinding(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (!t) return null;

  // 纠错：不是X，是Y（要求带人名线索，别把日常否定当成改声纹）
  // 疑问句（"是不是张三？""不是吗？"）不是纠错，别把提问当成改声纹。
  const negativeQuestion = /(?:是不是|不是吗)/.test(t);

  // 纠错：不是X，是Y。这一句本身就足够明确，可以不带"说话/刚才"这类线索；
  // 但仍然要求两边都是像名字的词（"不是这样，是那样"会被 cleanName 挡掉）。
  if (!negativeQuestion) {
    const m = t.match(/不是([^，。！？、,.!?]{1,20})[，,](?:是|叫)([^，。！？、,.!?]{1,20})/);
    if (m) {
      const from = cleanName(m[1]);
      const name = cleanName(m[2]);
      if (from && name) return { action: 'rebind', from, name };
    }
  }

  // 纠错：取消名字。必须带人相关的线索（说话/说错/认错/听错/弄错/那位…），
  // 否则"不是这样"这类日常否定会被误判成改声纹。
  if (CORRECTION_CUE.test(t) && !negativeQuestion) {
    let m = t.match(/(?:刚才|刚刚|上一个|上一位)?(?:说话的)?那位?不是([^，。！？、,.!?]{1,20})/);
    if (m) {
      const name = cleanName(m[1]);
      if (name) return { action: 'unbind', name };
    }
    m = t.match(/不是([^，。！？、,.!?]{1,20})[。！!]*$/);
    if (m) {
      const name = cleanName(m[1]);
      if (name) return { action: 'unbind', name };
    }
  }

  // 记住我的声线（通话内自注册）
  if (/记住我的声线|记住我的声音|记一下我的声线|记一下我的声音/.test(t)) {
    return { action: 'bind', self: true };
  }

  // 说话人2是张三 / S2 是张三
  let m = t.match(/(?:说话人|S)([1-8])(?:是|叫)([^，。！？、,.!?]{1,20})/i);
  if (m) {
    const name = cleanName(m[2]);
    return name ? { action: 'bind', name, speakerIndex: Number(m[1]) } : null;
  }

  // 刚才说话的是张三
  m = t.match(/(?:刚才|刚刚|上一个|上一位)?说话的是([^，。！？、,.!?]{1,20})/);
  if (m) {
    const name = cleanName(m[1]);
    return name ? { action: 'bind', name } : null;
  }

  // 记一下，张三 / 记一下，说话人2是张三
  m = t.match(/记一下[，,]?(?:说话人([1-8])(?:是|叫))?([^，。！？、,.!?]{1,20})/);
  if (m) {
    const name = cleanName(m[2]);
    return name ? { action: 'bind', name, ...(m[1] ? { speakerIndex: Number(m[1]) } : {}) } : null;
  }

  return null;
}
