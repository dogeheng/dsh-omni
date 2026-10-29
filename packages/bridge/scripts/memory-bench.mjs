#!/usr/bin/env node
// 记忆系统的性能/内存测量（真实 SQLite、临时目录、可重复）。
//
// 为什么单独一个脚本：
//   - 任务书要求「实测」而不是「配置里写了就算」：本脚本量的是真实检索链路
//     （SQLite 查询 + 排序 + 渲染 + 指标）的 P50/P95/P99 延迟、DB 体积、进程堆/RSS 增量；
//   - 用临时库，避免污染线上 data/memory；同时跑两种规模（默认 5000 / 20000），
//     方便判断「长期运行一年后」还够不够快。
//
// 用法：node scripts/memory-bench.mjs [--count 5000] [--queries 500] [--scale]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryManager } from '../src/memory/index.js';

const args = process.argv.slice(2);
const num = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

const QUERIES = [
  '你还记得小明面试怎么样了吗',
  '周末去看展那件事',
  '最近老是加班好累',
  '日语学得怎么样',
  '答应带的蝴蝶酥呢',
  '今天好热啊',
  '哈哈哈哈',
  '在吗'
];
const KINDS = ['fact', 'preference', 'impression', 'episode', 'promise', 'state'];
const CONTENTS = ['面试', '养猫', '加班到十点', '周末去看展', '想学日语', '答应带蝴蝶酥', '换了工作', '喜欢喝美式'];

function bench({ count, queries }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bench-'));
  const heap0 = process.memoryUsage();
  const manager = createMemoryManager({
    root,
    config: { enabled: true, retrieval: { mode: 'live' }, cache: { maxEntries: 32, ttlMs: 60000 } }
  });
  const store = manager.store();
  const ctx = manager.buildContext({
    conversationKey: 'group:743778958',
    ownerQQ: '952866364',
    senders: [{ userId: '111111111', name: '小明' }]
  });
  const groups = ['743778958', '1129355519', '745243579'];

  const insertStart = Date.now();
  for (let i = 0; i < count; i += 1) {
    store.addMemory({
      personaId: 'default',
      scope: i % 9 === 0 ? 'dm' : 'group',
      scopeKey: i % 9 === 0 ? '952866364' : groups[i % groups.length],
      kind: KINDS[i % KINDS.length],
      subjectId: i % 4 === 0 ? '111111111' : null,
      subjectLabel: i % 4 === 0 ? '小明' : null,
      content: `样本 ${i}：${CONTENTS[i % CONTENTS.length]}，补充细节 ${'内容'.repeat(i % 5)}`,
      confidence: 0.7,
      now: Date.now() - (i % 300) * 86400000
    });
  }
  const insertMs = Date.now() - insertStart;
  const heapAfterInsert = process.memoryUsage();

  const times = [];
  const tokens = [];
  const start = Date.now();
  for (let i = 0; i < queries; i += 1) {
    const t0 = process.hrtime.bigint();
    const block = manager.buildPromptBlock({ ctx, text: QUERIES[i % QUERIES.length], reason: 'wake', key: 'group:743778958' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (block.tokens) tokens.push(block.tokens);
  }
  const totalMs = Date.now() - start;
  times.sort((a, b) => a - b);
  const pick = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  const heap1 = process.memoryUsage();
  const stats = store.stats({ personaId: 'default' });
  const metrics = manager.metricsSummary();
  const result = {
    memories: count,
    queries,
    insertMs,
    dbBytes: stats.dbBytes,
    dbMB: +(stats.dbBytes / 1048576).toFixed(2),
    totalMs,
    p50Ms: +pick(0.5).toFixed(3),
    p95Ms: +pick(0.95).toFixed(3),
    p99Ms: +pick(0.99).toFixed(3),
    avgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3),
    heapDeltaMB: +((heap1.heapUsed - heap0.heapUsed) / 1048576).toFixed(2),
    rssDeltaMB: +((heap1.rss - heap0.rss) / 1048576).toFixed(2),
    heapAfterInsertMB: +((heapAfterInsert.heapUsed - heap0.heapUsed) / 1048576).toFixed(2),
    injectedTurns: tokens.length,
    tokenAvg: tokens.length ? +(tokens.reduce((a, b) => a + b, 0) / tokens.length).toFixed(1) : 0,
    tokenMax: tokens.length ? Math.max(...tokens) : 0,
    skippedNoNeed: metrics.skipNoNeed,
    cache: metrics.cache
  };
  manager.close();
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

const count = num('count', 5000);
const queries = num('queries', 500);
const runs = args.includes('--scale')
  ? [{ count, queries }, { count: count * 4, queries }]
  : [{ count, queries }];

const out = [];
for (const run of runs) {
  const result = bench(run);
  out.push(result);
  console.log(JSON.stringify(result, null, 2));
}
if (out.length > 1) console.log(JSON.stringify({ summary: out }, null, 2));
