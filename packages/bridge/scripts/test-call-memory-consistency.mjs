#!/usr/bin/env node
// 读写一致性：通话里刚写的显式记忆，下一轮读取能查到（临时 SQLite）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryManager } from '../src/memory/index.js';
import { recordCallTurn } from '../src/call-memory.js';
import { buildCallMemoryContext } from '../src/call-memory-context.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-call-consistency-'));
const memory = createMemoryManager({
  root,
  config: { enabled: true, dbPath: 'memory.sqlite', retrieval: { mode: 'live' } },
  logger: () => {}
});
try {
  const written = recordCallTurn({
    memory,
    key: 'private:952866364',
    text: '记住我周末要去咖啡馆',
    userId: '952866364',
    sender: 'doge.恆'
  });
  assert.equal(written.mode, 'explicit');
  assert.equal(written.ok, true);

  const readBack = buildCallMemoryContext({
    memory,
    key: 'private:952866364',
    ownerQQ: '952866364',
    userId: '952866364',
    speaker: 'doge.恆',
    text: '你还记得周末咖啡馆的约定吗'
  });
  assert.equal(readBack.ok, true);
  assert.ok(readBack.block.includes('咖啡馆'), `刚写入的记忆应能读到：${readBack.block}`);
  assert.ok(readBack.tokens > 0 && readBack.tokens <= 350);

  const group = buildCallMemoryContext({
    memory,
    key: 'group:973614217',
    ownerQQ: '952866364',
    userId: '952866364',
    speaker: 'doge.恆',
    text: '你还记得周末咖啡馆的约定吗'
  });
  assert.equal(group.block, '', '私聊事实不应出现在群 scope');
  console.log('  ✅ 写入后立即可读 / 私聊→群 scope 隔离 / token 预算');
  console.log('\nPASS');
} finally {
  memory.close();
  fs.rmSync(root, { recursive: true, force: true });
}
