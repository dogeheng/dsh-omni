// 记忆系统门面（Bridge 只跟这一个对象打交道）。
//
// 职责：
//   - 懒加载 SQLite（第一次真正用到才建库），失败就**降级**：所有方法返回空结果，
//     桥接继续按原样聊天。记忆坏了不能把 QQ 主链路一起带走；
//   - 把「检索 → 排序 → 裁剪 → 渲染」串起来，并记录每轮的 Token/命中/耗时；
//   - 写路径（显式记忆 / 候选缓冲 / 删除）统一走 ACL，作用域永远由上下文算；
//   - 提供状态、指标、备份、迁移、巩固入口给控制台/CLI/测试。
//
// 内存：只保留一个小 LRU（默认 32 条检索结果）+ 指标环形缓冲，绝不缓存整库。

import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from './store.js';
import {
  authorizeForget, authorizeWrite, buildReadContext, defaultWriteScope, MEMORY_KINDS, parseConversationKey, SCOPE
} from './scopes.js';
import { classifyCapture, guessExplicitKind } from './capture.js';
import {
  buildFtsMatchQuery, localDayKey, normalizeForDedupe, sanitizeMemoryContent, tokenizeMemoryText
} from './text.js';
import { classifyMemoryNeed, rankMemoryRows, renderMemoryBlock } from './retrieve.js';
import { effectiveRetrievalMode, normalizeMemoryConfig, resolveMemoryDbPath } from './config.js';
import { planExtraction, runConsolidation, runExtractionOnce } from './extract.js';
import { rollbackLegacyMigration, runLegacyMigration, verifyLegacyMigration } from './legacy.js';

const METRICS_MAX_BYTES = 2 * 1024 * 1024;

function nowMs() {
  return Date.now();
}

/** 极简 LRU：Map 的插入顺序即新旧顺序，命中后重插到尾部。 */
class LruCache {
  constructor({ maxEntries = 32, ttlMs = 60_000 } = {}) {
    this.maxEntries = Math.max(0, Number(maxEntries) || 0);
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key, now = nowMs()) {
    if (!this.maxEntries) return undefined;
    const hit = this.map.get(key);
    if (!hit) { this.misses += 1; return undefined; }
    if (this.ttlMs && now - hit.at > this.ttlMs) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits += 1;
    return hit.value;
  }

  set(key, value, now = nowMs()) {
    if (!this.maxEntries) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }

  stats() {
    return { size: this.map.size, maxEntries: this.maxEntries, hits: this.hits, misses: this.misses };
  }
}

export function createMemoryManager({
  root = '', config = {}, logger = () => {}, now = nowMs, powerState = () => null
} = {}) {
  const cfg = normalizeMemoryConfig(config, { root });
  const personaId = cfg.personaId;
  const dbFile = resolveMemoryDbPath(cfg);
  const mode = effectiveRetrievalMode(cfg);
  const cache = new LruCache(cfg.cache);
  const metrics = {
    injections: 0,
    retrieved: 0,
    skipNoNeed: 0,
    hits: 0,
    injectedTokens: 0,
    maxTokens: 0,
    errors: 0,
    degraded: false,
    lastInjection: null,
    recent: []
  };
  // 建立 manager 时的 RSS 基线：用来在状态里给出"新增常驻内存"的实测值，
  // 超过 memory.maxAdditionalRamMB 时只告警一次（RSS 无法在进程内硬限制，只能监控）。
  const baselineRssBytes = (() => {
    try { return typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : 0; } catch { return 0; }
  })();
  const state = {
    store: null,
    ramWarned: false,
    openError: null,
    nextRetryAt: 0,
    generation: 0,
    lastRetrievalMs: 0,
    sparseWarned: false,
    lastMetricsAt: 0,
    lastConsolidationAt: 0,
    graceful: true
  };
  const metricsFile = path.join(path.dirname(dbFile), 'metrics.jsonl');

  function log(msg, err) {
    try { logger(msg, err); } catch { /* 日志本身不能抛 */ }
  }

  function safe(fn, fallback, label) {
    try {
      return fn();
    } catch (error) {
      metrics.errors += 1;
      log(`memory: ${label ?? '操作'}失败（已降级）：${error?.message ?? error}`);
      return fallback;
    }
  }

  function store() {
    if (!cfg.enabled) return null;
    if (state.store) return state.store;
    const t = now();
    if (t < state.nextRetryAt) return null;
    try {
      const s = new MemoryStore({ file: dbFile, logger: log, now });
      s.open();
      state.store = s;
      state.openError = null;
      state.nextRetryAt = 0;
      metrics.degraded = false;
      log(`memory: SQLite 记忆库已打开 ${dbFile}（WAL=${s.walEnabled}，模式=${mode}）`);
      return s;
    } catch (error) {
      state.openError = String(error?.message ?? error);
      state.nextRetryAt = t + 60_000; // 60s 后重试，期间静默降级，不刷日志
      metrics.degraded = true;
      log(`⚠️ memory: 记忆库打开失败，降级为无记忆聊天（60s 后重试）：${state.openError}`);
      return null;
    }
  }

  function recordMetrics(entry) {
    metrics.recent.push(entry);
    if (metrics.recent.length > 200) metrics.recent.splice(0, metrics.recent.length - 200);
    if (metrics.injections % 25 === 0) {
      try {
        const mem = process.memoryUsage();
        entry.rssMB = Math.round(mem.rss / 1048576);
        entry.heapUsedMB = Math.round(mem.heapUsed / 1048576);
      } catch { /* 某些运行时没有 process.memoryUsage，忽略 */ }
    }
    try {
      fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
      fs.appendFileSync(metricsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      const st = fs.statSync(metricsFile);
      if (st.size > METRICS_MAX_BYTES) fs.renameSync(metricsFile, `${metricsFile}.1`);
    } catch { /* 指标落盘失败不影响主链路 */ }
  }

  function bumpGeneration() {
    state.generation += 1;
    cache.clear();
  }

  function ctxSignature(ctx) {
    if (!ctx) return 'none';
    return [
      ctx.personaId, ctx.conversationKey,
      [...(ctx.senderIds ?? [])].sort().join(','),
      ctx.ownerQQ || '', ctx.isOwnerConversation ? 'owner' : ''
    ].join('|');
  }

  /** 由桥接提供的会话状态构造读取上下文（senders 必须来自可信消息记录）。 */
  function buildContext({ conversationKey, ownerQQ = '', senders = [] } = {}) {
    return buildReadContext({ conversationKey, personaId, ownerQQ, senders });
  }

  function upsertPersonFromMessage(ctx, msg) {
    const s = store();
    if (!s || !ctx) return null;
    const uid = String(msg?.userId ?? '').trim();
    if (!/^\d+$/.test(uid)) return null;
    return s.upsertPerson({
      personaId,
      qqId: uid,
      name: String(msg?.sender ?? '').trim(),
      seenIn: ctx.conversationKey,
      at: now()
    });
  }

  /**
   * Level 2：观察一条消息，命中规则就落候选（不调 LLM、不写长期记忆）。
   * @returns {{captured:boolean, rule?:string, kind?:string, id?:number|null}}
   */
  function observeMessage({ ctx, msg } = {}) {
    if (!cfg.enabled || !cfg.capture.candidateBufferEnabled) return { captured: false };
    return safe(() => {
      if (!ctx || !msg || msg.isSelf) return { captured: false };
      const s = store();
      if (!s) return { captured: false };
      const decision = classifyCapture({
        text: String(msg.plain ?? msg.text ?? ''),
        isSelf: !!msg.isSelf,
        hasMedia: !!msg.hasMedia,
        kind: String(msg.kind ?? 'message')
      });
      if (!decision) return { captured: false };
      upsertPersonFromMessage(ctx, msg);
      const scopeInfo = defaultWriteScope(ctx);
      if (!scopeInfo) return { captured: false };
      const content = sanitizeMemoryContent(String(msg.plain ?? msg.text ?? ''), { maxChars: 240 });
      const result = s.addCandidate({
        personaId,
        conversationKey: ctx.conversationKey,
        scope: scopeInfo.scope,
        scopeKey: scopeInfo.scopeKey,
        kindHint: decision.kindHint,
        subjectId: msg.userId != null ? String(msg.userId) : null,
        subjectLabel: String(msg.sender ?? '').slice(0, 32) || null,
        content,
        sourceMessageId: msg.messageId ?? null,
        sourceSeq: msg.seq ?? null,
        rule: decision.rule,
        confidence: decision.confidence,
        now: now()
      });
      // 轻量清理：每 50 次捕获检查一次 TTL/上限（不在每轮聊天里做全表扫描）。
      if (result.created) {
        state.captures = (state.captures ?? 0) + 1;
        if (state.captures % 50 === 0) {
          // 低频、批量、有界：清过期记忆状态 + 裁候选。每 50 次捕获才跑一次，
          // 不在每条消息里做全表扫描（普通聊天路径上只有一次 INSERT）。
          s.expireDue(now());
          s.pruneCandidates({
            personaId, ttlMs: cfg.capture.candidateTtlMs, maxCandidates: cfg.capture.maxCandidates, now: now()
          });
        }
      }
      return { captured: result.created, rule: decision.rule, kind: decision.kindHint, id: result.id };
    }, { captured: false }, '候选捕获');
  }

  /**
   * Level 1：显式记忆（qq_memory_append 的新 kind 走这里）。
   * @returns {{ok:boolean, reason?:string, id?:number|null, created?:boolean, scope?:string}}
   */
  function remember({
    ctx, kind, content, subjectId = null, subjectLabel = null, subjectKey = null,
    confidence = null, expiresAt = null, scope = null, sourceMessageId = null, origin = 'explicit'
  } = {}) {
    if (!cfg.enabled) return { ok: false, reason: '记忆系统未启用' };
    if (!cfg.capture.explicitMemoryEnabled) return { ok: false, reason: '显式记忆未启用' };
    return safe(() => {
      const s = store();
      if (!s) return { ok: false, reason: `记忆库不可用${state.openError ? `：${state.openError}` : ''}` };
      const text = sanitizeMemoryContent(content, { maxChars: 400 });
      if (!text) return { ok: false, reason: '记忆内容为空' };
      const finalKind = MEMORY_KINDS.includes(kind) ? kind : guessExplicitKind(text);
      const subject = subjectId != null && /^\d+$/.test(String(subjectId)) ? String(subjectId) : null;
      const auth = authorizeWrite(ctx, { kind: finalKind, scope, subjectId: subject });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      // 人物档案由 store.addMemory 统一建档（身份=QQ 号，昵称=别名）。
      const result = s.addMemory({
        personaId,
        scope: auth.scope,
        scopeKey: auth.scopeKey,
        kind: finalKind,
        subjectId: subject,
        subjectLabel: subjectLabel ? String(subjectLabel).slice(0, 64) : null,
        content: text,
        sourceMessageId: sourceMessageId != null ? sourceMessageId : null,
        sourceConversation: ctx?.conversationKey ?? null,
        origin,
        confidence,
        subjectKey: subjectKey ? sanitizeMemoryContent(subjectKey, { maxChars: 60 }) : null,
        expiresAt: expiresAt != null && Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : null,
        now: now()
      });
      bumpGeneration();
      return { ok: true, id: result.id, created: result.created, duplicate: !!result.duplicate, scope: auth.scope, kind: finalKind, superseded: result.superseded ?? [] };
    }, { ok: false, reason: '记忆写入异常（已降级）' }, '显式记忆写入');
  }

  /** 内部检索（不做 Token 裁剪），供 recall 与渲染共用。 */
  function retrieveRows({ ctx, text, maxResults = 5, includeSession = false, minScore = cfg.retrieval.minScore }) {
    const s = store();
    if (!s) return { rows: [], ms: 0 };
    const started = process.hrtime.bigint();
    const q = buildFtsMatchQuery(text, { maxTokens: 24 });
    const queryTokens = q?.tokens ?? tokenizeMemoryText(text, { maxTokens: 24 });
    const ftsRows = q ? s.queryFts({
      ctx, matchExpression: q.expression, limit: cfg.retrieval.candidateLimit, now: now(), includeSession
    }) : [];
    // "我明天去哪"这类第一人称问题：把当前说话人的事实/计划也纳入结构化召回，
    // 否则"10/30 去波士顿"这种已经写成日期的记忆永远匹配不到"明天"。
    const selfQuestion = /我/.test(String(text)) && /[?？]|哪|什么|怎么|几点|吗|呢|谁|多少/.test(String(text));
    const structuredRows = s.queryAboutPeople({
      ctx,
      subjectIds: ctx.senderIds,
      kinds: selfQuestion
        ? ['impression', 'promise', 'state', 'fact', 'preference']
        : ['impression', 'promise', 'state'],
      limit: Math.min(8, cfg.retrieval.candidateLimit),
      now: now()
    });
    const subjectFilter = s.findPeopleMentioned({ personaId, text });
    const ranked = rankMemoryRows({
      ftsRows,
      structuredRows,
      queryTokens,
      ctx,
      now: now(),
      halfLifeDays: cfg.retrieval.halfLifeDays,
      minScore,
      limit: Math.max(maxResults, 1),
      queryText: text,
      subjectFilter,
      selfQuestion
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    state.lastRetrievalMs = ms;
    return { rows: ranked, ms };
  }

  /** 按权限检索（供 qq_memory_query / 控制台用）。 */
  function recall({ ctx, text = '', limit = cfg.retrieval.maxResults, includeSession = true } = {}) {
    if (!cfg.enabled) return { ok: false, reason: '记忆系统未启用', rows: [], ms: 0 };
    return safe(() => {
      const result = retrieveRows({ ctx, text, maxResults: Math.min(20, Math.max(1, limit)), includeSession });
      return { ok: true, rows: result.rows, ms: Math.round(result.ms * 100) / 100 };
    }, { ok: false, reason: '检索异常（已降级）', rows: [], ms: 0 }, '记忆检索');
  }

  /**
   * 构造本轮要注入的长期记忆块。
   *
   * @param {object} p
   * @param {object} p.ctx
   * @param {string} p.text          最近对方消息（检索依据）
   * @param {string} [p.reason]      唤醒原因
   * @param {string} [p.legacyText]  旧的 formatMemoryV2 输出（用于去重，避免两份）
   * @param {string} [p.key]         会话 key（只用于指标）
   * @returns {{text:string, tokens:number, hits:number, retrieved:boolean, tier:string, mode:string, ms:number}}
   */
  function buildPromptBlock({ ctx, text = '', reason = '', legacyText = '', key = '' } = {}) {
    const empty = { text: '', tokens: 0, hits: 0, retrieved: false, tier: 'casual', mode, ms: 0 };
    if (mode === 'off' || !cfg.enabled || !ctx) {
      metrics.skipNoNeed += 1;
      return empty;
    }
    const need = classifyMemoryNeed({ text, reason, memberKnown: false });
    if (!need.wantRetrieval || need.maxTokens <= 0) {
      metrics.skipNoNeed += 1;
      metrics.injections += 1;
      metrics.lastInjection = { at: new Date(now()).toISOString(), key, tier: need.tier, hits: 0, tokens: 0, retrieved: false, mode };
      recordMetrics({ t: now(), key, tier: need.tier, retrieved: false, hits: 0, tokens: 0, ms: 0, mode });
      return { ...empty, tier: need.tier };
    }
    const s = store();
    if (!s) {
      metrics.injections += 1;
      recordMetrics({ t: now(), key, tier: need.tier, retrieved: false, hits: 0, tokens: 0, ms: 0, mode, degraded: true });
      return { ...empty, tier: need.tier };
    }
    const cacheKey = [
      state.generation, ctxSignature(ctx), normalizeForDedupe(text).slice(0, 120),
      need.maxResults, need.tier, cfg.prompt.includeSessionState ? 'withSession' : 'noSession'
    ].join('|');
    let rows = cache.get(cacheKey, now());
    let ms = 0;
    let cached = !!rows;
    if (!rows) {
      const result = retrieveRows({
        ctx,
        text,
        maxResults: need.maxResults,
        includeSession: cfg.prompt.includeSessionState,
        // 档位越轻，门槛越严（闲聊宁可不说，也别翻旧账）。
        minScore: Math.max(cfg.retrieval.minScore, need.minScore ?? 0)
      });
      rows = result.rows;
      ms = result.ms;
      if (rows.length) cache.set(cacheKey, rows, now());
    }
    const budget = Math.min(need.maxTokens, cfg.prompt.maxTokens);
    let peopleByQq = null;
    try {
      peopleByQq = new Map(s.listPeople(personaId, { limit: 500 }).map((p) => [String(p.qqId), p]));
    } catch { peopleByQq = null; }
    const rendered = renderMemoryBlock({
      rows, ctx, maxTokens: budget, avoidText: legacyText, now: now(), peopleByQq,
      compact: need.tier === 'casual', queryText: text
    });
    metrics.retrieved += 1;
    metrics.injections += 1;
    metrics.hits += rendered.lines.length;
    const observedTokens = mode === 'live' ? rendered.tokens : rendered.tokens;
    metrics.injectedTokens += observedTokens;
    metrics.maxTokens = Math.max(metrics.maxTokens, observedTokens);
    metrics.lastInjection = {
      at: new Date(now()).toISOString(), key, tier: need.tier, hits: rendered.lines.length,
      tokens: observedTokens, retrieved: true, mode, ms: Math.round(ms * 100) / 100
    };
    recordMetrics({
      t: now(), key, tier: need.tier, retrieved: true, hits: rendered.lines.length,
      tokens: observedTokens, ms: Math.round(ms * 100) / 100, cached, mode
    });
    return {
      // shadow：只计算与记账，不改提示词 —— 用于上线前对照。
      text: mode === 'live' ? rendered.text : '',
      tokens: observedTokens,
      hits: rendered.lines.length,
      retrieved: true,
      tier: need.tier,
      mode,
      ms: Math.round(ms * 100) / 100,
      preview: mode === 'shadow' ? rendered.text : undefined
    };
  }

  /**
   * 删除记忆（真删：DB + FTS）。可为 null 的 id / 内容匹配 / 人物。
   */
  function forget({ ctx, id = null, content = null, subjectId = null, kinds = null, limit = 5 } = {}) {
    if (!cfg.enabled) return { ok: false, reason: '记忆系统未启用', removed: [] };
    return safe(() => {
      const s = store();
      if (!s) return { ok: false, reason: '记忆库不可用', removed: [] };
      let rows = [];
      if (id != null) {
        const row = s.getMemory(id);
        if (row) rows = [row];
      } else {
        const visible = s.listMemories({
          personaId, ctx, kind: kinds?.[0] ?? null, subjectId: subjectId ? String(subjectId) : null,
          status: 'active', limit: 50
        });
        const needle = normalizeForDedupe(content ?? '');
        rows = visible.filter((row) => {
          if (kinds?.length && !kinds.includes(row.kind)) return false;
          if (!needle) return true;
          const hay = normalizeForDedupe(row.content);
          return hay.includes(needle) || needle.includes(hay);
        }).slice(0, limit);
      }
      const removed = [];
      const denied = [];
      for (const row of rows) {
        const auth = authorizeForget(ctx, row);
        if (!auth.ok) { denied.push({ id: row.id, reason: auth.reason }); continue; }
        if (s.deleteMemory(row.id, { reason: '用户要求删除' })) {
          // 墓碑先写：即使随后旧 social-v2 清理失败/进程崩了，重迁与提炼也不会复活这条。
          s.addTombstone({ personaId, row, now: now() });
          removed.push({
            id: row.id, scope: row.scope, scopeKey: row.scopeKey, kind: row.kind,
            content: row.content, subjectId: row.subjectId, subjectLabel: row.subjectLabel
          });
        }
      }
      if (removed.length) bumpGeneration();
      return {
        ok: removed.length > 0,
        removed,
        denied,
        reason: removed.length ? undefined : (denied.length ? denied[0].reason : '没有找到可删除的记忆')
      };
    }, { ok: false, reason: '删除异常（已降级）', removed: [] }, '记忆删除');
  }

  /**
   * Session 退役钩子：把「不会过期的会话内状态」（多来自迁移的 topics / 显式写入）
   * 提升到会话所属作用域，让它在下次重建后仍能被检索。
   * 带 expires_at 的短期状态（想说未说）**不提升**：它们本来就是会话内的。
   */
  function onSessionRetire({ key } = {}) {
    if (!cfg.enabled) return { promoted: 0 };
    return safe(() => {
      const s = store();
      const parsed = parseConversationKey(key);
      if (!s || !parsed) return { promoted: 0 };
      const scope = parsed.kind === 'group' ? SCOPE.GROUP : SCOPE.DM;
      const scopeKey = parsed.id;
      const info = s.db.prepare(`UPDATE memories SET scope = ?, scope_key = ?, updated_at = ?
        WHERE persona_id = ? AND scope = 'session' AND scope_key = ? AND status = 'active'
          AND expires_at IS NULL AND kind IN ('promise','state','episode')`)
        .run(scope, scopeKey, now(), personaId, key);
      const promoted = Number(info.changes ?? 0);
      if (promoted) bumpGeneration();
      return { promoted };
    }, { promoted: 0 }, '会话退役状态提升');
  }

  /** 旧数据迁移（供 CLI / 启动时手动触发）。 */
  function migrateLegacy({ legacyFile, backupDir = path.join(path.dirname(dbFile), 'backups'), force = false } = {}) {
    if (!cfg.enabled) return { ok: false, reason: '记忆系统未启用' };
    return safe(() => {
      const s = store();
      if (!s) return { ok: false, reason: `记忆库不可用：${state.openError ?? ''}` };
      const result = runLegacyMigration(s, { legacyFile, backupDir, personaId, now: now(), logger: log, force });
      if (result.imported) bumpGeneration();
      return result;
    }, { ok: false, reason: '迁移异常' }, '旧数据迁移');
  }

  function verifyLegacy({ legacyFile } = {}) {
    return safe(() => {
      const s = store();
      if (!s) return { ok: false, reason: '记忆库不可用' };
      return verifyLegacyMigration(s, { legacyFile, personaId });
    }, { ok: false, reason: '校验异常' }, '迁移校验');
  }

  function rollbackLegacy({ backupDir = path.join(path.dirname(dbFile), 'backups') } = {}) {
    return safe(() => {
      const s = store();
      if (!s) return { ok: false, reason: '记忆库不可用' };
      const result = rollbackLegacyMigration(s, { backupDir, personaId, now: now(), logger: log });
      bumpGeneration();
      return result;
    }, { ok: false, reason: '回滚异常' }, '迁移回滚');
  }

  /**
   * 后台 tick（由桥接的低频定时器调用，或在 CLI 里手动调）。
   * 同时负责 P3 提炼与本地巩固；两者都遵守同一份每日 LLM 预算。
   */
  async function tick({ invoke = null, idleForMs = Number.POSITIVE_INFINITY, power = null, force = false } = {}) {
    if (!cfg.enabled) return { ran: false, reason: 'disabled' };
    const s = store();
    if (!s) return { ran: false, reason: 'store-unavailable' };
    const t = now();
    if (cfg.consolidation.enabled && t - state.lastConsolidationAt >= cfg.consolidation.intervalMs) {
      state.lastConsolidationAt = t;
      runConsolidation({ store: s, cfg, personaId, now: t });
    }
    const plan = planExtraction({ store: s, cfg, personaId, now: t, power, idleForMs, force });
    if (!plan.run) return { ran: false, reason: plan.reason };
    if (typeof invoke !== 'function') return { ran: false, reason: '没有可用的 LLM 通道' };
    const result = await runExtractionOnce({
      store: s, cfg, personaId, invoke, now: t, power, idleForMs, logger: log, force
    });
    if (result.created) bumpGeneration();
    return result;
  }

  function metricsSummary() {
    const n = Math.max(1, metrics.injections);
    return {
      injections: metrics.injections,
      retrieved: metrics.retrieved,
      skipNoNeed: metrics.skipNoNeed,
      hits: metrics.hits,
      avgTokensPerInjection: Math.round((metrics.injectedTokens / n) * 10) / 10,
      maxTokens: metrics.maxTokens,
      errors: metrics.errors,
      degraded: metrics.degraded,
      cache: cache.stats(),
      lastInjection: metrics.lastInjection,
      lastRetrievalMs: Math.round(state.lastRetrievalMs * 100) / 100
    };
  }

  function status() {
    const base = {
      enabled: cfg.enabled,
      mode,
      personaId,
      dbFile,
      dbPath: cfg.dbPath,
      config: cfg,
      openError: state.openError,
      generation: state.generation,
      metrics: metricsSummary(),
      budget: { day: localDayKey(now()), used: null, max: cfg.capture.maxExtraCallsPerDay }
    };
    // 状态查询也要能懒打开库：否则刚启动/还没检索过时，控制台看到的是"没有库"。
    const s = store();
    if (!s) return base;
    return safe(() => {
      const mem = typeof process.memoryUsage === 'function' ? process.memoryUsage() : null;
      if (mem && baselineRssBytes && !state.ramWarned) {
        const deltaMB = (mem.rss - baselineRssBytes) / 1048576;
        if (deltaMB > cfg.maxAdditionalRamMB) {
          state.ramWarned = true;
          log(`⚠️ memory: 新增常驻内存 ${deltaMB.toFixed(1)}MB 超过目标 ${cfg.maxAdditionalRamMB}MB（RSS 无法硬限制，仅告警；可用 memory-bench 复核）`);
        }
      }
      return {
        ...base,
        db: s.stats({ personaId }),
        cache: cache.stats(),
        memory: mem ? {
          rssMB: Math.round(mem.rss / 1048576),
          heapUsedMB: Math.round(mem.heapUsed / 1048576),
          externalMB: Math.round((mem.external ?? 0) / 1048576),
          // 新增常驻内存的实测值（相对建立 manager 时），用来对照 maxAdditionalRamMB。
          rssDeltaMB: baselineRssBytes ? Math.round((mem.rss - baselineRssBytes) / 10485.76) / 100 : null
        } : null,
        budget: {
          day: localDayKey(now()),
          used: s.llmCallsToday({ personaId, day: localDayKey(now()) }),
          max: cfg.capture.maxExtraCallsPerDay
        },
        lastMigration: s.lastMigration({ source: cfg.migrate.legacySource }),
        selfState: {
          lastExtractionAt: s.getSelfState(personaId, 'lastExtractionAt')?.value ?? null
        }
      };
    }, base, '状态读取');
  }

  function close() {
    if (state.store) {
      try { state.store.close(); } catch { /* ignore */ }
      state.store = null;
    }
  }

  // 初始化时把「不会生效的安全配置」明确记一行日志，避免用户以为开了就有跨群共享。
  if (cfg.security.crossGroupPrivateMemory) {
    log('⚠️ memory.security.crossGroupPrivateMemory=true 被忽略：跨群私有记忆共享需要改代码并过测试，配置开关不生效。');
  }
  if (config?.retrieval?.embeddingEnabled) {
    log('⚠️ memory.retrieval.embeddingEnabled=true 被忽略：第一版不加载任何 embedding 模型。');
  }

  return {
    cfg,
    personaId,
    mode,
    dbFile,
    buildContext,
    observeMessage,
    remember,
    recall,
    buildPromptBlock,
    forget,
    onSessionRetire,
    migrateLegacy,
    verifyLegacy,
    rollbackLegacy,
    tick,
    metricsSummary,
    status,
    listTombstones({ limit = 500 } = {}) {
      const s = store();
      if (!s) return [];
      return safe(() => s.listTombstones({ personaId, limit }), [], '墓碑读取');
    },
    close,
    store,
    // 测试/CLI 需要：拿到内部 store 做断言，或注入固定时间。
    _internal: { state, metrics, cache }
  };
}
