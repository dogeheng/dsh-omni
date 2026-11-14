#!/usr/bin/env node
// 通话记忆读取测试：临时 SQLite，不碰真实记忆库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryManager } from '../src/memory/index.js';
import { buildCallMemoryContext } from '../src/call-memory-context.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-call-memctx-'));
const memory = createMemoryManager({
  root,
  config: { enabled: true, dbPath: 'memory.sqlite', retrieval: { mode: 'live' } },
  logger: () => {}
});
try {
  const ctx = memory.buildContext({ conversationKey: 'private:952866364', ownerQQ: '952866364', senders: [{ userId: '952866364', name: '主人' }] });
  const saved = memory.remember({
    ctx, kind: 'fact', content: '主人喜欢喝手冲咖啡，不喜欢速溶',
    subjectId: '952866364', subjectLabel: '主人'
  });
  assert.equal(saved.ok, true);

  const hit = buildCallMemoryContext({
    memory, key: 'private:952866364', ownerQQ: '952866364',
    userId: '952866364', speaker: '主人',
    text: '我想喝点咖啡，你记得我喜欢什么吗？'
  });
  assert.equal(hit.ok, true);
  assert.ok(hit.block.includes('咖啡'), `记忆块应包含咖啡：${hit.block}`);
  assert.ok(hit.tokens <= 350, '记忆块应在预算内');

  const miss = buildCallMemoryContext({
    memory, key: 'group:973614217', ownerQQ: '952866364',
    userId: '952866364', speaker: '主人',
    text: '今天天气不错'
  });
  assert.equal(miss.ok, true);
  assert.equal(miss.block, '', '群 scope 不应读到私聊事实');
  console.log('  ✅ 通话记忆读取：私聊命中 / 群 scope 隔离 / token 预算');
  console.log('\nPASS');
} finally {
  memory.close();
  fs.rmSync(root, { recursive: true, force: true });
}
