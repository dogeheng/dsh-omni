// 旧数据迁移：data/social-v2.json → SQLite MemoryStore。
//
// 原则（对应任务书第十一节）：
//   1. **先备份**：迁移前把 social-v2.json 原样复制到 data/memory/backups/，并记下 sha256；
//   2. **可重复执行**：按源文件 hash 判断，同一份文件不会重复导入；内容级去重再兜一层；
//   3. **保守隔离**：旧的人物印象是按"群昵称"索引的，无法可靠对应 QQ 号时
//      subject_id 留空、只保存在**当前会话作用域**里，绝不跨群合并或猜测身份；
//   4. **不删旧数据**：social-v2.json 保持原样，旧读取路径不动；回滚就是删掉本次导入的行；
//   5. **不静默丢弃**：报告里逐类给出 导入/重复/身份未解析 的条数，测试据此对照。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseConversationKey } from './scopes.js';
import { sanitizeMemoryContent } from './text.js';

export const LEGACY_ORIGIN = 'legacy:social-v2';

export function sha256Of(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** 读取旧状态文件；不存在返回 null（迁移在全新安装上是 no-op）。 */
export function readLegacyState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { text: raw, json: JSON.parse(raw), hash: sha256Of(raw) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 从某个会话的 recentMessages 里建立「昵称 → QQ 号」映射。
 * 只有**唯一命中**才算可靠（同名多人 = 身份不明，宁可不解析）。
 */
function memberIndex(messages) {
  const map = new Map();
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || msg.isSelf) continue;
    const name = String(msg.sender ?? '').trim();
    const uid = String(msg.userId ?? '').trim();
    if (!name || !/^\d+$/.test(uid)) continue;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(uid);
  }
  return map;
}

function resolveMember(map, name) {
  const set = map.get(String(name ?? '').trim());
  if (!set || set.size !== 1) return null;
  return [...set][0];
}

/** 旧话题里带"承诺/约定"语义的升级为 promise，其余是 state。 */
function legacyTopicKind(text) {
  return /(答应|说好|约好|约定|记得|帮你|欠你|提醒)/.test(String(text ?? '')) ? 'promise' : 'state';
}

/**
 * 生成迁移计划（纯函数：输入旧 JSON，输出待写入条目）。
 * @returns {{entries:Array, stats:object}}
 */
export function planLegacyImport(socialState, { personaId = 'default', now = Date.now() } = {}) {
  const entries = [];
  const stats = {
    conversations: 0,
    activeTopics: 0,
    pendingThoughts: 0,
    memberImpressions: 0,
    unresolvedIdentity: 0,
    skipped: 0
  };
  const conversations = socialState?.conversations && typeof socialState.conversations === 'object'
    ? socialState.conversations
    : {};
  for (const [key, st] of Object.entries(conversations)) {
    const parsed = parseConversationKey(key);
    if (!parsed || !st || typeof st !== 'object') { stats.skipped += 1; continue; }
    stats.conversations += 1;
    const scope = parsed.kind === 'group' ? 'group' : 'dm';
    const scopeKey = parsed.id;
    const members = memberIndex(st.recentMessages);

    for (const topic of Array.isArray(st.activeTopics) ? st.activeTopics : []) {
      const text = sanitizeMemoryContent(topic?.text ?? '', { maxChars: 240 });
      if (!text) { stats.skipped += 1; continue; }
      stats.activeTopics += 1;
      entries.push({
        scope,
        scopeKey,
        kind: legacyTopicKind(text),
        subjectId: null,
        subjectLabel: null,
        content: text,
        sourceConversation: key,
        confidence: 0.65,
        validFrom: Number(topic?.lastMentionAt) || now,
        expiresAt: null,
        origin: LEGACY_ORIGIN,
        raw: {
          legacy: {
            category: 'activeTopic',
            conversation: key,
            lastMentionAt: Number(topic?.lastMentionAt) || null,
            pendingQuestion: topic?.pendingQuestion ? String(topic.pendingQuestion).slice(0, 200) : null,
            participants: Array.isArray(topic?.participants) ? topic.participants.slice(0, 10).map(String) : []
          }
        }
      });
    }

    for (const thought of Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []) {
      const text = sanitizeMemoryContent(thought?.text ?? '', { maxChars: 240 });
      if (!text) { stats.skipped += 1; continue; }
      stats.pendingThoughts += 1;
      // 「想说但还没说」是**会话内的短期状态**：只放 session 作用域，不跨会话注入。
      entries.push({
        scope: 'session',
        scopeKey: key,
        kind: 'state',
        subjectId: null,
        subjectLabel: null,
        content: text,
        sourceConversation: key,
        confidence: 0.5,
        validFrom: Number(thought?.createdAt) || now,
        expiresAt: Number(thought?.expiresAt) || null,
        origin: LEGACY_ORIGIN,
        raw: { legacy: { category: 'pendingThought', conversation: key, motivation: thought?.motivation ?? null } }
      });
    }

    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    for (const [name, im] of Object.entries(impressions)) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) { stats.skipped += 1; continue; }
      const traits = Array.isArray(im?.traits) ? im.traits.map((t) => sanitizeMemoryContent(t, { maxChars: 60 })).filter(Boolean) : [];
      if (!traits.length) { stats.skipped += 1; continue; }
      stats.memberImpressions += 1;
      const subjectId = resolveMember(members, name);
      if (!subjectId) stats.unresolvedIdentity += 1;
      entries.push({
        scope,
        scopeKey,
        kind: 'impression',
        subjectId,
        subjectLabel: String(name).slice(0, 64),
        content: `${String(name).slice(0, 32)}：${traits.join('、')}`,
        sourceConversation: key,
        confidence: subjectId ? 0.6 : 0.45,
        validFrom: Number(im?.lastSeenAt) || now,
        expiresAt: null,
        origin: LEGACY_ORIGIN,
        raw: {
          legacy: {
            category: 'memberImpression',
            conversation: key,
            unresolvedIdentity: !subjectId,
            interactionCount: Number(im?.interactionCount) || 0,
            lastSeenAt: Number(im?.lastSeenAt) || null
          }
        }
      });
    }
  }
  return { entries, stats };
}

/** 迁移前的原始文件备份（不覆盖同名文件；附带 .sha256 便于事后核对）。 */
export function backupLegacyFile({ file, backupDir, now = Date.now() } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });
  // 备份里是完整的旧记忆（含群友昵称/印象），目录必须与 data/ 一样只允许本人读。
  try { fs.chmodSync(backupDir, 0o700); } catch { /* 忽略无权限平台 */ }
  const text = fs.readFileSync(file, 'utf8');
  const hash = sha256Of(text);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `social-v2.${stamp}.${hash.slice(0, 8)}.json`);
  fs.writeFileSync(target, text, { mode: 0o600 });
  fs.writeFileSync(`${target}.sha256`, `${hash}  ${path.basename(file)}\n`, { mode: 0o600 });
  return { path: target, hash, bytes: Buffer.byteLength(text) };
}

/**
 * 执行迁移（幂等）。
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, backup?:object, imported:number, duplicates:number, stats:object, report:object}}
 */
export function runLegacyMigration(store, {
  legacyFile, backupDir, personaId = 'default', now = Date.now(), logger = () => {}, force = false
} = {}) {
  if (!fs.existsSync(legacyFile)) {
    return { ok: true, skipped: true, reason: '旧状态文件不存在（全新安装）', imported: 0, duplicates: 0, stats: {}, report: {} };
  }
  const loaded = readLegacyState(legacyFile);
  if (!loaded) {
    return { ok: true, skipped: true, reason: '旧状态文件为空', imported: 0, duplicates: 0, stats: {}, report: {} };
  }
  const sourceName = path.basename(legacyFile);
  const last = store.lastMigration({ source: sourceName });
  // 注意：只看 log 会漏掉「迁移后回滚」的情况 —— log 里还是同一个 hash，但库里已经没有
  // 迁移导入的行了。此时必须重新导入，否则回滚一次以后就再也迁不回来。
  const stillImported = store.countByOrigin(LEGACY_ORIGIN, { personaId });
  if (!force && last && last.sourceHash === loaded.hash && stillImported > 0) {
    return { ok: true, skipped: true, reason: '源文件自上次迁移后未变化', imported: 0, duplicates: 0, stats: last.report?.stats ?? {}, report: last.report ?? {} };
  }
  const startedAt = now;
  const backup = backupLegacyFile({ file: legacyFile, backupDir, now });
  const plan = planLegacyImport(loaded.json, { personaId, now });
  let imported = 0;
  let duplicates = 0;
  const failures = [];
  for (const entry of plan.entries) {
    try {
      const result = store.addMemory({ ...entry, personaId, now: entry.validFrom || now, origin: LEGACY_ORIGIN });
      if (result.created) imported += 1; else duplicates += 1;
    } catch (error) {
      failures.push({ content: entry.content.slice(0, 40), error: String(error?.message ?? error) });
    }
  }
  const report = {
    source: sourceName,
    sourceHash: loaded.hash,
    backup: backup.path,
    backupHash: backup.hash,
    stats: plan.stats,
    imported,
    duplicates,
    failures,
    at: new Date(now).toISOString()
  };
  store.recordMigration({
    source: sourceName,
    sourceHash: loaded.hash,
    startedAt,
    finishedAt: Date.now(),
    backupPath: backup.path,
    imported,
    duplicates,
    report
  });
  logger(`memory: 旧数据迁移完成 —— 导入 ${imported} 条，重复跳过 ${duplicates} 条，身份未解析 ${plan.stats.unresolvedIdentity} 条（备份 ${backup.path}）`);
  return { ok: true, skipped: false, backup, imported, duplicates, stats: plan.stats, report };
}

/**
 * 迁移校验：按计划逐条核对「内容 + 作用域 + 人物」是否真的落库。
 * 返回 missing（没写进去的）与 mismatched，用于证明没有静默丢失。
 */
export function verifyLegacyMigration(store, { legacyFile, personaId = 'default' } = {}) {
  const loaded = readLegacyState(legacyFile);
  if (!loaded) return { ok: false, reason: '旧状态文件不存在', total: 0, missing: [], mismatched: [] };
  const plan = planLegacyImport(loaded.json, { personaId });
  const missing = [];
  const mismatched = [];
  for (const entry of plan.entries) {
    const dedupeKey = store.buildDedupeKey({
      personaId, scope: entry.scope, scopeKey: entry.scopeKey, kind: entry.kind,
      subjectId: entry.subjectId, content: entry.content
    });
    const row = store.db.prepare("SELECT * FROM memories WHERE dedupe_key = ? AND status IN ('active','superseded','expired')")
      .get(dedupeKey);
    if (!row) { missing.push(entry); continue; }
    if (String(row.scope_key) !== String(entry.scopeKey) || String(row.kind) !== String(entry.kind)) {
      mismatched.push({ entry, row: { scopeKey: row.scope_key, kind: row.kind } });
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, total: plan.entries.length, missing, mismatched, stats: plan.stats };
}

/**
 * 回滚入口：先把当前库在线备份一份，再删掉「本次迁移导入」的全部行（含 FTS）。
 * social-v2.json 不会被还原/覆盖（它从来没被改过）。
 */
export function rollbackLegacyMigration(store, { backupDir, personaId = 'default', now = Date.now(), logger = () => {} } = {}) {
  let dbBackup = null;
  try {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    dbBackup = store.backupTo(path.join(backupDir, `memory.before-rollback.${stamp}.sqlite`));
  } catch (error) {
    logger(`memory: 回滚前备份失败（继续回滚）：${error?.message ?? error}`);
  }
  const removed = store.deleteByOrigin(LEGACY_ORIGIN, { personaId });
  logger(`memory: 已回滚旧数据迁移，删除 ${removed} 条导入记忆${dbBackup ? `（回滚前备份 ${dbBackup}）` : ''}`);
  return { ok: true, removed, dbBackup };
}
