#!/usr/bin/env node
// Token 估算校准：用**真实模型用量**对照 estimateTokens() 的保守估算。
//
// 为什么需要：350 tokens 的硬上限是拿本模块的估算值做截断的（CJK 1 token/字）。
// 估算必须**高估**才安全，但"高估多少"不能拍脑袋 —— 这里建几个临时 DSH 会话，
// 每个只发一段文本，读 provider 返回的 usage，比较真实输入 tokens 与估算值。
//
// 做法：每个样本一个独立会话（避免上一轮对话混进上下文），系统提示/工具面完全相同，
// 所以样本间 input tokens 的差值 ≈ 文本本身的 token 数。最后一个样本是与真实记忆块
// 同构的中文文本，直接给出"估算/实际"的倍数。
//
// 成本：默认 4 个极短 turn（输出限制 16 tokens），用完即归档会话。
// 用法：node scripts/memory-calibrate.mjs [--keep] [--model deepseek-flash]
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';
import { usageOfEvent } from '../src/token-ledger.js';
import { normalizeUsage, totalTokensOf } from '../src/model-prices.js';
import { estimateTokens, renderMemoryBlock, buildReadContext } from '../src/memory/index.js';

const keep = process.argv.includes('--keep');
const bridgeCfg = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')); } catch { return {}; }
})();
// 端口/模型都以 config.json 为准（DSH 换端口后探针不能还写死 3080）。
const BASE = process.env.DSH_BASE_URL || bridgeCfg.dsh?.baseUrl || 'http://127.0.0.1:3080';
const PROVIDER = process.env.DSH_PROVIDER || bridgeCfg.dsh?.provider || 'deepseek-official';
const argModel = (() => {
  const i = process.argv.indexOf('--model');
  return i >= 0 ? process.argv[i + 1] : (bridgeCfg.dsh?.model || 'deepseek-flash');
})();

const FILLER = '资料条目：这是一个用于校准的中文记忆样本，包含人名、时间、地点和约定，长度逐步增加。';
function sample(extraChars) {
  let text = '';
  while (text.length < extraChars) text += FILLER;
  return text.slice(0, extraChars);
}

const SAMPLES = [
  { name: 'tiny', text: '只回复 OK。' },
  { name: 'probe-120', text: `只回复 OK。\n\n${sample(120)}` },
  { name: 'probe-360', text: `只回复 OK。\n\n${sample(360)}` },
  {
    name: 'memory-block',
    text: `只回复 OK。\n\n${renderMemoryBlock({
      rows: [
        { kind: 'fact', content: '小明拿到 A 公司 offer 了，准备下个月入职', subjectLabel: '小明', scope: 'group', createdAt: Date.now(), confidence: 0.9 },
        { kind: 'promise', content: '答应给小明带蝴蝶酥，周末见面时给他', subjectLabel: '小明', scope: 'group', createdAt: Date.now(), confidence: 0.9 },
        { kind: 'episode', content: '上周小明说自己在找实习，面试了两家都没下文', subjectLabel: '小明', scope: 'group', createdAt: Date.now(), confidence: 0.8 },
        { kind: 'preference', content: '小明不吃香菜，喜欢喝美式', subjectLabel: '小明', scope: 'group', createdAt: Date.now(), confidence: 0.7 }
      ],
      ctx: buildReadContext({ conversationKey: 'group:1', senders: [{ userId: '1', name: '小明' }] }),
      maxTokens: 350
    }).text}`
  }
];

const cookie = probeCookie({ base: BASE });
const rpc = probeRpc(cookie, { base: BASE });

async function runSample({ name, text }) {
  const dir = probeWorkspaceDir(`calib-${name}`);
  const ws = await rpc('workspace/create', { request: { path: dir } });
  if (!ws.ok) throw new Error(`workspace/create 失败: ${ws.error?.message}`);
  const wsId = ws.value.workspace.workspaceId;
  const sc = await rpc('session/create', { request: { workspaceId: wsId } });
  if (!sc.ok) throw new Error(`session/create 失败: ${sc.error?.message}`);
  const sessionId = sc.value.sessionId;
  const sm = await rpc('session/selectModel', {
    request: { sessionId, provider: PROVIDER, model: argModel, reasoningEffort: 'low' }
  });
  if (!sm.ok) throw new Error(`selectModel 失败: ${sm.error?.message}`);

  const socket = probeMuxSocket(cookie, { base: BASE });
  const streamId = randomUUID();
  const eventStreamId = randomUUID();
  const buckets = [];
  const reply = [];

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 120_000);
    const finish = (why) => { clearTimeout(timer); resolve(why); };
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
      socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
      setTimeout(async () => {
        const p = await rpc('session/prompt', {
          request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] }
        });
        if (!p.ok) finish(`prompt-failed:${p.error?.message}`);
      }, 700);
    });
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'item' || m.streamId === eventStreamId) return;
      const v = m.value;
      if (v?.type !== 'event') return;
      const e = v.event;
      if (e.type === 'assistant/message') {
        const usage = usageOfEvent(e);
        if (usage) buckets.push(normalizeUsage(usage));
        for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') reply.push(b.text);
      }
      if (e.type === 'turn/end') finish('done');
    });
    socket.addEventListener('close', () => finish('closed'));
    socket.addEventListener('error', () => finish('error'));
  });

  const why = await done;
  try { socket.close(); } catch {}
  if (!keep) {
    try { await rpc('workspace/archiveSession', { request: { sessionId } }); } catch {}
  }
  const input = buckets.reduce((sum, b) => sum + b.cacheMiss + b.cacheHit + b.cacheWrite, 0);
  const output = buckets.reduce((sum, b) => sum + b.output, 0);
  return { name, why, sessionId, input, output, total: buckets.reduce((s, b) => s + totalTokensOf(b), 0), buckets, estimate: estimateTokens(text), preview: reply.join('').slice(0, 40) };
}

const results = [];
for (const sample of SAMPLES) {
  try {
    const r = await runSample(sample);
    results.push(r);
    console.log(`[calibrate] ${r.name}: ${r.why} input=${r.input} output=${r.output} estimate=${r.estimate}`);
  } catch (error) {
    console.error(`[calibrate] ${sample.name} 失败: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

// 差值法：以最小样本为基准，去掉系统提示/工具面的固定开销。
const baseline = results.find((r) => r.name === 'tiny');
const rows = results.filter((r) => r !== baseline).map((r) => {
  const actual = r.input - baseline.input;
  const estDelta = r.estimate - baseline.estimate;
  return {
    sample: r.name,
    actualInputDelta: actual,
    estimateDelta: estDelta,
    ratio: estDelta > 0 ? +(actual / estDelta).toFixed(2) : null,
    safe: actual <= estDelta
  };
});
const ratios = rows.map((r) => r.ratio).filter((n) => Number.isFinite(n));
const avgRatio = ratios.length ? +(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2) : null;
const report = {
  base: BASE,
  provider: PROVIDER,
  model: argModel,
  baseline: baseline ? { input: baseline.input, estimate: baseline.estimate } : null,
  samples: results.map(({ buckets, ...r }) => r),
  deltas: rows,
  avgRatio,
  verdict: rows.every((r) => r.safe) ? 'estimator-overestimates (safe for 350-token cap)' : 'ESTIMATOR-UNDERESTIMATES',
  note: 'ratio = 实际新增输入 tokens / 本模块估算新增 tokens；<1 表示估算偏保守。'
};
console.log(JSON.stringify(report, null, 2));
if (rows.some((r) => !r.safe)) process.exitCode = 1;
