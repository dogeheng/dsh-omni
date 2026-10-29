#!/usr/bin/env node
// 新旧记忆对照（shadow 上线检查用，只读）。
//
// 对每个会话打印：
//   · 旧 social-v2.json 里的轻量记忆条数（话题/想说未说/印象）；
//   · 新 SQLite 里该会话**按权限可见**的长期记忆（按 kind/scope 统计 + 最近几条）；
//   · 用一句样例查询跑真实检索链路，给出会注入的 Token 数与预览。
//
// 用法：node scripts/memory-compare.mjs [--query "你还记得上次面试吗"] [--key group:123]
// 说明：不会写 metrics.jsonl（直接调用 store + retrieve，不经过 manager 的记账路径）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemoryStore,
  buildFtsMatchQuery,
  buildReadContext,
  defaultMemoryConfig,
  estimateTokens,
  normalizeMemoryConfig,
  rankMemoryRows,
  renderMemoryBlock,
  resolveMemoryDbPath,
  tokenizeMemoryText,
  visibleScopeClause
} from '../src/memory/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const sampleQuery = flag('query', '你还记得上次说的事吗');
const onlyKey = flag('key');

const rawConfig = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; }
})();
const cfg = normalizeMemoryConfig(rawConfig.memory, { root: ROOT });
const ownerQQ = String(rawConfig.ownerQQ ?? '');
const dbFile = resolveMemoryDbPath({ ...cfg, dbPath: cfg.dbPath });
if (!fs.existsSync(dbFile)) {
  console.error(`记忆库不存在：${dbFile}（先跑 node scripts/memory-admin.mjs migrate）`);
  process.exit(1);
}
const legacyFile = path.join(ROOT, 'data', cfg.migrate.legacySource);
let legacy = { conversations: {} };
try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { /* 没有旧文件就只看新库 */ }

const store = new MemoryStore({ file: dbFile }).open();
const rows = [];
for (const [key, old] of Object.entries(legacy.conversations ?? {})) {
  if (onlyKey && key !== onlyKey) continue;
  const parsed = /^(group|private):(\d+)$/.exec(key);
  if (!parsed) continue;
  const senders = [];
  for (const msg of Array.isArray(old.recentMessages) ? old.recentMessages : []) {
    if (!msg || msg.isSelf) continue;
    const uid = String(msg.userId ?? '');
    if (!/^\d+$/.test(uid)) continue;
    if (!senders.some((s) => s.userId === uid)) senders.push({ userId: uid, name: String(msg.sender ?? '') });
  }
  const ctx = buildReadContext({ conversationKey: key, personaId: cfg.personaId, ownerQQ, senders });
  if (!ctx) continue;

  // 复用 ACL 的单一实现，不在对照脚本里再抄一份可见性规则。
  const vis = visibleScopeClause(ctx);
  const visRow = store.db.prepare(`SELECT COUNT(*) AS n FROM memories
      WHERE persona_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) AND ${vis.sql}`)
    .get(cfg.personaId, Date.now(), ...vis.params);
  const byKind = store.db.prepare(`SELECT kind, COUNT(*) AS n FROM memories
      WHERE persona_id = ? AND status = 'active' GROUP BY kind`).all(cfg.personaId);

  const q = buildFtsMatchQuery(sampleQuery);
  const ftsRows = q ? store.queryFts({ ctx, matchExpression: q.expression, limit: cfg.retrieval.candidateLimit }) : [];
  const structured = store.queryAboutPeople({ ctx, subjectIds: ctx.senderIds, limit: 8 });
  const ranked = rankMemoryRows({
    ftsRows, structuredRows: structured, queryTokens: q?.tokens ?? tokenizeMemoryText(sampleQuery),
    ctx, minScore: cfg.retrieval.minScore, limit: cfg.retrieval.maxResults, halfLifeDays: cfg.retrieval.halfLifeDays
  });
  const rendered = renderMemoryBlock({ rows: ranked, ctx, maxTokens: cfg.prompt.maxTokens });
  rows.push({
    key,
    legacyCounts: {
      activeTopics: Array.isArray(old.activeTopics) ? old.activeTopics.length : 0,
      pendingThoughts: Array.isArray(old.pendingThoughts) ? old.pendingThoughts.length : 0,
      memberImpressions: old.memberImpressions ? Object.keys(old.memberImpressions).length : 0
    },
    newVisibleActive: Number(visRow.n),
    newByKind: Object.fromEntries(byKind.map((r) => [r.kind, Number(r.n)])),
    sample: {
      hits: ranked.length,
      tokens: rendered.tokens,
      block: rendered.text || '(本轮不会注入记忆块)'
    }
  });
}
console.log(JSON.stringify({ dbFile, legacyFile, sampleQuery, conversations: rows, estimateTokensCheck: estimateTokens(sampleQuery) }, null, 2));
store.close();
