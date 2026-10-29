// Level 2：规则驱动的记忆候选缓冲（纯函数）。
//
// 目标不是"把聊天都存下来"，而是**只捞可能值得长期记住的那几句**：
// 计划/约定/边界/稳定的自我事实与偏好/发生过的事件。没命中的消息一条都不写。
//
// 为什么不用 LLM 逐条抽取：任务书的硬约束是「普通聊天不增加额外 LLM 调用」，
// 而逐条抽取会把每条消息都变成一次模型调用。规则有误判，但误判的代价是**多一条候选**，
// 候选在进入长期记忆前还要再过一道（显式确认 / 批量提炼），比逐条调用便宜三个数量级。
//
// 候选里只存：内容、来源会话/消息、作用域（桥接算好的）、人物 QQ 号、命中的规则。
// 不存完整聊天记录，也不存图片/语音。

/** 隐私兜底：看起来像凭据/密钥的内容一律不进记忆（宁可漏记，不可泄漏）。 */
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[:=]\s*\S{8,}|password\s*[:=]\s*\S{4,}|密码\s*[:：]\s*\S{4,}|token\s*[:=]\s*\S{16,})/i;

/** 规则表：顺序即优先级；第一个命中的规则决定 kind 与置信度。 */
export const CAPTURE_RULES = Object.freeze([
  {
    id: 'boundary',
    kind: 'preference',
    confidence: 0.86,
    re: /(以后别|不要再|别再|别提|不要提|别开.{0,6}玩笑|别叫|不喜欢别人|不许再|下次别)/
  },
  {
    id: 'promise',
    kind: 'promise',
    confidence: 0.84,
    // 「答应/说好/约定」必须跟一个具体动作，否则"说好了吗"这种问句也会被记成承诺。
    re: /((答应|说好|约好|约定|欠你|帮你|给你带|记得给我|提醒我)[^。！？!?]{0,30}(找|买|带|问|弄|写|做|查|改|发|看|约|还|请))|((我|你)(答应|说好)了)/
  },
  {
    id: 'plan',
    kind: 'state',
    confidence: 0.66,
    re: /((明天|后天|下周|下个月|下下个|周末|月底|年底|等会|待会|一会儿|今晚|这几天)[^。！？!?]{0,16}(面试|考试|出差|旅行|旅游|回家|见|开会|体检|比赛|生日|搬家|入职|离职|结婚|手术|去医院|上线|发布|答辩))|(我(要|得|准备|打算|计划|想)[^。！？!?]{0,14}(去|做|学|考|面|搬|离|换|见|报名))/
  },
  {
    id: 'preference',
    kind: 'preference',
    confidence: 0.72,
    re: /(我(很|超|挺|最|不)?(喜欢|爱|讨厌|不喜欢|受不了)|我(最近|这阵子|现在)?(在学|开始学|想学|在玩|在追|在补)|我(养|有)了?(一只|个)?(猫|狗|仓鼠|兔子)|我(吃素|不吃辣|不吃香菜|不喝酒|喝茶|喝咖啡))/
  },
  {
    id: 'self_fact',
    kind: 'fact',
    confidence: 0.74,
    re: /(我是[^。！？!?]{1,20}(学生|程序员|工程师|老师|医生|设计师|运营|老板|自由职业))|(我在[^。！？!?]{1,16}(上班|工作|读书|上学|读研|住))|(我(今年|刚|已经)[^。！？!?]{0,10}(毕业|结婚|换工作|搬家|入职|离职|成年|上大学|读研|退休))|(我叫[^。！？!?]{1,12})/
  },
  {
    id: 'event',
    kind: 'episode',
    confidence: 0.7,
    re: /(今天|昨天|前天|刚才|刚刚|早上|中午|晚上|这周)[^。！？!?]{0,20}(面试|考试|比赛|搬家|生日|吵架|分手|加班|生病|发烧|去医院|旅游|毕业|入职|离职|被裁|拿到|offer|涨薪|中奖|表白|领证)/
  },
  {
    id: 'explicit',
    kind: 'fact',
    confidence: 0.9,
    // 「记住/记一下/别忘了」是明确要求长期记住：即使规则没覆盖语义，也先落候选。
    re: /(记住|记一下|帮我记|别忘了|记得提醒|存一下|收藏一下这句话)/
  }
]);

/** 不应进入候选的消息形态：纯提问、纯感叹、太短、纯表情/媒体占位。 */
const QUESTION_ONLY_RE = /^(为什么|为啥|怎么|咋|什么|啥|哪|谁|吗|呢|是不是|有没有|能不能|可不可以|你觉得|你说|对不对|好不好)[^。]{0,20}[?？]?$/;

/**
 * 判断一条消息是否值得进入候选缓冲。
 *
 * @param {object} p
 * @param {string} p.text
 * @param {boolean} [p.isSelf]     自己发的消息不记（避免把 AI 的话当群友事实）
 * @param {boolean} [p.hasMedia]
 * @param {string} [p.kind]        'poke' 等系统事件不记
 * @returns {{kindHint:string, rule:string, confidence:number}|null}
 */
export function classifyCapture({ text = '', isSelf = false, hasMedia = false, kind = '' } = {}) {
  if (isSelf) return null;
  if (kind && kind !== 'message') return null;
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const stripped = raw.replace(/\[[^\]]{0,40}\]/g, '').trim();
  // 只剩表情/图片占位：没有可记的语义。
  if (!stripped || stripped.length < 4) return null;
  if (SECRET_RE.test(raw)) return null;
  if (QUESTION_ONLY_RE.test(stripped)) return null;
  // 全是同一个字符/连续哈哈哈：没有信息量。
  if (/^(.)\1{5,}$/.test(stripped)) return null;
  for (const rule of CAPTURE_RULES) {
    if (rule.re.test(stripped)) {
      return { kindHint: rule.kind, rule: rule.id, confidence: rule.confidence };
    }
  }
  return null;
}

/**
 * 显式记忆（Level 1）的 kind 猜测：模型只给内容时用它兜底。
 * 仍未命中则按 fact。
 */
export function guessExplicitKind(content) {
  const text = String(content ?? '');
  for (const rule of CAPTURE_RULES) {
    if (rule.id === 'explicit') continue;
    if (rule.re.test(text)) return rule.kind;
  }
  return 'fact';
}

/** 内容里有没有"要求长期记住"的措辞（用于给用户/日志一个显式标记）。 */
export function looksExplicitRemember(text) {
  return /(记住|记一下|帮我记|别忘了|记得提醒|以后都这样|以后就)/.test(String(text ?? ''));
}
