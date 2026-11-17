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

// ── 什么时候该取消在途回合 ────────────────────────────────────────────────────
//
// 线上日志里"打断思考：取消推理"出现了 109 次，而完整跑完的回合只有 21 次 —— 用户
// 问完、等了一两秒没声音、再开口（或只是"嗯？"），这一轮的答案就被整段丢掉，
// 表现就是"打电话时她经常不说话"。原因不是模型慢，而是**思考中开口被当成了打断**。

/**
 * 用户开口时该怎么办。
 *
 * - `none`  ：她既没出声也没在想，正常收一句。
 * - `queue` ：她还在想（没出声）。取消整轮 = 用户问完听到沉默；这里让这一轮答完，
 *             用户这句按普通语音入队，作为下一轮处理。
 * - `wait`  ：她正在出声且开了软打断，先让 ASR 听完再判断是应声还是真插话。
 * - `cancel`：她正在出声、没开软打断，开口即打断。
 */
export function decideSpeechStartBarge({ speaking = false, thinking = false, softBarge = true } = {}) {
  if (!speaking && !thinking) return 'none';
  if (thinking && !speaking) return 'queue';
  return softBarge ? 'wait' : 'cancel';
}

/** 提前打断的默认毫秒数（见 MIN_EARLY_BARGE_MS 的说明）。 */
export const DEFAULT_EARLY_BARGE_MS = 1200;

/**
 * 提前打断的下限。
 *
 * 从"用户开口"到"ASR 有结果"要经过：VAD 攒够 450ms 静音判句尾 + SenseVoice 50~120ms，
 * 也就是开口后 ~530ms 才可能有判定。阈值取 600ms 时，定时器必然赶在 ASR 之前烧掉，
 * 于是「嗯 / 对 / 好」这种应声一律被误杀 —— 软打断在默认配置下根本没机会生效。
 * 所以低于这个下限的配置会被抬到下限；0 仍然表示关闭。
 */
export const MIN_EARLY_BARGE_MS = 900;

export function resolveEarlyBargeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_EARLY_BARGE_MS;
  if (n <= 0) return 0;
  return Math.max(MIN_EARLY_BARGE_MS, Math.round(n));
}
