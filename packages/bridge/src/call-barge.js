// 全双工前置：边听边判断。
// 她说话时用户开口，不立刻掐掉；先让 ASR 听完，如果是“嗯/对/好”这类应声，
// 继续说完；只有真正的插话才停止播放并取消当前推理。
const BACKCHANNEL_RE = /^(嗯+|嗯嗯+|对+|对对+|好+|好的|好呀|是+|是的|是啊|哦+|啊+|行+|可以|收到|明白|没错|对呀|ok|okay)$/i;

export function isBackchannel(text, seconds = 0) {
  const clean = String(text ?? '')
    .replace(/[。！？!?，,、~～…\s]/g, '')
    .trim();
  if (!clean) return false;
  if (Number(seconds) > 1.4) return false;
  return BACKCHANNEL_RE.test(clean);
}
