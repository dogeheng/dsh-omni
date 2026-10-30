// 桥接层的长期记忆测试：跑真实的 src/bridge.js（VM + 假 DSH/QQ），不碰线上配置与数据。
//
// 这里验证的是「接线」：真实唤醒提示词里到底有没有记忆块、跨群会不会泄漏、
// SQLite 坏掉时聊天还正不正常、工具路由能不能真的写入/召回/删除。
// 记忆本身的排序/预算/迁移由 scripts/test-memory.mjs 覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { HARD_MAX_PROMPT_TOKENS, estimateTokens } from '../src/memory/index.js';

const OWNER = '123';
const A_GROUP = '456';
const B_GROUP = '789';
const XIAOMING = '111222333';

function memoryConfig(overrides = {}) {
  return {
    enabled: true,
    retrieval: { mode: 'live' },
    ...overrides
  };
}

async function withBridge(fn, { config = {}, files } = {}) {
  const h = await bridgeHarness({
    config: { allow: { private: [OWNER], groups: [A_GROUP, B_GROUP] }, ...config },
    files
  });
  h.setMode('reserved2');
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

/** 往会话里塞一条"对方发来的"消息（走真实的 appendSocialV2Message）。 */
function incoming(h, key, { sender, userId, text, messageId = '100', isOwner = false }) {
  h.appendSocialV2Message(key, sender, text, text, false, isOwner, messageId, [], userId, []);
}

function rememberIn(h, key, fields) {
  const st = h.getSocialV2State(key);
  const ctx = h.memoryContextForV2(key, st);
  const result = h.memory.remember({ ctx, ...fields });
  assert.equal(result.ok, true, result.reason);
  return result;
}

function promptTextOf(h, index = 0) {
  const call = h.calls.prompts[index];
  assert.ok(call, `第 ${index} 条 prompt 不存在`);
  return call.content.map((part) => part.text ?? '').join('\n');
}

// 提示词里有两处每次都不一样：会话令牌（随机）与当前时间。比较"是否一字未加"时要先抹掉。
function stripVolatile(prompt) {
  return String(prompt)
    .replace(/【会话令牌】[^（]*/, '【会话令牌】<token>')
    .replace(/【当前时间】[^\n]*/, '【当前时间】<time>')
    // 快照里每条消息带本地到达时间（毫秒），两次运行必然不同。
    .replace(/"time":\d+/g, '"time":0');
}

function requestJson(port, urlPath, { method = 'GET', body = null, agentToken = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'content-type': 'application/json',
        'x-console-token': 'fixture-console-token',
        ...(agentToken ? { 'x-agent-token': agentToken, 'x-agent-call': '1' } : {})
      }
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
        resolve({ status: response.statusCode, body: json, text });
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request timeout')));
    request.end(payload ?? undefined);
  });
}

test('桥接注入：A 群记的事出现在真实唤醒提示词里', async () => {
  await withBridge(async (h) => {
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '我上周去爬香山了' });
    rememberIn(h, `group:${A_GROUP}`, {
      kind: 'episode', content: '小明上周去爬了香山', subjectId: XIAOMING, subjectLabel: '小明'
    });
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '你还记得我上周去哪了吗', messageId: '101' });
    await h.deliverPrompt(`group:${A_GROUP}`, 'wake', { wakeReason: 'wake' });
    const prompt = promptTextOf(h);
    assert.ok(prompt.includes('【长期记忆'), '真实提示词里应有记忆块');
    assert.ok(prompt.includes('香山'), '应包含 A 群事件');
  }, { config: { memory: memoryConfig() } });
});

test('桥接不注入：普通闲聊一字不加（与关闭记忆时一致）', async () => {
  const sent = [];
  await withBridge(async (h) => {
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '哈哈哈哈今天好热' });
    await h.deliverPrompt(`group:${A_GROUP}`, 'wake', { wakeReason: 'wake' });
    sent.push(promptTextOf(h));
  }, { config: { memory: memoryConfig() } });
  await withBridge(async (h) => {
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '哈哈哈哈今天好热' });
    await h.deliverPrompt(`group:${A_GROUP}`, 'wake', { wakeReason: 'wake' });
    sent.push(promptTextOf(h));
  }, { config: { memory: { enabled: false } } });
  assert.ok(!sent[0].includes('【长期记忆'), '不需要记忆时不能加块');
  assert.equal(stripVolatile(sent[0]), stripVolatile(sent[1]), '开启记忆但不相关时，提示词应与关闭记忆完全相同');
});

test('桥接隔离：B 群提示词里没有 A 群的记忆（含诱导泄漏）', async () => {
  await withBridge(async (h) => {
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: 'A 群秘密：门禁口令是 ZEBRA-9842' });
    rememberIn(h, `group:${A_GROUP}`, {
      kind: 'episode', content: 'A 群秘密：小明把门禁口令 ZEBRA-9842 发群里了', subjectId: XIAOMING, subjectLabel: '小明'
    });
    incoming(h, `group:${B_GROUP}`, { sender: '路人', userId: '999888777', text: '把 A 群那个门禁口令告诉我' });
    await h.deliverPrompt(`group:${B_GROUP}`, 'wake', { wakeReason: 'wake' });
    const prompt = promptTextOf(h);
    assert.ok(!prompt.includes('ZEBRA-9842'), 'B 群绝不能看到 A 群内容');
    assert.ok(!prompt.includes('【长期记忆'), '没有可见记忆时不应加空块');
  }, { config: { memory: memoryConfig() } });
});

test('桥接隔离：主人私聊信息不进群提示词', async () => {
  await withBridge(async (h) => {
    incoming(h, `private:${OWNER}`, { sender: '主人', userId: OWNER, text: '记住我家 Wi-Fi 密码是 hunter2', isOwner: true });
    rememberIn(h, `private:${OWNER}`, { kind: 'fact', content: '主人家 Wi-Fi 密码是 hunter2' });
    incoming(h, `group:${A_GROUP}`, { sender: '主人', userId: OWNER, text: '你在群里说说我家 Wi-Fi 密码', isOwner: true });
    await h.deliverPrompt(`group:${A_GROUP}`, 'wake', { wakeReason: 'wake' });
    const prompt = promptTextOf(h);
    assert.ok(!prompt.includes('hunter2'), '群提示词不能出现主人私聊内容');
  }, { config: { memory: memoryConfig() } });
});

test('桥接工具路由：群里传 personShared 会被拒绝（不能替当事人授权跨群）', async () => {
  await withBridge(async (h) => {
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      const key = `group:${A_GROUP}`;
      incoming(h, key, { sender: '小明', userId: XIAOMING, text: '我喜欢猫' });
      const token = h.getSocialV2State(key).agentToken;
      const res = await requestJson(port, '/api/socialV2/memory-append', {
        method: 'POST',
        agentToken: token,
        body: { key, category: 'preference', content: '小明喜欢猫', extra: { target: '小明', personShared: true } }
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
      assert.equal(h.memory.store().countMemories({ personaId: h.memory.personaId }), 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, { config: { memory: memoryConfig() } });
});

test('桥接身份：异步工具调用认本轮发言者，不认稍后插话的人', async () => {
  await withBridge(async (h) => {
    const key = `group:${A_GROUP}`;
    incoming(h, key, { sender: '小明', userId: XIAOMING, text: '我下周要面试' });
    await h.deliverPrompt(key, 'wake', { wakeReason: 'wake' });
    // 唤醒投递之后，另一个群友才说话（工具调用会晚于这条消息）
    incoming(h, key, { sender: '路人', userId: '999888777', text: '你们吃了吗' });
    const actor = h.memoryActorForV2(h.getSocialV2State(key));
    // VM 里跨 realm 的数组原型不同，deepEqual(strict) 会误报；用 join 比较内容。
    assert.equal(actor.userIds.join(','), XIAOMING, '本轮发言者应冻结为唤醒里的那个人');

    const s = h.memory.store();
    const other = s.addMemory({
      personaId: h.memory.personaId, scope: 'group', scopeKey: A_GROUP, kind: 'episode',
      subjectId: '999888777', subjectLabel: '路人', content: '路人昨天丢了钱包'
    });
    const mine = s.addMemory({
      personaId: h.memory.personaId, scope: 'group', scopeKey: A_GROUP, kind: 'fact',
      subjectId: XIAOMING, subjectLabel: '小明', content: '小明在找实习'
    });

    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      const token = h.getSocialV2State(key).agentToken;
      const denied = await requestJson(port, '/api/socialV2/memory-forget', {
        method: 'POST', agentToken: token, body: { key, id: other.id }
      });
      assert.equal(denied.body.ok, false, '不能删掉后来插话者的记忆');
      assert.equal(s.getMemory(other.id).status, 'active');
      const allowed = await requestJson(port, '/api/socialV2/memory-forget', {
        method: 'POST', agentToken: token, body: { key, id: mine.id }
      });
      assert.equal(allowed.body.ok, true, '本轮发言者自己的记忆可以删');
      assert.equal(s.getMemory(mine.id), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, { config: { memory: memoryConfig() } });
});

test('桥接身份：person_shared 只在本轮发言者本人出现时可见', async () => {
  await withBridge(async (h) => {
    const peer = '999888777';
    const dmCtx = h.memory.buildContext({
      conversationKey: `private:${peer}`, ownerQQ: OWNER, senders: [{ userId: peer, name: '路人' }]
    });
    const created = h.memory.remember({
      ctx: dmCtx, kind: 'preference', content: '路人喜欢猫，这个可以跟别人说',
      subjectId: peer, subjectLabel: '路人', scope: 'person_shared'
    });
    assert.equal(created.ok, true, created.reason);

    const key = `group:${A_GROUP}`;
    incoming(h, key, { sender: '小明', userId: XIAOMING, text: '今天好热' });
    await h.deliverPrompt(key, 'wake', { wakeReason: 'wake' });
    // 唤醒后路人才插话：本轮上下文仍只认小明
    incoming(h, key, { sender: '路人', userId: peer, text: '我喜欢猫' });
    const rows = h.memory.recall({ ctx: h.memoryContextForV2(key, h.getSocialV2State(key)), text: '喜欢猫', limit: 5 }).rows;
    assert.equal(rows.length, 0, '后来插话不能把跨场景共享内容拉进本轮');

    // 下一轮由路人的消息触发唤醒 → 他本人在场，才可见
    await h.deliverPrompt(key, 'wake', { wakeReason: 'wake' });
    const rows2 = h.memory.recall({ ctx: h.memoryContextForV2(key, h.getSocialV2State(key)), text: '喜欢猫', limit: 5 }).rows;
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0].scope, 'person_shared');
  }, { config: { memory: memoryConfig() } });
});

test('桥接删除：同时清掉旧 social-v2 副本，降级路径与后续唤醒都不会再说出来', async () => {
  await withBridge(async (h) => {
    const key = `group:${A_GROUP}`;
    incoming(h, key, { sender: '小明', userId: XIAOMING, text: '我下周要面试' });
    const secret = '小明把门禁口令 ZEBRA-111 告诉了我';
    const st = h.getSocialV2State(key);
    st.activeTopics = [{ text: secret, lastMentionAt: Date.now() }];
    h.saveSocialV2State();
    const s = h.memory.store();
    const rec = s.addMemory({
      personaId: h.memory.personaId, scope: 'group', scopeKey: A_GROUP, kind: 'state',
      subjectId: XIAOMING, subjectLabel: '小明', content: secret
    });

    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      const token = st.agentToken;
      const res = await requestJson(port, '/api/socialV2/memory-forget', {
        method: 'POST', agentToken: token, body: { key, id: rec.id }
      });
      assert.equal(res.body.ok, true, res.text);
      assert.ok(res.body.legacyScrubbed >= 1, '删除时应同步清理旧副本');
      assert.equal(s.getMemory(rec.id), null);
      assert.equal(h.getSocialV2State(key).activeTopics.length, 0, 'social-v2 里的旧话题必须被删');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // 模拟旧副本回流（另一个进程/旧备份又写回来）：对账逻辑仍要清掉
    h.getSocialV2State(key).activeTopics.push({ text: secret, lastMentionAt: Date.now() });
    h.saveSocialV2State();
    const recon = h.maybeReconcileTombstonesV2({ force: true });
    assert.ok(recon.removed >= 1);
    assert.equal(h.getSocialV2State(key).activeTopics.length, 0);

    // 真实唤醒提示词里不能再出现被删内容（旧格式注入 + 新块都要干净）
    await h.deliverPrompt(key, 'wake', { wakeReason: 'wake' });
    const prompt = promptTextOf(h, h.calls.prompts.length - 1);
    assert.ok(!prompt.includes('ZEBRA-111'), '被删内容不得通过任何路径回到提示词');
  }, { config: { memory: memoryConfig() } });
});

test('控制台长期记忆接口：list / config 热更新 / delete', async () => {
  await withBridge(async (h) => {
    const key = `group:${A_GROUP}`;
    incoming(h, key, { sender: '小明', userId: XIAOMING, text: '我下周要面试' });
    const s = h.memory.store();
    const rec = s.addMemory({
      personaId: h.memory.personaId, scope: 'group', scopeKey: A_GROUP, kind: 'fact',
      subjectId: XIAOMING, subjectLabel: '小明', content: '小明下周三去上海出差，回来带蝴蝶酥'
    });

    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      // 列表：内容 / 过滤 / 统计
      const list = await requestJson(port, `/api/memory/list?q=${encodeURIComponent('蝴蝶酥')}`);
      assert.equal(list.status, 200, list.text);
      assert.equal(list.body.ok, true);
      assert.ok(list.body.memories.some((m) => m.id === rec.id));
      assert.equal(list.body.mode, 'live');
      const filtered = await requestJson(port, '/api/memory/list?kind=promise');
      assert.equal(filtered.body.total, 0);

      // 配置：写回 config.json + 热更新 mode / 预算 / 提炼白名单
      const cfgRes = await requestJson(port, '/api/memory/config', {
        method: 'POST',
        body: { mode: 'shadow', maxExtraCallsPerDay: 3, extractionConversations: [`private:${OWNER}`], autoExtractionEnabled: true }
      });
      assert.equal(cfgRes.status, 200, cfgRes.text);
      assert.equal(cfgRes.body.applied.mode, 'shadow');
      assert.equal(h.memory.mode, 'shadow', 'manager 读取模式应立即生效');
      assert.equal(h.getCfg().memory.retrieval.mode, 'shadow', '桥接配置对象应同步');
      const fileCfg = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
      assert.equal(fileCfg.memory.retrieval.mode, 'shadow');
      assert.equal(fileCfg.memory.capture.maxExtraCallsPerDay, 3);
      assert.deepEqual(fileCfg.memory.capture.extractionConversations, [`private:${OWNER}`]);
      const statusAfter = await requestJson(port, '/api/memory/status');
      assert.equal(statusAfter.body.mode, 'shadow');

      // 非法 mode 必须拒绝，且不能写坏配置
      const bad = await requestJson(port, '/api/memory/config', { method: 'POST', body: { mode: 'turbo' } });
      assert.equal(bad.status, 400);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).memory.retrieval.mode, 'shadow');

      // 删除：真删 + 墓碑
      const del = await requestJson(port, '/api/memory/delete', { method: 'POST', body: { id: rec.id } });
      assert.equal(del.status, 200, del.text);
      assert.equal(s.getMemory(rec.id), null);
      assert.ok(s.countTombstones({ personaId: h.memory.personaId }) >= 1);
      const after = await requestJson(port, `/api/memory/list?status=all`);
      assert.equal(after.body.memories.some((m) => m.id === rec.id), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, { config: { memory: memoryConfig() }, allow: { private: [OWNER], groups: [A_GROUP, B_GROUP] } });
});

test('桥接预算：真实提示词里的记忆块不超过 350 tokens', async () => {
  await withBridge(async (h) => {
    const s = h.memory.store();
    for (let i = 0; i < 80; i += 1) {
      s.addMemory({
        personaId: h.memory.personaId, scope: 'group', scopeKey: A_GROUP, kind: 'episode',
        subjectId: XIAOMING, subjectLabel: '小明',
        content: `小明第 ${i} 次面试：面试官问了${'很长的技术问题'.repeat(3)}`,
        confidence: 0.9
      });
    }
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '你还记得我之前那些面试吗，都问了什么' });
    await h.deliverPrompt(`group:${A_GROUP}`, 'wake', { wakeReason: 'wake' });
    const prompt = promptTextOf(h);
    const marker = '【长期记忆';
    const index = prompt.lastIndexOf(marker);
    assert.ok(index >= 0, '应注入记忆块');
    const block = prompt.slice(index);
    const tokens = estimateTokens(block);
    console.log(`[bridge] 注入块 ${tokens} tokens / ${block.length} 字符`);
    assert.ok(tokens <= HARD_MAX_PROMPT_TOKENS, `注入 ${tokens} tokens 超过硬上限`);
  }, { config: { memory: memoryConfig() } });
});

test('桥接降级：SQLite 打不开时 QQ 投递仍然成功', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bridge-broken-'));
  const broken = path.join(root, 'broken-db');
  fs.mkdirSync(broken, { recursive: true });
  try {
    await withBridge(async (h) => {
      incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '我下周五要面试' });
      const result = await h.deliverPrompt(`group:${A_GROUP}`, 'wake', { wakeReason: 'wake' });
      assert.equal(result.ok, true, '记忆坏掉也必须把 prompt 投递出去');
      assert.equal(h.calls.prompts.length, 1, 'DSH 会话确实收到了 prompt');
      const prompt = promptTextOf(h);
      assert.ok(!prompt.includes('【长期记忆'), '降级时不应有记忆块');
      await h.sendToQQ(`group:${A_GROUP}`, '正常聊天').catch(() => {});
    }, { config: { memory: memoryConfig({ dbPath: broken }) } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('桥接捕获：规则命中的消息进候选，普通闲聊不进', async () => {
  await withBridge(async (h) => {
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '哈哈哈哈' });
    incoming(h, `group:${A_GROUP}`, { sender: '小明', userId: XIAOMING, text: '我下周五要去面试，有点紧张', messageId: '102' });
    const s = h.memory.store();
    const pending = s.listCandidates({ personaId: h.memory.personaId, status: 'pending' });
    assert.equal(pending.length, 1, '只有值得记的那条进候选');
    assert.equal(pending[0].subjectId, XIAOMING, '候选必须带上可信的 QQ 身份');
    assert.equal(pending[0].scope, 'group');
    assert.equal(s.countMemories({ personaId: h.memory.personaId }), 0, '捕获不等于写长期记忆');
  }, { config: { memory: memoryConfig() } });
});

test('桥接会话退役：会话内状态提升到群作用域，下次重建仍可检索', async () => {
  await withBridge(async (h) => {
    const key = `group:${A_GROUP}`;
    incoming(h, key, { sender: '小明', userId: XIAOMING, text: '答应帮你找那个项目' });
    const s = h.memory.store();
    const rec = s.addMemory({
      personaId: h.memory.personaId, scope: 'session', scopeKey: key, kind: 'promise',
      subjectId: XIAOMING, subjectLabel: '小明', content: '答应帮小明找那个开源项目'
    });
    assert.equal(s.getMemory(rec.id).scope, 'session');
    await h.ensureSession(key);
    h.retireIdleSessionV2(key, 13 * 3600 * 1000, '测试退役');
    const after = s.getMemory(rec.id);
    assert.equal(after.scope, 'group', '退役后应提升到群作用域');
    assert.equal(after.scopeKey, A_GROUP);
    const ctx = h.memoryContextForV2(key, h.getSocialV2State(key));
    const found = h.memory.recall({ ctx, text: '答应找的那个项目', limit: 5 });
    assert.ok(found.rows.some((r) => r.content.includes('开源项目')), '重建后仍应检索到承诺');
  }, { config: { memory: memoryConfig() } });
});

test('桥接工具路由：memory-append/recall/forget 的长期记忆端到端', async () => {
  await withBridge(async (h) => {
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      const key = `group:${A_GROUP}`;
      incoming(h, key, { sender: '小明', userId: XIAOMING, text: '我最近开始学日语了' });
      const st = h.getSocialV2State(key);
      const token = st.agentToken;

      const added = await requestJson(port, '/api/socialV2/memory-append', {
        method: 'POST',
        agentToken: token,
        body: { key, category: 'preference', content: '小明最近开始学日语了', extra: { target: '小明' } }
      });
      assert.equal(added.status, 200, added.text);
      assert.equal(added.body.ok, true);
      assert.equal(added.body.scope, 'group');
      assert.equal(added.body.subject.resolved, true, '昵称应解析到 QQ 身份');

      const recalled = await requestJson(port, `/api/socialV2/memory-recall?key=${encodeURIComponent(key)}&q=${encodeURIComponent('日语')}`);
      assert.equal(recalled.status, 200, recalled.text);
      assert.ok(recalled.body.memories.some((m) => m.content.includes('日语')));

      const status = await requestJson(port, `/api/socialV2/memory-status?key=${encodeURIComponent(key)}`, { agentToken: token });
      assert.equal(status.body.enabled, true);
      assert.ok(status.body.memories >= 1);

      // 越权：别的群的 agent token 不能读这个群
      const stB = h.getSocialV2State(`group:${B_GROUP}`);
      const foreign = await requestJson(port, `/api/socialV2/memory-recall?key=${encodeURIComponent(key)}&q=${encodeURIComponent('日语')}`, { agentToken: stB.agentToken });
      assert.equal(foreign.status, 403, '跨会话令牌必须被拒绝');

      const forgot = await requestJson(port, '/api/socialV2/memory-forget', {
        method: 'POST', agentToken: token, body: { key, content: '日语' }
      });
      assert.equal(forgot.body.ok, true, forgot.text);
      const gone = await requestJson(port, `/api/socialV2/memory-recall?key=${encodeURIComponent(key)}&q=${encodeURIComponent('日语')}`);
      assert.equal(gone.body.memories.length, 0, '删除后不能再召回');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, { config: { memory: memoryConfig() } });
});

test('桥接工具路由：记忆关闭时长期记忆接口返回 409（旧轻量记忆仍可用）', async () => {
  await withBridge(async (h) => {
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      const key = `group:${A_GROUP}`;
      const token = h.getSocialV2State(key).agentToken;
      const longTerm = await requestJson(port, '/api/socialV2/memory-append', {
        method: 'POST', agentToken: token, body: { key, category: 'fact', content: '测试' }
      });
      assert.equal(longTerm.status, 409);
      const legacy = await requestJson(port, '/api/socialV2/memory-append', {
        method: 'POST', agentToken: token, body: { key, category: 'activeTopic', content: '在聊周末去哪' }
      });
      assert.equal(legacy.status, 200, '旧的轻量记忆路径不受影响');
      assert.equal(legacy.body.ok, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, { config: { memory: { enabled: false } } });
});
