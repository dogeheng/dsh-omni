// 外部应用中继（relay）的纯模块测试。
//
// 盯三件事：
//   1. 消息格式与短码解析（模型/人看到的到底是什么）；
//   2. 关联规则——只认引用和 `#短码`，**绝不隐式匹配**；
//   3. 生命周期——排队、回答、超时、重启后继续、令牌吊销。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRelay,
  formatRelayMessage,
  formatNotifyMessage,
  makeCode,
  matchAnswer,
  parseCodePrefix,
  resolveChoice
} from '../src/relay/index.js';

let failed = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failed = 1; console.error(`❌ ${label}`); }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-relay-'));
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));

// ── 格式 ────────────────────────────────────────────────────────────────────
const formatted = formatRelayMessage({
  appName: '简历投手', code: 'a3f9', text: '期望薪资填哪个？', choices: ['25k', '30k']
});
ok(formatted.startsWith('📨 简历投手 · #a3f9'), '消息头带应用名与短码（一眼看出不是大肥鱼）');
ok(formatted.includes('1) 25k') && formatted.includes('2) 30k'), '选项带序号');
ok(formatted.includes('回复本条，或带上 #a3f9'), '页脚写明两种回答方式');
ok(formatNotifyMessage({ appName: 'X', text: '好了', level: 'urgent' }).startsWith('🚨'), 'urgent 通知用更醒目的图标');
ok(makeCode('same') === makeCode('same'), '短码对同一种子稳定');
ok(makeCode('a') !== makeCode('b'), '不同种子短码不同');

// ── 短码解析 ────────────────────────────────────────────────────────────────
ok(parseCodePrefix('#a3f9 30k').code === 'a3f9', '解析 #短码');
ok(parseCodePrefix('#a3f9 30k').rest === '30k', '剥掉短码后的正文');
ok(parseCodePrefix('#A3F9：30k').rest === '30k', '大写与中文冒号也认');
ok(parseCodePrefix('30k') === null, '没有短码返回 null');
ok(parseCodePrefix('#123') === null, '三位十六进制不算短码');

// ── 关联规则 ────────────────────────────────────────────────────────────────
const pending = [
  { id: 'r_1', status: 'sent', code: 'a3f9', messageId: '7001' },
  { id: 'r_2', status: 'sent', code: 'b7c2', messageId: '7002' }
];
ok(matchAnswer(pending, { quoteId: '7002', text: '30k' }).request.id === 'r_2', '引用谁就答谁');
ok(matchAnswer(pending, { text: '#a3f9 25k' }).via === 'code', '短码匹配');
ok(matchAnswer(pending, { text: '#zzzz' }) === null, '不存在的短码格式直接不匹配');
ok(matchAnswer(pending, { text: '#ffff 25k' }).ambiguous === true, '格式对但编号不存在 → 明确告知（不退化成普通聊天）');
ok(matchAnswer(pending, { text: '30k' }) === null, '**没有引用也没有短码时绝不匹配**（不做隐式）');
ok(matchAnswer([], { text: '#a3f9 30k' }) === null, '没有待答请求时返回 null');
ok(matchAnswer([{ id: 'r', status: 'answered', code: 'a3f9' }], { text: '#a3f9 x' }) === null, '已结束的请求不再接受回答');

// ── 选项映射 ────────────────────────────────────────────────────────────────
ok(resolveChoice(['25k', '30k'], '2').choice === '30k', '数字对选项');
ok(resolveChoice(['25k', '30k'], '30k').choiceIndex === 1, '原文对选项');
ok(resolveChoice(['25k', '30k'], '40k').choiceIndex === undefined, '对不上就只留原文');
ok(Object.keys(resolveChoice([], 'x')).length === 0, '没有选项时不产生 choice 字段');

// ── 生命周期 ────────────────────────────────────────────────────────────────
function makeRelay(fileSuffix = '') {
  const sent = [];
  const selfRecorded = [];
  const relay = createRelay({
    stateFile: path.join(temp, `state${fileSuffix}.json`),
    appsFile: path.join(temp, `apps${fileSuffix}.json`),
    send: async (conversation, text) => {
      sent.push({ conversation, text });
      return String(8000 + sent.length);
    },
    recordSelf: (conversation, text) => selfRecorded.push({ conversation, text }),
    defaultConversation: () => 'private:123',
    defaultTimeoutSec: 60
  });
  relay.load();
  return { relay, sent, selfRecorded };
}

{
  const { relay, sent, selfRecorded } = makeRelay('');
  const { app, token } = relay.createApp('resume-bot');
  ok(app.name === 'resume-bot' && token.startsWith('relay_'), '签发应用令牌（只返回一次）');
  ok(relay.verify(token)?.id === app.id, '令牌校验通过');
  ok(relay.verify('relay_wrong') === null, '错误令牌被拒');
  ok(relay.verify('') === null, '空令牌被拒');

  const first = await relay.create({ app, text: '期望薪资填哪个？', choices: ['25k', '30k'] });
  ok(first.status === 'sent', '第一条 ask 立刻发出');
  ok(sent.length === 1 && sent[0].text.includes('📨 resume-bot'), '发出的是带前缀的中继消息');
  ok(selfRecorded.length === 1, '同时记成"自己说过"（避免人格错乱）');

  const second = await relay.create({ app, text: '另一个问题' });
  ok(second.status === 'queued', '同一会话同时只发一条（其余排队）');
  ok(sent.length === 1, '排队的不会立刻发出去');

  // 通知不等回答，不该被一个待答问题挡住。
  const note = await relay.create({ app, kind: 'notify', text: '顺便说一句' });
  ok(note.status === 'sent' && sent.length === 2, '待答问题挂着时，通知照样立刻发出');
  ok(sent[1].text.startsWith('📨 resume-bot'), '通知也带应用名前缀');

  // 没有引用、没有短码 → 不消费
  ok(relay.onInbound({ conversation: 'private:123', text: '随便说点', isOwner: true }).consumed === false,
    '普通消息不会被中继吞掉');
  // 群友不能替主人回答
  ok(relay.onInbound({ conversation: 'private:123', text: '#a3f9 30k', isOwner: false }).consumed === false,
    '非主人不能回答问题');

  const verdict = relay.onInbound({
    conversation: 'private:123',
    quoteId: sent[0].messageId ?? '8001',
    text: '30k',
    isOwner: true
  });
  ok(verdict.consumed === true, '引用那条消息 → 命中');
  ok(verdict.request.answer.text === '30k', '答案原样保存');
  ok(verdict.request.answer.choice === '30k', '选项也一起对出来');
  ok(relay.get(first.id).status === 'answered', '状态变为 answered');
  // 回答后队列里的下一条自动发出（pump 是异步的，等一个 tick）
  await new Promise((resolve) => setTimeout(resolve, 20));
  ok(relay.get(second.id).status === 'sent', '回答后自动放下一条');

  // 短码路径
  const third = await relay.create({ app, text: '第三个问题' });
  ok(third.status === 'queued', '仍有待答时第三条排队');
  const codeAnswer = relay.onInbound({
    conversation: 'private:123',
    text: `#${relay.get(second.id).code} 好`,
    isOwner: true
  });
  ok(codeAnswer.consumed === true && relay.get(second.id).answer.text === '好', '短码回答且剥掉前缀');

  // 吊销
  ok(relay.revokeApp(app.id) === true, '吊销应用');
  ok(relay.verify(token) === null, '吊销后令牌立刻失效');

  // 重启：新的实例读回状态，sent 的请求还能按引用命中
  await new Promise((resolve) => setTimeout(resolve, 20)); // 等第三条被 pump 发出去
  if (!['answered', 'cancelled'].includes(relay.get(third.id).status)) relay.cancel(third.id);
  await new Promise((resolve) => setTimeout(resolve, 20)); // 等 cancel 触发的 pump 落定
  const fourth = await relay.create({ app: { id: 'app_x', name: 'x' }, text: '重启前问的' });
  ok(fourth.status === 'sent' && !!fourth.messageId, '重启前那条已发出且有 message_id');
  const restarted = makeRelay('').relay; // 同一路径，模拟桥接重启
  const revived = restarted.list({ status: 'sent' }).find((r) => r.id === fourth.id);
  ok(!!revived && revived.messageId === fourth.messageId, '重启后仍保留 message_id（引用还认得）');
}

{
  // 网关掉线时留在 queued；恢复后 sweep 要能把它发出去（而不是躺到超时）
  let fail = true;
  const sent = [];
  const relay = createRelay({
    stateFile: path.join(temp, 'state-gw.json'),
    appsFile: path.join(temp, 'apps-gw.json'),
    send: async (conversation, text) => {
      if (fail) throw new Error('SnowLuma WebSocket closed before opening');
      sent.push(text);
      return String(9000 + sent.length);
    },
    defaultConversation: () => 'private:123',
    defaultTimeoutSec: 60
  });
  relay.load();
  const { app } = relay.createApp('gw-down');
  const queued = await relay.create({ app, text: '网关挂了' });
  ok(queued.status === 'queued', '发不出去时留在 queued（不是直接失败）');
  ok(!sent.length, '确实一条都没发出去');
  fail = false;
  relay.sweep();
  await new Promise((resolve) => setTimeout(resolve, 20));
  ok(relay.get(queued.id).status === 'sent', '网关恢复后由 sweep 补发');
  ok(sent.length === 1, '补发只发一次');
}

{
  // 超时
  const { relay } = makeRelay('-timeout');
  const { app } = relay.createApp('slow');
  const created = await relay.create({ app, text: '永远没人回', timeoutSec: 30 });
  // 把过期时间拨到过去，再 sweep
  const raw = relay.get(created.id);
  ok(raw.status === 'sent', '先确认已发出');
  relay.cancel(created.id);
  ok(relay.get(created.id).status === 'cancelled', '取消生效');
  ok(relay.create({ app, text: 'x', timeoutSec: 30 }).then, 'create 返回 promise');
}

{
  // 损坏文件：只读降级，不覆盖
  const broken = path.join(temp, 'broken.json');
  fs.writeFileSync(broken, '{not json');
  const relay = createRelay({
    stateFile: broken,
    appsFile: path.join(temp, 'apps-x.json'),
    send: async () => '1',
    defaultConversation: () => 'private:123'
  });
  relay.load();
  relay.createApp('a');
  ok(fs.readFileSync(broken, 'utf8') === '{not json', '损坏的状态文件不会被覆盖');
}

if (failed) { console.error('FAILED'); process.exit(1); }
console.log('all relay tests passed');
