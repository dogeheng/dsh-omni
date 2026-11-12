import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createOutbox } from '../src/outbox.js';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('duplicate inbound event is ignored by messageId', async (h) => {
  const key = 'group:456';
  const first = h.appendSocialV2Message(key, 'A', '在吗', '在吗', false, false, 7001, [], 111, []);
  const st = h.getSocialV2State(key);
  assert.equal(first.duplicate, false);
  assert.equal(st.unread.length, 1);
  const seqBefore = st.lastUnreadSeq;
  const second = h.appendSocialV2Message(key, 'A', '在吗', '在吗', false, false, 7001, [], 111, []);
  assert.equal(second.duplicate, true);
  assert.equal(st.unread.length, 1, '重发的同一条事件不能多进一条未读');
  assert.equal(st.lastUnreadSeq, seqBefore, '重发不能推进本地 seq');
  // 同一个 messageId 但正文不同：**必须收下**。判据是 id+正文指纹，
  // 只按 id 去重会把"网关复用 id"时的另一条真人消息静默吞掉（比重复严重得多）。
  const sameIdDifferentText = h.appendSocialV2Message(key, 'A', '在的', '在的', false, false, 7001, [], 111, []);
  assert.equal(sameIdDifferentText.duplicate, false, '同 id 不同正文不能当成重放');
  assert.equal(st.unread.length, 2);
  // 不同 messageId 照常入库（去重不能误伤正常消息）。
  const third = h.appendSocialV2Message(key, 'A', '吃了吗', '吃了吗', false, false, 7003, [], 111, []);
  assert.equal(third.duplicate, false);
  assert.equal(st.unread.length, 3);
});

await test('overlong message keeps its full text outside the window', async (h) => {
  const key = 'group:456';
  const text = '报错：' + 'x'.repeat(500);
  h.appendSocialV2Message(key, 'A', text, text, false, false, 7002, [], 111, []);
  const st = h.getSocialV2State(key);
  const msg = st.unread.at(-1);
  assert.equal(msg.text.length, 200, '窗口里仍然只放 200 字预览');
  assert.equal(msg.fullText, true);
  assert.equal(h.inbox.get({ key, messageId: 7002 }), text, '全文必须能按 messageId 取回');
});

await test('undelivered prompt survives a bridge restart', async (h) => {
  h.setReady(false);
  const result = await h.deliverPrompt('group:456', '重启期间的留言', {});
  // 同一句话发了两次就是两条消息：投递层不能按文本合并（那会吞掉真人重复说的话）。
  const repeated = await h.deliverPrompt('group:456', '重启期间的留言', {});
  assert.equal(result.queued, true);
  assert.equal(repeated.queued, true);
  const file = path.join(h.temp, 'data', 'outbox.json');
  assert.ok(fs.existsSync(file), '未投递的消息必须落盘');
  const restored = createOutbox({ file }).load();
  assert.equal(restored.length, 2, '重复文本也要各占一条');
  assert.equal(restored[0].payload.promptText, '重启期间的留言');
  // 模拟"重启后 DSH 恢复"：能真的投出去，并从磁盘清掉。
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 0, '投递成功后磁盘要清空');
});

await test('delivery problems stay empty until something needs a person', async (h) => {
  assert.equal(h.deliveryProblems().length, 0, '健康时待处理必须为空');
  h.noteDeliveryFailure('group:456', new Error('DSH 拒绝'));
  h.noteDeliveryFailure('group:456', new Error('DSH 拒绝'));
  assert.equal(h.deliveryProblems().length, 0, '失败两次还不报（避免抖动刷屏）');
  h.noteDeliveryFailure('group:456', new Error('DSH 拒绝'));
  const problems = h.deliveryProblems();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'delivery');
  assert.match(problems[0].text, /group:456 连续投递失败 3 次/);
  h.clearDeliveryFailure('group:456');
  assert.equal(h.deliveryProblems().length, 0, '投递恢复后要自己消失');
});

await test('lease timeouts and slow turns surface without a log digger', async (h) => {
  h.noteLeaseTimeout('group:456');
  assert.ok(h.deliveryProblems().some((p) => p.kind === 'lease'), '租约超时要浮上来');
  // 一次 130s 的回合只是记录，不打断人；超过 300s 才算问题。
  h.noteSlowTurn('fixture-1', 130_000);
  assert.equal(h.deliveryProblems().filter((p) => p.kind === 'slow').length, 0);
  h.noteSlowTurn('fixture-1', 310_000);
  assert.ok(h.deliveryProblems().some((p) => p.kind === 'slow'), '超过 5 分钟的回合要浮上来');
  const snapshot = h.deliverySnapshot();
  assert.equal(snapshot.slowTurns.length, 2);
  assert.equal(snapshot.slowTurns[0].seconds, 130);
  assert.equal(snapshot.pending, h.outbox.size());
});

await test('a thread survives an interruption and comes back in the wake snapshot', async (h) => {
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  // A 先说要办的事；B 刷了六条把它挤出两个窗口；A 再补一句。
  h.appendSocialV2Message(key, 'A', '帮我看看 X 项目的报错', '帮我看看 X 项目的报错', false, false, 8001, [], 111, []);
  for (let n = 0; n < 6; n += 1) {
    h.appendSocialV2Message(key, 'B', `插话${n}`, `插话${n}`, false, false, 8010 + n, [], 222, []);
  }
  h.appendSocialV2Message(key, 'A', '算了先看 README', '算了先看 README', false, false, 8020, [], 111, []);
  // 现实里的样子：中间那些早被读过，只有最后一句是新的。
  st.unread = st.unread.filter((m) => String(m.messageId) === '8020');
  const recent = st.recentMessages.slice(-8);
  assert.equal(recent[0].threadId, recent.at(-1).threadId, '同一件事的第二句要接上第一句（跨过中间六条）');
  assert.notEqual(recent[0].threadId, recent[1].threadId, '插话的人不该被并进别人的 thread');

  const snap = h.buildWakeSnapshotV2(key);
  assert.ok(snap.messages.every((m) => m.threadId), '快照里的消息要带 threadId（模型才知道哪些是一件事）');
  // 第一句已经被 wakeMessageLimit/wakeRecentLimit 两个窗口都挤出去了，只能靠 thread 带回来。
  const shownSeqs = new Set([...snap.messages, ...snap.recent].map((m) => m.seq));
  assert.equal(shownSeqs.has(recent[0].seq), false, '前置条件：第一句确实不在两个窗口里');
  assert.ok(Array.isArray(snap.thread) && snap.thread.some((m) => String(m.messageId) === '8001'),
    'thread 字段要带回被窗口挤掉的更早那句');
  assert.ok(snap.thread.every((m) => !shownSeqs.has(m.seq)), 'thread 不能和已经给出的消息重复');
});

await test('reply chain beats the same-sender rule', async (h) => {
  const key = 'group:456';
  h.appendSocialV2Message(key, 'A', '第一个话题', '第一个话题', false, false, 8101, [], 111, []);
  h.appendSocialV2Message(key, 'B', '第二个话题', '第二个话题', false, false, 8102, [], 222, []);
  // A 回复 B 的那条：应该并到 B 的 thread，而不是 A 自己上一个 thread。
  h.appendSocialV2Message(key, 'A', '回你一句', '回你一句', false, false, 8103, [], 111, [], '8102');
  const st = h.getSocialV2State(key);
  const [m1, m2, m3] = st.recentMessages.slice(-3);
  assert.equal(m3.threadId, m2.threadId, '回复链优先于同发送者规则');
  assert.notEqual(m3.threadId, m1.threadId);
});

await test('relay: a script asks a question and gets the quoted answer back', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data || '{}') }));
      }
    );
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('relay request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const admin = { 'x-console-token': 'fixture-console-token' };
  try {
    // 1. 管理端签发一个应用令牌
    const issued = await call('/api/relay-admin/apps', 'POST', admin, { name: 'resume-bot' });
    assert.equal(issued.status, 200);
    assert.ok(issued.body.token.startsWith('relay_'));
    const auth = { authorization: `Bearer ${issued.body.token}` };

    // 2. 无令牌/错令牌一律拒绝（不能回落到控制台全权）
    assert.equal((await call('/api/relay/ask', 'POST', {}, { text: 'x' })).status, 401);
    assert.equal((await call('/api/relay/ask', 'POST', { authorization: 'Bearer relay_wrong' }, { text: 'x' })).status, 401);

    // 3. 提问 → 立刻 202，并且 QQ 侧真的收到一条带短码的中继消息
    const asked = await call('/api/relay/ask', 'POST', auth, {
      text: '「期望薪资」填哪个？', choices: ['25k', '30k'], waitSec: 0
    });
    assert.equal(asked.status, 202);
    assert.equal(asked.body.status, 'sent');
    const sentEntry = h.calls.sent.at(-1);
    assert.match(sentEntry.text, /📨 resume-bot · #[0-9a-f]{4}/, '发出去的中继消息要带应用名与短码');
    assert.match(sentEntry.text, /回复本条，或带上 #/);

    // 4. 主人引用那条消息回答 → 中继消费掉，且不叫醒模型
    const messageId = h.relay.get(asked.body.id).messageId;
    const promptsBefore = h.calls.prompts.length;
    await h.handleIncoming('private', 123, {
      user_id: 123,
      self_id: 999,
      message_id: 70001,
      message: [
        { type: 'reply', data: { id: Number(messageId) } },
        { type: 'text', data: { text: '30k' } }
      ]
    }, h.cfg);
    assert.equal(h.calls.prompts.length, promptsBefore, '中继回答不该再叫醒模型');

    // 5. 调用方拿回答案（原样，且选项也对上了）
    const polled = await call(`/api/relay/requests/${encodeURIComponent(asked.body.id)}`, 'GET', auth);
    assert.equal(polled.status, 200);
    assert.equal(polled.body.status, 'answered');
    assert.equal(polled.body.answer.text, '30k');
    assert.equal(polled.body.answer.choice, '30k');
    assert.equal(polled.body.answer.via, 'quote');

    // 6. 别的应用查不到这条请求
    const other = await call('/api/relay-admin/apps', 'POST', admin, { name: 'other-app' });
    const foreign = await call(`/api/relay/requests/${encodeURIComponent(asked.body.id)}`, 'GET', { authorization: `Bearer ${other.body.token}` });
    assert.equal(foreign.status, 404, '应用之间不能互相查请求');

    // 7. 吊销后立刻失效
    await call('/api/relay-admin/apps/revoke', 'POST', admin, { id: issued.body.app.id });
    assert.equal((await call('/api/relay/ask', 'POST', auth, { text: 'x' })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('a silent gateway and real sleep both surface as 待处理', async (h) => {
  // 网关掉线超过 5 分钟：机器人还"活着"，但一条消息都收不到——这是最容易被忽略的故障。
  h.snowlumaHealth.connected = false;
  h.snowlumaHealth.downSince = Date.now() - 6 * 60_000;
  const gateway = h.deliveryProblems().find((p) => p.kind === 'gateway');
  assert.ok(gateway, '网关掉线要出现在待处理里');
  assert.match(gateway.text, /6 分钟/);
  h.snowlumaHealth.connected = true;
  h.snowlumaHealth.downSince = 0;
  assert.equal(h.deliveryProblems().filter((p) => p.kind === 'gateway').length, 0, '恢复后自动消失');

  // 合盖/空闲休眠：caffeinate 拦不住，醒来 QQ 会话就失效。
  h.sleepWatch.count = 2;
  h.sleepWatch.lastAt = Date.now();
  const sleep = h.deliveryProblems().find((p) => p.kind === 'sleep');
  assert.ok(sleep, '休眠要出现在待处理里');
  assert.match(sleep.text, /disablesleep 1/);
});

await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent');
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    await h.sendStickerV2('group:456', 'fixture-sticker');
    // 收藏表情现在走 send_custom_face（emoji_id），QQ 里才是真正的表情；
    // 带 @ 时才退回 image 段。这里断言默认路径不再把图片字节塞进 message。
    assert.equal(body.emoji_id, 'fixture-sticker', '收藏表情走 emoji_id');
    assert.equal(body.group_id, 456, '发给正确群');
    assert.equal(body.message, undefined, '默认不再发 image 段');
    console.log('PASS sticker sending uses send_custom_face with the sticker id');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// ── 语音发送（AI 通道）的安全边界 ────────────────────────────────────────────
// 语音比文本更"重"（真的会说话、不可撤回），所以这里逐条钉住它的闸门：
// 来源只能是语音库、白名单必须命中、限流要生效、文件名审计要拦住本机路径。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 默认出厂配置是 voice.enabled=false（AI 不能发语音）；这里显式打开，
  // 才能测"打开之后"的各项闸门。关闭时的行为单独在下面钉一条。
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    // 语音库 fixture：临时 config 的 ROOT 之下，voice.dir 默认 'audio'
    const audioDir = path.join(h.temp, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(1024, 1));
    // 库外的文件（模拟"随便一个本地文件"）
    const outside = path.join(h.temp, 'outside-secret.mp3');
    fs.writeFileSync(outside, Buffer.alloc(1024, 1));

    const names = h.voiceLibrary().map((v) => v.name);
    assert.ok(names.includes('hello.mp3'), '语音库列出库内音频');
    assert.ok(!names.some((n) => n.includes(h.temp)), '语音库不返回绝对路径');

    // 1) AI 只能按语音库名字取文件
    const okPath = h.resolveVoicePathForV2('hello');
    assert.equal(okPath.path, fs.realpathSync(path.join(audioDir, 'hello.mp3')), 'AI 省略扩展名也能命中语音库文件');

    // 2) 绝对路径默认被拒（防 prompt injection 拿任意本地文件外发）
    assert.throws(() => h.resolveVoicePathForV2(outside), /语音库|绝对路径/, 'AI 传库外绝对路径被拒');
    assert.throws(() => h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'), /语音库|绝对路径/, 'AI 传系统绝对路径被拒');

    // 3) 远程/内联来源被拒（体积与来源都不可控）
    for (const bad of ['https://example.com/a.mp3', 'base64://AAAA', 'data:audio/mp3;base64,AAAA']) {
      assert.throws(() => h.resolveVoicePathForV2(bad), /不接受|只能/, `AI 传 ${bad.split(':')[0]} 来源被拒`);
    }

    // 4) 真发一条（虚拟网关）：必须是 record 段、且 file 指向库内文件
    const sent = await h.sendVoiceForV2('group:456', 'hello.mp3', { readback: false });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    assert.ok(call, '语音走 send_group_msg');
    assert.equal(call.body.group_id, 456, '语音发给正确群');
    assert.equal(call.body.message.length, 1, '语音只发一个段');
    assert.equal(call.body.message[0].type, 'record', '段类型是 record');
    assert.equal(call.body.message[0].data.file, fs.realpathSync(path.join(audioDir, 'hello.mp3')), 'record 段指向库内绝对路径');
    assert.equal(sent.messageId, 9001, '返回网关 message_id');
    assert.equal(sent.readback, null, '显式关掉回读时不调 fetch_ptt_text');

    // 5) 落地校验：默认用 get_msg 回读确认这条消息真的带 record 段
    const h2 = await bridgeHarness({ config: voiceOn });
    try {
      const dir2 = path.join(h2.temp, 'audio');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, 'hi.mp3'), Buffer.alloc(512, 1));
      const sent2 = await h2.sendVoiceForV2('group:456', 'hi.mp3');
      // 注意：这些对象来自 vm realm，deepEqual 会因原型不同而失败 → 逐字段断言
      assert.equal(sent2.verification?.confirmed, true, '默认回读 get_msg 确认 record 段');
      assert.equal(sent2.verification?.duration, 3, '回读到语音时长');
      // 校验结果**不能**把源文件路径回传给 AI（私聊 get_msg 会把本机路径塞进 record.url）
      assert.equal(sent2.verification?.file, undefined, '校验结果不回传文件路径（防路径泄露进模型上下文）');
      assert.ok(h2.calls.http.some((c) => c.url.endsWith('/get_msg')), '校验走 get_msg');
      assert.equal(sent2.readback, null, '默认不索取转写（自己发的语音没有转写）');
      // 关掉校验时不发 get_msg
      const h2b = await bridgeHarness({ config: voiceOn });
      try {
        const dir2b = path.join(h2b.temp, 'audio');
        fs.mkdirSync(dir2b, { recursive: true });
        fs.writeFileSync(path.join(dir2b, 'hi.mp3'), Buffer.alloc(512, 1));
        const sent2b = await h2b.sendVoiceForV2('group:456', 'hi.mp3', { verify: false });
        assert.equal(sent2b.verification, null, 'verify=false 时不做回读校验');
        assert.ok(!h2b.calls.http.some((c) => c.url.endsWith('/get_msg')), 'verify=false 时不发 get_msg');
      } finally { await h2b.close(); }
    } finally { await h2.close(); }

    // 6) 文件名审计：含本机路径特征的名字不许外发。
    //    resolveVoicePathForV2 允许绝对路径的"文件名形态"由 allowAbsolutePath 管；
    //    这里直接喂一个**看起来就像本机路径**的名字，验证审计层会拦下来。
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', 'C:\\Users\\somebody\\secret-voice.mp3', { readback: false }),
      /敏感信息|语音库|绝对路径/,
      '文件名含本机路径特征被审计/来源校验拦截'
    );

    // 7) 限流：语音额度独立计数，超限拒绝
    const h3 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
    try {
      const dir3 = path.join(h3.temp, 'audio');
      fs.mkdirSync(dir3, { recursive: true });
      fs.writeFileSync(path.join(dir3, 'a.mp3'), Buffer.alloc(512, 1));
      await h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
      await assert.rejects(
        () => h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false }),
        /频率超限|每分钟/,
        '同一分钟内第二条语音被限流（每分钟 1 条）'
      );
      // 额度只在发出后才记账：参数错误不应吃掉配额
      const h4 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
      try {
        const dir4 = path.join(h4.temp, 'audio');
        fs.mkdirSync(dir4, { recursive: true });
        fs.writeFileSync(path.join(dir4, 'a.mp3'), Buffer.alloc(512, 1));
        await assert.rejects(() => h4.sendVoiceForV2('group:456', 'nope.mp3'), /找不到/, '不存在的音频被拒');
        // 失败没有消耗额度 → 紧接着真发一条应当成功
        const ok2 = await h4.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
        assert.equal(ok2.messageId, 9001, '失败不吃额度：随后发送成功');
      } finally { await h4.close(); }
    } finally { await h3.close(); }

    // 8) 语音功能总开关关闭时，**AI 通道**彻底拒绝
    const h5 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      await assert.rejects(() => h5.sendVoiceForV2('group:456', 'a.mp3'), /已关闭/, 'voice.enabled=false 时 AI 通道拒绝发送');
    } finally { await h5.close(); }

    // 9) 但**操作者通道**不受这个开关影响：否则"默认不启用"会变成"连手动试发都做不了"
    const h6 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      const dir6 = path.join(h6.temp, 'audio');
      fs.mkdirSync(dir6, { recursive: true });
      fs.writeFileSync(path.join(dir6, 'a.mp3'), Buffer.alloc(512, 1));
      const sent6 = await h6.sendVoiceV2('group:456', path.join(dir6, 'a.mp3'), { guard: false, audit: true });
      assert.equal(sent6.messageId, 9001, 'voice.enabled=false 时操作者仍能发（AI 开关不该封死手动路径）');
    } finally { await h6.close(); }

    // 10) 音量：倍数会传给音频处理，并原样回报给调用方
    const h7 = await bridgeHarness({ config: voiceOn });
    try {
      const dir7 = path.join(h7.temp, 'audio');
      fs.mkdirSync(dir7, { recursive: true });
      fs.writeFileSync(path.join(dir7, 'a.mp3'), Buffer.alloc(512, 1));
      const loud = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { volume: 2.5 } });
      assert.equal(loud.volume, 2.5, '音量倍数透传到音频处理');
      assert.equal(loud.audioMode, 'volume', 'mode 标为 volume');
      assert.match(loud.audioProcessing, /250%/, '处理说明含百分比');
      const normal = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true });
      assert.equal(normal.audioMode, 'original', '不传音量时保持原样（不转码）');
      assert.equal(normal.audioProcessing, '原始音量', '原样时说明为"原始音量"');
      const smart = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { normalize: true, loudness: 'loud' } });
      assert.equal(smart.audioMode, 'loudnorm', '智能音量 mode=loudnorm');
      assert.match(smart.audioProcessing, /-13/, '智能音量按档位给出目标 LUFS');
      // 非法音量必须被拦下（而不是把奇怪的值丢给 ffmpeg）
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { volume: 99 } }),
        /0\.1~4/,
        '越界音量被拒'
      );
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { normalize: true, loudness: 'nope' } }),
        /未知的响度档位/,
        '未知响度档位被拒'
      );
    } finally { await h7.close(); }

    console.log('PASS voice sending enforces library-only source, whitelist, budget, name audit and volume');
  } catch (error) { failures++; console.error('FAIL voice sending guards:', error.message); }
  finally { await h.close(); }
}

// ── 语音路径：allowAbsolutePath 不再放宽 AI 通道（任意本机音频外发）────────────
// 审计发现：开关打开时 resolveVoicePathForV2 会把 AI 给的绝对路径直接交给
// resolveAudioSource 解析，于是群友用提示注入就能让 AI 把本机任意音频（< 20MB）
// 发到群里；而 inspectAudio 在 ffprobe 不可用时对任何文件都放行。
// 现在即使开了开关，绝对路径也必须落在语音库目录之内。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } } } });
  try {
    const libraryDir = path.join(h.temp, 'audio');
    const outsideDir = path.join(h.temp, 'outside');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
    const outsideFile = path.join(outsideDir, 'secret.mp3');
    fs.writeFileSync(outsideFile, Buffer.alloc(512, 2));

    // 库外的绝对路径必须被拒绝（即使 allowAbsolutePath=true）
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', outsideFile, { readback: false }),
      /语音库/,
      'allowAbsolutePath=true 时库外绝对路径仍必须被拒绝'
    );
    // 相对穿越同样必须被拒绝
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', path.join('..', 'outside', 'secret.mp3'), { readback: false }),
      /语音库|\.\./,
      '相对路径穿越必须被拒绝'
    );
    // 库内的绝对路径应当仍然可用（开关的合理用途）
    const inside = await h.sendVoiceForV2('group:456', path.join(libraryDir, 'inside.mp3'), { readback: false });
    assert.equal(inside.messageId, 9001, '库内绝对路径仍可发送');
    console.log('PASS voice absolute paths stay confined to the library even when allowAbsolutePath is on');
  } catch (error) { failures++; console.error('FAIL voice library confinement:', error.message); }
  finally { await h.close(); }
}

// agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
// 因此仅靠控制台令牌挡不住 QQ 群里的 AI。人格/提示词/思考强度/白名单/重启等管理端点
// 必须对 agent token 一律 403，否则 AI 能改写自己的系统提示词或给自己提权。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': 'fixture-agent-token' };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/preset/sim-prompt'], ['POST', '/api/preset/sim-prompt'],
      ['GET', '/api/preset/sim-prompt/backups'], ['POST', '/api/preset/sim-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
      // 中继管理面：签发外部应用令牌属于纯权限外溢，智能体一律不许碰。
      ['GET', '/api/relay-admin/status'], ['POST', '/api/relay-admin/apps'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越与重复斜杠在 URL 解析后仍需被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 允许面：AI 真正需要的只读接口不应被误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理端点，管理员（仅控制台令牌）应可正常访问
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// ── 控制台入口的传输层防护：Host 头 + 令牌定长比较 + /api/authorize/read 鉴权 ──
// 这三条都是「审计发现 → 加固」的结果，钉住它们以防以后被无意改回去。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① DNS rebinding 硬化：非本机 Host 一律拒绝（即使带着正确的控制台令牌）。
    // 注意 Host 必须走 headers（Node 会用 options.host 覆盖它，那样测不到伪造 Host）。
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 合法的三个 Host 都要放行（127.0.0.1 / localhost / [::1] 加实际端口）
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须是定长：错长度/错内容的令牌都不得通过（不能因为"前缀对"就放行）。
    // 注意 Node 的 HTTP 客户端会自动裁掉自定义头的首尾空白，所以"带尾空格"这一类
    // 必须用 ?token= 传（控制台本来就接受这种入口，它才是真实的攻击面）。
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    // 概览页的「待处理」整块依赖 /api/status 的 delivery 字段：字段没了控制台会永远空白。
    const status = await call('/api/status', 'GET', admin);
    assert.equal(status.status, 200);
    const statusBody = JSON.parse(status.body);
    assert.equal(typeof statusBody.delivery, 'object', '/api/status 必须带 delivery');
    assert.ok(Array.isArray(statusBody.delivery.problems), 'delivery.problems 必须是数组');
    assert.equal(statusBody.delivery.problems.length, 0, '健康时 problems 为空');
    // 会话级主体不许看到 delivery（里面有别的群的 key 与错误文本）。
    const agentView = JSON.parse((await call('/api/status', 'GET', { 'x-agent-token': 'x', 'x-agent-call': '1' })).body);
    assert.equal(agentView.delivery, undefined, 'agent 视图不得包含 delivery');

    // ③ /api/authorize/read 不再接受空令牌（它曾对 agent 流量开放 ⇒ 成为免鉴权入口）。
    const noToken = await call('/api/authorize/read', 'POST', { ...admin, 'x-agent-token': 'x' }, { key: 'group:456' });
    assert.equal(noToken.status, 403, '空会话令牌必须被拒绝');
    console.log('PASS console rejects foreign Host headers, non-exact tokens and token-less authorize/read');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

if (failures) process.exitCode = 1;
