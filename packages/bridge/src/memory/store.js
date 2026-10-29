// SQLite 记忆存储（node:sqlite / DatabaseSync）。
//
// 为什么是 node:sqlite：
//   - Node >= 22.13 自带（本机实测 v24.16.0，SQLite 3.53.0，FTS5 + trigram 可用），
//     不新增依赖、不常驻服务、不装数据库服务器；
//   - 同步 API 对「一次检索几条」这种微秒~毫秒级查询足够，且没有连接池与事件循环开销；
//   - 单文件 + WAL：备份就是拷一个文件，回滚就是把文件换回去。
//
// 硬性做法（对应任务书第十节的低资源要求）：
//   1. 只开一个连接，prepared statement 缓存（有上限），**从不把整库读进 JS 内存**；
//   2. 每次读写都是短事务（BEGIN IMMEDIATE ... COMMIT），批量任务分片而不是一个大事务；
//   3. 所有检索都带 LIMIT 与索引条件；
//   4. 删除是**真删**（连同 FTS 行），不是打标记；
//   5. 事务内失败一律 rollback，并把错误交给上层降级（绝不 throw 到消息处理主链路）。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildGramsText, normalizeForDedupe } from './text.js';
import {
  DEFAULT_CONFIDENCE,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  SUPERSEDING_KINDS,
  visibleScopeClause
} from './scopes.js';

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id            INTEGER PRIMARY KEY,
  persona_id    TEXT NOT NULL,
  qq_id         TEXT NOT NULL,
  display_name  TEXT,
  aliases       TEXT NOT NULL DEFAULT '[]',
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE(persona_id, qq_id)
);
CREATE INDEX IF NOT EXISTS people_name_idx ON people(persona_id, display_name);

CREATE TABLE IF NOT EXISTS memories (
  id                  INTEGER PRIMARY KEY,
  persona_id          TEXT NOT NULL,
  scope               TEXT NOT NULL,
  scope_key           TEXT NOT NULL DEFAULT '',
  kind                TEXT NOT NULL,
  subject_id          TEXT,
  subject_label       TEXT,
  content             TEXT NOT NULL,
  grams               TEXT NOT NULL,
  source_message_id   TEXT,
  source_conversation TEXT,
  origin              TEXT NOT NULL DEFAULT 'explicit',
  confidence          REAL NOT NULL DEFAULT 0.8,
  status              TEXT NOT NULL DEFAULT 'active',
  dedupe_key          TEXT NOT NULL,
  subject_key         TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  valid_from          INTEGER,
  valid_until         INTEGER,
  expires_at          INTEGER,
  superseded_by       INTEGER,
  raw_json            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_dedupe_active
  ON memories(dedupe_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS memories_scope_idx
  ON memories(persona_id, scope, scope_key, status);
CREATE INDEX IF NOT EXISTS memories_subject_idx
  ON memories(persona_id, subject_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_subject_key_idx
  ON memories(persona_id, scope, scope_key, subject_key) WHERE subject_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_expiry_idx ON memories(status, expires_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(grams, tokenize = 'unicode61');

CREATE TABLE IF NOT EXISTS candidates (
  id                  INTEGER PRIMARY KEY,
  persona_id          TEXT NOT NULL,
  conversation_key    TEXT NOT NULL,
  scope               TEXT NOT NULL,
  scope_key           TEXT NOT NULL,
  kind_hint           TEXT,
  subject_id          TEXT,
  subject_label       TEXT,
  content             TEXT NOT NULL,
  dedupe_key          TEXT NOT NULL,
  source_message_id   TEXT,
  source_seq          INTEGER,
  rule                TEXT,
  confidence          REAL NOT NULL DEFAULT 0.6,
  status              TEXT NOT NULL DEFAULT 'pending',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  consumed_at         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_pending_dedupe
  ON candidates(dedupe_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS candidates_pending_idx
  ON candidates(persona_id, status, created_at);

CREATE TABLE IF NOT EXISTS llm_budget (
  persona_id   TEXT NOT NULL,
  day          TEXT NOT NULL,
  calls        INTEGER NOT NULL DEFAULT 0,
  last_call_at INTEGER,
  PRIMARY KEY (persona_id, day)
);

CREATE TABLE IF NOT EXISTS migration_log (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  backup_path TEXT,
  imported    INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  report_json TEXT
);

CREATE TABLE IF NOT EXISTS tombstones (
  persona_id         TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  scope             TEXT NOT NULL,
  scope_key         TEXT NOT NULL DEFAULT '',
  subject_id        TEXT,
  subject_label     TEXT,
  kind              TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (persona_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS tombstones_scope_idx ON tombstones(persona_id, scope, scope_key);

CREATE TABLE IF NOT EXISTS self_state (
  persona_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (persona_id, key)
);
`;

function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    personaId: row.persona_id,
    scope: row.scope,
    scopeKey: row.scope_key,
    kind: row.kind,
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    content: row.content,
    // 检索内部用（双字 token 集合）；对外 API 会再挑字段，不会把 grams 吐给模型。
    grams: row.grams,
    sourceMessageId: row.source_message_id,
    sourceConversation: row.source_conversation,
    origin: row.origin,
    confidence: row.confidence,
    status: row.status,
    subjectKey: row.subject_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    expiresAt: row.expires_at,
    supersededBy: row.superseded_by,
    score: typeof row.score === 'number' ? row.score : undefined,
    bm25: typeof row.bm25 === 'number' ? row.bm25 : undefined
  };
}

function rowToCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    personaId: row.persona_id,
    conversationKey: row.conversation_key,
    scope: row.scope,
    scopeKey: row.scope_key,
    kindHint: row.kind_hint,
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    content: row.content,
    sourceMessageId: row.source_message_id,
    sourceSeq: row.source_seq,
    rule: row.rule,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at
  };
}

export class MemoryStore {
  /**
   * @param {object} p
   * @param {string} p.file                     sqlite 文件路径（':memory:' 允许，测试用）
   * @param {(msg:string, err?:unknown)=>void} [p.logger]
   * @param {() => number} [p.now]
   */
  constructor({ file, logger = () => {}, now = Date.now } = {}) {
    this.file = String(file || ':memory:');
    this.logger = logger;
    this.now = now;
    this.db = null;
    this.stmtCache = new Map();
    this.stmtLimit = 128;
    this.ready = false;
    this.walEnabled = false;
  }

  open() {
    if (this.ready) return this;
    if (this.file !== ':memory:') {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      // 与 data/ 下其它状态文件一致：目录 700、库文件 600（记忆里有群友隐私）。
      try { fs.chmodSync(dir, 0o700); } catch { /* Windows / 无权限时忽略 */ }
    }
    const db = new DatabaseSync(this.file);
    this.db = db;
    try {
      // busy_timeout 必须最先设：多进程（CLI 迁移/备份）同时打开时不能直接 SQLITE_BUSY 抛错。
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec('PRAGMA foreign_keys = ON');
      if (this.file !== ':memory:') {
        try {
          db.exec('PRAGMA journal_mode = WAL');
          db.exec('PRAGMA synchronous = NORMAL');
          const mode = db.prepare('PRAGMA journal_mode').get();
          this.walEnabled = String(mode?.journal_mode ?? '').toLowerCase() === 'wal';
        } catch (error) {
          this.logger('memory: 无法启用 WAL，继续用默认日志模式', error?.message ?? error);
        }
      }
      db.exec(SCHEMA_SQL);
      const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
      if (!current) {
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(SCHEMA_VERSION));
      } else if (Number(current.value) > SCHEMA_VERSION) {
        throw new Error(`记忆库 schema 版本 ${current.value} 高于本程序支持的 ${SCHEMA_VERSION}，拒绝写入`);
      }
      if (this.file !== ':memory:') {
        try { fs.chmodSync(this.file, 0o600); } catch { /* 忽略 */ }
      }
      this.ready = true;
    } catch (error) {
      try { db.close(); } catch { /* ignore */ }
      this.db = null;
      throw error;
    }
    return this;
  }

  close() {
    this.stmtCache.clear();
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
    }
    this.db = null;
    this.ready = false;
  }

  _stmt(sql) {
    const cached = this.stmtCache.get(sql);
    if (cached) return cached;
    const stmt = this.db.prepare(sql);
    if (this.stmtCache.size >= this.stmtLimit) {
      // 简单 FIFO 淘汰：语句集合是有限的，正常不会触顶；触顶说明有动态 SQL，需要检查。
      const first = this.stmtCache.keys().next().value;
      this.stmtCache.delete(first);
    }
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 事务可能已被 SQLite 自动回滚 */ }
      throw error;
    }
  }

  _activeFilter(alias = '') {
    const p = alias ? `${alias}.` : '';
    return `${p}status = 'active' AND (${p}expires_at IS NULL OR ${p}expires_at > ?)`;
  }

  // ── 人物（稳定身份 = QQ 号；昵称/群名片只是别名） ─────────────────────────
  /**
   * 建立/更新人物档案。昵称变化不改变身份：qq_id 是唯一键，旧昵称进 aliases。
   */
  upsertPerson({ personaId = 'default', qqId, name = '', seenIn = '', at = this.now() } = {}) {
    const qq = String(qqId ?? '').trim();
    if (!/^\d+$/.test(qq)) throw new Error('人物身份必须是数字 QQ 号');
    const display = String(name ?? '').trim().slice(0, 64) || null;
    const existing = this._stmt('SELECT * FROM people WHERE persona_id = ? AND qq_id = ?').get(personaId, qq);
    if (!existing) {
      const aliases = display ? JSON.stringify([{ name: display, at, seenIn: String(seenIn || '') }]) : '[]';
      this._stmt(`INSERT INTO people(persona_id, qq_id, display_name, aliases, first_seen_at, last_seen_at)
                  VALUES(?,?,?,?,?,?)`).run(personaId, qq, display, aliases, at, at);
      const person = this.getPerson(personaId, qq);
      return { person, created: true, renamedFrom: null };
    }
    let renamedFrom = null;
    let aliases = [];
    try { aliases = JSON.parse(existing.aliases || '[]'); } catch { aliases = []; }
    if (display && existing.display_name && display !== existing.display_name) {
      renamedFrom = existing.display_name;
      if (!aliases.some((a) => a && a.name === existing.display_name)) {
        aliases.push({ name: existing.display_name, at, seenIn: String(seenIn || '') });
      }
    }
    if (display && !aliases.some((a) => a && a.name === display)) {
      aliases.push({ name: display, at, seenIn: String(seenIn || '') });
    }
    aliases = aliases.slice(-20);
    this._stmt(`UPDATE people SET display_name = ?, aliases = ?, last_seen_at = ? WHERE persona_id = ? AND qq_id = ?`)
      .run(display ?? existing.display_name, JSON.stringify(aliases), at, personaId, qq);
    return { person: this.getPerson(personaId, qq), created: false, renamedFrom };
  }

  getPerson(personaId, qqId) {
    const row = this._stmt('SELECT * FROM people WHERE persona_id = ? AND qq_id = ?').get(personaId, String(qqId));
    if (!row) return null;
    let aliases = [];
    try { aliases = JSON.parse(row.aliases || '[]'); } catch { aliases = []; }
    return {
      personaId: row.persona_id,
      qqId: row.qq_id,
      displayName: row.display_name,
      aliases,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    };
  }

  listPeople(personaId, { limit = 50 } = {}) {
    return this._stmt('SELECT * FROM people WHERE persona_id = ? ORDER BY last_seen_at DESC LIMIT ?')
      .all(personaId, Math.min(200, Math.max(1, limit)))
      .map((row) => ({
        personaId: row.persona_id,
        qqId: row.qq_id,
        displayName: row.display_name,
        lastSeenAt: row.last_seen_at
      }));
  }

  // ── 记忆 ─────────────────────────────────────────────────────────────────
  buildDedupeKey({ personaId, scope, scopeKey, kind, subjectId, content }) {
    return [personaId, scope, scopeKey || '', kind, subjectId || '', normalizeForDedupe(content)].join('|');
  }

  /**
   * 写入一条记忆。
   * @returns {{id:number|null, created:boolean, duplicate?:boolean, superseded?:number[]}}
   */
  addMemory({
    personaId = 'default',
    scope,
    scopeKey = '',
    kind,
    subjectId = null,
    subjectLabel = null,
    content,
    sourceMessageId = null,
    sourceConversation = null,
    origin = 'explicit',
    confidence = null,
    validFrom = null,
    validUntil = null,
    expiresAt = null,
    subjectKey = null,
    raw = null,
    now = this.now()
  } = {}) {
    if (!MEMORY_SCOPES.includes(scope)) throw new Error(`非法 scope: ${scope}`);
    if (!MEMORY_KINDS.includes(kind)) throw new Error(`非法 kind: ${kind}`);
    const text = String(content ?? '').trim();
    if (!text) throw new Error('记忆内容为空');
    const subject = subjectId ? String(subjectId) : null;
    const dedupeKey = this.buildDedupeKey({ personaId, scope, scopeKey, kind, subjectId: subject, content: text });
    const grams = buildGramsText(`${text} ${subjectLabel ?? ''}`, { maxTokens: 240 });
    const conf = Number.isFinite(confidence) ? confidence : (DEFAULT_CONFIDENCE[kind] ?? 0.7);
    const topicKey = subjectKey ? String(subjectKey).trim().slice(0, 80) : null;

    return this._tx(() => {
      // 删除墓碑：显式删除过的内容不能被迁移/提炼/候选"自动复活"。
      // 只有用户再次明确要求记住（origin='explicit'）才允许覆盖墓碑。
      const tomb = this._stmt('SELECT dedupe_key FROM tombstones WHERE persona_id = ? AND dedupe_key = ?')
        .get(personaId, dedupeKey);
      if (tomb) {
        if (origin !== 'explicit') return { id: null, created: false, blocked: true, superseded: [] };
        this._stmt('DELETE FROM tombstones WHERE persona_id = ? AND dedupe_key = ?').run(personaId, dedupeKey);
      }
      // 完全相同的 active 记忆：直接返回已有行，**不做 supersede**。
      // 否则「同一条内容又写一遍」会先把旧行标成 superseded、再插入新行 ——
      // 检索结果没变，但历史里多出一对"自己取代自己"的噪音。
      const sameActive = this._stmt("SELECT id FROM memories WHERE dedupe_key = ? AND status = 'active'").get(dedupeKey);
      if (sameActive) return { id: Number(sameActive.id), created: false, duplicate: true, superseded: [] };
      // 人物档案：身份由 QQ 号确定（昵称只是别名）。写入记忆时顺手建档，
      // 这样迁移/提炼/显式写入都不会出现「有 subject_id 但查不到人」的悬挂关联。
      if (subject) {
        this.upsertPerson({
          personaId, qqId: subject, name: subjectLabel || '',
          seenIn: sourceConversation || '', at: now
        });
      }
      let superseded = [];
      if (topicKey && SUPERSEDING_KINDS.includes(kind)) {
        const rows = this._stmt(`SELECT id FROM memories
          WHERE persona_id = ? AND scope = ? AND scope_key = ? AND kind = ? AND subject_key = ? AND status = 'active'`)
          .all(personaId, scope, scopeKey || '', kind, topicKey);
        superseded = rows.map((r) => r.id);
        if (superseded.length) {
          this._stmt(`UPDATE memories SET status = 'superseded', valid_until = ?, updated_at = ?
                       WHERE id IN (${superseded.map(() => '?').join(',')})`)
            .run(now, now, ...superseded);
        }
      }
      try {
        this._stmt(`INSERT INTO memories(
            persona_id, scope, scope_key, kind, subject_id, subject_label, content, grams,
            source_message_id, source_conversation, origin, confidence, status, dedupe_key, subject_key,
            created_at, updated_at, valid_from, valid_until, expires_at, raw_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?,?,?,?,?,?)`)
          .run(personaId, scope, scopeKey || '', kind, subject, subjectLabel || null, text, grams,
            sourceMessageId != null ? String(sourceMessageId) : null, sourceConversation || null, origin,
            Math.min(1, Math.max(0, conf)), dedupeKey, topicKey, now, now,
            validFrom ?? now, validUntil ?? null, expiresAt ?? null, raw ? JSON.stringify(raw) : null);
        const id = Number(this._stmt('SELECT last_insert_rowid() AS id').get().id);
        this._stmt('INSERT INTO memory_fts(rowid, grams) VALUES(?, ?)').run(id, grams);
        if (superseded.length) {
          this._stmt(`UPDATE memories SET superseded_by = ? WHERE id IN (${superseded.map(() => '?').join(',')})`)
            .run(id, ...superseded);
        }
        this._bump('writes');
        return { id, created: true, superseded };
      } catch (error) {
        if (!/UNIQUE constraint failed|constraint failed/i.test(String(error?.message ?? error))) throw error;
        // 去重命中：恢复刚被 supersede 的旧记录（新内容没写进去，旧状态仍应有效）。
        for (const id of superseded) {
          this._stmt(`UPDATE memories SET status = 'active', valid_until = NULL, updated_at = ? WHERE id = ? AND status = 'superseded'`)
            .run(now, id);
        }
        const existing = this._stmt('SELECT id FROM memories WHERE dedupe_key = ? AND status = \'active\'').get(dedupeKey);
        return { id: existing ? Number(existing.id) : null, created: false, duplicate: true, superseded: [] };
      }
    });
  }

  getMemory(id) {
    return rowToMemory(this._stmt('SELECT * FROM memories WHERE id = ?').get(Number(id)));
  }

  /** 真删除：同时删 FTS 行。返回是否删到了东西。 */
  deleteMemory(id, { reason = '' } = {}) {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) return false;
    return this._tx(() => {
      const row = this._stmt('SELECT id FROM memories WHERE id = ?').get(numeric);
      if (!row) return false;
      this._stmt('DELETE FROM memory_fts WHERE rowid = ?').run(numeric);
      this._stmt('DELETE FROM memories WHERE id = ?').run(numeric);
      this._bump('deletes');
      if (reason) this.logger(`memory: 已删除记忆 #${numeric}（${reason}）`);
      return true;
    });
  }

  /** 过期清理：把到期的 active 记忆标记为 expired（保留历史，不再检索）。 */
  expireDue(now = this.now()) {
    const info = this._stmt(`UPDATE memories SET status = 'expired', updated_at = ?
                              WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, now);
    return Number(info.changes ?? 0);
  }

  /** 按作用域/人物做结构化检索（FTS 无命中或需要人物相关记忆时用）。 */
  queryStructured({ ctx, kinds = null, subjectIds = null, limit = 10, now = this.now(), includeSession = true } = {}) {
    if (!ctx) return [];
    const vis = visibleScopeClause(ctx);
    const params = [ctx.personaId, now];
    let sql = `SELECT * FROM memories WHERE persona_id = ? AND ${this._activeFilter()} AND ${vis.sql}`;
    if (kinds?.length) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (subjectIds?.length) {
      sql += ` AND subject_id IN (${subjectIds.map(() => '?').join(',')})`;
      params.push(...subjectIds);
    }
    if (!includeSession) sql += ` AND scope <> 'session'`;
    params.push(...vis.params);
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(Math.min(200, Math.max(1, limit)));
    return this._stmt(sql).all(...params).map(rowToMemory);
  }

  /** FTS5 检索（中文双字索引）。bm25 越小越相关（负值），这里统一转成 bm25 原值返回。 */
  queryFts({ ctx, matchExpression, limit = 40, now = this.now(), includeSession = false } = {}) {
    if (!ctx || !matchExpression) return [];
    const vis = visibleScopeClause(ctx);
    const params = [matchExpression, ctx.personaId, now, ...vis.params];
    let sql = `SELECT m.*, bm25(memory_fts) AS bm25
               FROM memory_fts JOIN memories m ON m.id = memory_fts.rowid
               WHERE memory_fts MATCH ? AND m.persona_id = ?
                 AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
                 AND ${vis.sql.replace(/\bscope\b/g, 'm.scope').replace(/\bscope_key\b/g, 'm.scope_key')}`;
    if (!includeSession) sql += ` AND m.scope <> 'session'`;
    sql += ' ORDER BY bm25(memory_fts) ASC LIMIT ?';
    params.push(Math.min(200, Math.max(1, limit)));
    return this._stmt(sql).all(...params).map(rowToMemory);
  }

  /**
   * 按人物取「当前状态类」记忆（impression/promise/state）：用于熟悉成员互动场景。
   * 结构化条件走普通索引，不进 FTS。
   */
  queryAboutPeople({ ctx, subjectIds, kinds = ['impression', 'promise', 'state'], limit = 8, now = this.now() } = {}) {
    if (!ctx || !subjectIds?.length) return [];
    const vis = visibleScopeClause(ctx);
    const sql = `SELECT * FROM memories
                 WHERE persona_id = ? AND ${this._activeFilter()}
                   AND subject_id IN (${subjectIds.map(() => '?').join(',')})
                   AND kind IN (${kinds.map(() => '?').join(',')})
                   AND ${vis.sql}
                 ORDER BY updated_at DESC LIMIT ?`;
    const params = [ctx.personaId, now, ...subjectIds, ...kinds, ...vis.params, Math.min(50, Math.max(1, limit))];
    return this._stmt(sql).all(...params).map(rowToMemory);
  }

  listMemories({ personaId = 'default', ctx = null, kind = null, subjectId = null, status = null, limit = 50, offset = 0 } = {}) {
    const params = [personaId];
    let sql = 'SELECT * FROM memories WHERE persona_id = ?';
    if (ctx) {
      const vis = visibleScopeClause(ctx);
      sql += ` AND ${vis.sql}`;
      params.push(...vis.params);
    }
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    if (subjectId) { sql += ' AND subject_id = ?'; params.push(String(subjectId)); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(Math.min(500, Math.max(1, limit)), Math.max(0, offset));
    return this._stmt(sql).all(...params).map(rowToMemory);
  }

  countMemories({ personaId = 'default', status = 'active' } = {}) {
    const row = this._stmt('SELECT COUNT(*) AS n FROM memories WHERE persona_id = ? AND status = ?')
      .get(personaId, status);
    return Number(row?.n ?? 0);
  }

  countByKind({ personaId = 'default', status = 'active' } = {}) {
    const rows = this._stmt('SELECT kind, COUNT(*) AS n FROM memories WHERE persona_id = ? AND status = ? GROUP BY kind')
      .all(personaId, status);
    const out = {};
    for (const r of rows) out[r.kind] = Number(r.n);
    return out;
  }

  countByScope({ personaId = 'default', status = 'active' } = {}) {
    const rows = this._stmt('SELECT scope, COUNT(*) AS n FROM memories WHERE persona_id = ? AND status = ? GROUP BY scope')
      .all(personaId, status);
    const out = {};
    for (const r of rows) out[r.scope] = Number(r.n);
    return out;
  }

  // ── 候选缓冲（Level 2） ───────────────────────────────────────────────────
  addCandidate({
    personaId = 'default',
    conversationKey,
    scope,
    scopeKey = '',
    kindHint = null,
    subjectId = null,
    subjectLabel = null,
    content,
    sourceMessageId = null,
    sourceSeq = null,
    rule = '',
    confidence = 0.6,
    now = this.now()
  } = {}) {
    const text = String(content ?? '').trim();
    if (!text) return { id: null, created: false };
    const dedupeKey = this.buildDedupeKey({
      personaId, scope, scopeKey, kind: kindHint || 'candidate', subjectId, content: text
    });
    try {
      this._stmt(`INSERT INTO candidates(
          persona_id, conversation_key, scope, scope_key, kind_hint, subject_id, subject_label,
          content, dedupe_key, source_message_id, source_seq, rule, confidence, status, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`)
        .run(personaId, conversationKey, scope, scopeKey || '', kindHint || null, subjectId ? String(subjectId) : null,
          subjectLabel || null, text, dedupeKey, sourceMessageId != null ? String(sourceMessageId) : null,
          Number.isFinite(sourceSeq) ? Number(sourceSeq) : null, String(rule || '').slice(0, 40),
          Math.min(1, Math.max(0, Number(confidence) || 0.6)), now, now);
      const id = Number(this._stmt('SELECT last_insert_rowid() AS id').get().id);
      return { id, created: true };
    } catch (error) {
      if (!/UNIQUE constraint failed|constraint failed/i.test(String(error?.message ?? error))) throw error;
      return { id: null, created: false, duplicate: true };
    }
  }

  listCandidates({ personaId = 'default', status = 'pending', limit = 50, conversationKey = null } = {}) {
    const params = [personaId, status];
    let sql = 'SELECT * FROM candidates WHERE persona_id = ? AND status = ?';
    if (conversationKey) { sql += ' AND conversation_key = ?'; params.push(conversationKey); }
    sql += ' ORDER BY created_at ASC LIMIT ?';
    params.push(Math.min(500, Math.max(1, limit)));
    return this._stmt(sql).all(...params).map(rowToCandidate);
  }

  countPendingCandidates({ personaId = 'default' } = {}) {
    const row = this._stmt('SELECT COUNT(*) AS n FROM candidates WHERE persona_id = ? AND status = \'pending\'')
      .get(personaId);
    return Number(row?.n ?? 0);
  }

  markCandidates(ids, status, now = this.now()) {
    const list = (ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!list.length) return 0;
    const info = this._stmt(`UPDATE candidates SET status = ?, updated_at = ?, consumed_at = ?
                              WHERE id IN (${list.map(() => '?').join(',')}) AND status = 'pending'`)
      .run(status, now, now, ...list);
    return Number(info.changes ?? 0);
  }

  /** 清理过期候选 + 把 pending 数量压回上限（最旧的先丢）。 */
  pruneCandidates({ personaId = 'default', ttlMs = 7 * 24 * 60 * 60 * 1000, maxCandidates = 500, now = this.now() } = {}) {
    const expired = this._stmt(`UPDATE candidates SET status = 'expired', updated_at = ?
                                WHERE persona_id = ? AND status = 'pending' AND created_at < ?`)
      .run(now, personaId, now - ttlMs);
    let dropped = 0;
    const pending = this.countPendingCandidates({ personaId });
    if (pending > maxCandidates) {
      const victims = this._stmt(`SELECT id FROM candidates WHERE persona_id = ? AND status = 'pending'
                                  ORDER BY created_at ASC LIMIT ?`).all(personaId, pending - maxCandidates);
      dropped = this.markCandidates(victims.map((v) => v.id), 'expired', now);
    }
    return { expired: Number(expired.changes ?? 0), dropped };
  }

  // ── 每日 LLM 预算（提炼 + 巩固共用） ───────────────────────────────────────
  /**
   * 原子占用一次额度。返回 false = 今天已经用完。
   * 用单条 UPSERT 而不是「先查再写」，避免并发调度下超发。
   */
  reserveLlmCall({ personaId = 'default', day, max, now = this.now() } = {}) {
    const limit = Math.max(0, Number(max) || 0);
    if (limit <= 0) return false;
    const info = this._stmt(`INSERT INTO llm_budget(persona_id, day, calls, last_call_at)
        VALUES(?, ?, 1, ?)
        ON CONFLICT(persona_id, day) DO UPDATE SET calls = calls + 1, last_call_at = excluded.last_call_at
        WHERE calls < ?`).run(personaId, String(day), now, limit);
    return Number(info.changes ?? 0) > 0;
  }

  llmCallsToday({ personaId = 'default', day } = {}) {
    const row = this._stmt('SELECT calls FROM llm_budget WHERE persona_id = ? AND day = ?').get(personaId, String(day));
    return Number(row?.calls ?? 0);
  }

  // ── 迁移记录 ─────────────────────────────────────────────────────────────
  recordMigration({
    source, sourceHash, startedAt, finishedAt = this.now(), backupPath = null, imported = 0, duplicates = 0, report = null
  } = {}) {
    this._stmt(`INSERT INTO migration_log(source, source_hash, started_at, finished_at, backup_path, imported, duplicates, report_json)
                VALUES(?,?,?,?,?,?,?,?)`)
      .run(String(source), String(sourceHash), startedAt, finishedAt, backupPath,
        Number(imported) || 0, Number(duplicates) || 0, report ? JSON.stringify(report) : null);
    return Number(this._stmt('SELECT last_insert_rowid() AS id').get().id);
  }

  lastMigration({ source } = {}) {
    const row = this._stmt('SELECT * FROM migration_log WHERE source = ? ORDER BY id DESC LIMIT 1').get(String(source));
    if (!row) return null;
    let report = null;
    try { report = row.report_json ? JSON.parse(row.report_json) : null; } catch { report = null; }
    return {
      id: row.id,
      source: row.source,
      sourceHash: row.source_hash,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      backupPath: row.backup_path,
      imported: row.imported,
      duplicates: row.duplicates,
      report
    };
  }

  countByOrigin(origin, { personaId = 'default' } = {}) {
    return Number(this._stmt('SELECT COUNT(*) AS n FROM memories WHERE persona_id = ? AND origin = ?')
      .get(personaId, String(origin))?.n ?? 0);
  }

  /** 删除某次迁移导入的全部记忆（回滚入口）。返回删除条数。 */
  deleteByOrigin(origin, { personaId = 'default' } = {}) {
    return this._tx(() => {
      const rows = this._stmt('SELECT id FROM memories WHERE persona_id = ? AND origin = ?').all(personaId, String(origin));
      for (const row of rows) {
        this._stmt('DELETE FROM memory_fts WHERE rowid = ?').run(row.id);
      }
      this._stmt('DELETE FROM memories WHERE persona_id = ? AND origin = ?').run(personaId, String(origin));
      return rows.length;
    });
  }

  // ── 删除墓碑（防止旧数据/自动路径把删掉的内容复活） ─────────────────────
  /**
   * 记录一条"已删除"。dedupe_key 与 memories 同一套算法，所以重复写会幂等。
   * normalized_content / subject_label 留给旧 social-v2 的物理清理用。
   */
  addTombstone({ personaId = 'default', row, now = this.now() } = {}) {
    if (!row) return false;
    const content = String(row.content ?? '');
    const dedupeKey = row.dedupeKey || this.buildDedupeKey({
      personaId, scope: row.scope, scopeKey: row.scopeKey || '', kind: row.kind,
      subjectId: row.subjectId ?? null, content
    });
    this._stmt(`INSERT INTO tombstones(
        persona_id, dedupe_key, normalized_content, scope, scope_key, subject_id, subject_label, kind, created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(persona_id, dedupe_key) DO UPDATE SET created_at = excluded.created_at`)
      .run(personaId, dedupeKey, normalizeForDedupe(content), String(row.scope ?? ''),
        String(row.scopeKey ?? ''), row.subjectId ? String(row.subjectId) : null,
        row.subjectLabel ? String(row.subjectLabel) : null, String(row.kind ?? ''), now);
    return true;
  }

  listTombstones({ personaId = 'default', limit = 500 } = {}) {
    return this._stmt('SELECT * FROM tombstones WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(personaId, Math.min(2000, Math.max(1, limit)))
      .map((row) => ({
        dedupeKey: row.dedupe_key,
        normalizedContent: row.normalized_content,
        scope: row.scope,
        scopeKey: row.scope_key,
        subjectId: row.subject_id,
        subjectLabel: row.subject_label,
        kind: row.kind,
        createdAt: row.created_at
      }));
  }

  countTombstones({ personaId = 'default' } = {}) {
    return Number(this._stmt('SELECT COUNT(*) AS n FROM tombstones WHERE persona_id = ?').get(personaId)?.n ?? 0);
  }

  // ── 自我状态（允许变化的自我认知，只有主人能写） ──────────────────────────
  getSelfState(personaId, key) {
    const row = this._stmt('SELECT value, updated_at FROM self_state WHERE persona_id = ? AND key = ?').get(personaId, key);
    if (!row) return null;
    try { return { value: JSON.parse(row.value), updatedAt: row.updated_at }; } catch { return { value: row.value, updatedAt: row.updated_at }; }
  }

  setSelfState(personaId, key, value, now = this.now()) {
    this._stmt(`INSERT INTO self_state(persona_id, key, value, updated_at) VALUES(?,?,?,?)
                ON CONFLICT(persona_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(personaId, String(key), JSON.stringify(value ?? null), now);
    return true;
  }

  // ── 统计与运维 ───────────────────────────────────────────────────────────
  _bump(counter) {
    this._counters = this._counters || { writes: 0, deletes: 0 };
    this._counters[counter] = (this._counters[counter] || 0) + 1;
  }

  counters() {
    return { ...(this._counters || { writes: 0, deletes: 0 }) };
  }

  stats({ personaId = 'default' } = {}) {
    let dbBytes = 0;
    try {
      if (this.file !== ':memory:') dbBytes = fs.statSync(this.file).size;
    } catch { dbBytes = 0; }
    return {
      file: this.file,
      wal: this.walEnabled,
      dbBytes,
      people: Number(this._stmt('SELECT COUNT(*) AS n FROM people WHERE persona_id = ?').get(personaId)?.n ?? 0),
      memories: this.countMemories({ personaId, status: 'active' }),
      superseded: this.countMemories({ personaId, status: 'superseded' }),
      expired: this.countMemories({ personaId, status: 'expired' }),
      byKind: this.countByKind({ personaId }),
      byScope: this.countByScope({ personaId }),
      candidates: this.countPendingCandidates({ personaId }),
      tombstones: this.countTombstones({ personaId }),
      counters: this.counters()
    };
  }

  /**
   * 在线备份（SQLite 官方推荐的 VACUUM INTO）：不需要停写，产物是单个一致的文件。
   * 返回备份路径。目标已存在时抛错（调用方用时间戳命名）。
   */
  backupTo(file) {
    if (this.file === ':memory:') throw new Error('内存库不支持备份');
    const target = path.resolve(String(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) throw new Error(`备份目标已存在：${target}`);
    const escaped = target.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    return target;
  }
}
