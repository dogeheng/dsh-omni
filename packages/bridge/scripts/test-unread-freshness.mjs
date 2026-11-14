#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pruneStaleUnread } from '../src/unread-freshness.js';

const now = 1_000_000_000_000;
const old = { seq: 10, time: now - 3 * 60 * 60 * 1000, text: '三小时前' };
const fresh = { seq: 11, time: now - 5 * 60 * 1000, text: '刚刚' };
const noTime = { seq: 12, text: '无时间' };
const r = pruneStaleUnread({ unread: [old, fresh, noTime], now, staleMs: 2 * 60 * 60 * 1000, lastUnreadSeq: 12 });
assert.deepEqual(r.unread.map((m) => m.seq), [11, 12], '只保留新鲜/无时间消息');
assert.deepEqual(r.removed.map((m) => m.seq), [10]);
assert.equal(r.through, 10, '水位只前移到被删消息的最大 seq');
const allOld = pruneStaleUnread({ unread: [old], now, staleMs: 1000, lastUnreadSeq: 10 });
assert.equal(allOld.unread.length, 0);
console.log('  ✅ 未读时效裁剪：旧消息移除 / 新鲜保留 / 水位安全');
console.log('\nPASS');
