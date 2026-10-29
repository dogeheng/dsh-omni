// 长期记忆系统的配置归一化（纯函数，可单测）。
//
// 设计边界：
//   1. 这里只做**归一化与钳制**，不读文件、不碰数据库、不依赖桥接内部状态 ——
//      配置是用户可直接编辑的，写错一个值不该让整段记忆系统失效；
//   2. 所有「硬上限」都在代码里钳死（不是只写在文档里）：单轮注入 350 tokens 是
//      本模块的硬上限，配置再大也会被压回来；每日 LLM 调用预算同理；
//   3. 默认**关闭**（enabled=false）。这是刻意的：长期记忆会改变提示词内容，
//      必须先跑完迁移与对照（retrieval.mode='shadow'）再切 live，否则等于未经
//      验证就改了线上聊天行为。见 docs/MEMORY.md 的上线步骤。

/** 单轮额外记忆注入的硬上限（tokens）。任何配置都不能突破它。 */
export const HARD_MAX_PROMPT_TOKENS = 350;
/** 默认每日自动 LLM 调用上限（提炼 + 巩固**共用**这一个预算）。 */
export const DEFAULT_MAX_EXTRA_CALLS_PER_DAY = 6;

export const MEMORY_PROMPT_TIERS = Object.freeze({
  // 普通闲聊/表情：有明确相关才注入，最多 50 tokens
  casual: 50,
  // 熟悉成员互动：最多 150 tokens
  familiar: 150,
  // 涉及共同经历：最多 250 tokens
  shared: 250,
  // 明确询问历史：最多 350 tokens
  history: HARD_MAX_PROMPT_TOKENS
});

export const MEMORY_RETRIEVAL_MODES = Object.freeze(['off', 'shadow', 'live']);

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const clampFloat = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

export function defaultMemoryConfig(root = '') {
  return {
    enabled: false,
    backend: 'sqlite',
    // 相对 ROOT；空 = data/memory/memory.sqlite
    dbPath: 'data/memory/memory.sqlite',
    // 空 = 单一共享人格（'default'）。多角色各自独立经历时才设成不同值。
    personaId: 'default',
    maxAdditionalRamMB: 50,
    cache: { maxEntries: 32, ttlMs: 60_000 },
    retrieval: {
      mode: 'shadow',
      embeddingEnabled: false,
      maxResults: 5,
      candidateLimit: 40,
      targetP95Ms: 20,
      minScore: 0.18,
      halfLifeDays: 30
    },
    prompt: {
      targetAverageTokens: 150,
      maxTokens: HARD_MAX_PROMPT_TOKENS,
      includeSessionState: false
    },
    capture: {
      explicitMemoryEnabled: true,
      candidateBufferEnabled: true,
      autoExtractionEnabled: false,
      batchCandidateThreshold: 15,
      maxExtraCallsPerDay: DEFAULT_MAX_EXTRA_CALLS_PER_DAY,
      minExtractionIntervalMs: 30 * 60 * 1000,
      candidateTtlMs: 7 * 24 * 60 * 60 * 1000,
      maxCandidates: 500,
      // 只对这些会话做自动提炼（空 = 全部）。灰度时先填测试群/测试私聊。
      extractionConversations: []
    },
    consolidation: {
      enabled: false,
      onlyWhenIdle: true,
      idleMs: 15 * 60 * 1000,
      preferACPower: true,
      intervalMs: 60 * 60 * 1000
    },
    security: {
      // 私有记忆不跨群/不进口群。设为 true 也只是记录一条警告，不会真的放开
      // （跨群泄漏是本系统最不能犯的错，放开需要改代码并过测试，不是一个开关）。
      crossGroupPrivateMemory: false
    },
    migrate: {
      legacySource: 'social-v2.json'
    },
    root: String(root ?? '')
  };
}

/**
 * 归一化 config.json 的 `memory` 段。
 * 未知字段丢弃、非法值收敛到默认，绝不 throw（桥接启动不能因为这里失败）。
 */
export function normalizeMemoryConfig(raw, { root = '' } = {}) {
  const def = defaultMemoryConfig(root);
  const src = isPlainObject(raw) ? raw : {};
  const retrieval = isPlainObject(src.retrieval) ? src.retrieval : {};
  const prompt = isPlainObject(src.prompt) ? src.prompt : {};
  const capture = isPlainObject(src.capture) ? src.capture : {};
  const consolidation = isPlainObject(src.consolidation) ? src.consolidation : {};
  const security = isPlainObject(src.security) ? src.security : {};
  const cache = isPlainObject(src.cache) ? src.cache : {};
  const migrate = isPlainObject(src.migrate) ? src.migrate : {};

  const maxTokens = clampInt(prompt.maxTokens, 50, HARD_MAX_PROMPT_TOKENS, def.prompt.maxTokens);
  const targetAverageTokens = clampInt(prompt.targetAverageTokens, 0, maxTokens, def.prompt.targetAverageTokens);
  const mode = MEMORY_RETRIEVAL_MODES.includes(String(retrieval.mode ?? '').trim())
    ? String(retrieval.mode).trim()
    : def.retrieval.mode;

  return {
    enabled: src.enabled === true,
    backend: 'sqlite',
    dbPath: typeof src.dbPath === 'string' && src.dbPath.trim() ? src.dbPath.trim() : def.dbPath,
    personaId: normalizePersonaId(src.personaId),
    maxAdditionalRamMB: clampInt(src.maxAdditionalRamMB, 1, 2048, def.maxAdditionalRamMB),
    cache: {
      maxEntries: clampInt(cache.maxEntries, 0, 512, def.cache.maxEntries),
      ttlMs: clampInt(cache.ttlMs, 0, 30 * 60 * 1000, def.cache.ttlMs)
    },
    retrieval: {
      mode,
      // 第一版明确不支持向量检索：配置成 true 会被忽略并记一条警告（由 manager 负责）。
      embeddingEnabled: false,
      maxResults: clampInt(retrieval.maxResults, 1, 20, def.retrieval.maxResults),
      candidateLimit: clampInt(retrieval.candidateLimit, 5, 200, def.retrieval.candidateLimit),
      targetP95Ms: clampInt(retrieval.targetP95Ms, 1, 5000, def.retrieval.targetP95Ms),
      minScore: clampFloat(retrieval.minScore, 0.05, 0.95, def.retrieval.minScore),
      halfLifeDays: clampInt(retrieval.halfLifeDays, 1, 3650, def.retrieval.halfLifeDays)
    },
    prompt: {
      targetAverageTokens,
      maxTokens,
      includeSessionState: bool(prompt.includeSessionState, def.prompt.includeSessionState)
    },
    capture: {
      explicitMemoryEnabled: bool(capture.explicitMemoryEnabled, def.capture.explicitMemoryEnabled),
      candidateBufferEnabled: bool(capture.candidateBufferEnabled, def.capture.candidateBufferEnabled),
      autoExtractionEnabled: capture.autoExtractionEnabled === true,
      // 阈值低于 5 会让提炼变成「每聊几句就调一次模型」，与「低 Token」目标冲突。
      batchCandidateThreshold: clampInt(capture.batchCandidateThreshold, 5, 200, def.capture.batchCandidateThreshold),
      // 默认 6；允许调到 24 但从默认值出发。提炼与巩固共用同一个预算表。
      maxExtraCallsPerDay: clampInt(capture.maxExtraCallsPerDay, 0, 24, def.capture.maxExtraCallsPerDay),
      minExtractionIntervalMs: clampInt(capture.minExtractionIntervalMs, 60_000, 24 * 60 * 60 * 1000, def.capture.minExtractionIntervalMs),
      candidateTtlMs: clampInt(capture.candidateTtlMs, 60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000, def.capture.candidateTtlMs),
      maxCandidates: clampInt(capture.maxCandidates, 50, 5000, def.capture.maxCandidates),
      extractionConversations: Array.isArray(capture.extractionConversations)
        ? capture.extractionConversations
          .map((k) => String(k ?? '').trim())
          .filter((k) => /^(group|private):\d+$/.test(k))
          .slice(0, 20)
        : []
    },
    consolidation: {
      enabled: consolidation.enabled === true,
      onlyWhenIdle: bool(consolidation.onlyWhenIdle, def.consolidation.onlyWhenIdle),
      idleMs: clampInt(consolidation.idleMs, 60_000, 24 * 60 * 60 * 1000, def.consolidation.idleMs),
      preferACPower: bool(consolidation.preferACPower, def.consolidation.preferACPower),
      intervalMs: clampInt(consolidation.intervalMs, 5 * 60 * 1000, 24 * 60 * 60 * 1000, def.consolidation.intervalMs)
    },
    security: {
      crossGroupPrivateMemory: security.crossGroupPrivateMemory === true
    },
    migrate: {
      legacySource: typeof migrate.legacySource === 'string' && migrate.legacySource.trim()
        ? migrate.legacySource.trim()
        : def.migrate.legacySource
    },
    root: String(root ?? '')
  };
}

/** persona_id 只允许安全字符：它会进 SQL 参数与文件路径（不拼路径，但保持可读可测）。 */
export function normalizePersonaId(value) {
  const s = String(value ?? '').trim();
  if (!s) return 'default';
  const safe = s.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
  return safe || 'default';
}

/**
 * 实际生效的检索模式：总开关关掉就是 off，不看 retrieval.mode。
 * 返回 'off' | 'shadow' | 'live'。
 */
export function effectiveRetrievalMode(cfg) {
  if (!cfg || cfg.enabled !== true) return 'off';
  return MEMORY_RETRIEVAL_MODES.includes(cfg.retrieval?.mode) ? cfg.retrieval.mode : 'shadow';
}

export function resolveMemoryDbPath(cfg) {
  const rel = String(cfg?.dbPath || defaultMemoryConfig().dbPath);
  if (rel.startsWith('/')) return rel;
  const root = String(cfg?.root || '');
  return root ? `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}` : rel;
}
