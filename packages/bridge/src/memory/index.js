// 记忆系统的对外入口。桥接、CLI 与测试统一从这里 import，避免各自挑文件导致
// 单一实现漂移（这个项目里最贵的一类 bug 就是"两份同源逻辑各自演化"）。

export {
  HARD_MAX_PROMPT_TOKENS,
  DEFAULT_MAX_EXTRA_CALLS_PER_DAY,
  MEMORY_PROMPT_TIERS,
  MEMORY_RETRIEVAL_MODES,
  defaultMemoryConfig,
  effectiveRetrievalMode,
  normalizeMemoryConfig,
  normalizePersonaId,
  resolveMemoryDbPath
} from './config.js';
export {
  SCOPE,
  KIND,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  SCOPE_LABEL,
  DEFAULT_CONFIDENCE,
  authorizeForget,
  authorizeWrite,
  buildReadContext,
  defaultWriteScope,
  isVisibleTo,
  parseConversationKey,
  scopePromptTag,
  visibleScopeClause
} from './scopes.js';
export {
  buildFtsMatchQuery,
  buildGramsText,
  estimateTokens,
  formatMemoryDate,
  localDayKey,
  normalizeForDedupe,
  quoteFtsToken,
  sanitizeMemoryContent,
  sanitizePromptLine,
  tokenizeMemoryText
} from './text.js';
export {
  classifyMemoryNeed,
  collectQueryText,
  rankMemoryRows,
  renderMemoryBlock,
  scoreMemory,
  stripNonContent
} from './retrieve.js';
export { CAPTURE_RULES, classifyCapture, guessExplicitKind, looksExplicitRemember } from './capture.js';
export { MemoryStore } from './store.js';
export {
  LEGACY_ORIGIN,
  planLegacyImport,
  readLegacyState,
  rollbackLegacyMigration,
  runLegacyMigration,
  verifyLegacyMigration
} from './legacy.js';
export {
  buildExtractionPrompt,
  parseExtractionOutput,
  planExtraction,
  runConsolidation,
  runExtractionOnce
} from './extract.js';
export { createMemoryManager } from './manager.js';
