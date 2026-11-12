#!/usr/bin/env node
// 通话记忆规则测试：临时 SQLite，不碰真实记忆库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryManager } from '../src/memory/index.js';
import { recordCallTurn } from '../src/call-memory.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-call-memory-'));
const memory = createMemoryManager({
  root,
  config: {
    enabled: true,
    dbPath: 'memory.sqlite',
    capture: {
      explicitMemoryEnabled: true,
      candidateBufferEnabled: true,
      autoExtractionEnabled: false,
      extractionConversations: ['private:952866364']
    }
  },
  logger: () => {}
});

try {
  const explicit = recordCallTurn({
    memory,
    key: 'private:952866364',
    text: '记住我下周三去上海',
    userId: '952866364',
    sender: 'doge.恆'
  });
  assert.equal(explicit.ok, true, '显式记忆应成功');
  assert.equal(explicit.mode, 'explicit');
  assert.equal(explicit.text, '我下周三去上海');
  const rows = memory.listMemories({ query: '上海', limit: 10 }).memories ?? [];
  assert.equal(rows.length, 1, '应写入一条显式记忆');
  assert.match(rows[0].content, /下周三.*上海/);
  assert.equal(rows[0].scope, 'owner_private', '私聊通话应写 owner_private scope');
  console.log('  ✅ 显式“记住…” → 长期记忆（owner_private）');

  const candidate = recordCallTurn({
    memory,
    key: 'private:952866364',
    text: '我明天要去面试',
    userId: '952866364',
    sender: 'doge.恆'
  });
  assert.equal(candidate.ok, true);
  assert.equal(candidate.mode, 'candidate');
  assert.equal(candidate.captured, true, '规则命中的句子应进候选');
  const notYet = memory.listMemories({ query: '面试', limit: 10 }).memories ?? [];
  assert.equal(notYet.length, 0, '候选不应直接进长期记忆');
  console.log('  ✅ 普通计划句 → 候选缓冲，不直接写长期记忆');

  const noise = recordCallTurn({
    memory,
    key: 'private:952866364',
    text: '今天天气不错',
    userId: '952866364',
    sender: 'doge.恆'
  });
  assert.equal(noise.captured, false, '无规则命中的句子不应写任何东西');
  console.log('  ✅ 无规则句子 → 不写');

  const group = recordCallTurn({
    memory,
    key: 'group:973614217',
    text: '记住这个群下周三有活动',
    userId: '952866364',
    sender: 'doge.恆'
  });
  assert.equal(group.ok, true);
  const groupRows = memory.listMemories({ query: '活动', limit: 10 }).memories ?? [];
  assert.equal(groupRows.length, 1, '群通话显式记忆应写入');
  assert.equal(groupRows[0].scope, 'group', '群 scope 不应写成私聊');
  console.log('  ✅ 群 scope 保留（不污染私聊）');

  const groupAnonymous = recordCallTurn({
    memory,
    key: 'group:973614217',
    text: '记住这个群下周三有匿名测试活动',
    userId: '',
    sender: '群语音'
  });
  assert.equal(groupAnonymous.ok, true);
  assert.equal(groupAnonymous.mode, 'explicit');
  assert.equal(groupAnonymous.scope, 'group');
  const anonRows = memory.listMemories({ query: '匿名测试', limit: 10 }).memories ?? [];
  assert.equal(anonRows.length, 1, '群语音显式记忆应写入 group scope');
  console.log('  ✅ 群语音匿名显式记忆 → group scope');

  const groupCandidate = recordCallTurn({
    memory,
    key: 'group:973614217',
    text: '我明天要去面试',
    userId: '',
    sender: '群语音',
    explicitOnly: true
  });
  assert.equal(groupCandidate.ok, true);
  assert.equal(groupCandidate.captured, false);
  assert.equal(groupCandidate.skipped, 'explicit_only');
  console.log('  ✅ 群语音匿名候选 → 跳过（不误归因）');

  console.log('\nPASS');
} finally {
  memory.close();
  fs.rmSync(root, { recursive: true, force: true });
}
