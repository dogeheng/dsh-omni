// SenseVoice 识别子进程：由 voice-asr.js 在「第一条语音到来时」fork，闲置一段时间后被父进程结束。
//
// 为什么单独开进程：模型加载后约占 850MB 内存（2026-10-24 Apple Silicon 实测 phys_footprint）。
// 在桥接进程里直接加载的话，即使丢掉识别器对象，ONNX Runtime 的内存池通常也不会还给系统；
// 放进子进程后，结束进程就能把这部分内存完整归还。
//
// IPC 协议（fork 时用 serialization:'advanced'，Float32Array 原样传递，不走 JSON）：
//   父 → 子 { type:'init', model, tokens, numThreads, language, useItn }
//   子 → 父 { type:'ready', ms }                      加载成功
//   子 → 父 { type:'fatal', error }                   加载失败（随后退出）
//   父 → 子 { type:'decode', id, samples }            16kHz 单声道 Float32
//   子 → 父 { type:'result', id, result:{ text, lang, emotion, event } } | { type:'error', id, error }
// 父进程断开（桥接退出/重启）时子进程自行退出，不会留下孤儿进程。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let recognizer = null;
let chain = Promise.resolve(); // 串行解码：同一识别器上不并发 decode，单条只要 ~0.1s

const send = (m) => {
  try { process.send?.(m); } catch {}
};

process.on('disconnect', () => process.exit(0));

async function init(m) {
  try {
    const sherpa = require('sherpa-onnx-node');
    const t0 = Date.now();
    recognizer = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: m.model,
          language: m.language || '',
          useInverseTextNormalization: m.useItn ? 1 : 0
        },
        tokens: m.tokens,
        numThreads: m.numThreads || 2,
        provider: 'cpu',
        debug: 0
      }
    });
    send({ type: 'ready', ms: Date.now() - t0 });
  } catch (error) {
    send({ type: 'fatal', error: String(error?.message ?? error) });
    setTimeout(() => process.exit(1), 50);
  }
}

async function decode(m) {
  try {
    if (!recognizer) throw new Error('识别器尚未加载');
    if (!(m.samples instanceof Float32Array)) throw new Error('samples 必须是 Float32Array');
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: m.samples });
    const r = await recognizer.decodeAsync(stream);
    send({
      type: 'result',
      id: m.id,
      result: { text: String(r?.text ?? ''), lang: String(r?.lang ?? ''), emotion: String(r?.emotion ?? ''), event: String(r?.event ?? '') }
    });
  } catch (error) {
    send({ type: 'error', id: m.id, error: String(error?.message ?? error) });
  }
}

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') { chain = chain.then(() => init(m)); return; }
  if (m.type === 'decode') chain = chain.then(() => decode(m));
});
