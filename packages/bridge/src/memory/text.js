// 记忆检索的文本层：中文轻量分词、FTS 查询构造、Token 估算、脱敏与去重归一。
//
// 为什么不用 unicode61 直接吃中文：
//   SQLite 的 unicode61 把连续汉字当成**一个** token（"我下周五要面试" 会变成一整条），
//   所以 `WHERE content MATCH '面试'` 一条也匹配不到。第一版不上 embedding、不常驻分词
//   模型，只能自己切：**双字索引（bigram）+ 拉丁词**。索引期与查询期必须用同一个函数，
//   否则召回率会静默变成 0 —— 这是本文件存在的唯一理由。
//
// 另一条硬约束：FTS5 的 MATCH 语法里 `-`、`*`、`"`、`OR/AND/NOT`、括号都是操作符。
// 直接把用户消息拼进去会得到 "fts5: syntax error" 或语义完全跑偏的查询。我们只接受
// 由本文件切出来的字母/汉字 token，并逐个加引号，构造形如 ("小明" OR "明说") 的表达式。

// CJK 统一表意文字 + 扩展 A + 兼容表意 + 假名 + 谚文。切分只需判断「是不是汉字/假名」，
// 不是做语言识别。
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/** 单字符是否属于需要双字切分的 CJK 区段。 */
export function isCjkChar(ch) {
  return typeof ch === 'string' && ch.length > 0 && CJK_RE.test(ch);
}

// 查询侧的极短停用双字词：它们几乎每句话都有，留着只会把检索拉向噪声。
// **只用于查询**，索引侧不丢（否则「这个」出现在记忆原文里也没关系，检索时不需要它）。
const QUERY_STOP_GRAMS = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '这些', '那些', '什么', '怎么',
  '就是', '但是', '因为', '所以', '可以', '不是', '没有', '一个', '一下', '现在', '然后',
  '还是', '已经', '自己', '这样', '那样', '真的', '觉得', '知道', '如果', '虽然', '而且',
  'the', 'and', 'for', 'you', 'are', 'was', 'with', 'this', 'that'
]);

/**
 * 切出检索 token：
 *   - 连续 CJK 串 → 每两个相邻字符一个 bigram（长度 1 的串保留单字，便于单字查询）；
 *   - 连续拉丁/数字串 → 小写后整体保留（长度 >= 2）。
 * 顺序保留（便于调试），去重后截断到 maxTokens。
 */
export function tokenizeMemoryText(text, { maxTokens = 160 } = {}) {
  const src = String(text ?? '');
  const out = [];
  let cjkRun = '';
  let latinRun = '';
  const flushCjk = () => {
    if (!cjkRun) return;
    if (cjkRun.length === 1) out.push(cjkRun);
    else for (let i = 0; i < cjkRun.length - 1; i += 1) out.push(cjkRun.slice(i, i + 2));
    cjkRun = '';
  };
  const flushLatin = () => {
    if (latinRun.length >= 2) out.push(latinRun.toLowerCase());
    latinRun = '';
  };
  for (const ch of src) {
    if (isCjkChar(ch)) {
      flushLatin();
      cjkRun += ch;
    } else if (/[A-Za-z0-9]/.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  const seen = new Set();
  const result = [];
  for (const token of out) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
    if (result.length >= maxTokens) break;
  }
  return result;
}

/** 索引列：空格分隔的 token 串（FTS5 unicode61 按空格切，正好每个 bigram 一个 token）。 */
export function buildGramsText(text, opts = {}) {
  return tokenizeMemoryText(text, opts).join(' ');
}

/** FTS5 的引号转义：token 内部不允许出现任何语法字符，这里再兜一层。 */
export function quoteFtsToken(token) {
  const safe = String(token ?? '').replace(/[^\p{L}\p{N}_]/gu, '');
  if (!safe) return '';
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * 由用户文本构造 FTS5 MATCH 表达式。
 * 返回 null 表示「没有可用 token」—— 调用方必须退回结构化检索，绝不能拿空串去 MATCH
 * （空 MATCH 会抛 malformed MATCH expression）。
 */
export function buildFtsMatchQuery(text, { maxTokens = 24, dropStopwords = true } = {}) {
  const tokens = tokenizeMemoryText(text, { maxTokens: maxTokens * 3 })
    .filter((token) => !(dropStopwords && QUERY_STOP_GRAMS.has(token)))
    .slice(0, maxTokens);
  if (!tokens.length) return null;
  return { expression: tokens.map(quoteFtsToken).filter(Boolean).join(' OR '), tokens };
}

/**
 * 保守 Token 估算（宁可高估，不能低估）。
 *
 * 项目里没有准确的 tokenizer（DeepSeek 的分词表不随仓库分发），所以：
 *   - 每个 CJK 字符按 1 token 计（真实约 1 token / 1.2~1.6 字 → 高估约 20%~60%）；
 *   - 其它字符按 3.2 字符/token（英文真实约 4 → 高估约 25%）；
 *   - 再 +1 作为行结构开销。
 * 用它做「350 tokens 硬上限」的截断，实际消耗只会更少。
 */
export function estimateTokens(text) {
  const src = String(text ?? '');
  if (!src) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of src) {
    const code = ch.codePointAt(0);
    if (isCjkChar(ch) || (code >= 0xff00 && code <= 0xffef)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 3.2) + 1;
}

/** 去重归一：NFKC + 小写 + 去掉所有空白/标点，只留字母数字汉字。 */
export function normalizeForDedupe(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 600);
}

/**
 * 写入数据库前的清洗：去掉 NUL 与控制字符、折叠换行、截断。
 * **保留原文语义**（不删标点/不改写），因为记忆原文是事实来源。
 */
export function sanitizeMemoryContent(text, { maxChars = 400 } = {}) {
  const src = String(text ?? '')
    .replace(/\u0000/g, '')
    // 只保留常见空白：控制字符（含纵向制表、ESC）一律换成空格，避免污染终端/日志。
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (src.length <= maxChars) return src;
  return `${src.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 写进提示词的单行清洗。
 *
 * 检索出来的记忆是**数据**，不是指令。这里做的是「让它不可能伪造结构」：
 *   - 压成单行（去掉换行，防止伪造出一段新的【】标题）；
 *   - 去掉反引号、尖括号、markdown 标题符号；
 *   - 截断到 maxChars。
 * 真正的防注入靠 manager 渲染时的「数据不是指令」声明 + 权限：模型即便被骗，
 * 也拿不到它读不到的记忆（检索在 SQL 层就按 scope 过滤了）。
 */
export function sanitizePromptLine(text, { maxChars = 160 } = {}) {
  let src = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[`<>#|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 常见「假装成系统/工具输出」的前缀：保留内容，但把冒号前的角色标记打散。
  src = src.replace(/^(system|assistant|user|tool|系统|助手|用户|工具)\s*[:：]/i, '$1 ');
  if (src.length <= maxChars) return src;
  return `${src.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 「这条记忆是不是已经出现在旧注入里了」。
 * 迁移/过渡期 social-v2 的 topics/impressions 仍会注入，新块若再列同一条就是双份
 * Token。用足够长的原样子串判断重叠：只在**整段包含**时丢弃，避免误杀短句。
 */
export function overlapsText(line, haystack, { minChars = 8 } = {}) {
  const needle = normalizeForDedupe(line);
  if (!needle) return false;
  const hay = normalizeForDedupe(haystack);
  if (!hay) return false;
  if (needle.length < minChars) return false;
  return hay.includes(needle) || (needle.length >= 16 && hay.includes(needle.slice(0, Math.floor(needle.length * 0.8))));
}

/** 本地日期 YYYY-MM-DD（用于每日预算桶，必须与用户所在时区一致）。 */
export function localDayKey(now = Date.now(), timeZone = undefined) {
  const date = new Date(now);
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    } catch {
      /* 非法时区回退到本机时区 */
    }
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 展示用短日期：同年 MM-DD，跨年 YYYY-MM-DD。 */
export function formatMemoryDate(ms, now = Date.now()) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  if (d.getFullYear() === new Date(now).getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
