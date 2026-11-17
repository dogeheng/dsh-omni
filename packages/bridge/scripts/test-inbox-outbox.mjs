// 长消息全文仓（inbox）与待投递持久队列（outbox）的纯模块测试。
//
// 这两个模块解决的问题都不在"功能"上，而在数据完整性上，所以测试只盯三件事：
//   1. inbox 只存被截断的消息（普通聊天不落盘）、按 messageId 能取回、有界；
//   2. outbox 重启后能把队列原样读回、成功即删、失败按次数退避；
//   3. 两者遇到损坏文件都**不能**用空数据覆盖原文件（与 sessions.json 同一口径）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInbox, inboxFileName, shouldStoreFull, INLINE_LIMIT } from '../src/inbox.js';
import { createOutbox, backoffMs, OUTBOX_VERSION } from '../src/outbox.js';

let failed = 0;
function assert(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failed = 1; }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-inbox-outbox-'));
const cleanup = () => fs.rmSync(temp, { recursive: true, force: true });
process.on('exit', cleanup);

// ── inbox ────────────────────────────────────────────────────────────────────
const longText = '报错：' + 'x'.repeat(600);

assert(shouldStoreFull(longText) === true, 'inbox: 超过 200 字的消息要存全文');
assert(shouldStoreFull('短消息') === false, 'inbox: 短消息不存');
assert(shouldStoreFull('x'.repeat(INLINE_LIMIT)) === false, 'inbox: 正好 200 字不存（与预览长度一致）');
assert(inboxFileName('group:123') === 'group_123.jsonl', 'inbox: 文件名把冒号折成下划线');
assert(inboxFileName('private:456') === 'private_456.jsonl', 'inbox: 私聊文件名可读');

const inbox = createInbox({ dir: path.join(temp, 'inbox') });
assert(inbox.put({ key: 'group:1', messageId: 9001, seq: 7, text: '短' }) === false, 'inbox: put 短消息返回 false');
assert(fs.existsSync(path.join(temp, 'inbox', 'group_1.jsonl')) === false, 'inbox: 短消息不产生文件');
assert(inbox.put({ key: 'group:1', messageId: 9002, seq: 8, text: longText }) === true, 'inbox: put 长消息返回 true');
assert(inbox.get({ key: 'group:1', messageId: 9002 }) === longText, 'inbox: 按 messageId 取回全文');
assert(inbox.get({ key: 'group:1', messageId: '9002' }) === longText, 'inbox: messageId 数字/字符串等价');
assert(inbox.get({ key: 'group:1', messageId: 9999 }) === null, 'inbox: 没有的消息返回 null');
assert(inbox.get({ key: 'group:2', messageId: 9002 }) === null, 'inbox: 会话之间不串');

// 同一 messageId 重复写入不产生第二行（网关重发）。
const file = path.join(temp, 'inbox', 'group_1.jsonl');
const before = fs.readFileSync(file, 'utf8').trim().split('\n').length;
inbox.put({ key: 'group:1', messageId: 9002, seq: 9, text: longText });
assert(fs.readFileSync(file, 'utf8').trim().split('\n').length === before, 'inbox: 同一 messageId 不重复落盘');

// 有界：超过 maxLines 只留最后一段。
const small = createInbox({ dir: path.join(temp, 'inbox-small'), maxLines: 3 });
for (let i = 0; i < 6; i++) small.put({ key: 'group:9', messageId: 100 + i, text: `长${i}` + 'y'.repeat(300) });
const kept = fs.readFileSync(path.join(temp, 'inbox-small', 'group_9.jsonl'), 'utf8').trim().split('\n');
assert(kept.length === 3, `inbox: 超出 maxLines 截到 3 条（实际 ${kept.length}）`);
assert(small.get({ key: 'group:9', messageId: 105 }) !== null, 'inbox: 截断后最新的还在');
assert(small.get({ key: 'group:9', messageId: 100 }) === null, 'inbox: 截断后最旧的已丢弃');

// ── outbox ───────────────────────────────────────────────────────────────────
assert(backoffMs(1) === 3000, 'outbox: 第 1 次失败等 3s');
assert(backoffMs(2) === 6000, 'outbox: 第 2 次失败等 6s');
assert(backoffMs(10) === 60000, 'outbox: 退避封顶 60s');

const outboxFile = path.join(temp, 'outbox.json');
const ob = createOutbox({ file: outboxFile });
ob.load();
const a = ob.add({ key: 'group:1', payload: { promptText: 'A', wakeReason: 'message' } });
const b = ob.add({ key: 'group:1', payload: { promptText: 'B', wakeReason: 'message' } });
const c = ob.add({ key: 'group:2', payload: { promptText: 'C' } });
assert(ob.size() === 3, 'outbox: 三条入队');
assert(ob.add({ key: 'group:1', payload: { promptText: 'A', wakeReason: 'message' }, dedupe: true }).id === a.id, 'outbox: dedupe 时同 key 同文本不重复入队');
assert(ob.size() === 3, 'outbox: dedupe 入队后仍是三条');
// 默认不去重：同一个人连说两句"在吗"是两条消息，必须都投出去。
ob.add({ key: 'group:1', payload: { promptText: 'A', wakeReason: 'message' } });
assert(ob.size() === 4, 'outbox: 默认允许重复文本入队');
ob.remove(ob.pending('group:1').at(-1).id);
assert(ob.size() === 3, 'outbox: 清理重复项后回到三条');
assert(ob.pending('group:1').length === 2, 'outbox: 按 key 过滤');
assert(ob.pending('group:1')[0].id === a.id, 'outbox: 按入队顺序');
assert(fs.existsSync(outboxFile), 'outbox: 入队即落盘');

ob.fail(b.id, new Error('DSH 不可用'));
const failedEntry = ob.pending('group:1').find((e) => e.id === b.id);
assert(failedEntry.attempts === 1, 'outbox: 失败计数 +1');
assert(failedEntry.nextAt > Date.now(), 'outbox: 失败后有下次重试时间');
assert(ob.ready('group:1').map((e) => e.id).join() === a.id, 'outbox: 退避中的条目不进 ready');

ob.remove(a.id);
assert(ob.size() === 2, 'outbox: 投递成功后删除');

// 重启：新实例读回同样的条目（这是这次改动的主要目的）。
const ob2 = createOutbox({ file: outboxFile });
const restored = ob2.load();
assert(restored.length === 2, `outbox: 重启后读回 2 条（实际 ${restored.length}）`);
assert(restored.every((e) => e.nextAt === 0), 'outbox: 重启后清掉退避时间（立刻重试一次）');
assert(JSON.parse(fs.readFileSync(outboxFile, 'utf8')).version === OUTBOX_VERSION, 'outbox: 落盘带 version');

// 唤醒项故意没有 promptText（提示词在投递那一刻才按 wakeReason 拼），
// 重启时不能被当成空条目丢掉。
const wakeFile = path.join(temp, 'outbox-wake.json');
fs.writeFileSync(wakeFile, JSON.stringify({
  version: OUTBOX_VERSION,
  entries: [
    { id: 'w1', key: 'group:7', payload: { promptText: '', wakeReason: 'atMention' }, createdAt: 1, attempts: 2, nextAt: Date.now() + 60000, lastError: 'DSH 未就绪' },
    { id: 'w2', key: 'group:7', payload: { promptText: '' }, createdAt: 2, attempts: 0, nextAt: 0, lastError: '' },
    { id: 'w3', key: 'group:7', payload: { promptText: '普通消息' }, createdAt: 3, attempts: 0, nextAt: 0, lastError: '' },
  ],
}));
const obWake = createOutbox({ file: wakeFile });
const wakeRestored = obWake.load();
assert(wakeRestored.length === 2, `outbox: 只有唤醒原因的条目也要读回（实际 ${wakeRestored.length}）`);
assert(wakeRestored[0].id === 'w1' && wakeRestored[0].payload.wakeReason === 'atMention', 'outbox: 唤醒原因原样读回');
assert(wakeRestored[1].payload.promptText === '普通消息', 'outbox: 普通文本条目不受影响');
assert(wakeRestored[0].nextAt === 0, 'outbox: 唤醒项重启后也清掉退避时间');

// 上限：超出 maxEntries 丢最旧，不无限增长。
const tiny = createOutbox({ file: path.join(temp, 'outbox-tiny.json'), maxEntries: 2 });
tiny.load();
for (const n of ['1', '2', '3']) tiny.add({ key: 'group:3', payload: { promptText: n } });
assert(tiny.size() === 2, 'outbox: 超过上限丢最旧');
assert(tiny.pending().map((e) => e.payload.promptText).join() === '2,3', 'outbox: 保留的是最新的两条');

// 损坏文件：只读降级，绝不覆盖。
const brokenFile = path.join(temp, 'outbox-broken.json');
fs.writeFileSync(brokenFile, '{not json');
const ob3 = createOutbox({ file: brokenFile });
assert(ob3.load().length === 0, 'outbox: 损坏文件读回空');
ob3.add({ key: 'group:4', payload: { promptText: 'X' } });
assert(fs.readFileSync(brokenFile, 'utf8') === '{not json', 'outbox: 损坏文件不会被空队列覆盖');

// 形状不对（合法 JSON 但不是预期结构）同样只读。
const wrongFile = path.join(temp, 'outbox-wrong.json');
fs.writeFileSync(wrongFile, JSON.stringify({ hello: 'world' }));
const ob4 = createOutbox({ file: wrongFile });
ob4.load();
ob4.add({ key: 'group:5', payload: { promptText: 'Y' } });
assert(JSON.parse(fs.readFileSync(wrongFile, 'utf8')).hello === 'world', 'outbox: 形状不对也不覆盖');

if (failed) {
  console.error('FAILED');
  process.exit(1);
}
console.log('all inbox/outbox tests passed');
